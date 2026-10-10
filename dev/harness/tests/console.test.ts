// unified console and network reading: console_read / console_clear / errors_summary,
// network_read / network_body / headers_inspect (incl. extension-made requests).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, installTestExt, makeHome, startFixtures, startServer } from './helpers.ts';

describe('console and network', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); await installTestExt(c, h.workspace); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('console_read: page logs, collapsed repeats, warnings, uncaught errors and rejections with stacks', async () => {
    await c.call('navigate', { url: fx.url('/errors.html') });
    await c.call('wait_for_console', { pattern: 'fixture uncaught', since: 'c0' });
    let r = await c.call('console_read', { pattern: '/fixture|repeated/' });
    assert.match(r.text, /LOG   \[page tab1\] repeated line \(http:\/\/127\.0\.0\.1:\d+\/errors\.html:\d+:\d+\) ×3/);
    assert.match(r.text, /WARN  \[page tab1\] fixture warning/);
    assert.match(r.text, /ERROR \[page tab1\] rejection Uncaught \(in promise\) Error: fixture rejection/);
    assert.match(r.text, /ERROR \[page tab1\] error TypeError: fixture uncaught/);
    r = await c.call('console_read', { level: 'error', sources: ['page'], detail: 'normal' });
    assert.doesNotMatch(r.text, /repeated line|fixture warning/);
    assert.match(r.text, /at .*errors\.html/);
    const cursor = /cursor: (c\d+)/.exec(r.text)![1];
    r = await c.call('console_read', { since: cursor });
    assert.match(r.text, /no matching console entries/);
  });

  it('console_read: content-script and extension background realms; errors_summary; console_clear', async () => {
    await c.call('navigate', { url: fx.url('/page2.html?cserror') });
    await c.call('ext_message', { extension: 'test-ext', message: { cmd: 'throw' }, writes: false });
    await c.call('ext_message', { extension: 'test-ext', message: { cmd: 'log', value: 'hello from bg' }, writes: false });
    await c.call('wait_for_console', { pattern: 'background boom', since: 'c0' });
    const w = await c.call('wait_for_console', { pattern: 'content boom', since: 'c0', timeout_ms: 5000 });
    assert.ok(!w.isError, w.text);
    // console capture is asynchronous (devtools events): wait for every entry asserted below, not just the errors
    for (const pattern of ['bg says hello from bg', 'content script on /page2']) {
      const x = await c.call('wait_for_console', { pattern, since: 'c0', timeout_ms: 5000 });
      assert.ok(!x.isError, x.text);
    }
    let r = await c.call('console_read', { realm: 'test extension' });
    assert.match(r.text, /\[content:firefox-use test extension tab1\] test-ext content script on \/page2\.html \(ext:\/cs\.js:2:\d+\)/);
    assert.match(r.text, /ERROR \[content:firefox-use test extension tab1\] error Error: test-ext content boom/);
    assert.match(r.text, /WARN  \[extension:firefox-use test extension\] test-ext bg says hello from bg/);
    assert.match(r.text, /ERROR \[extension:firefox-use test extension\] error Error: test-ext background boom \(ext:\/bg\.js:\d+:\d+\)/);
    r = await c.call('errors_summary', {});
    assert.match(r.text, /×1 \[content:firefox-use test extension\] error: Error: test-ext content boom/);
    assert.match(r.text, /×1 \[extension:firefox-use test extension\] error: Error: test-ext background boom/);
    assert.match(r.text, /first \d\d:\d\d:\d\d\.\d{3} · last/);
    await c.call('console_clear', {});
    r = await c.call('console_read', {});
    assert.match(r.text, /no matching console entries/);
    r = await c.call('errors_summary', {});
    assert.match(r.text, /no errors/);
  });

  it('network_read: page and extension-made requests with initiators; network_body; masking', async () => {
    await c.call('navigate', { url: fx.url('/idle.html'), wait: 'networkidle' });
    // make the extension fetch (its background fetches fetchUrl when it changes)
    await c.call('ext_storage_set', { extension: 'test-ext', items: { fetchUrl: fx.url('/text.html?token=SHHH&from=ext') } });
    await c.call('wait_for_request', { url_pattern: 'from=ext', since: 'r0' });
    let r = await c.call('network_read', {});
    assert.match(r.text, /r\d+ GET 200 html \S+ \d+ms \[page tab1 nav\] http:\/\/127\.0\.0\.1:\d+\/idle\.html/);
    assert.match(r.text, /r\d+ GET 200 plain \S+ \d+ms \[page tab1 fetch\] http:\/\/127\.0\.0\.1:\d+\/slow/);
    assert.match(r.text, /\[ext:firefox-use test extension fetch\] http:\/\/127\.0\.0\.1:\d+\/text\.html\?token=<masked>&from=ext/);
    assert.doesNotMatch(r.text, /SHHH/);
    r = await c.call('network_read', { initiator: 'page', filter: '/slow' });
    assert.equal(r.text.split('\n').filter((l) => /^\d/.test(l)).length, 1, r.text);
    r = await c.call('network_read', { initiator: 'extension' });
    assert.doesNotMatch(r.text, /\[page/);
    const id = /(r\d+) GET 200 html \S+ \S+ \[ext:/.exec(r.text)![1];
    r = await c.call('network_body', { request_id: id });
    assert.match(r.text, /Body paragraph one/);
    assert.match(r.text, /Bearer <masked>/);
    r = await c.call('network_body', { request_id: id, unmask: ['authorization'] });
    assert.match(r.text, /Bearer abcdefghijklmnopqrstuv/);
    r = await c.call('network_read', { filter: 'from=ext', unmask: ['token'] });
    assert.match(r.text, /token=SHHH/);
    r = await c.call('network_read', { status: '4xx' });
    assert.match(r.text, /404/);
    r = await c.call('network_body', { request_id: 'r99999' });
    assert.match(r.text, /REQUEST_NOT_FOUND/);
  });

  it('headers_inspect: headers (cookies masked) and CSP verdicts', async () => {
    await c.call('navigate', { url: fx.url('/csp.html') });
    let r = await c.call('headers_inspect', { target: 'csp.html' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /set-cookie: <masked>/i);
    assert.doesNotMatch(r.text, /SECRETCOOKIE123/);
    assert.match(r.text, /CSP policy 1: default-src 'self'; script-src 'self' 'nonce-abc' 'unsafe-inline'/);
    assert.match(r.text, /BLOCKED: inline <script> \(by script-src\)/, 'a nonce disables unsafe-inline');
    assert.match(r.text, /BLOCKED: eval \/ new Function/);
    assert.match(r.text, /allowed: <style> element/);
    assert.match(r.text, /BLOCKED: fetch to http:\/\/127\.0\.0\.1 \(resource server\) \(by connect-src\)/);
    r = await c.call('headers_inspect', { target: 'csp.html', unmask: ['set-cookie'] });
    assert.match(r.text, /SECRETCOOKIE123/);
    await c.call('navigate', { url: fx.url('/page2.html') });
    r = await c.call('headers_inspect', { target: 'page2.html' });
    assert.match(r.text, /CSP: none/);
  });
});
