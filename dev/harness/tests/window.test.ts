// The agent window is parked off-screen as a normal window, so its pages count as visible and render
// (requestAnimationFrame, CSS transitions, the animation clock). A window the user minimised is reported, never
// restored (restoring takes the foreground). ff_window shows / parks it without activating it. Personal mode: a
// visible window by default, never the foreground window; covered or minimised is reported. Headed, so opt-in:
// CF_TEST_HEADED=1 (launching a headed Firefox can take the foreground for about a second; nothing after the launch should).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, killPersonal, makeHome, personalProfile, startFixtures } from './helpers.ts';

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

const WIN32 = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class FW { public delegate bool CB(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
public static string T(IntPtr h) { var sb = new StringBuilder(400); GetWindowText(h, sb, 400); return sb.ToString(); }
public static int Min(string part) { int n = 0; EnumWindows((h, l) => { if (T(h).Contains(part)) { ShowWindow(h, 6); n++; } return true; }, IntPtr.Zero); return n; } }
"@
`;
const ps = (cmd: string) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN32 + cmd], { encoding: 'utf8', windowsHide: true }).trim();
/** title of the OS foreground window */
const foreground = () => ps('[FW]::T([FW]::GetForegroundWindow())');
/** minimise (SW_MINIMIZE, no activation) the windows whose title contains part, as the user would */
const minimize = (part: string) => Number(ps(`[FW]::Min('${part}')`));

describe('ff_window in claude-dev', { skip: !process.env.CF_TEST_HEADED && 'headed: set CF_TEST_HEADED=1' }, () => {
  let c: McpClient, h: ReturnType<typeof makeHome>;
  before(async () => {
    h = makeHome((cfg) => { cfg.agentWindow = { dev: 'visible' }; });
    c = McpClient.spawnServer(['--profile-mode=throwaway'], h.env);
    await c.initialize();
  });
  after(async () => { await c.close(); h.cleanup(); });
  const where = async () => JSON.parse(/\{[\s\S]*\}/.exec((await c.call('eval_privileged', { code: FIND + ` const { ctypes } = ChromeUtils.importESModule('resource://gre/modules/ctypes.sys.mjs');
    const u = ctypes.open('user32.dll'); const fg = u.declare('GetForegroundWindow', ctypes.winapi_abi, ctypes.voidptr_t)();
    const n = Number(ctypes.cast(fg, ctypes.uintptr_t).value.toString()); u.close();
    return { x: w.screenX, state: w.windowState, fg: n === Number(w.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle) }` })).text)![0]);

  it('agentWindow dev "visible": on-screen after launch, and the launch hands the foreground back', async () => {
    let r = await c.call('ff_launch', {});
    assert.ok(!r.isError, r.text);
    r = await c.call('ff_status', {});
    assert.match(r.text, /agent window: on-screen \(shown, not activated\) · mode visible/);
    const w = await where();
    assert.ok(w.x > -10000, `x ${w.x}`);
    assert.equal(w.state, 3);
    assert.equal(w.fg, false, 'not the foreground window');
  });

  it('park moves it off-screen, show brings it back where it was, neither activates it', async () => {
    const was = await where();
    let r = await c.call('ff_window', { action: 'park' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /parked off-screen for this session/);
    let w = await where();
    assert.equal(w.x, -20000);
    assert.equal(w.fg, false);
    r = await c.call('ff_status', {});
    assert.match(r.text, /agent window: parked off-screen .* mode offscreen/);
    r = await c.call('ff_window', { action: 'show' });
    assert.match(r.text, /shown on-screen \(not activated/);
    w = await where();
    assert.equal(w.x, was.x, 'back where it was before parking');
    assert.equal(w.fg, false);
    // the choice lasts for the session: a handback leaves a shown window on-screen
    r = await c.call('ff_handback', {});
    assert.match(r.text, /agent window left on-screen/);
  });
});

describe('personal mode window', { skip: !process.env.CF_TEST_HEADED && 'headed: set CF_TEST_HEADED=1' }, () => {
  let c: McpClient, h: ReturnType<typeof makeHome>;
  const TITLE = `claude-window-probe-${process.pid}`;
  before(async () => {
    h = makeHome((cfg, home) => {
      personalProfile()(cfg, home);
      // a headed throwaway profile stacks under the user's own Firefox taskbar button without this
      fs.appendFileSync(path.join(home, 'personal-profile', 'user.js'), 'user_pref("taskbar.grouping.useprofile", true);\n');
    });
    c = McpClient.spawnServer(['--profile-mode=throwaway'], { ...h.env, FIREFOX_USE_PROXY_PID: String(process.pid) });
    await c.initialize();
  });
  after(async () => { await c.close(); killPersonal(h.home); h.cleanup(); });
  const status = async () => (await c.call('ff_status', {})).text;
  const hidden = async () => /true/.test((await c.call('eval', { code: 'document.hidden' })).text);

  it('visible by default: on-screen, never the foreground window', async () => {
    let r = await c.call('ff_launch', { profile: 'personal', headless: false });
    assert.ok(!r.isError, r.text);
    r = await c.call('navigate', { url: 'data:text/html,' + encodeURIComponent(`<title>${TITLE}</title>probe`) });
    assert.ok(!r.isError, r.text);
    await new Promise((res) => setTimeout(res, 1500));
    const st = await status();
    assert.match(st, /window: on-screen at -?\d+,-?\d+ \(mode visible\)/);
    // covered by other windows is possible on a busy desktop; ff_status must agree with the page
    assert.match(st, (await hidden()) ? /pages HIDDEN/ : /pages visible/);
    assert.doesNotMatch(foreground(), new RegExp(TITLE), 'Claude\'s window must not take the foreground');
  });

  it('a minimised window is reported once; ff_window(show) restores it', async () => {
    assert.ok(minimize(TITLE) >= 1, 'found Claude\'s window by its title');
    await new Promise((res) => setTimeout(res, 3200)); // the check runs at most every 3 s
    let r = await c.call('tabs', { op: 'list' });
    assert.match(r.text, /note: Claude's window in the user's Firefox is minimised/);
    r = await c.call('tabs', { op: 'list' });
    assert.doesNotMatch(r.text, /is minimised/, 'once per hidden spell');
    assert.match(await status(), /minimised \(mode visible\) · pages HIDDEN/);
    r = await c.call('ff_window', { action: 'show' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /restored from the taskbar/);
    assert.match(await status(), /on-screen at/);
    // (here the launch window, i.e. "the user working in their Firefox", is the foreground window, so the restored
    // window comes to the front: measured, a restore activates it then; with another app in front it doesn't)
  });

  it('park minimises it (an off-screen window would be throttled anyway, and lost from the taskbar), show: back where it was', async () => {
    const at = /on-screen at (-?\d+,-?\d+)/.exec(await status())![1];
    let r = await c.call('ff_window', { action: 'park' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /minimised for this session/);
    assert.match(await status(), /minimised \(mode minimized\) · pages HIDDEN/);
    assert.equal(await hidden(), true);
    await new Promise((res) => setTimeout(res, 3200));
    r = await c.call('tabs', { op: 'list' });
    assert.doesNotMatch(r.text, /note: Claude's window/, 'minimised was chosen: no note');
    assert.doesNotMatch(foreground(), new RegExp(TITLE));
    r = await c.call('ff_window', { action: 'show' });
    assert.ok(!r.isError, r.text);
    assert.match(await status(), new RegExp(`on-screen at ${at} \\(mode visible\\)`));
  });

  it('park lasts over a backend reload; another session attaching leaves the minimised window alone and says so', async () => {
    await c.call('ff_window', { action: 'park' });
    // a proxy reload (same session): the choice is kept
    c.notify('notifications/firefox-use/detach');
    await c.close();
    c = McpClient.spawnServer(['--profile-mode=throwaway'], { ...h.env, FIREFOX_USE_PROXY_PID: String(process.pid) });
    await c.initialize();
    await c.call('tabs', { op: 'list' }); // attaches (ff_status alone doesn't)
    assert.match(await status(), /minimised \(mode minimized\)/);
    // the session that parked it is gone (its proxy pid is dead); another Claude session finds Claude's window again
    // in its own mode (visible), but doesn't un-minimise it unasked (that could bring it to the front)
    c.notify('notifications/firefox-use/detach');
    await c.close();
    const run = path.join(h.home, 'run', 'personal.json');
    fs.writeFileSync(run, JSON.stringify({ ...JSON.parse(fs.readFileSync(run, 'utf8')), ownerPid: spawnSync('cmd.exe', ['/c', 'exit']).pid }));
    c = McpClient.spawnServer(['--profile-mode=throwaway'], { ...h.env, FIREFOX_USE_PROXY_PID: String(process.pid + 1) });
    await c.initialize();
    const r = await c.call('ff_launch', { profile: 'personal', headless: false });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /attached to your running Firefox/);
    const st = await status();
    assert.match(st, /minimised \(mode visible\) · pages HIDDEN/);
    await new Promise((res) => setTimeout(res, 3200));
    const t = await c.call('tabs', { op: 'list' });
    // the note rides on the first result after the check (the launch, ff_status or this one)
    assert.match(r.text + st + t.text, /note: Claude's window in the user's Firefox is minimised/);
  });
});
