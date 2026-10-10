// several Claude sessions per Firefox: a second session routes through the owning proxy and gets its own
// tab group ("Claude 2"), current tab and scope; ff_quit there closes only its group.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, NAMED_ARGS, makeHome, namedProfile, startFixtures } from './helpers.ts';

describe('several sessions', () => {
  let A: McpClient, B: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => {
    h = makeHome(namedProfile);
    fx = await startFixtures();
    const env = { ...h.env, FIREFOX_USE_NO_COLD: '1' };
    A = McpClient.spawnProxy(NAMED_ARGS, env); await A.initialize();
    B = McpClient.spawnProxy(NAMED_ARGS, env); await B.initialize();
  });
  after(async () => { await B.close(); await A.close(); fx.close(); h.cleanup(); });

  it('second session gets its own group, tabs and current tab', async () => {
    let r = await A.call('navigate', { url: fx.url('/form.html') });
    assert.ok(!r.isError, r.text);
    r = await B.call('navigate', { url: fx.url('/page2.html') });
    assert.ok(!r.isError, r.text);
    r = await B.call('tabs_list', {});
    assert.match(r.text, /Page two/);
    assert.doesNotMatch(r.text, /Form fixture/);
    r = await A.call('tabs_list', { include_user: true });
    assert.match(r.text, /Form fixture/);
    assert.doesNotMatch(r.text, /Page two/, 'other sessions\' tabs are never listed');
    r = await A.call('get_page_text', {});
    assert.match(r.text, /Fixture form/);
    r = await B.call('ff_status', {});
    assert.match(r.text, /group "Claude 2" \(this session is routed through/);
    r = await B.call('batch', { actions: [{ tool: 'tabs_create', args: { url: fx.url('/text.html') } }, { tool: 'get_page_text', args: {} }] });
    assert.match(r.text, /Body paragraph one/);
  });

  it('scope is per session; ff_restart refused; ff_quit closes only the second group', async () => {
    let r = await B.call('scope_set', { description: 'B scope for prefs', areas: ['prefs'], user_said: 'yes' });
    assert.ok(!r.isError, r.text);
    r = await A.call('scope_show', {});
    assert.match(r.text, /no scope/);
    r = await B.call('scope_clear', {});
    assert.match(r.text, /scope cleared \(B scope for prefs\)/);
    r = await B.call('scope_show', {});
    assert.match(r.text, /no scope/);
    r = await B.call('ff_restart', {});
    assert.match(r.text, /NOT_OWNER/);
    r = await B.call('ff_quit', {});
    assert.match(r.text, /closed this session's tab group \(2 tab\(s\)\)/);
    r = await A.call('get_page_text', {});
    assert.match(r.text, /Fixture form/, 'the owner keeps working');
  });
});
