// load trace: which scripts run, in which order, without pausing anything.
//
// A first-statement *breakpoint* gives the order too, but every pause spins a nested event loop in which other
// queued work runs (measured: a Violentmonkey content-mode script ran inside such a pause and went unrecorded), so
// it changes the very race it should show. Instead, each content process gets its own Debugger (in a fresh
// system compartment, like Firefox's own all-globals tracer) whose onEnterFrame hook records top-level frames and
// returns: nothing pauses. It runs from the content process target's console (devtools hub) and debugs only
// content-principal globals (pages, content-script and userscript sandboxes), never system code.
import type { Devtools, TargetInfo } from './devtools.js';

/** [epoch ms, script URL or null (type "dom": the event), line, document URL of the global, frame type or "dom", global class (Window / Sandbox)] */
export type ExecRecord = [number, string | null, number, string | null, string, string];

// Debugger.Script line lookup: getOffsetMetadata (getOffsetLocation was removed in Firefox 158), else the
// script's first line
const LINE_OF = `(script, offset) => typeof script.getOffsetMetadata === "function" ? script.getOffsetMetadata(offset).lineNumber
  : typeof script.getOffsetLocation === "function" ? script.getOffsetLocation(offset).lineNumber : script.startLine`;

const INSTALL = `(() => {
  const L = globalThis.__cfLoadTrace;
  if (L) { L.log.length = 0; L.errors = 0; L.firstError = null; L.on = true; L.attach(); return 'ok'; }
  const { addDebuggerToGlobal } = ChromeUtils.importESModule("resource://gre/modules/jsdebugger.sys.mjs");
  const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { freshCompartment: true });
  addDebuggerToGlobal(sb);
  const dbg = new sb.Debugger();
  const now = typeof ChromeUtils.dateNow === "function" ? () => ChromeUtils.dateNow() : () => Date.now();
  const T = globalThis.__cfLoadTrace = { dbg, log: [], on: true, errors: 0, firstError: null };
  const lineOf = ${LINE_OF};
  const content = (g) => { try { return !Cu.getObjectPrincipal(g.unsafeDereference()).isSystemPrincipal; } catch (e) { return false; } };
  // document events on the tracer's clock (exact): system-group capture listeners on each new content window,
  // which the page can't see or stop; rows [time, event, 0, document URL, "dom", "Window"]
  const docEvents = (g) => {
    let w;
    try { if (g.class !== "Window") return; w = g.unsafeDereference(); } catch (e) { return; }
    if (!w || typeof w.addEventListener !== "function") return;
    const href = () => { try { return String(w.location.href); } catch (e) { return null; } };
    const rec = (what) => { if (T.on && T.log.length < 5000) T.log.push([now(), what, 0, href(), "dom", "Window"]); };
    const opts = { capture: true, mozSystemGroup: true };
    try {
      rec("document created");
      w.addEventListener("DOMContentLoaded", (e) => { if (e.target === w.document) rec("DOMContentLoaded"); }, opts);
      w.addEventListener("load", (e) => { if (e.target === w.document) rec("load"); }, opts);
      w.addEventListener("readystatechange", (e) => { if (e.target === w.document) rec("readyState " + w.document.readyState); }, opts);
    } catch (e) {}
  };
  T.attach = () => {
    dbg.addAllGlobalsAsDebuggees();
    for (const g of dbg.getDebuggees()) if (!content(g)) dbg.removeDebuggee(g);
    dbg.onNewGlobalObject = (g) => { if (T.on && content(g)) { try { dbg.addDebuggee(g); } catch (e) {} docEvents(g); } };
    dbg.onEnterFrame = (frame) => {
      if (!T.on || frame.older || (frame.type !== 'global' && frame.type !== 'module' && frame.type !== 'eval')) return;
      try {
        const src = frame.script.source;
        const url = src.displayURL || src.url || null;
        let href = null;
        const cls = frame.script.global.class;
        try { const g = frame.script.global.unsafeDereference(); href = String(g.location ? g.location.href : ''); } catch (e) {}
        const line = lineOf(frame.script, frame.offset);
        if (T.log.length < 5000) T.log.push([now(), url, line, href, frame.type, cls]);
      } catch (e) {
        // counted and reported, never silent: a Debugger API change must not look like "no scripts ran"
        T.errors++;
        if (!T.firstError) T.firstError = String(e && e.message || e);
      }
    };
  };
  T.attach();
  return 'ok';
})()`;

/** ff_selfcheck: the tracer's Debugger calls (and the breakpoint-column ones) on a content-principal sandbox in the parent process (true or an error). */
export const TRACER_PROBE = `() => {
  const { addDebuggerToGlobal } = ChromeUtils.importESModule("resource://gre/modules/jsdebugger.sys.mjs");
  const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { freshCompartment: true });
  addDebuggerToGlobal(sb);
  if (typeof sb.Debugger !== "function" || typeof ChromeUtils.dateNow !== "function") return "Debugger/dateNow missing";
  const dbg = new sb.Debugger();
  const target = Cu.Sandbox("http://selfcheck.invalid", { freshCompartment: true });
  const lineOf = ${LINE_OF};
  let got = null;
  try {
    dbg.addDebuggee(target);
    dbg.onEnterFrame = (frame) => {
      if (got || frame.older) return;
      try {
        const src = frame.script.source;
        got = { url: src.displayURL || src.url, line: lineOf(frame.script, frame.offset), type: frame.type, cls: frame.script.global.class };
      } catch (e) { got = { error: String(e && e.message || e) }; }
    };
    Cu.evalInSandbox("var selfcheck = 1;", target, null, "selfcheck-probe.js", 7);
    if (!got) return "onEnterFrame never fired";
    if (got.error) return "frame inspection failed: " + got.error;
    if (got.url !== "selfcheck-probe.js" || got.line !== 7) return "unexpected frame " + JSON.stringify(got);
    // the debugger's breakpoint columns (debugger.ts firstBreakable) use the same Debugger.Script API
    const fn = Cu.evalInSandbox("(function () {\\n  var a = 1;\\n})", target, null, "selfcheck-bp.js", 1);
    const script = dbg.addDebuggee(target).makeDebuggeeValue(fn).script;
    const cols = script.getPossibleBreakpoints({ line: 2 }).map((p) => p.columnNumber);
    if (!cols.length || typeof script.getChildScripts !== "function") return "breakpoint positions changed: " + JSON.stringify(cols);
    return true;
  } catch (e) { return "Debugger API failed: " + (e && e.message || e); }
  finally { dbg.onEnterFrame = undefined; dbg.removeAllDebuggees(); Cu.nukeSandbox(target); }
}`;

const COLLECT = `(() => {
  const T = globalThis.__cfLoadTrace;
  if (!T) return '{"log":[],"errors":0}';
  T.on = false;
  T.dbg.onEnterFrame = undefined;
  T.dbg.onNewGlobalObject = undefined;
  T.dbg.removeAllDebuggees();
  const out = JSON.stringify({ log: T.log, errors: T.errors, firstError: T.firstError });
  T.log.length = 0;
  return out;
})()`;

/** Content processes that can run a tab's scripts (web content and the preallocated ones a navigation may take). */
function contentProcesses(d: Devtools): TargetInfo[] {
  return [...d.targets.values()].filter((t) => t.alive && t.type === 'process' && t.consoleActor && /^(web|prealloc|file)/.test(t.remoteType ?? ''));
}

export async function startLoadTrace(d: Devtools): Promise<TargetInfo[]> {
  const ts = contentProcesses(d);
  const ok: TargetInfo[] = [];
  await Promise.all(ts.map(async (t) => {
    const r: { result?: unknown; exception?: string } = await d.evaluate(t.consoleActor!, INSTALL, 10000).catch((e) => ({ exception: String(e?.message ?? e) }));
    if (r.result === 'ok') ok.push(t);
    else if (process.env.FIREFOX_USE_DEBUG_TRACE) process.stderr.write(`[loadtrace] ${t.remoteType}: ${JSON.stringify(r).slice(0, 300)}\n`);
  }));
  return ok;
}

export interface LoadTrace { execs: ExecRecord[]; /** frames the tracer failed to record */ errors: number; firstError?: string }

export async function stopLoadTrace(d: Devtools, ts: TargetInfo[]): Promise<LoadTrace> {
  // processes created during the trace (a cross-process navigation) had no tracer; nothing to collect there
  const out: LoadTrace = { execs: [], errors: 0 };
  await Promise.all(ts.map(async (t) => {
    const r = await d.evaluate(t.consoleActor!, COLLECT, 3000).catch(() => null);
    if (!r || r.exception) return;
    try {
      const c = JSON.parse(await d.longString(r.result));
      out.execs.push(...c.log);
      out.errors += c.errors;
      out.firstError ??= c.firstError ?? undefined;
    } catch { /* process gone */ }
  }));
  out.execs.sort((a, b) => a[0] - b[0]);
  return out;
}
