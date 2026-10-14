#!/usr/bin/env node
// PreToolUse hook (hooks/hooks.json): a call that runs other tools or privileged code gets the permission checks of
// what it runs, up front, in Claude Code's own permission prompt. Claude Code checks a tool call by its name only, so
// without this, allowing `batch` would also allow every tool its steps name (eval_privileged, us_write, restore...),
// and allowing `eval` would allow `eval` in the privileged realm, which has eval_privileged's reach.
//
// What it checks:
//   batch (each step), test_record (its steps), test_run and bisect (the tests' steps and privileged-realm
//   assertions: inline, or read from tests/<name>.test.json), ff_dev_call (the forwarded call), and eval / wait_for
//   / verify with the privileged realm (checked as eval_privileged).
// For each step, against the user's permission rules (managed, user, project and local settings files):
//   - a deny rule for the step's tool denies the whole call; an ask rule asks;
//   - a step with no rule asks, unless it is a page action or read-only (navigate, click, type, read_page,
//     screenshot, ff_read, ...): those are what batch is for, so the approval of the batch call covers them.
//     eval and verify run code, so they need their own approval, in a batch as on their own.
// Permission modes: bypassPermissions only applies deny rules; dontAsk denies what would ask; auto applies deny and
// ask rules and leaves steps with no rule to auto mode's classifier, which sees the whole call.
// Not visible to a hook: approvals given for the rest of a session only, and --settings rules. A step allowed that
// way still asks here.
// Exit 0 always: with a decision as JSON on stdout, or silent (the normal permission flow). If the check itself
// fails, it asks rather than letting the call through unchecked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = 'mcp__plugin_firefox-use_firefox';
const PREFIX = `${SERVER}__`;

// Page-level tools: a batch step with one of these, or with any read-only tool, is covered by the batch's own
// approval (as Claude in Chrome's browser_batch covers its page actions).
const PAGE_LEVEL = new Set(['navigate', 'click', 'type', 'key', 'hover', 'drag', 'scroll', 'scroll_to', 'input', 'form_input',
  'resize', 'screenshot', 'read_page', 'find', 'get_page_text', 'tabs', 'wait_for']);

/** Tools that run other tools. */
const RUNNERS = new Set(['batch', 'ff_dev_call', 'test_record', 'bisect', 'test_run']);

const realmKind = (r) => (typeof r === 'string' ? r : r && typeof r === 'object' ? r.kind : undefined);

/** Steps that one call runs: [{label, tool, args}]. */
function stepsOf(tool, input, depth = 0) {
  if (depth > 2 || !input || typeof input !== 'object') return [];
  const entry = (s) => { const [t, raw] = Object.entries(s ?? {})[0] ?? []; return { tool: t, args: raw && typeof raw === 'object' ? raw : {} }; };
  // a step that itself runs tools (test_record inside a batch) brings its own steps; the privileged realm of a step is
  // the step's own classification (classify), not another step
  const nested = (label, s) => [{ label, ...s }, ...(RUNNERS.has(s.tool) ? stepsOf(s.tool, s.args, depth + 1) : []).map((x) => ({ ...x, label: `${label} > ${x.label}` }))];
  switch (tool) {
    case 'batch':
      return (Array.isArray(input.actions) ? input.actions : []).flatMap((s, i) => nested(`step ${i + 1}`, { tool: s?.tool, args: s?.args ?? {} }));
    case 'ff_dev_call':
      return typeof input.tool === 'string' ? nested('forwarded call', { tool: input.tool, args: input.args ?? {} }) : [];
    case 'test_record':
      return (Array.isArray(input.steps) ? input.steps : []).flatMap((s, i) => nested(`step ${i + 1}`, entry(s)));
    case 'bisect': {
      const t = input.test;
      if (typeof t === 'string') return testFileSteps([t]);
      if (!t || typeof t !== 'object') return [];
      return testSteps(t, 'test');
    }
    case 'test_run':
      return testFileSteps(Array.isArray(input.names) ? input.names : 'all');
    case 'eval': case 'wait_for': case 'verify':
      return privileged(tool, input) ? [{ label: 'this call', tool: 'eval_privileged', args: {} }] : [];
    default:
      return [];
  }
}

/** The workspace the server resolves tests/ in (set per call in decide). */
let WORKSPACE = process.cwd();

/** A test's steps and its privileged-realm assertions: {steps, assert} (inline) or {cases: [{steps, assert}]} (file). */
function testSteps(t, name) {
  const entry = (s) => { const [tool, raw] = Object.entries(s ?? {})[0] ?? []; return { tool, args: raw && typeof raw === 'object' ? raw : {} }; };
  const cases = Array.isArray(t?.cases) ? t.cases : [t];
  return cases.flatMap((k, ci) => {
    const where = cases.length > 1 ? `${name} case ${ci + 1}` : name;
    return [
      ...(Array.isArray(k?.steps) ? k.steps : []).map((s, i) => ({ label: `${where} step ${i + 1}`, ...entry(s) })),
      ...(Array.isArray(k?.assert) ? k.assert : []).flatMap((a, i) => (realmKind(a?.realm) === 'privileged' ? [{ label: `${where} assertion ${i + 1}`, tool: 'eval_privileged', args: {} }] : [])),
    ];
  });
}

/** tests/<name>.test.json in the workspace (all, or by name), as test_run and bisect read them. */
function testFileSteps(names) {
  const dir = path.join(WORKSPACE, 'tests');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.json')); } catch { return []; }
  const pick = names === 'all' ? files : files.filter((f) => names.some((n) => f === `${n}.test.json` || f === n || f === path.basename(String(n))));
  return pick.flatMap((f) => {
    try { return testSteps(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f.replace(/\.test\.json$/, '')); } catch { return []; }
  });
}

/** Code this call would run in the privileged (chrome) realm. */
function privileged(tool, args) {
  if (!args || typeof args !== 'object') return false;
  if (tool === 'verify') return Array.isArray(args.checks) && args.checks.some((c) => realmKind(c?.realm) === 'privileged');
  return realmKind(args.realm) === 'privileged';
}

/** The listed tool a step's permission rules name, and whether the batch's approval covers it. */
function classify(step, manifest) {
  if (privileged(step.tool, step.args)) return { name: 'eval_privileged', covered: false };
  const name = manifest.aliases[step.tool] ?? step.tool;
  // wait_for with an expression runs page code, like eval: it needs its own approval, not the batch's
  if (name === 'wait_for' && (step.tool === 'wait_for_expr' || (step.tool === 'wait_for' && (step.args?.kind ?? 'expr') === 'expr'))) return { name, covered: false };
  return { name, covered: PAGE_LEVEL.has(name) || manifest.tools[name]?.readOnly === true };
}

function settingsFiles(cwd) {
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const projects = [...new Set([process.env.CLAUDE_PROJECT_DIR, cwd].filter(Boolean))];
  const managed = process.env.FIREFOX_USE_MANAGED_SETTINGS ? [process.env.FIREFOX_USE_MANAGED_SETTINGS]
    : process.platform === 'win32' ? ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json']
    : process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
    : ['/etc/claude-code/managed-settings.json'];
  return [...managed, path.join(config, 'settings.json'), ...projects.flatMap((p) => [path.join(p, '.claude', 'settings.json'), path.join(p, '.claude', 'settings.local.json')])];
}

function loadRules(cwd) {
  const rules = { allow: [], ask: [], deny: [] };
  for (const f of settingsFiles(cwd)) {
    let s;
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const k of Object.keys(rules)) if (Array.isArray(s?.permissions?.[k])) rules[k].push(...s.permissions[k].filter((r) => typeof r === 'string'));
  }
  return rules;
}

/** Claude Code's matching for an MCP tool name: exact, the bare server, or a * glob (allow globs only after the literal server prefix). */
function matches(rule, full, kind) {
  if (rule.includes('(')) return false; // Claude Code skips mcp__ rules with parentheses
  if (rule === full || rule === SERVER) return true;
  if (!rule.includes('*')) return false;
  if (kind === 'allow' && !rule.startsWith(PREFIX)) return false;
  return new RegExp(`^${rule.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(full);
}

function ruleFor(rules, name) {
  const full = PREFIX + name;
  for (const kind of ['deny', 'ask', 'allow']) if (rules[kind].some((r) => matches(r, full, kind))) return kind;
  return null;
}

/** "eval_privileged (step 3), us_write (steps 4, 5)" */
function list(items) {
  const by = new Map();
  for (const { name, label } of items) by.set(name, [...(by.get(name) ?? []), label]);
  return [...by].map(([n, ls]) => `${n} (${ls.join(', ')})`).join(', ');
}

function decide(input, manifest) {
  if (typeof input.tool_name !== 'string' || !input.tool_name.startsWith(PREFIX)) return null;
  const tool = input.tool_name.slice(PREFIX.length);
  const steps = stepsOf(tool, input.tool_input ?? {}).filter((s) => typeof s.tool === 'string');
  if (!steps.length) return null;
  const rules = loadRules(input.cwd || process.cwd());
  WORKSPACE = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const denied = [], asked = [], unapproved = [];
  for (const s of steps) {
    const c = classify(s, manifest);
    const r = ruleFor(rules, c.name);
    if (r === 'deny') denied.push({ name: c.name, label: s.label });
    else if (r === 'ask') asked.push({ name: c.name, label: s.label });
    else if (r !== 'allow' && !c.covered) unapproved.push({ name: c.name, label: s.label });
  }
  // eval / wait_for / verify in the privileged realm: one "step", the call itself, checked as eval_privileged
  const realmCall = tool === 'eval' || tool === 'wait_for' || tool === 'verify';
  const runs = (items) => (realmCall
    ? `This ${tool} runs code in the privileged (browser chrome) realm, which has the reach of eval_privileged`
    : `This ${tool} call runs ${list(items)}`);
  if (denied.length) return { permissionDecision: 'deny', permissionDecisionReason: `${runs(denied)}, which your permission rules deny.` };
  const mode = input.permission_mode ?? 'default';
  if (mode === 'bypassPermissions') return null;
  const needs = [...asked, ...(mode === 'auto' ? [] : unapproved)];
  if (!needs.length) return null;
  if (mode === 'dontAsk') return { permissionDecision: 'deny', permissionDecisionReason: `${runs(needs)}, which would need approval; dontAsk mode denies that.` };
  return {
    permissionDecision: 'ask',
    permissionDecisionReason: realmCall
      ? `${runs(needs)}, and your permission rules don't pre-approve eval_privileged. Approving runs it for this call only.`
      : `This ${tool} call runs tools your permission rules don't pre-approve: ${list(needs)}. Approving runs them for this call only.`,
  };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let out = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'tool-manifest.json'), 'utf8'));
    out = decide(JSON.parse(raw), manifest);
  } catch (e) {
    out = { permissionDecision: 'ask', permissionDecisionReason: `firefox-use could not check the tools this call runs (${e?.message ?? e}). Approve only if you would approve each of them.` };
  }
  if (out) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));
  process.exit(0);
});
