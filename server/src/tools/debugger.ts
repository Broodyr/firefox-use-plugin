// debugger tools: breakpoints (line, logpoint, conditional, function, event, DOM mutation), pause on
// exceptions, paused state with scopes, stepping, evaluation in a paused frame. Userscript breakpoints take and
// report lines of the file on disk (Violentmonkey's wrapper and @require lines are mapped away).
import { z } from 'zod';
import { fail } from '../errors.js';
import { gripText } from '../browser/devtools.js';
import { debuggerFor, debuggerIfRunning, type Bp, type Debugger, type PauseInfo, type ScriptMap } from '../browser/debugger.js';
import { evalIn, resolveExtension, type RealmSpec } from '../browser/realms.js';
import { resolveRef } from '../browser/resolve.js';
import { SERIALIZER } from '../browser/serialize.js';
import type { Browser } from '../browser/session.js';
import { readState, relPath, slug, stripPrelude, vmScripts, VM_ID } from '../adapters/violentmonkey.js';
import { maskValue } from '../safety/mask.js';
import { realmArg, toSpec } from './realms.js';
import { refArg, tabArg, tool } from './registry.js';

// ------------------------------------------------------------ userscript sources and line mapping
const VM_SRC = /^moz-extension:\/\/[^/]+\/%20(.+)\.user\.js#(\d+)$/;
const FAST_SRC = /^claude-fast\/(.+)\.user\.js$/;

/** Source line of the file's "// ==UserScript==" line, 0-based: file line = source line - offset. */
async function offsetFromSource(d: Debugger, url: string): Promise<number> {
  const src = d.sourcesFor(url)[0];
  if (!src) return FAST_SRC.test(url) ? 0 : 2;
  const lines = (await d.sourceText(src)).split('\n');
  const i = lines.findIndex((l) => l.includes('==UserScript=='));
  return i >= 0 ? i : 0;
}

/** Mapping for a userscript source URL (VM manager or companion fast mode), cached. */
async function mapFor(d: Debugger, url: string | undefined): Promise<ScriptMap | null> {
  if (!url) return null;
  const have = d.scriptMaps.get(url);
  if (have) return have;
  const vm = VM_SRC.exec(url), fast = FAST_SRC.exec(url);
  if (!vm && !fast) return null;
  const name = vm ? decodeURIComponent(vm[1]) : fast![1];
  const links = readState().links;
  const file = Object.entries(links).find(([, l]) => (vm ? l.mode === 'manager' && String(l.id) === vm[2] : l.mode === 'fast' && slug(l.name) === name))?.[0] ?? name;
  const m: ScriptMap = { file, name, offset: await offsetFromSource(d, url) };
  d.scriptMaps.set(url, m);
  return m;
}

/** script = workspace file, Violentmonkey name or id, or a fast-mode script -> its source URL. */
async function scriptUrl(b: Browser, d: Debugger, script: string): Promise<string> {
  const links = readState().links;
  let rel = Object.keys(links).find((k) => k === script || k === script.replace(/\\/g, '/'));
  if (!rel) { try { rel = relPath(script).rel; if (!links[rel]) rel = undefined; } catch { rel = undefined; } }
  const link = rel ? links[rel] : Object.values(links).find((l) => l.name === script || String(l.id) === script);
  const urls = [...new Set([...d.sources.values()].map((s) => s.url))];
  if (link?.mode === 'fast') {
    fail('NOT_DEBUGGABLE', `"${link.name}" runs in fast mode: Firefox does not show userScripts-API sources to the debugger`,
      'To set breakpoints, install it in manager mode (us_install mode "manager") with @inject-into content while debugging. eval with realm {kind:"userscript", script} still works in fast mode.');
  }
  let id = link?.mode === 'manager' ? String(link.id) : '';
  if (!id) {
    const s = (await vmScripts(b)).find((x) => !x.removed && (x.name === script || String(x.id) === script));
    if (!s) fail('SCRIPT_NOT_FOUND', `no userscript "${script}" (workspace file, Violentmonkey name or id)`, 'us_list shows installed scripts.');
    id = String(s!.id);
  }
  const host = await b.callChrome<string | null>(`({ id }) => WebExtensionPolicy.getByID(id)?.mozExtensionHostname ?? null`, { id: VM_ID });
  const hit = urls.find((u) => u.startsWith(`moz-extension://${host}/`) && u.endsWith(`.user.js#${id}`));
  if (!hit) {
    fail('SOURCE_NOT_FOUND', `Violentmonkey script #${id} has no loaded source`,
      'Load a page where it runs first (then reload to hit top-level code). us_logs shows why a script did not run.');
  }
  return hit!;
}

/**
 * Where a function is defined: its source text (Function.prototype.toString is the exact text) found in the loaded
 * sources of that realm's origin. (Function grips carry a location only on a connection that watches sources in the
 * realm's own target, which the debugger's process-level connection doesn't have.)
 */
async function functionLocation(b: Browser, d: Debugger, spec: RealmSpec, name: string, tab?: number): Promise<{ location: { url: string; line: number; column: number } }> {
  const r = await evalIn(b, spec, `const f = (${name});\nreturn typeof f === 'function' ? [Function.prototype.toString.call(f), String(location.href)] : null;`, { tab, depth: 2 });
  const v = r.value as [string, string] | null;
  if (!Array.isArray(v)) fail('BAD_ARGS', `${name} is not a function in ${r.realm}`);
  const [text, href] = v!;
  if (/\{\s*\[native code\]\s*\}$/.test(text)) fail('BAD_ARGS', `${name} is a native or bound function: it has no source`);
  let origin = '';
  try { const u = new URL(href); origin = u.protocol === 'moz-extension:' ? `moz-extension://${u.host}/` : u.origin; } catch { /* about: pages */ }
  const urls = [...new Set([...d.sources.values()].map((s) => s.url))].filter((u) => !/^(chrome|resource|about):/.test(u));
  const first = urls.filter((u) => origin && u.startsWith(origin));
  const rest = urls.filter((u) => !first.includes(u) && (/^moz-extension:/.test(u) || u.startsWith('claude-fast/')));
  for (const url of [...first, ...rest].slice(0, 300)) {
    const src = d.sourcesFor(url)[0];
    let t: string;
    try { t = await d.sourceText(src); } catch { continue; }
    const i = t.indexOf(text);
    if (i < 0) continue;
    const before = t.slice(0, i);
    const line = before.split('\n').length;
    return { location: { url, line, column: i - (before.lastIndexOf('\n') + 1) } };
  }
  return fail('SOURCE_NOT_FOUND', `found ${name} in ${r.realm} but not its source among the loaded sources`, 'Set a line breakpoint on its file instead (bp_set {url, line}).');
}

// ------------------------------------------------------------ formatting
async function where(d: Debugger, w: any): Promise<string> {
  const src = d.sourceOf(w?.actor) ?? await d.waitSourceActor(w?.actor, 1000);
  const url = src?.url ?? '?';
  const m = await mapFor(d, url).catch(() => null);
  const pos = `${url}:${w?.line ?? '?'}:${w?.column ?? '?'}`;
  return m ? `${m.file}:${(w?.line ?? 0) - m.offset} (${pos})` : pos;
}

function bpLine(bp: Bp): string {
  const extra = [bp.condition ? `if ${JSON.stringify(bp.condition)}` : '', bp.log ? `logpoint ${JSON.stringify(bp.log)}` : '', bp.pending ? 'pending' : '', bp.note ?? ''].filter(Boolean).join(' · ');
  const at = `${bp.url}:${bp.line}${bp.column !== undefined ? `:${bp.column}` : ''}`;
  if (bp.kind === 'line') return `${bp.id} ${bp.file ? `${bp.file}:${bp.fileLine} (${at})` : at}${bp.label && !bp.label.startsWith(bp.url ?? '\0') ? ` [${bp.label}]` : ''}${extra ? ` · ${extra}` : ''}`;
  return `${bp.id} ${bp.label}${extra ? ` · ${extra}` : ''}`;
}

async function sourceContext(d: Debugger, w: any, around = 2): Promise<string[]> {
  const src = d.sourceOf(w?.actor) ?? await d.waitSourceActor(w?.actor, 1000);
  if (!src || !w?.line) return [];
  let text: string;
  try { text = await d.sourceText(src); } catch { return []; }
  const lines = text.split('\n');
  const m = await mapFor(d, src.url).catch(() => null);
  const out: string[] = [];
  for (let l = Math.max(1, w.line - around); l <= Math.min(lines.length, w.line + around); l++) {
    // the one-line dev prelude is in the installed source, not in the file
    let s = stripPrelude(lines[l - 1]).replace(/\t/g, '  ');
    if (s.length > 160) {
      // minified code: a window around the paused column
      const c = l === w.line ? (w.column ?? 0) : 0;
      const a = Math.max(0, c - 60);
      s = `${a ? '…' : ''}${s.slice(a, a + 150)}…`;
    }
    out.push(`${l === w.line ? '>' : ' '} ${String(m ? l - m.offset : l).padStart(4)} | ${s}`);
  }
  return out;
}

const frameName = (f: any) => (!f ? '?' : f.type === 'global' || f.displayName === '(global)' ? '(top level)' : f.displayName ?? '(anonymous)');

function whyText(why: any): string {
  switch (why?.type) {
    case 'breakpoint': return 'breakpoint';
    case 'exception': return `exception: ${gripText(why.exception)}`;
    case 'eventBreakpoint': return `event breakpoint: ${why.message ?? why.breakpoint}`;
    case 'mutationBreakpoint': return `DOM mutation breakpoint: ${why.message ?? why.mutationType} on ${gripText(why.nodeGrip)}`;
    case 'resumeLimit': return 'step';
    case 'debuggerStatement': return 'debugger statement';
    default: return why?.type ?? '?';
  }
}

/** Which of our breakpoints a pause is at (by URL + line). */
async function bpAt(d: Debugger, w: any): Promise<Bp | undefined> {
  const url = (d.sourceOf(w?.actor) ?? await d.waitSourceActor(w?.actor, 1000))?.url;
  return d.bps.find((b) => b.kind === 'line' && b.url === url && b.line === w?.line);
}

export async function pauseSummary(d: Debugger, p: PauseInfo): Promise<string> {
  const f = p.packet.frame;
  const bp = p.packet.why?.type === 'breakpoint' ? await bpAt(d, f?.where) : undefined;
  return `paused (${whyText(p.packet.why)}${bp ? ` ${bp.id}` : ''}) in ${frameName(f)} at ${await where(d, f?.where)}`;
}

async function scopeLines(d: Debugger, frameActor: string, max = 40): Promise<string[]> {
  const out: string[] = [];
  let env: any;
  try { env = await d.environment(frameActor); } catch { return out; }
  let depth = 0;
  while (env && out.length < max && depth < 6) {
    if (env.type === 'object' && !env.scopeKind) break; // the global object: too big, and eval_paused reaches it
    const vars: string[] = [];
    const b = env.bindings ?? {};
    const noise = (k: string) => k === 'arguments' || k.startsWith('__cf') || k === '__claude' || /^(define|module|exports)$/.test(k);
    for (const a of b.arguments ?? []) for (const [k, v] of Object.entries<any>(a)) if (!noise(k)) vars.push(`${k} = ${gripText(v.value ?? v)}`);
    for (const [k, v] of Object.entries<any>(b.variables ?? {})) {
      // the dev prelude's and Violentmonkey's wrapper bindings are noise
      if (noise(k)) continue;
      vars.push(`${k} = ${'value' in (v ?? {}) ? gripText(v.value) : v?.get ? '[getter]' : '?'}`);
    }
    const kind = env.type === 'function' ? `function ${env.function?.displayName ?? ''}` : env.type === 'with' ? 'with' : env.scopeKind ?? env.type;
    if (vars.length) out.push(`  ${kind}: ${vars.slice(0, max - out.length).map((v) => v.slice(0, 200)).join(', ')}`);
    env = env.parent;
    depth++;
  }
  return out;
}

async function stateText(d: Debugger, p: PauseInfo, detail: string): Promise<string> {
  const lines = [await pauseSummary(d, p)];
  const frames = await d.frames(p, detail === 'full' ? 40 : 12).catch(() => [] as any[]);
  const top = frames[0] ?? p.packet.frame;
  lines.push(...await sourceContext(d, top?.where, detail === 'summary' ? 2 : 4));
  if (frames.length) {
    lines.push('stack:');
    let internal = 0;
    for (const [i, f] of frames.entries()) {
      const url = d.sourceOf(f.where?.actor)?.url ?? '';
      // the browser's own frames below the page code (BiDi input synthesis, message handlers): count, don't list
      if (i > 0 && /^(chrome|resource):/.test(url)) { internal++; continue; }
      lines.push(`  #${i} ${frameName(f)} @ ${await where(d, f.where)}${f.asyncCause ? ` [async ${f.asyncCause}]` : ''}`);
    }
    if (internal) lines.push(`  (+${internal} browser-internal frame(s))`);
  }
  if (top?.actor) {
    const sc = await scopeLines(d, top.actor, detail === 'full' ? 120 : 40);
    if (sc.length) lines.push('scope (#0):', ...sc);
    if (top.this && detail !== 'summary') lines.push(`  this = ${gripText(top.this)}`);
  }
  const left = Math.max(0, Math.round((p.since + Number(process.env.FIREFOX_USE_PAUSE_TIMEOUT_MS || 60000) - Date.now()) / 1000));
  lines.push(`paused for ${((Date.now() - p.since) / 1000).toFixed(1)} s; auto-resume in ${left} s. Next: step, resume, eval_paused.`);
  const others = [...d.paused.values()].filter((x) => x !== p);
  if (others.length) lines.push(`also paused: ${others.length} other thread(s) (resume this one first)`);
  return lines.join('\n');
}

const locationArg = z.object({
  url: z.string().optional().describe('Source URL or a unique substring of it (page script, extension file, ...)'),
  extension: z.string().optional().describe('With url: a file of this extension (id or alias), e.g. {url: "bg.js", extension: "my-ext@x"}'),
  script: z.string().optional().describe('Userscript: workspace file (scripts/x.user.js), Violentmonkey name or id; line = line in the file'),
  line: z.number().int().positive().optional(),
  column: z.number().int().min(0).optional().describe('0-based; default: the first breakable position on the line'),
  function: z.string().optional().describe('Function name (or expression) evaluated in `realm`; breaks at its first statement'),
  event: z.string().optional().describe('Event breakpoint: "click", "DOMContentLoaded", "setTimeout", or a full id like "event.mouse.click"'),
});

export const debuggerTools = [
  tool({
    name: 'bp_set',
    description: 'Set a breakpoint: location {url|script, line, column?}, {function: name, realm?}, or {event: "click"}. condition = only pause when truthy; log_message = a logpoint (logs the expression list, e.g. "\'x is\', x", into console_read without pausing). Userscript lines are file lines. Then trigger it (navigate/click/verify) and use debugger_state.',
    args: {
      location: locationArg,
      condition: z.string().optional(),
      log_message: z.string().optional().describe('Logpoint: comma-separated expressions to log instead of pausing'),
      realm: realmArg.optional().describe('function breakpoints: the realm the name is evaluated in (default page)'),
      tab: tabArg,
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await debuggerFor(b);
      const loc = a.location;
      const kinds = [loc.url || loc.script ? 'line' : '', loc.function ? 'function' : '', loc.event ? 'event' : ''].filter(Boolean);
      if (kinds.length !== 1) fail('BAD_ARGS', 'location is one of {url|script, line}, {function}, {event}');
      let bp: Bp;
      if (loc.event) bp = await d.setEvent(loc.event);
      else if (loc.function) {
        const spec = toSpec(a.realm ?? { kind: 'page' });
        if (spec.kind === 'privileged') fail('BAD_ARGS', 'breakpoints in browser chrome code are refused (a pause would freeze the browser)');
        const g = await functionLocation(b, d, spec, loc.function, a.tab);
        bp = await d.setLine({ url: g.location.url, line: g.location.line, column: g.location.column + 1, condition: a.condition, log: a.log_message, label: `function ${loc.function}` });
        const m = await mapFor(d, bp.url);
        if (m) { bp.file = m.file; bp.fileLine = bp.line! - m.offset; }
      } else {
        if (!loc.line) fail('BAD_ARGS', 'line breakpoints need line');
        let url: string, fileLine: number | undefined, file: string | undefined;
        let line = loc.line!;
        if (loc.script) {
          url = await scriptUrl(b, d, loc.script);
          const m = await mapFor(d, url);
          if (m) { fileLine = line; file = m.file; line = line + m.offset; }
        } else {
          let prefix = '';
          if (loc.extension) {
            const ext = await resolveExtension(b, loc.extension);
            const host = await b.callChrome<string | null>(`({ id }) => WebExtensionPolicy.getByID(id)?.mozExtensionHostname ?? null`, { id: ext.id });
            if (!host) fail('EXTENSION_DISABLED', `${ext.name} is not running`);
            prefix = `moz-extension://${host}/`;
          }
          url = d.resolveUrl(loc.url!, prefix).url;
        }
        if (/^(chrome|resource):/.test(url)) fail('BAD_ARGS', 'breakpoints in browser chrome code are refused (a pause would freeze the browser)');
        bp = await d.setLine({ url, line, column: loc.column, condition: a.condition, log: a.log_message, label: url, file, fileLine });
        if (file && bp.line !== line) bp.fileLine = bp.line! - (line - fileLine!);
      }
      d.persist(); // with the file-line mapping added above
      return `set ${bpLine(bp)}`;
    },
  }),
  tool({
    name: 'bp_list',
    description: 'List breakpoints (line, logpoint, function, event, DOM), the pause-on-exceptions mode, and what is paused. detail "normal" adds the debugger connection (threads, sources, pause counts); `sources` lists loaded source URLs matching a substring.',
    args: { sources: z.string().optional().describe('List loaded source URLs containing this substring') },
    detail: true,
    async handler(a, ctx) {
      const d = debuggerIfRunning(ctx.current());
      if (!d) return 'debugger not started (no breakpoints)';
      const lines = d.bps.map(bpLine);
      lines.push(`pause on exceptions: ${d.exceptions}`);
      const p = d.current();
      lines.push(p ? await pauseSummary(d, p) : 'not paused');
      if (a.detail && a.detail !== 'summary') {
        const types = new Map<string, number>();
        for (const t of d.targets.values()) types.set(t.type, (types.get(t.type) ?? 0) + 1);
        lines.push(`connection: ${[...types].map(([k, v]) => `${v} ${k}`).join(', ')} target(s); ${d.sources.size} sources; ${d.stats.pauses} pause(s), ${d.stats.duplicates} duplicate(s) dropped, ${d.stats.autoResumed} auto-resumed, ${d.stats.reconnects} reconnect(s)`);
      }
      if (a.sources !== undefined) {
        const urls = [...d.sources.values()].filter((s) => s.url.includes(a.sources!)).map((s) => `${s.url}  (${s.actor.replace(/^.*\/\//, '')})`);
        lines.push(`sources matching "${a.sources}" (${urls.length}):`, ...urls.slice(0, 50).map((u) => `  ${u}`));
      }
      return lines.join('\n');
    },
  }),
  tool({
    name: 'bp_remove',
    description: 'Remove a breakpoint by id, or "all" (also turns pause-on-exceptions off, resumes, and closes the debugger connection so pages run uninstrumented).',
    args: { id: z.string().min(1).describe('Breakpoint id (bp_list) or "all"') },
    write: true,
    async handler(a, ctx) {
      const d = debuggerIfRunning(ctx.current());
      if (!d) return 'debugger not started';
      if (a.id === 'all') {
        const n = d.bps.length;
        for (const p of [...d.paused.values()]) await d.resume(p, null, 0).catch(() => {});
        const b = ctx.current()!;
        b.adapters.delete('debugger');
        d.close();
        delete b.state.debugger;
        b.save();
        return `removed ${n} breakpoint(s); debugger closed`;
      }
      const bp = d.bps.find((x) => x.id === a.id);
      if (!bp) fail('BP_NOT_FOUND', `no breakpoint ${a.id}`, `Breakpoints: ${d.bps.map((x) => x.id).join(', ') || 'none'}`);
      await d.remove(bp!);
      return `removed ${bpLine(bp!)}`;
    },
  }),
  tool({
    name: 'pause_on_exceptions',
    description: 'Pause when an exception is thrown: "uncaught", "all" (caught ones too) or "none". Pages, content scripts, userscripts and extension pages; never browser chrome.',
    args: { mode: z.enum(['none', 'uncaught', 'all']) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await debuggerFor(b);
      await d.setExceptions(a.mode);
      return `pause on exceptions: ${a.mode}`;
    },
  }),
  tool({
    name: 'debugger_state',
    description: 'When paused: reason, location (userscripts in file lines), source around it, call stack, and the variables in scope for the top frame. detail "full" adds more frames and `this`.',
    args: {},
    detail: true,
    async handler(a, ctx) {
      const d = debuggerIfRunning(ctx.current());
      if (!d) return 'debugger not started';
      const p = d.current();
      if (!p) return `not paused (${d.bps.length} breakpoint(s), pause on exceptions: ${d.exceptions})`;
      return stateText(d, p, a.detail ?? 'summary');
    },
  }),
  tool({
    name: 'step',
    description: 'Step the paused thread: "over" (next line), "into" (into a call), "out" (to the caller). Returns the new location and source.',
    args: { kind: z.enum(['over', 'into', 'out']).default('over') },
    write: true,
    async handler(a, ctx) {
      const d = debuggerIfRunning(ctx.current());
      if (!d) fail('NOT_PAUSED', 'debugger not started');
      const p = d!.requireCurrent();
      const next = await d!.resume(p, a.kind === 'over' ? 'next' : a.kind === 'into' ? 'step' : 'finish', 3000);
      if (!next) return 'resumed: the code ran to completion (or into code that is not debugged) without pausing again';
      const f = next.packet.frame;
      return [await pauseSummary(d!, next), ...await sourceContext(d!, f?.where, 1)].join('\n');
    },
  }),
  tool({
    name: 'resume',
    description: 'Resume the paused thread (it may pause again at the next breakpoint; then this reports where).',
    args: {},
    write: true,
    async handler(_a, ctx) {
      const d = debuggerIfRunning(ctx.current());
      if (!d) return 'debugger not started';
      const p = d.current();
      if (!p) return 'not paused';
      const next = await d.resume(p, null, 400);
      return next ? `resumed, then ${await pauseSummary(d, next)}` : 'resumed';
    },
  }),
  tool({
    name: 'eval_paused',
    description: 'Evaluate an expression inside a paused stack frame (frame 0 = top of the stack), seeing its local variables. No await.',
    args: {
      code: z.string().min(1),
      frame: z.number().int().min(0).default(0),
      serialize_depth: z.number().int().min(0).max(6).default(2),
    },
    write: true,
    unmask: true,
    async handler(a, ctx) {
      const d = debuggerIfRunning(ctx.current());
      if (!d) fail('NOT_PAUSED', 'debugger not started');
      const p = d!.requireCurrent();
      const frames = await d!.frames(p, a.frame + 1);
      const f = frames[a.frame];
      if (!f) fail('BAD_ARGS', `no frame #${a.frame} (stack depth ${frames.length})`);
      const label = `paused frame #${a.frame} ${frameName(f)}`;
      let r = await d!.evalInFrame(p, f.actor, `(${SERIALIZER})((${a.code}\n), ${a.serialize_depth}, false)`);
      if (r.exception && /SyntaxError/.test(r.exception)) {
        // statements: evaluate as-is and describe the completion value
        r = await d!.evalInFrame(p, f.actor, a.code);
        if (r.exception) fail('EVAL_EXCEPTION', `${r.exception} (in ${label})`, undefined, r.stack ? { stack: r.stack } : undefined);
        return `[${label}] ${gripText(r.result)}`;
      }
      if (r.exception) fail('EVAL_EXCEPTION', `${r.exception} (in ${label})`, undefined, r.stack ? { stack: r.stack } : undefined);
      const s = await d!.gripFull(r.result);
      let v: any = s;
      try { v = JSON.parse(s); } catch { /* not serialised */ }
      if (v && typeof v === 'object' && 'type' in v && 'value' in v) {
        const val = maskValue(v.value);
        return `[${label}] (${v.type}${v.xray ? ', Xray' : ''}) ${typeof val === 'string' ? JSON.stringify(val) : JSON.stringify(val, null, 1)}`;
      }
      v = maskValue(v);
      return `[${label}] ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, null, 1)}`;
    },
  }),
  tool({
    name: 'dom_breakpoint',
    description: 'Pause when an element changes: "subtree" (children added/removed), "attribute" (attributes changed), "removal" (the element is removed). For "something removed/changed my element" bugs.',
    args: {
      ref: refArg,
      type: z.enum(['subtree', 'attribute', 'removal']).or(z.array(z.enum(['subtree', 'attribute', 'removal'])).min(1)),
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await debuggerFor(b);
      const n = await resolveRef(b, a.ref.replace(/^\[|\]$/g, ''));
      const types = Array.isArray(a.type) ? a.type : [a.type];
      const bp = await d.setDom(n.context, n.sharedId, types, `DOM ${types.join('+')} on ${a.ref}`);
      return `set ${bpLine(bp)}`;
    },
  }),
];

/** Debugger tools never race against a pause (they are how Claude deals with one). */
export const DEBUGGER_TOOLS = new Set(debuggerTools.map((t) => t.name));
