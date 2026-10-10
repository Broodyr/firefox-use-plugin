// scope approvals and snapshots/rollback on a named (lasting) test profile: scope enforcement,
// automatic checkpoints, snapshot/diff/restore/undo, cold snapshot, restore after a kill switch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, NAMED_ARGS, installTestExt, makeHome, namedProfile, startFixtures } from './helpers.ts';

describe('scope and snapshots', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  const env = () => ({ ...h.env, FIREFOX_USE_NO_COLD: '1' });
  const named = async () => { const x = McpClient.spawnServer(NAMED_ARGS, env()); await x.initialize(); return x; };
  before(async () => { h = makeHome(namedProfile); fx = await startFixtures(); c = await named(); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('launch checkpoint; lasting changes need a scope; first change in scope takes a checkpoint', async () => {
    let r = await c.call('ff_launch', {});
    assert.match(r.text, /note: checkpoint s\d{8}-\d{6}-\w+ \(at launch\)/);
    r = await c.call('addons_install_local', { path: 'nowhere' });
    assert.match(r.text, /SCOPE_REQUIRED|FILE_NOT_FOUND/);
    r = await c.call('ff_prefs_set', { values: { 'browser.cf.snap': 1 } });
    assert.match(r.text, /SCOPE_REQUIRED[\s\S]*scope_set/);
    r = await c.call('scope_set', { description: 'prefs and the test extension in test-named', areas: ['prefs', 'addons', 'ext:test-ext@firefox-use', 'restore'], user_said: 'ok, go ahead' });
    assert.ok(!r.isError, r.text);
    r = await c.call('scope_set', { description: 'bad areas', areas: ['everything'], user_said: 'yes' });
    assert.match(r.text, /unknown area/);
    await installTestExt(c, h.workspace);
    r = await c.call('scope_show', {});
    assert.match(r.text, /checkpoint: s\d{8}/);
    r = await c.call('ext_storage_set', { extension: 'ubo', items: { x: 1 } });
    assert.match(r.text, /SCOPE_REQUIRED[\s\S]*outside the approved scope/);
  });

  it('snapshot, diff, undo, restore', async () => {
    let r = await c.call('snapshot', { label: 'base' });
    const base = /snapshot (s\S+)/.exec(r.text)![1];
    await c.call('ext_storage_set', { extension: 'test-ext', items: { greeting: 'changed', extra: 1 } });
    await c.call('ff_prefs_set', { values: { 'browser.cf.snap': 5 } });
    r = await c.call('snapshot_diff', { a: base });
    assert.match(r.text, /pref browser\.cf\.snap: \(absent\) -> 5/);
    assert.match(r.text, /storage\.local\.greeting: "hi" -> "changed"/);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /ff_prefs_set:\n  pref browser\.cf\.snap -> "\(default\)"/);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /ext_storage_set:/);
    assert.match(r.text, /storage\.local\.greeting -> "hi"/);
    assert.match(r.text, /storage\.local\.extra -> \(removed\)/);
    r = await c.call('snapshot_diff', { a: base });
    assert.match(r.text, /no differences/);
    await c.call('ext_storage_set', { extension: 'test-ext', items: { greeting: 'again' } });
    r = await c.call('restore', { id: base, parts: ['ext_storage:test-ext@firefox-use'] });
    assert.match(r.text, /storage\.local: 1 set, 0 removed\nreloaded firefox-use test extension/);
    r = await c.call('ext_storage_get', { extension: 'test-ext', keys: ['greeting'] });
    assert.match(r.text, /"hi"/);
    r = await c.call('snapshot_list', {});
    assert.match(r.text, /\[auto\] auto: at launch/);
    assert.match(r.text, /\[auto\] auto: before restore/);
    assert.match(r.text, new RegExp(`${base} warm .* base`));
  });

  it('snapshot_cold copies the stopped profile and Firefox comes back with the agent tab', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    const r = await c.call('snapshot_cold', { label: 'cold test' });
    assert.ok(!r.isError, r.text);
    const dir = /: (\S+)$/m.exec(r.text)![1];
    assert.ok(fs.existsSync(path.join(dir, 'profile', 'prefs.js')), dir);
    const t = await c.call('tabs_list', {});
    assert.match(t.text, /Page two/);
  });

  it('kill switch -> next cold start restores the latest checkpoint', async () => {
    await c.call('snapshot', { label: 'before kill' });
    await c.call('ext_storage_set', { extension: 'test-ext', items: { greeting: 'after-checkpoint' } });
    await c.call('ff_kill', {});
    await c.close();
    fs.writeFileSync(path.join(h.home, 'token'), 'test-token-again');
    c = await named();
    const r = await c.call('ff_launch', {});
    assert.match(r.text, /kill switch was engaged \(ff_kill at [^)]+\): restored checkpoint/, r.text);
    assert.match(r.text, /checkpoint s\S+ \(at launch\)/);
  });

  it('restore names temporary add-ons a clean restart removed, with their source', async () => {
    await c.call('scope_set', { description: 'add-ons and restores in test-named', areas: ['restore', 'addons'], user_said: 'ok' });
    await installTestExt(c, h.workspace);
    let r = await c.call('addons_list', {});
    assert.match(r.text, /firefox-use test extension 1\.0 — test-ext@firefox-use \[temporary\]/);
    r = await c.call('snapshot', { label: 'with temp add-on' });
    const id = /snapshot (s\S+)/.exec(r.text)![1];
    // (a kill counts as a crash: Firefox keeps temporary add-ons then; a clean shutdown removes them)
    r = await c.call('ff_restart', {});
    assert.ok(!r.isError, r.text);
    r = await c.call('restore', { id, parts: ['addons'] });
    assert.match(r.text, /add-on firefox-use test extension \(temporary\) is not installed: reinstall it with addons_install_local\(".*test-ext"\)/, r.text);
  });
});
