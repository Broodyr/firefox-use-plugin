// Personal mode: the user's own profile (here a plain throwaway one) over BiDi only.
// The parity suites also run against it: CF_TEST_PERSONAL=1 node --test dev/harness/tests/{page,input,parity}.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, killPersonal, liveUrl, makeHome, personalProfile, raw, refFor, sse, startFixtures } from './helpers.ts';

const spawn = async (env: NodeJS.ProcessEnv) => { const c = McpClient.spawnServer(['--profile-mode=throwaway', '--headless'], env); await c.initialize(); return c; };

/** Every tool that personal mode must refuse with PERSONAL_MODE (one representative call each). */
const REFUSED: [string, Record<string, unknown>][] = [
  ['eval_privileged', { code: '1' }], ['ff_prefs_get', { names: ['a'] }], ['ff_prefs_set', { prefs: { a: 1 } }], ['ff_restart', {}],
  ['addons_list', {}], ['addons_set_enabled', { id: 'x', enabled: true }], ['addons_reload', { id: 'x' }], ['addons_install_local', { path: 'x' }],
  ['ext_storage_get', { extension: 'x' }], ['ext_storage_set', { extension: 'x', items: {} }], ['ext_storage_remove', { extension: 'x', keys: ['a'] }],
  ['ext_page_open', { extension: 'x', path: '/' }], ['ext_message', { extension: 'x', message: {} }], ['ext_source', { extension: 'x' }], ['managed_storage_set', { extension: 'x', json: {} }],
  ['realms_list', {}], ['inspect_xray', { expr: 'x' }],
  ['snapshot', {}], ['snapshot_cold', {}], ['snapshot_list', {}], ['snapshot_diff', { a: 'x' }], ['restore', { id: 'x' }], ['undo', { n: 1 }],
  ['scope_set', { description: 'x', areas: ['prefs'] }], ['scope_show', {}], ['scope_clear', {}], ['profile_sync', {}],
  ['us_list', {}], ['us_install', { path: 'x' }], ['ubo_status', {}], ['ubo_filters_get', {}], ['wait_for_ubo_event', { pattern: 'x' }], ['verify', { checks: ['1'] }],
  // site storage, permissions, downloads, clipboard, performance, packaging
  ['cookies_get', {}], ['local_storage', {}], ['indexeddb_list', {}], ['site_data_clear', {}], ['permissions_set', { name: 'geolocation', state: 'granted' }],
  ['downloads_list', {}], ['clipboard_read', {}], ['site_read', { kind: 'cookies' }], ['ext_read', { kind: 'addons' }], ['ff_write', { action: 'prefs_set', values: { a: 1 } }], ['perf_profile', { action: 'start' }], ['perf_memory', {}], ['ext_dev_build', { path: 'x' }],
];

describe('personal mode', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  // a stable owner pid, as the hot-reload proxy gives its backends (FIREFOX_USE_PROXY_PID)
  let env: NodeJS.ProcessEnv;
  before(async () => { h = makeHome(personalProfile()); env = { ...h.env, FIREFOX_USE_PROXY_PID: String(process.pid) }; fx = await startFixtures(); c = await spawn(env); });
  after(async () => { await c.close(); killPersonal(h.home); fx.close(); h.cleanup(); });

  it('other tools never start the user\'s Firefox; ff_launch does', async () => {
    let r = await c.call('ff_status', {});
    assert.match(r.text, /not connected/);
    r = await c.call('ff_launch', { profile: 'personal', headless: true });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /PERSONAL MODE/);
    assert.match(r.text, /started your Firefox .* keeps running when this session ends/);
    assert.match(r.text, /Claude's window: 1 tab\(s\) · current tab 1/);
    const run = JSON.parse(fs.readFileSync(path.join(h.home, 'run', 'personal.json'), 'utf8'));
    assert.equal(run.personal, true);
    assert.equal(run.pid, 0, 'no kill path may ever see a pid for the user\'s browser');
  });

  it('refuses everything beyond page level with PERSONAL_MODE', async () => {
    for (const [tool, args] of REFUSED) {
      const r = await c.call(tool, args);
      assert.ok(r.isError, `${tool} should be refused`);
      assert.match(r.text, /PERSONAL_MODE/, `${tool}: ${r.text}`);
    }
    // eval: page realm only
    let r = await c.call('eval', { code: '1 + 1' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /2/);
    for (const realm of [{ kind: 'privileged' }, { kind: 'content', extension: 'ubo' }, { kind: 'extension', extension: 'vm' }]) {
      r = await c.call('eval', { code: '1', realm });
      assert.match(r.text, /PERSONAL_MODE/, JSON.stringify(realm));
    }
    r = await c.call('ff_launch', { profile: 'claude-dev' });
    assert.match(r.text, /PROFILE_SWITCH/);
  });

  it('Claude\'s tabs live in its own window; the user\'s tabs are listed only on request and never logged', async () => {
    let r = await c.call('tabs_list', {});
    assert.doesNotMatch(r.text, /USER TAB/);
    r = await c.call('tabs_list', { include_user: true });
    const user = /tab (\d+) \[USER TAB\]/.exec(r.text);
    assert.ok(user, r.text);
    // the user names their tab: Claude may use it, but its console and network stay out of the logs
    await c.call('navigate', { url: fx.url('/errors.html'), tab: Number(user![1]) });
    await c.call('tabs_create', { url: fx.url('/form.html') });
    r = await c.call('tabs_list', {});
    assert.equal(r.text.trim().split('\n').length, 2, r.text);
    assert.match(r.text, /\* tab \d+: "Form fixture"/);
    r = await c.call('console_read', {});
    assert.doesNotMatch(r.text, /fixture/, r.text);
    r = await c.call('network_read', {});
    assert.doesNotMatch(r.text, /errors\.html/);
    assert.match(r.text, /GET 200 html .* \[page tab\d+ nav\] .*form\.html/);
    // a dialog in the user's own tab is theirs: left open (the session used to dismiss it), never reported
    r = await c.call('eval', { tab: Number(user![1]), code: 'setTimeout(() => { alert("for the user"); document.title = "after alert"; }, 0); "ok"' });
    assert.doesNotMatch(r.text, /dialog:/);
    await new Promise((res) => setTimeout(res, 700));
    r = await c.call('tabs_list', { include_user: true });
    assert.doesNotMatch(r.text, /after alert/, r.text);
    assert.doesNotMatch(r.text, /dialog:/);
  });

  it('console, errors, network bodies and headers of Claude\'s tabs', async () => {
    await c.call('navigate', { url: fx.url('/errors.html') });
    const r0 = await c.call('wait_for_console', { pattern: 'fixture uncaught', since: 'c0' });
    assert.ok(!r0.isError, r0.text);
    let r = await c.call('console_read', {});
    assert.match(r.text, /WARN +\[page tab\d+\] fixture warning/);
    assert.match(r.text, /repeated line.*×3/);
    assert.match(r.text, /fixture uncaught/);
    r = await c.call('errors_summary', {});
    assert.match(r.text, /TypeError: fixture uncaught/);
    assert.match(r.text, /fixture rejection/);
    await c.call('navigate', { url: fx.url('/csp.html') });
    r = await c.call('network_read', { filter: 'csp.html' });
    const id = /(r\d+) GET 200/.exec(r.text)![1];
    r = await c.call('network_body', { request_id: id });
    assert.match(r.text, /strict page/);
    r = await c.call('headers_inspect', { target: id });
    assert.match(r.text, /content-security-policy/i);
    assert.match(r.text, /BLOCKED: eval/);
    assert.match(r.text, /set-cookie: <masked>/i);
    assert.doesNotMatch(r.text, /SECRETCOOKIE/);
    r = await c.call('navigate', { url: fx.url('/idle.html'), wait: 'networkidle' });
    assert.match(r.text, /fetched slow/, r.text);
    r = await c.call('wait_for_request', { url_pattern: '/slow', since: 'r0' });
    assert.ok(!r.isError, r.text);
  });

  it('read_page refs from the DOM walk drive form_input and clicks; same-origin iframes are read', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const p = await c.call('read_page', {});
    assert.match(p.text, /checkbox "Agree"/);
    assert.match(p.text, /textbox "Secret" value="<masked>"/);
    await c.call('form_input', { ref: refFor(p.text, 'combobox', 'Pick'), value: 'Alpha' });
    assert.match((await c.call('get_page_text', {})).text, /pick:a/);
    await c.call('navigate', { url: fx.url('/frames.html') });
    const f = await c.call('read_page', { filter: 'all' });
    assert.match(f.text, /heading h1 "Second" \(in iframe\)/, f.text);
  });

  it('live view: frames of Claude\'s tab; the user\'s tabs are never listed, viewable or captured', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    const url = liveUrl((await c.call('ff_live_view', { action: 'open' })).text);
    const s = sse(url + 'events');
    try {
      const f = await s.next('frame', (d) => /page2\.html/.test(d.url));
      assert.equal((await raw(url + 'frame?seq=' + f.seq)).status, 200);
      const tabs = (await s.next('tabs')).tabs;
      const user = /tab (\d+) \[USER TAB\]/.exec((await c.call('tabs_list', { include_user: true })).text)!;
      assert.ok(user);
      assert.ok(!tabs.some((t: any) => t.tab === Number(user[1])), JSON.stringify(tabs));
      assert.ok(!tabs.some((t: any) => /errors\.html/.test(t.url)), 'the user\'s tab (named earlier) stays out');
      const r = await raw(url + 'view', { method: 'POST', headers: { 'x-live-view': '1', 'content-type': 'application/json' }, body: JSON.stringify({ tab: Number(user[1]) }) });
      assert.equal(r.status, 400, 'a user tab cannot be picked for viewing');
      assert.ok(s.events.filter((e) => e.type === 'frame').every((e) => !/errors\.html/.test(e.data.url)));
    } finally { s.close(); }
    await c.call('ff_live_view', { action: 'close' });
  });

  it('a new backend (hot reload) finds Claude\'s window again; ff_quit closes only that window', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    const before = (await c.call('tabs_list', {})).text;
    // a proxy reload: the old backend gets the detach notice (ends its BiDi session; Firefox and Claude's window stay)
    c.notify('notifications/firefox-use/detach');
    await c.close();
    c = await spawn(env);
    let r = await c.call('tabs_list', {});
    assert.ok(!r.isError, r.text);
    assert.equal(r.text, before, 'same handles, same tabs after reattaching');
    r = await c.call('ff_status', {});
    assert.match(r.text, /PERSONAL MODE/);
    r = await c.call('ff_quit', {});
    assert.match(r.text, /your Firefox keeps running/);
    // the user's own window survives; the remote port is still open
    const port = JSON.parse(fs.readFileSync(path.join(h.home, 'personal-profile', 'WebDriverBiDiServer.json'), 'utf8')).ws_port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.close();
    // back to claude-dev mode for this session; reattaching to personal mode is explicit
    r = await c.call('ff_status', {});
    assert.doesNotMatch(r.text, /PERSONAL MODE/);
    r = await c.call('ff_launch', { profile: 'personal', headless: true });
    assert.match(r.text, /attached to your running Firefox/);
    assert.match(r.text, /Claude's window: 1 tab\(s\)/, 'a new window: the old one was closed');
  });
});

describe('personal mode preconditions', () => {
  it('refuses a profile that is not set up (remote.prefs.recommended) and leaves the session on claude-dev', async () => {
    const h = makeHome(personalProfile(false));
    const c = await spawn(h.env);
    try {
      const r = await c.call('ff_launch', { profile: 'personal', headless: true });
      assert.match(r.text, /PERSONAL_SETUP_NEEDED/);
      assert.match(r.text, /personal-mode\.ps1/);
      assert.doesNotMatch((await c.call('ff_status', {})).text, /PERSONAL MODE/);
      assert.ok(!fs.existsSync(path.join(h.home, 'personal-profile', 'WebDriverBiDiServer.json')), 'Firefox was not started');
    } finally { await c.close(); killPersonal(h.home); h.cleanup(); }
  });

  it('a Firefox already running on the profile without remote control: PERSONAL_NOT_REMOTE (never closed for the user)', async () => {
    const h = makeHome(personalProfile());
    const dir = path.join(h.home, 'personal-profile');
    const { spawn: sp } = await import('node:child_process');
    const ff = sp(JSON.parse(fs.readFileSync(path.join(h.home, 'config.json'), 'utf8')).firefoxPath ?? 'C:/Program Files/Mozilla Firefox/firefox.exe', ['-no-remote', '-profile', dir, '--headless'], { stdio: 'ignore' });
    const c = await spawn(h.env);
    try {
      for (let i = 0; i < 80 && !fs.existsSync(path.join(dir, 'parent.lock')); i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      const r = await c.call('ff_launch', { profile: 'personal', headless: true });
      assert.match(r.text, /PERSONAL_NOT_REMOTE/, r.text);
      // (the process spawned above can be Firefox's launcher, which hands over to the browser and exits: look for a
      // Firefox on that profile instead)
      const still = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir.replaceAll("'", "''")}') }).Count`], { encoding: 'utf8', windowsHide: true }).trim();
      assert.ok(Number(still) > 0, `the user's Firefox is still running (${still} process(es) on the profile; the one spawned exited with ${ff.exitCode})`);
    } finally { await c.close(); killPersonal(h.home); h.cleanup(); }
  });
});
