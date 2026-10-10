// uBO adapter: status, My filters (lint, add/remove, undo), logger + wait_for_ubo_event, filter and
// scriptlet testing without saving, advanced settings, lists, backup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

describe('uBO adapter', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  const pageEval = async (code: string) => (await c.call('eval', { code })).text;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('ubo_status and My filters: lint refuses bad lines, add applies live, remove', async () => {
    let r = await c.call('ubo_status', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /uBlock Origin 1\.\d+/);
    assert.match(r.text, /My filters: enabled/);
    assert.match(r.text, /userResourcesLocation: unset/);
    r = await c.call('ubo_filters_add', { lines: ['127.0.0.1##.ad', '127.0.0.1##.box:has-text('] });
    assert.ok(r.isError, r.text);
    assert.match(r.text, /FILTER_INVALID[\s\S]*line 2: Invalid filter: "\)" is expected[\s\S]*— 127\.0\.0\.1##\.box:has-text\(/);
    r = await c.call('ubo_filters_add', { lines: ['127.0.0.1##.ad', '||127.0.0.1^*/ads/'] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /saved and applied in \d+ ms\n\+ 127\.0\.0\.1##\.ad\n\+ \|\|127\.0\.0\.1\^\*\/ads\//);
    r = await c.call('ubo_filters_add', { lines: ['127.0.0.1##.ad'] });
    assert.match(r.text, /unchanged/);
    await c.call('navigate', { url: fx.url('/ubo.html') });
    assert.match(await pageEval('getComputedStyle(document.querySelector(".ad")).display'), /"none"/);
    r = await c.call('ubo_filters_get', { lint: true });
    assert.match(r.text, /127\.0\.0\.1##\.ad[\s\S]*lint: no errors/);
  });

  it('ubo_logger captures verdicts with filters; wait_for_ubo_event', async () => {
    let r = await c.call('ubo_logger', {});
    assert.match(r.text, /logger started/);
    const cur = /cursor: (u\d+)/.exec(r.text)![1];
    await c.call('navigate', { url: 'reload' });
    r = await c.call('wait_for_ubo_event', { pattern: '/ads/banner', verdict: 'blocked', since: cur, timeout_ms: 8000 });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /\[tab\d+\] network blocked image \|\|127\.0\.0\.1\^\*\/ads\/ +http:\/\/127\.0\.0\.1:\d+\/ads\/banner\.gif/);
    r = await c.call('ubo_logger', { since: cur, realm: 'cosmetic' });
    assert.match(r.text, /cosmetic hidden dom ##\.ad/);
    r = await c.call('wait_for_ubo_event', { pattern: 'never-matches-anything', timeout_ms: 600 });
    assert.match(r.text, /TIMEOUT[\s\S]*recentUboEntries/);
  });

  it('ubo_test_filter: cosmetic + procedural query, highlight, syntax errors, in-memory network test', async () => {
    let r = await c.call('ubo_test_filter', { filter: '127.0.0.1##.box span' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /cosmetic filter: 2 match\(es\)/);
    r = await c.call('ubo_test_filter', { filter: '127.0.0.1##.box:has-text(Buy now)', highlight: true });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /\(procedural\) filter: 1 match\(es\)[\s\S]*<div class="box"><span>Buy now<\/span><\/div>/);
    assert.equal(r.images.length, 1);
    assert.match(await pageEval('document.querySelectorAll("[data-claude-ubo-test]").length'), /0/);
    r = await c.call('ubo_test_filter', { filter: '127.0.0.1##.box:has-text(' });
    assert.match(r.text, /INVALID \(cosmetic\): Invalid filter/);
    r = await c.call('ubo_test_filter', { filter: 'example.org##.box' });
    assert.match(r.text, /don't cover 127\.0\.0\.1/);
    r = await c.call('ubo_test_filter', { filter: '||127.0.0.1^$image' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /network filter, in-memory \(not saved\)[\s\S]*uBO applied it \d+ time/);
    r = await c.call('ubo_filters_get', {});
    assert.doesNotMatch(r.text, /\$image/, 'test filter never saved');
  });

  it('ubo_test_scriptlet injects once (in-memory) and reports it', async () => {
    let r = await c.call('ubo_test_scriptlet', { name: 'set-constant', args: ['cfFlag', 'true'] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /127\.0\.0\.1##\+js\(set-constant, cfFlag, true\) \(in-memory, not saved\)[\s\S]*injected \d+ time/);
    r = await c.call('ubo_test_scriptlet', { name: 'no-such-scriptlet-xyz' });
    assert.match(r.text, /NOT injected/);
    await c.call('navigate', { url: 'reload' });
    assert.match(await pageEval('typeof window.cfFlag'), /"undefined"/, 'in-memory filter removed afterwards');
  });

  it('advanced settings and lists, with undo; backup', async () => {
    let r = await c.call('ubo_advanced_set', { values: { cnameReplayFullURL: true } });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /cnameReplayFullURL: false -> true/);
    r = await c.call('ubo_advanced_get', {});
    assert.match(r.text, /cnameReplayFullURL = true \(default false\)/);
    r = await c.call('ubo_advanced_set', { values: { noSuchSetting: 1 } });
    assert.match(r.text, /unknown uBO advanced setting/);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /uBO advanced cnameReplayFullURL -> false/);
    r = await c.call('ubo_advanced_get', {});
    assert.doesNotMatch(r.text, /cnameReplayFullURL/);
    r = await c.call('ubo_lists', {});
    assert.match(r.text, /selected \(\d+\): user-filters/);
    r = await c.call('ubo_lists', { disable: ['plowe-0'] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /- plowe-0/);
    r = await c.call('ubo_lists', { enable: ['https://example.com/list.txt'] });
    assert.match(r.text, /DENIED/);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /uBO filter lists ->/);
    r = await c.call('ubo_lists', {});
    assert.match(r.text, /plowe-0/);
    r = await c.call('ubo_filters_remove', { lines: ['127.0.0.1##.ad'] });
    assert.match(r.text, /- 127\.0\.0\.1##\.ad/);
    r = await c.call('undo', { target: 1 });
    assert.match(r.text, /My filters -> previous content/);
    r = await c.call('ubo_filters_get', {});
    assert.match(r.text, /127\.0\.0\.1##\.ad/);
    r = await c.call('ubo_backup', {});
    const file = r.text.split('\n')[0];
    assert.ok(fs.existsSync(file), r.text);
    assert.match(r.text, /My filters 2 line\(s\)/);
  });

  it('user resources: resource server bundle, set, edit, reload (content-hash confirmed)', async () => {
    const dir = path.join(h.workspace, 'resources');
    fs.mkdirSync(dir, { recursive: true });
    const write = (rev: string) => fs.writeFileSync(path.join(dir, 'user-mark.js'), `function userMark(v) {\n  const el = document.documentElement;\n\n  el.setAttribute('data-user-mark', v + '-${rev}');\n}\n`);
    write('r1');
    let r = await c.call('ubo_set_resources', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /uBO fetched bundle \w{12} from the resource server/);
    assert.match(r.text, /user-mark\.js: user-mark\.js \(1 blank line\(s\) -> "\/\/"/);
    r = await c.call('ubo_status', {});
    assert.match(r.text, /userResourcesLocation: http:\/\/127\.0\.0\.1:\d+\/resources\/bundle\.js\?v=\w+ \(served by this session's resource server\)/);
    await c.call('ubo_filters_add', { lines: ['127.0.0.1##+js(user-mark, A)'] });
    await c.call('navigate', { url: fx.url('/ubo.html') });
    assert.match(await pageEval('document.documentElement.getAttribute("data-user-mark")'), /"A-r1"/);
    r = await c.call('ubo_reload_resources', {});
    assert.match(r.text, /unchanged/);
    write('r2');
    r = await c.call('ubo_reload_resources', {});
    assert.match(r.text, /uBO fetched bundle \w{12}/);
    await c.call('navigate', { url: 'reload' });
    assert.match(await pageEval('document.documentElement.getAttribute("data-user-mark")'), /"A-r2"/);
    r = await c.call('ubo_test_scriptlet', { name: 'user-mark', args: ['T'] });
    assert.match(r.text, /injected \d+ time/);
    await c.call('ubo_filters_remove', { lines: ['127.0.0.1##+js(user-mark, A)'] });
  });

  it('warm snapshots carry a "ubo" part: diffed and restored through uBO\'s messaging', async () => {
    let r = await c.call('snapshot', { label: 'ubo-base' });
    assert.ok(!r.isError, r.text);
    const id = /snapshot (s\S+)/.exec(r.text)![1];
    await c.call('ubo_filters_add', { lines: ['127.0.0.1##h1'] });
    await c.call('ubo_advanced_set', { values: { cnameReplayFullURL: true } });
    await c.call('ubo_lists', { disable: ['plowe-0'] });
    // Assumption check: user-authored uBO state lives in keys the raw snapshot keeps (not under cache/)
    r = await c.call('ext_storage_get', { extension: 'ubo', keys: ['user-filters', 'hiddenSettings'], detail: 'normal' });
    assert.match(r.text, /user-filters \(\d+\): "127\.0\.0\.1##\.ad/);
    assert.match(r.text, /hiddenSettings \(\d+\): .*cnameReplayFullURL/);
    r = await c.call('snapshot_diff', { a: id });
    assert.match(r.text, /uBO My filters: 1 added, 0 removed \(\+127\.0\.0\.1##h1\)/);
    assert.match(r.text, /uBO advanced cnameReplayFullURL: \(default\) -> true/);
    assert.match(r.text, /uBO lists: -plowe-0/);
    r = await c.call('restore', { id, parts: ['ubo'] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /uBO My filters restored[\s\S]*uBO advanced settings: cnameReplayFullURL[\s\S]*uBO filter list selection restored/);
    r = await c.call('snapshot_diff', { a: id });
    assert.doesNotMatch(r.text, /uBO (My filters|advanced|lists)/);
  });
});
