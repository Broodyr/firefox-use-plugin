import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientWorkspace } from './browser/client.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const HOME = process.env.FIREFOX_USE_HOME
  ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'firefox-use');
export const TOKEN_FILE = path.join(HOME, 'token');
export const RUN_DIR = path.join(HOME, 'run');
export const THROWAWAY_DIR = path.join(HOME, 'throwaway');

export interface Config {
  firefoxPath: string;
  profiles: Record<string, string>;
  addonsDir: string;
  sandboxDir: string;
  runDir: string;
  /** the user's main Firefox profile; read-only source for add-on version sync (auto-detected if unset) */
  mainProfile?: string;
  /** default true: at launch, update approved add-ons to the newer version found in the main profile */
  syncAddonsFromMainProfile?: boolean;
  /** quit Firefox after this many minutes without tool calls (default 15; 0 = never) */
  idleQuitMinutes?: number;
  /** throwaway copies: "all" add-ons as in claude-dev (default), or "core" (only uBO, Violentmonkey and temporary ones active; used by the test suite) */
  throwawayAddons?: 'all' | 'core';
  /** false: never use MCP elicitation for scope approval (for clients that advertise it but answer without showing it) */
  approvalDialog?: boolean;
  /** personal mode: the profile to drive (default: the main profile from profiles.ini) */
  personalProfile?: string;
  /**
   * Where Claude's window sits, per mode. dev (claude-dev) default "offscreen": a normal window parked off-screen, so its
   * pages count as visible and render (rAF, transitions). personal default "visible": a normal on-screen window the user
   * can watch, never activated by Claude. "minimized": pages hidden, rendering throttled. Personal mode treats
   * "offscreen" as "minimized" (with occlusion tracking on, an off-screen window is throttled too, and the taskbar can't
   * bring it back). A plain string sets dev only (the older flat setting). ff_window switches at runtime.
   */
  agentWindow?: WindowMode | { dev?: WindowMode; personal?: WindowMode };
  /** default true: at each claude-dev launch, compare its Violentmonkey scripts with the main profile's (read-only) */
  driftReport?: boolean;
}

export type WindowMode = 'offscreen' | 'visible' | 'minimized';
const WINDOW_MODES: WindowMode[] = ['offscreen', 'visible', 'minimized'];

/** The configured start mode of Claude's window: dev "offscreen", personal "visible" unless config says otherwise. */
export function agentWindowSetting(personal: boolean): WindowMode {
  const w = loadConfig().agentWindow;
  const v = typeof w === 'string' ? (personal ? undefined : w) : w?.[personal ? 'personal' : 'dev'];
  return v && WINDOW_MODES.includes(v) ? v : personal ? 'visible' : 'offscreen';
}

export interface Options {
  /** named profile (claude-dev) or a throwaway copy of it */
  profileMode: 'named' | 'throwaway';
  profile: string;
  headless: boolean;
  /** personal mode: ff_launch may start the user's Firefox (other tools only attach to it) */
  startPersonal?: boolean;
}

export function parseArgs(argv: string[]): Options {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const mode = get('profile-mode') ?? 'named';
  if (mode !== 'named' && mode !== 'throwaway' && mode !== 'claude-dev') throw new Error(`bad --profile-mode=${mode}`);
  return {
    profileMode: mode === 'throwaway' ? 'throwaway' : 'named',
    profile: get('profile') ?? 'claude-dev',
    headless: argv.includes('--headless'),
  };
}

let cached: Config | null = null;
let cachedMtime = -1;
/** config.json, re-read when it changes (a backend started before setup ran picks up the new config). */
export function loadConfig(): Config {
  const configFile = path.join(HOME, 'config.json');
  let mtime = 0;
  try { mtime = fs.statSync(configFile).mtimeMs; } catch { /* setup not run yet */ }
  if (cached && mtime === cachedMtime) return cached;
  cachedMtime = mtime;
  let file: Partial<Config> = {};
  try { file = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* setup not run yet */ }
  cached = {
    firefoxPath: file.firefoxPath && fs.existsSync(file.firefoxPath) ? file.firefoxPath : detectFirefox(),
    profiles: file.profiles ?? {},
    addonsDir: file.addonsDir ?? path.join(HOME, 'addons'),
    sandboxDir: file.sandboxDir ?? path.join(HOME, 'sandbox'),
    runDir: file.runDir ?? RUN_DIR,
    mainProfile: file.mainProfile,
    syncAddonsFromMainProfile: file.syncAddonsFromMainProfile,
    idleQuitMinutes: file.idleQuitMinutes,
    throwawayAddons: (process.env.FIREFOX_USE_THROWAWAY_ADDONS as Config['throwawayAddons']) ?? file.throwawayAddons,
    approvalDialog: file.approvalDialog,
    personalProfile: file.personalProfile,
    driftReport: file.driftReport,
    agentWindow: file.agentWindow,
  };
  return cached;
}

function detectFirefox(): string {
  if (process.platform === 'win32') {
    for (const hive of ['HKLM', 'HKCU']) {
      try {
        const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe`, '/ve'], { encoding: 'utf8', windowsHide: true });
        const m = /REG_SZ\s+(.+)$/m.exec(out);
        if (m && fs.existsSync(m[1].trim())) return m[1].trim();
      } catch { /* not found */ }
    }
    for (const p of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      const c = p && path.join(p, 'Mozilla Firefox', 'firefox.exe');
      if (c && fs.existsSync(c)) return c;
    }
  }
  for (const c of ['/usr/bin/firefox', '/Applications/Firefox.app/Contents/MacOS/firefox']) if (fs.existsSync(c)) return c;
  return 'firefox';
}

/** The user's project: where audit logs and artifacts go. */
export function workspace(): string {
  // a call routed from another Claude session works in that session's workspace
  const routed = clientWorkspace();
  if (routed) return routed;
  return process.env.FIREFOX_USE_WORKSPACE ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export function readToken(): string | null {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

export function ensureDir(d: string): string {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** The user's default Firefox profile directory, from profiles.ini (Install section first). Never the claude-dev profile. */
export function detectMainProfile(): string | null {
  const ini = path.join(process.env.APPDATA ?? '', 'Mozilla', 'Firefox', 'profiles.ini');
  let text: string;
  try { text = fs.readFileSync(ini, 'utf8'); } catch { return null; }
  const sections: Record<string, string>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^\[(.+)\]$/.exec(line);
    if (h) sections.push({ __name: h[1] });
    else { const kv = /^([^=]+)=(.*)$/.exec(line); if (kv && sections.length) sections[sections.length - 1][kv[1]] = kv[2]; }
  }
  const rel = sections.find((s) => s.__name.startsWith('Install'))?.Default
    ?? sections.find((s) => s.Name === 'default-release')?.Path;
  if (!rel) return null;
  const dir = path.isAbsolute(rel) ? rel : path.join(path.dirname(ini), rel);
  const dev = loadConfig().profiles['claude-dev'];
  if (dev && path.resolve(dev).toLowerCase() === path.resolve(dir).toLowerCase()) return null;
  return fs.existsSync(dir) ? dir : null;
}

/** Add-ons in the main profile (read-only, from its extensions.json): id -> {version, path to its .xpi}. */
export function mainProfileAddons(dir = detectMainProfile() ?? undefined): Map<string, { version: string; path: string }> {
  const out = new Map<string, { version: string; path: string }>();
  if (!dir) return out;
  try {
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'extensions.json'), 'utf8'));
    for (const a of db.addons ?? []) {
      const p = a.path ?? path.join(dir, 'extensions', `${a.id}.xpi`);
      if (a.id && a.version && p.endsWith('.xpi') && fs.existsSync(p)) out.set(a.id, { version: a.version, path: p });
    }
  } catch { /* no main profile or unreadable: nothing to sync */ }
  return out;
}

/** The PowerShell command that runs one of the plugin's setup scripts, with its full path (for hints shown to the user). */
export function setupCommand(script = 'setup.ps1', flags = ''): string {
  let root = REPO_ROOT;
  try { root = fs.realpathSync.native(REPO_ROOT); } catch { /* keep the path as loaded */ }
  return `powershell -ExecutionPolicy Bypass -File "${path.join(root, 'setup', script)}"${flags ? ` ${flags}` : ''}`;
}

/** What the user runs to get going again: setup if it never ran, else a new token after a kill switch. */
export function setupHint(): string {
  return fs.existsSync(path.join(HOME, 'config.json'))
    ? `the kill switch was engaged; the user re-enables with: ${setupCommand('setup.ps1', '-TokenOnly')}`
    : `setup has not run yet; the user runs, once: ${setupCommand()}`;
}
