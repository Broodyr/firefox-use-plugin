import fs from 'node:fs';
import path from 'node:path';
import { agentWindowSetting, ensureDir, loadConfig, mainProfileAddons, type Options, type WindowMode } from '../config.js';
import { ToolError, fail } from '../errors.js';
import { Bidi, BidiError, fromRemote, type BidiEvent } from '../transports/bidi.js';
import { clearOrphanBidiSession } from '../transports/rdp.js';
import * as CS from './chromeScripts.js';
import * as XS from './extScripts.js';
import {
  clearRunState, firefoxAlive, killFirefox, isAlive, killTree, launchFirefox, ownerPid, profileKey, readRunState, removeThrowaway,
  sleep, waitExit, writeRunState, type RunState,
} from './launcher.js';
import { RefStore } from './refs.js';
import { BODY_LIMIT, Devtools, type Hub } from './devtools.js';
import { GROUP_COLORS, clientPid, currentClient, runAsClient } from './client.js';
import type { Scope } from './scope.js';
import { RUN_DIR } from '../config.js';
import { ensureCompanion } from '../adapters/companion.js';
import { releaseStaleShadows } from '../adapters/violentmonkey.js';
import { launchDrift } from '../adapters/vmstore.js';
import { unstickAutomationPrefs } from './autoprefs.js';
import { DialogHandler, PROMPT_CAPS } from './dialogs.js';
import { DL_GUARD_INSTALL, syncDownloadApprovals } from './downloads.js';
import { lastCheckpoint, maybeDailyCold, readWarm, restoreWarm, takeWarm, type SnapMeta } from '../snapshots/snapshots.js';

export const SANDBOX = 'firefox-use';

/** ff_window's choice per mode, kept by this backend so it outlives an idle quit or ff_restart (run state holds it across a hot reload) */
const windowChoice: { dev?: WindowMode; personal?: WindowMode } = {};

export interface ConsoleEntry { ts: number; level: string; text: string; context?: string; url?: string }
export interface TabInfo { tab: number; id: string; agent: boolean; url: string; title: string; selected: boolean; current: boolean; bc?: number }

/** One automation session against one Firefox: BiDi transport, agent window, tab handles, refs. */
export class Browser {
  chromeCtx = '';
  readonly refs = new RefStore();
  readonly console: ConsoleEntry[] = [];
  private netInflight = new Map<string, Map<string, number>>(); // context -> requestId -> start
  private netLastActivity = new Map<string, number>();
  launchedNow = false;
  /** results of launchTasks() for the launch that created this session (reported once by ff_launch / ff_status) */
  launchNotes: string[] = [];
  /** said once, in the next tool result, after attaching to a running Firefox (re-applied breakpoints) */
  attachNotes: string[] = [];
  versions: any = null;
  dead = false;
  /** personal mode: the user's own profile over BiDi only (PersonalBrowser) */
  readonly personal: boolean = false;
  /** handoff per session: the user is driving the agent window; input tools refuse until ff_handback */
  private handoffs = new Map<string, { reason: string; tab: number; since: number; by?: 'live view' }>();
  get handoff() { return this.handoffs.get(currentClient()) ?? null; }
  set handoff(v) { if (v) this.handoffs.set(currentClient(), v); else this.handoffs.delete(currentClient()); }

  // ------------------------------------------------------------ per-session view (several sessions)
  /** this call's session: null = the owning session (state.current / state.scope); others live in state.clients */
  private clientInfo() {
    const c = currentClient();
    if (!c) return null;
    this.state.clients ??= {};
    let ci = this.state.clients[c];
    if (!ci) {
      // a new session routed through this backend: next free "Claude N" group; forget sessions that are gone
      for (const k of Object.keys(this.state.clients)) {
        if (!isAlive(clientPid(k))) { delete this.state.clients[k]; void this.callChrome(CS.CLOSE_CLIENT_GROUP, { key: k }).catch(() => {}); }
      }
      const used = new Set(Object.values(this.state.clients).map((x) => x.n));
      let n = 2;
      while (used.has(n)) n++;
      ci = this.state.clients[c] = { n, label: `Claude ${n}`, current: null, scope: null };
      this.save();
    }
    return ci;
  }
  get cur(): number | null { const ci = this.clientInfo(); return ci ? ci.current ?? null : this.state.current ?? null; }
  set cur(v: number | null) { const ci = this.clientInfo(); if (ci) ci.current = v; else this.state.current = v; }
  get scope(): Scope | null { const ci = this.clientInfo(); return (ci ? ci.scope : this.state.scope) ?? null; }
  set scope(v: Scope | null) { const ci = this.clientInfo(); if (ci) ci.scope = v; else this.state.scope = v; }
  /** areas approved "for the rest of this session" in the approval dialog; in memory, per client */
  private sessionAreas = new Map<string, Set<string>>();
  addSessionAreas(areas: string[]) { const c = currentClient(); const s = this.sessionAreas.get(c) ?? new Set(); for (const a of areas) s.add(a); this.sessionAreas.set(c, s); }
  sessionApproved(): string[] { return [...(this.sessionAreas.get(currentClient()) ?? [])]; }
  sessionApprovedFor(client: string): string[] { return [...(this.sessionAreas.get(client) ?? [])]; }

  /** Approvals belong to the task/session, not to one Firefox process: carry them across a restart (ff_restart, cold snapshots). */
  approvals() { return { scope: this.state.scope ?? null, clients: this.state.clients, sessionAreas: this.sessionAreas, checkpoints: [...this.adapters].filter(([k]) => k.startsWith('sessionCheckpoint:')) }; }
  adoptApprovals(a: ReturnType<Browser['approvals']>) {
    if (a.scope && !this.state.scope) this.state.scope = a.scope;
    if (a.clients) for (const [k, v] of Object.entries(a.clients)) { this.state.clients ??= {}; this.state.clients[k] ??= v; }
    for (const [k, v] of a.sessionAreas) this.sessionAreas.set(k, v);
    for (const [k, v] of a.checkpoints) this.adapters.set(k, v);
    this.save();
    void syncDownloadApprovals(this);
  }
  get groupLabel(): string { return this.clientInfo()?.label ?? 'Claude'; }
  private get groupColor(): string { const ci = this.clientInfo(); return ci ? GROUP_COLORS[(ci.n - 2) % GROUP_COLORS.length] : 'orange'; }
  /** last screenshot per context: maps screenshot pixels to document CSS px (doc = o + px / factor) */
  /** last navigationStarted time per context */
  readonly navStarted = new Map<string, number>();
  readonly shots = new Map<string, { factor: number; ox: number; oy: number; w: number; h: number }>();
  /** devtools hub (RDP parent watcher): unified console, network, extension/content-script realms */
  devtools: Devtools | null = null;
  devtoolsError = '';
  /** console_clear cursors per client */
  private consoleFloors = new Map<string, number>();
  consoleFloor(client = currentClient()): number { return this.consoleFloors.get(client) ?? 0; }
  setConsoleFloor(seq: number, client = currentClient()) { this.consoleFloors.set(client, seq); }
  /** top-level browsing context id -> tab handle (agent and user tabs) */
  readonly bcTab = new Map<number, number>();
  /** per-session adapter state (uBO logger poller, resource server, ...) and their teardown hooks */
  readonly adapters = new Map<string, unknown>();
  readonly closers: (() => void)[] = [];
  /** run for a new agent tab before its first navigation (network interception must cover it): (context, client) */
  readonly tabHooks: ((ctx: string, client: string) => Promise<void>)[] = [];
  /** dialogs and HTTP auth in agent tabs: policies per session, the record of what happened */
  readonly dialogs = new DialogHandler(this);
  get prompts() { return this.dialogs.entries; }
  protected runClosers() { for (const f of this.closers.splice(0)) { try { f(); } catch { /* ignore */ } } }

  protected constructor(public bidi: Bidi, public state: RunState, public opts: Options) {}

  // ------------------------------------------------------------ attach / launch
  static async open(opts: Options): Promise<Browser> {
    const key = profileKey(opts);
    let state = readRunState(key);
    let launched = false;
    let coldNote: string | null = null;
    if (state && !firefoxAlive(state)) { clearRunState(key); state = null; }
    if (state && state.ownerPid !== ownerPid() && isAlive(state.ownerPid)) {
      // index.ts routes calls through the owner's proxy instead; reaching here means that failed
      fail('PROFILE_BUSY', `${opts.profile} is being driven by another Claude session (owner pid ${state.ownerPid}) and its proxy could not be reached`,
        'Retry in a moment (the owning session may be reloading), or quit its Firefox (ff_quit there, or setup/kill.ps1).');
    }
    if (!state) {
      // daily automatic cold snapshot, while the profile is not in use
      const named = opts.profileMode === 'named' ? loadConfig().profiles[opts.profile] : undefined;
      const cold = named && fs.existsSync(named) ? maybeDailyCold(key, named) : null;
      if (cold) coldNote = cold;
      state = await launchFirefox(opts, key);
      launched = true;
    }
    try {
      const b = await Browser.connect(state, opts, launched);
      if (coldNote) b.launchNotes.unshift(coldNote);
      return b;
    } catch (e) {
      // never leave a Firefox we just started running without an owner
      if (launched) { killFirefox(state); clearRunState(key); removeThrowaway(state); }
      // the recorded Firefox died (or is dying) between calls: forget it and start a fresh one
      else if (e instanceof ToolError && e.code === 'BIDI_CONNECT') {
        // (never kill the recorded pid here: Windows may have reused it for another process;
        // a Firefox that is really still running shows up as PROFILE_IN_USE on relaunch)
        await sleep(500);
        clearRunState(key);
        return Browser.open(opts);
      }
      throw e;
    }
  }

  private static async connect(state: RunState, opts: Options, launched: boolean): Promise<Browser> {
    const bidi = new Bidi(`ws://127.0.0.1:${state.bidiPort}/session`);
    await bidi.connect();
    try {
      await bidi.newSession(20000, PROMPT_CAPS);
    } catch (e) {
      // A crashed backend left its session behind; end it over RDP, then retry once.
      // Also when session.new got no answer (seen right after launches under load; a new connection answers): if
      // the session was created late, clear it; RDP may not be up yet then, which is fine
      const timeout = e instanceof ToolError && e.code === 'BIDI_TIMEOUT';
      if (!(e instanceof BidiError) && !timeout) throw e;
      bidi.close();
      try { await clearOrphanBidiSession(state.rdpPort); } catch (ce) { if (!timeout) throw ce; }
      const b2 = new Bidi(bidi.url);
      await b2.connect();
      await b2.newSession(30000, PROMPT_CAPS);
      return Browser.finishOpen(b2, state, opts, launched);
    }
    return Browser.finishOpen(bidi, state, opts, launched);
  }

  private static async finishOpen(bidi: Bidi, state: RunState, opts: Options, launched: boolean): Promise<Browser> {
    state.ownerPid = ownerPid();
    state.ownerBackendPid = process.pid;
    const b = new Browser(bidi, state, opts);
    b.launchedNow = launched;
    try { state.browserPid = await b.callChrome<number>('() => Services.appinfo.processID', null, (await b.chromeWindows())[0]); } catch { /* keep the launcher pid only */ }
    bidi.on('event', (e: BidiEvent) => b.onEvent(e));
    bidi.on('close', () => { b.dead = true; b.runClosers(); });
    await bidi.send('session.subscribe', {
      events: ['log.entryAdded', 'browsingContext.contextDestroyed', 'browsingContext.navigationStarted',
        'browsingContext.contextCreated', 'browsingContext.userPromptOpened', 'browsingContext.userPromptClosed', 'network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError', 'network.authRequired'],
    });
    await b.ensureAgentWindow();
    await b.dialogs.syncAuth().catch(() => {});
    await b.callChrome(CS.START_A11Y);
    await b.startDevtools();
    if (launched) b.launchNotes = await b.launchTasks();
    if (launched && !state.throwaway) b.launchNotes.push(...await b.launchCheckpoints());
    if (launched) delete state.debugger; // breakpoints of an earlier Firefox (after a crash) don't apply to this one
    else if (state.debugger) {
      // a backend reload closed the debugger connection, and its breakpoints with it: set them again
      try {
        const { restoreDebugger } = await import('./debugger.js');
        const n = await restoreDebugger(b);
        if (n) b.attachNotes.push(n);
      } catch (e: any) { b.attachNotes.push(`debugger: re-applying the breakpoints failed: ${e?.message ?? e}`); }
    }
    // Stylus watch mode: a backend reload or a new launch ends the file watchers; arm the workspace's again
    try {
      const { readStyleState, stylusSync } = await import('../adapters/stylus.js');
      const watched = Object.entries(readStyleState().links).filter(([, l]) => l.watch).map(([rel]) => rel);
      if (watched.length) { stylusSync(b).ensure(); b.attachNotes.push(`stylus: watching ${watched.join(', ')} again`); }
    } catch (e: any) { b.attachNotes.push(`stylus: re-arming watched styles failed: ${e?.message ?? e}`); }
    // downloads guard: which session's tab started a download; non-local ones need the user's OK
    try { await b.callChrome(DL_GUARD_INSTALL); await syncDownloadApprovals(b); } catch (e: any) { b.launchNotes.push(`downloads guard not installed: ${e?.message ?? e}`); }
    b.save();
    return b;
  }

  save() { writeRunState(this.state); }

  /** Start (or restart) the devtools hub. Capture starts at launch so nothing is lost before page load. */
  async startDevtools(): Promise<Devtools | null> {
    if (this.devtools && !this.devtools.dead) return this.devtools;
    if (process.env.FIREFOX_USE_NO_DEVTOOLS) { this.devtoolsError = 'disabled (FIREFOX_USE_NO_DEVTOOLS, for memory comparisons)'; return null; }
    const d = new Devtools(this.state.rdpPort, () => this.callChrome(CS.EXT_LIST));
    try {
      // memory bounds: cap the bodies the devtools server keeps per request (default branch: not persisted, user value wins)
      await this.callChrome(`({ n }) => { const p = "devtools.netmonitor.responseBodyLimit"; const d = Services.prefs.getDefaultBranch(""); if (d.getIntPref(p, 1048576) > n) d.setIntPref(p, n); }`, { n: BODY_LIMIT }).catch(() => {});
      await d.start();
      this.devtools = d;
      this.devtoolsError = '';
    } catch (e: any) {
      d.close();
      this.devtoolsError = String(e?.message ?? e);
      this.devtools = null;
    }
    return this.devtools;
  }

  /** The devtools hub, or a structured error if it can't be reached. */
  async dt(): Promise<Devtools> {
    const d = await this.startDevtools();
    if (!d) fail('DEVTOOLS_UNAVAILABLE', `devtools (RDP) connection failed: ${this.devtoolsError}`, 'ff_restart reconnects every transport.');
    return d!;
  }

  /** Console/network source for console_read, network_read and waits: the devtools hub here, BidiHub in personal mode. */
  async hub(): Promise<Hub> { return this.dt(); }

  /** Which Claude session's tab this context is ('' = this backend's own, else a routed client id); null = a user tab. */
  async promptOwner(context: string): Promise<string | null> { return this.callChrome<string | null>(CS.OWNER_OF_CONTEXT, { id: context }); }
  /** Context ids of every Claude session's agent tabs (never the user's). */
  async agentContexts(): Promise<string[]> { return this.callChrome<string[]>(CS.AGENT_CONTEXTS); }

  /** Tab handle for a top-level browsing context id (refreshes the map once if unknown). */
  async tabForBc(bc: number | undefined): Promise<number | undefined> {
    if (bc === undefined || bc < 0) return undefined;
    if (!this.bcTab.has(bc)) await this.listTabs(true).catch(() => {});
    return this.bcTab.get(bc);
  }

  // ------------------------------------------------------------ events
  protected onEvent({ method, params }: BidiEvent) {
    switch (method) {
      case 'log.entryAdded':
        this.console.push({ ts: params.timestamp, level: params.level, text: String(params.text ?? '').slice(0, 2000), context: params.source?.context, url: params.stackTrace?.callFrames?.[0]?.url });
        if (this.console.length > 200) this.console.shift();
        break;
      case 'browsingContext.navigationStarted':
        if (!params.context) break;
        this.refs.resetContext(params.context);
        this.shots.delete(params.context);
        this.navStarted.set(params.context, Date.now());
        break;
      case 'browsingContext.contextDestroyed':
        this.refs.resetContext(params.context);
        for (const [k, v] of Object.entries(this.state.tabs ?? {})) if (v === params.context) { delete this.state.tabs![k]; delete this.state.tabBids?.[k]; }
        break;
      case 'browsingContext.contextCreated':
        if (!params.parent && !this.personal) void this.adoptPopup(params.context);
        break;
      case 'browsingContext.userPromptOpened':
        void this.dialogs.onOpened(params);
        break;
      case 'browsingContext.userPromptClosed':
        this.dialogs.onClosed(params);
        break;
      case 'network.authRequired':
        void this.dialogs.onAuth(params);
        break;
      case 'network.beforeRequestSent': {
        const ctx = params.context; if (!ctx) break;
        let m = this.netInflight.get(ctx); if (!m) this.netInflight.set(ctx, (m = new Map()));
        m.set(params.request.request, Date.now());
        this.netLastActivity.set(ctx, Date.now());
        break;
      }
      case 'network.responseCompleted': case 'network.fetchError': {
        const ctx = params.context; if (!ctx) break;
        this.netInflight.get(ctx)?.delete(params.request.request);
        this.netLastActivity.set(ctx, Date.now());
        break;
      }
    }
  }

  /**
   * A tab opened by one of Claude's tabs belongs to that session. Firefox puts window.open tabs into the opener's
   * group itself, but a popup (window.open with features) gets a window of its own, visible on the user's screen
   * and outside every group: move it into the agent window and the opener's group, then give it a handle and run
   * the new-tab hooks (interception, auth) for it, as for tabs_create.
   */
  private async adoptPopup(context: string) {
    const r = await this.callChrome<{ key: string; moved: boolean; id: string | null } | null>(CS.ADOPT_POPUP, { id: context }).catch(() => null);
    if (!r) return;
    const id = r.id ?? context;
    await runAsClient(r.key, async () => {
      const tab = this.handleFor(id);
      this.save();
      for (const f of this.tabHooks) await f(id, r.key).catch(() => {});
      if (r.moved) this.attachNotes.push(`a popup window opened by a Claude tab was moved into the agent window as tab ${tab}`);
    });
  }

  async waitNetworkIdle(context: string, idleMs = 500, timeoutMs = 10000): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      const m = this.netInflight.get(context);
      // forget requests that never reported back (e.g. long-polls) after 10 s
      if (m) for (const [id, t] of m) if (Date.now() - t > 10000) m.delete(id);
      const busy = (m?.size ?? 0) > 0;
      const last = this.netLastActivity.get(context) ?? 0;
      if (!busy && Date.now() - last >= idleMs) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(100);
    }
  }

  // ------------------------------------------------------------ evaluation helpers
  /** Accessibility tree rows of a tab for read_page / find (parent-process a11y service). */
  async a11yWalk(context: string, maxNodes: number): Promise<any> {
    return this.callChrome<any>(CS.A11Y_WALK, { id: context, maxNodes });
  }

  /** Handoff: show the agent window on this tab (the one deliberate focus change). */
  async showWindow(context: string) { await this.callChrome(CS.HANDOFF_SHOW, { id: context }); }
  /** After a handoff: back to the window mode (offscreen: parked again; minimized: minimised; visible: left where it is). */
  async afterHandback() {
    const m = this.agentWindowMode();
    if (m === 'offscreen') await this.callChrome(CS.PARK, { handback: true });
    else if (m === 'minimized') await this.callChrome(CS.MINIMIZE);
  }
  /**
   * Where Claude's window sits: ff_window's choice for this session, else config (dev "offscreen", personal
   * "visible"); headless: none. "offscreen" = a normal window parked off-screen (pages render as visible in claude-dev,
   * where occlusion tracking is off); "visible" = on-screen, never activated; "minimized" = pages hidden.
   */
  agentWindowMode(): WindowMode | 'none' {
    if (this.state.headless) return 'none';
    const w = this.state.windowMode;
    return w && w.owner === ownerPid() ? w.mode : windowChoice[this.personal ? 'personal' : 'dev'] ?? agentWindowSetting(this.personal);
  }
  /** ff_window: show the window on-screen without activating it, or park it off-screen; lasts for this session. */
  async setWindowMode(mode: 'visible' | 'offscreen'): Promise<string> {
    if (this.agentWindowMode() === 'none') fail('HEADLESS', 'this Firefox is headless; there is no window to show or park');
    this.rememberWindowMode(mode);
    if (mode === 'visible') {
      const r = await this.callChrome<string>(CS.SHOW);
      return r === 'restored'
        ? 'agent window restored from the taskbar (the user had minimised it; restoring brings it to the front) and kept on-screen for this session'
        : 'agent window shown on-screen (not activated: it stays behind the window the user is working in) and kept there for this session; ff_window(park) moves it off-screen again';
    }
    const r = await this.callChrome<string>(CS.PARK, { handback: true });
    if (r === 'minimized') return 'the agent window is minimised (by the user) and stays so (un-minimising would take the foreground); it is parked off-screen once they restore it. Its pages count as hidden until then';
    return r === 'parked' ? 'agent window parked off-screen for this session (pages still render as visible); ff_window(show) brings it back' : `agent window could not be parked (${r})`;
  }
  /** One line for ff_status (null when headless). */
  async windowLine(): Promise<string | null> {
    const m = this.agentWindowMode();
    if (m === 'none') return null;
    const w = await this.callChrome<{ state: string }>(CS.WINDOW_VISIBILITY).catch(() => null);
    if (!w) return null;
    const where = w.state === 'parked' ? 'parked off-screen (pages render as visible)'
      : w.state === 'on-screen' ? `on-screen (${m === 'visible' ? 'shown, not activated' : 'the user brought it up'})`
        : 'MINIMISED by the user: pages count as hidden (rAF, transitions, observers barely run) until they click its taskbar button';
    return `agent window: ${where} · mode ${m} (ff_window show / park)`;
  }
  protected rememberWindowMode(mode: WindowMode) {
    this.state.windowMode = { mode, owner: ownerPid() };
    windowChoice[this.personal ? 'personal' : 'dev'] = mode;
    this.save();
    this.visNoted = false;
  }
  protected visNoted = false;
  protected visCheckedAt = 0;
  /**
   * A note for the next tool result when the agent window is minimised (the user did it: the server never
   * minimises in "offscreen" or "visible" mode, and can't undo it without taking the foreground). Once per minimise;
   * checked at most every 3 s.
   */
  async windowVisibilityNote(): Promise<string | null> {
    const m = this.agentWindowMode();
    if ((m !== 'offscreen' && m !== 'visible') || !this.chromeCtx || Date.now() - this.visCheckedAt < 3000) return null;
    this.visCheckedAt = Date.now();
    const v = await this.callChrome<{ state: string }>(CS.WINDOW_VISIBILITY).catch(() => null);
    if (v?.state !== 'minimized') { this.visNoted = false; return null; }
    if (this.visNoted) return null;
    this.visNoted = true;
    return 'the agent window is minimised (by the user), so its pages count as hidden: requestAnimationFrame, CSS transitions, animations and observer callbacks barely run, and timers are throttled. Visual checks and timing are unreliable until it is restored. Claude cannot restore it without taking the foreground: ask the user to click the claude-dev taskbar button (it then stays visible), or ff_window(show) if they want to see it anyway (it comes to the front).';
  }

  /** Call a function in a privileged chrome window (default: the agent window). Result travels as JSON. */
  async callChrome<T = any>(fn: string, arg: unknown = null, context = this.chromeCtx): Promise<T> {
    const r = await this.bidi.send('script.callFunction', {
      functionDeclaration: `async function (json) { const r = await (${fn})(JSON.parse(json)); return JSON.stringify(r === undefined ? null : r); }`,
      arguments: [{ type: 'string', value: JSON.stringify(arg) }],
      target: { context }, awaitPromise: true, resultOwnership: 'none',
    });
    if (r.type === 'exception') throw new ToolError('PRIVILEGED_EXCEPTION', r.exceptionDetails?.text ?? 'exception', undefined, { stack: stackOf(r) });
    return JSON.parse(r.result.value);
  }

  /** Call a function in the page, in this server's isolated sandbox by default (invisible to the page). */
  async callPage(context: string, fn: string, args: unknown[] = [], o: { sandbox?: string | null; awaitPromise?: boolean; raw?: boolean } = {}): Promise<any> {
    const target: any = { context };
    const sb = o.sandbox === undefined ? SANDBOX : o.sandbox;
    if (sb) target.sandbox = sb;
    const r = await this.bidi.send('script.callFunction', {
      functionDeclaration: fn, arguments: args.map(toLocal), target,
      awaitPromise: o.awaitPromise ?? true, resultOwnership: 'none', serializationOptions: { maxDomDepth: 0, maxObjectDepth: 4 },
    });
    if (r.type === 'exception') throw new ToolError('PAGE_EXCEPTION', r.exceptionDetails?.text ?? 'exception', undefined, { stack: stackOf(r) });
    return o.raw ? r.result : fromRemote(r.result);
  }

  // ------------------------------------------------------------ agent window and tabs
  async chromeWindows(): Promise<string[]> {
    const t = await this.bidi.send('browsingContext.getTree', { 'moz:scope': 'chrome' });
    return t.contexts.filter((c: any) => c.url === 'chrome://browser/content/browser.xhtml').map((c: any) => c.context);
  }

  /** a dedicated agent window (parked off-screen) with a "Claude" tab group. */
  async ensureAgentWindow(): Promise<void> {
    const wins = await this.chromeWindows();
    let agent = '';
    for (const w of wins) if (await this.callChrome<boolean>(CS.IS_AGENT_WINDOW, null, w)) { agent = w; break; }
    if (!agent) {
      if (this.launchedNow && wins.length === 1) {
        agent = wins[0];
      } else {
        const created = await this.bidi.send('browsingContext.create', { type: 'window', background: true });
        for (let i = 0; i < 20 && !agent; i++) {
          for (const w of await this.chromeWindows()) {
            if (await this.callChrome<boolean>(CS.WINDOW_HAS_CONTEXT, created.context, w)) { agent = w; break; }
          }
          if (!agent) await sleep(100);
        }
        if (!agent) fail('AGENT_WINDOW', 'could not locate the newly created agent window');
      }
    }
    this.chromeCtx = agent;
    this.state.tabs ??= {};
    this.state.tabBids ??= {};
    this.state.nextTab ??= 1;
    // context ids changed if this is a new BiDi session: re-map handles through browserId
    const bids = Object.values(this.state.tabBids);
    if (bids.length) {
      const now = await this.callChrome<Record<string, string>>(CS.REMAP_BROWSER_IDS, { bids });
      for (const [k, bid] of Object.entries(this.state.tabBids)) {
        if (now[bid]) this.state.tabs[k] = now[bid];
        else { delete this.state.tabs[k]; delete this.state.tabBids[k]; }
      }
    }
    const m = this.agentWindowMode();
    const r = await this.callChrome<{ tabs: { id: string; bid: number }[] }>(CS.SETUP_AGENT_WINDOW, { hide: m === 'offscreen' ? 'offscreen' : m === 'minimized' ? 'minimize' : m === 'visible' ? 'show' : 'none', launched: this.launchedNow, label: this.groupLabel, color: this.groupColor, key: currentClient() });
    for (const t of r.tabs) this.handleFor(t.id, t.bid);
    const live = new Set(r.tabs.map((t) => t.id));
    for (const [k, v] of Object.entries(this.state.tabs)) if (!live.has(v) && this.state.tabBids[k] === undefined) delete this.state.tabs[k];
    const cur = this.cur;
    if (cur == null || !this.state.tabs[String(cur)] || !live.has(this.state.tabs[String(cur)])) {
      const first = Object.entries(this.state.tabs).find(([, v]) => live.has(v));
      this.cur = first ? Number(first[0]) : null;
    }
  }

  handleFor(contextId: string, bid?: number): number {
    this.state.tabBids ??= {};
    for (const [k, v] of Object.entries(this.state.tabs ?? {})) {
      if (v === contextId) { if (bid !== undefined) this.state.tabBids[k] = bid; return Number(k); }
    }
    const n = this.state.nextTab!++;
    this.state.tabs![String(n)] = contextId;
    if (bid !== undefined) this.state.tabBids[String(n)] = bid;
    this.save();
    return n;
  }

  async listTabs(includeUser = false): Promise<TabInfo[]> {
    const raw = await this.callChrome<any[]>(CS.LIST_TABS, { includeUser, key: currentClient() });
    const out = raw.map((t) => ({ tab: this.handleFor(t.id, t.bid), id: t.id, agent: t.agent, url: t.url, title: t.title, selected: t.selected, current: false, bc: t.bc as number }));
    for (const t of out) if (t.bc !== undefined) this.bcTab.set(t.bc, t.tab);
    return out
      .map((t) => ({ ...t, current: t.tab === this.cur }));
  }

  /** Resolve a tab handle (default: current agent tab) to a BiDi context id. */
  async context(tab?: number): Promise<string> {
    if (tab === undefined || tab === null) {
      let cur = this.cur;
      if (cur == null || !this.state.tabs?.[String(cur)]) {
        const tabs = (await this.listTabs()).filter((t) => t.agent);
        if (!tabs.length) { await this.ensureAgentWindow(); if (this.cur == null) fail('AGENT_WINDOW', 'no agent tab'); return this.context(); }
        cur = this.cur = tabs[0].tab;
        this.save();
      }
      return this.state.tabs![String(cur)];
    }
    const id = this.state.tabs?.[String(tab)];
    if (!id) fail('TAB_NOT_FOUND', `no tab ${tab}`, 'Use tabs_list to see tab handles.');
    return id!;
  }

  async createTab(url?: string): Promise<number> {
    const agentTabs = (await this.listTabs()).filter((t) => t.agent);
    let ctx: string;
    if (agentTabs.length) {
      ctx = (await this.bidi.send('browsingContext.create', { type: 'tab', referenceContext: agentTabs[agentTabs.length - 1].id, background: true })).context;
    } else {
      await this.ensureAgentWindow();
      const again = (await this.listTabs()).filter((t) => t.agent);
      if (!again.length) fail('AGENT_WINDOW', 'agent window has no tabs');
      return again[0].tab;
    }
    await this.callChrome(CS.ADD_TO_GROUP, { id: ctx, key: currentClient() });
    const handle = this.handleFor(ctx);
    await this.listTabs(); // records the new tab's browserId
    for (const f of this.tabHooks) await f(ctx, currentClient()).catch(() => {});
    if (url) await this.bidi.send('browsingContext.navigate', { context: ctx, url, wait: 'complete' }, 60000);
    return handle;
  }

  async selectTab(tab: number) {
    const ctx = await this.context(tab);
    await this.callChrome(CS.SELECT_TAB, { id: ctx });
    this.cur = tab;
    this.save();
  }

  async closeTab(tab: number) {
    const ctx = await this.context(tab);
    const agentTabs = (await this.listTabs()).filter((t) => t.agent);
    if (agentTabs.length === 1 && agentTabs[0].id === ctx) {
      // never close the window's last agent tab (that would close the agent window); blank it instead
      await this.bidi.send('browsingContext.navigate', { context: ctx, url: 'about:blank', wait: 'complete' });
      return 'blanked (last agent tab is kept)';
    }
    await this.bidi.send('browsingContext.close', { context: ctx, promptUnload: false });
    delete this.state.tabs![String(tab)];
    delete this.state.tabBids?.[String(tab)];
    if (this.cur === tab) this.cur = null;
    this.save();
    return 'closed';
  }

  recentErrors(context?: string, n = 5): string[] {
    return this.console.filter((c) => c.level === 'error' && (!context || c.context === context)).slice(-n).map((c) => c.text.slice(0, 300));
  }

  async versionsInfo(): Promise<any> {
    this.versions = await this.callChrome(CS.VERSIONS);
    return this.versions;
  }

  /**
   * Launch-time add-on work, before any automation:
   * install the user-approved add-ons (the .xpi names in addonsDir) if missing, and sync each one to the
   * version in the user's main profile when that is newer (read-only: extensions.json + the .xpi).
   * Background updates stay off, so versions never change mid-session.
   */
  async launchTasks(): Promise<string[]> {
    const notes: string[] = [];
    const cfg = loadConfig();
    const dir = cfg.addonsDir;
    const main = cfg.syncAddonsFromMainProfile === false ? new Map() : mainProfileAddons(cfg.mainProfile);
    const installed = new Map<string, string>((await this.versionsInfo()).addons.map((a: any) => [a.id, a.version]));
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.xpi'))) {
        const id = f.slice(0, -4);
        const m = main.get(id);
        const have = installed.get(id);
        let src: string | null = null, why = '';
        if (!have) { src = m?.path ?? path.join(dir, f); why = `installed ${id}${m ? ` ${m.version} from your main profile` : ` from ${f}`}`; }
        else if (m && (await this.callChrome<number>('({ a, b }) => Services.vc.compare(a, b)', { a: m.version, b: have })) > 0) {
          src = m.path; why = `updated ${id} ${have} -> ${m.version} (synced from your main profile)`;
        }
        if (!src) continue;
        if (src !== path.join(dir, f)) fs.copyFileSync(src, path.join(dir, f)); // keep the staged copy current
        await this.bidi.send('webExtension.install', { extensionData: { type: 'archivePath', path: path.join(dir, f) }, 'moz:permanent': true }, 60000);
        notes.push(why);
      }
    }
    // per-profile managed storage (managed_storage_set): install the lookup override, reload those extensions
    const managed = await this.callChrome<string[]>(XS.MANAGED_LIST).catch(() => []);
    if (managed.length) {
      await this.callChrome(XS.MANAGED_INSTALL);
      for (const id of managed) {
        if (await this.callChrome<boolean>(`({ id }) => !!WebExtensionPolicy.getByID(id)`, { id })) await this.callChrome(XS.ADDON_RELOAD, { id }).catch(() => {});
      }
      notes.push(`applied managed storage for ${managed.join(', ')}`);
    }
    // downloads go only to the sandbox folder: a download dir that isn't an existing folder (e.g. an
    // unreplaced %SANDBOX% placeholder) makes Firefox fall back to the user's own Downloads folder
    const dl = await this.callChrome<{ dir: string; list: number; use: boolean }>(`() => ({ dir: Services.prefs.getStringPref("browser.download.dir", ""), list: Services.prefs.getIntPref("browser.download.folderList", 1), use: Services.prefs.getBoolPref("browser.download.useDownloadDir", true) })`);
    let dirOk = false;
    try { dirOk = !!dl.dir && fs.statSync(dl.dir).isDirectory(); } catch { /* missing */ }
    if (!dirOk || dl.list !== 2 || !dl.use) {
      const dir = ensureDir(cfg.sandboxDir);
      await this.callChrome(`({ dir }) => { Services.prefs.setStringPref("browser.download.dir", dir); Services.prefs.setIntPref("browser.download.folderList", 2); Services.prefs.setBoolPref("browser.download.useDownloadDir", true); }`, { dir });
      notes.push(`downloads folder was ${dirOk ? `${dl.dir} (folderList ${dl.list}, useDownloadDir ${dl.use})` : `not an existing folder (${JSON.stringify(dl.dir)})`}: set to the sandbox ${dir}`);
    }
    if (this.state.throwaway && cfg.throwawayAddons === 'core') {
      // tests: the user's other extensions (copied with claude-dev) would change pages under test
      const n = await this.callChrome<number>(`async () => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const keep = new Set(["uBlock0@raymondhill.net", "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}", "companion@firefox-use"]);
        let n = 0;
        for (const a of await AddonManager.getAddonsByTypes(["extension"])) if (!a.isSystem && !a.isBuiltin && !a.hidden && !a.temporarilyInstalled && !keep.has(a.id) && a.isActive) { await a.disable(); n++; }
        return n;
      }`);
      if (n) notes.push(`throwaway "core" add-ons: disabled ${n} other extension(s)`);
    }
    if (!this.state.throwaway) {
      const n = await unstickAutomationPrefs(this).catch((e) => `checking leftover automation prefs failed: ${e?.message ?? e}`);
      if (n) notes.push(n);
    }
    const pinned = await this.callChrome<number>(CS.PIN_ADDON_UPDATES);
    if (pinned) notes.push(`disabled background updates for ${pinned} add-on(s)`);
    // own taskbar button (not stacked with the user's Firefox); read at startup, so it applies from the next launch
    if (await this.callChrome<boolean>(`() => { if (Services.prefs.getBoolPref("taskbar.grouping.useprofile", false)) return false; Services.prefs.setBoolPref("taskbar.grouping.useprofile", true); return true; }`).catch(() => false)) {
      notes.push('set taskbar.grouping.useprofile: from the next launch claude-dev gets its own taskbar button');
    }
    // same-script check: scripts a dev copy disabled run again once that copy is gone (fast mode: always after a restart)
    try { notes.push(...await releaseStaleShadows(this)); } catch (e: any) { notes.push(`re-enabling shadowed userscripts failed: ${e?.message ?? e}`); }
    // read-only drift report: claude-dev's Violentmonkey scripts vs the main profile's
    try { const d = await launchDrift(this); if (d) notes.push(d); } catch (e: any) { if (e?.code !== 'VM_UNAVAILABLE') notes.push(`userscript drift report failed: ${e?.message ?? e}`); }
    // companion: temporary add-on, so installed again at every launch; the devtools hub must be up for its realm
    try {
      await this.startDevtools();
      const n = await ensureCompanion(this);
      if (n) notes.push(n);
    } catch (e: any) { notes.push(`companion not installed: ${e?.message ?? e}`); }
    if (notes.length) await this.versionsInfo();
    return notes;
  }

  /**
   * Cold start of a lasting profile: after a kill switch, restore the most recent checkpoint
   * (unless --no-restore), then take the automatic launch checkpoint.
   */
  async launchCheckpoints(): Promise<string[]> {
    const notes: string[] = [];
    const killed = path.join(loadConfig().runDir ?? RUN_DIR, 'killed.json');
    try {
      const k = JSON.parse(fs.readFileSync(killed, 'utf8'));
      fs.renameSync(killed, `${killed}.handled`);
      const cp = lastCheckpoint(this.state.key);
      if (k.restore && cp && fs.existsSync(path.join(cp.dir, 'meta.json'))) {
        const meta: SnapMeta = JSON.parse(fs.readFileSync(path.join(cp.dir, 'meta.json'), 'utf8'));
        const r = await restoreWarm(this, readWarm({ ...meta, dir: cp.dir }));
        notes.push(`kill switch was engaged (${k.by ?? '?'} at ${k.at}): restored checkpoint ${cp.id}: ${r.lines.join('; ') || 'nothing differed'}`);
      } else if (k.restore) notes.push(`kill switch was engaged at ${k.at}; no checkpoint to restore`);
      else notes.push(`kill switch was engaged at ${k.at} with --no-restore; nothing restored`);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') notes.push(`kill-switch restore failed: ${e?.message ?? e}`);
    }
    try {
      const m = await takeWarm(this, 'auto: at launch', true);
      notes.push(`checkpoint ${m.id} (at launch)`);
    } catch (e: any) { notes.push(`launch checkpoint failed: ${e?.message ?? e}`); }
    return notes;
  }

  // ------------------------------------------------------------ teardown
  /** Graceful detach for a backend reload: end the BiDi session, leave Firefox running. */
  async detach() {
    this.save();
    this.runClosers();
    this.devtools?.close();
    await this.bidi.endSession();
    this.bidi.close();
  }

  async quit(): Promise<void> {
    const pid = this.state.browserPid ?? this.state.pid;
    this.runClosers();
    this.devtools?.close();
    try { await this.bidi.send('browser.close', {}, 10000); } catch { /* connection drops as it closes */ }
    this.bidi.close();
    if (!(await waitExit(pid, 15000))) killFirefox(this.state);
    clearRunState(this.state.key);
    removeThrowaway(this.state);
  }

  kill() {
    this.runClosers();
    this.devtools?.close();
    try { this.bidi.close(); } catch { /* ignore */ }
    killFirefox(this.state);
    clearRunState(this.state.key);
    removeThrowaway(this.state);
  }
}

function stackOf(r: any): string | undefined {
  const f = r.exceptionDetails?.stackTrace?.callFrames;
  return f?.length ? f.slice(0, 5).map((c: any) => `${c.functionName || '?'}@${c.url}:${c.lineNumber}:${c.columnNumber}`).join(' <- ') : undefined;
}

/** JS value -> BiDi LocalValue. Objects shaped {sharedId} pass through as node references. */
export function toLocal(v: any): any {
  if (v === undefined) return { type: 'undefined' };
  if (v === null) return { type: 'null' };
  if (typeof v === 'string') return { type: 'string', value: v };
  if (typeof v === 'boolean') return { type: 'boolean', value: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { type: 'number', value: v } : { type: 'number', value: String(v) };
  if (Array.isArray(v)) return { type: 'array', value: v.map(toLocal) };
  if (typeof v === 'object' && typeof v.sharedId === 'string') return { sharedId: v.sharedId };
  return { type: 'object', value: Object.entries(v).map(([k, x]) => [k, toLocal(x)]) };
}
