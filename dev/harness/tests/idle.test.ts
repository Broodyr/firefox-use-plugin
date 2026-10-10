// Idle quit: Firefox is closed after N minutes without tool calls and relaunched on the next one, approvals kept.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('idle quit', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer({ ...h.env, FIREFOX_USE_IDLE_QUIT_MIN: '0.05', FIREFOX_USE_ENFORCE_SCOPE: '1' }); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('closes Firefox after the idle time and relaunches on the next tool, keeping the scope', async () => {
    await c.call('navigate', { url: fx.url('/page2.html') });
    await c.call('tabs_create', { url: fx.url('/text.html') });
    await c.call('scope_set', { description: 'prefs for the idle test', areas: ['prefs'], user_said: 'ok' });
    const pid = Number(/pid (\d+)/.exec((await c.call('ff_status', {})).text)![1]);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
    assert.ok(!alive(pid), 'Firefox closed after 3 s idle');
    assert.match(c.stderr.join('\n'), /no tool calls for \d+ min: closing Firefox/);
    const r = await c.call('ff_launch', {});
    assert.match(r.text, /note: Firefox had been closed after 0\.05 min without tool calls \(idle quit\); relaunched with 2 agent tab\(s\) reopened/);
    const s = await c.call('scope_show', {});
    assert.match(s.text, /scope: prefs for the idle test/);
    const t = await c.call('tabs_list', {});
    assert.match(t.text, /page2\.html[\s\S]*\* tab \d+: "Text" .*text\.html/, 'tabs reopened, the current one current again');
  });
});
