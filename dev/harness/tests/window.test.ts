// The agent window is parked off-screen as a normal window, so its pages count as visible and render
// (requestAnimationFrame, CSS transitions, the animation clock). A window the user minimised is reported, never
// restored (restoring takes the foreground). Headed, so opt-in: CF_TEST_HEADED=1 (launching a headed Firefox can
// take the foreground for about a second; nothing after the launch should).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures } from './helpers.ts';

const PROBE = '<title>probe</title><div id=b style="width:10px;height:10px;background:red;transition:transform 0.5s linear"></div>'
  + '<script>let n=0;function f(){n++;requestAnimationFrame(f)}requestAnimationFrame(f);setInterval(()=>{window.rate=n;n=0},1000)</script>';
// visibility, rAF per second, the transform 1.2 s after starting a 0.5 s transition
const MEASURE = 'await new Promise((r) => setTimeout(r, 2100)); const b = document.getElementById("b"); getComputedStyle(b).transform;'
  + ' b.style.transform = "translateX(100px)"; getComputedStyle(b).transform; await new Promise((r) => setTimeout(r, 1200));'
  + ' return { vis: document.visibilityState, rate: window.rate, transform: getComputedStyle(b).transform }';
const FIND = 'const w = [...Services.wm.getEnumerator("navigator:browser")].find((x) => x.__claudeAgent);';

describe('agent window parked off-screen', { skip: !process.env.CF_TEST_HEADED && 'headed: set CF_TEST_HEADED=1' }, () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => {
    h = makeHome(); fx = await startFixtures();
    c = McpClient.spawnServer(['--profile-mode=throwaway'], h.env);
    await c.initialize();
  });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  const measure = async () => JSON.parse(/\{[\s\S]*\}/.exec((await c.call('eval', { code: MEASURE })).text)![0]);

  it('pages render as visible: rAF runs, transitions complete', async () => {
    let r = await c.call('navigate', { url: 'data:text/html,' + encodeURIComponent(PROBE) });
    assert.ok(!r.isError, r.text);
    const m = await measure();
    assert.equal(m.vis, 'visible');
    assert.ok(m.rate >= 30, `rAF ${m.rate}/s`);
    assert.match(m.transform, /matrix\(1, 0, 0, 1, 100, 0\)/, 'the transition finished');
    r = await c.call('ff_status', {});
    assert.match(r.text, /agent window: parked off-screen/);
    r = await c.call('eval_privileged', { code: FIND + ' return { state: w.windowState, x: w.screenX }' });
    assert.match(r.text, /"state": 3/, 'a normal window, not minimised');
    assert.match(r.text, /"x": -20000/);
    // the launch window took the foreground at startup; parking hands it back (an invisible foreground window
    // would take the user's typing)
    r = await c.call('eval_privileged', { code: FIND + ` const { ctypes } = ChromeUtils.importESModule('resource://gre/modules/ctypes.sys.mjs');
      const u = ctypes.open('user32.dll'); const fg = u.declare('GetForegroundWindow', ctypes.winapi_abi, ctypes.voidptr_t)();
      const n = Number(ctypes.cast(fg, ctypes.uintptr_t).value.toString()); u.close();
      return n === Number(w.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle) ? 'agent window is foreground' : 'elsewhere'` });
    assert.match(r.text, /"elsewhere"/);
  });

  it('a window the user minimised is reported once, not restored', async () => {
    await c.call('eval_privileged', { code: FIND + ' w.minimize(); await new Promise((r) => setTimeout(r, 500)); return w.windowState' });
    await new Promise((r) => setTimeout(r, 3100)); // the check runs at most every 3 s
    let r = await c.call('tabs_list', {});
    assert.match(r.text, /note: the agent window is minimised \(by the user\)/);
    r = await c.call('tabs_list', {});
    assert.doesNotMatch(r.text, /agent window is minimised/, 'once per minimise');
    r = await c.call('ff_status', {});
    assert.match(r.text, /agent window: MINIMISED by the user/);
    const m = await measure();
    assert.equal(m.vis, 'hidden');
    r = await c.call('eval_privileged', { code: FIND + ' return w.windowState' });
    assert.match(r.text, /2/, 'still minimised: restoring would take the foreground');
  });
});
