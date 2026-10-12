// Live view (SPEC §6.23): a page on 127.0.0.1 per session with the current tab as frames, tool calls, pointer events
// and tabs over Server-Sent Events, and Take over. Who can reach it (token, Host, Sec-Fetch-Site, the control header),
// that nothing is captured without a viewer, and that close / ff_kill end it. Headless: Take over runs through the
// test hook FIREFOX_USE_TEST_TAKEOVER (no window to show); without it, it is refused with its reason.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, NAMED_ARGS, liveUrl, makeHome, namedProfile, raw, refFor, sse, startFixtures } from './helpers.ts';

const post = (url: string, headers: Record<string, string> = { 'x-live-view': '1', 'sec-fetch-site': 'same-origin' }, body = '{}') => raw(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

const urlOf = liveUrl;
const jpegSize = (b: Buffer) => { for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc3) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }; i += 2 + b.readUInt16BE(i + 2); } return null; };
const frames = async (c: McpClient) => Number(/(\d+) frame\(s\)/.exec((await c.call('ff_live_view', { action: 'status' })).text)![1]);

describe('live view', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>, url: string;
  before(async () => {
    h = makeHome(); fx = await startFixtures();
    c = McpClient.spawnServer(['--profile-mode=throwaway', '--headless'], { ...h.env, FIREFOX_USE_TEST_TAKEOVER: '1' });
    await c.initialize();
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('open returns a URL; the page is served only with the token, our Host and from the page itself', async () => {
    const r = await c.call('ff_live_view', { action: 'open' });
    assert.ok(!r.isError, r.text);
    url = urlOf(r.text);
    assert.match(r.text, /built-in browser pane/);
    const page = await raw(url);
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /script-src 'nonce-[^']+'; .*connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS');
    assert.match(page.body.toString(), /<title>Claude live view<\/title>/);
    const port = new URL(url).port;
    assert.equal((await raw(url.replace(/[0-9a-f]{32}/, '0'.repeat(32)))).status, 404, 'wrong token');
    assert.equal((await raw(`http://127.0.0.1:${port}/`)).status, 404);
    assert.equal((await raw(url, { headers: { host: `evil.example:${port}` } })).status, 404, 'DNS rebinding');
    assert.equal((await raw(url, { headers: { host: `localhost:${port}` } })).status, 200);
    assert.equal((await raw(url + 'events', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 404, 'cross-site stream');
    assert.equal((await raw(url + 'frame', { headers: { 'sec-fetch-site': 'same-site' } })).status, 404, 'same-site is not same-origin');
    assert.equal((await raw(url.slice(0, -1))).status, 302);
    assert.match((await c.call('ff_status', {})).text, /live view: http:\/\/127\.0\.0\.1:\d+\/live\/[0-9a-f]{32}\/ · 0 viewer\(s\)/);
  });

  it('no viewer: tool calls make zero captures', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    await c.call('click', { target: { x: 10, y: 10 }, coords: 'viewport' });
    assert.equal(await frames(c), 0);
  });

  it('with a viewer: a navigate produces a frame of the viewport, tool events in order, a click its pointer event', async () => {
    const s = sse(url + 'events');
    try {
      await s.next('hello');
      await s.next('state');
      const n0 = s.events.length;
      let r = await c.call('navigate', { url: fx.url('/form.html') });
      assert.ok(!r.isError, r.text);
      const f = await s.next('frame', (d) => /form\.html/.test(d.url), 10000, n0);
      assert.equal(f.title, 'Form fixture');
      const img = await raw(url + 'frame?seq=' + f.seq);
      assert.equal(img.status, 200);
      assert.equal(img.headers['content-type'], 'image/jpeg');
      const dims = jpegSize(img.body)!;
      const vp = JSON.parse(/\{[\s\S]*\}/.exec((await c.call('eval', { code: '({ w: innerWidth, h: innerHeight })' })).text)![0]);
      assert.deepEqual(dims, { w: vp.w, h: vp.h }, 'a JPEG of the viewport\'s size');
      assert.deepEqual({ w: f.cssW, h: f.cssH }, { w: vp.w, h: vp.h });
      const tools = s.events.slice(n0).filter((e) => e.type === 'tool').map((e) => `${e.data.name}:${e.data.phase}`);
      assert.deepEqual(tools.slice(0, 2), ['navigate:start', 'navigate:end']);
      assert.ok(s.events.slice(n0).some((e) => e.type === 'tool' && e.data.name === 'navigate' && /form\.html/.test(e.data.target)));
      const n1 = s.events.length;
      r = await c.call('click', { target: { x: 120, y: 60 }, coords: 'viewport' });
      assert.ok(!r.isError, r.text);
      const p = await s.next('pointer', () => true, 5000, n1);
      assert.deepEqual({ kind: p.kind, x: p.x, y: p.y }, { kind: 'click', x: 120, y: 60 });
      // typing marks the focused box, never the text
      const ref = refFor((await c.call('read_page', {})).text, 'textbox', 'Name');
      const n2 = s.events.length;
      await c.call('type', { ref, text: 'zzsecretzz' });
      const t = await s.next('pointer', (d) => d.kind === 'type', 5000, n2);
      assert.ok(t.w > 0 && t.h > 0);
      assert.doesNotMatch(JSON.stringify(s.events.slice(n2)), /zzsecretzz/);
      await s.next('tabs', (d) => d.tabs.some((t: any) => t.current && /form\.html/.test(t.url)));
      assert.ok(await frames(c) >= 1);
      assert.match((await c.call('ff_live_view', { action: 'status' })).text, /1 viewer\(s\)/);
    } finally { s.close(); }
    // the viewer left: nothing is captured any more
    await new Promise((r) => setTimeout(r, 300));
    const n = await frames(c);
    await c.call('navigate', { url: fx.url('/page2.html') });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await frames(c), n);
  });

  it('an extension page gets a placeholder (Firefox does not capture privileged pages)', async () => {
    const s = sse(url + 'events');
    try {
      await s.next('state');
      await c.call('navigate', { url: 'about:robots' });
      const p = await s.next('placeholder', (d) => /about:robots/.test(d.url), 8000);
      assert.match(p.reason, /does not capture/);
    } finally { s.close(); }
  });

  it('Take over: refused without the header, with a wrong token or cross-site; then the next write call is HANDED_OFF naming the live view', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const bad = url.replace(/[0-9a-f]{32}/, 'f'.repeat(32));
    assert.equal((await post(url + 'takeover', { 'sec-fetch-site': 'same-origin' })).status, 404, 'no X-Live-View header');
    assert.equal((await post(bad + 'takeover')).status, 404, 'wrong token');
    assert.equal((await post(url + 'takeover', { 'x-live-view': '1', 'sec-fetch-site': 'cross-site' })).status, 404, 'cross-site');
    assert.equal((await raw(url + 'takeover', { headers: { 'x-live-view': '1' } })).status, 404, 'GET');
    let r = await c.call('click', { target: { x: 5, y: 5 }, coords: 'viewport' });
    assert.ok(!r.isError, 'nothing changed: ' + r.text);

    const s = sse(url + 'events');
    try {
      await s.next('state');
      const n0 = s.events.length;
      const t = await post(url + 'takeover');
      assert.equal(t.status, 200, t.body.toString());
      await s.next('state', (d) => d.state === 'handed-off', 5000, n0);
      // a read call says so once; the next write call fails
      r = await c.call('tabs', { op: 'list' });
      assert.match(r.text, /note: HANDED_OFF: the user took over from the live view at \d\d:\d\d:\d\d on tab \d+/);
      r = await c.call('click', { target: { x: 5, y: 5 }, coords: 'viewport' });
      assert.ok(r.isError);
      assert.match(r.text, /HANDED_OFF\nthe user took over from the live view at \d\d:\d\d:\d\d on tab \d+; ask them what they want, and call ff_handback/);
      assert.match((await c.call('ff_status', {})).text, /HANDED OFF since .* the user took over from the live view/);
      const audit = (await c.call('ff_audit_show', { tool: 'live_view_takeover' })).text;
      assert.match(audit, /live_view_takeover ok/);
      const n1 = s.events.length;
      r = await c.call('ff_handback', {});
      assert.ok(!r.isError, r.text);
      await s.next('state', (d) => d.state !== 'handed-off', 5000, n1);
      r = await c.call('click', { target: { x: 5, y: 5 }, coords: 'viewport' });
      assert.ok(!r.isError, r.text);
    } finally { s.close(); }
  });

  it('Show window / Run in background are refused headless with the reason', async () => {
    const r = await post(url + 'window', undefined, JSON.stringify({ action: 'show' }));
    assert.equal(r.status, 409);
    assert.match(r.body.toString(), /headless/);
  });

  it('close ends the stream (state: stopped) and the URL stops working', async () => {
    const s = sse(url + 'events');
    await s.next('state');
    const r = await c.call('ff_live_view', { action: 'close' });
    assert.match(r.text, /closed/);
    await s.next('state', (d) => d.state === 'stopped');
    assert.equal((await raw(url)).status, 404);
    assert.doesNotMatch((await c.call('ff_status', {})).text, /live view:/);
  });

  it('ff_kill stops an open view', async () => {
    const u = urlOf((await c.call('ff_live_view', { action: 'open' })).text);
    const s = sse(u + 'events');
    await s.next('state');
    await c.call('ff_kill', {});
    await s.next('state', (d) => d.state === 'stopped' && /kill switch/.test(d.note));
    assert.equal((await raw(u).catch(() => ({ status: 0 }))).status === 200, false);
  });
});

describe('live view: Take over in a headless session', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); c = McpClient.spawnServer(['--profile-mode=throwaway', '--headless'], h.env); await c.initialize(); });
  after(async () => { await c.close(); h.cleanup(); });

  it('is refused with its reason (no window to show)', async () => {
    const u = urlOf((await c.call('ff_live_view', { action: 'open' })).text);
    const s = sse(u + 'events');
    try {
      const st = await s.next('state', (d) => !!d.controls);
      assert.match(st.controls.takeover, /headless/);
      const r = await post(u + 'takeover');
      assert.equal(r.status, 409);
      assert.match(r.body.toString(), /headless/);
      assert.ok(!(await c.call('navigate', { url: 'about:blank' })).isError);
    } finally { s.close(); }
  });
});

describe('live view: several sessions', () => {
  let A: McpClient, B: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => {
    h = makeHome(namedProfile);
    fx = await startFixtures();
    const env = { ...h.env, FIREFOX_USE_NO_COLD: '1' };
    A = McpClient.spawnProxy(NAMED_ARGS, env); await A.initialize();
    B = McpClient.spawnProxy(NAMED_ARGS, env); await B.initialize();
  });
  after(async () => { await B.close(); await A.close(); fx.close(); h.cleanup(); });

  it('a routed session gets its own URL showing only its own group\'s tabs; Take over is not offered there', async () => {
    assert.ok(!(await A.call('navigate', { url: fx.url('/form.html') })).isError);
    assert.ok(!(await B.call('navigate', { url: fx.url('/page2.html') })).isError);
    const ua = urlOf((await A.call('ff_live_view', { action: 'open' })).text);
    const r = await B.call('ff_live_view', { action: 'open' });
    assert.match(r.text, /routed through another session's Firefox/);
    const ub = urlOf(r.text);
    assert.notEqual(ua, ub);
    assert.equal(new URL(ua).port, new URL(ub).port, 'served by the owning backend');
    const s = sse(ub + 'events');
    try {
      const st = await s.next('state', (d) => !!d.controls);
      assert.match(st.label, /Claude 2/);
      assert.match(st.controls.takeover, /another Claude session owns/);
      const tabs = await s.next('tabs');
      assert.ok(tabs.tabs.length >= 1);
      assert.ok(tabs.tabs.every((t: any) => !/form\.html/.test(t.url)), 'never the other session\'s tabs');
      const f = await s.next('frame');
      assert.match(f.url, /page2\.html/);
      // B's tool calls reach B's view, A's don't
      const n0 = s.events.length;
      await A.call('navigate', { url: fx.url('/text.html') });
      await B.call('get_page_text', {});
      const names = s.events.slice(n0).filter((e) => e.type === 'tool').map((e) => e.data.name);
      assert.ok(names.includes('get_page_text'));
      assert.ok(!names.includes('navigate'), names.join(','));
      assert.equal((await post(ub + 'takeover')).status, 409);
    } finally { s.close(); }
    // ff_quit in the routed session closes only its view
    await B.call('ff_quit', {});
    assert.equal((await raw(ub)).status, 404);
    assert.equal((await raw(ua)).status, 200);
  });
});
