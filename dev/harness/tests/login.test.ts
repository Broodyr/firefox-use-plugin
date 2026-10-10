// Login handoff (ff_handoff mode "login"): the profile reopens as an ordinary Firefox (no remote agent), other tools
// get LOGIN_IN_PROGRESS, ff_handback resumes automation on the same profile with what the login left (cookies),
// approvals carried over. And: automation prefs a kill left behind are tracked again and gone after a clean quit.
// Headless here (FIREFOX_USE_TEST_LOGIN): the "user" is a cookie the plain window gets from the site, and the
// plain window is killed (a headless window can't be closed like a user would).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, NAMED_ARGS, makeHome, namedProfile } from './helpers.ts';
import { execFileSync } from 'node:child_process';

describe('login handoff and leftover automation prefs', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, base = '', visits = 0, profileDir = '';
  before(async () => {
    h = makeHome(namedProfile);
    profileDir = path.join(h.home, 'profiles', 'test-named');
    // a kill left these behind (remote agent recommended values, as untracked user values)
    fs.writeFileSync(path.join(profileDir, 'prefs.js'), 'user_pref("browser.safebrowsing.malware.enabled", false);\nuser_pref("remote.prefs.recommended.applied", true);\n');
    srv = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
      if (req.url === '/botcheck') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Sign in</title><form><div class="cf-turnstile"></div></form>'); return; }
      visits++;
      // only the plain (login) window's visit sets the cookie
      res.writeHead(200, { 'content-type': 'text/html', ...(visits === 2 ? { 'set-cookie': [`persist=p${visits}; Max-Age=3600; Path=/`] } : {}) });
      res.end(`<!doctype html><title>Login ${visits}</title><h1>login page</h1>`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
    c = McpClient.spawnServer(NAMED_ARGS, { ...h.env, FIREFOX_USE_TEST_LOGIN: '1', FIREFOX_USE_ENFORCE_SCOPE: '1' });
    await c.initialize();
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('leftover automation prefs are tracked again, and gone after a clean quit', async () => {
    const r = await c.call('ff_launch', {});
    assert.match(r.text, /2 automation pref\(s\) left behind by an unclean shutdown are tracked again/, r.text);
    await c.call('ff_quit', {});
    const prefs = fs.readFileSync(path.join(profileDir, 'prefs.js'), 'utf8');
    assert.doesNotMatch(prefs, /safebrowsing\.malware\.enabled/);
    assert.doesNotMatch(prefs, /remote\.prefs\.recommended\.applied/);
  });

  it('ff_handoff mode "login" -> plain Firefox -> ff_handback resumes with its cookies and the approvals', async () => {
    await c.call('scope_set', { description: 'test scope', areas: ['prefs'], user_said: 'yes' });
    let r = await c.call('navigate', { url: `${base}/login` });
    assert.match(r.text, /Login 1/);
    r = await c.call('ff_handoff', { reason: 'log in', mode: 'login' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /reopened as an ordinary Firefox \(no automation, so no navigator\.webdriver\) on http:\/\/127\.0\.0\.1:\d+\/login/);
    // the plain window loads the page (visit 2 sets persist=p2)
    for (let i = 0; i < 80 && visits < 2; i++) await new Promise((res) => setTimeout(res, 250));
    assert.equal(visits, 2, 'the plain Firefox loaded the login page');
    r = await c.call('navigate', { url: `${base}/x` });
    assert.match(r.text, /LOGIN_IN_PROGRESS/);
    assert.match((await c.call('ff_status', {})).text, /LOGIN HANDOFF since .*window still open/);
    // the "user" is done: the cookie database is written within a few seconds; then the window goes away
    await new Promise((res) => setTimeout(res, 4000));
    const pids = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profileDir.replaceAll("'", "''")}') } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean);
    for (const p of pids) { try { execFileSync('taskkill', ['/PID', p, '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    r = await c.call('ff_handback', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /login handoff ended after \d+ s; automation resumed/);
    r = await c.call('navigate', { url: `${base}/after` });
    assert.match(r.text, /Login 4/, 'visit 3 was the restored login tab');
    assert.match((await c.call('eval', { code: 'document.cookie' })).text, /persist=p2/, 'the cookie the plain window got');
    assert.match((await c.call('eval', { code: 'navigator.webdriver' })).text, /true/, 'automated again');
    assert.match((await c.call('scope_show', {})).text, /areas: prefs/, 'approvals carried over');
  });

  it('ff_selfcheck; a bot-check page turns a window handoff into a login handoff', async () => {
    let r = await c.call('ff_selfcheck', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /internals OK/, r.text);
    assert.doesNotMatch(r.text, /✖/, r.text);
    await c.call('navigate', { url: `${base}/botcheck` });
    r = await c.call('ff_handoff', { reason: 'log in' });
    assert.match(r.text, /^This page has a bot check \(Cloudflare\) that fails in an automated browser, so this is a login handoff/, r.text);
    const pids = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profileDir.replaceAll("'", "''")}') } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean);
    for (const p of pids) { try { execFileSync('taskkill', ['/PID', p, '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    r = await c.call('ff_handback', {});
    assert.match(r.text, /automation resumed/, r.text);
  });
});