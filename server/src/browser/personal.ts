// Personal mode: the user's own Firefox profile at Claude-in-Chrome level, over WebDriver BiDi
// alone. No --remote-allow-system-access and no debugger server, so there is no chrome scope: tabs come from
// browsingContext.getTree (Claude's tabs = the ones in the window it created), read_page walks the DOM, and
// console/network come from BiDi events of Claude's tabs only (BidiHub). Claude never closes the user's browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectMainProfile, loadConfig, setupCommand, type Options, type WindowMode } from '../config.js';
import { ToolError, fail } from '../errors.js';
import { Bidi, BidiError, type BidiEvent } from '../transports/bidi.js';
import { BidiHub } from './bidihub.js';
import { currentClient } from './client.js';
import { PROMPT_CAPS } from './dialogs.js';
import type { Devtools, Hub } from './devtools.js';
import { DOM_WALK } from './domTree.js';
import { clearRunState, isAlive, ownerPid, readRunState, sleep, writeRunState, type RunState } from './launcher.js';
import { Browser, type TabInfo } from './session.js';

export const PERSONAL = 'personal';

/** The profile personal mode drives: config personalProfile (tests: a plain throwaway profile), else the main profile. */
export function personalProfileDir(): string | null {
  const p = loadConfig().personalProfile;
  if (p) return fs.existsSync(p) ? p : null;
  return detectMainProfile();
}

/**
 * The remote agent applies "recommended" automation prefs to any profile it runs in (Safe Browsing, saved logins,
 * session restore after a crash, extension scopes, ... are switched off until a clean shutdown; a crash keeps
 * them). Personal mode requires remote.prefs.recommended=false in the profile, written by the user-run
 * setup/personal-mode.ps1, so the user's browser keeps its own settings.
 */
export function personalPrefsOk(dir: string): boolean {
  const re = /user_pref\(\s*["']remote\.prefs\.recommended["']\s*,\s*false\s*\)/;
  for (const f of ['user.js', 'prefs.js']) {
    try { if (re.test(fs.readFileSync(path.join(dir, f), 'utf8'))) return true; } catch { /* missing */ }
  }
  return false;
}

/** Is the profile open in a running Firefox? (parent.lock is held exclusively while it runs) */
function profileLocked(dir: string): boolean {
  const lock = path.join(dir, 'parent.lock');
  if (!fs.existsSync(lock)) return false;
  try { const fd = fs.openSync(lock, 'r+'); fs.closeSync(fd); return process.platform !== 'win32'; } catch { return true; }
}

/** Port of a running remote agent, from the file Firefox writes into the profile (WebDriverBiDiServer.json). */
async function livePort(dir: string): Promise<number | null> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'WebDriverBiDiServer.json'), 'utf8'));
    const port = Number(j.ws_port);
    if (port && (await Bidi.probe(`ws://127.0.0.1:${port}/session`))) return port;
  } catch { /* none */ }
  return null;
}

/** Personal mode refuses everything beyond page-level access. */
export function personalRefusal(what: string): never {
  return fail('PERSONAL_MODE', `${what} is not available in personal mode (your own Firefox profile is driven at page level only)`,
    'Use claude-dev for privileged work: ff_quit here (closes only Claude\'s window), then ff_launch with profile "claude-dev".');
}

export class PersonalBrowser extends Browser {
  override readonly personal = true;
  readonly bidiHub: BidiHub;
  /** Claude's window (BiDi client window id; regenerated per BiDi session, re-found by its tabs' URLs) */
  clientWindow = '';
  firefoxVersion = '';
  /** the window was left by another session or a crashed backend: put it where this session's mode says */
  private recoverWindow = false;

  private constructor(bidi: Bidi, state: RunState, opts: Options) {
    super(bidi, state, opts);
    this.bidiHub = new BidiHub(bidi);
  }

  static async openPersonal(opts: Options): Promise<PersonalBrowser> {
    const dir = personalProfileDir();
    if (!dir) fail('PROFILE_MISSING', 'could not find your Firefox profile (profiles.ini)', 'Set "personalProfile" in %LOCALAPPDATA%\\firefox-use\\config.json.');
    const prev = readRunState(PERSONAL);
    if (prev && prev.ownerPid !== ownerPid() && isAlive(prev.ownerPid) && (await livePort(dir!))) {
      fail('PROFILE_BUSY', `your Firefox is being driven by another Claude session (owner pid ${prev.ownerPid})`, 'Personal mode works from one Claude session at a time; ff_quit in that session first.');
    }
    if (!personalPrefsOk(dir!)) {
      fail('PERSONAL_SETUP_NEEDED', `your Firefox profile (${dir}) is not set up for personal mode`,
        `The user runs ${setupCommand('personal-mode.ps1')} once (it sets remote.prefs.recommended=false, so remote control does not switch off Safe Browsing, saved logins or session restore in their browser, and adds a "Firefox (Claude can browse)" shortcut).`);
    }
    let port = await livePort(dir!);
    let launcherPid = 0, launched = false;
    if (!port) {
      if (!opts.startPersonal) {
        // only ff_launch starts the user's browser; other tools never reopen a Firefox the user closed
        if (prev) clearRunState(PERSONAL);
        fail('PERSONAL_CLOSED', 'your Firefox (personal mode) is not running', 'Call ff_launch with profile "personal" to start it again, or ff_launch with profile "claude-dev" to go back to the dev profile.');
      }
      if (profileLocked(dir!)) {
        fail('PERSONAL_NOT_REMOTE', 'your Firefox is running without remote control, and Firefox cannot add it to a running browser',
          'Ask the user to close Firefox (session restore brings their tabs back) and say when it is closed, or to start it from the "Firefox (Claude can browse)" shortcut. Never close it for them.');
      }
      ({ port, pid: launcherPid } = await launchPersonal(dir!, opts.headless));
      launched = true;
    }
    const state: RunState = {
      key: PERSONAL, pid: 0, bidiPort: port!, rdpPort: 0, profileDir: dir!, throwaway: false, headless: opts.headless,
      startedAt: prev?.startedAt && !launched ? prev.startedAt : new Date().toISOString(), ownerPid: ownerPid(), ownerBackendPid: process.pid,
      personal: true, launcherPid: launched ? launcherPid : prev?.launcherPid ?? 0,
      tabs: {}, current: prev?.current ?? null, nextTab: prev?.nextTab ?? 1, personalTabs: prev?.personalTabs,
      windowMode: prev?.windowMode,
    };
    let bidi = new Bidi(`ws://127.0.0.1:${port}/session`);
    await bidi.connect();
    let caps: { browserVersion?: string };
    try {
      try { caps = await bidi.newSession(20000, PROMPT_CAPS); } catch (e) {
        // no answer (seen right after a launch under load): a new connection answers
        if (!(e instanceof ToolError && e.code === 'BIDI_TIMEOUT')) throw e;
        bidi.close();
        bidi = new Bidi(bidi.url);
        await bidi.connect();
        caps = await bidi.newSession(30000, PROMPT_CAPS);
      }
    } catch (e) {
      bidi.close();
      if (e instanceof BidiError) {
        fail('PERSONAL_SESSION_BUSY', `your Firefox already has a remote-control session (${e.message})`,
          'Another automation client is connected, or a crashed Claude backend left its session behind (it cannot be cleared without privileged access). Ask the user to close any other automation tool, or to restart Firefox.');
      }
      throw e;
    }
    const b = new PersonalBrowser(bidi, state, opts);
    b.firefoxVersion = caps.browserVersion ?? '';
    b.launchedNow = launched;
    b.recoverWindow = !prev || prev.ownerPid !== ownerPid();
    b.launchNotes = launched ? [`started your Firefox (${dir}) with remote control on 127.0.0.1:${port}; it keeps running when this session ends`] : [`attached to your running Firefox (remote control on 127.0.0.1:${port})`];
    bidi.on('event', (e: BidiEvent) => { b.bidiHub.onEvent(e); b.onEvent(e); });
    bidi.on('close', () => { b.dead = true; b.bidiHub.close(); });
    // only tab bookkeeping is subscribed for every tab; console and network are per agent tab (BidiHub.watch)
    await bidi.send('session.subscribe', { events: ['browsingContext.contextCreated', 'browsingContext.contextDestroyed', 'browsingContext.navigationStarted', 'browsingContext.userPromptOpened', 'browsingContext.userPromptClosed', 'network.authRequired'] });
    await b.ensureAgentWindow();
    await b.dialogs.syncAuth().catch(() => {});
    b.save();
    return b;
  }

  protected override onEvent(e: BidiEvent) {
    // dialogs and navigations of the user's own tabs are none of Claude's business
    const ctx = e.params?.context;
    // (userPromptOpened of user tabs is still recorded: as theirs, left open for them; see DialogHandler)
    if (e.method === 'log.entryAdded' && ctx && !this.bidiHub.isWatched(this.bidiHub.top(ctx))) return;
    super.onEvent(e);
  }

  // ------------------------------------------------------------ Claude's window and tabs
  private async tree(): Promise<{ context: string; url: string; clientWindow: string }[]> {
    return (await this.bidi.send('browsingContext.getTree', { maxDepth: 0 })).contexts;
  }

  override async ensureAgentWindow(): Promise<void> {
    let tops = await this.tree();
    const byWin = new Map<string, { context: string; url: string }[]>();
    for (const c of tops) { const l = byWin.get(c.clientWindow) ?? []; l.push(c); byWin.set(c.clientWindow, l); }
    this.state.tabs ??= {};
    if (!this.clientWindow || !byWin.has(this.clientWindow)) {
      this.clientWindow = '';
      // context and window ids change with every BiDi session: find our window again by its tabs' URLs
      const rec = this.state.personalTabs ?? [];
      if (rec.length) {
        let best = '', score = 0;
        for (const [w, tabs] of byWin) {
          const urls = tabs.map((t) => t.url);
          const same = rec.filter((r, i) => urls[i] === r.url).length;
          const s = urls.length === rec.length ? same * 2 : same;
          if (same >= Math.ceil(rec.length / 2) && s > score) { best = w; score = s; }
        }
        if (best) {
          this.clientWindow = best;
          const tabs = byWin.get(best)!;
          this.state.tabs = {};
          tabs.forEach((t, i) => { const h = rec[i] && rec[i].url === t.url && rec[i].handle ? rec[i].handle : this.state.nextTab!++; this.state.tabs![String(h)] = t.context; });
          for (const t of tabs) if (!Object.values(this.state.tabs).includes(t.context)) this.state.tabs[String(this.state.nextTab!++)] = t.context;
        }
      }
      if (!this.clientWindow) {
        const created = await this.bidi.send('browsingContext.create', { type: 'window', background: true });
        this.clientWindow = (await this.tree()).find((c) => c.context === created.context)?.clientWindow ?? '';
        if (!this.clientWindow) fail('AGENT_WINDOW', 'could not find the window Claude created');
        this.state.tabs = {};
        this.handleFor(created.context);
        // created in the background where Firefox puts new windows; never activated (measured: creating, navigating,
        // dialogs, downloads and window.open in it leave the foreground with the user's app)
        if (!this.state.headless) await this.placeWindow(this.agentWindowMode()).catch(() => {});
      } else if (this.recoverWindow && !this.state.headless) {
        // a minimised window stays minimised: un-minimising brings it to the front when the user is working in Firefox
        await this.placeWindow(this.agentWindowMode(), false).catch(() => {});
      }
      this.recoverWindow = false;
      tops = await this.tree();
    }
    for (const [k, v] of Object.entries(this.state.tabs)) if (!tops.some((c) => c.context === v && c.clientWindow === this.clientWindow)) delete this.state.tabs[k];
    for (const c of tops) if (c.clientWindow === this.clientWindow) { this.handleFor(c.context); await this.bidiHub.watch(c.context); }
    const cur = this.cur;
    if (cur == null || !this.state.tabs[String(cur)]) {
      const first = Object.keys(this.state.tabs)[0];
      this.cur = first ? Number(first) : null;
    }
    this.recordTabs(tops);
  }

  /** Remember Claude's tabs (handle, URL, in window order) so a later BiDi session can find the window again. */
  private recordTabs(tops: { context: string; url: string; clientWindow: string }[]) {
    const inWin = tops.filter((c) => c.clientWindow === this.clientWindow);
    this.state.personalTabs = inWin.map((c) => ({ handle: Number(Object.entries(this.state.tabs ?? {}).find(([, v]) => v === c.context)?.[0] ?? 0), url: c.url }));
    this.save();
  }

  override async listTabs(includeUser = false): Promise<TabInfo[]> {
    let tops = await this.tree();
    if (!tops.some((c) => c.clientWindow === this.clientWindow)) { await this.ensureAgentWindow(); tops = await this.tree(); }
    const out: TabInfo[] = [];
    for (const c of tops) {
      const agent = c.clientWindow === this.clientWindow;
      if (!agent && !includeUser) continue;
      if (agent && !this.bidiHub.isWatched(c.context)) await this.bidiHub.watch(c.context);
      // titles of the user's tabs are read in this server's sandbox (invisible to the page)
      const title = await this.callPage(c.context, '() => document.title', [], { awaitPromise: false }).catch(() => '');
      const tab = this.handleFor(c.context);
      out.push({ tab, id: c.context, agent, url: c.url, title: String(title ?? ''), selected: false, current: tab === this.cur, bc: this.bidiHub.bcFor(c.context) });
    }
    this.recordTabs(tops);
    return out;
  }

  override async createTab(url?: string): Promise<number> {
    const agentTabs = (await this.listTabs()).filter((t) => t.agent);
    if (!agentTabs.length) { await this.ensureAgentWindow(); return Number(Object.keys(this.state.tabs ?? {})[0]); }
    const ctx = (await this.bidi.send('browsingContext.create', { type: 'tab', referenceContext: agentTabs[agentTabs.length - 1].id, background: true })).context;
    const handle = this.handleFor(ctx);
    await this.bidiHub.watch(ctx);
    this.recordTabs(await this.tree());
    for (const f of this.tabHooks) await f(ctx, currentClient()).catch(() => {});
    if (url) await this.bidi.send('browsingContext.navigate', { context: ctx, url, wait: 'complete' }, 60000);
    return handle;
  }

  override async selectTab(tab: number) {
    // activating a tab would raise and focus the window: only make it current for later calls
    await this.context(tab);
    this.cur = tab;
    this.save();
  }

  override async tabForBc(bc: number | undefined): Promise<number | undefined> {
    if (bc === undefined) return undefined;
    const ctx = this.bidiHub.ctxOfBc.get(bc);
    if (!ctx) return undefined;
    const e = Object.entries(this.state.tabs ?? {}).find(([, v]) => v === ctx);
    return e ? Number(e[0]) : undefined;
  }

  // ------------------------------------------------------------ what personal mode has instead of chrome scope
  override async a11yWalk(context: string, maxNodes: number): Promise<any> {
    return this.callPage(context, DOM_WALK, [maxNodes], { awaitPromise: false });
  }

  // ------------------------------------------------------------ Claude's window: visible or minimised (plain BiDi)
  // No off-screen parking here: occlusion tracking (on in the user's profile) counts an off-screen window as hidden,
  // so it would be throttled like a minimised one, and without chrome access nothing brings a parked window back when
  // the user picks it from the taskbar (they would type into an invisible window). Minimised is honest about both.
  private async clientWin(): Promise<{ x: number; y: number; width: number; height: number; state: string } | null> {
    if (!this.clientWindow) return null;
    return (await this.bidi.send('browser.getClientWindows')).clientWindows.find((w: any) => w.clientWindow === this.clientWindow) ?? null;
  }

  /** Centred on the screen of the current tab (for a window found off-screen, e.g. parked by an older version). */
  private async centred(w: { width: number; height: number }): Promise<{ x: number; y: number }> {
    const ctx = this.cur != null ? this.state.tabs?.[String(this.cur)] : undefined;
    const sc = ctx ? await this.callPage(ctx, '() => ({ l: screen.availLeft, t: screen.availTop, w: screen.availWidth, h: screen.availHeight })', [], { awaitPromise: false }).catch(() => null) : null;
    if (!sc) return { x: 40, y: 40 };
    return { x: Math.round(sc.l + Math.max(0, (sc.w - w.width) / 2)), y: Math.round(sc.t + Math.max(0, (sc.h - w.height) / 2)) };
  }

  /**
   * On-screen as a normal window. Moving never takes the foreground; un-minimising (BiDi restore) does when the user
   * is working in their Firefox at that moment (measured: with another app in front it doesn't), so only on request.
   */
  private async unminimize(restoreMinimized = true): Promise<'restored' | 'moved' | 'there' | 'minimized'> {
    const w = await this.clientWin();
    if (!w) return 'there';
    if (w.state === 'minimized') {
      if (!restoreMinimized) return 'minimized';
      // back to where it was before it was minimised
      await this.bidi.send('browser.setClientWindowState', { clientWindow: this.clientWindow, state: 'normal' });
      return 'restored';
    }
    if (w.state === 'normal' && w.x <= -10000) {
      await this.bidi.send('browser.setClientWindowState', { clientWindow: this.clientWindow, state: 'normal', ...(await this.centred(w)) });
      return 'moved';
    }
    return 'there';
  }

  private async minimize() {
    if (this.clientWindow) await this.bidi.send('browser.setClientWindowState', { clientWindow: this.clientWindow, state: 'minimized' });
  }

  /** Personal mode has two window modes: config / ff_window "offscreen" means minimised here (see above). */
  override agentWindowMode(): WindowMode | 'none' {
    const m = super.agentWindowMode();
    return m === 'offscreen' ? 'minimized' : m;
  }

  private async placeWindow(mode: WindowMode | 'none', restoreMinimized = true) {
    if (mode === 'minimized') await this.minimize();
    else if (mode === 'visible') await this.unminimize(restoreMinimized);
  }

  /** document.hidden of the current agent tab (covered or minimised); null when unknown */
  private async currentHidden(): Promise<boolean | null> {
    const ctx = this.cur != null ? this.state.tabs?.[String(this.cur)] : undefined;
    if (!ctx) return null;
    // a page waiting in one of Claude's dialogs can't answer: don't spend the timeout on it
    if ([...this.dialogs.open.values()].some((e) => e.context === ctx || this.bidiHub.top(e.context) === ctx)) return null;
    const r = await Promise.race([this.callPage(ctx, '() => document.hidden', [], { awaitPromise: false }).catch(() => null), sleep(1000).then(() => null)]);
    return typeof r === 'boolean' ? r : null;
  }

  override async showWindow(context: string) {
    await this.unminimize().catch(() => {});
    await this.bidi.send('browsingContext.activate', { context });
  }

  override async afterHandback() {
    // visible: the window stays where the user left it
    if (this.agentWindowMode() === 'minimized') await this.minimize();
  }

  override async setWindowMode(mode: 'visible' | 'offscreen'): Promise<string> {
    if (this.agentWindowMode() === 'none') fail('HEADLESS', 'this Firefox is headless; there is no window to show or park');
    if (mode === 'visible') {
      this.rememberWindowMode('visible');
      const r = await this.unminimize();
      await sleep(1200); // occlusion is re-evaluated asynchronously
      const hidden = await this.currentHidden();
      return [
        r === 'restored' ? "Claude's window restored from the taskbar and kept on-screen for this session (if the user was working in their Firefox, it came to the front)" : "Claude's window is on-screen for this session (not activated: it stays behind the window the user is working in)",
        hidden ? 'It is covered by other windows, so Firefox counts its pages as hidden (rAF, transitions and observers barely run, timers about 1/s) until the user brings it forward or uncovers it.' : '',
      ].filter(Boolean).join('. ');
    }
    this.rememberWindowMode('minimized');
    await this.minimize();
    return "Claude's window is minimised for this session (in the user's Firefox an off-screen window would be throttled just the same, and could not be brought back from the taskbar). Its pages count as hidden: page work goes on, but rAF, transitions and observers barely run and timers fire about once a second, so visual and timing checks are unreliable. ff_window(show), or the user clicking it in the taskbar, brings it back.";
  }

  /**
   * In the user's profile occlusion tracking is on: Claude's visible window behind other windows is throttled like a
   * minimised one (measured: hidden, 0 rAF/s, timers 1/s). Say so once per hidden spell (checked at most every 3 s;
   * not in minimised mode, which was chosen).
   */
  override async windowVisibilityNote(): Promise<string | null> {
    if (this.agentWindowMode() !== 'visible' || Date.now() - this.visCheckedAt < 3000) return null;
    this.visCheckedAt = Date.now();
    const hidden = await this.currentHidden();
    if (!hidden) { if (hidden === false) this.visNoted = false; return null; }
    if (this.visNoted) return null;
    this.visNoted = true;
    const w = await this.clientWin().catch(() => null);
    const min = w?.state === 'minimized';
    return `Claude's window in the user's Firefox ${min ? 'is minimised' : 'is covered by other windows'}, so Firefox counts its pages as hidden: requestAnimationFrame, CSS transitions and observer callbacks barely run, timers fire about once a second. Visual checks and timing are unreliable until it is visible: ${min ? 'ask the user to restore it, or ff_window(show) if they want to see it (it comes to the front if they are working in Firefox)' : 'ask the user to bring it forward or move it where nothing covers it'} (only if that matters for the task).`;
  }

  /** One line for ff_status. */
  override async windowLine(): Promise<string | null> {
    const m = this.agentWindowMode();
    if (m === 'none') return null;
    const w = await this.clientWin().catch(() => null);
    if (!w) return null;
    const hidden = await this.currentHidden();
    const where = w.state === 'minimized' ? 'minimised' : w.x <= -10000 ? 'parked off-screen' : `on-screen at ${w.x},${w.y}`;
    return `window: ${where} (mode ${m}) · pages ${hidden == null ? 'visibility unknown' : hidden ? 'HIDDEN (throttled: covered or minimised)' : 'visible'}`;
  }

  override async hub(): Promise<Hub> { return this.bidiHub; }
  override async promptOwner(context: string): Promise<string | null> { return this.bidiHub.isWatched(this.bidiHub.top(context)) ? '' : null; }
  override async agentContexts(): Promise<string[]> { return (await this.tree()).filter((c) => c.clientWindow === this.clientWindow).map((c) => c.context); }
  override async dt(): Promise<Devtools> { return personalRefusal('Extension, content-script and worker realms'); }
  override async startDevtools(): Promise<null> { return null; }
  override async callChrome<T = any>(): Promise<T> { return personalRefusal('Privileged (chrome) access'); }

  override async versionsInfo(): Promise<any> {
    this.versions = { firefox: this.firefoxVersion, buildId: '', addons: [] };
    return this.versions;
  }

  // ------------------------------------------------------------ teardown: never the user's browser
  /** Close Claude's window (its tabs) and end the BiDi session; Firefox keeps running. */
  private async closeOwnWindow() {
    try {
      const tops = await this.tree();
      for (const c of tops.filter((x) => x.clientWindow === this.clientWindow)) await this.bidi.send('browsingContext.close', { context: c.context, promptUnload: false }).catch(() => {});
    } catch { /* connection gone */ }
  }

  override async detach() {
    try { this.recordTabs(await this.tree()); } catch { /* keep the last record */ }
    this.save();
    this.bidiHub.close();
    await this.bidi.endSession();
    this.bidi.close();
  }

  override async quit(): Promise<void> {
    await this.closeOwnWindow();
    this.bidiHub.close();
    await this.bidi.endSession();
    this.bidi.close();
    this.dead = true;
    clearRunState(PERSONAL);
  }

  override kill() {
    // the kill switch never kills the user's browser: drop Claude's window and the connection
    void this.closeOwnWindow().finally(() => { try { this.bidi.close(); } catch { /* ignore */ } });
    this.bidiHub.close();
    this.dead = true;
    clearRunState(PERSONAL);
  }
}

/** Start the user's Firefox with remote control on a free port (written to WebDriverBiDiServer.json). */
async function launchPersonal(dir: string, headless: boolean): Promise<{ port: number; pid: number }> {
  const cfg = loadConfig();
  try { fs.rmSync(path.join(dir, 'WebDriverBiDiServer.json')); } catch { /* none */ }
  // no -no-remote: the user's own Firefox shortcuts must keep opening windows in this instance
  const args = ['-profile', dir, '--remote-debugging-port', '0'];
  if (headless) args.push('--headless');
  const child = spawn(cfg.firefoxPath, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  if (!child.pid) fail('LAUNCH_FAILED', `could not start ${cfg.firefoxPath}`);
  const t0 = Date.now();
  for (;;) {
    const port = await livePort(dir);
    if (port) return { port, pid: child.pid! };
    if (Date.now() - t0 > 45000) {
      throw new ToolError('LAUNCH_TIMEOUT', 'Firefox did not open remote control within 45 s',
        'If the user\'s Firefox was already starting (or another instance holds the profile), ask them to close it and retry.');
    }
    await sleep(250);
  }
}
