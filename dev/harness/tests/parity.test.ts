// Chrome-parity additions: batch, screenshot-space coordinates, region zoom, hover/scroll/scroll_to,
// dialog reporting, handoff (headless refusal), launch-time add-on sync
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, PERSONAL_RUN, makeHome, refFor, startFixtures, startServer } from './helpers.ts';

describe('parity tools', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  const text = async () => (await c.call('get_page_text', {})).text;
  const title = async () => (await c.call('tabs_list', {})).text;

  it('batch runs steps in order, interleaves images, stops on error', async () => {
    let r = await c.call('batch', { actions: [
      { tool: 'navigate', args: { url: fx.url('/form.html') } },
      { tool: 'screenshot', args: { scale: 0.5 } },
      { tool: 'find', args: { query: 'Next page' } },
    ] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /batch: 3\/3 step\(s\) ran/);
    assert.match(r.text, /#1 navigate: Form fixture/);
    assert.match(r.text, /#3 find: .*link "Next page"/s);
    assert.equal(r.images.length, 1);
    r = await c.call('batch', { actions: [{ tool: 'navigate', args: {} }, { tool: 'tabs_list', args: {} }] });
    assert.match(r.text, /1\/2 step\(s\) ran, 1 failed/);
    assert.match(r.text, /#1 navigate \[ERROR\]: error: BAD_ARGS/);
    r = await c.call('batch', { actions: [{ tool: 'batch', args: {} }, { tool: 'tabs_list', args: {} }], stop_on_error: false });
    assert.match(r.text, /cannot be nested/);
    assert.match(r.text, /#2 tabs_list/);
  });

  it('{x, y} are screenshot pixels by default; coords:"viewport" opts out', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    await c.call('screenshot', { scale: 0.5 });
    let r = await c.call('click', { target: { x: 150, y: 3 } });
    assert.match(r.text, /= viewport \(300, 6\)/, r.text);
    assert.match(await text(), /\[300,6,true\]/);
    r = await c.call('click', { target: { x: 410, y: 4 }, coords: 'viewport' });
    assert.match(await text(), /\[410,4,true\]/);
    // a new navigation forgets the mapping: back to viewport px
    await c.call('navigate', { url: fx.url('/form.html') });
    await c.call('click', { target: { x: 222, y: 5 } });
    assert.match(await text(), /\[222,5,true\]/);
  });

  it('region zoom captures part of the previous screenshot at full resolution', async () => {
    // an even viewport, so the half-scale image maps exactly (claude-dev copies keep the user's window size)
    await c.call('resize', { width: 1200, height: 700 });
    await c.call('navigate', { url: fx.url('/hover.html') });
    await c.call('screenshot', { scale: 0.5 });
    const r = await c.call('screenshot', { region: [50, 50, 100, 75] }); // = css box (100,100) 100x50: the grey div
    assert.match(r.text, /^100x50/, r.text);
    // coordinates now refer to the zoomed image: (50, 25) is the middle of the div
    await c.call('hover', { target: { x: 50, y: 25 } });
    assert.match(await title(), /hovered/);
    await c.call('resize', {});
  });

  it('hover, scroll, scroll_to', async () => {
    await c.call('navigate', { url: fx.url('/hover.html') });
    let r = await c.call('hover', { target: { x: 150, y: 125 } });
    assert.match(r.text, /hovering/);
    assert.match(await title(), /hovered/);
    await c.call('navigate', { url: fx.url('/form.html') });
    r = await c.call('scroll', { direction: 'down', amount: 3 });
    assert.match(r.text, /page scroll now \(0, 300\)/, r.text);
    const p = await c.call('read_page', {});
    r = await c.call('scroll_to', { ref: refFor(p.text, 'button', 'Far button') });
    assert.match(r.text, /now at viewport/);
  });

  it('a popup window opened by an agent tab joins the session (agent window, group, dialogs handled)', { skip: PERSONAL_RUN && 'personal mode cannot move windows (no chrome access)' }, async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    await c.call('eval', { code: `window.addEventListener('message', (e) => { document.title = 'from popup ' + e.data; }); window.open(${JSON.stringify(fx.url('/dialog.html'))}, 'pop', 'width=400,height=300'); 1` });
    let r = await c.call('tabs_list', {});
    for (let i = 0; i < 20 && !/"Dialog"/.test(r.text); i++) { await new Promise((res) => setTimeout(res, 150)); r = await c.call('tabs_list', {}); }
    const pop = /tab (\d+): "Dialog"/.exec(r.text);
    assert.ok(pop, `popup is an agent tab:
${r.text}`);
    assert.doesNotMatch((await c.call('tabs_list', { include_user: true })).text, /USER TAB.*dialog\.html/);
    // window.opener still works after the move; the popup's dialogs are this session's
    await c.call('eval', { tab: Number(pop![1]), code: 'window.opener.postMessage("ok", "*")' });
    assert.match((await c.call('eval', { code: 'document.title' })).text, /from popup ok/);
    const p = await c.call('read_page', { tab: Number(pop![1]) });
    r = await c.call('click', { tab: Number(pop![1]), target: refFor(p.text, 'button', 'Alert') });
    assert.match(r.text, /dialog: alert "hello from page" \(dismissed\)/, r.text);
    await c.call('tabs_close', { tab: Number(pop![1]) });
  });

  it('dialogs opened during a call are reported', async () => {
    await c.call('navigate', { url: fx.url('/dialog.html') });
    const p = await c.call('read_page', {});
    const r = await c.call('click', { target: refFor(p.text, 'button', 'Alert') });
    assert.match(r.text, /dialog: alert "hello from page" \(dismissed\)/, r.text);
  });

  it('ff_handoff refuses on a headless Firefox', async () => {
    const r = await c.call('ff_handoff', { reason: 'log in' });
    assert.ok(r.isError);
    assert.match(r.text, /HEADLESS/);
  });
});

describe('launch-time add-on sync from the main profile', { skip: PERSONAL_RUN && 'claude-dev only (personal mode has no add-on work)' }, () => {
  it('installs the main profile\'s copy when it is newer (pipeline check with a fake main profile)', async (t) => {
    let staged = '';
    const h = makeHome((cfg, home) => {
      staged = path.join(cfg.addonsDir, 'uBlock0@raymondhill.net.xpi');
      const main = path.join(home, 'fake-main');
      fs.mkdirSync(path.join(main, 'extensions'), { recursive: true });
      if (fs.existsSync(staged)) fs.copyFileSync(staged, path.join(main, 'extensions', 'uBlock0@raymondhill.net.xpi'));
      fs.writeFileSync(path.join(main, 'extensions.json'), JSON.stringify({ addons: [
        { id: 'uBlock0@raymondhill.net', version: '99.0', path: path.join(main, 'extensions', 'uBlock0@raymondhill.net.xpi') },
        { id: '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}', version: '0.1', path: path.join(main, 'extensions', 'missing.xpi') },
      ] }));
      cfg.mainProfile = main;
    });
    if (!fs.existsSync(staged)) { h.cleanup(); t.skip('setup has not staged uBlock Origin'); return; }
    const c = await startServer(h.env);
    try {
      const r = await c.call('ff_launch', {});
      assert.ok(!r.isError, r.text);
      assert.match(r.text, /updated uBlock0@raymondhill\.net [\d.]+ -> 99\.0 \(synced from your main profile\)/, r.text);
      assert.doesNotMatch(r.text, /aecec67f.*synced/, 'never downgrades or uses a missing file');
    } finally {
      await c.close(); h.cleanup();
    }
  });
});
