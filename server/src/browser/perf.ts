// performance: Firefox Profiler (privileged Services.profiler) and memory reporters.
//
// The profile is analysed inside Firefox (it is megabytes of JSON); only a summary crosses BiDi. Measured on
// Firefox 157: JS frames are "fn (url:line:col)[id]" (a script's top level: "url[id]") in the JavaScript category;
// Gecko labels mark MutationObserver callbacks ("MutationCallback"), timer callbacks ("setTimeout handler") and
// layout/style flushes ("PresShell::DoFlushPendingNotifications …", "Styles", "Reflow <url>", "Layout <url>"),
// below the script frame that forced them. Idle samples (category Idle) separate tasks: a task = a run of busy
// samples, long = 50 ms or more. Everything here is sampled: times are estimates at the sampling interval.
import { NAV } from './internals.js';

/** function (profile, {pid?, from, to, interval, includeBrowser, top}) -> summary (runs in the chrome realm) */
const ANALYZE = `function __cfAnalyze(profile, o) {
  const cats = (profile.meta.categories || []).map((c) => c.name);
  const JS = cats.indexOf("JavaScript"), IDLE = cats.indexOf("Idle");
  const procs = [{ meta: profile.meta, threads: profile.threads, parent: true }, ...(profile.processes || []).map((p) => ({ meta: p.meta, threads: p.threads, parent: false }))];
  const scripts = new Map(), fns = new Map(), longTasks = [];
  let samples = 0, busy = 0, threads = 0;
  const S = (url) => { let s = scripts.get(url); if (!s) scripts.set(url, s = { self: 0, total: 0, mo: 0, moRuns: 0, flush: 0, flushRuns: 0 }); return s; };
  for (const pr of procs) {
    if (pr.parent && !o.includeBrowser) continue;
    const start = pr.meta.startTime;
    for (const t of pr.threads) {
      if (t.name !== "GeckoMain") continue;
      if (o.pid && String(t.pid) !== String(o.pid)) continue;
      threads++;
      const str = t.stringTable, fs = t.frameTable.schema, ss = t.stackTable.schema, sm = t.samples.schema;
      const fr = t.frameTable.data.map((f) => {
        const loc = String(str[f[fs.location]] || "").replace(/\\[\\d+\\]$/, "");
        const cat = f[fs.category];
        let js = null;
        if (cat === JS) {
          const m = /^(.*) \\((.+):(\\d+):(\\d+)\\)$/.exec(loc);
          if (m) js = { fn: m[1] || "(anonymous)", url: m[2], line: +m[3] };
          else if (/^([a-z][\\w+.-]*:\\/\\/|claude-fast\\/|about:|blob:|data:)/i.test(loc)) js = { fn: "(top level)", url: loc, line: f[fs.line] || 0 };
          // builtins written in JS (Array.prototype.filter, ...): their time is their caller's
          if (js && js.url === "self-hosted") js = null;
        }
        return { loc, cat, js, mo: loc === "MutationCallback", flush: /^(PresShell::DoFlushPendingNotifications|Styles$|Reflow |Layout )/.test(loc) };
      });
      // per stack (prefixes come first): youngest JS frame, scripts on the stack, MO callback, what forced a flush
      const st = [];
      for (const s of t.stackTable.data) {
        const p = s[ss.prefix] == null ? null : st[s[ss.prefix]];
        const f = fr[s[ss.frame]];
        // idle = the thread waits for work (the Idle category is on a label frame, not on the native leaf)
        const x = { leaf: f, idle: !!((p && p.idle) || f.cat === IDLE), young: f.js || (p ? p.young : null), urls: p ? p.urls : [], inMo: !!((p && p.inMo) || f.mo), moCb: p ? p.moCb : null, flushBy: p ? p.flushBy : null };
        if (f.js && !x.urls.includes(f.js.url)) x.urls = [...x.urls, f.js.url];
        if (x.inMo && !x.moCb && f.js) x.moCb = f.js;
        if (f.flush && !x.flushBy && p && p.young) x.flushBy = p.young;
        st.push(x);
      }
      const data = t.samples.data;
      let task = null, lastMo = null, lastFlush = null;
      const endTask = () => {
        if (task && task.end - task.start >= 50) longTasks.push({ start: task.start, ms: Math.round(task.end - task.start), by: [...task.by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([u, ms]) => [u, Math.round(ms)]) });
        task = null;
      };
      for (let i = 0; i < data.length; i++) {
        const tm = start + data[i][sm.time];
        if (tm < o.from || tm > o.to) continue;
        const next = i + 1 < data.length ? start + data[i + 1][sm.time] : tm + o.interval;
        const w = Math.min(Math.max(next - tm, 0), o.interval * 2);
        const si = data[i][sm.stack];
        const x = si == null ? null : st[si];
        samples++;
        if (!x || x.idle) { endTask(); lastMo = lastFlush = null; continue; }
        busy += w;
        if (!task) task = { start: tm, end: tm, by: new Map() };
        task.end = tm + w;
        if (x.young) {
          S(x.young.url).self += w;
          task.by.set(x.young.url, (task.by.get(x.young.url) || 0) + w);
          const k = x.young.fn + " " + x.young.url + ":" + x.young.line;
          const e = fns.get(k) || { fn: x.young.fn, url: x.young.url, line: x.young.line, self: 0 };
          e.self += w;
          fns.set(k, e);
        }
        for (const u of x.urls) S(u).total += w;
        if (x.moCb) { const s = S(x.moCb.url); s.mo += w; if (lastMo !== x.moCb.url) s.moRuns++; lastMo = x.moCb.url; } else lastMo = null;
        if (x.flushBy) { const s = S(x.flushBy.url); s.flush += w; if (lastFlush !== x.flushBy.url) s.flushRuns++; lastFlush = x.flushBy.url; } else lastFlush = null;
      }
      endTask();
    }
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    busy: r1(busy), samples, threads,
    scripts: [...scripts.entries()].map(([url, s]) => ({ url, self: r1(s.self), total: r1(s.total), mo: r1(s.mo), moRuns: s.moRuns, flush: r1(s.flush), flushRuns: s.flushRuns })).sort((a, b) => b.total - a.total).slice(0, o.top * 3),
    fns: [...fns.values()].sort((a, b) => b.self - a.self).slice(0, o.top).map((f) => ({ ...f, self: r1(f.self) })),
    longTasks: longTasks.sort((a, b) => b.ms - a.ms).slice(0, 10),
  };
}`;

export interface PerfSummary {
  busy: number; samples: number; threads: number;
  scripts: { url: string; self: number; total: number; mo: number; moRuns: number; flush: number; flushRuns: number }[];
  fns: { fn: string; url: string; line: number; self: number }[];
  longTasks: { start: number; ms: number; by: [string, number][] }[];
}

export const PERF_START = `({ entries, interval, features, threads }) => {
  if (Services.profiler.IsActive()) return { busy: true };
  Services.profiler.StartProfiler(entries, interval, features, threads);
  return { busy: false, active: Services.profiler.IsActive() };
}`;

export const PERF_ACTIVE = `() => Services.profiler.IsActive()`;

/** Stop: analyse (optional), save the gzipped profile for the Firefox Profiler (optional), stop. */
export const PERF_STOP = `async ({ analyze, save }) => {
  ${ANALYZE}
  if (!Services.profiler.IsActive()) return { notRunning: true };
  let summary = null, saved = null, interval = null;
  try {
    if (save) {
      // Firefox 157: {profile: ArrayBuffer, additionalInformation}; earlier: the ArrayBuffer itself
      const g = await Services.profiler.getProfileDataAsGzippedArrayBuffer();
      const buf = g && g.profile ? g.profile : g;
      await IOUtils.write(save, new Uint8Array(buf));
      saved = buf.byteLength;
    }
    if (analyze) {
      const p = await Services.profiler.getProfileDataAsync();
      interval = p.meta.interval;
      summary = __cfAnalyze(p, { ...analyze, interval: analyze.interval || p.meta.interval });
    }
  } finally { Services.profiler.StopProfiler(); }
  return { summary, saved, interval };
}`;

/** Content process pid and top outer window id of a tab (memory reporters name windows "top(<url>, id=<outer id>)"). */
export const TAB_WINDOW = `({ id }) => {
  ${NAV}
  const wg = Nav.getBrowsingContextById(id)?.currentWindowGlobal;
  return wg ? { pid: wg.osPid, outer: wg.outerWindowId, url: wg.documentURI ? wg.documentURI.spec : "" } : null;
}`;

/**
 * Memory reports of one content process (getReports gathers every process; anonymize=false: real URLs, masked
 * later): the tab's window subtree ("explicit/window-objects/top(…, id=<outer>)/…"), the process's other explicit
 * memory by top-level bucket, and its resident/heap totals.
 */
export const MEM_REPORTS = `async ({ pid, outer, url }) => {
  const mgr = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);
  const pageKey = url.replace(/#.*$/, "").replaceAll("/", "\\\\");
  const win = [], other = {}, totals = {}, ext = {};
  const mine = (proc) => new RegExp("\\\\(pid " + pid + "\\\\)").test(proc);
  await new Promise((res) => mgr.getReports((proc, path, kind, units, amount) => {
    if (units !== Ci.nsIMemoryReporter.UNITS_BYTES || !mine(proc)) return;
    if (path.startsWith("explicit/window-objects/top(") && path.includes(", id=" + outer + ")")) win.push([path, amount]);
    else if (path.startsWith("explicit/")) {
      const k = path.split("/").slice(0, 2).join("/");
      other[k] = (other[k] || 0) + amount;
      // content-script sandboxes: realms "[Expanded Principal [<page URL>, moz-extension://<uuid>/]], Content Script…",
      // with "/" written as "\\" in report paths; the page URL in them says which tab's they are
      const u = /moz-extension:[\\\\/]+([0-9a-f-]{36})/.exec(path);
      if (u && path.includes(pageKey)) ext[u[1]] = (ext[u[1]] || 0) + amount;
    }
    else if (/^(resident|resident-unique|heap-allocated)$/.test(path)) totals[path] = amount;
  }, null, () => res(), null, false));
  return { win, other, totals, ext };
}`;
