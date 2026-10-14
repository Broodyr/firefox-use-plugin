// timing and document-start control: trace_load (one ordered timeline of a page load), pause_at_start,
// spa_watch, resource_latency.
//
// Script executions come from a non-pausing per-process Debugger (browser/loadtrace.ts): exact order, ms times.
// Document events come from a BiDi preload script in its own sandbox (no page-visible change); console and
// network from the devtools hub; __claude.mark from the dev prelude's markers. pause_at_start does pause: at the
// first statement of the first script, through the debugger's event breakpoint.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail } from '../errors.js';
import { stateDir } from '../audit/audit.js';
import { FIRST_STATEMENT, debuggerFor, type PauseHook } from '../browser/debugger.js';
import { startLoadTrace, stopLoadTrace, type LoadTrace } from '../browser/loadtrace.js';
import { NAV } from '../browser/internals.js';
import type { Browser } from '../browser/session.js';
import { sleep } from '../browser/launcher.js';
import { readState } from '../adapters/violentmonkey.js';
import { resourceServer } from '../resources/server.js';
import { pauseSummary } from './debugger.js';
import { tool, tabArg } from './registry.js';
import { shortUrl } from './console.js';

const TRACE_SANDBOX = 'claude-trace';

/** Preload (own sandbox, runs before any page script): document events, script elements, watched selectors. */
const preload = (watch: string[]) => `() => {
  const T = { origin: performance.timeOrigin, url: location.href, ev: [] };
  window.__cfTrace = T;
  const now = () => Math.round(performance.now() * 10) / 10;
  const push = (kind, what) => { if (T.ev.length < 2000) T.ev.push({ t: now(), kind, what }); };
  push('dom', 'document created');
  document.addEventListener('readystatechange', () => push('dom', 'readyState ' + document.readyState), true);
  document.addEventListener('DOMContentLoaded', () => push('dom', 'DOMContentLoaded'), true);
  window.addEventListener('load', () => push('dom', 'load'), true);
  window.addEventListener('popstate', () => push('spa', 'popstate ' + location.href), true);
  window.addEventListener('hashchange', () => push('spa', 'hashchange ' + location.href), true);
  const watch = ${JSON.stringify(watch)};
  const seen = new Set();
  const check = () => { for (const s of watch) { if (seen.has(s)) continue; let hit = null; try { hit = document.querySelector(s); } catch (e) { seen.add(s); push('dom', 'bad selector ' + s); continue; } if (hit) { seen.add(s); push('dom', 'first match ' + s); } } };
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeName === 'SCRIPT') push('dom', 'script element ' + (n.src ? n.src : 'inline') + (m.target && m.target.nodeName ? ' in <' + m.target.nodeName.toLowerCase() + '>' : ''));
    if (watch.length) check();
  }).observe(document, { childList: true, subtree: true });
}`;

interface Row { t: number; cat: string; text: string; approx?: boolean }

async function tabPid(b: Browser, context: string): Promise<number | undefined> {
  return b.callChrome<number | null>(`({ id }) => {
    ${NAV}
    return Nav.getBrowsingContextById(id)?.currentWindowGlobal?.osPid ?? null;
  }`, { id: context }).then((x) => x ?? undefined).catch(() => undefined);
}

const VM_SRC = /^moz-extension:\/\/[^/]+\/%20(.+)\.user\.js#(\d+)$/;

/** page script / content script of an extension / userscript, from the source URL. */
function classify(b: Browser, url: string | undefined, docUrl: string): { cat: string; label: string } {
  if (!url) return { cat: 'script', label: 'eval / new Function' };
  const vm = VM_SRC.exec(url);
  if (vm) {
    const link = Object.entries(readState().links).find(([, l]) => l.mode === 'manager' && String(l.id) === vm[2]);
    return { cat: 'userscript', label: `${decodeURIComponent(vm[1])}${link ? ` (${link[0]})` : ''} [Violentmonkey]` };
  }
  if (url.startsWith('claude-fast/')) return { cat: 'userscript', label: `${url.slice(12, -8)} [fast mode]` };
  const ext = /^moz-extension:\/\/([^/]+)(\/.*)$/.exec(url);
  if (ext) {
    const id = b.devtools?.addonForUrl(url);
    return { cat: 'content', label: `${(id && b.devtools?.extNameById.get(id)) ?? id ?? 'extension'} ${ext[2]}` };
  }
  const noHash = (u: string) => u.replace(/#.*$/, '');
  if (noHash(url) === noHash(docUrl)) return { cat: 'script', label: 'page inline script' };
  return { cat: 'script', label: `page script ${shortUrl(url)}` };
}

export const timingTools = [
  tool({
    name: 'trace_load',
    description: 'Load a URL with a load trace: ONE ordered timeline (ms from navigation start) of script executions (page inline/external, extension content scripts, userscripts — exact order, nothing paused), DOMContentLoaded/load, script elements inserted, first match of watched selectors, __claude.mark markers, console and network. For "does my userscript run before the page\'s script / the extension\'s?" questions. Full JSON goes to .firefox-use/artifacts/.',
    args: {
      url: z.string().optional().describe('Default: reload the current page'),
      capture: z.array(z.enum(['scripts', 'userscripts', 'content', 'dom', 'marks', 'console', 'network'])).optional().describe('Default: all'),
      watch: z.array(z.string()).max(20).optional().describe('CSS selectors: report when each first matches'),
      settle_ms: z.number().int().min(0).max(30000).default(1000).describe('Keep tracing this long after load'),
      timeout_ms: z.number().int().positive().max(120000).default(20000),
      include_evals: z.boolean().default(false).describe('Also list eval/new Function scripts (else counted)'),
      tab: tabArg,
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const hub = await b.dt();
      const caps = new Set(a.capture ?? ['scripts', 'userscripts', 'content', 'dom', 'marks', 'console', 'network']);
      const logFrom = hub.cursor, netFrom = hub.netCursor;
      let preloadId: string | null = null;
      let navTo = a.url ?? '';
      const tracers = await startLoadTrace(hub);
      let trace: LoadTrace | null = null;
      try {
        preloadId = (await b.bidi.send('script.addPreloadScript', { functionDeclaration: preload(a.watch ?? []), contexts: [context], sandbox: TRACE_SANDBOX })).script;
        const t0 = Date.now();
        if (!navTo) navTo = (await b.bidi.send('browsingContext.getTree', { root: context })).contexts[0].url;
        const r: any = await b.bidi.send('browsingContext.navigate', { context, url: navTo, wait: 'complete' }, a.timeout_ms).catch((e: any) => ({ error: e.message }));
        if (r?.error) fail('NAVIGATION_FAILED', `${navTo}: ${r.error}`);
        await sleep(a.settle_ms);
        trace = await stopLoadTrace(hub, tracers);
        const execs = trace.execs;
        const page: any = JSON.parse(await b.callPage(context, '() => JSON.stringify(window.__cfTrace || null)', [], { sandbox: TRACE_SANDBOX }) ?? 'null');
        const origin: number = page?.origin ?? t0;
        const docUrl: string = page?.url ?? navTo;
        const noHash = (u: string | null) => (u ?? '').replace(/#.*$/, '');
        const rows: Row[] = [];
        let evals = 0;
        let exactDom = false;
        for (const [epoch, url, line, href, type, cls] of execs) {
          // document events from the tracer: exact, on the script rows' clock
          if (type === 'dom') {
            if (noHash(href) !== noHash(docUrl) || !caps.has('dom')) continue;
            if (url === 'document created' && rows.some((r) => r.text === 'document created')) continue; // the initial about:blank swap
            rows.push({ t: epoch - origin, cat: 'dom', text: url ?? '' });
            exactDom = true;
            continue;
          }
          // this document only (pages in other tabs of the process are traced too); never the browser's own code
          if (noHash(href) !== noHash(docUrl) || (url && /^(chrome|resource|about):/.test(url))) continue;
          // page-URL code in a sandbox is a tool's (BiDi preload/evaluation sandboxes), not the page's
          if (cls !== 'Window' && (!url || /^(https?|file):/.test(url))) continue;
          if (type === 'eval' && (!url || url === docUrl) && !a.include_evals) { evals++; continue; }
          const c = classify(b, url ?? undefined, docUrl);
          if (c.cat === 'script' && !caps.has('scripts')) continue;
          if (c.cat === 'userscript' && !caps.has('userscripts')) continue;
          if (c.cat === 'content' && !caps.has('content')) continue;
          const text = `${c.label}${type === 'eval' ? ' (eval)' : type === 'module' ? ' (module)' : ''}${line ? `:${line}` : ''}`;
          // Violentmonkey enters a content-mode script twice within a few ms (wrapper, then the script): one row
          if (rows.some((r) => r.text === text && epoch - origin - r.t < 5)) continue;
          rows.push({ t: epoch - origin, cat: c.cat, text });
        }
        // page-side times (script elements, watched selectors, SPA events, marks) are clamped to 1 ms by Firefox;
        // the document events themselves come exact from the tracer (the page-side copies only as a fallback)
        const tracerEvent = (w: string) => exactDom && /^(document created|readyState |DOMContentLoaded$|load$)/.test(w);
        for (const e of page?.ev ?? []) if (((e.kind === 'dom' && caps.has('dom')) || e.kind === 'spa') && !tracerEvent(e.what)) rows.push({ t: e.t, cat: e.kind, text: e.what, approx: true });
        const myTab = Number(Object.entries(b.state.tabs ?? {}).find(([, v]) => v === context)?.[0]);
        for (const e of hub.log) {
          if (e.seq <= logFrom) continue;
          const t = await b.tabForBc(e.bc);
          if (t !== undefined && t !== myTab) continue;
          if (t === undefined && e.source !== 'content' && e.source !== 'page') continue;
          if (e.text.startsWith('[claude-mark] ')) {
            if (!caps.has('marks')) continue;
            try { const m = JSON.parse(e.text.slice(14)); rows.push({ t: m.t, cat: 'mark', text: `${m.script}: ${m.label}`, approx: true }); } catch { /* malformed */ }
            continue;
          }
          if (e.text.startsWith('[claude-gmxhr] ') || e.text.startsWith('[claude-start] ') || !caps.has('console')) continue;
          rows.push({ t: e.ts - origin, cat: 'console', text: `${e.level} [${hub.realmLabel(e)}] ${e.text.slice(0, 160)}` });
        }
        if (caps.has('network')) {
          for (const e of hub.net) {
            if (e.seq <= netFrom || e.initiator !== 'page' || (await b.tabForBc(e.bc)) !== myTab) continue;
            rows.push({ t: e.ts - origin, cat: 'network', text: `${e.method} ${e.status ?? '…'} ${e.url}` });
          }
        }
        // a clamped time t means "somewhere in [t, t+1)": sort it at the end of its millisecond against exact times
        const key = (r: Row) => (r.approx ? r.t + 0.999 : r.t);
        rows.sort((x, y) => key(x) - key(y));
        const file = path.join(stateDir('artifacts'), `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify({ url: docUrl, rows, evals, ...(trace.errors ? { tracerErrors: trace.errors, tracerFirstError: trace.firstError } : {}) }, null, 1));
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.cat, (counts.get(r.cat) ?? 0) + 1);
        const lines = [`trace of ${docUrl}: ${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')}${evals ? `, ${evals} eval script(s) not listed` : ''} (script tracer in ${tracers.length} process(es), ${execs.length} top-level frame(s))`];
        if (trace.errors) lines.push(`WARNING: the script tracer failed on ${trace.errors} frame(s), so script rows are missing (${trace.firstError}). A Firefox update may have changed its Debugger API: run ff_selfcheck.`);
        const max = a.detail === 'full' ? 600 : a.detail === 'normal' ? 250 : 120;
        for (const r of rows.slice(0, max)) lines.push(`${`${r.t >= 0 ? '+' : '-'}${Math.abs(r.t).toFixed(1)}`.padStart(9)} ms${r.approx ? '~' : ' '} ${r.cat.padEnd(10)} ${r.text}`);
        if (rows.length > max) lines.push(`… ${rows.length - max} more rows (detail "full", or the file)`);
        lines.push(`(script${exactDom ? ' and document-event' : ''} rows are exact and in true order; ~ rows come from the page clock, which Firefox clamps to 1 ms: against exact rows they are good to about ±2 ms)`, `full trace: ${path.relative(process.cwd(), file)}`);
        return lines.join('\n');
      } finally {
        if (!trace) await stopLoadTrace(hub, tracers).catch(() => {});
        if (preloadId) await b.bidi.send('script.removePreloadScript', { script: preloadId }).catch(() => {});
      }
    },
    detail: true,
  }),
  tool({
    name: 'pause_at_start',
    description: 'Navigate and pause BEFORE any script of the page runs (document-start userscripts included), so breakpoints can be set in code that runs at load. Other extensions\' content scripts are skipped unless include_extensions. Then bp_set, and resume.',
    args: {
      url: z.string().optional().describe('Default: reload the current page'),
      include_extensions: z.boolean().default(false).describe('Also stop in other extensions\' content scripts'),
      timeout_ms: z.number().int().positive().max(60000).default(15000),
      tab: tabArg,
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const d = await debuggerFor(b);
      if (d.current()) fail('ALREADY_PAUSED', 'something is already paused', 'resume first.');
      const url = a.url ?? (await b.bidi.send('browsingContext.getTree', { root: context })).contexts[0].url;
      const target = url.replace(/#.*$/, '');
      let pid: number | undefined;
      let done = false;
      const hook: PauseHook = (p, t) => {
        if (done || p.why?.type !== 'eventBreakpoint' || p.why?.breakpoint !== FIRST_STATEMENT) return undefined;
        if (pid !== undefined && t?.processID !== pid) return 'resume';
        const src = d.sourceOf(p.frame?.where?.actor)?.url;
        const thisUrl: string = p.frame?.this?.preview?.url ?? '';
        const isVm = !!src && VM_SRC.test(src);
        // a script of the page itself: a top-level script (not an eval some tool or extension runs) in the page's window
        const isPage = p.frame?.type === 'global' && thisUrl.replace(/#.*$/, '') === target && (!src || !src.startsWith('moz-extension:'));
        const isExt = !!src && src.startsWith('moz-extension:') && !isVm;
        if (isVm || isPage || (isExt && a.include_extensions)) { done = true; return 'keep'; }
        return 'resume';
      };
      d.pauseHooks.unshift(hook);
      d.internalEvents.add(FIRST_STATEMENT);
      try {
        await d.pushEvents();
        const next = d.nextPause();
        void b.bidi.send('browsingContext.navigate', { context, url, wait: 'none' }, a.timeout_ms).catch(() => {});
        for (let i = 0; i < 50 && pid === undefined; i++) { await sleep(20); pid = await tabPid(b, context); }
        const p = await Promise.race([next.promise, sleep(a.timeout_ms).then(() => null)]);
        next.cancel();
        if (!p) return `no script ran in ${url} within ${a.timeout_ms} ms (nothing to pause in)`;
        return [`paused at the first script of ${url}:`, await pauseSummary(d, p), 'Set breakpoints now (bp_set), then resume. The pause auto-resumes after 60 s.'].join('\n');
      } finally {
        done = true;
        d.pauseHooks.splice(d.pauseHooks.indexOf(hook), 1);
        d.internalEvents.delete(FIRST_STATEMENT);
        await d.pushEvents().catch(() => {});
      }
    },
  }),
  tool({
    name: 'spa_watch',
    description: 'Report in-page navigations (pushState / replaceState / popstate / hashchange) of the agent tabs as events. on:true starts, on:false stops; without on, lists what was seen.',
    args: { on: z.boolean().optional() },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const w = spaWatch(b);
      if (a.on === true) { await w.start(); return 'watching in-page navigations of the agent tabs (spa_watch to list)'; }
      if (a.on === false) { await w.stop(); return `stopped; ${w.events.length} in-page navigation(s) seen`; }
      if (!w.events.length) return w.on ? 'no in-page navigations yet' : 'not watching (spa_watch on:true)';
      const tabs = new Map(Object.entries(b.state.tabs ?? {}).map(([k, v]) => [v, k]));
      return w.events.slice(-50).map((e) => `${new Date(e.ts).toISOString().slice(11, 23)} tab${tabs.get(e.context) ?? '?'} ${e.kind} ${e.url}`).join('\n');
    },
  }),
  tool({
    name: 'resource_latency',
    description: 'Delay a file served by the local resource server (resources/*.js, scripts/*.user.js, the uBO bundle), to reproduce race conditions. ms 0 removes the delay; without arguments lists the delays.',
    args: { path: z.string().optional().describe('e.g. "resources/bundle.js", "/scripts/x.user.js"'), ms: z.number().int().min(0).max(60000).optional() },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const srv = await resourceServer(b);
      if (a.path) {
        const p = '/' + a.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!a.ms) srv.latency.delete(p); else srv.latency.set(p, a.ms);
      }
      const list = [...srv.latency].map(([p, ms]) => `${srv.origin}${p}: +${ms} ms`);
      return list.length ? list.join('\n') : 'no artificial latency';
    },
  }),
];

// ------------------------------------------------------------ spa_watch: BiDi in-page navigation events
interface SpaWatch { on: boolean; events: { ts: number; context: string; kind: string; url: string }[]; start(): Promise<void>; stop(): Promise<void> }

export function spaWatch(b: Browser): SpaWatch {
  let w = b.adapters.get('spaWatch') as SpaWatch | undefined;
  if (w) return w;
  const events: SpaWatch['events'] = [];
  let sub: string | null = null;
  const handler = (e: { method: string; params: any }) => {
    if (!w!.on) return;
    if (e.method === 'browsingContext.historyUpdated') events.push({ ts: Date.now(), context: e.params.context, kind: 'history', url: e.params.url });
    else if (e.method === 'browsingContext.fragmentNavigated') events.push({ ts: Date.now(), context: e.params.context, kind: 'hash', url: e.params.url });
    if (events.length > 500) events.shift();
  };
  b.bidi.on('event', handler);
  b.closers.push(() => b.bidi.off('event', handler));
  w = {
    on: false, events,
    async start() {
      if (!sub) sub = (await b.bidi.send('session.subscribe', { events: ['browsingContext.historyUpdated', 'browsingContext.fragmentNavigated'] })).subscription ?? 'legacy';
      w!.on = true;
    },
    async stop() {
      w!.on = false;
      if (sub && sub !== 'legacy') await b.bidi.send('session.unsubscribe', { subscriptions: [sub] }).catch(() => {});
      sub = null;
    },
  };
  b.adapters.set('spaWatch', w);
  return w;
}
