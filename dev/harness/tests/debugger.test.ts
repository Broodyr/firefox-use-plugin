// debugger: line breakpoints (pause during click, state with scope, eval in frame, step, resume), logpoints,
// conditions, function and event breakpoints, pause on exceptions, DOM mutation breakpoints, content scripts,
// extension backgrounds, userscripts in file lines (manager and fast mode), auto-resume, bp_remove all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, PAGES, installTestExt, makeHome, refFor, startFixtures, startServer } from './helpers.ts';

PAGES['/dbg.html'] = `<!doctype html><title>dbg</title><div id="box" role="region" aria-label="Box"><span id="kid">k</span></div><button id="b">Work</button><script>
function work(n) {
  const local = n * 2;
  document.title = 'work ' + local;
  return local;
}
document.getElementById('b').addEventListener('click', () => work(21));
window.doMut = () => { document.getElementById('box').setAttribute('data-x', '1'); };
window.doThrow = () => { try { throw new Error('caught one'); } catch (e) {} null.x; };
</script>`;

/** debugger_state once something is paused (polls up to 3 s). */
async function pausedState(c: McpClient) {
  let r = await c.call('debugger_state', {});
  for (let i = 0; i < 30 && /^not paused/.test(r.text); i++) { await new Promise((res) => setTimeout(res, 100)); r = await c.call('debugger_state', {}); }
  return r;
}

describe('debugger', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  let port = '';
  const title = async () => (await c.call('eval', { code: 'document.title' })).text.split('\n')[0];
  before(async () => {
    h = makeHome(); fx = await startFixtures();
    c = await startServer({ ...h.env, FIREFOX_USE_PAUSE_TIMEOUT_MS: '8000' });
    port = new URL(fx.url('/')).port;
    await installTestExt(c, h.workspace);
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('line breakpoint: click reports the pause; state, eval_paused, step, resume', async () => {
    await c.call('navigate', { url: fx.url('/dbg.html') });
    let r = await c.call('bp_set', { location: { url: 'dbg.html', line: 4 } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /set bp1 http:\/\/127\.0\.0\.1:\d+\/dbg\.html:4:2/);
    const page = await c.call('read_page', {});
    r = await c.call('click', { target: refFor(page.text, 'button', 'Work') });
    assert.match(r.text, /^PAUSED during click: paused \(breakpoint bp1\) in work at http:\/\/127\.0\.0\.1:\d+\/dbg\.html:4:2/);
    r = await c.call('debugger_state', {});
    assert.match(r.text, />\s+4 \|\s+document\.title = 'work ' \+ local;/);
    assert.match(r.text, /#0 work @ /);
    assert.match(r.text, /local = 42/);
    assert.match(r.text, /n = 21/);
    r = await c.call('eval_paused', { code: 'local + n' });
    assert.match(r.text, /\[paused frame #0 work\] \(number\) 63/);
    r = await c.call('eval_paused', { code: '({ a: [local], s: "x" })' });
    assert.match(r.text, /"a": \[\s*42\s*\]/);
    r = await c.call('screenshot', {});
    assert.match(r.text, /^NOTE: the page is paused/);
    r = await c.call('step', { kind: 'over' });
    assert.match(r.text, /paused \(step\) in work at http:\/\/127\.0\.0\.1:\d+\/dbg\.html:5:2/);
    r = await c.call('resume', {});
    assert.match(r.text, /^resumed\n/);
    assert.match(await title(), /"work 42"/);
    r = await c.call('bp_list', {});
    assert.match(r.text, /bp1 .*dbg\.html:4:2/);
    assert.match(r.text, /not paused/);
    await c.call('bp_remove', { id: 'bp1' });
  });

  it('logpoint and condition', async () => {
    let r = await c.call('bp_set', { location: { url: 'dbg.html', line: 4 }, log_message: '"LP", local, n' });
    assert.ok(!r.isError, r.text);
    await c.call('eval', { code: 'document.getElementById("b").click(); 1' });
    r = await c.call('console_read', { pattern: 'LP' });
    assert.match(r.text, /\[logpoint bp\d+\] LP 42 21/);
    const id = /set (bp\d+)/.exec((await c.call('bp_list', {})).text)?.[1] ?? 'bp2';
    await c.call('bp_remove', { id });
    r = await c.call('bp_set', { location: { url: 'dbg.html', line: 4 }, condition: 'n > 100' });
    r = await c.call('eval', { code: 'document.getElementById("b").click(); document.title' });
    assert.match(r.text, /"work 42"/); // condition false: no pause
    r = await c.call('eval', { code: 'setTimeout(() => work(200)); 1' });
    r = await pausedState(c);
    assert.match(r.text, /n = 200/);
    await c.call('resume', {});
    await c.call('bp_remove', { id: 'all' });
  });

  it('function and event breakpoints', async () => {
    let r = await c.call('bp_set', { location: { function: 'work' } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /dbg\.html:3:\d+ \[function work\]/);
    r = await c.call('eval', { code: 'setTimeout(() => work(1)); 1' });
    r = await pausedState(c);
    assert.match(r.text, /^paused \(breakpoint bp\d+\) in work at .*dbg\.html:3:/);
    await c.call('bp_remove', { id: 'all' });
    r = await c.call('bp_set', { location: { event: 'click' } });
    assert.match(r.text, /event event\.mouse\.click/);
    r = await c.call('eval', { code: 'setTimeout(() => document.getElementById("b").click()); 1' });
    r = await pausedState(c);
    assert.match(r.text, /^paused \(event breakpoint: DOM 'click' event\)/);
    await c.call('resume', {});
    await c.call('bp_remove', { id: 'all' });
  });

  it('pause on uncaught exceptions; DOM attribute breakpoint', async () => {
    let r = await c.call('pause_on_exceptions', { mode: 'uncaught' });
    r = await c.call('eval', { code: 'setTimeout(() => doThrow()); 1' });
    r = await pausedState(c);
    assert.match(r.text, /^paused \(exception: TypeError: can't access property "x" of null\) in window\.doThrow/);
    await c.call('resume', {});
    await c.call('pause_on_exceptions', { mode: 'none' });
    const page = await c.call('read_page', { filter: 'all' });
    const box = refFor(page.text, 'region', 'Box');
    r = await c.call('dom_breakpoint', { ref: box!, type: 'attribute' });
    assert.ok(!r.isError, r.text);
    r = await c.call('eval', { code: 'setTimeout(() => doMut()); 1' });
    r = await pausedState(c);
    assert.match(r.text, /^paused \(DOM mutation breakpoint: DOM Mutation: 'attributeModified' on <div#box>\) in window\.doMut/);
    await c.call('resume', {});
    assert.match((await c.call('eval', { code: 'document.getElementById("box").dataset.x' })).text, /"1"/);
    await c.call('bp_remove', { id: 'all' });
  });

  it('content script and extension background breakpoints', async () => {
    let r = await c.call('navigate', { url: fx.url('/page2.html') });
    r = await c.call('bp_set', { location: { url: 'cs.js', line: 3 } });
    assert.ok(!r.isError, r.text);
    r = await c.call('navigate', { url: fx.url('/page2.html?again') });
    assert.match(r.text, /^PAUSED during navigate: paused \(breakpoint bp\d+\) in \(top level\) at moz-extension:\/\/[^/]+\/cs\.js:3:/);
    r = await c.call('debugger_state', {});
    assert.match(r.text, /console\.log\('test-ext content script on'/);
    await c.call('resume', {});
    await c.call('bp_remove', { id: 'all' });
    // bg.js line 9: the echo handler
    r = await c.call('bp_set', { location: { url: 'bg.js', extension: 'test-ext@firefox-use', line: 9 } });
    assert.ok(!r.isError, r.text);
    r = await c.call('ext_message', { extension: 'test-ext@firefox-use', message: { cmd: 'echo', value: 5 } });
    assert.match(r.text, /^PAUSED during ext_message: paused \(breakpoint bp\d+\) .*bg\.js:9:/);
    r = await c.call('eval_paused', { code: 'msg.value' });
    assert.match(r.text, /\] \(number\) 5\n/);
    await c.call('bp_remove', { id: 'all' });
  });

  it('userscripts: eval in the script scope (content, page, fast); breakpoints in file lines', async () => {
    fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true });
    const src = (name: string, extra = '') => `// ==UserScript==
// @name        ${name}
// @namespace   cf-test
// @match       http://127.0.0.1:${port}/*
// @grant       none
${extra}// ==/UserScript==
const greeting = 'hi from ${name}';
function mark(el) {
  el.setAttribute('data-${name}', greeting);
  return greeting.length;
}
mark(document.documentElement);
`;
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'dbgvm.user.js'), src('dbgvm', '// @inject-into content\n'));
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'dbgfast.user.js'), src('dbgfast'));
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'dbgpage.user.js'), src('dbgpage', '// @inject-into page\n'));
    for (const [f, mode] of [['dbgvm', 'manager'], ['dbgfast', 'fast'], ['dbgpage', 'manager']]) {
      const r = await c.call('us_install', { path: `scripts/${f}.user.js`, mode });
      assert.ok(!r.isError, r.text);
    }
    await c.call('navigate', { url: fx.url('/page2.html') });
    let r = await c.call('wait_for', { expr: 'document.documentElement.dataset.dbgvm && document.documentElement.dataset.dbgfast && document.documentElement.dataset.dbgpage', timeout_ms: 5000 });
    assert.ok(!r.isError, r.text);
    // {kind:"userscript"}: the eval hook evaluates in the script's own scope, in every injection mode
    for (const name of ['dbgvm', 'dbgfast', 'dbgpage']) {
      r = await c.call('eval', { code: 'greeting + " " + typeof mark + " " + mark.length', realm: { kind: 'userscript', script: name } });
      assert.match(r.text, new RegExp(`^\\[userscript:${name} \\((Violentmonkey|fast mode)\\)\\] \\(string\\) "hi from ${name} function 1"`), r.text);
    }
    r = await c.call('eval', { code: 'let x = greeting.length; x * 2', realm: { kind: 'userscript', script: 'scripts/dbgvm.user.js' } });
    assert.match(r.text, /\(number\) 26/);
    r = await c.call('eval', { code: 'nope.x', realm: { kind: 'userscript', script: 'dbgfast' } });
    assert.match(r.text, /EVAL_EXCEPTION[\s\S]*nope is not defined \(in userscript:dbgfast \(fast mode\)\)/);
    // breakpoints: file line 10 = "el.setAttribute(...)"
    r = await c.call('bp_set', { location: { script: 'scripts/dbgvm.user.js', line: 10 } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /set bp\d+ scripts\/dbgvm\.user\.js:10 \(moz-extension:\/\/[^)]+%20dbgvm\.user\.js#\d+:\d+:\d+\)/);
    r = await c.call('bp_set', { location: { script: 'dbgfast', line: 9 } });
    assert.match(r.text, /NOT_DEBUGGABLE[\s\S]*fast mode/);
    await c.call('navigate', { url: 'reload' });
    r = await pausedState(c);
    assert.match(r.text, /^paused \(breakpoint bp\d+\) in mark at scripts\/dbgvm\.user\.js:10 /);
    assert.match(r.text, />\s+10 \|\s+el\.setAttribute\('data-dbgvm/);
    assert.match(r.text, /el = <html/);
    r = await c.call('eval_paused', { code: 'greeting' });
    assert.match(r.text, /"hi from dbgvm"/);
    await c.call('resume', {});
    await c.call('bp_remove', { id: 'all' });
  });

  it('workers: a dedicated worker\'s top level (breakpoint set before it exists), its handler, shared and service workers', async () => {
    PAGES['/wk.html'] = `<!doctype html><title>wk</title><script>
      window.w = new Worker('/wk.js');
      w.onmessage = (e) => { document.title = 'dedicated ' + e.data; };
      window.sw = new SharedWorker('/shw.js');
      sw.port.onmessage = (e) => { document.title = 'shared ' + e.data; };
      window.reg = navigator.serviceWorker.register('/svw.js');
      navigator.serviceWorker.onmessage = (e) => { document.title = 'service ' + e.data; };
    </script>`;
    PAGES['/wk.js'] = 'let count = 0;\nconst startedAt = Date.now();\nfunction handle(x) {\n  count += x;\n  return count * 2;\n}\nonmessage = (e) => postMessage(handle(e.data));\n';
    PAGES['/shw.js'] = 'let seen = 0;\nonconnect = (e) => {\n  const port = e.ports[0];\n  port.onmessage = (m) => {\n    seen += m.data;\n    port.postMessage(seen);\n  };\n};\n';
    PAGES['/svw.js'] = 'self.addEventListener("message", (e) => {\n  const v = e.data * 3;\n  e.source.postMessage(v);\n});\n';
    await c.call('navigate', { url: 'about:blank' });
    // before the worker exists: the column comes from compiling the fetched source (Firefox needs a breakable one)
    let r = await c.call('bp_set', { location: { url: fx.url('/wk.js'), line: 2 } });
    assert.match(r.text, /set bp\d+ http:\/\/127\.0\.0\.1:\d+\/wk\.js:2:18 · pending/, r.text);
    await c.call('navigate', { url: fx.url('/wk.html') });
    r = await pausedState(c);
    assert.match(r.text, /paused \(breakpoint bp\d+\) in \(top level\) at http:\/\/127\.0\.0\.1:\d+\/wk\.js:2:18/, r.text);
    assert.match(r.text, /global: count = 0/);
    await c.call('resume', {});
    await c.call('bp_remove', { id: 'all' });
    // a running worker's handler
    await c.call('bp_set', { location: { url: 'wk.js', line: 4 } });
    await c.call('eval', { code: 'w.postMessage(5)' });
    r = await pausedState(c);
    assert.match(r.text, /in handle at .*\/wk\.js:4:2/, r.text);
    r = await c.call('eval_paused', { code: 'x + count' });
    assert.match(r.text, /\(number\) 5/, r.text);
    await c.call('resume', {});
    assert.match(await title(), /dedicated 10/);
    // shared worker
    await c.call('bp_set', { location: { url: fx.url('/shw.js'), line: 5 } });
    await c.call('eval', { code: 'sw.port.postMessage(3)' });
    r = await pausedState(c);
    assert.match(r.text, /in onconnect\/port\.onmessage at .*\/shw\.js:5:4/, r.text);
    await c.call('resume', {});
    // service worker
    await c.call('eval', { code: '(await navigator.serviceWorker.ready).active.state' });
    await c.call('bp_set', { location: { url: fx.url('/svw.js'), line: 2 } });
    await c.call('eval', { code: '(await navigator.serviceWorker.ready).active.postMessage(7); "sent"' });
    r = await pausedState(c);
    assert.match(r.text, /at .*\/svw\.js:2:\d+/, r.text);
    await c.call('resume', {});
    assert.match(await title(), /service 21/);
    await c.call('bp_remove', { id: 'all' });
  });

  it('auto-resume after the pause timeout', async () => {
    await c.call('navigate', { url: fx.url('/dbg.html') });
    await c.call('bp_set', { location: { url: 'dbg.html', line: 4 } });
    const r = await c.call('eval', { code: 'setTimeout(() => work(3)); 1' });
    assert.ok(!r.isError);
    await new Promise((res) => setTimeout(res, 9500));
    assert.match(await title(), /"work 6"/);
    assert.match((await c.call('debugger_state', {})).text, /not paused/);
    await c.call('bp_remove', { id: 'all' });
    assert.match((await c.call('bp_list', {})).text, /debugger not started/);
  });
});

// Breakpoints live in the debugger's RDP connection, which a backend hot reload closes; the run state keeps them
// and the next backend sets them again. The reload is done as the proxy does it: detach notice to the old backend
// (BiDi session ends, Firefox keeps running), then a new backend of the same proxy (same FIREFOX_USE_PROXY_PID).
describe('breakpoints across a backend reload', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  const env = () => ({ ...h.env, FIREFOX_USE_PROXY_PID: String(process.pid), FIREFOX_USE_PAUSE_TIMEOUT_MS: '8000' });
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(env()); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('a line breakpoint and pause-on-exceptions survive the reload and still pause', async () => {
    await c.call('navigate', { url: fx.url('/dbg.html') });
    let r = await c.call('bp_set', { location: { url: 'dbg.html', line: 4 }, condition: 'n === 21' });
    assert.match(r.text, /set bp1 /);
    await c.call('pause_on_exceptions', { mode: 'uncaught' });
    const exited = new Promise((res) => c.child!.once('exit', res));
    c.notify('notifications/firefox-use/detach');
    await exited;
    c = await startServer(env());
    const page = await c.call('read_page', {});
    assert.match(page.text, /note: debugger: re-applied 1 breakpoint\(s\) and pause on exceptions "uncaught" after a backend reload/, page.text);
    r = await c.call('click', { target: refFor(page.text, 'button', 'Work') });
    assert.match(r.text, /^PAUSED during click: paused \(breakpoint bp1\) in work at http:\/\/127\.0\.0\.1:\d+\/dbg\.html:4:2/, r.text);
    r = await c.call('eval_paused', { code: 'local' });
    assert.match(r.text, /\(number\) 42/);
    await c.call('resume', {});
    r = await c.call('bp_list', {});
    assert.match(r.text, /bp1 .*dbg\.html:4:2.*n === 21/);
    assert.match(r.text, /pause on exceptions: uncaught/);
    r = await c.call('bp_set', { location: { url: 'dbg.html', line: 8 } });
    assert.match(r.text, /set bp2 /, 'ids continue');
    await c.call('bp_remove', { id: 'all' });
    // nothing left to carry over
    const exited2 = new Promise((res) => c.child!.once('exit', res));
    c.notify('notifications/firefox-use/detach');
    await exited2;
    c = await startServer(env());
    r = await c.call('bp_list', {});
    assert.match(r.text, /debugger not started/);
  });
});
