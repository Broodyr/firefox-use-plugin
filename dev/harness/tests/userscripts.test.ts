// userscripts: companion at launch, Violentmonkey manager mode (install, values, logs, GM_xmlhttpRequest
// attribution, enable/disable, uninstall + undo), two-way sync (push, auto-pull, conflict), fast mode.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

describe('userscripts', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  let port = '';
  const pageEval = async (code: string) => (await c.call('eval', { code })).text;
  const file = (name: string) => path.join(h.workspace, 'scripts', name);
  const hello = (rev: string) => `// ==UserScript==
// @name        hello
// @namespace   cf-test
// @match       http://127.0.0.1:${port}/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_xmlhttpRequest
// @version     1.${rev}
// ==/UserScript==
'use strict';
GM_setValue('count', GM_getValue('count', 0) + 1);
document.documentElement.setAttribute('data-hello', 'r${rev}');
if (typeof __claude !== 'undefined') __claude.mark('started');
GM_xmlhttpRequest({ method: 'GET', url: location.origin + '/page2.html?gm=${rev}', onload: () => console.log('hello xhr done') });
console.log('hello ran r${rev}');
`;
  before(async () => {
    h = makeHome(); fx = await startFixtures(); c = await startServer(h.env);
    port = new URL(fx.url('/')).port;
    fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true });
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('companion is installed at launch', async () => {
    const r = await c.call('ff_launch', {});
    assert.match(r.text, /note: companion 0\.\d+\.\d+ installed \(temporary add-on, userScripts granted\)/);
    const s = await c.call('ff_status', {});
    assert.match(s.text, /companion: 0\.\d+\.\d+/);
  });

  it('manager mode: install, run, values, logs, GM_xmlhttpRequest attribution', async () => {
    fs.writeFileSync(file('hello.user.js'), hello('1'));
    let r = await c.call('us_install', { path: 'scripts/hello.user.js' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /installed scripts\/hello\.user\.js in Violentmonkey as #(\d+) "hello" 1\.1 \(dev prelude\)/);
    await c.call('navigate', { url: fx.url('/page2.html') });
    await c.call('wait_for_console', { pattern: 'hello xhr done', timeout_ms: 5000 });
    assert.match(await pageEval('document.documentElement.getAttribute("data-hello")'), /"r1"/);
    r = await c.call('us_values', { script: 'hello' });
    assert.match(r.text, /count = 1/);
    r = await c.call('us_logs', { script: 'scripts/hello.user.js' });
    assert.match(r.text, /hello ran r1/);
    assert.match(r.text, /\[claude-mark\] \{"script":"hello","label":"started"/);
    r = await c.call('network_read', { filter: 'gm=1' });
    assert.match(r.text, /\[ext:vm userscript "hello" xhr\] http:\/\/127\.0\.0\.1:\d+\/page2\.html\?gm=1/);
    r = await c.call('us_list', {});
    assert.match(r.text, /#\d+ hello 1\.1 · document-end · http:\/\/127\.0\.0\.1:\d+\/\*  ← scripts\/hello\.user\.js/);
    r = await c.call('ext_message', { extension: 'vm', message: { cmd: 'GetScriptCode', data: Number(/#(\d+)/.exec(r.text)![1]) }, writes: false });
    assert.match(r.text, /==\/UserScript==\\n'use strict';\/\*claude-dev-prelude.*?\/\*\/claude-dev-prelude\*\/ \\nGM_setValue/, 'prelude: one line, after the "use strict" directive');
    assert.doesNotMatch(fs.readFileSync(file('hello.user.js'), 'utf8'), /claude-dev-prelude/);
  });

  it('two-way sync: push a file edit, auto-pull a Violentmonkey edit, conflict kept apart', async () => {
    fs.writeFileSync(file('hello.user.js'), hello('2'));
    let r = await c.call('us_sync_status', {});
    assert.match(r.text, /scripts\/hello\.user\.js: file changed/);
    r = await c.call('us_update', { path: 'scripts/hello.user.js' });
    assert.match(r.text, /updated scripts\/hello\.user\.js in Violentmonkey/);
    await c.call('navigate', { url: 'reload' });
    assert.match(await pageEval('document.documentElement.getAttribute("data-hello")'), /"r2"/);
    // an edit in Violentmonkey's editor (same command its editor uses)
    const id = Number(/#(\d+)/.exec((await c.call('us_list', {})).text)![1]);
    await c.call('ext_message', { extension: 'vm', message: { cmd: 'ParseScript', data: { id, code: hello('3'), bumpDate: true } } });
    let content = '';
    for (let i = 0; i < 40 && !content.includes("'r3'"); i++) { await new Promise((res) => setTimeout(res, 250)); content = fs.readFileSync(file('hello.user.js'), 'utf8'); }
    assert.match(content, /data-hello', 'r3'/, 'pulled automatically');
    r = await c.call('us_sync_status', {});
    assert.match(r.text, /scripts\/hello\.user\.js: synced/);
    // both sides change -> conflict file, nothing overwritten
    fs.writeFileSync(file('hello.user.js'), hello('4'));
    await c.call('ext_message', { extension: 'vm', message: { cmd: 'ParseScript', data: { id, code: hello('5'), bumpDate: true } } });
    r = await c.call('us_sync', { direction: 'auto' });
    assert.match(r.text, /CONFLICT scripts\/hello\.user\.js[\s\S]*hello\.user\.js\.vm-conflict/);
    assert.match(fs.readFileSync(file('hello.user.js'), 'utf8'), /'r4'/);
    assert.match(fs.readFileSync(file('hello.user.js.vm-conflict'), 'utf8'), /'r5'/);
    r = await c.call('us_update', { path: 'scripts/hello.user.js' });
    assert.ok(!r.isError, r.text);
    r = await c.call('us_sync_status', {});
    assert.match(r.text, /scripts\/hello\.user\.js: synced/);
  });

  it('values_set + undo, enable/disable, uninstall + undo', async () => {
    let r = await c.call('us_values_set', { script: 'hello', values: { count: 10, extra: { a: 1 } } });
    assert.ok(!r.isError, r.text);
    r = await c.call('us_values', { script: 'hello' });
    assert.match(r.text, /count = 10[\s\S]*extra = \{"a":1\}/);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /values -> previous store/);
    r = await c.call('us_values', { script: 'hello' });
    assert.doesNotMatch(r.text, /count = 10/);
    r = await c.call('us_set_enabled', { script: 'hello', enabled: false });
    assert.match(r.text, /enabled -> disabled/);
    await c.call('navigate', { url: 'reload' });
    assert.match(await pageEval('document.documentElement.getAttribute("data-hello")'), /null/);
    await c.call('us_set_enabled', { script: 'hello', enabled: true });
    r = await c.call('us_uninstall', { script: 'hello' });
    assert.match(r.text, /recycle bin[\s\S]*file is kept/);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /restored from its recycle bin/);
  });

  it('fast mode: companion userScripts with persisted GM values; recorded stubs', async () => {
    fs.writeFileSync(file('fast.user.js'), `// ==UserScript==
// @name        fasty
// @namespace   cf-test
// @match       http://127.0.0.1/*
// @grant       GM_setValue
// @run-at      document-start
// ==/UserScript==
GM_setValue('n', GM_getValue('n', 0) + 1);
document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-fast', String(GM_getValue('n'))));
console.log('fasty ran', typeof GM_info, GM_info.scriptHandler);
setTimeout(() => console.log('fasty late 1 n=' + GM_getValue('n')), 400);
setTimeout(() => console.log('fasty late 2 n=' + GM_getValue('n')), 900);
`);
    let r = await c.call('us_install', { path: 'scripts/fast.user.js', mode: 'fast' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /registered scripts\/fast\.user\.js in fast mode \(companion userScripts, USER_SCRIPT, GM stubs: persisted\) as cf-\w+/);
    await c.call('navigate', { url: fx.url('/page2.html') });
    assert.match(await pageEval('document.documentElement.getAttribute("data-fast")'), /"1"/);
    await new Promise((res) => setTimeout(res, 400)); // the companion re-registers with the new value
    await c.call('navigate', { url: 'reload' });
    assert.match(await pageEval('document.documentElement.getAttribute("data-fast")'), /"2"/);
    r = await c.call('us_values', { script: 'fasty' });
    assert.match(r.text, /n = 2/);
    r = await c.call('us_logs', { script: 'fasty', settle_ms: 0 });
    assert.match(r.text, /\[userscript:fasty \(fast\)[^\]]*\] fasty ran object firefox-use fast mode \(claude-fast\/fasty\.user\.js:10:/, 'line numbers are the file\'s');
    assert.doesNotMatch(r.text, /fasty late 2 n=2/, 'settle_ms 0 reads at once');
    // the default settle waits for entries that are still coming
    r = await c.call('us_logs', { script: 'fasty' });
    assert.match(r.text, /fasty late 2 n=2/);
    assert.match(r.text, /note: \d+ entr(y|ies) arrived while waiting/);
    r = await c.call('us_fast_gm', { stubs: 'recorded' });
    assert.match(r.text, /fast-mode GM stubs: recorded/);
    await c.call('navigate', { url: 'reload' });
    r = await c.call('us_values', { script: 'fasty' });
    assert.match(r.text, /n = 2/, 'recorded mode does not persist');
    r = await c.call('us_fast_gm', {});
    assert.match(r.text, /GM_setValue\("n",3\)/);
    r = await c.call('us_list', {});
    assert.match(r.text, /fast cf-\w+ fasty .*document_start · USER_SCRIPT · GM recorded/);
    r = await c.call('us_uninstall', { script: 'fasty' });
    assert.match(r.text, /unregistered/);
  });

  it('verify waits for dev userscripts that started at the previous verify, and names one that no longer starts', async () => {
    fs.writeFileSync(file('starter.user.js'), `// ==UserScript==
// @name        starter
// @namespace   cf-test
// @match       http://127.0.0.1/*
// @grant       none
// ==/UserScript==
document.documentElement.setAttribute('data-starter', '1');
`);
    let r = await c.call('us_install', { path: 'scripts/starter.user.js', mode: 'fast' });
    assert.ok(!r.isError, r.text);
    await c.call('verify', { url: fx.url('/page2.html'), checks: ['document.documentElement.dataset.starter === "1"'] });
    r = await c.call('verify', { checks: ['document.documentElement.dataset.starter === "1"'] });
    assert.match(r.text, /1\/1 check\(s\) passed/, r.text);
    assert.doesNotMatch(r.text, /did not start/);
    assert.doesNotMatch((await c.call('console_read', {})).text, /claude-start/, 'the start marker is not console output');
    await c.call('us_set_enabled', { script: 'starter', enabled: false });
    r = await c.call('verify', { checks: ['document.documentElement.dataset.starter === "1"'] });
    assert.match(r.text, /NOTE: dev userscript\(s\) that started here at the previous verify did not start this time \(waited 3 s\): starter/, r.text);
    await c.call('us_uninstall', { script: 'starter' });
  });

  it('Violentmonkey stack lines are file lines past @requires; an uncaught top-level error says its line is unknown', async () => {
    // line 9: an error inside a function (exact position; the dev prelude sits on this line, so its columns are
    // shifted back); line 12: an uncaught error in top-level code, which Firefox reports one line past the script's
    // end (Violentmonkey's wrapper). The setTimeout callback's error lands in the page realm, so verify shows it.
    fs.writeFileSync(file('lines.user.js'), `// ==UserScript==
// @name        lines
// @namespace   cf-test
// @match       http://127.0.0.1:${port}/*
// @require     ${fx.url('/req-nl.js')}
// @require     ${fx.url('/req-nonl.js')}
// @grant       none
// ==/UserScript==
function inner() { return document.querySelector('#nope-inner').remove(); }
console.log('lines here');
setTimeout(inner);
document.querySelector('#nope-top').remove();
`);
    let r = await c.call('us_install', { path: 'scripts/lines.user.js' });
    assert.ok(!r.isError, r.text);
    r = await c.call('verify', { url: fx.url('/page2.html'), screenshots: 'none' });
    assert.match(r.text, /is null \(scripts\/lines\.user\.js \(top-level code, line not reported\)\)/, r.text);
    const inner = /is null \(scripts\/lines\.user\.js:9:(\d+)\)/.exec(r.text);
    assert.ok(inner, r.text);
    assert.ok(Number(inner[1]) <= 80, `column ${inner[1]} is a file column (the line is 77 characters)`);
    r = await c.call('us_logs', { script: 'scripts/lines.user.js' });
    assert.match(r.text, /lines here \(scripts\/lines\.user\.js:10:/, r.text);
    assert.match(r.text, /is null \(scripts\/lines\.user\.js \(top-level code, line not reported\)\)/, r.text);
    await c.call('us_uninstall', { script: 'lines' });
  });
});
