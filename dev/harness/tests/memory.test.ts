// memory bounds: request actors released when they leave the ring, console object grips released after
// formatting, process memory reported; a few hundred page loads stay bounded.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

describe('devtools memory bounds', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer({ ...h.env, FIREFOX_USE_NET_RING: '40' }); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  // resident memory after a GC/CC in every process (raw RSS mostly measures garbage not yet collected)
  const MEM = `return await new Promise((resolve) => {
    const mgr = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);
    mgr.minimizeMemoryUsage(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const i = await ChromeUtils.requestProcInfo();
      resolve(Math.round((i.memory + i.children.reduce((n, c) => n + c.memory, 0)) / 1048576));
    });
  });`;
  const memNow = async () => Number(/\(number\) (\d+)/.exec((await c.call('eval_privileged', { code: MEM })).text)![1]);

  it('releases request actors and object grips; memory stays bounded over 300 loads', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    let r = await c.call('ff_status', { detail: 'normal' });
    const m0 = await memNow();
    assert.match(r.text, /devtools hub: \d+ log entries, \d+ requests kept \(bodies ≤ 256 kB each\)/);
    const first = /^(\S+ )?(r\d+) /m.exec((await c.call('network_read', { limit: 1 })).text);
    for (let i = 0; i < 300; i++) {
      await c.call('navigate', { url: fx.url(`/page2.html?i=${i}`), wait: 'load' });
      if (i % 50 === 0) { await c.call('eval', { code: `console.log("load ${i}", { i: ${i}, list: [1, 2, 3] }, document); 1` }); await new Promise((res) => setTimeout(res, 400)); }
    }
    await new Promise((res) => setTimeout(res, 1500)); // grip batches flush every second
    r = await c.call('ff_status', { detail: 'normal' });
    const released = /released (\d+) request actors, (\d+) object grips/.exec(r.text)!;
    assert.ok(Number(released[1]) >= 250, `request actors released: ${r.text}`);
    assert.ok(Number(released[2]) >= 6, `object grips released: ${r.text}`);
    assert.match(r.text, /devtools hub: \d+ log entries, 40 requests kept/);
    const m1 = await memNow();
    console.log(`memory after 300 loads: ${m0} MB -> ${m1} MB`);
    assert.ok(m1 - m0 < 300, `memory grew by ${m1 - m0} MB`);
    if (first) {
      r = await c.call('network_body', { request_id: first[2] });
      assert.match(r.text, /REQUEST_NOT_FOUND|released|unavailable/, 'old entries are gone from the ring');
    }
    const last = /(r\d+) GET 200/.exec((await c.call('network_read', { filter: 'i=299' })).text)!;
    r = await c.call('network_body', { request_id: last[1] });
    assert.match(r.text, /Page two/, 'recent bodies still readable');
  });
});
