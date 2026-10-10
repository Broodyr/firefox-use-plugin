// The permission hook (server/hooks/permissions.mjs, hooks/hooks.json): batch steps, test_record / bisect steps and
// the privileged realm get the permission checks of what they run. Runs the hook as Claude Code does (JSON on stdin)
// against settings files in a temp folder; no Firefox.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { SERVER_ROOT } from '../client.ts';

const P = 'mcp__plugin_firefox-use_firefox__';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-perm-'));
const config = path.join(tmp, 'config'), project = path.join(tmp, 'project');
fs.mkdirSync(config); fs.mkdirSync(path.join(project, '.claude'), { recursive: true });

function rules(where: 'user' | 'project' | 'local', permissions: Record<string, string[]>) {
  const f = where === 'user' ? path.join(config, 'settings.json') : path.join(project, '.claude', where === 'project' ? 'settings.json' : 'settings.local.json');
  fs.writeFileSync(f, JSON.stringify({ permissions }));
}
function reset() { for (const f of [path.join(config, 'settings.json'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')]) fs.rmSync(f, { force: true }); }

function hook(tool: string, input: unknown, mode = 'default', raw?: string): { decision?: string; reason?: string } {
  const r = spawnSync(process.execPath, [path.join(SERVER_ROOT, 'server', 'hooks', 'permissions.mjs')], {
    input: raw ?? JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: P + tool, tool_input: input, permission_mode: mode, cwd: project }),
    encoding: 'utf8', cwd: project,
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project, FIREFOX_USE_MANAGED_SETTINGS: path.join(tmp, 'no-managed.json') },
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return {};
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(o.hookEventName, 'PreToolUse');
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
}
const batch = (...steps: [string, Record<string, unknown>?][]) => ({ actions: steps.map(([tool, args]) => ({ tool, args: args ?? {} })) });

describe('permission hook', () => {
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('page actions and read-only steps are covered by the batch itself; eval and verify are not', () => {
    reset();
    assert.deepEqual(hook('batch', batch(['navigate', { url: 'https://example.com' }], ['click', { target: 'ref_1' }], ['type', { text: 'x' }], ['ff_read', { kind: 'audit' }], ['screenshot'], ['wait_for', { kind: 'selector', selector: '#x' }])), {});
    // wait_for with an expression runs page code: its own approval (other kinds are covered)
    assert.match(hook('batch', batch(['navigate'], ['wait_for', { expr: 'window.ready' }])).reason!, /wait_for \(step 2\)/);
    assert.match(hook('batch', batch(['wait_for_expr', { expr: 'x' }])).reason!, /wait_for \(step 1\)/);
    const r = hook('batch', batch(['navigate'], ['eval', { code: '1' }], ['verify', { url: 'u', checks: [] }]));
    assert.equal(r.decision, 'ask');
    assert.match(r.reason!, /: eval \(step 2\), verify \(step 3\)\./); // only the steps that need approval are named
    rules('user', { allow: [`${P}eval`, `${P}verify`] });
    assert.deepEqual(hook('batch', batch(['navigate'], ['eval', { code: '1' }], ['verify', { url: 'u', checks: [] }])), {});
  });

  it('a step beyond page level asks, naming the tool and step; its own allow rule (exact, server, glob) covers it', () => {
    reset();
    let r = hook('batch', batch(['navigate'], ['eval_privileged', { code: 'return 1' }], ['us_write', { action: 'install' }], ['us_install']));
    assert.equal(r.decision, 'ask');
    assert.match(r.reason!, /eval_privileged \(step 2\), us_write \(steps? 3, step 4\)/);
    rules('user', { allow: [`${P}eval_privileged`, `${P}us_write`] });
    assert.deepEqual(hook('batch', batch(['eval_privileged', { code: 'return 1' }], ['us_install'])), {});
    rules('user', { allow: ['mcp__plugin_firefox-use_firefox'] });
    assert.deepEqual(hook('batch', batch(['eval_privileged'])), {});
    rules('user', { allow: [`${P}*`] });
    assert.deepEqual(hook('batch', batch(['eval_privileged'])), {});
    rules('user', { allow: ['*', 'mcp__*'] }); // unanchored allow globs approve nothing in Claude Code
    assert.equal(hook('batch', batch(['eval_privileged'])).decision, 'ask');
  });

  it('deny and ask rules apply to every step, page-level ones included; deny wins', () => {
    reset();
    rules('project', { deny: [`${P}us_write`] });
    rules('local', { ask: [`${P}navigate`] });
    let r = hook('batch', batch(['navigate'], ['us_install']));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason!, /us_write \(step 2\), which your permission rules deny/);
    r = hook('batch', batch(['navigate']));
    assert.equal(r.decision, 'ask');
    assert.match(r.reason!, /navigate \(step 1\)/);
  });

  it('the privileged realm counts as eval_privileged: eval, wait_for, verify, and batch steps', () => {
    reset();
    assert.deepEqual(hook('eval', { code: '1', realm: { kind: 'page' } }), {});
    let r = hook('eval', { code: 'Services.appinfo.version', realm: { kind: 'privileged' } });
    assert.equal(r.decision, 'ask');
    assert.match(r.reason!, /privileged \(browser chrome\) realm/);
    assert.equal(hook('wait_for', { expr: 'true', realm: { kind: 'privileged' } }).decision, 'ask');
    assert.equal(hook('verify', { url: 'x', checks: [{ expr: '1' }, { expr: '1', realm: 'privileged' }] }).decision, 'ask');
    r = hook('batch', batch(['wait_for', { expr: 'x', realm: { kind: 'privileged' } }], ['eval', { code: 'x', realm: { kind: 'extension', extension: 'ubo' } }]));
    assert.equal(r.decision, 'ask');
    assert.match(r.reason!, /eval_privileged \(step 1\), eval \(step 2\)/); // eval outside the page realm isn't page-level
    rules('user', { allow: [`${P}eval_privileged`] });
    assert.deepEqual(hook('eval', { code: 'x', realm: { kind: 'privileged' } }), {});
  });

  it('test_record steps and inline bisect tests are checked too', () => {
    reset();
    assert.match(hook('test_record', { name: 't', url: 'u', steps: [{ navigate: 'u' }, { eval_privileged: { code: 'x' } }] }).reason!, /eval_privileged \(step 2\)/);
    assert.match(hook('bisect', { test: { url: 'u', assert: [{ expr: '1' }, { expr: 'x', realm: 'privileged' }] }, dimensions: {} }).reason!, /eval_privileged \(test assertion 2\)/);
    assert.deepEqual(hook('bisect', { test: 'a-test-file', dimensions: {} }), {});
    // test_run and a named bisect test: read from tests/<name>.test.json
    fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(project, 'tests', 'site.test.json'), JSON.stringify({ name: 'site', cases: [{ url: 'u', steps: [{ navigate: 'u' }], assert: [{ expr: '1' }, { expr: 'x', realm: { kind: 'privileged' } }] }] }));
    fs.writeFileSync(path.join(project, 'tests', 'plain.test.json'), JSON.stringify({ name: 'plain', cases: [{ url: 'u', steps: [{ click: 'ref_1' }], assert: [{ expr: '1' }] }] }));
    assert.match(hook('test_run', { names: 'all' }).reason!, /eval_privileged \(site assertion 2\)/);
    assert.deepEqual(hook('test_run', { names: ['plain'] }), {});
    assert.match(hook('bisect', { test: 'site', dimensions: {} }).reason!, /eval_privileged \(site assertion 2\)/);
    // a runner inside a batch brings its own steps
    assert.match(hook('batch', batch(['test_record', { name: 't', url: 'u', steps: [{ eval_privileged: {} }] }])).reason!, /test_record \(step 1\), eval_privileged \(step 1 > step 1\)/);
  });

  it('permission modes: bypass applies deny rules only, dontAsk denies, auto leaves unruled steps to the classifier', () => {
    reset();
    const b = batch(['eval_privileged']);
    assert.deepEqual(hook('batch', b, 'bypassPermissions'), {});
    assert.equal(hook('batch', b, 'dontAsk').decision, 'deny');
    assert.deepEqual(hook('batch', b, 'auto'), {});
    rules('user', { ask: [`${P}eval_privileged`] });
    assert.equal(hook('batch', b, 'auto').decision, 'ask');
    rules('user', { deny: [`${P}eval_privileged`] });
    assert.equal(hook('batch', b, 'bypassPermissions').decision, 'deny');
  });

  it('other tools pass through; a check that fails asks instead of letting the call through', () => {
    reset();
    assert.deepEqual(hook('navigate', { url: 'x' }), {});
    assert.equal(hook('batch', null, 'default', '{not json').decision, 'ask');
  });
});
