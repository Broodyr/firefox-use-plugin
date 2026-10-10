// lifecycle, tabs, audit, masking, structured errors, kill switch
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

describe('lifecycle, tabs, audit, safety', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('ff_status before launch does not start Firefox', async () => {
    const r = await c.call('ff_status', {});
    assert.match(r.text, /not connected/);
    assert.match(r.text, /session token: present/);
  });

  it('ff_launch, ff_status', async () => {
    const r = await c.call('ff_launch', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Firefox \d+/);
    assert.match(r.text, /agent tabs: 1/);
    const s = await c.call('ff_status', { detail: 'normal' });
    assert.match(s.text, /profile dir:/);
    assert.match(s.text, /BiDi ok/);
  });

  it('tabs_create, tabs_list, tabs_select, tabs_close (last tab is kept)', async () => {
    let r = await c.call('tabs_create', { url: fx.url('/page2.html') });
    assert.match(r.text, /tab (\d+) created/);
    const t2 = Number(/tab (\d+) created/.exec(r.text)![1]);
    r = await c.call('tabs_list', {});
    assert.match(r.text, new RegExp(`\\* tab ${t2}: "Page two"`));
    const t1 = Number(/ tab (\d+):/.exec(r.text)![1]);
    r = await c.call('tabs_select', { tab: t1 });
    assert.match(r.text, new RegExp(`current tab: ${t1}`));
    const nav = await c.call('navigate', { url: fx.url('/form.html') });
    assert.match(nav.text, /Form fixture/);
    r = await c.call('tabs_list', {});
    assert.match(r.text, new RegExp(`\\* tab ${t1}: "Form fixture"`));
    r = await c.call('tabs_close', { tab: t2 });
    assert.match(r.text, /closed/);
    r = await c.call('tabs_close', { tab: t1 });
    assert.match(r.text, /blanked/);
    r = await c.call('tabs_select', { tab: 999 });
    assert.ok(r.isError);
    assert.match(r.text, /TAB_NOT_FOUND/);
  });

  it('ff_restart restores tabs', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    const r = await c.call('ff_restart', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /reopened 1 tab/);
    const l = await c.call('tabs_list', {});
    assert.match(l.text, /Page two/);
  });

  it('structured errors for bad arguments and unknown tools', async () => {
    let r = await c.call('navigate', {});
    assert.ok(r.isError);
    assert.match(r.text, /^error: BAD_ARGS/);
    assert.match(r.text, /auditId:/);
    r = await c.call('no_such_tool', {});
    assert.match(r.text, /UNKNOWN_TOOL/);
  });

  it('output cap (max_chars) truncates explicitly', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const r = await c.call('read_page', { filter: 'all', max_chars: 200 });
    assert.match(r.text, /\[truncated: showed \d+ of \d+ chars/);
  });

  it('audit log: every call recorded, args masked, writes flagged', async () => {
    await c.call('navigate', { url: fx.url('/text.html?session=abc123&q=1') });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(h.workspace, '.firefox-use', 'audit', `${day}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const nav = lines.filter((e) => e.tool === 'navigate').at(-1);
    assert.equal(nav.write, true);
    assert.match(nav.args.url, /session=<masked>/);
    assert.doesNotMatch(JSON.stringify(lines), /abc123/);
    assert.ok(lines.some((e) => e.status === 'error' && e.error.code === 'BAD_ARGS'));
    assert.ok(fs.existsSync(path.join(h.workspace, '.firefox-use', '.gitignore')));
    const show = await c.call('ff_audit_show', { since: '1h', tool: 'navigate' });
    assert.match(show.text, /navigate ok/);
    assert.match(show.text, /session=<masked>/);
  });

  it('ff_quit then lazy relaunch', async () => {
    let r = await c.call('ff_quit', {});
    assert.match(r.text, /quit/);
    r = await c.call('ff_status', {});
    assert.match(r.text, /not connected/);
    r = await c.call('navigate', { url: fx.url('/page2.html') });
    assert.ok(!r.isError, r.text);
  });

  it('ff_kill revokes the token and kills Firefox; tools then refuse', async () => {
    const s = await c.call('ff_status', { detail: 'normal' });
    const pid = Number(/pid (\d+)/.exec(s.text)![1]);
    const r = await c.call('ff_kill', {});
    assert.match(r.text, /Kill switch engaged/);
    assert.ok(!fs.existsSync(path.join(h.home, 'token')));
    await new Promise((res) => setTimeout(res, 500));
    assert.throws(() => process.kill(pid, 0));
    const after = await c.call('navigate', { url: fx.url('/page2.html') });
    assert.ok(after.isError);
    assert.match(after.text, /TOKEN_REVOKED/);
  });
});
