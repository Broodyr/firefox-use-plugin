import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { HOME, REPO_ROOT, THROWAWAY_DIR, ensureDir, loadConfig, setupCommand, type Options } from '../config.js';
import { ToolError, fail } from '../errors.js';
import { Bidi } from '../transports/bidi.js';

export interface RunState {
  key: string;
  /** the process we spawned: on Windows, Firefox's launcher process (parent of the browser) */
  pid: number;
  /** the browser process itself (Services.appinfo.processID), recorded at connect */
  browserPid?: number;
  bidiPort: number;
  rdpPort: number;
  profileDir: string;
  throwaway: boolean;
  headless: boolean;
  startedAt: string;
  ownerPid: number;
  ownerBackendPid?: number;
  /** short tab id -> BiDi context id, so handles survive a backend reload */
  tabs?: Record<string, string>;
  /** short tab id -> browser.browserId (stable across BiDi sessions; context ids are not) */
  tabBids?: Record<string, number>;
  current?: number | null;
  nextTab?: number;
  /** approved scope for the current task (survives backend reloads; cleared when Firefox stops) */
  scope?: import('./scope.js').Scope | null;
  /** other Claude sessions routed through this backend: client id -> their group, current tab, scope */
  clients?: Record<string, { n: number; label: string; current: number | null; scope: import('./scope.js').Scope | null }>;
  /** personal mode: the user's own Firefox; pid stays 0 so no kill path ever touches it */
  personal?: boolean;
  /** personal mode: the process we started, if we started it (tests clean it up; Claude never kills it) */
  launcherPid?: number;
  /** personal mode: Claude's tabs in window order (BiDi ids change per session; the window is found again by URL) */
  personalTabs?: { handle: number; url: string }[];
  /** ff_window's choice (visible / offscreen) for the session that made it (owner = its proxy pid); config sets the start */
  windowMode?: { mode: import('../config.js').WindowMode; owner: number };
  /** debugger breakpoints and settings, set again by the next backend after a hot reload */
  debugger?: import('./debugger.js').SavedDebugger;
}

export const ownerPid = () => Number(process.env.FIREFOX_USE_PROXY_PID || process.pid);

/** Is this Firefox still running? (browser process, or the launcher while the browser is still starting) */
export function firefoxAlive(s: RunState): boolean { return isAlive(s.browserPid) || isAlive(s.pid); }

/** Kill a recorded Firefox: the launcher's process tree and the browser process (if it outlived its launcher). */
export function killFirefox(s: RunState) {
  // run state can be old (CLI kill, orphan reaping): never kill a pid Windows has since given to another program
  if (isOurFirefox(s.pid, s.profileDir)) killTree(s.pid);
  if (s.browserPid && s.browserPid !== s.pid && isOurFirefox(s.browserPid, s.profileDir)) killTree(s.browserPid);
}

/**
 * Is this pid a Firefox running OUR profile? The command line must name the profile folder, so a reused pid that now
 * belongs to the user's own Firefox (or anything else) never matches.
 */
export function isOurFirefox(pid: number | undefined, profileDir: string): boolean {
  if (!isAlive(pid)) return false;
  try {
    const cmd = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
      : execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    return /firefox/i.test(cmd) && cmd.toLowerCase().includes(path.resolve(profileDir).toLowerCase());
  } catch { return false; /* can't tell: never kill on a guess */ }
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}

export function runStatePath(key: string) { return path.join(loadConfig().runDir, `${key}.json`); }
export function readRunState(key: string): RunState | null {
  try { return JSON.parse(fs.readFileSync(runStatePath(key), 'utf8')); } catch { return null; }
}
export function writeRunState(s: RunState) {
  ensureDir(loadConfig().runDir);
  fs.writeFileSync(runStatePath(s.key), JSON.stringify(s, null, 1));
}
export function clearRunState(key: string) { try { fs.unlinkSync(runStatePath(key)); } catch { /* gone */ } }

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

export function profileKey(opts: Options) { return opts.profile === 'personal' ? 'personal' : opts.profileMode === 'throwaway' ? `throwaway-${ownerPid()}` : opts.profile; }

/** Resolve (and for throwaway mode, create) the profile directory. */
export function prepareProfile(opts: Options): { dir: string; throwaway: boolean } {
  const cfg = loadConfig();
  const named = cfg.profiles[opts.profile];
  if (opts.profileMode === 'named') {
    if (!named || !fs.existsSync(named)) {
      fail('PROFILE_MISSING', `profile "${opts.profile}" not found`, `The user runs setup once, in PowerShell: ${setupCommand()}`);
    }
    return { dir: named, throwaway: false };
  }
  ensureDir(THROWAWAY_DIR);
  reapThrowaways();
  const dir = path.join(THROWAWAY_DIR, `claude-test-${ownerPid()}-${Date.now().toString(36)}`);
  // tests: a clean template profile (setup/user.js + uBO + Violentmonkey, nothing of the user's) instead of claude-dev
  const tpl = process.env.FIREFOX_USE_THROWAWAY_FROM;
  if (tpl && fs.existsSync(path.join(tpl, 'prefs.js'))) {
    copyProfile(tpl, dir);
  } else if (named && fs.existsSync(named)) {
    copyProfile(named, dir, cfg.throwawayAddons === 'core');
  } else {
    ensureDir(dir);
    const tpl = fs.readFileSync(path.join(REPO_ROOT, 'setup', 'user.js'), 'utf8')
      .replaceAll('%SANDBOX%', ensureDir(cfg.sandboxDir).replaceAll('\\', '\\\\'));
    fs.writeFileSync(path.join(dir, 'user.js'), tpl);
  }
  return { dir, throwaway: true };
}

/** Kill Firefoxes and delete profiles of throwaway runs whose owner process is gone. */
function reapThrowaways() {
  const runDir = loadConfig().runDir;
  for (const f of fs.existsSync(runDir) ? fs.readdirSync(runDir) : []) {
    const m = /^throwaway-(\d+)\.json$/.exec(f);
    if (!m || isAlive(Number(m[1]))) continue;
    try {
      const s: RunState = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
      if (firefoxAlive(s)) killFirefox(s);
    } catch { /* unreadable */ }
    try { fs.unlinkSync(path.join(runDir, f)); } catch { /* gone */ }
  }
  for (const d of fs.readdirSync(THROWAWAY_DIR)) {
    const m = /^claude-test-(\d+)-/.exec(d);
    if (m && !isAlive(Number(m[1]))) {
      try { fs.rmSync(path.join(THROWAWAY_DIR, d), { recursive: true, force: true, maxRetries: 2 }); } catch { /* still locked; next time */ }
    }
  }
}

const SKIP = new Set(['parent.lock', 'lock', '.parentlock', 'cache2', 'startupCache', 'crashes', 'minidumps', 'sessionstore-backups',
  'sessionstore.jsonlz4', 'datareporting', 'saved-telemetry-pings', 'thumbnails', 'shader-cache', 'jumpListCache']);
/** The core add-ons the test suite drives; their data is left behind in "core" throwaway copies. */
const CORE_ADDONS = ['uBlock0@raymondhill.net', '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}'];

/**
 * coreClean (throwawayAddons "core", the test suite): leave uBO's and Violentmonkey's own data behind (storage, userscripts),
 * so they start clean instead of with the user's filters and scripts copied into claude-dev. Only theirs: the other
 * extensions' storage stays (some of them, started once before "core" disables them, broke wheel scrolling without it).
 */
function copyProfile(src: string, dst: string, coreClean = false) {
  let skipDirs = new Set<string>();
  if (coreClean) {
    try {
      const m = /user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\);/.exec(fs.readFileSync(path.join(src, 'prefs.js'), 'utf8'));
      const uuids: Record<string, string> = m ? JSON.parse(JSON.parse(`"${m[1]}"`)) : {};
      skipDirs = new Set(CORE_ADDONS.filter((id) => uuids[id]).map((id) => `moz-extension+++${uuids[id]}`));
    } catch { /* no map: copy everything */ }
  }
  const coreData = (p: string) => {
    const b = path.basename(p);
    if (skipDirs.has(b.split('^')[0]) && /[\\/]storage[\\/]default[\\/][^\\/]+$/.test(p)) return true;
    if (b === 'extension-store-userscripts') return true;
    return CORE_ADDONS.includes(b) && /[\\/]browser-extension-data[\\/][^\\/]+$/.test(p);
  };
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => !SKIP.has(path.basename(p)) && !p.endsWith('-wal') && !p.endsWith('-shm') && !(coreClean && coreData(p)),
  });
}

/**
 * Refuse to launch on a profile that a non-automated Firefox already has open. A Firefox that is just quitting
 * (ff_quit, ff_restart) can hold the lock a moment after its browser process reported exit: retry for a few seconds.
 */
async function assertProfileFree(dir: string) {
  const lock = path.join(dir, 'parent.lock');
  for (let i = 0; ; i++) {
    if (!fs.existsSync(lock)) return;
    try { fs.rmSync(lock); return; } catch {
      if (i >= 20) fail('PROFILE_IN_USE', `the profile at ${dir} is already open in another Firefox`, 'Close that Firefox window (it was not started by firefox-use), then retry.');
      await sleep(250);
    }
  }
}

/**
 * Prefs Firefox reads only at startup, added to the profile's user.js (written by setup.ps1) when an older setup
 * lacks them: taskbar.grouping.useprofile gives claude-dev its own taskbar button instead of stacking with the
 * user's Firefox.
 */
function ensureUserPrefs(dir: string) {
  const file = path.join(dir, 'user.js');
  const want: Record<string, string> = { 'taskbar.grouping.useprofile': 'true' };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const add = Object.entries(want).filter(([k]) => !text.includes(`"${k}"`));
  if (!add.length) return;
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}\n// added by firefox-use (startup-only prefs)\n${add.map(([k, v]) => `user_pref("${k}", ${v});`).join('\n')}\n`);
}

/**
 * The install's AutoConfig script, if any (defaults/pref/*.js setting general.config.filename): it runs in every
 * profile, claude-dev and test profiles included, and the prefs it locks can't be changed by anything else.
 */
export function autoConfig(firefoxPath: string): { file: string; via: string; locks: string[] } | null {
  try {
    const dir = path.join(path.dirname(firefoxPath), 'defaults', 'pref');
    for (const f of fs.readdirSync(dir)) {
      const m = /general\.config\.filename"\s*,\s*"([^"]+)"/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!m) continue;
      const file = path.join(path.dirname(firefoxPath), m[1]);
      let locks: string[] = [];
      try { locks = [...fs.readFileSync(file, 'utf8').matchAll(/lockPref\(\s*["']([^"']+)["']/g)].map((x) => x[1]); } catch { /* unreadable */ }
      return { file, via: `defaults/pref/${f}`, locks };
    }
  } catch { /* no defaults/pref */ }
  return null;
}

/**
 * A start that never brings BiDi up is often a modal dialog Firefox shows before its first window (an AutoConfig
 * error alert, a profile error), invisible in a headless or parked window. Name the AutoConfig script if any.
 */
function startupDialogHint(firefoxPath: string): string {
  const base = 'Firefox may be waiting on a startup dialog that a headless or off-screen window hides (start it once visibly with the same profile to see it).';
  const ac = autoConfig(firefoxPath);
  return ac ? `${base} This Firefox runs an AutoConfig script (${ac.file}, enabled by ${ac.via}): when it throws, e.g. lockPref/unlockPref on a pref the profile doesn't have, Firefox shows an "AutoConfig Alert" and waits.` : base;
}

/**
 * Has this launch started a web content process yet? A healthy start does within a few seconds; a start stuck on a
 * startup dialog never does (measured: launcher + main process only, main thread idle). Windows only; true elsewhere.
 */
function hasContentProcess(profileDir: string): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const dir = profileDir.replaceAll("'", "''");
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$all = @(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'"); $mine = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ForEach-Object { $_.ProcessId }); @($all | Where-Object { $mine -contains $_.ParentProcessId -and $_.CommandLine -match '-contentproc' -and $_.CommandLine -match ' tab\\s*$' }).Count`],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return Number(out.trim()) > 0;
  } catch { return true; } // can't tell: keep waiting
}

export async function launchFirefox(opts: Options, key: string): Promise<RunState> {
  const cfg = loadConfig();
  const { dir, throwaway } = prepareProfile(opts);
  await assertProfileFree(dir);
  ensureUserPrefs(dir);
  const bidiPort = await freePort();
  const rdpPort = await freePort();
  const args = ['-no-remote', '-profile', dir,
    '--remote-debugging-port', String(bidiPort), '--remote-allow-system-access',
    '--start-debugger-server', String(rdpPort)];
  if (opts.headless) args.push('--headless');
  const logFile = path.join(ensureDir(cfg.runDir), `${key}.firefox.log`);
  const out = fs.openSync(logFile, 'w');
  const child = spawn(cfg.firefoxPath, args, { detached: true, stdio: ['ignore', out, out], windowsHide: false });
  child.unref();
  fs.closeSync(out);
  if (!child.pid) fail('LAUNCH_FAILED', `could not start ${cfg.firefoxPath}`);
  const url = `ws://127.0.0.1:${bidiPort}/session`;
  const t0 = Date.now();
  let checkedAt = 0;
  while (!(await Bidi.probe(url))) {
    if (!isAlive(child.pid)) fail('LAUNCH_FAILED', 'Firefox exited during startup', undefined, { log: tail(logFile) });
    // stuck on a hidden startup dialog: say so after 15 s instead of waiting the full 45
    if (Date.now() - t0 > 15000 && Date.now() - checkedAt > 5000) {
      checkedAt = Date.now();
      if (!hasContentProcess(dir) && !(await Bidi.probe(url))) { killTree(child.pid!); fail('LAUNCH_STUCK', 'Firefox has not started a single web content process after 15 s: its startup is waiting', startupDialogHint(cfg.firefoxPath), { log: tail(logFile) }); }
    }
    if (Date.now() - t0 > 45000) { killTree(child.pid!); fail('LAUNCH_TIMEOUT', 'BiDi did not come up within 45 s', startupDialogHint(cfg.firefoxPath), { log: tail(logFile) }); }
    await sleep(250);
  }
  const state: RunState = {
    key, pid: child.pid!, bidiPort, rdpPort, profileDir: dir, throwaway, headless: opts.headless,
    startedAt: new Date().toISOString(), ownerPid: ownerPid(), ownerBackendPid: process.pid, tabs: {}, current: null, nextTab: 1,
  };
  writeRunState(state);
  return state;
}

// ------------------------------------------------------------ plain login window (ff_handoff mode "login")
/**
 * A login some sites only accept from a normal browser (bot checks see navigator.webdriver, which Firefox sets
 * whenever the remote agent runs): the profile is reopened without any remote flag, the user logs in, closes it,
 * and automation resumes on the same profile with the cookies the login left.
 */
/** Approvals of the session that started a login handoff, adopted when automation resumes (same backend). */
export const loginCarry: { approvals?: unknown } = {};

export interface LoginState { key: string; pid: number; url: string; since: string; profileDir: string; agentUrls: string[]; ownerPid: number }

const loginPath = (key: string) => path.join(loadConfig().runDir, `${key}.login.json`);
export function readLogin(key: string): LoginState | null { try { return JSON.parse(fs.readFileSync(loginPath(key), 'utf8')); } catch { return null; } }
export function clearLogin(key: string) { try { fs.unlinkSync(loginPath(key)); } catch { /* gone */ } }

/**
 * Firefox processes running this profile, by command line. (parent.lock is no reliable signal: a profile Firefox
 * had open before was found unlocked while a second, plain instance ran on it.)
 */
export function profilePids(dir: string): number[] {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${path.resolve(dir).toLowerCase().replaceAll("'", "''")}') } | ForEach-Object { $_.ProcessId }`],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 })
      : execFileSync('pgrep', ['-f', path.resolve(dir)], { encoding: 'utf8' });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}

export const profileLocked = (dir: string) => profilePids(dir).length > 0;

export function launchPlain(key: string, profileDir: string, url: string, agentUrls: string[], headless = false): LoginState {
  const cfg = loadConfig();
  const out = fs.openSync(path.join(ensureDir(cfg.runDir), `${key}.login.log`), 'w');
  // no --remote-debugging-port / --remote-allow-system-access / debugger server: an ordinary Firefox
  const child = spawn(cfg.firefoxPath, ['-no-remote', '-profile', profileDir, ...(headless ? ['--headless'] : []), url], { detached: true, stdio: ['ignore', out, out], windowsHide: false });
  child.unref();
  fs.closeSync(out);
  if (!child.pid) fail('LAUNCH_FAILED', `could not start ${cfg.firefoxPath}`);
  const st: LoginState = { key, pid: child.pid!, url, since: new Date().toISOString(), profileDir, agentUrls, ownerPid: ownerPid() };
  fs.writeFileSync(loginPath(key), JSON.stringify(st, null, 1));
  return st;
}

/** Ask the plain Firefox to close like a click on its close button (so it saves its session), then wait. */
export async function closePlain(st: LoginState, ms = 20000): Promise<boolean> {
  if (!profileLocked(st.profileDir)) return true;
  if (process.platform === 'win32') {
    // graceful: WM_CLOSE to the windows of every Firefox process on this profile (no /F)
    for (const pid of profilePids(st.profileDir)) { try { execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* no window */ } }
  } else {
    try { process.kill(st.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  const t0 = Date.now();
  while (profileLocked(st.profileDir) && Date.now() - t0 < ms) await sleep(500);
  return !profileLocked(st.profileDir);
}

/**
 * The next start restores the session the plain window saved when it closed: its tab, and the session cookies a
 * login often sets (they'd be gone otherwise). Firefox clears the pref once used. Profile must not be running.
 */
export function armSessionResume(profileDir: string) {
  const f = path.join(profileDir, 'prefs.js');
  const line = 'user_pref("browser.sessionstore.resume_session_once", true);';
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
  if (!text.includes(line)) fs.appendFileSync(f, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
}

export function killTree(pid: number) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

export async function waitExit(pid: number, ms: number) {
  const t0 = Date.now();
  while (isAlive(pid) && Date.now() - t0 < ms) await sleep(200);
  return !isAlive(pid);
}

export function removeThrowaway(state: RunState) {
  if (!state.throwaway || !state.profileDir.startsWith(THROWAWAY_DIR)) return;
  try { fs.rmSync(state.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* cleaned on next start */ }
}

function tail(file: string) { try { return fs.readFileSync(file, 'utf8').split('\n').slice(-15).join('\n'); } catch { return ''; } }
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { HOME, ToolError };
