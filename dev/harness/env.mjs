// What the test harness needs from this machine, and the preflight check that says what is missing and how to get
// it (npm run test:*, test:setup, test:live). Plain JS: the runners import it before Node strips any TypeScript.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const HOME = process.env.FIREFOX_USE_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'firefox-use');

/** The user's config.json ({} before setup has run). */
export function realConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch { return {}; }
}

export const PINS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'test-addons.json'), 'utf8'));
/** npm run test:setup's copies (git-ignored). */
export const TEST_ADDONS_DIR = path.join(import.meta.dirname, '.test-addons');
/** In every test profile (the template): uBO and Violentmonkey; optional pins (Stylus) only where a test installs them. */
export const CORE_FILES = PINS.addons.filter((a) => !a.optional).map((a) => `${a.id}.xpi`);

const hasCore = (dir) => !!dir && CORE_FILES.every((f) => fs.existsSync(path.join(dir, f)));
/**
 * Where test profiles get uBlock Origin and Violentmonkey: FIREFOX_USE_TEST_ADDONS, else the copies setup.ps1 staged
 * from the user's own Firefox (the versions they run), else npm run test:setup's pinned copies. null: none of them.
 */
export function coreAddons() {
  const sources = [[process.env.FIREFOX_USE_TEST_ADDONS, 'FIREFOX_USE_TEST_ADDONS'], [realConfig().addonsDir, 'staged by setup.ps1'], [TEST_ADDONS_DIR, 'npm run test:setup']];
  for (const [dir, from] of sources) if (hasCore(dir)) return { dir, from };
  return null;
}

/** A pinned add-on's .xpi (e.g. the optional Stylus), from the same sources as coreAddons(); null when none has it. */
export function addonFile(id) {
  for (const dir of [process.env.FIREFOX_USE_TEST_ADDONS, realConfig().addonsDir, TEST_ADDONS_DIR]) {
    const f = dir && path.join(dir, `${id}.xpi`);
    if (f && fs.existsSync(f)) return f;
  }
  return null;
}

/** The Firefox the server would use (config.json, else the install the registry or Program Files names). */
export function firefoxPath() {
  const configured = realConfig().firefoxPath;
  if (configured && fs.existsSync(configured)) return configured;
  if (process.platform !== 'win32') return null;
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe`, '/ve'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /REG_SZ\s+(.+)$/m.exec(out);
      if (m && fs.existsSync(m[1].trim())) return m[1].trim();
    } catch { /* not registered */ }
  }
  for (const p of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    const c = p && path.join(p, 'Mozilla Firefox', 'firefox.exe');
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** The real claude-dev profile folder, if setup.ps1 created it. */
export function claudeDevProfile() {
  const p = realConfig().profiles?.['claude-dev'];
  return p && fs.existsSync(p) ? p : null;
}

const SETUP = `powershell -ExecutionPolicy Bypass -File "${path.join(ROOT, 'setup', 'setup.ps1')}"`;
export const CLAUDE_DEV_HELP = `claude-dev, the plugin's own Firefox profile, isn't set up on this machine. Run setup once, in PowerShell:
      ${SETUP}
    It creates claude-dev, writes its user.js, offers to copy uBlock Origin, Violentmonkey and Stylus from your own Firefox,
    and adds this checkout to CLAUDE_CODE_PLUGIN_DIRS.`;

/**
 * Check what a run needs; print each missing piece with how to get it. Returns false when the run can't work.
 *   serverRoot: where the server is spawned from (the repo, or a release tree)
 *   addons: the test profiles need uBO + Violentmonkey (the integration suites)
 *   claudeDev: the run uses the real claude-dev profile (test:live, CF_TEST_FROM_CLAUDE_DEV=1)
 */
export function preflight({ serverRoot = ROOT, addons = true, claudeDev = false, what = 'the tests' } = {}) {
  const problems = [];
  if (process.platform !== 'win32') problems.push('firefox-use runs on Windows only for now (README: "Windows only").');
  const [major, minor] = process.versions.node.split('.').map(Number);
  // the harness and tests are .ts files that Node runs directly (type stripping: 22.18+, 23.6+)
  if (!(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18))) problems.push(`Node ${process.versions.node} can't run the .ts test files: use Node 22.18 or later.`);
  if (!fs.existsSync(path.join(serverRoot, 'server', 'dist', 'index.js'))) {
    problems.push(serverRoot === ROOT ? 'The server isn\'t built: run npm install, then npm run build.' : `No server in ${serverRoot}: run npm run release first.`);
  }
  if (!firefoxPath()) problems.push('Firefox isn\'t installed (or not where Windows registers it): install the current release.');
  if (addons && !coreAddons()) {
    problems.push('The test profiles need uBlock Origin and Violentmonkey. Run npm run test:setup (copies or downloads the pinned versions\n    into dev/harness/.test-addons/), or setup\\setup.ps1, which copies yours from your own Firefox.');
  }
  if (claudeDev && !claudeDevProfile()) problems.push(CLAUDE_DEV_HELP);
  if (!problems.length) return true;
  console.error(`Can't run ${what} yet:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return false;
}
