// dialogs (policy, ask + dialog_handle, beforeunload), HTTP auth, site permissions, downloads (guard,
// sandbox), clipboard.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, refFor, startServer } from './helpers.ts';

const PAGE = `<!doctype html><title>dlg</title>
  <button onclick="alert('hi there')">Alert</button>
  <button onclick="document.title = 'confirmed ' + confirm('really?')">Confirm</button>
  <button onclick="document.title = 'prompted ' + prompt('name?', 'def')">Prompt</button>
  <button onclick="document.execCommand('copy')">Copy</button>
  <a href="/file.bin">Download</a>
  <a href="http://downloads.example/remote.bin">Remote download</a>
  <textarea id="t"></textarea>
  <script>
    document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'copied by page'); e.preventDefault(); });
    document.getElementById('t').addEventListener('paste', (e) => { document.title = 'pasted ' + e.clipboardData.getData('text/plain'); });
    window.onbeforeunload = (e) => { if (window.guard) { e.preventDefault(); return 'x'; } };
  </script>`;

describe('dialogs, auth, permissions, downloads, clipboard', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, base = '';
  const title = async () => JSON.parse((await c.call('eval', { code: 'document.title' })).text.replace(/^\[page\] \(string\) /, '').split('\n')[0]);
  const click = async (name: string, role = 'button') => { const t = Date.now(); const r = await c.call('click', { target: refFor((await c.call('read_page', {})).text, role, name) }); if (process.env.CF_TIMING) console.log('click', name, Date.now() - t); return r; };

  before(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/auth') {
        const ok = req.headers.authorization === `Basic ${Buffer.from('tester:pw-for-tests').toString('base64')}`;
        res.writeHead(ok ? 200 : 401, { 'content-type': 'text/html', ...(ok ? {} : { 'www-authenticate': 'Basic realm="cf test"' }) });
        res.end(ok ? '<title>welcome</title>in' : '<title>denied</title>no');
        return;
      }
      if (req.url === '/file.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' }); res.end(Buffer.alloc(1234, 7)); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
    h = makeHome();
    c = await startServer({ ...h.env, FIREFOX_USE_ENFORCE_SCOPE: '1' });
    await c.call('navigate', { url: `${base}/dlg.html` });
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('default policy, accept, ask + dialog_handle, beforeunload', async () => {
    let r = await click('Alert');
    assert.match(r.text, /dialog: alert "hi there" \(dismissed\)/, r.text);
    r = await click('Confirm');
    assert.match(r.text, /dialog: confirm "really\?" \(dismissed\)/, r.text);
    assert.equal(await title(), 'confirmed false');
    r = await c.call('dialogs_policy', { confirm: 'accept', prompt: 'accept', prompt_text: 'Claude' });
    assert.match(r.text, /confirm accept · prompt accept \(text "Claude"\)/, r.text);
    await click('Confirm');
    assert.equal(await title(), 'confirmed true');
    r = await click('Prompt');
    assert.match(r.text, /dialog: prompt "name\?" \(accepted with "Claude"\)/, r.text);
    assert.equal(await title(), 'prompted Claude');

    await c.call('dialogs_policy', { confirm: 'ask' });
    r = await click('Confirm');
    assert.match(r.text, /dialog: confirm "really\?" \(OPEN: the page is waiting; answer with dialog_handle\)/, r.text);
    // the page is suspended inside confirm(): a call that waits on it reports the open dialog after 3 s
    const t0 = Date.now();
    r = await c.call('eval', { code: 'document.title' });
    assert.match(r.text, /DIALOG_OPEN/, r.text);
    assert.match(r.text, /tab 1: confirm "really\?"/);
    assert.ok(Date.now() - t0 < 6000);
    assert.match((await c.call('ff_status', {})).text, /dialogs OPEN \(dialog_handle answers them\): confirm "really\?"/);
    r = await c.call('dialog_handle', { accept: true });
    assert.match(r.text, /confirm "really\?": accepted \(dialog_handle\)/, r.text);
    assert.equal(await title(), 'confirmed true');
    r = await c.call('dialog_handle', { accept: true });
    assert.match(r.text, /NO_DIALOG/);
    await c.call('dialogs_policy', { reset: true });

    // beforeunload is accepted by default: navigating away works
    await c.call('eval', { code: 'window.guard = true' });
    await click('Alert'); // user activation (beforeunload needs it)
    r = await c.call('navigate', { url: `${base}/dlg.html?again` });
    assert.match(r.text, /dialog: beforeunload .*\(accepted\)/, r.text);
    assert.match(r.text, /dlg\.html\?again/);
  });

  it('HTTP auth: cancelled by default, test credentials for local hosts only', async () => {
    let r = await c.call('navigate', { url: `${base}/auth` });
    assert.match(r.text, /^denied/, r.text);
    assert.match(r.text, /http auth: http:\/\/127\.0\.0\.1:\d+\/auth \(Basic realm "cf test"\): cancelled: the page shows the server's 401 response/, r.text);
    r = await c.call('http_auth', { mode: 'credentials', url: 'http://example.com/', username: 'u', password: 'p' });
    assert.match(r.text, /DENIED/);
    r = await c.call('http_auth', { mode: 'credentials', url: '/auth', username: 'tester', password: 'pw-for-tests' });
    assert.doesNotMatch(r.text, /pw-for-tests/);
    r = await c.call('navigate', { url: `${base}/auth` });
    assert.match(r.text, /^welcome/, r.text);
    assert.match(r.text, /answered with the test credentials for tester/);
    const audit = await c.call('ff_audit_show', { tool: 'http_auth', detail: 'full' });
    assert.doesNotMatch(audit.text, /pw-for-tests/);
    await c.call('http_auth', { mode: 'cancel' });
  });

  it('permissions: scope, set, get, page sees it, undo', async () => {
    await c.call('navigate', { url: `${base}/dlg.html` });
    let r = await c.call('permissions_set', { name: 'geolocation', state: 'granted' });
    assert.match(r.text, /SCOPE_REQUIRED/);
    r = await c.call('scope_set', { description: 'test site permissions and downloads', areas: ['site_data', 'restore'], user_said: 'yes' });
    assert.ok(!r.isError, r.text);
    r = await c.call('permissions_set', { name: 'geolocation', state: 'granted' });
    assert.match(r.text, /geolocation = granted for http:\/\/127\.0\.0\.1:\d+ \(stored as geo: allow/, r.text);
    r = await c.call('permissions_get', {});
    assert.match(r.text, /geolocation \(geo\): allow/, r.text);
    r = await c.call('eval', { code: '(await navigator.permissions.query({ name: "geolocation" })).state' });
    assert.match(r.text, /"granted"/, r.text);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /permission geo of .* -> \(not set\)/, r.text);
    assert.doesNotMatch((await c.call('permissions_get', {})).text, /geolocation/);
  });

  it('downloads: into the sandbox; non-local ones need the user\'s OK', async () => {
    await c.call('navigate', { url: `${base}/dlg.html` });
    await click('Download', 'link');
    let r = await c.call('downloads_wait', { pattern: 'file.bin' });
    assert.match(r.text, /downloaded http:\/\/127\.0\.0\.1:\d+\/file\.bin\n-> .*file\.bin · 1234 B on disk/, r.text);
    const sandbox = JSON.parse(/= (".*") \(/.exec((await c.call('ff_prefs_get', { names: ['browser.download.dir'] })).text)![1]);
    assert.ok(r.text.includes(path.join(sandbox, 'file')), `${r.text}\nnot in ${sandbox}`);
    // a non-local site (mocked) without the downloads approval: blocked
    await c.call('network_mock', { rules: [{ url: 'downloads.example', action: 'fulfill', status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="remote.bin"' }, body: 'remote' }] });
    await click('Remote download', 'link');
    r = await c.call('downloads_wait', { pattern: 'remote.bin' });
    assert.match(r.text, /DOWNLOAD_BLOCKED/, r.text);
    assert.match(r.text, /non-local site without the user's OK/);
    r = await c.call('scope_set', { description: 'test site permissions and downloads', areas: ['site_data', 'restore', 'downloads'], user_said: 'yes, downloads too' });
    assert.ok(!r.isError, r.text);
    await c.call('navigate', { url: `${base}/dlg.html` });
    await click('Remote download', 'link');
    r = await c.call('downloads_wait', { pattern: 'remote.bin' });
    assert.match(r.text, /downloaded http:\/\/downloads\.example\/remote\.bin/, r.text);
    r = await c.call('downloads_list', {});
    assert.match(r.text, /^3 download\(s\) from this session's tabs/, r.text); // incl. the blocked (canceled) attempt
    assert.match(r.text, /canceled · remote\.bin/);
    assert.match(r.text, /BLOCKED .*downloads\.example\/remote\.bin: download from a non-local site/);
    await c.call('network_mock_clear', {});
  });

  it('clipboard: page copy, write + paste, restore', async () => {
    await c.call('navigate', { url: `${base}/dlg.html` });
    await click('Copy');
    let r = await c.call('clipboard_read', {});
    assert.match(r.text, /clipboard \(14 chars\): "copied by page"/, r.text);
    r = await c.call('clipboard_write', { text: 'from claude' });
    assert.match(r.text, /11 chars written/);
    await c.call('eval', { code: 'document.getElementById("t").focus()' });
    await c.call('key', { keys: 'ctrl+v' });
    assert.equal(await title(), 'pasted from claude');
    r = await c.call('clipboard_write', { restore: true });
    assert.match(r.text, /restored the earlier text/, r.text);
    assert.match((await c.call('clipboard_read', {})).text, /"copied by page"/);
  });
});
