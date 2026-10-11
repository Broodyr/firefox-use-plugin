// promote (SPEC §4.6): userscripts / userstyles / filter lists into the user's own Firefox (here a plain throwaway
// profile set up as personal mode, with Violentmonkey and Stylus sideloaded) through the extensions' install pages.
// Nothing is installed: Violentmonkey's page is left open (timeout), Stylus's closed by the test hook
// (FIREFOX_USE_TEST_PROMOTE=userstyle plays the user closing it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { addonFile } from '../env.mjs';
import { McpClient, killPersonal, makeHome, personalProfile } from './helpers.ts';

const VM = '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}';
const STYLUS = '{7a7a4a92-a2a0-41d1-9fd7-1e92480d612d}';
const STYLUS_XPI = addonFile(STYLUS);

/** personal-mode profile with the add-ons dropped into its extensions folder (profile scope, not auto-disabled) */
function withAddons(cfg: any, home: string) {
  personalProfile()(cfg, home);
  const dir = cfg.personalProfile;
  fs.mkdirSync(path.join(dir, 'extensions'), { recursive: true });
  for (const id of [VM, STYLUS]) { const f = addonFile(id); if (f) fs.copyFileSync(f, path.join(dir, 'extensions', `${id}.xpi`)); }
  fs.appendFileSync(path.join(dir, 'user.js'), 'user_pref("extensions.autoDisableScopes", 0);\nuser_pref("extensions.enabledScopes", 15);\n');
}

describe('promote', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>;
  before(async () => {
    h = makeHome(withAddons);
    fs.mkdirSync(path.join(h.workspace, 'scripts'));
    fs.mkdirSync(path.join(h.workspace, 'styles'));
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'hello.user.js'), '// ==UserScript==\n// @name Promote probe\n// @match https://example.com/*\n// ==/UserScript==\nconsole.log("probe");\n');
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'nometa.user.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(h.workspace, 'styles', 'probe.user.css'), '/* ==UserStyle==\n@name Promote style probe\n@namespace test\n@version 1.0.0\n==/UserStyle== */\n@-moz-document domain("example.com") { body { color: red } }\n');
    fs.writeFileSync(path.join(h.workspace, 'my-filters.txt'), '! a comment\nexample.com##.ad\n||ads.example^\n');
    c = McpClient.spawnServer(['--profile-mode=throwaway', '--headless'], { ...h.env, FIREFOX_USE_PROXY_PID: String(process.pid), FIREFOX_USE_TEST_PROMOTE: 'userstyle' });
    await c.initialize();
  });
  after(async () => { await c.close(); killPersonal(h.home); h.cleanup(); });

  it('is refused in claude-dev without starting anything', async () => {
    const r = await c.call('promote', { kind: 'userscript', path: 'scripts/hello.user.js' });
    assert.ok(r.isError);
    assert.match(r.text, /PERSONAL_ONLY/);
    assert.match(r.text, /us_write\(action: "install"\)/);
    assert.match((await c.call('ff_status', {})).text, /not connected/);
  });

  it('checks the file before opening anything', async () => {
    assert.ok(!(await c.call('ff_launch', { profile: 'personal', headless: true })).isError);
    let r = await c.call('promote', { kind: 'userscript', path: '../outside.user.js' });
    assert.match(r.text, /outside the workspace/);
    r = await c.call('promote', { kind: 'userstyle', path: 'scripts/hello.user.js' });
    assert.match(r.text, /must end in \.user\.css/);
    r = await c.call('promote', { kind: 'userscript', path: 'scripts/nometa.user.js' });
    assert.match(r.text, /BAD_FILE/);
  });

  it('filters: serves only the list (with a title) and gives the steps', async () => {
    const r = await c.call('promote', { kind: 'filters', path: 'my-filters.txt' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /2 filter\(s\)/);
    assert.match(r.text, /Filter lists -> at the bottom "Import…"/);
    assert.match(r.text, /My filters/);
    assert.match(r.text, /example\.com##\.ad/);
    const url = /at (http:\/\/127\.0\.0\.1:\d+\/promote\/my-filters\.txt)/.exec(r.text)![1];
    const body = await (await fetch(url)).text();
    assert.match(body, /^! Title: my-filters\n! a comment\nexample\.com##\.ad/);
    // nothing else of the workspace
    const origin = new URL(url).origin;
    for (const p of ['/scripts/hello.user.js', '/resources/bundle.js', '/promote/hello.user.js']) assert.equal((await fetch(origin + p)).status, 404, p);
  });

  it('userscript: Violentmonkey shows its install page; promote waits for the user and says what it saw', async () => {
    const t0 = Date.now();
    const r = await c.call('promote', { kind: 'userscript', path: 'scripts/hello.user.js', timeout_s: 6 });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Violentmonkey's install page for "Promote probe" is still open after \d+ s/);
    assert.ok(Date.now() - t0 >= 5000);
    assert.match(r.text, /Served from http:\/\/127\.0\.0\.1:\d+\/promote\/hello\.user\.js/);
    // the blank tab promote opened is gone; the install page is one of Claude's tabs
    const tabs = (await c.call('tabs_list', {})).text;
    assert.doesNotMatch(tabs, /hello\.user\.js/);
    {
      assert.match(tabs, /moz-extension:\/\/[^ ]+\/confirm\/index\.html/, tabs);
      // input tools work again once promote returned
      const close = /tab (\d+): [^\n]*moz-extension/.exec(tabs)!;
      assert.ok(!(await c.call('tabs', { op: 'close', tab: Number(close[1]) })).isError);
    }
  });

  it('userstyle: Stylus turns the tab into its install page', { skip: !STYLUS_XPI && 'Stylus not staged (npm run test:setup)' }, async () => {
    const r = await c.call('promote', { kind: 'userstyle', path: 'styles/probe.user.css', timeout_s: 6 });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Stylus's install page for "Promote style probe" was closed after \d+ s/);
    assert.doesNotMatch((await c.call('tabs_list', {})).text, /install-usercss|probe\.user\.css/);
  });

  it('audits the promotion', async () => {
    const r = await c.call('ff_audit_show', { tool: 'promote', detail: 'normal' });
    assert.match(r.text, /promote ok/);
    assert.match(r.text, /"kind":"promote","path":"scripts\/hello\.user\.js"/);
  });
});
