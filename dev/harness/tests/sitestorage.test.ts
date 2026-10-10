// site storage: cookies, localStorage / sessionStorage, IndexedDB, Cache Storage, service workers,
// site_data_clear; masking, scope, undo.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startServer } from './helpers.ts';

const STORE_PAGE = `<!doctype html><title>store</title><script>
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('authToken', 'SUPERSECRETVALUE123');
  sessionStorage.setItem('step', '2');
  document.cookie = 'visible=yes; path=/';
  (async () => {
    await new Promise((res, rej) => {
      const r = indexedDB.open('shop', 3);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore('items', { keyPath: 'id' }); s.createIndex('byName', 'name'); r.result.createObjectStore('log', { autoIncrement: true }); };
      r.onsuccess = () => {
        const tx = r.result.transaction(['items', 'log'], 'readwrite');
        for (let i = 1; i <= 5; i++) tx.objectStore('items').put({ id: i, name: 'item' + i, added: new Date(0), tags: ['a', 'b'] });
        tx.objectStore('log').add('first');
        tx.oncomplete = () => { r.result.close(); res(); };
      };
      r.onerror = rej;
    });
    const c = await caches.open('v1');
    await c.put('/data.json', new Response('{"x":1}', { headers: { 'content-type': 'application/json' } }));
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    document.title = 'ready';
  })().catch((e) => { document.title = 'failed ' + e; });
</script>`;

describe('site storage', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, base = '', other = '';
  before(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('self.addEventListener("fetch", () => {});'); return; }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=HTTPONLYSECRET42; HttpOnly; Path=/', 'cache-control': 'no-store' });
      res.end(req.url?.startsWith('/store') ? STORE_PAGE : '<!doctype html><title>plain</title><p>plain');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    base = `http://127.0.0.1:${port}`;
    other = `http://localhost:${port}`;
    h = makeHome();
    c = await startServer({ ...h.env, FIREFOX_USE_ENFORCE_SCOPE: '1' });
    await c.call('navigate', { url: `${base}/store.html` });
    const w = await c.call('wait_for', { expr: 'document.title !== "store"', timeout_ms: 15000 });
    assert.ok(!w.isError, w.text);
    assert.equal((await c.call('eval', { code: 'document.title' })).text.match(/"(.*)"/)?.[1], 'ready');
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('reads cookies, local/session storage with masking', async () => {
    let r = await c.call('cookies_get', { domain: '127.0.0.1' });
    assert.match(r.text, /sid=<masked: 16 chars> · 127\.0\.0\.1\/ · httpOnly/, r.text);
    assert.match(r.text, /visible=<masked: 3 chars>/);
    assert.doesNotMatch(r.text, /HTTPONLYSECRET42/);
    r = await c.call('cookies_get', { domain: '127.0.0.1', name: 'visible', unmask: ['visible'] });
    assert.match(r.text, /^1 cookie\(s\)\nvisible=yes/, r.text);

    r = await c.call('local_storage', {});
    assert.match(r.text, /2 item\(s\) in localStorage of http:\/\/127\.0\.0\.1:\d+/, r.text);
    assert.match(r.text, /"theme" = "dark"/);
    assert.match(r.text, /"authToken" = "<masked: 19 chars>"/);
    r = await c.call('local_storage', { op: 'get', key: 'authToken', unmask: ['authToken'] });
    assert.match(r.text, /"SUPERSECRETVALUE123"/, r.text);
    // another origin's localStorage, without loading it: empty
    r = await c.call('local_storage', { origin: other });
    assert.match(r.text, /^0 item\(s\) in localStorage of http:\/\/localhost:\d+/, r.text);

    r = await c.call('session_storage', {});
    assert.match(r.text, /1 item\(s\) in sessionStorage .*\n {2}"step" = "2"/, r.text);
    r = await c.call('session_storage', { origin: other });
    assert.match(r.text, /NO_DOCUMENT/);
  });

  it('reads IndexedDB, Cache Storage and service workers', async () => {
    let r = await c.call('indexeddb_list', {});
    assert.match(r.text, /db "shop" v3:/, r.text);
    assert.match(r.text, /store "items": 5 record\(s\) · keyPath "id" · indexes: byName\("name"\)/);
    assert.match(r.text, /store "log": 1 record\(s\) · keyPath null · autoIncrement/);
    r = await c.call('indexeddb_read', { db: 'shop', store: 'items', query: { lower: 2 }, limit: 2, offset: 1 });
    assert.match(r.text, /items of http:\/\/127\.0\.0\.1:\d+: 4 record\(s\) in range; showing 2-3 \(next: offset 3\)/, r.text);
    assert.match(r.text, /\n {2}3 → \{"id":3,"name":"item3","added":"\[Date 1970-01-01T00:00:00\.000Z\]","tags":\["a","b"\]\}/);
    r = await c.call('indexeddb_read', { db: 'shop', store: 'items', index: 'byName', query: { only: 'item4' } });
    assert.match(r.text, /1 record\(s\).*\n {2}"item4" \(primary 4\) →/s, r.text);
    r = await c.call('indexeddb_read', { db: 'nope', store: 'x' });
    assert.ok(r.isError);
    assert.match(r.text, /no database "nope"/);

    r = await c.call('cache_storage_list', {});
    assert.match(r.text, /cache "v1": 1 entry\n {2}GET http:\/\/127\.0\.0\.1:\d+\/data\.json → 200 application\/json/, r.text);
    r = await c.call('service_workers', {});
    assert.match(r.text, /http:\/\/127\.0\.0\.1:\d+\/\n {2}script http:\/\/127\.0\.0\.1:\d+\/sw\.js · active: activated, handles fetch/, r.text);
  });

  it('writes need scope; localStorage of an unloaded origin, cookies; undo', async () => {
    let r = await c.call('local_storage', { op: 'set', key: 'k', value: 'v', origin: other });
    assert.match(r.text, /SCOPE_REQUIRED/);
    r = await c.call('scope_set', { description: 'change test site storage', areas: ['site_data', 'restore'], user_said: 'yes' });
    assert.ok(!r.isError, r.text);
    r = await c.call('local_storage', { op: 'set', key: 'pre', value: 'seeded', origin: other });
    assert.match(r.text, /localStorage of http:\/\/localhost:\d+: "pre" added/, r.text);
    // the page of that origin sees it when it loads
    await c.call('tabs_create', { url: `${other}/plain.html` });
    r = await c.call('eval', { code: 'localStorage.getItem("pre")' });
    assert.match(r.text, /"seeded"/, r.text);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /"pre" -> \(removed\)/, r.text);
    r = await c.call('eval', { code: 'localStorage.getItem("pre")' });
    assert.match(r.text, /null/, r.text);

    r = await c.call('cookies_set', { name: 'cf_test', value: 'abc', domain: 'localhost' });
    assert.match(r.text, /cookie cf_test set for localhost\/ \(session\)/, r.text);
    r = await c.call('eval', { code: 'document.cookie' });
    assert.match(r.text, /cf_test=abc/, r.text);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /cookie cf_test .* -> deleted/, r.text);
    r = await c.call('cookies_get', { name: 'cf_test' });
    assert.match(r.text, /^no cookies/, r.text);

    // sessionStorage write in the tab
    await c.call('tabs_select', { tab: 1 });
    r = await c.call('session_storage', { op: 'remove', key: 'step' });
    assert.match(r.text, /"step" removed \(tab-bound: not undo-able\)/, r.text);
  });

  it('site_data_clear removes cookies and storage of the origin only', async () => {
    let r = await c.call('local_storage', { op: 'set', key: 'keep', value: '1', origin: other });
    assert.ok(!r.isError, r.text);
    r = await c.call('service_workers', { op: 'unregister', scope: 'all' });
    assert.match(r.text, /\/: unregistered/, r.text);
    r = await c.call('site_data_clear', {});
    assert.match(r.text, /cleared cookies, storage for http:\/\/127\.0\.0\.1:\d+\./, r.text);
    assert.match((await c.call('indexeddb_list', {})).text, /^no IndexedDB databases/);
    assert.match((await c.call('cache_storage_list', {})).text, /^no Cache Storage caches/);
    assert.match((await c.call('local_storage', { origin: base })).text, /^0 item\(s\)/);
    assert.match((await c.call('cookies_get', { domain: '127.0.0.1' })).text, /^no cookies/);
    // other origins untouched
    assert.match((await c.call('local_storage', { origin: other })).text, /"keep" = "1"/);
    assert.match((await c.call('service_workers', {})).text, /^no service workers/);
  });
});
