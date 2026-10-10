// timing: trace_load (script execution order across page / content script / userscript, document events,
// watched selectors, marks, console, network), pause_at_start (before the page's first script, breakpoints in
// load-time code), spa_watch (pushState / hash), resource_latency (local resource server).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, PAGES, installTestExt, makeHome, startFixtures, startServer } from './helpers.ts';

PAGES['/tr.html'] = `<!doctype html><title>tr</title><script>window.order = (window.order || []).concat('inline1'); console.log('inline one');</script>
<script src="/tr.js"></script>
<script>
window.order.push('inline2');
setTimeout(() => { const d = document.createElement('div'); d.className = 'banner'; document.body.append(d); }, 30);
</script>`;
PAGES['/tr.js'] = `window.order.push('external'); console.log('external ran');`;
PAGES['/spa.html'] = `<!doctype html><title>spa</title><button onclick="history.pushState({}, '', '/spa/two')">push</button>`;

describe('timing', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  let port = '';
  before(async () => {
    h = makeHome(); fx = await startFixtures(); c = await startServer(h.env);
    port = new URL(fx.url('/')).port;
    await installTestExt(c, h.workspace);
    fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'early.user.js'), `// ==UserScript==
// @name        early
// @namespace   cf-test
// @match       http://127.0.0.1:${port}/tr.html*
// @grant       none
// @run-at      document-start
// @inject-into content
// ==/UserScript==
__claude.mark('early start');
const early = true;
`);
    const r = await c.call('us_install', { path: 'scripts/early.user.js' });
    assert.ok(!r.isError, r.text);
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('trace_load: one ordered timeline', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    const r = await c.call('trace_load', { url: fx.url('/tr.html'), watch: ['.banner'], settle_ms: 500, detail: 'normal' });
    assert.ok(!r.isError, r.text);
    const rows = r.text.split('\n');
    const idx = (re: RegExp) => rows.findIndex((l) => re.test(l));
    const early = idx(/userscript\s+early \(scripts\/early\.user\.js\) \[Violentmonkey\]/);
    const inline1 = idx(/script\s+page inline script:1$/);
    const external = idx(/script\s+page script http:\/\/127\.0\.0\.1:\d+\/tr\.js/);
    const inline2 = idx(/script\s+page inline script:4$/);
    const cs = idx(/content\s+firefox-use test extension \/cs\.js/);
    const dcl = idx(/dom\s+DOMContentLoaded/);
    const load = idx(/dom\s+load$/);
    const banner = idx(/dom\s+first match \.banner/);
    for (const [n, i] of Object.entries({ early, inline1, external, inline2, cs, dcl, load, banner })) assert.ok(i > 0, `${n} missing:\n${r.text}`);
    // (measured: Violentmonkey's document-start content-mode scripts run after the page's first inline script)
    // script rows are exact; document events are on the page clock (clamped, about ±2 ms against scripts)
    assert.ok(inline1 < external && external < inline2 && early < cs && inline2 < cs, `script order:
${r.text}`);
    // document events come from the tracer: exact, so in true order against the script rows
    assert.match(rows[dcl], / ms {2}dom {8}DOMContentLoaded$/, `DOMContentLoaded is exact (no ~):\n${r.text}`);
    assert.match(rows[load], / ms {2}dom {8}load$/, r.text);
    const interactive = idx(/dom\s+readyState interactive$/);
    assert.ok(inline2 < interactive && interactive < dcl && dcl < load, `document events in order after the parser's scripts:\n${r.text}`);
    assert.doesNotMatch(r.text, /chrome:\/\/|resource:\/\//, 'browser-internal scripts are not listed');
    assert.ok(idx(/mark\s+early: early start/) > 0, r.text);
    assert.ok(idx(/console\s+log \[page\] inline one/) > inline1, r.text);
    assert.ok(idx(/network\s+GET 200 http:\/\/127\.0\.0\.1:\d+\/tr\.js/) > 0, r.text);
    assert.match(r.text, /full trace: .*trace-.*\.json/);
    assert.match((await c.call('eval', { code: 'window.order.join(",")' })).text, /"inline1,external,inline2"/);
    // trace_load leaves no debugger behind
    assert.match((await c.call('bp_list', {})).text, /debugger not started/);
  });

  it('pause_at_start: before the first script; breakpoints in load-time code', async () => {
    let r = await c.call('pause_at_start', { url: fx.url('/tr.html?pas') });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /paused at the first script of .*tr\.html\?pas:\npaused \(event breakpoint: Script First Statement\) in \(top level\) at (http:\/\/127\.0\.0\.1:\d+\/tr\.html\?pas:1:|scripts\/early\.user\.js)/);
    r = await c.call('bp_set', { location: { url: 'tr.js', line: 1 } });
    assert.ok(!r.isError, r.text);
    r = await c.call('resume', {});
    assert.match(r.text, /resumed, then paused \(breakpoint bp\d+\) in \(top level\) at http:\/\/127\.0\.0\.1:\d+\/tr\.js:1:/);
    r = await c.call('eval_paused', { code: 'window.order.join(",")' });
    assert.match(r.text, /"inline1"/);
    await c.call('bp_remove', { id: 'all' });
  });

  it('spa_watch and resource_latency', async () => {
    let r = await c.call('spa_watch', { on: true });
    assert.ok(!r.isError, r.text);
    await c.call('navigate', { url: fx.url('/spa.html') });
    await c.call('eval', { code: 'history.pushState({}, "", "/spa/two"); location.hash = "#three"; 1' });
    await new Promise((res) => setTimeout(res, 300));
    r = await c.call('spa_watch', {});
    assert.match(r.text, /tab\d+ history http:\/\/127\.0\.0\.1:\d+\/spa\/two/);
    assert.match(r.text, /tab\d+ hash http:\/\/127\.0\.0\.1:\d+\/spa\/two#three/);
    await c.call('spa_watch', { on: false });
    fs.mkdirSync(path.join(h.workspace, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'resources', 'slow.js'), '/// slow.js\nwindow.slow = 1;\n');
    r = await c.call('resource_latency', { path: 'resources/slow.js', ms: 600 });
    assert.match(r.text, /http:\/\/127\.0\.0\.1:\d+\/resources\/slow\.js: \+600 ms/);
    const url = /(http:\/\/127\.0\.0\.1:\d+)\/resources/.exec(r.text)![1] + '/resources/slow.js';
    const t0 = Date.now();
    r = await c.call('eval', { code: `fetch(${JSON.stringify(url)}).then((r) => r.status)` });
    assert.match(r.text, /200/);
    assert.ok(Date.now() - t0 >= 550, `latency ${Date.now() - t0}`);
    r = await c.call('resource_latency', { path: 'resources/slow.js', ms: 0 });
    assert.match(r.text, /no artificial latency/);
  });
});
