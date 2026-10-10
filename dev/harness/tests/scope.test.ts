// Real confirmation: scope_set asks the user through an MCP elicitation dialog when the client has one.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome } from './helpers.ts';

describe('scope approval dialog', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>;
  let answer: { action: string; content?: Record<string, unknown> } = { action: 'accept', content: { decision: 'task' } };
  before(async () => {
    h = makeHome();
    c = McpClient.spawnServer(['--profile-mode=throwaway', '--headless'], { ...h.env, FIREFOX_USE_ENFORCE_SCOPE: '1' });
    c.onElicit = () => answer;
    await c.initialize();
  });
  after(async () => { await c.close(); h.cleanup(); });

  it('approve for this task, decline, approve for the rest of the session', async () => {
    let r = await c.call('scope_set', { description: 'change a test pref', areas: ['prefs'] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /scope approved via approval dialog: change a test pref/);
    const p = c.elicitations.at(-1);
    assert.match(p.message, /lasting changes in the claude-dev Firefox profile[\s\S]*change a test pref[\s\S]*• Firefox preferences/);
    assert.deepEqual(p.requestedSchema.properties.decision.enum, ['task', 'session', 'decline']);
    r = await c.call('ff_prefs_set', { values: { 'browser.cf.dialog': 1 } });
    assert.ok(!r.isError, r.text);
    r = await c.call('scope_show', {});
    assert.match(r.text, /user said: "\(approved in the Claude Code dialog: for this task\)"/);

    answer = { action: 'accept', content: { decision: 'decline' } };
    r = await c.call('scope_set', { description: 'install add-ons', areas: ['addons'] });
    assert.match(r.text, /SCOPE_DECLINED/);
    // dismissed / never shown: no answer, so chat approval (user_said) is the fallback
    answer = { action: 'cancel' };
    r = await c.call('scope_set', { description: 'install add-ons', areas: ['addons'] });
    assert.match(r.text, /APPROVAL_NEEDED[\s\S]*no answer from the approval dialog/);
    r = await c.call('scope_set', { description: 'install add-ons', areas: ['addons'], user_said: 'yes, use my chat approval' });
    assert.match(r.text, /scope approved via chat \(attested by Claude\)/);

    answer = { action: 'accept', content: { decision: 'session' } };
    r = await c.call('scope_set', { description: 'prefs for the whole session', areas: ['prefs'] });
    assert.match(r.text, /kept approved for the rest of this session/);
    await c.call('scope_clear', {});
    r = await c.call('ff_prefs_set', { values: { 'browser.cf.dialog': 2 } });
    assert.ok(!r.isError, `session approval outlives the task scope: ${r.text}`);
    r = await c.call('ff_prefs_set', { values: {} });
    r = await c.call('addons_set_enabled', { extension: 'ubo', enabled: true });
    assert.match(r.text, /SCOPE_REQUIRED/, 'other areas still need approval');
  });

  it('the dialog works through the hot-reload proxy (how Claude Code connects)', async () => {
    const h3 = makeHome();
    const p = McpClient.spawnProxy(['--profile-mode=throwaway', '--headless'], { ...h3.env, FIREFOX_USE_ENFORCE_SCOPE: '1' });
    p.onElicit = () => ({ action: 'accept', content: { decision: 'task' } });
    await p.initialize();
    try {
      const r = await p.call('scope_set', { description: 'change a test pref', areas: ['prefs'] });
      assert.match(r.text, /scope approved via approval dialog/, r.text);
      assert.equal(p.elicitations.length, 1);
    } finally { await p.close(); h3.cleanup(); }
  });

  it('without a dialog: user_said from chat is required', async () => {
    const h2 = makeHome();
    const c2 = McpClient.spawnServer(['--profile-mode=throwaway', '--headless'], { ...h2.env, FIREFOX_USE_ENFORCE_SCOPE: '1' });
    await c2.initialize();
    try {
      let r = await c2.call('scope_set', { description: 'change a test pref', areas: ['prefs'] });
      assert.match(r.text, /APPROVAL_NEEDED[\s\S]*no approval dialog[\s\S]*user_said/);
      r = await c2.call('scope_set', { description: 'change a test pref', areas: ['prefs'], user_said: 'yes do it' });
      assert.match(r.text, /scope approved via chat \(attested by Claude\)/);
    } finally { await c2.close(); h2.cleanup(); }
  });
});
