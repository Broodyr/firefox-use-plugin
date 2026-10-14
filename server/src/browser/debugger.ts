// debugger over RDP. Its own devtools connection, started on the first debugger tool and closed by
// bp_remove("all"), so threads are only instrumented while debugging.
//
// Thread model (Firefox 157, Browser Toolbox "parent-process" scope): a content PROCESS target's thread debugs every
// global in that process (pages, content-script and userscript sandboxes, extension pages in the extension process).
// Window-global (frame) and content_script targets have threads of their own; watching them too makes one breakpoint
// pause twice. So this connection watches process + worker targets only; frame targets are added for DOM mutation
// breakpoints (the walker pauses through its frame's thread), and any other pause on a frame thread is a duplicate
// of the process thread's and is resumed at once.
import { Rdp } from '../transports/rdp.js';
import { ToolError, fail } from '../errors.js';
import { gripText, rdpEvaluate } from './devtools.js';
import type { Browser } from './session.js';
import { contextIds } from './realms.js';
import { sleep } from './launcher.js';
import { ADD_DEBUGGER } from './loadtrace.js';

export const PAUSE_TIMEOUT_MS = Number(process.env.FIREFOX_USE_PAUSE_TIMEOUT_MS) || 60000;

interface Target { actor: string; type: string; url?: string; threadActor?: string; consoleActor?: string; inspectorActor?: string; innerWindowId?: number; remoteType?: string; processID?: number }

/**
 * A pause hook sees every pause before it is reported: "resume" swallows it (resumed at once, never reported),
 * "keep" reports it as a normal pause, undefined lets the next hook decide (trace_load, pause_at_start).
 */
export type PauseHook = (p: any, target: Target | undefined) => 'resume' | 'keep' | undefined;
export const FIRST_STATEMENT = 'script.source.firstStatement';
interface Source { actor: string; url: string }

export interface Bp {
  id: string;
  kind: 'line' | 'event' | 'dom';
  /** line: the location given to Firefox (source URL, 1-based line, 0-based column) */
  url?: string; line?: number; column?: number;
  /** userscript breakpoints: workspace file / script name and the line in the file */
  file?: string; fileLine?: number;
  condition?: string; log?: string;
  /** what the user asked for (function name, event, ref) */
  label: string;
  event?: string;
  dom?: { walker: string; node: string; types: string[] };
  /** source not loaded yet: column guessed from the line's indentation, checked when the source arrives */
  pending?: boolean;
  note?: string;
}

/** What the run state keeps of the debugger across backend reloads. */
export interface SavedDebugger { bps: Bp[]; exceptions: 'none' | 'uncaught' | 'all'; nextBp: number; scriptMaps?: [string, ScriptMap][]; dom?: string[] }

export interface PauseInfo { thread: string; packet: any; since: number; timer: NodeJS.Timeout; target?: Target }

/** VM / fast-mode userscript sources: file line = source line - offset. */
export interface ScriptMap { file: string; name: string; offset: number }

export class Debugger {
  rdp: Rdp;
  private watcher = '';
  private bpl = '';
  private cfg = '';
  readonly targets = new Map<string, Target>();
  readonly sources = new Map<string, Source>();
  readonly bps: Bp[] = [];
  private nextBp = 1;
  /** paused threads, oldest first; the first one is "the" pause the tools act on */
  readonly paused = new Map<string, PauseInfo>();
  exceptions: 'none' | 'uncaught' | 'all' = 'none';
  private framesWatched = false;
  private eventCatalog: { id: string; name: string; group: string }[] | null = null;
  private pauseWaiters = new Set<(p: PauseInfo) => void>();
  readonly pauseHooks: PauseHook[] = [];
  /** event breakpoints the tools use internally (first statement for trace_load / pause_at_start), never listed */
  readonly internalEvents = new Set<string>();
  private sourceWaiters = new Set<(s: Source) => void>();
  /** source URL -> userscript mapping (filled by the tools when a script breakpoint is set) */
  readonly scriptMaps = new Map<string, ScriptMap>();
  dead = false;
  readonly stats = { pauses: 0, autoResumed: 0, duplicates: 0, reconnects: 0 };

  private constructor(private b: Browser) { this.rdp = new Rdp(b.state.rdpPort); }

  static async start(b: Browser): Promise<Debugger> {
    const d = new Debugger(b);
    try { await d.connect(); } catch (e) {
      d.close();
      throw e instanceof ToolError ? e : new ToolError('DEBUGGER_UNAVAILABLE', `debugger connection failed: ${(e as any)?.message ?? e}`);
    }
    return d;
  }

  private async connect() {
    const rdp = this.rdp;
    await rdp.connect();
    rdp.onClose = () => { if (rdp !== this.rdp) return; this.dead = true; for (const p of this.paused.values()) clearTimeout(p.timer); this.paused.clear(); };
    rdp.on((p) => { if (rdp === this.rdp) this.onPacket(p); });
    const proc = await rdp.request('root', 'getProcess', { id: 0 });
    this.watcher = (await rdp.request(proc.processDescriptor.actor, 'getWatcher', { isServerTargetSwitchingEnabled: true })).actor;
    for (const t of ['process', 'worker']) await rdp.request(this.watcher, 'watchTargets', { targetType: t }, 20000);
    // shared and service workers are target types of their own (in this "all" session context the devtools server
    // exposes every one); best effort: older builds may not know them
    for (const t of ['shared_worker', 'service_worker']) await rdp.request(this.watcher, 'watchTargets', { targetType: t }, 20000).catch(() => {});
    await rdp.request(this.watcher, 'watchResources', { resourceTypes: ['source', 'thread-state'] }, 30000);
    this.cfg = (await rdp.request(this.watcher, 'getThreadConfigurationActor')).configuration.actor;
    // never pause on `debugger;` statements in arbitrary pages (only on what Claude asked for)
    await rdp.request(this.cfg, 'updateConfiguration', { configuration: { shouldPauseOnDebuggerStatement: false, pauseOnExceptions: false, ignoreCaughtExceptions: true } });
    this.bpl = (await rdp.request(this.watcher, 'getBreakpointListActor')).breakpointList.actor;
  }

  /**
   * A fresh connection, with every breakpoint and setting applied again. Firefox's thread keeps the sources of
   * content-script sandboxes that navigations destroyed, and setting a breakpoint then fails with "can't access dead
   * object" (the breakpoint is not applied in that process); new thread actors start without them.
   * DOM breakpoints belong to walker actors of the old connection and are dropped (returned).
   */
  private async reconnect(): Promise<Bp[]> {
    const old = this.rdp;
    for (const p of this.paused.values()) clearTimeout(p.timer);
    this.paused.clear();
    this.targets.clear();
    this.sources.clear();
    this.framesWatched = false;
    this.rdp = new Rdp(this.b.state.rdpPort);
    old.close();
    await this.connect();
    this.stats.reconnects++;
    if (this.exceptions !== 'none') await this.setExceptions(this.exceptions);
    await this.pushEvents();
    for (const bp of this.bps) if (bp.kind === 'line') await this.rawSet(bp).catch(() => {});
    const dropped = this.bps.filter((b) => b.kind === 'dom');
    for (const bp of dropped) this.bps.splice(this.bps.indexOf(bp), 1);
    this.persist();
    return dropped;
  }

  close() {
    this.dead = true;
    for (const p of this.paused.values()) clearTimeout(p.timer);
    this.paused.clear();
    this.rdp.close();
  }

  // ------------------------------------------------------------ across backend reloads
  /**
   * Breakpoints live in this RDP connection's watcher, which a backend reload closes. Keep them in the run state
   * (line, logpoint, function and event breakpoints; pause-on-exceptions) so the next backend sets them again.
   * DOM breakpoints belong to walker actors of this connection and can't be carried over.
   */
  persist() {
    const bps = this.bps.filter((b) => b.kind !== 'dom');
    if (!bps.length && this.exceptions === 'none') delete this.b.state.debugger;
    else this.b.state.debugger = { bps, exceptions: this.exceptions, nextBp: this.nextBp, scriptMaps: [...this.scriptMaps], dom: this.bps.filter((b) => b.kind === 'dom').map((b) => b.id) };
    this.b.save();
  }

  /** Set the saved breakpoints again on this (new) connection; returns a one-line note. */
  async restore(saved: SavedDebugger): Promise<string> {
    this.nextBp = Math.max(this.nextBp, saved.nextBp);
    for (const [u, m] of saved.scriptMaps ?? []) this.scriptMaps.set(u, m);
    const failed: string[] = [];
    for (const bp of saved.bps) {
      if (bp.kind === 'line') {
        try { await this.addBreakpoint(bp); this.bps.push(bp); if (bp.pending) void this.fixPending(bp); } catch (e: any) { failed.push(`${bp.id} (${e?.message ?? e})`); }
      } else if (bp.kind === 'event') this.bps.push(bp);
    }
    if (this.bps.some((b) => b.kind === 'event')) await this.pushEvents();
    if (saved.exceptions !== 'none') await this.setExceptions(saved.exceptions);
    this.persist();
    return [`debugger: re-applied ${this.bps.length} breakpoint(s)${saved.exceptions !== 'none' ? ` and pause on exceptions "${saved.exceptions}"` : ''} after a backend reload`,
      failed.length ? `; failed: ${failed.join(', ')}` : '',
      saved.dom?.length ? `; DOM breakpoint(s) ${saved.dom.join(', ')} can't be carried over: set them again` : ''].join('');
  }

  // ------------------------------------------------------------ events
  private onPacket(p: any) {
    switch (p.type) {
      case 'target-available-form': {
        const t = p.target;
        this.targets.set(t.actor, { actor: t.actor, type: t.targetType, url: t.url, threadActor: t.threadActor, consoleActor: t.consoleActor, inspectorActor: t.inspectorActor, innerWindowId: t.innerWindowId, remoteType: t.remoteType, processID: t.processID });
        break;
      }
      case 'target-destroyed-form': this.targets.delete(p.target?.actor); break;
      case 'resources-available-array':
        for (const [type, arr] of p.array ?? []) {
          if (type === 'source') for (const s of arr) if (s.url) this.addSource({ actor: s.actor, url: s.url });
        }
        break;
      case 'paused': this.onPaused(p); break;
      case 'resumed': { const x = this.paused.get(p.from); if (x) { clearTimeout(x.timer); this.paused.delete(p.from); } break; }
    }
  }

  private addSource(s: Source) {
    this.sources.set(s.actor, s);
    for (const f of [...this.sourceWaiters]) f(s);
  }

  private threadTarget(thread: string): Target | undefined {
    for (const t of this.targets.values()) if (t.threadActor === thread) return t;
    return undefined;
  }

  private onPaused(p: any) {
    const why = p.why?.type;
    if (why === 'attached' || why === 'interrupted') return;
    const target = this.threadTarget(p.from);
    if (target?.type === 'frame' && why !== 'mutationBreakpoint') {
      // the process thread pauses on the same code (see the header comment): drop this duplicate
      this.stats.duplicates++;
      this.rdp.request(p.from, 'resume', { resumeLimit: null }).catch(() => {});
      return;
    }
    for (const h of [...this.pauseHooks]) {
      const v = h(p, target);
      if (v === 'resume') { this.rdp.request(p.from, 'resume', { resumeLimit: null }).catch(() => {}); return; }
      if (v === 'keep') break;
    }
    const prev = this.paused.get(p.from);
    if (prev) clearTimeout(prev.timer);
    const info: PauseInfo = {
      thread: p.from, packet: p, since: Date.now(), target,
      timer: setTimeout(() => {
        // never leave a page frozen
        this.stats.autoResumed++;
        this.rdp.request(p.from, 'resume', { resumeLimit: null }).catch(() => {});
      }, PAUSE_TIMEOUT_MS),
    };
    this.paused.delete(p.from);
    this.paused.set(p.from, info);
    this.stats.pauses++;
    for (const f of [...this.pauseWaiters]) f(info);
  }

  /** Resolves on the next pause (after this call). */
  nextPause(): { promise: Promise<PauseInfo>; cancel(): void } {
    let f!: (p: PauseInfo) => void;
    const promise = new Promise<PauseInfo>((res) => { f = (p) => { this.pauseWaiters.delete(f); res(p); }; this.pauseWaiters.add(f); });
    return { promise, cancel: () => this.pauseWaiters.delete(f) };
  }

  current(): PauseInfo | null { return this.paused.values().next().value ?? null; }

  requireCurrent(): PauseInfo {
    const p = this.current();
    if (!p) fail('NOT_PAUSED', 'nothing is paused', 'Set a breakpoint (bp_set), trigger it (navigate, click, verify, eval with setTimeout), then debugger_state.');
    return p!;
  }

  // ------------------------------------------------------------ sources
  sourcesFor(url: string): Source[] { return [...this.sources.values()].filter((s) => s.url === url); }

  /** URL or URL substring -> one source URL. Full URLs that aren't loaded yet are accepted (pending). */
  resolveUrl(q: string, prefix = ''): { url: string; loaded: boolean } {
    if (prefix && !q.startsWith(prefix) && /^[a-z][a-z0-9+.-]*:\/\//i.test(q)) fail('BAD_ARGS', `${q} is not a file of that extension (${prefix})`);
    const urls = [...new Set([...this.sources.values()].map((s) => s.url))].filter((u) => u.startsWith(prefix));
    if (urls.includes(q)) return { url: q, loaded: true };
    const hits = urls.filter((u) => u.includes(q));
    if (hits.length === 1) return { url: hits[0], loaded: true };
    if (hits.length > 1) {
      // prefer page/extension sources over browser internals
      const web = hits.filter((u) => /^(https?|moz-extension|file|claude-fast):/.test(u) || u.startsWith('claude-fast/'));
      if (web.length === 1) return { url: web[0], loaded: true };
      fail('AMBIGUOUS_SOURCE', `"${q}" matches ${hits.length} sources: ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ', …' : ''}`, 'Pass more of the URL.');
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q) || q.startsWith('claude-fast/')) return { url: q, loaded: false };
    if (prefix) return { url: prefix + q.replace(/^\//, ''), loaded: false };
    return fail('SOURCE_NOT_FOUND', `no loaded source matches "${q}"`, 'Load the page first, or pass the full URL (the breakpoint then waits for that source).');
  }

  async sourceText(src: Source): Promise<string> {
    const r = await this.rdp.request(src.actor, 'source');
    const s = r.source;
    if (typeof s === 'string') return s;
    if (s?.type === 'longString') return (await this.rdp.request(s.actor, 'substring', { start: 0, end: s.length })).substring;
    return String(s ?? '');
  }

  /** Breakable positions of a source: line -> columns. */
  async positions(src: Source, from: number, to: number): Promise<Map<number, number[]>> {
    const r = await this.rdp.request(src.actor, 'getBreakpointPositionsCompressed', { query: { start: { line: from, column: 0 }, end: { line: to, column: Infinity } } });
    const m = new Map<number, number[]>();
    for (const [k, v] of Object.entries(r.positions ?? {})) m.set(Number(k), (v as number[]).slice().sort((a, b) => a - b));
    return m;
  }

  /** First breakable position at or after (line, column), within the next 30 lines. */
  async snap(url: string, line: number, column?: number): Promise<{ line: number; column: number } | null> {
    // an HTML page has one source per inline <script>, all with the page's URL (and sources of past loads): merge
    const srcs = this.sourcesFor(url);
    if (!srcs.length) return null;
    const pos = new Map<number, number[]>();
    for (const s of srcs) {
      const p = await this.positions(s, line, line + 30).catch(() => new Map<number, number[]>());
      for (const [l, cols] of p) pos.set(l, [...new Set([...(pos.get(l) ?? []), ...cols])].sort((a, b) => a - b));
    }
    for (let l = line; l <= line + 30; l++) {
      const cols = pos.get(l);
      if (!cols?.length) continue;
      if (l === line && column !== undefined) {
        if (cols.includes(column)) return { line, column };
        const after = cols.find((c) => c >= column);
        if (after !== undefined) return { line, column: after };
        continue;
      }
      return { line: l, column: cols[0] };
    }
    return null;
  }

  /** Wait for a source with this URL (pending breakpoints). */
  waitSource(url: string, ms: number): Promise<Source | null> {
    const have = this.sourcesFor(url)[0];
    if (have) return Promise.resolve(have);
    return new Promise((res) => {
      const f = (s: Source) => { if (s.url === url) { clearTimeout(t); this.sourceWaiters.delete(f); res(s); } };
      const t = setTimeout(() => { this.sourceWaiters.delete(f); res(null); }, ms);
      this.sourceWaiters.add(f);
    });
  }

  // ------------------------------------------------------------ breakpoints
  async setLine(bp: Omit<Bp, 'id' | 'kind'> & { url: string; line: number }): Promise<Bp> {
    let { line, column } = bp;
    let note = '';
    let pending = false;
    const snapped = await this.snap(bp.url, line, column);
    if (snapped) {
      if (snapped.line !== line) note = `no breakable code on line ${line}; set on line ${snapped.line}`;
      line = snapped.line; column = snapped.column;
    } else if (this.sourcesFor(bp.url).length) {
      fail('NO_BREAKABLE_CODE', `no breakable code at or after ${bp.url}:${line} (next 30 lines)`);
    } else {
      // not loaded yet: Firefox needs a column (session data refuses line-only breakpoints), and it must be a
      // breakable one or code that runs as the source loads (a new worker's top level) is missed: ask SpiderMonkey
      // where it would break, by compiling (never running) the fetched source
      pending = true;
      if (column === undefined) column = await this.firstBreakable(bp.url, line);
      note = 'source not loaded yet: the breakpoint applies when it loads';
    }
    const full: Bp = { ...bp, id: `bp${this.nextBp++}`, kind: 'line', line, column, pending, note: note || undefined };
    await this.addBreakpoint(full);
    this.bps.push(full);
    this.persist();
    if (pending) void this.fixPending(full);
    return full;
  }

  /** Breakpoints are watcher session data: stored, then applied to every target (and to documents loaded later). */
  private rawSet(bp: Bp) {
    return this.rdp.request(this.bpl, 'setBreakpoint', { location: { sourceUrl: bp.url, line: bp.line, column: bp.column }, options: this.options(bp) });
  }

  private async addBreakpoint(bp: Bp) {
    try { await this.rawSet(bp); } catch (e: any) {
      if (!/dead object/.test(e?.message ?? '')) throw e;
      const dropped = await this.reconnect();
      await this.rawSet(bp);
      if (dropped.length) bp.note = [bp.note, `debugger reconnected (stale sources after navigations); DOM breakpoint(s) ${dropped.map((d) => d.id).join(', ')} were dropped: set them again`].filter(Boolean).join('; ');
    }
  }

  /**
   * Firefox's own logpoints (options.logValue) report only to a connection watching the frame's target, which
   * this process-level connection doesn't; so a logpoint is a condition that logs with the realm's console and is
   * never true. Its output reaches console_read like any console.log, attributed to the right realm.
   */
  private options(bp: Bp) {
    const o: Record<string, string> = {};
    if (bp.log) o.condition = `(${bp.condition || 'true'}) && (console.log(${JSON.stringify(`[logpoint ${bp.id}]`)}, ${bp.log}), false)`;
    else if (bp.condition) o.condition = bp.condition;
    return o;
  }

  /**
   * The first breakable column of a line of a source that isn't loaded yet: the fetched text is compiled as a
   * function body (one line of wrapper above it, columns unchanged) in a throwaway sandbox, never called, and a
   * Debugger in its own compartment lists the possible breakpoints of that line across all nested scripts.
   * Falls back to the line's indentation.
   */
  private async firstBreakable(url: string, line: number): Promise<number> {
    try {
      return await this.b.callChrome<number>(`async ({ url, line }) => {
        const text = await (await fetch(url)).text();
        const indent = (/^\\s*/.exec(text.split(/\\r?\\n/)[line - 1] ?? "") || [""])[0].length;
        ${ADD_DEBUGGER}
        const host = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { freshCompartment: true });
        addDebuggerToGlobal(host);
        const sb = Cu.Sandbox(null, { freshCompartment: true });
        try {
          // (explicit file name and line 1: otherwise lines count from the caller's position)
          const fn = Cu.evalInSandbox("(function () {\\n" + text + "\\n})", sb, null, "firefox-use-breakpoint-probe", 1);
          const dbg = new host.Debugger();
          const script = dbg.addDebuggee(sb).makeDebuggeeValue(fn).script;
          const cols = [];
          const walk = (s) => { for (const p of s.getPossibleBreakpoints({ line: line + 1 })) cols.push(p.columnNumber - 1); for (const c of s.getChildScripts()) walk(c); };
          walk(script);
          dbg.removeAllDebuggees();
          return cols.length ? Math.min(...cols) : indent;
        } catch (e) { return indent; } finally { Cu.nukeSandbox(sb); }
      }`, { url, line });
    } catch { return 0; }
  }

  /**
   * When a pending breakpoint's source arrives, pin it to a real breakable position (the next one if the column
   * worked out before the source loaded was off).
   */
  private async fixPending(bp: Bp) {
    const src = await this.waitSource(bp.url!, 10 * 60 * 1000);
    if (!src || this.dead || !this.bps.includes(bp)) return;
    bp.pending = false;
    const s = await this.snap(bp.url!, bp.line!, bp.column).catch(() => null);
    if (!s || (s.line === bp.line && s.column === bp.column)) { bp.note = undefined; this.persist(); return; }
    await this.rdp.request(this.bpl, 'removeBreakpoint', { location: { sourceUrl: bp.url, line: bp.line, column: bp.column } }).catch(() => {});
    bp.note = bp.column === undefined && s.line === bp.line ? undefined : `moved from ${bp.line}${bp.column === undefined ? '' : `:${bp.column}`} to ${s.line}:${s.column} when the source loaded`;
    bp.line = s.line; bp.column = s.column;
    await this.addBreakpoint(bp).catch(() => {});
    this.persist();
  }

  async eventCatalogue(): Promise<{ id: string; name: string; group: string }[]> {
    if (this.eventCatalog) return this.eventCatalog;
    const th = [...this.targets.values()].find((t) => t.threadActor && t.type === 'process')?.threadActor;
    if (!th) fail('DEBUGGER_UNAVAILABLE', 'no content process thread to ask for event breakpoint names');
    const r = await this.rdp.request(th!, 'getAvailableEventBreakpoints');
    this.eventCatalog = (r.value ?? []).flatMap((g: any) => (g.events ?? []).map((e: any) => ({ id: e.id, name: e.name, group: g.name })));
    return this.eventCatalog!;
  }

  async setEvent(q: string): Promise<Bp> {
    const cat = await this.eventCatalogue();
    const ql = q.toLowerCase();
    const hits = cat.filter((e) => e.id.toLowerCase() === ql || e.name.toLowerCase() === ql || e.id.toLowerCase().endsWith(`.${ql}`));
    if (!hits.length) fail('BAD_ARGS', `no event breakpoint "${q}"`, `Groups: ${[...new Set(cat.map((e) => e.group))].join(', ')}. Examples: ${cat.filter((_, i) => i % 6 === 0).slice(0, 30).map((e) => e.id).join(', ')}, …`);
    const bp: Bp = { id: `bp${this.nextBp++}`, kind: 'event', event: hits[0].id, label: `event ${hits[0].id} (${hits[0].group}: ${hits[0].name})` };
    this.bps.push(bp);
    await this.pushEvents();
    this.persist();
    return bp;
  }

  /** DOM mutation breakpoint on the element behind a BiDi node reference (dom_breakpoint). */
  async setDom(context: string, sharedId: string, types: string[], label: string): Promise<Bp> {
    if (!this.framesWatched) {
      await this.rdp.request(this.watcher, 'watchTargets', { targetType: 'frame' }, 20000);
      this.framesWatched = true;
    }
    const { innerWindowId } = await contextIds(this.b, context);
    let t: Target | undefined;
    for (let i = 0; i < 30 && !t; i++) {
      t = [...this.targets.values()].find((x) => x.type === 'frame' && x.innerWindowId === innerWindowId && x.inspectorActor);
      if (!t) await sleep(100);
    }
    if (!t) fail('REALM_NOT_FOUND', 'no devtools target for this document');
    // the walker pauses through its frame's own thread, which nothing else attaches in this (process-level) session
    if (t!.threadActor) await this.rdp.request(t!.threadActor, 'attach', { options: {} }).catch(() => {});
    // a unique selector path for the element, computed in the page
    const sel: string = await this.b.callPage(context, `(el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) i++;
        parts.unshift(n.localName + ':nth-child(' + i + ')');
      }
      return ':root > ' + parts.join(' > ');
    }`, [{ sharedId }]);
    const walker = (await this.rdp.request(t!.inspectorActor!, 'getWalker', { options: {} })).walker.actor;
    const doc = await this.rdp.request(walker, 'document', {});
    const q = await this.rdp.request(walker, 'querySelector', { node: doc.node.actor, selector: sel });
    if (!q.node) fail('REF_STALE', `the element is no longer in the page (${sel})`);
    const bps = { subtree: types.includes('subtree'), attribute: types.includes('attribute'), removal: types.includes('removal') };
    await this.rdp.request(walker, 'setMutationBreakpoints', { node: q.node.actor, ...bps });
    const bp: Bp = { id: `bp${this.nextBp++}`, kind: 'dom', dom: { walker, node: q.node.actor, types }, label };
    this.bps.push(bp);
    this.persist();
    return bp;
  }

  async remove(bp: Bp) {
    const i = this.bps.indexOf(bp);
    if (i >= 0) this.bps.splice(i, 1);
    this.persist();
    if (bp.kind === 'line') await this.rdp.request(this.bpl, 'removeBreakpoint', { location: { sourceUrl: bp.url, line: bp.line, column: bp.column } }).catch(() => {});
    else if (bp.kind === 'event') await this.pushEvents();
    else if (bp.kind === 'dom') await this.rdp.request(bp.dom!.walker, 'setMutationBreakpoints', { node: bp.dom!.node, subtree: false, attribute: false, removal: false }).catch(() => {});
  }

  /** Active event breakpoints = the user's plus the internal ones. */
  async pushEvents() {
    const ids = new Set([...this.bps.filter((b) => b.kind === 'event').map((b) => b.event!), ...this.internalEvents]);
    await this.rdp.request(this.bpl, 'setActiveEventBreakpoints', { ids: [...ids] });
  }

  /** Does anything need this connection (breakpoints, exception pauses, internal hooks)? */
  get idle() { return !this.bps.length && this.exceptions === 'none' && !this.internalEvents.size && !this.pauseHooks.length && !this.paused.size; }

  processOf(thread: string): number | undefined { return this.threadTarget(thread)?.processID; }

  async setExceptions(mode: 'none' | 'uncaught' | 'all') {
    await this.rdp.request(this.cfg, 'updateConfiguration', { configuration: { pauseOnExceptions: mode !== 'none', ignoreCaughtExceptions: mode !== 'all' } });
    this.exceptions = mode;
    this.persist();
  }

  // ------------------------------------------------------------ paused state
  async frames(p: PauseInfo, count = 20): Promise<any[]> {
    const r = await this.rdp.request(p.thread, 'frames', { start: 0, count });
    return r.frames ?? [];
  }

  /** Resume (limit: null) or step; waits up to waitMs for the next pause of that thread. */
  async resume(p: PauseInfo, limit: null | 'next' | 'step' | 'finish', waitMs = 3000): Promise<PauseInfo | null> {
    const next = this.nextPause();
    try {
      await this.rdp.request(p.thread, 'resume', { resumeLimit: limit ? { type: limit } : null });
      if (!limit && waitMs <= 0) return null;
      const r = await Promise.race([next.promise, sleep(limit ? waitMs : Math.min(waitMs, 300)).then(() => null)]);
      return r;
    } finally { next.cancel(); }
  }

  /** Evaluate in a paused frame; the result is a grip. */
  async evalInFrame(p: PauseInfo, frameActor: string, code: string): Promise<{ result?: any; exception?: string; stack?: string }> {
    const consoleActor = p.target?.consoleActor ?? this.threadTarget(p.thread)?.consoleActor;
    if (!consoleActor) fail('DEBUGGER_UNAVAILABLE', 'the paused thread has no console actor');
    return rdpEvaluate(this.rdp, consoleActor!, code, 15000, { frameActor });
  }

  async environment(frameActor: string): Promise<any> { return this.rdp.request(frameActor, 'getEnvironment'); }

  /** Full text of a grip (long strings). */
  async gripFull(g: any): Promise<string> {
    if (g && typeof g === 'object' && g.type === 'longString') return (await this.rdp.request(g.actor, 'substring', { start: 0, end: Math.min(g.length, 200000) })).substring;
    return typeof g === 'string' ? g : gripText(g);
  }

  sourceOf(actor: string | undefined): Source | undefined { return actor ? this.sources.get(actor) : undefined; }

  /** A source created right before a pause may be reported just after it. */
  waitSourceActor(actor: string | undefined, ms: number): Promise<Source | undefined> {
    if (!actor) return Promise.resolve(undefined);
    const have = this.sources.get(actor);
    if (have) return Promise.resolve(have);
    return new Promise((res) => {
      const f = (s: Source) => { if (s.actor === actor) { clearTimeout(t); this.sourceWaiters.delete(f); res(s); } };
      const t = setTimeout(() => { this.sourceWaiters.delete(f); res(undefined); }, ms);
      this.sourceWaiters.add(f);
    });
  }
}

/** The debugger for this browser, started on first use (b.adapters "debugger"). */
export async function debuggerFor(b: Browser): Promise<Debugger> {
  if (b.personal) fail('PERSONAL_MODE', 'the debugger is not available in personal mode');
  const have = b.adapters.get('debugger') as Debugger | undefined;
  if (have && !have.dead) return have;
  const d = await Debugger.start(b);
  b.adapters.set('debugger', d);
  b.closers.push(() => d.close());
  return d;
}

/** After a backend reload: start the debugger again when the run state has breakpoints (null = nothing saved). */
export async function restoreDebugger(b: Browser): Promise<string | null> {
  const saved = b.state.debugger;
  if (!saved || b.personal || (!saved.bps.length && saved.exceptions === 'none')) return null;
  const d = await debuggerFor(b);
  return d.restore(saved);
}

export function debuggerIfRunning(b: Browser | null): Debugger | null {
  const d = b?.adapters.get('debugger') as Debugger | undefined;
  return d && !d.dead ? d : null;
}
