// input tools: click, type, key, drag, input, set_files
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, refFor, startFixtures, startServer } from './helpers.ts';

describe('input', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  const text = async () => (await c.call('get_page_text', {})).text;
  const title = async () => (await c.call('tabs_list', {})).text;

  it('click by ref is trusted; offscreen refs are scrolled into view; second "Go" is distinct', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const p = await c.call('read_page', {});
    let r = await c.call('click', { target: refFor(p.text, 'button', 'Go') });
    assert.ok(!r.isError, r.text);
    assert.match(await title(), /clicked 1/);
    assert.match(await text(), /,true\]/, 'isTrusted click');
    const second = [...p.text.matchAll(/\[(ref_\d+)\] button "Go"/g)][1][1];
    await c.call('click', { target: second });
    assert.match(await title(), /"second"/);
    r = await c.call('click', { target: refFor(p.text, 'button', 'Far button') });
    assert.ok(!r.isError, r.text);
    assert.match(await title(), /far clicked/);
  });

  it('click by coordinates, double click, modifiers', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    await c.call('click', { target: { x: 300, y: 5 }, modifiers: ['ctrl'] });
    assert.match(await text(), /\[300,5,ctrl,true\]/);
    const p = await c.call('read_page', {});
    await c.call('click', { target: refFor(p.text, 'button', 'Dbl'), count: 2 });
    assert.match(await title(), /double/);
  });

  it('click that navigates reports the new URL', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const p = await c.call('read_page', {});
    const r = await c.call('click', { target: refFor(p.text, 'link', 'Next page') });
    assert.match(r.text, /navigated to .*page2\.html/, r.text);
  });

  it('type into ref, key chords and named keys', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const p = await c.call('read_page', {});
    const name = refFor(p.text, 'textbox', 'Name');
    await c.call('click', { target: name });
    await c.call('key', { keys: 'ctrl+a Backspace' });
    let r = await c.call('type', { text: 'héllo', ref: name });
    assert.ok(!r.isError, r.text);
    assert.match(await text(), /input:héllo:true/);
    await c.call('key', { keys: 'shift+Tab ArrowDown', repeat: 2 });
    const t = await text();
    assert.match(t, /\^a,/);
    assert.match(t, /\+Tab,/);
    assert.match(t, /ArrowDown,.*ArrowDown,/);
    r = await c.call('key', { keys: 'NotAKey' });
    assert.ok(r.isError);
    assert.match(r.text, /BAD_KEY/);
  });

  it('type refuses password fields', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const p = await c.call('read_page', {});
    const pw = /\[(ref_\d+)\] [^\n]*"Secret"/.exec(p.text)![1];
    const r = await c.call('type', { text: 'x', ref: pw });
    assert.ok(r.isError);
    assert.match(r.text, /password/);
  });

  it('drag and raw input', async () => {
    await c.call('navigate', { url: fx.url('/drag.html') });
    await c.call('drag', { from: { x: 50, y: 50 }, to: { x: 250, y: 150 } });
    assert.match(await title(), /dropped 220,120/);
    await c.call('navigate', { url: fx.url('/form.html') });
    const r = await c.call('input', { actions: [{ type: 'pointer', id: 'm', actions: [{ type: 'pointerMove', x: 400, y: 7 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    assert.ok(!r.isError, r.text);
    assert.match(await text(), /\[400,7,true\]/);
  });

  it('set_files: workspace files only', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const f = path.join(h.workspace, 'upload.txt');
    fs.writeFileSync(f, 'hello');
    const p = await c.call('read_page', {});
    const btn = /\[(ref_\d+)\] button "Upload/.exec(p.text)![1];
    let r = await c.call('set_files', { ref: btn, paths: ['upload.txt'] });
    assert.ok(!r.isError, r.text);
    assert.match(await title(), /files:upload\.txt/);
    r = await c.call('set_files', { ref: btn, paths: ['C:/Windows/win.ini'] });
    assert.ok(r.isError);
    assert.match(r.text, /PATH_REFUSED/);
  });
});
