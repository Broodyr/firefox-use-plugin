import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { McpClient, ROOT } from '../client.ts';
import { CORE_FILES, claudeDevProfile, coreAddons, firefoxPath, realConfig } from '../env.mjs';

export { McpClient, ROOT };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CORE = new Set<string>(CORE_FILES);

/**
 * Throwaway profiles in tests are copies of a clean TEMPLATE (setup/user.js + uBO + Violentmonkey, nothing of the
 * user's), not of claude-dev: smaller and faster to copy, the user's extensions, prefs and data never change a
 * test, and a machine without claude-dev can run the suite. The add-ons come from env.mjs coreAddons() (the user's
 * staged copies, else npm run test:setup's pinned ones). Built once per Firefox build / add-on files / user.js
 * (stamp), shared by parallel test files (lock). CF_TEST_FROM_CLAUDE_DEV=1 runs on copies of claude-dev instead.
 */
const TEMPLATE_ROOT = path.join(os.tmpdir(), 'cf-test-template');
/** set at the end of this module (top-level await), before any test runs */
let templateProfile: string | null = null;
function templateStamp(): string {
  const st = (f: string) => { try { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return '-'; } };
  const src = coreAddons()?.dir;
  const addons = src ? [...CORE].sort().map((f) => `${f}=${st(path.join(src, f))}`) : [];
  const ff = firefoxPath() ?? '';
  // application.ini: version + build id (an update can leave firefox.exe itself unchanged)
  return JSON.stringify({ v: 5, firefox: st(ff), app: st(path.join(path.dirname(ff), 'application.ini')), addons, userjs: st(path.join(ROOT, 'setup', 'user.js')) });
}
async function ensureTemplate(): Promise<string | null> {
  if (process.env.CF_TEST_FROM_CLAUDE_DEV) return null;
  const profile = path.join(TEMPLATE_ROOT, 'profile');
  const want = templateStamp();
  const ready = () => { try { return fs.readFileSync(path.join(TEMPLATE_ROOT, 'stamp.json'), 'utf8') === want && fs.existsSync(path.join(profile, 'prefs.js')); } catch { return false; } };
  if (ready()) return profile;
  const lock = `${TEMPLATE_ROOT}.lock`;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5 * 60000) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      await sleep(500);
      if (ready()) return profile;
    }
  }
  try {
    if (ready()) return profile;
    process.stderr.write('building the test template profile (once per Firefox / add-on version)...\n');
    const h = makeHome((cfg, home) => {
      const dir = path.join(home, 'profiles', 'tpl');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'user.js'), fs.readFileSync(path.join(ROOT, 'setup', 'user.js'), 'utf8').replaceAll('%SANDBOX%', path.join(os.tmpdir(), 'cf-test-sandbox').replaceAll('\\', '\\\\')));
      cfg.profiles = { tpl: dir };
    }, false);
    try {
      const c = McpClient.spawnServer(['--profile=tpl', '--profile-mode=named', '--headless'], { ...h.env, FIREFOX_USE_NO_COLD: '1' });
      await c.initialize();
      const r = await c.call('ff_launch', {});
      if (r.isError) throw new Error(`template launch failed: ${r.text}`);
      await c.call('ubo_status', {}); // uBO's first start (compiles its packaged lists) happens now, not in every copy
      await c.call('ff_quit', {});
      await c.close();
      fs.rmSync(TEMPLATE_ROOT, { recursive: true, force: true });
      fs.cpSync(path.join(h.home, 'profiles', 'tpl'), profile, { recursive: true, filter: (p) => !/(^|[\\/])(parent\.lock|lock|\.parentlock|cache2|startupCache|crashes|minidumps|sessionstore-backups|datareporting|saved-telemetry-pings)$/.test(p) });
      fs.writeFileSync(path.join(TEMPLATE_ROOT, 'stamp.json'), want);
    } finally { h.cleanup(); }
    return profile;
  } catch (e) {
    process.stderr.write(`test template failed: ${(e as Error).message}\n  falling back to copies of claude-dev${claudeDevProfile() ? '' : ', which is not set up on this machine either: the tests will fail (run npm run test:setup)'}\n`);
    return null;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/**
 * Isolated FIREFOX_USE_HOME for tests: own token, run dir and throwaway dir, and the real config (Firefox path,
 * staged core add-ons). Throwaway profiles are copies of the test template (above), or of claude-dev without one.
 */
export function makeHome(overrides: (cfg: any, home: string) => void = () => {}, useTemplate = true): { home: string; workspace: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'));
  const home = path.join(base, 'home');
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  // the real config (Firefox path, profiles, ...), or {} before setup has run
  const cfg: any = realConfig();
  cfg.runDir = path.join(home, 'run');
  cfg.sandboxDir = path.join(home, 'sandbox');
  // private copy of the core add-ons: launch-time sync may rewrite them
  const addons = path.join(home, 'addons');
  fs.mkdirSync(addons, { recursive: true });
  // only the core add-ons: extensions copied from the user's Firefox (profile_sync) stay out of tests
  const src = coreAddons()?.dir;
  if (src) for (const f of CORE) fs.copyFileSync(path.join(src, f), path.join(addons, f));
  cfg.addonsDir = addons;
  cfg.throwawayAddons = 'core';
  delete cfg.approvalDialog; // the user's dialog preference is not the tests' (scope.test.ts plays the user)
  delete cfg.personalProfile; // never the user's own profile in tests (personalProfile() sets a throwaway one)
  cfg.driftReport = false; // never read the user's main profile's userscripts (drift.test.ts sets up its own "main" profile)
  if (PERSONAL_RUN) personalProfile()(cfg, home);
  overrides(cfg, home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(home, 'token'), 'test-token-' + Math.random().toString(36).slice(2));
  return {
    home, workspace,
    env: { FIREFOX_USE_HOME: home, FIREFOX_USE_WORKSPACE: workspace, ...(useTemplate && templateProfile ? { FIREFOX_USE_THROWAWAY_FROM: templateProfile } : {}) },
    cleanup() {
      // anything a failed test left running on this home's profiles (e.g. a login handoff's plain window)
      killFirefoxUnder(base);
      try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* firefox may still hold files */ }
    },
  };
}

/** Kill every Firefox whose command line names a folder under dir (tests only: their temp homes). */
export function killFirefoxUnder(dir: string) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${dir.toLowerCase().replaceAll("'", "''")}') } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    for (const pid of out.split(/\s+/).filter(Boolean)) { try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ } }
  } catch { /* none */ }
}

/** makeHome override: a named profile "test-named" (fresh, from setup/user.js) for tests that need a lasting profile. */
export function namedProfile(cfg: any, home: string) {
  const dir = path.join(home, 'profiles', 'test-named');
  fs.mkdirSync(dir, { recursive: true });
  const tpl = fs.readFileSync(path.join(ROOT, 'setup', 'user.js'), 'utf8');
  fs.writeFileSync(path.join(dir, 'user.js'), tpl.replaceAll('%SANDBOX%', path.join(home, 'sandbox').replaceAll('\\', '\\\\')));
  cfg.profiles = { 'test-named': dir };
}
export const NAMED_ARGS = ['--profile=test-named', '--profile-mode=named', '--headless'];

/** Copy the fixture extension into the workspace and install it as a temporary add-on. */
export async function installTestExt(c: McpClient, workspace: string): Promise<void> {
  fs.cpSync(path.join(ROOT, 'dev', 'harness', 'fixtures', 'test-ext'), path.join(workspace, 'test-ext'), { recursive: true });
  const r = await c.call('addons_install_local', { path: 'test-ext' });
  if (r.isError) throw new Error(r.text);
}

export async function startServer(env: NodeJS.ProcessEnv, extraArgs: string[] = []): Promise<McpClient> {
  const c = McpClient.spawnServer(['--profile-mode=throwaway', '--headless', ...extraArgs], env);
  await c.initialize();
  if (PERSONAL_RUN && env.FIREFOX_USE_HOME && fs.existsSync(path.join(env.FIREFOX_USE_HOME, 'personal-profile'))) {
    // CF_TEST_PERSONAL=1: the same suite against personal mode on a plain throwaway profile
    const r = await c.call('ff_launch', { profile: 'personal', headless: true });
    if (r.isError) throw new Error(`personal launch failed: ${r.text}`);
    const close = c.close.bind(c);
    c.close = async () => { await close(); killPersonal(env.FIREFOX_USE_HOME!); };
  }
  return c;
}

/** CF_TEST_PERSONAL=1 runs the parity suites (page, input, parity) against personal mode. */
export const PERSONAL_RUN = !!process.env.CF_TEST_PERSONAL;

/**
 * makeHome override: a plain throwaway profile as "the user's own profile" for personal mode, set up the way
 * setup/personal-mode.ps1 does it (remote.prefs.recommended=false). setUp=false leaves that pref out.
 */
export function personalProfile(setUp = true) {
  return (cfg: any, home: string) => {
    const dir = path.join(home, 'personal-profile');
    fs.mkdirSync(dir, { recursive: true });
    const prefs = ['user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("browser.aboutwelcome.enabled", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);'];
    if (setUp) prefs.push('user_pref("remote.prefs.recommended", false);', 'user_pref("dom.file.createInChild", true);');
    fs.writeFileSync(path.join(dir, 'user.js'), prefs.join('\n') + '\n');
    cfg.personalProfile = dir;
  };
}

/** Tests only: stop the Firefox a personal-mode test started (the server itself never closes the user's browser). */
export function killPersonal(home: string) {
  const dir = path.join(home, 'personal-profile');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir.replaceAll("'", "''")}') } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true });
    for (const pid of out.split(/\s+/).filter(Boolean)) { try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ } }
  } catch { /* none */ }
}

export const PAGES: Record<string, string> = {
  '/form.html': `<!doctype html><title>Form fixture</title>
    <h1>Fixture form</h1>
    <button id="go" onclick="document.title='clicked ' + (++window.n || (window.n = 1)); window.lastTrusted = event.isTrusted">Go</button>
    <button onclick="document.title='second'">Go</button>
    <button ondblclick="document.title='double'">Dbl</button>
    <a href="/page2.html">Next page</a>
    <label>Name <input id="name" type="text" value="abc"></label>
    <label>Secret <input id="pw" type="password" value="hunter2"></label>
    <label>Pick <select id="pick"><option value="a">Alpha</option><option value="b" selected>Beta</option></select></label>
    <label><input id="agree" type="checkbox"> Agree</label>
    <label>Notes <textarea id="notes"></textarea></label>
    <label>Upload <input id="file" type="file"></label>
    <div id="ce" contenteditable="true" role="textbox" aria-label="Editor">edit me</div>
    <pre id="log"></pre><pre id="keys">keys:</pre><pre id="clicks">clicks:</pre>
    <script>
      const $ = (id) => document.getElementById(id);
      $('name').addEventListener('input', (e) => { $('log').textContent = 'input:' + e.target.value + ':' + e.isTrusted; });
      $('agree').addEventListener('change', (e) => { $('log').textContent = 'agree:' + e.target.checked; });
      $('pick').addEventListener('change', (e) => { $('log').textContent = 'pick:' + e.target.value; });
      $('file').addEventListener('change', (e) => { document.title = 'files:' + [...e.target.files].map(f => f.name).join(','); });
      addEventListener('keydown', (e) => { $('keys').textContent += (e.ctrlKey ? '^' : '') + (e.shiftKey && e.key.length > 1 ? '+' : '') + e.key + ','; });
      addEventListener('click', (e) => { $('clicks').textContent += '[' + e.clientX + ',' + e.clientY + (e.ctrlKey ? ',ctrl' : '') + ',' + e.isTrusted + ']'; });
    </script>
    <p style="margin-top:1500px">far away</p><button onclick="document.title='far clicked'">Far button</button>`,
  '/page2.html': `<!doctype html><title>Page two</title><h1>Second</h1><p>Main text of page two.</p>`,
  '/text.html': `<!doctype html><title>Text</title><nav>NAV LINKS</nav><main><h1>Article</h1><p>Body paragraph one.</p><p>Leak: Authorization: Bearer abcdefghijklmnopqrstuv and /api?token=SUPERSECRET123&x=1</p></main>`,
  '/drag.html': `<!doctype html><title>Drag</title><div id="box" style="position:absolute;left:20px;top:20px;width:60px;height:60px;background:red"></div>
    <script>let d=null;const b=document.getElementById('box');b.addEventListener('mousedown',e=>{d=[e.clientX-b.offsetLeft,e.clientY-b.offsetTop]});
    addEventListener('mousemove',e=>{if(d){b.style.left=(e.clientX-d[0])+'px';b.style.top=(e.clientY-d[1])+'px'}});addEventListener('mouseup',()=>{d=null;document.title='dropped '+b.offsetLeft+','+b.offsetTop});</script>`,
  '/dynamic.html': `<!doctype html><title>Dynamic</title><button onclick="const b=document.createElement('button');b.textContent='Added';document.body.append(b)">Add</button>`,
  '/hover.html': `<!doctype html><title>Hover</title><style>body{margin:0}</style><div id="h" style="position:absolute;left:100px;top:100px;width:100px;height:50px;background:#ccc" onmouseenter="document.title='hovered'">hover me</div>`,
  '/dialog.html': `<!doctype html><title>Dialog</title><button onclick="alert('hello from page'); document.title='after alert'">Alert</button>`,
  '/pw.html': `<!doctype html><title>PW</title><style>body{margin:0;background:#fff}</style><input id="pw" type="password" value="hunter2" style="position:absolute;left:10px;top:10px;width:200px;height:40px;background:#fff;border:0">`,
  '/csp.html': `<!doctype html><title>CSP</title><p>strict page</p>`,
  '/frames.html': `<!doctype html><title>Frames</title><h1>Outer</h1><iframe src="/page2.html"></iframe>`,
  '/xray.html': `<!doctype html><title>Xray</title><script>window.pageLib = { version: 3 }; document.body && 0;</script><p>expando page</p>`,
  '/ubo.html': `<!doctype html><title>uBO fixture</title><h1>uBO</h1>
    <div class="ad">Sponsored</div>
    <div class="box"><span>Buy now</span></div><div class="box"><span>Read more</span></div>
    <img src="/ads/banner.gif" alt="banner">
    <script>window.cfPageReady = true;</script>`,
  '/errors.html': `<!doctype html><title>Errors</title><script>
    console.warn('fixture warning');
    for (let i = 0; i < 3; i++) console.log('repeated line');
    Promise.reject(new Error('fixture rejection'));
    setTimeout(() => { throw new TypeError('fixture uncaught'); });
  </script>`,
  // @require files for the stack-line mapping: two lines each, with and without a final newline
  '/req-nl.js': 'window.__reqA = 1;\nwindow.__reqB = 2;\n',
  '/req-nonl.js': 'window.__reqC = 3;\nwindow.__reqD = 4;',
};

export async function startFixtures(): Promise<{ url: (p: string) => string; close(): void }> {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/slow') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('slow'); }, 1200);
      return;
    }
    if (u.pathname === '/idle.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>idle</title><script>addEventListener('load', () => fetch('/slow').then(r => r.text()).then(t => document.title = 'fetched ' + t))</script>`);
      return;
    }
    const body = PAGES[u.pathname];
    const extra: Record<string, string> = u.pathname === '/csp.html'
      ? { 'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.example.com", 'set-cookie': 'sid=SECRETCOOKIE123; HttpOnly' }
      : {};
    res.writeHead(body ? 200 : 404, { 'content-type': u.pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => srv.close() };
}

/** Extract `[ref_N] <role> "<name>"` -> ref. */
export function refFor(text: string, role: string, name: string): string {
  const re = new RegExp(`\\[(ref_\\d+)\\] ${role}(?: h\\d)? ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const m = re.exec(text);
  if (!m) throw new Error(`no ${role} "${name}" in:\n${text}`);
  return m[1];
}

export async function evalTitle(c: McpClient): Promise<string> {
  const r = await c.call('get_page_text', {});
  return r.text.split(' — ')[0];
}

templateProfile = await ensureTemplate();
