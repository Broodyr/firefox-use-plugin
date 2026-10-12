// The listed surface (2026-10-08): read/write composites per area. Every kind/action must reach the right tool
// (checked in the audit log), reads can't write, old names and old call shapes keep working (not listed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

/** composite -> discriminator -> value -> the tool it must run (mirrors tools/composite.ts on purpose) */
const EXPECT: Record<string, [string, Record<string, string>]> = {
  tabs: ['op', { list: 'tabs_list', create: 'tabs_create', select: 'tabs_select', close: 'tabs_close' }],
  wait_for: ['kind', { expr: 'wait_for_expr', selector: 'wait_for_selector', text: 'wait_for_text', console: 'wait_for_console', network_idle: 'wait_for_network_idle', navigation: 'wait_for_navigation', request: 'wait_for_request', download: 'downloads_wait', ubo_event: 'wait_for_ubo_event' }],
  console_read: ['kind', { entries: 'console_entries', errors: 'errors_summary', clear: 'console_clear' }],
  network_read: ['kind', { requests: 'network_requests', body: 'network_body', headers: 'headers_inspect' }],
  network_write: ['action', { mock: 'network_mock', mock_clear: 'network_mock_clear', har_record: 'har_record', har_stop: 'har_stop', har_replay: 'har_replay', har_replay_stop: 'har_replay_stop' }],
  site_read: ['kind', { cookies: 'cookies_get', local_storage: 'local_storage', session_storage: 'session_storage', indexeddb: 'indexeddb_list', indexeddb_records: 'indexeddb_read', cache_storage: 'cache_storage_list', service_workers: 'service_workers', permissions: 'permissions_get' }],
  site_write: ['action', { cookie_set: 'cookies_set', cookie_delete: 'cookies_delete', local_storage: 'local_storage', session_storage: 'session_storage', service_worker_unregister: 'service_workers', permission_set: 'permissions_set' }],
  ext_read: ['kind', { addons: 'addons_list', storage: 'ext_storage_get', source: 'ext_source' }],
  ext_write: ['action', { enable: 'addons_set_enabled', disable: 'addons_set_enabled', reload: 'addons_reload', install_local: 'addons_install_local', storage_set: 'ext_storage_set', storage_remove: 'ext_storage_remove', managed_storage: 'managed_storage_set', message: 'ext_message', page_open: 'ext_page_open' }],
  us_read: ['kind', { list: 'us_list', values: 'us_values', logs: 'us_logs', sync_status: 'us_sync_status', main_diff: 'us_sync_main' }],
  us_write: ['action', { install: 'us_install', update: 'us_update', enable: 'us_set_enabled', disable: 'us_set_enabled', uninstall: 'us_uninstall', values_set: 'us_values_set', sync: 'us_sync', sync_main: 'us_sync_main', dev_prelude: 'us_dev_prelude', fast_gm: 'us_fast_gm' }],
  ubo_read: ['kind', { status: 'ubo_status', advanced: 'ubo_advanced_get', filters: 'ubo_filters_get', lists: 'ubo_lists', logger: 'ubo_logger', test_filter: 'ubo_test_filter', test_scriptlet: 'ubo_test_scriptlet', backup: 'ubo_backup' }],
  ubo_write: ['action', { advanced_set: 'ubo_advanced_set', filters_set: 'ubo_filters_set', filters_add: 'ubo_filters_add', filters_remove: 'ubo_filters_remove', trust_my_filters: 'ubo_trust_my_filters', lists: 'ubo_lists', set_resources: 'ubo_set_resources', reload_resources: 'ubo_reload_resources', restore: 'ubo_restore' }],
  ff_read: ['kind', { prefs: 'ff_prefs_get', snapshots: 'snapshot_list', snapshot_diff: 'snapshot_diff', downloads: 'downloads_list', audit: 'ff_audit_show', clipboard: 'clipboard_read', dialogs: 'dialogs_policy', http_auth: 'http_auth' }],
  ff_write: ['action', { prefs_set: 'ff_prefs_set', snapshot: 'snapshot', snapshot_cold: 'snapshot_cold', dialogs_policy: 'dialogs_policy', dialog_answer: 'dialog_handle', http_auth: 'http_auth', clipboard: 'clipboard_write', pins: 'pins_update' }],
};

describe('read/write composites', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, fx: Awaited<ReturnType<typeof startFixtures>>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer({ ...h.env, FIREFOX_USE_ENFORCE_SCOPE: '1' }); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });
  const auditTools = () => {
    const dir = path.join(h.workspace, '.firefox-use', 'audit');
    return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).tool as string));
  };

  it('lists the composites as plain object schemas; the tools behind them are not listed', async () => {
    const tools = await c.listTools();
    const names = new Set(tools.map((t: any) => t.name));
    for (const n of Object.keys(EXPECT)) assert.ok(names.has(n), `${n} listed`);
    for (const [, m] of Object.values(EXPECT)) for (const t of Object.values(m)) if (!EXPECT[t]) assert.ok(!names.has(t), `${t} is reached through a composite, not listed`);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', `${t.name}: top-level object schema`);
      assert.ok(!('anyOf' in t.inputSchema) && !('oneOf' in t.inputSchema), t.name);
    }
    for (const n of ['site_read', 'ext_read', 'us_read', 'ubo_read', 'ff_read']) assert.equal(tools.find((t: any) => t.name === n).annotations?.readOnlyHint, true, n);
    for (const n of ['site_write', 'ext_write', 'us_write', 'ubo_write', 'ff_write', 'network_write']) assert.equal(tools.find((t: any) => t.name === n).annotations?.readOnlyHint, false, n);
    // 82: ff_live_view is listed on its own, like ff_window (SPEC §6.23)
    assert.ok(tools.length <= 82, `${tools.length} tools listed`);
  });

  it('every kind/action runs its tool (audit log)', async () => {
    await c.call('navigate', { url: fx.url('/form.html') });
    const skip = new Set(['ff_write.snapshot_cold']); // restarts Firefox; resolution is the same mechanism
    const before = auditTools().length;
    const calls: [string, string][] = [];
    for (const [comp, [disc, m]] of Object.entries(EXPECT)) {
      for (const value of Object.keys(m)) {
        if (skip.has(`${comp}.${value}`)) continue;
        // minimal arguments: most calls fail validation in the tool itself, which is enough (and harmless)
        const args: Record<string, unknown> = { [disc]: value, ...(comp === 'wait_for' ? { timeout_ms: 200 } : {}) };
        const r = await c.call(comp, args);
        assert.doesNotMatch(r.text, /UNKNOWN_TOOL|needs (kind|action|op)\b|unknown (kind|action|op)/, `${comp} ${value}: ${r.text}`);
        calls.push([`${comp}.${value}`, m[value]]);
      }
    }
    const seen = auditTools().slice(before);
    for (const [label, tool] of calls) assert.ok(seen.includes(tool), `${label} -> ${tool} not in the audit log`);
  });

  it('reads cannot write; old names and old call shapes still work', async () => {
    let r = await c.call('site_read', { kind: 'local_storage', op: 'set', key: 'a', value: 'b' });
    assert.match(r.text, /BAD_ARGS[\s\S]*op must be one of "list", "get"[\s\S]*site_write/, r.text);
    r = await c.call('ubo_read', { kind: 'lists', enable: ['x'] });
    assert.match(r.text, /does not take enable/);
    r = await c.call('site_write', { action: 'local_storage', op: 'list' });
    assert.match(r.text, /op must be one of "set", "remove", "clear"/);
    r = await c.call('site_read', { kind: 'nope' });
    assert.match(r.text, /unknown kind "nope"[\s\S]*"cookies"/);
    // writes still need scope through the composite
    r = await c.call('site_write', { action: 'local_storage', op: 'set', key: 'a', value: 'b' });
    assert.match(r.text, /SCOPE_REQUIRED/);
    // old call shapes: discriminator left out -> the default kind; old names: still callable
    assert.doesNotMatch((await c.call('wait_for', { expr: '1 + 1 === 2', timeout_ms: 2000 })).text, /error/);
    assert.match((await c.call('console_read', {})).text, /entr|no console|cursor/i);
    assert.match((await c.call('tabs', {})).text, /tab \d+/);
    assert.match((await c.call('tabs_list', {})).text, /tab \d+/);
    assert.match((await c.call('cookies_get', {})).text, /cookie/i);
    // ext_write enable/disable pin the argument themselves
    r = await c.call('ext_write', { action: 'disable', extension: 'companion' });
    assert.match(r.text, /SCOPE_REQUIRED/); // reached addons_set_enabled (which checks scope after resolving the extension)
  });
});
