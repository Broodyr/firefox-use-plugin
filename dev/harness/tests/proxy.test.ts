// hot-reload proxy: rebuild picked up live (list_changed), failed build keeps the last good backend,
// crashed backend is replaced and reattaches to the same Firefox, ff_dev_status / ff_dev_call, harness pipe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, PAGES, ROOT, liveUrl, makeHome, raw, sse, startFixtures } from './helpers.ts';

PAGES['/bp.html'] = `<!doctype html><title>bp</title><button id="b">Hit</button><script>
function hit() {
  document.title = 'hit';
}
document.getElementById('b').addEventListener('click', hit);
</script>`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hot-reload proxy', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  let root: string, entry: string, goodEntry: string;
  let stampN = 0;
  const stamp = () => fs.writeFileSync(path.join(root, 'server', 'dist', '.build-stamp'), JSON.stringify({ hash: `test${++stampN}`, builtAt: new Date().toISOString() }));
  const status = async () => JSON.parse((await c.call('ff_dev_status', {})).text);

  before(async () => {
    h = makeHome();
    fx = await startFixtures();
    // private copy of the build so the test can "rebuild" without touching server/dist
    root = path.join(path.dirname(h.home), 'root');
    fs.cpSync(path.join(ROOT, 'server', 'dist'), path.join(root, 'server', 'dist'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'setup'), path.join(root, 'setup'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    fs.mkdirSync(path.join(root, 'server', 'src')); // a source checkout: the proxy lists its dev tools
    entry = path.join(root, 'server', 'dist', 'index.js');
    goodEntry = fs.readFileSync(entry, 'utf8');
    c = McpClient.spawnProxy(['--profile-mode=throwaway', '--headless'], { ...h.env, FIREFOX_USE_ROOT: root });
    await c.initialize();
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('lists backend tools plus ff_dev_status / ff_dev_call', async () => {
    const names = (await c.listTools()).map((t) => t.name);
    assert.ok(names.includes('navigate'));
    assert.ok(names.includes('ff_dev_status'));
    assert.ok(names.includes('ff_dev_call'));
    const r = await c.call('navigate', { url: fx.url('/page2.html') });
    assert.match(r.text, /Page two/, r.text);
  });

  it('rebuild: new tool appears via list_changed, browser state kept', async () => {
    const pid0 = (await status()).backend.pid;
    fs.writeFileSync(entry, goodEntry.replace(/const TOOLS = \[([^\]]*)\];/, "const TOOLS = [$1, { name: 'zz_probe', description: 'probe', schema: z.object({}), handler: async () => 'probe ok' }];"));
    stamp();
    await c.waitNotification('notifications/tools/list_changed', 30000);
    const st = await status();
    assert.notEqual(st.backend.pid, pid0);
    assert.equal(st.reloads, 1);
    assert.ok((await c.listTools()).some((t) => t.name === 'zz_probe'));
    assert.match((await c.call('zz_probe', {})).text, /probe ok/);
    assert.match((await c.call('tabs_list', {})).text, /^\* tab 1: "Page two"/m, 'same Firefox, same tab, same handle');
    // BiDi context ids change with every BiDi session; handles must still work for acting, not just listing
    const nav = await c.call('navigate', { url: fx.url('/form.html') });
    assert.ok(!nav.isError, nav.text);
    assert.match((await c.call('navigate', { url: fx.url('/page2.html'), tab: 1 })).text, /Page two/);
  });

  it('rebuild: a breakpoint survives the reload and still pauses', async () => {
    await c.call('navigate', { url: fx.url('/bp.html') });
    let r = await c.call('bp_set', { location: { url: 'bp.html', line: 3 } });
    assert.match(r.text, /set bp1 /, r.text);
    const pid0 = (await status()).backend.pid;
    stamp();
    await c.waitNotification('notifications/tools/list_changed', 30000);
    assert.notEqual((await status()).backend.pid, pid0);
    const page = await c.call('read_page', {});
    assert.match(page.text, /note: debugger: re-applied 1 breakpoint\(s\) after a backend reload/, page.text);
    r = await c.call('click', { target: /\[(ref_\d+)\] button "Hit"/.exec(page.text)![1] });
    assert.match(r.text, /^PAUSED during click: paused \(breakpoint bp1\) in hit at http:\/\/127\.0\.0\.1:\d+\/bp\.html:3/, r.text);
    await c.call('resume', {});
    await c.call('bp_remove', { id: 'all' });
    await c.call('navigate', { url: fx.url('/page2.html') }); // the steps below expect it
  });

  it('rebuild: the live view URL keeps working (same port and token) and the page gets frames again', async () => {
    const url = liveUrl((await c.call('ff_live_view', { action: 'open' })).text);
    let s = sse(url + 'events');
    await s.next('frame');
    const pid0 = (await status()).backend.pid;
    stamp();
    await c.waitNotification('notifications/tools/list_changed', 30000);
    assert.notEqual((await status()).backend.pid, pid0);
    // the old backend dropped the stream; the page reconnects (EventSource retry) to the same URL
    for (let i = 0; i < 50 && !s.ended; i++) await sleep(100);
    assert.ok(s.ended, 'the old backend closed the stream');
    // and retries until the new backend listens (it waits for the old one to let go of the port)
    for (let i = 0; i < 50; i++) {
      s = sse(url + 'events');
      try { await s.next('hello', () => true, 2000); break; } catch { s.close(); await sleep(200); }
    }
    try {
      await s.next('hello');
      const n0 = s.events.length;
      await c.call('navigate', { url: fx.url('/form.html') });
      const f = await s.next('frame', (d) => /form\.html/.test(d.url), 10000, n0);
      assert.equal((await raw(url + 'frame?seq=' + f.seq)).status, 200);
      assert.match((await c.call('ff_status', {})).text, new RegExp(`live view: ${url.replace(/[.?]/g, '\\$&')}`));
    } finally { s.close(); }
    await c.call('ff_live_view', { action: 'close' });
    await c.call('navigate', { url: fx.url('/page2.html') }); // the steps below expect it
  });

  it('broken build keeps the last good backend and reports the error', async () => {
    const pid0 = (await status()).backend.pid;
    fs.writeFileSync(entry, 'this is not javascript (');
    stamp();
    for (let i = 0; i < 100 && !(await status()).lastError; i++) await sleep(200);
    const st = await status();
    assert.match(st.lastError, /reload failed/);
    assert.equal(st.backend.pid, pid0);
    assert.match((await c.call('tabs_list', {})).text, /Page two/);
  });

  it('a fixed build loads again', async () => {
    fs.writeFileSync(entry, goodEntry);
    stamp();
    await c.waitNotification('notifications/tools/list_changed', 30000);
    assert.equal((await status()).lastError, null);
  });

  it('crashed backend is replaced and reattaches to the same Firefox (orphaned BiDi session cleared)', async () => {
    const pid0 = (await status()).backend.pid;
    process.kill(pid0);
    let r;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const st = await status();
      if (st.backend?.pid && st.backend.pid !== pid0 && st.backendReady) break;
    }
    const st = await status();
    assert.notEqual(st.backend.pid, pid0);
    assert.equal(st.crashes, 1);
    r = await c.call('tabs_list', {});
    assert.match(r.text, /^\* tab 1: "Page two"/m, r.text);
    r = await c.call('navigate', { url: 'reload' });
    assert.ok(!r.isError, r.text);
  });

  it('ff_dev_call forwards by name', async () => {
    const r = await c.call('ff_dev_call', { tool: 'tabs_list', args: {} });
    assert.match(r.text, /Page two/);
  });

  it('harness pipe: token-authenticated access through the running backend', async () => {
    const st = await status();
    const token = fs.readFileSync(path.join(h.home, 'token'), 'utf8').trim();
    await assert.rejects(McpClient.connectPipe(st.pipe, 'wrong-token'));
    const p = await McpClient.connectPipe(st.pipe, token);
    await p.initialize();
    const r = await p.call('tabs_list', {});
    assert.match(r.text, /Page two/);
    await p.close();
  });

  it('release install (no server/src): dev tools unlisted but still answer', async () => {
    const rel = path.join(path.dirname(h.home), 'release-root');
    fs.mkdirSync(path.join(rel, 'server'), { recursive: true });
    for (const d of ['server/dist', 'setup', 'node_modules']) fs.symlinkSync(path.join(root, d), path.join(rel, d), 'junction');
    const r = McpClient.spawnProxy(['--profile-mode=throwaway', '--headless'], { ...h.env, FIREFOX_USE_ROOT: rel });
    try {
      await r.initialize();
      const names = (await r.listTools()).map((t) => t.name);
      assert.ok(names.includes('navigate'));
      assert.ok(!names.some((n) => n.startsWith('ff_dev_')), names.join(','));
      assert.equal(JSON.parse((await r.call('ff_dev_status', {})).text).devCheckout, false);
    } finally { await r.close(); }
  });
});
