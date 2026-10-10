// realms and evaluation: realms_list, eval in every realm kind, script-mode completion values, Xray labels,
// inspect_xray.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, installTestExt, makeHome, startFixtures, startServer } from './helpers.ts';

describe('realms', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); await installTestExt(c, h.workspace); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('realms_list: page, frames, content sandboxes, extension backgrounds, privileged', async () => {
    await c.call('navigate', { url: fx.url('/frames.html') });
    const r = await c.call('realms_list', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /\{kind:"page"\}  http:\/\/127\.0\.0\.1:\d+\/frames\.html/);
    assert.match(r.text, /\{kind:"page", frame:0\}  http:\/\/127\.0\.0\.1:\d+\/page2\.html/);
    assert.match(r.text, /\{kind:"content", extension:"test-ext@firefox-use"\}/);
    assert.match(r.text, /\{kind:"content", extension:"ubo"\}  uBlock Origin content-script sandbox/);
    assert.match(r.text, /\{kind:"extension", extension:"vm"\}  Violentmonkey background/);
    assert.match(r.text, /\{kind:"privileged"\}/);
  });

  it('eval: page (expression, body with await, script mode), frames, errors', async () => {
    let r = await c.call('eval', { code: 'document.title' });
    assert.match(r.text, /^\[page\] \(string\) "Frames"/);
    r = await c.call('eval', { code: 'await new Promise(r => setTimeout(r, 20)); return [1, "two", { three: 3 }]' });
    assert.match(r.text, /\(array\)/);
    assert.match(r.text, /"three": 3/);
    r = await c.call('eval', { code: 'let a = 20; a + 1' });
    assert.match(r.text, /\(number\) 21/);
    // a `return` nested in a function doesn't make the code a function body (was "[undefined]")
    r = await c.call('eval', { code: '(() => { const a = 40; return a + 2; })()' });
    assert.match(r.text, /\(number\) 42/);
    r = await c.call('eval', { code: 'new Promise((res) => setTimeout(res, 10)).then(() => { return "late"; })' });
    assert.match(r.text, /\(string\) "late"/);
    r = await c.call('eval', { code: 'const f = () => { return 7; }; f()' });
    assert.match(r.text, /\(number\) 7/);
    r = await c.call('eval', { code: 'document.querySelector("h1").textContent', frame: 0 });
    assert.match(r.text, /\[page frame 0\] \(string\) "Second"/);
    r = await c.call('eval', { code: 'document.title', frame: 'page2' });
    assert.match(r.text, /"Page two"/);
    r = await c.call('eval', { code: '[document.body, undefined, NaN, () => 1, new Map([[1, 2]])]' });
    assert.match(r.text, /"<body>"/);
    assert.match(r.text, /"\[undefined\]"/);
    assert.match(r.text, /"\[function anonymous\]"/);
    assert.match(r.text, /"\[Map\]"/);
    r = await c.call('eval', { code: 'null.x' });
    assert.ok(r.isError);
    assert.match(r.text, /EVAL_EXCEPTION/);
    r = await c.call('eval', { code: 'document.title', frame: 7 });
    assert.match(r.text, /FRAME_NOT_FOUND/);
  });

  it('eval: content-script sandbox with Xray labels and waive; extension background; privileged', async () => {
    await c.call('navigate', { url: fx.url('/xray.html') });
    let r = await c.call('eval', { code: 'typeof csMarker + " " + typeof window.pageLib', realm: { kind: 'content', extension: 'test-ext' } });
    assert.match(r.text, /\[content:firefox-use test extension\] \(string\) "string undefined"/);
    r = await c.call('eval', { code: 'document.body', realm: { kind: 'content', extension: 'test-ext' } });
    assert.match(r.text, /Xray/);
    r = await c.call('eval', { code: 'window.wrappedJSObject.pageLib', realm: { kind: 'content', extension: 'test-ext' }, xray: 'waive' });
    assert.match(r.text, /"version": 3/);
    r = await c.call('eval', { code: 'bgMarker', realm: { kind: 'extension', extension: 'test-ext' } });
    assert.match(r.text, /\[extension:firefox-use test extension background\] \(string\) "background-realm"/);
    r = await c.call('eval', { code: 'typeof vAPI', realm: { kind: 'extension', extension: 'ubo' } });
    assert.match(r.text, /"object"/);
    r = await c.call('eval', { code: 'Services.appinfo.name', realm: { kind: 'privileged' } });
    assert.match(r.text, /\[privileged\] \(string\) "Firefox"/);
    r = await c.call('eval', { code: 'Services.logins.findLogins("x", "", "")', realm: { kind: 'privileged' } });
    assert.match(r.text, /DENIED/);
    r = await c.call('eval', { code: '1', realm: { kind: 'content', extension: 'no-such-ext' } });
    assert.match(r.text, /EXTENSION_NOT_FOUND/);
  });

  it('inspect_xray explains page expandos hidden by the Xray view', async () => {
    await c.call('navigate', { url: fx.url('/xray.html') });
    const r = await c.call('inspect_xray', { expr: 'window.pageLib', realm: { kind: 'content', extension: 'test-ext' } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /sandbox \(Xray view\): typeof undefined/);
    assert.match(r.text, /wrappedJSObject[^\n]*typeof object/);
    assert.match(r.text, /page realm: typeof object/);
    assert.match(r.text, /unsafeWindow\.pageLib/);
  });
});
