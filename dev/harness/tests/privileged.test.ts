// privileged layer + prefs: eval_privileged, denylist, ff_prefs_*, addons_*, ext_storage_*, ext_page_open,
// ext_message, managed_storage_set.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { McpClient, ROOT, installTestExt, makeHome, startFixtures, startServer } from './helpers.ts';

const EXT = 'test-ext@firefox-use';

describe('privileged', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); await installTestExt(c, h.workspace); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('eval_privileged: values, errors, denylist, declared writes, protected prefs', async () => {
    let r = await c.call('eval_privileged', { code: 'return { v: Services.appinfo.name, n: [1, 2] }' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /"v": "Firefox"/);
    r = await c.call('eval_privileged', { code: 'throw new Error("nope")' });
    assert.match(r.text, /PRIVILEGED_EXCEPTION[\s\S]*nope/);
    for (const code of ['return Services.logins.getAllLogins()', 'return ChromeUtils.importESModule("resource://gre/modules/FxAccounts.sys.mjs")', 'return IOUtils.read(PathUtils.join(PathUtils.profileDir, "key4.db"))']) {
      r = await c.call('eval_privileged', { code });
      assert.ok(r.isError, code);
      assert.match(r.text, /DENIED/, code);
    }
    r = await c.call('eval_privileged', { code: 'Services.prefs.setBoolPref("ui.cf.test", true)' });
    assert.match(r.text, /DECLARE_WRITES/);
    r = await c.call('eval_privileged', { code: 'Services.prefs.setBoolPref("ui.cf.test", true); return 1', writes: true });
    assert.ok(!r.isError, r.text);
    // literal protected pref write: refused before running
    r = await c.call('eval_privileged', { code: 'Services.prefs.setIntPref("security.tls.version.min", 1)', writes: true });
    assert.match(r.text, /DENIED[\s\S]*security\.tls\.version\.min/);
    // indirect protected pref write: detected and reverted
    r = await c.call('eval_privileged', { code: 'const n = ["secu", "rity.cf_probe"].join(""); Services.prefs.setBoolPref(n, true); return 1', writes: true });
    assert.match(r.text, /DENIED[\s\S]*reverted/);
    r = await c.call('ff_prefs_get', { names: ['security.cf_probe'] });
    assert.match(r.text, /not set/);
  });

  it('ff_prefs_get / ff_prefs_set with before-values; protected prefs refused', async () => {
    let r = await c.call('ff_prefs_set', { values: { 'browser.cf.test.int': 7, 'browser.cf.test.str': 'x' } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /browser\.cf\.test\.int: null -> 7/);
    r = await c.call('ff_prefs_get', { names: ['browser.cf.test.int', 'browser.cf.test.str', 'devtools.chrome.enabled'] });
    assert.match(r.text, /browser\.cf\.test\.int = 7 \(int, user-set\)/);
    assert.match(r.text, /devtools\.chrome\.enabled = true/);
    r = await c.call('ff_prefs_set', { values: { 'browser.cf.test.int': null } });
    assert.match(r.text, /7 -> \(default\)/);
    for (const n of ['remote.enabled', 'devtools.debugger.remote-enabled', 'xpinstall.signatures.required', 'signon.rememberSignons']) {
      r = await c.call('ff_prefs_set', { values: { [n]: false } });
      assert.match(r.text, /DENIED/, n);
    }
    const audit = await c.call('ff_audit_show', { tool: 'ff_prefs_set', detail: 'full' });
    assert.match(audit.text, /"kind":"pref","path":"browser\.cf\.test\.int","before":null,"after":7/);
  });

  it('addons_list / set_enabled / reload / install_local refuses the web', async () => {
    let r = await c.call('addons_list', { detail: 'normal' });
    assert.match(r.text, /firefox-use test extension 1\.0 — test-ext@firefox-use \[temporary\]/);
    assert.match(r.text, /background: page/);
    assert.doesNotMatch(r.text, /undefined|newtab@mozilla\.org/, 'location shown; Mozilla built-ins hidden');
    assert.match(r.text, /app-temporary/);
    r = await c.call('addons_set_enabled', { extension: 'test-ext', enabled: false });
    assert.match(r.text, /enabled -> disabled/);
    r = await c.call('ext_storage_get', { extension: 'test-ext' });
    assert.match(r.text, /not running/);
    r = await c.call('addons_set_enabled', { extension: EXT, enabled: true });
    assert.match(r.text, /disabled -> enabled/);
    r = await c.call('addons_reload', { extension: 'test-ext' });
    assert.match(r.text, /reloaded/);
    r = await c.call('addons_install_local', { path: 'https://addons.mozilla.org/firefox/downloads/x.xpi' });
    assert.match(r.text, /DENIED/);
    r = await c.call('addons_install_local', { path: 'C:\\Windows\\System32' });
    assert.match(r.text, /PATH_REFUSED/);
  });

  it('ext_storage get/set/remove (local, session, sync), onChanged fires, masking + unmask', async () => {
    let r = await c.call('ext_storage_get', { extension: 'test-ext' });
    assert.match(r.text, /greeting \(4\): "hi"/);
    r = await c.call('ext_storage_get', { extension: 'test-ext', area: 'session' });
    assert.match(r.text, /sess .*"only-in-memory"/);
    r = await c.call('ext_storage_set', { extension: 'test-ext', items: { apiToken: 'tok-123456', plain: { a: 1 } } });
    assert.ok(!r.isError, r.text);
    r = await c.call('ext_storage_get', { extension: 'test-ext', keys: ['apiToken', 'plain', 'missing'] });
    assert.match(r.text, /plain \(7\): \{"a":1\}/);
    assert.match(r.text, /missing: \(absent\)/);
    r = await c.call('ext_storage_set', { extension: 'test-ext', items: { token: 'SECRET-VALUE' } });
    r = await c.call('ext_storage_get', { extension: 'test-ext', keys: ['token'] });
    assert.doesNotMatch(r.text, /SECRET-VALUE/);
    r = await c.call('ext_storage_get', { extension: 'test-ext', keys: ['token'], unmask: ['token'] });
    assert.match(r.text, /SECRET-VALUE/);
    r = await c.call('ext_storage_get', { extension: 'test-ext', unmask: ['password'] });
    assert.match(r.text, /DENIED/);
    // the extension saw the writes (storage.onChanged in its background)
    r = await c.call('wait_for_console', { pattern: 'storage changed local token', timeout_ms: 5000 });
    assert.match(r.text, /\[extension:firefox-use test extension\] test-ext storage changed local token/);
    r = await c.call('ext_storage_remove', { extension: 'test-ext', keys: ['token', 'plain'] });
    assert.ok(!r.isError, r.text);
    r = await c.call('ext_storage_get', { extension: 'test-ext', keys: ['token'] });
    assert.match(r.text, /token: \(absent\)/);
    r = await c.call('ext_storage_set', { extension: 'test-ext', area: 'sync', items: { s: 1 } });
    r = await c.call('ext_storage_get', { extension: 'test-ext', area: 'sync' });
    assert.match(r.text, /s \(1\): 1/);
    // uBO's storage, without its 20 MB of list caches
    r = await c.call('ext_storage_get', { extension: 'ubo', skip: '^cache/' });
    assert.match(r.text, /uBlock Origin storage\.local: \d+ key\(s\)/);
    assert.match(r.text, /selectedFilterLists/);
  });

  it('ext_page_open + extension page realm; ext_message as the extension\'s page', async () => {
    let r = await c.call('ext_page_open', { extension: 'test-ext', path: 'page.html' });
    assert.match(r.text, /tab \d+: moz-extension:\/\/[^/]+\/page\.html/);
    r = await c.call('eval', { code: 'pageMarker + " " + typeof browser.runtime', realm: { kind: 'extension', extension: 'test-ext', page: 'page.html' } });
    assert.match(r.text, /"extension-page object"/);
    r = await c.call('ext_message', { extension: 'test-ext', message: { cmd: 'echo', value: 'ping' } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /"echo": "ping"/);
    r = await c.call('ext_message', { extension: 'test-ext', message: { cmd: 'get' }, writes: false });
    assert.match(r.text, /"greeting": "hi"/);
  });

  it('ext_message falls back to an extension page when it has no background document', async () => {
    fs.cpSync(path.join(ROOT, 'dev', 'harness', 'fixtures', 'page-ext'), path.join(h.workspace, 'page-ext'), { recursive: true });
    let r = await c.call('addons_install_local', { path: 'page-ext' });
    assert.ok(!r.isError, r.text);
    r = await c.call('ext_message', { extension: 'page-ext@firefox-use', message: { v: 'hi' }, writes: false });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /"from": "page"[\s\S]*"echo": "hi"[\s\S]*sent from its extension page options\.html \((no background document|the background is a worker)\)/);
  });

  it('ext_source: list, read and grep an extension\'s files (temporary folder and .xpi)', async () => {
    let r = await c.call('ext_source', { extension: 'test-ext' });
    assert.match(r.text, /firefox-use test extension: \d+ file\(s\)[\s\S]*\nbg\.js  [\d.]+ k?B[\s\S]*\nmanifest\.json/);
    r = await c.call('ext_source', { extension: 'test-ext', path: 'manifest.json', from: 1, to: 3 });
    assert.match(r.text, /manifest\.json lines 1–3 of \d+/);
    r = await c.call('ext_source', { extension: 'test-ext', grep: 'onMessage' });
    assert.match(r.text, /\d+ match\(es\) for \/onMessage\/i[\s\S]*bg\.js:\d+:\d+ /);
    r = await c.call('ext_source', { extension: 'vm', prefix: 'background/' });
    assert.match(r.text, /Violentmonkey: \d+ file\(s\) under background\/ · jar:file:/);
    r = await c.call('ext_source', { extension: 'vm', grep: 'ParseScript', prefix: 'background/', context: 40, max_matches: 3 });
    assert.match(r.text, /background\/index\.js:1:\d+ .*ParseScript/);
    r = await c.call('ext_source', { extension: 'vm', path: 'background/index.js', from: 1, to: 1, max_chars: 3000 });
    assert.match(r.text, /probably minified; use grep with context, or offset\/length/);
    r = await c.call('ext_source', { extension: 'vm', path: 'background/index.js', offset: 0, length: 50 });
    assert.match(r.text, /chars 0–50 of \d+/);
    r = await c.call('ext_source', { extension: 'vm', path: 'nope.js' });
    assert.match(r.text, /FILE_NOT_FOUND/);
  });

  it('managed_storage_set: per-profile managed storage, reload, clear', async () => {
    let r = await c.call('managed_storage_set', { extension: 'test-ext', data: { adminSettings: '{"x":1}', flag: true } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /claude-managed-storage/);
    r = await c.call('eval', { code: 'return await browser.storage.managed.get(null)', realm: { kind: 'extension', extension: 'test-ext' } });
    assert.match(r.text, /"flag": true/);
    r = await c.call('ext_storage_get', { extension: 'test-ext', area: 'managed' });
    assert.match(r.text, /"adminSettings"/);
    r = await c.call('managed_storage_set', { extension: 'test-ext', data: null });
    assert.match(r.text, /cleared/);
    r = await c.call('eval', { code: 'return await browser.storage.managed.get(null).catch(e => "none: " + e.message)', realm: { kind: 'extension', extension: 'test-ext' } });
    assert.doesNotMatch(r.text, /"flag": true/);
  });
});
