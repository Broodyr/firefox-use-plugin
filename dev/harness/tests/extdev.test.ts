// ext_dev_*: lint (Firefox's manifest validation), load + hot reload on file change with startup errors per
// reload (an invalid manifest keeps the running version), inspect (realms, permissions, storage, messaging log).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { SERVER_ROOT } from '../client.ts';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

// web-ext as the server finds it: the plugin's dev dependency, else a global install. A release tree has neither
// unless the user installed it globally; the lint/build tools then say so instead of running addons-linter.
const npmRoot = () => { try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, windowsHide: true }).trim(); } catch { return ''; } };
const HAS_WEB_EXT = fs.existsSync(path.join(SERVER_ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js')) || fs.existsSync(path.join(npmRoot(), 'web-ext', 'bin', 'web-ext.js'));

const BG = (extra = '') => `${extra}
browser.storage.local.set({ ready: true });
browser.runtime.onMessage.addListener((msg) => Promise.resolve({ pong: msg.ping * 2 }));
browser.runtime.onConnect.addListener((port) => port.onMessage.addListener((m) => port.postMessage({ echo: m.n })));
`;
const CS = `browser.runtime.sendMessage({ ping: 21 }).then((r) => { document.documentElement.dataset.pong = r.pong; });
const port = browser.runtime.connect({ name: 'chan' });
port.onMessage.addListener((m) => { document.documentElement.dataset.echo = m.echo; });
port.postMessage({ n: 7 });
`;
const MANIFEST = { manifest_version: 2, name: 'dev fixture', version: '1.0', browser_specific_settings: { gecko: { id: 'dev-fixture@firefox-use' } }, background: { scripts: ['bg.js'] }, permissions: ['storage'], content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'] }] };

describe('ext_dev', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>, dir = '';
  const write = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);
  const until = async (re: RegExp, ms = 6000) => {
    let r = await c.call('ext_dev_inspect', { extension: 'dev-fixture@firefox-use' });
    for (let t = 0; t < ms / 250 && !re.test(r.text); t++) { await new Promise((res) => setTimeout(res, 250)); r = await c.call('ext_dev_inspect', { extension: 'dev-fixture@firefox-use' }); }
    return r;
  };
  before(async () => {
    // no AMO keys in this server (ext_dev_sign refuses before anything leaves the machine)
    h = makeHome(); fx = await startFixtures(); c = await startServer({ ...h.env, WEB_EXT_API_KEY: '', WEB_EXT_API_SECRET: '' });
    dir = path.join(h.workspace, 'devext');
    fs.mkdirSync(dir, { recursive: true });
    write('manifest.json', JSON.stringify(MANIFEST, null, 1));
    write('bg.js', BG());
    write('cs.js', CS);
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('ext_dev_lint: Firefox manifest validation', async () => {
    let r = await c.call('ext_dev_lint', { path: 'devext' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Firefox: manifest OK \(dev fixture 1\.0, MV2\)/);
    if (HAS_WEB_EXT) assert.match(r.text, /addons-linter: \d+ error\(s\), \d+ warning\(s\)/); // web-ext installed
    else assert.match(r.text, /addons-linter: not run \(web-ext is not installed; the user can add it with npm install -g web-ext\)/);
    fs.mkdirSync(path.join(h.workspace, 'badext'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'badext', 'manifest.json'), JSON.stringify({ manifest_version: 2, version: '1', permissions: ['notAPermission'] }));
    r = await c.call('ext_dev_lint', { path: 'badext' });
    assert.match(r.text, /Firefox: REFUSES the manifest/);
    assert.match(r.text, /name/);
  });

  it('ext_dev_load + inspect + messaging log', async () => {
    let r = await c.call('ext_dev_load', { path: 'devext' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /loaded dev fixture 1\.0 \(dev-fixture@firefox-use, MV2\) from devext as a temporary add-on; reloads when its files change/);
    assert.match(r.text, /no startup errors/);
    r = await c.call('ext_dev_inspect', { extension: 'dev-fixture@firefox-use', messages: 'on' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /realms: background/);
    assert.match(r.text, /permissions: [^\n]*storage/);
    assert.match(r.text, /storage: local 1 key/);
    assert.match(r.text, /messaging log: on/);
    await c.call('navigate', { url: fx.url('/page2.html') });
    r = await c.call('wait_for', { expr: 'document.documentElement.dataset.pong === "42" && document.documentElement.dataset.echo === "7"', timeout_ms: 5000 });
    assert.ok(!r.isError, r.text);
    r = await until(/response/);
    assert.match(r.text, /message content http:\/\/127\.0\.0\.1:\d+\/page2\.html -> extension pages: \{"ping":21\}/);
    assert.match(r.text, /response extension pages -> content [^\n]*\{"pong":42\}/);
    assert.match(r.text, /connect content [^\n]*-> port "chan"/);
    assert.match(r.text, /port content [^\n]*-> port "chan": \{"n":7\}/);
    assert.match(r.text, /content scripts: tab\d+/);
  });

  it('hot reload: startup error reported, fixed, invalid manifest keeps the running version', async () => {
    write('bg.js', BG(`throw new Error('dev fixture startup boom');`));
    let r = await until(/FAILED \(files changed: bg\.js\)/);
    assert.match(r.text, /FAILED \(files changed: bg\.js\)[^\n]*\n\s+[^\n]*dev fixture startup boom/);
    write('bg.js', BG('// fixed'));
    r = await until(/reloaded \(files changed: bg\.js\)/);
    assert.match(r.text, /reloaded \(files changed: bg\.js\)/);
    write('manifest.json', '{ "manifest_version": 2, ');
    r = await until(/manifest is invalid/);
    assert.match(r.text, /FAILED \(files changed: manifest\.json\) in \d+ ms — not reloaded: the manifest is invalid/);
    write('manifest.json', JSON.stringify(MANIFEST, null, 1));
    r = await c.call('ext_dev_load', { path: 'devext' });
    assert.match(r.text, /watching for changes/);
    assert.match(r.text, /reloaded \(ext_dev_load\)/);
  });

  it('ext_dev_build: a zip without node_modules; ext_dev_sign refuses without keys or the user\'s OK', async () => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk', 'big-junk-file.js'), 'x');
    let r = await c.call('ext_dev_build', { path: 'devext' });
    if (HAS_WEB_EXT) {
      assert.ok(!r.isError, r.text);
      const zip = /^built (.+\.zip) \(/.exec(r.text)![1];
      assert.match(zip, /ext-builds[\\/]dev_fixture-1\.0\.zip$/);
      const bytes = fs.readFileSync(zip).toString('latin1');
      assert.ok(bytes.includes('manifest.json') && bytes.includes('bg.js'), 'zip has the extension files');
      assert.ok(!bytes.includes('big-junk-file'), 'node_modules left out');
      assert.match(r.text, /addons-linter: \d+ error\(s\)/);
    } else {
      assert.ok(r.isError, r.text);
      assert.match(r.text, /WEB_EXT_MISSING[\s\S]*npm install -g web-ext/);
    }

    r = await c.call('ext_dev_sign', { path: 'devext', user_said: 'yes' });
    assert.match(r.text, /KEYS_MISSING/);
    const c2 = await startServer({ ...h.env, WEB_EXT_API_KEY: 'fake-key-for-test', WEB_EXT_API_SECRET: 'fake-secret-for-test' });
    try {
      r = await c2.call('ext_dev_sign', { path: 'devext', channel: 'listed' });
      assert.match(r.text, /APPROVAL_NEEDED/);
      assert.match(r.text, /channel "listed" \(PUBLISHED on AMO after review\)/);
      assert.doesNotMatch(r.text, /fake-(key|secret)/);
    } finally { await c2.close(); }
  });
});
