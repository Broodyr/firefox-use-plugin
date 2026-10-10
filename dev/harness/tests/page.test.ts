// parity tools: navigate, read_page, find, get_page_text, screenshot, form_input, resize
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { McpClient, makeHome, refFor, startFixtures, startServer } from './helpers.ts';

describe('pages', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('navigate: load, reload, back/forward, networkidle', async () => {
    let r = await c.call('navigate', { url: fx.url('/form.html') });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Form fixture — http:\/\/127\.0\.0\.1:\d+\/form\.html/);
    assert.match(r.text, /auditId: a\d{8}-/);
    r = await c.call('navigate', { url: fx.url('/page2.html'), wait: 'interactive' });
    assert.match(r.text, /Page two/);
    r = await c.call('navigate', { url: 'back' });
    assert.match(r.text, /Form fixture/, r.text);
    r = await c.call('navigate', { url: 'forward' });
    assert.match(r.text, /Page two/, r.text);
    r = await c.call('navigate', { url: 'reload', bypass_cache: true });
    assert.match(r.text, /Page two/);
    r = await c.call('navigate', { url: fx.url('/idle.html'), wait: 'networkidle' });
    assert.match(r.text, /fetched slow/, r.text);
  });

  it('navigate refuses about:config', async () => {
    const r = await c.call('navigate', { url: 'about:config' });
    assert.ok(r.isError);
    assert.match(r.text, /URL_REFUSED/);
  });

  it('read_page: interactive refs, all, root, since-diff', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const r = await c.call('read_page', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /snap_\d+/);
    refFor(r.text, 'button', 'Go');
    refFor(r.text, 'link', 'Next page');
    refFor(r.text, 'textbox', 'Name');
    refFor(r.text, 'checkbox', 'Agree');
    assert.match(r.text, /heading h1 "Fixture form"/);
    assert.match(r.text, /"Far button".*\(offscreen\)/);
    assert.match(r.text, /value="<masked>"/, 'password value masked');
    assert.doesNotMatch(r.text, /hunter2/);
    const all = await c.call('read_page', { filter: 'all' });
    assert.match(all.text, /far away/);
    const snap = /(snap_\d+)/.exec(r.text)![1];
    await c.call('navigate', { url: fx.url('/dynamic.html') });
    const d1 = await c.call('read_page', {});
    const s1 = /(snap_\d+)/.exec(d1.text)![1];
    await c.call('click', { target: refFor(d1.text, 'button', 'Add') });
    const d2 = await c.call('read_page', { since: s1 });
    assert.match(d2.text, /\+ \[ref_\d+\] button "Added"/, d2.text);
    const stale = await c.call('read_page', { since: snap });
    assert.match(stale.text, /unknown or expired/);
    const root = await c.call('read_page', { root: refFor(d1.text, 'button', 'Add') });
    assert.match(root.text, /1 of \d+ nodes/);
  });

  it('find', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const r = await c.call('find', { query: 'next' });
    assert.match(r.text, /link "Next page"/);
    const none = await c.call('find', { query: 'zzzz-nothing' });
    assert.match(none.text, /no match/);
  });

  it('get_page_text prefers <main> and masks secrets', async () => {
    await c.call('navigate', { url: fx.url('/text.html') });
    const r = await c.call('get_page_text', {});
    assert.match(r.text, /Body paragraph one/);
    assert.doesNotMatch(r.text, /NAV LINKS/);
    assert.match(r.text, /Bearer <masked>/);
    assert.match(r.text, /token=<masked>/);
    assert.doesNotMatch(r.text, /SUPERSECRET123|abcdefghijklmnopqrstuv/);
  });

  it('form_input: text, select, checkbox, textarea, contenteditable; refuses passwords', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const p = await c.call('read_page', {});
    let r = await c.call('form_input', { ref: refFor(p.text, 'textbox', 'Name'), value: 'xyz' });
    assert.ok(!r.isError, r.text);
    let t = await c.call('get_page_text', {});
    assert.match(t.text, /input:xyz/);
    r = await c.call('form_input', { ref: refFor(p.text, 'combobox', 'Pick'), value: 'Alpha' });
    assert.match(r.text, /selected Alpha/);
    r = await c.call('form_input', { ref: refFor(p.text, 'checkbox', 'Agree'), value: true });
    assert.match(r.text, /checked/);
    t = await c.call('get_page_text', {});
    assert.match(t.text, /agree:true/);
    r = await c.call('form_input', { ref: refFor(p.text, 'textbox', 'Notes'), value: 'multi\nline' });
    assert.ok(!r.isError, r.text);
    r = await c.call('form_input', { ref: refFor(p.text, 'textbox', 'Editor'), value: 'edited' });
    assert.ok(!r.isError, r.text);
    const after = await c.call('read_page', {});
    assert.match(after.text, /textbox "Name" value="xyz"/);
    const pw = /\[(ref_\d+)\] [^\n]*"Secret"/.exec(p.text);
    assert.ok(pw, p.text);
    r = await c.call('form_input', { ref: pw![1], value: 'x' });
    assert.ok(r.isError);
    assert.match(r.text, /password/);
  });

  it('screenshot: viewport, element, full page, password masking', async () => {
    await c.call('navigate', { url: fx.url('/pw.html') });
    const r = await c.call('screenshot', {});
    assert.ok(!r.isError, r.text);
    assert.equal(r.images.length, 1);
    assert.match(r.text, /1 password field\(s\) masked/);
    const file = /saved: (.+\.png)/.exec(r.text)![1];
    assert.ok(fs.existsSync(file));
    const img = PNG.sync.read(Buffer.from(r.images[0].data, 'base64'));
    const px = (x: number, y: number) => img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
    assert.deepEqual([...px(100, 30)], [0, 0, 0], 'password field blacked out');
    assert.deepEqual([...px(400, 300)], [255, 255, 255]);
    await c.call('navigate', { url: fx.url('/form.html') });
    const full = await c.call('screenshot', { full_page: true });
    const fullDims = /^(\d+)x(\d+)/.exec(full.text)!;
    assert.ok(Number(fullDims[2]) > 1500, full.text);
    const p = await c.call('read_page', {});
    const el = await c.call('screenshot', { ref: refFor(p.text, 'button', 'Go') });
    const dims = /^(\d+)x(\d+)/.exec(el.text)!;
    assert.ok(Number(dims[1]) < 200 && Number(dims[2]) < 100, el.text);
    const small = await c.call('screenshot', { scale: 0.5 });
    assert.match(small.text, /returned at/);
  });

  it('resize', async () => {
    let r = await c.call('resize', { width: 500, height: 400 });
    assert.match(r.text, /500x400/);
    const p = await c.call('read_page', {});
    assert.match(p.text, /viewport 500x400/);
    r = await c.call('resize', {});
    assert.match(r.text, /reset/);
  });
});
