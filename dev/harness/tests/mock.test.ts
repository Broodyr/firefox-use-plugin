// interception: network_mock (fulfill, fail, delay, modify request/response headers, modify body), clear,
// HAR record (masked) -> replay (strict: served from the file with the server gone, unmatched reported; fallthrough).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startServer } from './helpers.ts';

describe('network mocking and HAR', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, base = '';
  const pageEval = async (code: string) => (await c.call('eval', { code })).text.split('\n')[0];
  before(async () => {
    h = makeHome();
    srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/app.html') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=SECRETCOOKIE; HttpOnly' });
        res.end(`<!doctype html><title>App</title><h1 id="h">Original heading</h1><img src="/pixel.png"><script src="/app.js?token=SECRET123"></script>`);
      } else if (u.pathname === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(`fetch('/api/data').then(r => r.json()).then(j => { document.title = 'data ' + j.value; });`);
      } else if (u.pathname === '/api/data') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: 'real' }));
      } else if (u.pathname === '/pixel.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      } else if (u.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-real': 'yes' });
        res.end(JSON.stringify({ test: req.headers['x-test'] ?? null }));
      } else { res.writeHead(404); res.end('nope'); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
    c = await startServer(h.env);
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('fulfill, fail, delay', async () => {
    let r = await c.call('network_mock', { rules: [{ url: '/api/data', action: 'fulfill', headers: { 'content-type': 'application/json' }, body: '{"value":"mocked"}' }] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /m1 \/api\/data -> fulfill 200/);
    await c.call('navigate', { url: `${base}/app.html` });
    r = await c.call('wait_for', { expr: 'document.title === "data mocked"', timeout_ms: 5000 });
    assert.ok(!r.isError, r.text);
    r = await c.call('network_mock', { rules: [{ url: `${base}/echo`, action: 'fail' }, { url: '*/pixel.png*', action: 'delay', ms: 700, times: 1 }] });
    assert.match(r.text, /m2 .*\/echo -> fail/);
    r = await c.call('eval', { code: `fetch('${base}/echo').then(() => 'ok', (e) => 'failed: ' + e.name)` });
    assert.match(r.text, /"failed: TypeError"/);
    const t0 = Date.now();
    await c.call('eval', { code: `fetch('/pixel.png?x').then(r => r.status)` });
    assert.ok(Date.now() - t0 >= 650, `delay took ${Date.now() - t0} ms`);
    r = await c.call('network_mock', {});
    assert.match(r.text, /m1 .* 1 hit\(s\)/);
    assert.match(r.text, /m3 \*\/pixel\.png\* -> delay 700ms \(first 1\) · 1 hit\(s\)/);
    r = await c.call('network_mock_clear', {});
    assert.match(r.text, /removed m1/);
    await c.call('navigate', { url: 'reload' });
    r = await c.call('wait_for', { expr: 'document.title === "data real"', timeout_ms: 5000 });
    assert.ok(!r.isError, r.text);
  });

  it('modify request/response headers and the real body', async () => {
    let r = await c.call('network_mock', { rules: [{ url: '/echo', action: 'modify_headers', request_headers: { 'X-Test': 'added' }, response_headers: { 'x-real': null, 'x-mocked': '1' } }] });
    assert.ok(!r.isError, r.text);
    r = await c.call('eval', { code: `fetch('${base}/echo').then(async (r) => [await r.text(), r.headers.get('x-real'), r.headers.get('x-mocked')])` });
    assert.match(r.text, /"\{\\"test\\":\\"added\\"\}",\s*null,\s*"1"/);
    await c.call('network_mock_clear', {});
    r = await c.call('network_mock', { rules: [{ url: '/echo', action: 'modify_headers', request_headers: { 'X-Test': 'only-request' } }] });
    r = await c.call('eval', { code: `fetch('${base}/echo').then((r) => r.text())` });
    assert.match(r.text, /only-request/);
    await c.call('network_mock_clear', {});
    await c.call('network_mock', { rules: [{ url: '/app.html', action: 'modify_body', replace: [['Original heading', 'Patched heading']] }] });
    await c.call('navigate', { url: `${base}/app.html` });
    assert.match(await pageEval('document.getElementById("h").textContent'), /"Patched heading"/);
    await c.call('network_mock_clear', {});
  });

  it('HAR: record (masked), replay strict with the server gone, unmatched reported', async () => {
    let r = await c.call('har_record', { name: 'app', url: `${base}/app.html` });
    assert.ok(!r.isError, r.text);
    await c.call('wait_for', { expr: 'document.title === "data real"', timeout_ms: 5000 });
    r = await c.call('har_stop', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /wrote tests\/fixtures\/app\.har: \d+ request\(s\)/);
    const file = path.join(h.workspace, 'tests', 'fixtures', 'app.har');
    const text = fs.readFileSync(file, 'utf8');
    if (process.env.HAR_DEBUG) console.log(JSON.parse(text).log.entries.map((e: any) => [e.request.method, e.request.url, e.response.status, e.response.content.text?.length, e._bodyMissing].join(' ')).join('\n'));
    const har = JSON.parse(text);
    assert.ok(!text.includes('SECRETCOOKIE') && !text.includes('SECRET123'), 'cookies and token params are masked');
    const urls = har.log.entries.map((e: any) => e.request.url);
    assert.ok(urls.some((u: string) => u.endsWith('/api/data')), urls.join(' '));
    assert.ok(har.log.entries.some((e: any) => e.response.content.encoding === 'base64'), 'binary bodies as base64');
    // the server goes away: everything must come from the HAR
    await new Promise<void>((res) => srv.close(() => res()));
    srv.closeAllConnections?.();
    r = await c.call('har_replay', { name: 'app', mode: 'strict' });
    assert.match(r.text, /replaying tests\/fixtures\/app\.har \(\d+ entries, strict\)/);
    await c.call('navigate', { url: 'about:blank' });
    await c.call('navigate', { url: `${base}/app.html` });
    r = await c.call('wait_for', { expr: 'document.title === "data real"', timeout_ms: 5000 });
    assert.ok(!r.isError, r.text);
    assert.match(await pageEval('document.querySelector("img").naturalWidth'), /1/);
    r = await c.call('eval', { code: `fetch('/not-recorded').then(() => 'ok', () => 'failed')` });
    assert.match(r.text, /"failed"/);
    r = await c.call('har_replay_stop', {});
    assert.match(r.text, /stopped replaying app: \d+ served, 0 passed through, 1 unmatched/);
    assert.match(r.text, /GET http:\/\/127\.0\.0\.1:\d+\/not-recorded/);
  });
});
