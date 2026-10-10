// performance: perf_profile (Firefox Profiler, summary grouped by script origin), perf_script_cost (one
// page load, per-script cost), perf_memory (memory reporters for a tab, extension compartments included).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail } from '../errors.js';
import { stateDir } from '../audit/audit.js';
import { MEM_REPORTS, PERF_ACTIVE, PERF_START, PERF_STOP, TAB_WINDOW, type PerfSummary } from '../browser/perf.js';
import { sleep } from '../browser/launcher.js';
import type { Browser } from '../browser/session.js';
import { readState } from '../adapters/violentmonkey.js';
import { maskText } from '../safety/mask.js';
import { tool, tabArg } from './registry.js';

const VM_SRC = /^moz-extension:\/\/[^/]+\/%20(.+)\.user\.js#(\d+)$/;

/** Who a script URL belongs to: the page (origin), an extension (by name), a userscript, or Firefox itself. */
function origin(b: Browser, url: string): string {
  const vm = VM_SRC.exec(url);
  if (vm) {
    const link = Object.entries(readState().links).find(([, l]) => l.mode === 'manager' && String(l.id) === vm[2]);
    return `userscript "${decodeURIComponent(vm[1])}"${link ? ` (${link[0]})` : ''}`;
  }
  if (url.startsWith('claude-fast/')) return `userscript ${url.slice(12).replace(/\.user\.js$/, '')} (fast mode)`;
  if (url.startsWith('moz-extension://')) {
    const id = b.devtools?.addonForUrl(url);
    return `extension ${(id && b.devtools?.extNameById.get(id)) ?? id ?? url.slice(16, 52)}`;
  }
  if (/^(resource|chrome|about):/.test(url)) return 'Firefox internals';
  try { const o = new URL(url).origin; if (o !== 'null') return `page ${o}`; } catch { /* below */ }
  return url.slice(0, 60);
}

/** One script: its origin plus a short name (the file, or "inline" for the document's own scripts). */
function scriptLabel(b: Browser, url: string, docUrl?: string): string {
  const o = origin(b, url);
  if (!o.startsWith('page ') && !o.startsWith('extension ')) return o;
  const noHash = (u: string) => u.replace(/#.*$/, '');
  if (docUrl && noHash(url) === noHash(docUrl)) return 'page inline scripts';
  let file = url;
  try { const u = new URL(url); file = u.pathname.split('/').filter(Boolean).slice(-2).join('/') || u.pathname; } catch { /* keep */ }
  return o.startsWith('extension ') ? `${o} ${file}` : `page script ${file}`;
}

const ms = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1));
const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

function longTaskLines(b: Browser, s: PerfSummary, t0: number, docUrl?: string): string[] {
  return s.longTasks.map((t) => `  ${t.ms} ms at +${Math.round(t.start - t0)} ms: ${t.by.map(([u, x]) => `${scriptLabel(b, u, docUrl)} ${x} ms`).join(', ') || 'no script (browser work)'}`);
}

async function tabPid(b: Browser, context: string): Promise<{ pid: number; outer: number; url: string }> {
  const w = await b.callChrome<{ pid: number; outer: number; url: string } | null>(TAB_WINDOW, { id: context });
  if (!w) fail('NO_DOCUMENT', 'the tab has no document');
  return w!;
}

interface Run { s: PerfSummary; t0: number; docUrl: string; file: string | null }
type Series = { url: string; self: number[]; total: number[]; mo: number[]; moRuns: number[]; flush: number[]; flushRuns: number[] };
interface Baseline { name: string; url: string; at: string; runs: number; busy: number[]; scripts: Record<string, Series> }

/** One page load under the profiler (0.5 ms samples of the document's main thread, load + settle). */
async function measureLoad(b: Browser, context: string, navTo: string, settleMs: number, top: number, save: boolean): Promise<Run> {
  if (await b.callChrome<boolean>(PERF_ACTIVE)) fail('PROFILER_BUSY', 'the profiler is already running', 'perf_profile action "stop" first (or wait for another session).');
  await b.callChrome(PERF_START, { entries: 1 << 23, interval: 0.5, features: ['js', 'stackwalk', 'cpu'], threads: ['GeckoMain'] });
  const t0 = Date.now();
  let nav: any;
  try {
    nav = await b.bidi.send('browsingContext.navigate', { context, url: navTo, wait: 'complete' }, 60000).catch((e: any) => ({ error: e.message }));
    if (!nav?.error) await sleep(settleMs);
  } catch (e) { await b.callChrome(PERF_STOP, { analyze: null, save: null }).catch(() => {}); throw e; }
  // the document's process (after a cross-process navigation it is a new one)
  const w = await tabPid(b, context).catch(() => null);
  const file = save ? path.join(stateDir('artifacts'), `profile-load-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`) : null;
  const r = await b.callChrome<{ summary: PerfSummary; saved: number | null }>(PERF_STOP, { analyze: { pid: w?.pid, from: t0, to: Date.now(), includeBrowser: false, top: Math.max(top, 30), interval: 0.5 }, save: file });
  if (nav?.error) fail('NAVIGATION_FAILED', `${navTo}: ${nav.error}`);
  return { s: r.summary, t0, docUrl: w?.url ?? navTo, file };
}

/** Per-script series across runs, keyed by label (a script missing from a run counts 0 there). */
function aggregate(b: Browser, runs: Run[]): { busy: number[]; scripts: Map<string, Series> } {
  const scripts = new Map<string, Series>();
  runs.forEach((r, i) => {
    for (const x of r.s.scripts) {
      if (/^(resource|chrome|about):/.test(x.url)) continue;
      const l = scriptLabel(b, x.url, r.docUrl);
      let v = scripts.get(l);
      if (!v) scripts.set(l, (v = { url: x.url, self: Array(runs.length).fill(0), total: Array(runs.length).fill(0), mo: Array(runs.length).fill(0), moRuns: Array(runs.length).fill(0), flush: Array(runs.length).fill(0), flushRuns: Array(runs.length).fill(0) }));
      v.self[i] += x.self; v.total[i] += x.total; v.mo[i] += x.mo; v.moRuns[i] += x.moRuns; v.flush[i] += x.flush; v.flushRuns[i] += x.flushRuns;
    }
  });
  return { busy: runs.map((r) => r.s.busy), scripts };
}

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const spread = (xs: number[]) => (xs.length > 1 ? `${ms(Math.min(...xs))}–${ms(Math.max(...xs))}` : ms(xs[0] ?? 0));
const delta = (o: number, n: number) => `${n - o >= 0 ? '+' : ''}${ms(n - o)} ms${o > 0.5 ? `, ${n - o >= 0 ? '+' : ''}${Math.round(((n - o) / o) * 100)}%` : ''}`;
const cell = (v: number, n: number) => (v || n ? `${ms(v)} ms / ${n}` : '-');
const baselineFile = (name: string) => path.join(stateDir('artifacts', 'perf-baselines'), `${name}.json`);
const listBaselines = () => { try { return fs.readdirSync(stateDir('artifacts', 'perf-baselines')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };

export const perfTools = [
  tool({
    name: 'perf_profile',
    description: 'Firefox Profiler: action "start" records every content process (JS + native stacks, 1 ms samples); "stop" saves .firefox-use/artifacts/profile-*.json.gz (open it at profiler.firefox.com) and summarises: main-thread busy time, self time grouped by script origin (page, each extension, each userscript, Firefox), top functions, long tasks. Sampled: times are estimates.',
    args: {
      action: z.enum(['start', 'stop']),
      interval_ms: z.number().min(0.1).max(20).default(1).describe('start: sampling interval'),
      features: z.array(z.string()).optional().describe('start: profiler features (default js, stackwalk, cpu)'),
      threads: z.array(z.string()).optional().describe('start: thread names (default GeckoMain, DOM Worker)'),
      include_browser: z.boolean().default(false).describe('stop: include the parent process (Firefox UI, extension backgrounds run elsewhere)'),
      save: z.boolean().default(true).describe('stop: write the .json.gz'),
      top: z.number().int().min(1).max(50).default(15),
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const key = 'perfProfile';
      if (a.action === 'start') {
        const r = await b.callChrome<{ busy: boolean }>(PERF_START, { entries: 1 << 24, interval: a.interval_ms, features: a.features ?? ['js', 'stackwalk', 'cpu'], threads: a.threads ?? ['GeckoMain', 'DOM Worker'] });
        if (r.busy) fail('PROFILER_BUSY', 'the profiler is already running', b.adapters.has(key) ? 'perf_profile action "stop" first.' : 'Another session (or the user, in about:profiling) is profiling; wait for it.');
        b.adapters.set(key, { started: Date.now(), interval: a.interval_ms });
        return `profiler started (${a.interval_ms} ms samples). Do the work, then perf_profile action "stop".`;
      }
      const st = b.adapters.get(key) as { started: number; interval: number } | undefined;
      if (!st) fail('NOT_RUNNING', 'this session did not start the profiler', 'perf_profile action "start" first.');
      const file = a.save ? path.join(stateDir('artifacts'), `profile-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`) : null;
      const to = Date.now();
      const r = await b.callChrome<{ notRunning?: boolean; summary: PerfSummary; saved: number | null }>(PERF_STOP, { analyze: { from: st!.started, to, includeBrowser: a.include_browser, top: a.top, interval: st!.interval }, save: file });
      b.adapters.delete(key);
      if (r.notRunning) fail('NOT_RUNNING', 'the profiler was stopped by someone else');
      const s = r.summary;
      const byOrigin = new Map<string, number>();
      for (const x of s.scripts) byOrigin.set(origin(b, x.url), (byOrigin.get(origin(b, x.url)) ?? 0) + x.self);
      const lines = [
        `profile ${Math.round((to - st!.started) / 100) / 10} s, ${s.threads} main thread(s): ${ms(s.busy)} ms busy${file ? ` · saved ${path.relative(process.cwd(), file) || file} (${kb(r.saved ?? 0)})` : ''}`,
        'self time by origin:',
        ...[...byOrigin.entries()].sort((x, y) => y[1] - x[1]).slice(0, a.top).map(([o, v]) => `  ${ms(v).padStart(7)} ms  ${o}`),
        'top functions (self):',
        ...s.fns.map((f) => `  ${ms(f.self).padStart(7)} ms  ${f.fn} (${scriptLabel(b, f.url)}:${f.line})`),
      ];
      if (s.longTasks.length) lines.push('long tasks (>= 50 ms):', ...longTaskLines(b, s, st!.started));
      return { text: maskText(lines.join('\n')), changes: file ? [{ kind: 'file', path: file }] : undefined };
    },
  }),
  tool({
    name: 'perf_script_cost',
    description: 'Per-script cost of a page load (default: reload the current page): main-thread time per script (self, and total incl. what it called), MutationObserver callback time and runs, forced layout/style flushes it caused, long tasks (>= 50 ms) and who ran in them, top functions. Profiler-sampled at 0.5 ms (estimates); page, content scripts and userscripts alike. Before/after a change: runs:5 + save_as:"before", edit, then runs:5 + compare_to:"before" (medians and spreads per script).',
    args: {
      url: z.string().optional(),
      settle_ms: z.number().int().min(0).max(30000).default(1500).describe('Keep measuring this long after load'),
      runs: z.number().int().min(1).max(10).default(1).describe('Loads to measure; with more than one, medians are reported (sampling noise is a few ms per script)'),
      save_as: z.string().regex(/^[\w.-]{1,60}$/).optional().describe('Store the per-script medians as a named baseline (.firefox-use/artifacts/perf-baselines/)'),
      compare_to: z.string().regex(/^[\w.-]{1,60}$/).optional().describe('Compare with a baseline saved earlier'),
      scripts: z.string().optional().describe('Only scripts whose label or URL contains this'),
      save: z.boolean().default(false).describe('Also write the (last run\'s) profile (.json.gz) to artifacts'),
      top: z.number().int().min(1).max(50).default(12),
      tab: tabArg,
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      let base: Baseline | null = null;
      if (a.compare_to) {
        try { base = JSON.parse(fs.readFileSync(baselineFile(a.compare_to), 'utf8')); } catch { fail('NO_BASELINE', `no baseline "${a.compare_to}"`, `Save one first: perf_script_cost(runs, save_as: "${a.compare_to}"). Saved: ${listBaselines().join(', ') || 'none'}`); }
      }
      const navTo = a.url ?? (await b.bidi.send('browsingContext.getTree', { root: context, maxDepth: 0 })).contexts[0].url;
      const runs: Run[] = [];
      for (let i = 0; i < a.runs; i++) runs.push(await measureLoad(b, context, navTo, a.settle_ms, a.top, a.save && i === a.runs - 1));
      const last = runs[runs.length - 1];
      const keep = (label: string, url: string) => !a.scripts || label.includes(a.scripts) || url.includes(a.scripts);
      const agg = aggregate(b, runs);
      if (a.save_as) {
        const bl: Baseline = { name: a.save_as, url: last.docUrl, at: new Date().toISOString(), runs: runs.length, busy: agg.busy, scripts: Object.fromEntries([...agg.scripts].map(([k, v]) => [k, v])) };
        fs.writeFileSync(baselineFile(a.save_as), JSON.stringify(bl, null, 1));
      }
      const lines: string[] = [];
      const head = runs.length > 1
        ? `${maskText(last.docUrl)} — ${runs.length} loads + ${a.settle_ms} ms each: median ${ms(med(agg.busy))} ms busy on the page's main thread (spread ${ms(Math.min(...agg.busy))}–${ms(Math.max(...agg.busy))}; 0.5 ms samples)`
        : `${maskText(last.docUrl)} — load + ${a.settle_ms} ms: ${ms(last.s.busy)} ms busy on the page's main thread (0.5 ms samples; estimates)`;
      lines.push(head);
      if (base) {
        if (base.url.replace(/#.*$/, '') !== last.docUrl.replace(/#.*$/, '')) lines.push(`NOTE: baseline "${base.name}" was measured on ${maskText(base.url)}`);
        lines.push(`vs baseline "${base.name}" (${base.runs} load(s), ${base.at.slice(0, 16).replace('T', ' ')}Z): busy ${ms(med(base.busy))} -> ${ms(med(agg.busy))} ms (${delta(med(base.busy), med(agg.busy))})`,
          'script: self before -> after (change) · total before -> after · [spread before | after]');
        const labels = [...new Set([...Object.keys(base.scripts), ...agg.scripts.keys()])]
          .filter((l) => keep(l, base!.scripts[l]?.url ?? agg.scripts.get(l)?.url ?? ''))
          .sort((x, y) => Math.abs(med(agg.scripts.get(y)?.self ?? [0]) - med(base!.scripts[y]?.self ?? [0])) - Math.abs(med(agg.scripts.get(x)?.self ?? [0]) - med(base!.scripts[x]?.self ?? [0])))
          .slice(0, a.top);
        for (const l of labels) {
          const o = base.scripts[l], n = agg.scripts.get(l);
          if (!o) { lines.push(`  ${l}: NEW · self ${ms(med(n!.self))} ms · total ${ms(med(n!.total))} ms`); continue; }
          if (!n) { lines.push(`  ${l}: GONE (was self ${ms(med(o.self))} ms · total ${ms(med(o.total))} ms)`); continue; }
          lines.push(`  ${l}: ${ms(med(o.self))} -> ${ms(med(n.self))} ms (${delta(med(o.self), med(n.self))}) · ${ms(med(o.total))} -> ${ms(med(n.total))} ms · [${spread(o.self)} | ${spread(n.self)}]`);
        }
        lines.push('(a change smaller than the spreads is noise; more runs narrow it)');
      } else if (runs.length > 1) {
        lines.push('script (medians): self · total · MutationObserver callbacks (time / runs) · forced layout/style (time / runs) · [self spread]');
        for (const [l, v] of [...agg.scripts].filter(([l, v]) => keep(l, v.url)).sort((x, y) => med(y[1].total) - med(x[1].total)).slice(0, a.top)) {
          lines.push(`  ${l}: ${ms(med(v.self))} ms · ${ms(med(v.total))} ms · MO ${cell(med(v.mo), med(v.moRuns))} · flush ${cell(med(v.flush), med(v.flushRuns))} · [${spread(v.self)}]`);
        }
        const lt = runs.map((r) => r.s.longTasks.length);
        lines.push(`long tasks (>= 50 ms) per load: ${lt.join(', ')}; the last load's:`, ...longTaskLines(b, last.s, last.t0, last.docUrl));
      } else {
        const s = last.s;
        const rows = s.scripts.filter((x) => !/^(resource|chrome|about):/.test(x.url))
          .map((x) => ({ ...x, label: scriptLabel(b, x.url, last.docUrl) }))
          .filter((x) => keep(x.label, x.url))
          .slice(0, a.top);
        const firefox = s.scripts.filter((x) => /^(resource|chrome|about):/.test(x.url)).reduce((n, x) => n + x.self, 0);
        lines.push('script: self · total · MutationObserver callbacks (time / runs) · forced layout/style (time / runs)',
          ...rows.map((x) => `  ${x.label}: ${ms(x.self)} ms · ${ms(x.total)} ms · MO ${cell(x.mo, x.moRuns)} · flush ${cell(x.flush, x.flushRuns)}`));
        if (!rows.length) lines.push('  (no script ran long enough to be sampled)');
        if (firefox) lines.push(`  (Firefox's own JS in this process: ${ms(firefox)} ms)`);
        if (s.longTasks.length) lines.push('long tasks (>= 50 ms):', ...longTaskLines(b, s, last.t0, last.docUrl));
        lines.push('top functions (self):', ...s.fns.filter((f) => !/^(resource|chrome):/.test(f.url)).slice(0, 8).map((f) => `  ${ms(f.self).padStart(6)} ms  ${f.fn} (${scriptLabel(b, f.url, last.docUrl)}:${f.line})`));
      }
      if (a.save_as) lines.push(`baseline "${a.save_as}" saved (${runs.length} load(s)); compare later with compare_to: "${a.save_as}"`);
      if (last.file) lines.push(`profile: ${last.file}`);
      return maskText(lines.join('\n'));
    },
  }),
  tool({
    name: 'perf_memory',
    description: 'Memory of a tab (default: current), from Firefox\'s memory reporters (about:memory): the page\'s window broken down (JS per realm — page vs extension content scripts —, DOM, layout, style), its content process\'s resident / heap totals and biggest other buckets.',
    args: { tab: tabArg, top: z.number().int().min(1).max(40).default(12) },
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const w = await tabPid(b, context);
      const r = await b.callChrome<{ win: [string, number][]; other: Record<string, number>; totals: Record<string, number>; ext: Record<string, number> }>(MEM_REPORTS, { pid: w.pid, outer: w.outer, url: w.url });
      if (!r.win.length) fail('NO_REPORTS', `no memory reports for this tab's window (pid ${w.pid}, window ${w.outer})`, 'Retry after the page has loaded.');
      const buckets = new Map<string, number>();
      let total = 0;
      for (const [p, n] of r.win) {
        total += n;
        const realm = /\/(?:js-)?realm\(([^)]*(?:\([^)]*\)[^)]*)*)\)/.exec(p)?.[1];
        let k: string;
        if (realm !== undefined) {
          const ext = /moz-extension:[\\/]+([0-9a-f-]{36})/.exec(realm);
          k = ext ? `JS: ${origin(b, `moz-extension://${ext[1]}/`)} (content scripts)` : /\[System Principal\]|Sandbox/i.test(realm) ? 'JS: sandboxes (tools, userscripts)' : 'JS: page';
        } else {
          const seg = p.replace(/^explicit\/window-objects\/top\([^)]*\)\/(?:active|cached)\/window\([^)]*\)\//, '').replace(/^explicit\/window-objects\/top\([^)]*\)\//, '').split('/');
          k = seg[0].startsWith('js-zone(') ? 'JS: zone (shared)' : seg[0] || 'other';
        }
        buckets.set(k, (buckets.get(k) ?? 0) + n);
      }
      const lines = [
        `${maskText(w.url)} (content process pid ${w.pid}): window ${kb(total)}`,
        ...[...buckets.entries()].sort((x, y) => y[1] - x[1]).slice(0, a.top).map(([k, n]) => `  ${kb(n).padStart(9)}  ${k}`),
        ...(Object.keys(r.ext).length ? ['extension content scripts in this page:', ...Object.entries(r.ext).sort((x, y) => y[1] - x[1]).map(([u, n]) => `  ${kb(n).padStart(9)}  ${origin(b, `moz-extension://${u}/`)}`)] : []),
        `process: resident ${kb(r.totals.resident ?? 0)}${r.totals['resident-unique'] ? ` (unique ${kb(r.totals['resident-unique'])})` : ''} · heap ${kb(r.totals['heap-allocated'] ?? 0)}`,
      ];
      if (a.detail !== 'summary') lines.push('other explicit memory in the process:', ...Object.entries(r.other).sort((x, y) => y[1] - x[1]).slice(0, a.top).map(([k, n]) => `  ${kb(n).padStart(9)}  ${k.replace(/^explicit\//, '')}`));
      return lines.join('\n');
    },
  }),
];
