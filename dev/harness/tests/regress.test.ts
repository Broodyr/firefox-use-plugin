// regression tests: test_record (HAR + suggested test file) -> test_run in a fresh throwaway profile with
// the HAR replayed and the server gone (PASS) -> a broken userscript (FAIL with assertion context + screenshot);
// visual_diff.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startServer } from './helpers.ts';

describe('regression tests', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, base = '', port = '';
  const script = (ok: boolean) => `// ==UserScript==
// @name        rt-banner
// @namespace   cf-test
// @match       http://127.0.0.1:${port}/*
// @grant       none
// @inject-into content
// ==/UserScript==
__claude.mark('rt-start');
const b = document.querySelector('.banner');
if (b) b.remove();
document.documentElement.dataset.rt = ${ok ? "'cleaned'" : "'broken'"};
__claude.mark('rt-done');
`;
  before(async () => {
    h = makeHome();
    srv = http.createServer((req, res) => {
      if (req.url?.startsWith('/site.html')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Site</title><h1>Welcome</h1><div class="banner">Buy!</div><script src="/site.js"></script>'); }
      else if (req.url?.startsWith('/site.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('document.title = "Site ready";'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = String((srv.address() as any).port);
    base = `http://127.0.0.1:${port}`;
    c = await startServer(h.env);
    fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'rt.user.js'), script(true));
    const r = await c.call('us_install', { path: 'scripts/rt.user.js' });
    assert.ok(!r.isError, r.text);
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('test_record writes a HAR and a test file with suggested assertions', async () => {
    const r = await c.call('test_record', { name: 'site', url: `${base}/site.html`, steps: [{ wait_for_selector: 'html[data-rt]' }], userscripts: ['scripts/rt.user.js'] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /wrote tests\/site\.test\.json/);
    const t = JSON.parse(fs.readFileSync(path.join(h.workspace, 'tests', 'site.test.json'), 'utf8'));
    assert.equal(t.fixtures.har, 'site');
    assert.deepEqual(t.setup.userscripts, ['scripts/rt.user.js']);
    const asserts = JSON.stringify(t.cases[0].assert);
    assert.match(asserts, /"equals":"Site ready"/);
    assert.match(asserts, /"text":"Welcome"/);
    assert.match(asserts, /"order":\["mark:rt-start","mark:rt-done"\]/);
    assert.match(asserts, /"console":\{"level":"error","count":0\}/);
    // add a check of the userscript's effect
    t.cases[0].assert.push({ selector: '.banner', state: 'absent' }, { expr: 'document.documentElement.dataset.rt', equals: 'cleaned' }, { expr: '!b.isConnected', realm: { kind: 'userscript', script: 'rt-banner' } });
    fs.writeFileSync(path.join(h.workspace, 'tests', 'site.test.json'), JSON.stringify(t, null, 2));
    assert.ok(fs.existsSync(path.join(h.workspace, 'tests', 'fixtures', 'site.har')));
  });

  it('test_run: passes from the HAR with the server gone; a regression fails with context', async () => {
    await new Promise<void>((res) => srv.close(() => res()));
    srv.closeAllConnections?.();
    let r = await c.call('test_run', { names: ['site'] }, 300000);
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^1\/1 test file\(s\) passed/, r.text);
    assert.match(r.text, /✔ document\.documentElement\.dataset\.rt/);
    assert.match(r.text, /✔ order mark:rt-start < mark:rt-done/);
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'rt.user.js'), script(false));
    r = await c.call('test_run', { names: ['site'] }, 300000);
    assert.match(r.text, /^0\/1 test file\(s\) passed/, r.text);
    assert.match(r.text, /✖ document\.documentElement\.dataset\.rt → "broken" \(expected "cleaned"\)/);
    assert.match(r.text, /screenshot: \.firefox-use[\\/]artifacts[\\/]test-site-1-\d+\.png/);
  });

  it('visual_diff', async () => {
    const dir = path.join(h.workspace, '.firefox-use', 'artifacts');
    const shots = fs.readdirSync(dir).filter((f) => f.startsWith('test-site-')).map((f) => path.join('.firefox-use', 'artifacts', f));
    let r = await c.call('visual_diff', { a: shots[0], b: shots[0] });
    assert.match(r.text, /^0\.00% changed/);
    await c.call('navigate', { url: 'data:text/html,<body style="background:white"><h1>One</h1>' });
    await c.call('screenshot', {});
    await c.call('navigate', { url: 'data:text/html,<body style="background:white"><h1>Two two two</h1>' });
    await c.call('screenshot', {});
    const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png') && !f.startsWith('test-') && !f.startsWith('diff-')).map((f) => path.join(dir, f)).sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs).slice(-2);
    r = await c.call('visual_diff', { a: path.relative(h.workspace, pngs[0]), b: path.relative(h.workspace, pngs[1]) });
    assert.ok(!r.isError, r.text);
    const pct = Number(/^([\d.]+)% changed/.exec(r.text)?.[1]);
    assert.ok(pct > 0 && pct < 20, r.text);
    assert.equal(r.images.length, 1);
  });
});
