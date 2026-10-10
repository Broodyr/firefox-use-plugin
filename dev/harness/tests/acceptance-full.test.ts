// End-to-end acceptance scenario, all six steps, with a local extension build and scope enforcement on:
// 1-2 write a userscript and an extension that cooperate on "site Y"; 3 install / load them (one scope approval);
// 4 load site Y: trace shows the order, errors come with stacks; 5 find the bug with a breakpoint and evaluation in
// the extension's realm, fix it (hot reload), re-verify; 6 record a regression test, run it headless offline from
// the HAR, and report with the audit trail and the scope checkpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startServer } from './helpers.ts';

const SITE = `<!doctype html><title>Site Y</title><h1>News</h1>
<div class="promo">Subscribe now!</div><p>Article text.</p><div class="promo">Another promo</div>
<script>window.siteReady = true;</script>`;

// the extension: a content script that hides what the userscript asks for, and counts it in its background
const MANIFEST = { manifest_version: 2, name: 'promo hider', version: '1.0', browser_specific_settings: { gecko: { id: 'promo-hider@firefox-use' } }, background: { scripts: ['bg.js'] }, permissions: ['storage'], content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'], run_at: 'document_start' }] };
const BG = `browser.runtime.onMessage.addListener((m) => {
  if (m && m.hidden) return browser.storage.local.get('hidden').then((r) => browser.storage.local.set({ hidden: (r.hidden || 0) + m.hidden }));
});
`;
const CS_BUGGY = `console.log('ext-ready');
document.documentElement.dataset.extReady = '1';
document.addEventListener('x-hide', (e) => {
  const req = JSON.parse(e.detail);
  const els = document.querySelectorAll(req.selectors.join(','));
  els.forEach((el) => { el.style.display = 'none'; });
  browser.runtime.sendMessage({ hidden: els.length });
});
`;
const CS_FIXED = CS_BUGGY.replace('req.selectors.join(\',\')', 'req.selector');

describe('acceptance scenario, all steps, with a local extension build', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, base = '', port = '';
  before(async () => {
    h = makeHome();
    srv = http.createServer((req, res) => {
      if (req.url?.startsWith('/news.html')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SITE); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = String((srv.address() as any).port);
    base = `http://127.0.0.1:${port}`;
    c = await startServer({ ...h.env, FIREFOX_USE_ENFORCE_SCOPE: '1' });
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('steps 1-6', async () => {
    // 1-2: Claude writes the userscript and the extension side
    const ext = path.join(h.workspace, 'ext');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(MANIFEST, null, 1));
    fs.writeFileSync(path.join(ext, 'bg.js'), BG);
    fs.writeFileSync(path.join(ext, 'cs.js'), CS_BUGGY);
    fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'x.user.js'), `// ==UserScript==
// @name        hide-promos
// @namespace   cf-test
// @match       http://127.0.0.1:${port}/*
// @grant       none
// @inject-into content
// ==/UserScript==
__claude.mark('x-started');
if (document.documentElement.dataset.extReady !== '1') throw new Error('promo hider extension is not running');
document.dispatchEvent(new CustomEvent('x-hide', { detail: JSON.stringify({ selector: '.promo' }) }));
__claude.mark('x-asked');
`);
    // 3: one scope approval, then install and load with no further interaction
    let r = await c.call('scope_set', { description: 'load my promo-hider extension build and install my userscript in Violentmonkey (claude-dev) for this task', areas: ['addons', 'ext:vm', 'ext:promo-hider@firefox-use'], user_said: 'yes, go ahead' });
    assert.ok(!r.isError, r.text);
    r = await c.call('ext_dev_lint', { path: 'ext' });
    assert.match(r.text, /Firefox: manifest OK/);
    r = await c.call('ext_dev_load', { path: 'ext' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /no startup errors/);
    r = await c.call('us_install', { path: 'scripts/x.user.js' });
    assert.ok(!r.isError, r.text);

    // 4: load site Y: the order (extension content script, then the userscript), and the error with its stack
    r = await c.call('trace_load', { url: `${base}/news.html`, capture: ['scripts', 'userscripts', 'content', 'marks', 'console'] });
    assert.ok(!r.isError, r.text);
    const rows = r.text.split('\n');
    const csAt = rows.findIndex((l) => /content\s+promo hider \/cs\.js/.test(l));
    const usAt = rows.findIndex((l) => /userscript\s+hide-promos \(scripts\/x\.user\.js\)/.test(l));
    assert.ok(csAt > 0 && usAt > csAt, `extension content script runs before the userscript:\n${r.text}`);
    r = await c.call('errors_summary', {});
    assert.match(r.text, /TypeError: can't access property "join", req\.selectors is undefined/, r.text);
    assert.match(r.text, /cs\.js:5/);
    assert.match((await c.call('eval', { code: 'document.querySelectorAll(".promo")[0].style.display' })).text, /""/, 'the promos are still there');

    // 5: find it: a breakpoint in the extension's content script, evaluation in the paused frame
    r = await c.call('bp_set', { location: { url: 'cs.js', extension: 'promo-hider@firefox-use', line: 5 } });
    assert.ok(!r.isError, r.text);
    r = await c.call('navigate', { url: 'reload' });
    let st = await c.call('debugger_state', {});
    for (let i = 0; i < 30 && /^not paused/.test(st.text); i++) { await new Promise((res) => setTimeout(res, 100)); st = await c.call('debugger_state', {}); }
    assert.match(st.text, /paused \(breakpoint bp\d+\) in .* at moz-extension:\/\/[^/]+\/cs\.js:5/, st.text);
    r = await c.call('eval_paused', { code: 'Object.keys(req).join()' });
    assert.match(r.text, /"selector"/, 'the request has "selector", the content script reads "selectors"');
    await c.call('bp_remove', { id: 'all' });
    // the fix, hot-reloaded by ext_dev_load
    fs.writeFileSync(path.join(ext, 'cs.js'), CS_FIXED);
    let ins = await c.call('ext_dev_inspect', { extension: 'promo-hider@firefox-use' });
    for (let i = 0; i < 30 && !/reloaded \(files changed: cs\.js\)/.test(ins.text); i++) { await new Promise((res) => setTimeout(res, 250)); ins = await c.call('ext_dev_inspect', { extension: 'promo-hider@firefox-use' }); }
    assert.match(ins.text, /reloaded \(files changed: cs\.js\)/);
    r = await c.call('verify', { url: `${base}/news.html`, checks: ['[...document.querySelectorAll(".promo")].every((e) => e.style.display === "none")', { text: 'Article text.' }] });
    assert.match(r.text, /2\/2 check\(s\) passed/, r.text);
    assert.match(r.text, /0 new error\(s\)/, r.text);
    r = await c.call('ext_storage_get', { extension: 'promo-hider@firefox-use', keys: ['hidden'] });
    assert.match(r.text, /hidden[^\n]*[1-9]/, r.text);

    // 6: a regression test, run headless from the recorded traffic
    r = await c.call('test_record', { name: 'promos', url: `${base}/news.html`, steps: [{ wait_for: 'document.querySelector(".promo").style.display === "none"' }], userscripts: ['scripts/x.user.js'], extensions: ['ext'] });
    assert.ok(!r.isError, r.text);
    const tf = path.join(h.workspace, 'tests', 'promos.test.json');
    const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
    t.cases[0].assert.push(
      { expr: '[...document.querySelectorAll(".promo")].every((e) => e.style.display === "none")', name: 'promos hidden' },
      { expr: 'document.documentElement.dataset.extReady', equals: '1', realm: { kind: 'content', extension: 'promo-hider@firefox-use' } },
    );
    fs.writeFileSync(tf, JSON.stringify(t, null, 2));
    await new Promise<void>((res) => srv.close(() => res()));
    srv.closeAllConnections?.();
    r = await c.call('test_run', { names: ['promos'] }, 300000);
    assert.match(r.text, /^1\/1 test file\(s\) passed/, r.text);
    assert.match(r.text, /✔ promos hidden/);
    assert.match(r.text, /✔ order mark:x-started < mark:x-asked/);

    // report: audit trail and the checkpoint to roll back to
    r = await c.call('ff_audit_show', {});
    for (const tool of ['scope_set', 'ext_dev_load', 'us_install', 'bp_set', 'test_record']) assert.match(r.text, new RegExp(tool), `audit has ${tool}`);
    r = await c.call('scope_show', {});
    assert.match(r.text, /checkpoint: s\d{8}-\d{6}/, r.text);
  });
});
