// waits: selector, text, console, network idle, navigation (incl. pushState), request, generic; timeouts report state.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

describe('waits', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('wait_for_selector (attached, visible, detached) and timeout context', async () => {
    await c.call('navigate', { url: fx.url('/dynamic.html') });
    let r = await c.call('wait_for_selector', { selector: 'button:nth-of-type(2)', timeout_ms: 400 });
    assert.ok(r.isError);
    assert.match(r.text, /TIMEOUT[\s\S]*matches: 0[\s\S]*page: Dynamic/);
    await c.call('eval', { code: 'setTimeout(() => document.querySelector("button").click(), 200); 1' });
    r = await c.call('wait_for_selector', { selector: 'button:nth-of-type(2)', state: 'visible' });
    assert.match(r.text, /visible after \d+ ms \(1 match\)\n<button>Added<\/button>/);
    await c.call('eval', { code: 'setTimeout(() => document.querySelectorAll("button")[1].remove(), 150); 1' });
    r = await c.call('wait_for_selector', { selector: 'button:nth-of-type(2)', state: 'detached' });
    assert.match(r.text, /detached after/);
  });

  it('wait_for_text, wait_for_console, wait_for (generic)', async () => {
    await c.call('navigate', { url: fx.url('/dynamic.html') });
    await c.call('eval', { code: 'setTimeout(() => { document.body.append("Done loading"); console.info("phase two"); window.ready = 42; }, 200); 1' });
    let r = await c.call('wait_for_text', { text: '/done\\s+load/i' });
    assert.match(r.text, /found "Done load"/);
    r = await c.call('wait_for_console', { pattern: 'phase two', since: 'c0' });
    assert.match(r.text, /INFO  \[page tab1\] phase two/);
    r = await c.call('wait_for', { expr: 'window.ready' });
    assert.match(r.text, /truthy after \d+ ms: 42/);
    r = await c.call('wait_for', { expr: 'window.never', timeout_ms: 300 });
    assert.match(r.text, /TIMEOUT[\s\S]*lastValue/);
    r = await c.call('wait_for_console', { pattern: 'nothing like this', timeout_ms: 300 });
    assert.match(r.text, /TIMEOUT/);
  });

  it('wait_for_navigation: in-page pushState and full navigation; wait_for_request; wait_for_network_idle', async () => {
    await c.call('navigate', { url: fx.url('/dynamic.html') });
    await c.call('eval', { code: 'setTimeout(() => history.pushState({}, "", "/spa-route"), 150); 1' });
    let r = await c.call('wait_for_navigation', { url_pattern: 'spa-route' });
    assert.match(r.text, /navigated to http:\/\/127\.0\.0\.1:\d+\/spa-route \(in-page\)/);
    await c.call('eval', { code: 'setTimeout(() => { location.href = "/page2.html"; }, 150); 1' });
    r = await c.call('wait_for_navigation', {});
    assert.match(r.text, /navigated to http:\/\/127\.0\.0\.1:\d+\/page2\.html after/);
    assert.doesNotMatch(r.text, /in-page/);
    await c.call('navigate', { url: fx.url('/idle.html'), wait: 'none' });
    r = await c.call('wait_for_request', { url_pattern: '/slow', since: 'r0' });
    assert.match(r.text, /GET 200 plain .*\/slow/);
    r = await c.call('wait_for_network_idle', { idle_ms: 300 });
    assert.match(r.text, /network idle/);
  });
});
