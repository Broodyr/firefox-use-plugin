// End-to-end acceptance scenario, steps 1–4 (below), with scope enforcement on: after ONE scope
// approval, everything runs without further approval.
//   1. "Write a userscript that removes the banner on site Y, plus a uBO scriptlet that neutralises its ad-block
//      nag (Z), and make them work together."
//   2. The files: scripts/x.user.js and resources/user-z.js in the workspace.
//   3. Install the script into Violentmonkey; point uBO's userResourcesLocation at the resource server; add
//      Y##+js(user-z.js) to My filters.
//   4. Load Y, confirm both run in the expected order (scriptlet -> page -> userscript), collect errors with stacks.
//   (+ the inner loop: a buggy first version is caught by verify, fixed, re-verified.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startServer } from './helpers.ts';

const SITE_Y = `<!doctype html><title>Site Y</title>
<script>
  document.documentElement.dataset.order = (document.documentElement.dataset.order || '') + 'page,';
  window.detectAdblock = function () { return true; };
  addEventListener('DOMContentLoaded', function () {
    if (window.detectAdblock()) document.body.insertAdjacentHTML('beforeend', '<div id="nag">Please disable your ad blocker</div>');
  });
</script>
<header class="banner">Big banner</header>
<main><h1>Article</h1><p>Story text.</p></main>`;

describe('acceptance scenario steps 1–4', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, origin = '';
  before(async () => {
    srv = http.createServer((req, res) => { res.writeHead(req.url?.startsWith('/news') ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(req.url?.startsWith('/news') ? SITE_Y : 'nope'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(srv.address() as any).port}`;
    h = makeHome();
    c = await startServer({ ...h.env, FIREFOX_USE_ENFORCE_SCOPE: '1' });
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('writes, installs, wires up, loads, verifies — one scope approval, no other interaction', async () => {
    // one approval for the whole task
    let r = await c.call('scope_set', { description: 'modify Violentmonkey scripts and uBO My filters + userResourcesLocation in claude-dev for the site Y task', areas: ['ext:vm', 'ext:ubo'], user_said: 'yes, go ahead' });
    assert.ok(!r.isError, r.text);

    // step 2: the files Claude writes (first version of the userscript has a bug: wrong selector)
    fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(h.workspace, 'resources'), { recursive: true });
    const script = (sel: string) => `// ==UserScript==
// @name        Site Y cleanup
// @namespace   cf-acceptance
// @match       ${origin}/news*
// @run-at      document-end
// @grant       none
// @version     1.0
// ==/UserScript==
document.documentElement.dataset.order += 'userscript,';
const banner = document.querySelector('${sel}');
if (!banner) throw new Error('banner not found');
banner.remove();
`;
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'x.user.js'), script('.banners'));
    fs.writeFileSync(path.join(h.workspace, 'resources', 'user-z.js'), `/// user-z.js
function userZ() {
  const root = document.documentElement;
  root.dataset.order = (root.dataset.order || '') + 'scriptlet,';

  // neutralise the page's ad-block detector before the page defines it
  Object.defineProperty(window, 'detectAdblock', { get: () => () => false, set: () => {}, configurable: false });
}
`);

    // step 3
    r = await c.call('us_install', { path: 'scripts/x.user.js' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /installed scripts\/x\.user\.js in Violentmonkey/);
    r = await c.call('ubo_set_resources', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /uBO fetched bundle/);
    r = await c.call('ubo_filters_add', { lines: ['127.0.0.1##+js(user-z.js)'] });
    assert.ok(!r.isError, r.text);

    // step 4 (first run): verify catches the bug, with the stack pointing into the userscript
    const checks = [
      { name: 'order', expr: 'document.documentElement.dataset.order', equals: 'scriptlet,page,userscript,' },
      { name: 'banner removed', selector: '.banner', state: 'absent' },
      { name: 'no nag', selector: '#nag', state: 'absent' },
    ];
    r = await c.call('verify', { url: `${origin}/news.html`, checks, screenshots: 'none' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /2\/3 check\(s\) passed/);
    assert.match(r.text, /✖ banner removed/);
    assert.match(r.text, /errors:[\s\S]*Error: banner not found[\s\S]*Site%20Y%20cleanup\.user\.js|errors:[\s\S]*banner not found/);
    assert.match(r.text, /uBO: [\s\S]*1 scriptlet injection[\s\S]*injected scriptlet ##\+js\(user-z\)/);
    // an uncaught error in top-level code: Firefox reports Violentmonkey's wrapper, past the script's end, not line 11
    assert.match(r.text, /Error: banner not found \(scripts\/x\.user\.js \(top-level code, line not reported\)\)/, r.text);

    // fix and re-verify (the inner loop)
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'x.user.js'), script('.banner'));
    r = await c.call('us_update', { path: 'scripts/x.user.js' });
    assert.ok(!r.isError, r.text);
    r = await c.call('verify', { checks, screenshots: 'none' });
    assert.match(r.text, /3\/3 check\(s\) passed · loaded in \d+ ms · 0 new error\(s\)/, r.text);
    assert.match(r.text, /DOM \(a11y\) before -> after/);

    // the audit trail and the checkpoint to roll back to
    r = await c.call('scope_show', {});
    assert.match(r.text, /checkpoint: s\d{8}-\d{6}/);
    r = await c.call('ff_audit_show', { since: '1h' });
    for (const t of ['us_install', 'ubo_set_resources', 'ubo_filters_add', 'us_update', 'verify']) assert.match(r.text, new RegExp(` ${t} ok`));
  });
});
