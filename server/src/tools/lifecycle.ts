import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RUN_DIR, TOKEN_FILE, ensureDir, loadConfig, readToken, setupCommand, setupHint } from '../config.js';
import { Browser } from '../browser/session.js';
import { BODY_LIMIT } from '../browser/devtools.js';
import { autoConfig, closePlain, firefoxAlive, isAlive, killTree, isOurFirefox, launchPlain, loginCarry, ownerPid, profileLocked, readLogin, clearLogin, readRunState, profileKey } from '../browser/launcher.js';
import { auditRead } from '../audit/audit.js';
import { fail } from '../errors.js';
import * as CS from '../browser/chromeScripts.js';
import { tool, tabArg, type Ctx } from './registry.js';
import { listSnapshots, localTime } from '../snapshots/snapshots.js';
import { currentClient } from '../browser/client.js';
import { readShadows, releaseShadows, restoreFastScripts } from '../adapters/violentmonkey.js';
import { driftSummary, readDrift } from '../adapters/vmstore.js';
import { PERSONAL, personalProfileDir, personalPrefsOk } from '../browser/personal.js';
import { pinsStatus } from './pins.js';
import { live } from '../live/liveview.js';
import { firefoxSupportNote } from '../browser/internals.js';

/** this session's recent dialogs / HTTP auth challenges, and any left open */
function dialogStatus(b: Browser): string[] {
  const mine = b.prompts.filter((p) => p.client === currentClient());
  const out: string[] = [];
  const open = mine.filter((p) => p.result === 'open');
  if (open.length) out.push(`dialogs OPEN (dialog_handle answers them): ${open.map((p) => `${p.type} "${p.message.slice(0, 80)}"`).join('; ')}`);
  if (mine.length) out.push(`dialogs seen: ${mine.slice(-3).map((p) => `${p.type} "${p.message.slice(0, 80)}" (${p.result})`).join('; ')}`);
  return out;
}

/** this session's handoff (the user has the browser) and live view, for ff_status */
function sessionLines(b: Browser | null): string[] {
  const out: string[] = [];
  const h = b?.handoff;
  if (h) out.push(`HANDED OFF since ${new Date(h.since).toTimeString().slice(0, 8)} on tab ${h.tab}: ${h.by === 'live view' ? 'the user took over from the live view' : h.reason} (ff_handback when they say they are done)`);
  const l = live.statusLine();
  if (l) out.push(l);
  return out;
}

/** A challenge that rejects automated browsers on this page? (Cloudflare/Turnstile, hCaptcha, DataDome, PerimeterX) */
const BOT_CHECK = `() => {
  const srcs = [...document.querySelectorAll('iframe, script')].map((e) => e.src || '').join(' ');
  if (/challenges\.cloudflare\.com/.test(srcs) || document.querySelector('.cf-turnstile, #challenge-form, #cf-challenge-running')) return 'Cloudflare';
  if (/^Just a moment/.test(document.title)) return 'Cloudflare';
  if (/hcaptcha\.com/.test(srcs)) return 'hCaptcha';
  if (/captcha-delivery\.com|datadome/i.test(srcs)) return 'DataDome';
  if (/px-captcha|perimeterx/i.test(srcs) || document.querySelector('#px-captcha')) return 'PerimeterX';
  return null;
}`;

function lastCp(b: Browser): string {
  const all = listSnapshots(b.state.key).filter((s) => s.profile === b.state.key);
  const l = all[all.length - 1];
  return l ? `${l.id} (${l.label}, ${localTime(l.ts).slice(11)})` : 'none';
}

/** Personal mode: the user's own Firefox, page-level only. */
async function describePersonal(b: Browser, detail: string): Promise<string> {
  const v = await b.versionsInfo();
  const all = await b.listTabs(true);
  const tabs = all.filter((t) => t.agent);
  const lines = [
    `Firefox ${v.firefox} · PERSONAL MODE: your own profile${b.state.headless ? ' · headless' : ''}`,
    ...[firefoxSupportNote(v.firefox)].filter((x): x is string => !!x),
    `transport: BiDi ${b.dead ? 'DOWN' : 'ok'} (127.0.0.1:${b.state.bidiPort}) · no privileged access, no devtools (page-level tools only)`,
    `Claude's window: ${tabs.length} tab(s) · current tab ${b.cur ?? '-'}: ${tabs.find((t) => t.current)?.url ?? '-'} · your own tabs: ${all.length - tabs.length} (not touched unless you name one)`,
  ];
  const win = await b.windowLine().catch(() => null);
  if (win) lines.push(`${win} (ff_window show / park)`);
  lines.push(...sessionLines(b));
  lines.push(...dialogStatus(b));
  if (detail !== 'summary') lines.push(`profile dir: ${b.state.profileDir}`, `connected since: ${b.state.startedAt}`);
  return lines.join('\n');
}

/** The install's AutoConfig script runs in every profile (claude-dev and test profiles too); its locked prefs win over everything. */
function autoConfigLine(): string[] {
  const ac = autoConfig(loadConfig().firefoxPath);
  return ac ? [`install: AutoConfig ${ac.file} (enabled by ${ac.via}) runs in every profile${ac.locks.length ? `; locks ${ac.locks.join(', ')}` : ''}. If it throws, Firefox shows a startup alert that a headless or off-screen window hides`] : [];
}

async function describe(b: Browser, detail: string): Promise<string> {
  if (b.personal) return describePersonal(b, detail);
  const v = await b.versionsInfo();
  const tabs = await b.listTabs();
  const find = (id: string) => v.addons.find((a: any) => a.id === id);
  const ubo = find('uBlock0@raymondhill.net'), vm = find('{aecec67f-0d10-4fa7-b7c7-609a2db280cf}'), comp = find('companion@firefox-use');
  const lines = [
    `Firefox ${v.firefox} · profile ${b.state.key}${b.state.throwaway ? ' (throwaway)' : ''}${b.state.headless ? ' · headless' : ''} · pid ${b.state.browserPid ?? b.state.pid}${b.state.browserPid && b.state.browserPid !== b.state.pid ? ` (launcher ${b.state.pid})` : ''}`,
    ...[firefoxSupportNote(v.firefox)].filter((x): x is string => !!x),
    `uBlock Origin ${ubo ? ubo.version + (ubo.active ? '' : ' (disabled)') : 'not installed'} · Violentmonkey ${vm ? vm.version + (vm.active ? '' : ' (disabled)') : 'not installed'} · companion: ${comp ? comp.version : 'not installed'}`,
    `transports: BiDi ${b.dead ? 'DOWN' : 'ok'} (port ${b.state.bidiPort}) · privileged: ok (chrome scope) · devtools/RDP ${b.devtools && !b.devtools.dead ? `ok (${b.devtools.liveTargets} targets)` : `DOWN${b.devtoolsError ? `: ${b.devtoolsError}` : ''}`} (port ${b.state.rdpPort})`,
    `agent tabs: ${tabs.length} in group "${b.groupLabel}"${currentClient() ? ` (this session is routed through the session that owns this Firefox, proxy ${b.state.ownerPid})` : ''} · current tab ${b.cur ?? '-'}: ${tabs.find((t) => t.current)?.url ?? '-'}`,
    `scope: ${b.scope ? `${b.scope.description} [${b.scope.areas.join(', ')}]` : 'none approved'} · last checkpoint: ${lastCp(b)}`,
    ...autoConfigLine(),
  ];
  const win = await b.windowLine().catch(() => null);
  if (win) lines.push(win);
  lines.push(...sessionLines(b));
  const errs = b.recentErrors(undefined, 3);
  if (errs.length) lines.push(`recent console errors: ${errs.length}`);
  lines.push(...dialogStatus(b));
  if (detail !== 'summary' && b.devtools) {
    // memory bounds: what the hub keeps, what it gave back to the devtools server, and Firefox's memory
    const d = b.devtools, s = d.stats;
    const mem = await b.callChrome<{ parent: number; children: { type: string; n: number; mb: number }[] }>(`async () => {
      const i = await ChromeUtils.requestProcInfo();
      const by = {};
      for (const c of i.children) { const t = c.type || 'other'; by[t] = by[t] || { type: t, n: 0, mb: 0 }; by[t].n++; by[t].mb += (c.memory || 0) / 1048576; }
      return { parent: Math.round((i.memory || 0) / 1048576), children: Object.values(by).map((x) => ({ ...x, mb: Math.round(x.mb) })) };
    }`).catch(() => null);
    lines.push(`devtools hub: ${d.log.length} log entries, ${d.net.length} requests kept (bodies ≤ ${BODY_LIMIT / 1024} kB each) · released ${s.netReleased} request actors, ${s.gripsReleased} object grips${s.releaseErrors ? ` (${s.releaseErrors} release errors)` : ''}`);
    if (mem) lines.push(`memory (resident, uncollected garbage included): parent ${mem.parent} MB · ${mem.children.map((c) => `${c.type} ${c.n}×=${c.mb} MB`).join(' · ')}`);
  }
  if (detail !== 'summary') {
    lines.push(`profile dir: ${b.state.profileDir}`, `started: ${b.state.startedAt}`);
    lines.push('add-ons:', ...v.addons.map((a: any) => `  ${a.id} ${a.version}${a.active ? '' : ' (disabled)'}${a.temporary ? ' (temporary)' : ''} autoUpdate=${a.autoUpdate}`));
  }
  lines.push(...pinsStatus(b));
  const drift = readDrift(b);
  if (drift && (drift.items.length || !drift.ok || detail !== 'summary')) lines.push(`${driftSummary(drift)} (compared ${new Date(drift.at).toLocaleString()})`);
  const shadows = Object.entries(readShadows(b));
  if (shadows.length) lines.push(`disabled while a dev copy is installed: ${shadows.map(([id, s]) => `#${id} "${s.name}" ${s.version} (by ${s.by.rel}, ${s.by.mode})`).join('; ')}`);
  return lines.join('\n');
}

async function launch(ctx: Ctx, profile?: string, headless?: boolean): Promise<{ b: Browser; notes: string[] }> {
  const cur = ctx.current();
  if (profile && cur && (cur.personal !== (profile === PERSONAL) || (!cur.personal && profile !== ctx.opts.profile))) {
    fail('PROFILE_SWITCH', `this session is driving ${cur.personal ? 'your own Firefox (personal mode)' : ctx.opts.profile}; one profile at a time`,
      `ff_quit first (${cur.personal ? 'closes only Claude\'s window; your Firefox keeps running' : 'quits that Firefox'}), then ff_launch with profile "${profile}".`);
  }
  const before = ctx.opts.profile;
  if (profile) ctx.opts.profile = profile;
  if (headless !== undefined) ctx.opts.headless = headless;
  ctx.opts.startPersonal = ctx.opts.profile === PERSONAL;
  let b: Browser;
  try { b = await ctx.browser(); } catch (e) {
    // a personal launch that failed (not set up, Firefox running without remote control) leaves the session where it was
    if (ctx.opts.profile === PERSONAL && before !== PERSONAL) ctx.opts.profile = before;
    throw e;
  } finally { ctx.opts.startPersonal = false; }
  const notes = b.launchedNow || (b.personal && b.launchNotes.length) ? b.launchNotes : ['attached to the already-running Firefox'];
  b.launchedNow = false;
  b.launchNotes = [];
  return { b, notes };
}

export const lifecycleTools = [
  tool({
    name: 'ff_launch',
    description: 'Start (or attach to) Firefox on the claude-dev profile: connects BiDi + privileged access, sets up the agent window (parked off-screen, so pages render as if visible) with the "Claude" tab group, installs staged add-ons on first run. Other tools launch on demand, so this is optional. profile "personal" (only when the user asks for their own Firefox): their own profile at page level, in a window Claude opens on-screen (never activated) so the user can watch.',
    args: {
      profile: z.string().optional().describe('Profile name (default claude-dev); "personal" = the user\'s own Firefox, page-level tools only'),
      headless: z.boolean().optional().describe('Headless (test profiles only)'),
    },
    write: true,
    async handler(a, ctx) {
      if (currentClient()) {
        const b = await ctx.browser();
        await b.context();
        return [await describe(b, 'summary'), 'note: attached as another session; Firefox is owned by a different Claude session'].join('\n');
      }
      const { b, notes } = await launch(ctx, a.profile, a.headless);
      return [await describe(b, 'summary'), ...notes.map((n) => `note: ${n}`)].join('\n');
    },
  }),
  tool({
    name: 'ff_status',
    description: 'Versions (Firefox, uBO, Violentmonkey), transport health, profile, ports, agent tabs, scope and checkpoint. Does not launch Firefox.',
    args: {},
    detail: true,
    async handler(a, ctx) {
      const b = ctx.current();
      if (b && !b.dead) return describe(b, a.detail ?? 'summary');
      const cfg = loadConfig();
      if (ctx.opts.profile === PERSONAL) {
        const dir = personalProfileDir();
        return [`PERSONAL MODE (your own Firefox): not connected (ff_launch with profile "personal" starts or attaches)`, ...sessionLines(null), `profile: ${dir ?? 'not found'}${dir ? (personalPrefsOk(dir) ? ' · set up' : ` · NOT SET UP (user runs: ${setupCommand('personal-mode.ps1')})`) : ''}`].join('\n');
      }
      const st = readRunState(profileKey(ctx.opts));
      const staged = fs.existsSync(cfg.addonsDir) ? fs.readdirSync(cfg.addonsDir).filter((f) => f.endsWith('.xpi')) : [];
      const login = readLogin(profileKey(ctx.opts));
      return [
        ...(login ? [`LOGIN HANDOFF since ${login.since}: the profile is open as an ordinary Firefox on ${login.url} (${profileLocked(login.profileDir) ? 'window still open' : 'window closed: ff_handback resumes'})`] : []),
        'Firefox: not connected (any browser tool, or ff_launch, starts it)',
        ...sessionLines(null),
        `firefox binary: ${cfg.firefoxPath}`,
        ...autoConfigLine(),
        `profile ${ctx.opts.profile}: ${cfg.profiles[ctx.opts.profile] ?? `NOT SET UP (user runs: ${setupCommand()})`} · mode ${ctx.opts.profileMode}`,
        `session token: ${readToken() ? 'present' : `MISSING: ${setupHint()}`}`,
        `staged add-ons: ${staged.join(', ') || 'none'}`,
        st ? `run state: Firefox pid ${st.browserPid ?? st.pid} owned by session ${st.ownerPid}${firefoxAlive(st) ? (isAlive(st.ownerPid) ? '' : ' (owner gone; the next call takes it over)') : ' — STALE: that Firefox is gone (cleared on the next launch)'}` : 'run state: none',
      ].join('\n');
    },
  }),
  tool({
    name: 'ff_restart',
    description: 'Restart Firefox cleanly and reconnect; reopens the agent tabs when restore_tabs is true.',
    args: { restore_tabs: z.boolean().default(true) },
    write: true,
    async handler(a, ctx) {
      if (currentClient()) fail('NOT_OWNER', 'this Firefox is owned by another Claude session; only it can restart Firefox', 'ff_quit closes just this session\'s tab group.');
      const b = await ctx.browser();
      const urls = (await b.listTabs()).filter((t) => t.agent).map((t) => t.url);
      const approvals = b.approvals();
      await b.quit();
      ctx.setBrowser(null);
      const { b: nb, notes } = await launch(ctx);
      nb.adoptApprovals(approvals);
      if (a.restore_tabs && urls.length) {
        const first = await nb.context();
        if (urls[0] !== 'about:blank') await nb.bidi.send('browsingContext.navigate', { context: first, url: urls[0], wait: 'complete' }, 60000).catch(() => {});
        for (const u of urls.slice(1)) await nb.createTab(u).catch(() => {});
      }
      const fast = await restoreFastScripts(nb).catch(() => [] as string[]);
      if (fast.length) notes.push(`fast-mode userscripts re-registered: ${fast.join(', ')}`);
      return [`restarted; reopened ${a.restore_tabs ? urls.length : 0} tab(s)`, await describe(nb, 'summary'), ...notes].join('\n');
    },
  }),
  tool({
    name: 'ff_quit',
    description: 'Quit Firefox gracefully (throwaway profiles are deleted). In a session routed through another session\'s Firefox, closes only this session\'s tab group.',
    args: {},
    write: true,
    async handler(_a, ctx) {
      let b = ctx.current();
      if (!b) {
        // this session may own a running Firefox it isn't attached to yet (e.g. after a backend hot reload)
        const st = readRunState(profileKey(ctx.opts));
        if (!st || !firefoxAlive(st) || st.ownerPid !== ownerPid()) return 'Firefox is not running for this session; nothing to quit.';
        b = await ctx.browser();
      }
      if (b.personal) {
        live.closeAll('Claude\'s window was closed (ff_quit)');
        await b.quit();
        ctx.setBrowser(null);
        ctx.opts.profile = 'claude-dev';
        return 'Closed Claude\'s window in your Firefox and ended remote control for this session; your Firefox keeps running. Later browser tools use claude-dev again.';
      }
      const c = currentClient();
      if (c) {
        const n = await b.callChrome<number>(CS.CLOSE_CLIENT_GROUP, { key: c });
        live.close(c, 'this session\'s tab group was closed (ff_quit)');
        delete b.state.clients?.[c];
        b.save();
        return `closed this session's tab group (${n} tab(s)); Firefox keeps running for the session that owns it.`;
      }
      // fast-mode dev copies go with the companion: the installed copies they shadowed run again
      const back = await releaseShadows(b, (s) => s.by.mode === 'fast', 'its fast-mode dev copy ends with this Firefox').catch(() => ({ lines: [] as string[] }));
      live.closeAll('Firefox was quit (ff_quit)');
      await b.quit();
      ctx.setBrowser(null);
      return ['Firefox quit.', ...back.lines].join('\n');
    },
  }),
  tool({
    name: 'ff_kill',
    description: 'KILL SWITCH: revoke the session token, close all connections, kill the Firefox process tree. Every tool then refuses to run until the user re-issues a token (setup.ps1 -TokenOnly).',
    args: { no_restore: z.boolean().default(false).describe('Do not restore the latest checkpoint on the next cold start') },
    write: true,
    async handler(a, ctx) {
      try { fs.unlinkSync(TOKEN_FILE); } catch { /* already revoked */ }
      fs.writeFileSync(path.join(ensureDir(RUN_DIR), 'killed.json'), JSON.stringify({ at: new Date().toISOString(), restore: !a.no_restore, by: 'ff_kill' }));
      live.closeAll('stopped: the kill switch was engaged');
      const b = ctx.current();
      if (b) b.kill();
      ctx.setBrowser(null);
      const login = readLogin(profileKey(ctx.opts));
      if (login) { if (isOurFirefox(login.pid, login.profileDir)) killTree(login.pid); clearLogin(login.key); }
      if (b?.personal) return 'Kill switch engaged: token revoked, connections closed, Claude\'s window closed. Your own Firefox was not killed (personal mode never closes it). The user re-enables with: ' + setupCommand('setup.ps1', '-TokenOnly');
      return 'Kill switch engaged: token revoked, connections closed, Firefox killed. The user re-enables with: ' + setupCommand('setup.ps1', '-TokenOnly');
    },
  }),
  tool({
    name: 'ff_handoff',
    description: 'Hand the browser to the user for a login, CAPTCHA, 2FA or anything Claude must not do. mode "window" (default): shows the agent window on the tab; input tools refuse until ff_handback. mode "login": for sites whose bot check rejects an automated browser (e.g. a Cloudflare checkbox that always fails): closes Firefox and reopens the same profile as an ordinary Firefox (no automation) on the tab\'s page; the user logs in and closes it; ff_handback resumes automation with the login kept. Tell the user what to do, then wait for them in chat.',
    args: {
      reason: z.string().min(1).describe('What the user needs to do, shown in the result'),
      tab: tabArg,
      mode: z.enum(['window', 'login']).default('window'),
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const testLogin = !!process.env.FIREFOX_USE_TEST_LOGIN;
      if (b.state.headless && !testLogin) fail('HEADLESS', 'this Firefox is headless; there is no window to hand over', 'Handoff needs the claude-dev profile run headed (the default for the plugin).');
      const context = await b.context(a.tab);
      if (a.tab) { b.cur = a.tab; b.save(); }
      // a bot check that rejects automated browsers (navigator.webdriver): the window handoff can't pass it
      let switched = '';
      if (a.mode === 'window' && (!b.state.headless || testLogin) && !b.state.throwaway && !b.personal && !currentClient()) {
        const bot = await b.callPage(context, BOT_CHECK).catch(() => null);
        if (bot) { a.mode = 'login'; switched = `This page has a bot check (${bot}) that fails in an automated browser, so this is a login handoff (mode "login").
`; }
      }
      if (a.mode === 'login') {
        if (b.personal) fail('BAD_ARGS', 'login mode is for claude-dev; personal mode is already your own browser', 'Use mode "window".');
        if (b.state.throwaway) fail('BAD_ARGS', 'a throwaway profile is deleted when it closes: a login there would be lost');
        if (currentClient()) fail('NOT_OWNER', 'another Claude session drives this Firefox: a login handoff would close it under that session', 'Ask in the owning session, or use mode "window".');
        const info = await b.callPage(context, '() => location.href').catch(() => null);
        const url = typeof info === 'string' && /^https?:/.test(info) ? info : fail('BAD_ARGS', 'the tab has no web page to log in on', 'Navigate the tab to the login page first.');
        const agentUrls = (await b.listTabs()).filter((t) => t.agent).map((t) => t.url);
        loginCarry.approvals = b.approvals();
        const { key, profileDir, headless } = b.state;
        await b.quit(); // clean: the remote agent's automation prefs are reset on the way out
        ctx.setBrowser(null);
        for (let i = 0; i < 60 && profileLocked(profileDir); i++) await new Promise((r) => setTimeout(r, 250));
        launchPlain(key, profileDir, url, agentUrls, headless && testLogin);
        return switched + [
          `Firefox was closed and the claude-dev profile reopened as an ordinary Firefox (no automation, so no navigator.webdriver) on ${url}.`,
          `Ask the user to: ${a.reason}, and then CLOSE that Firefox window (the login stays in the profile; closing it saves the session).`,
          'Then call ff_handback: it resumes automation with that session (it asks the window to close if it is still open). Other browser tools fail with LOGIN_IN_PROGRESS until then.',
        ].join('\n');
      }
      await b.showWindow(context);
      b.handoff = { reason: a.reason, tab: b.cur ?? 0, since: Date.now() };
      return `The agent window is now shown on tab ${b.cur}. Ask the user to: ${a.reason}\nCall ff_handback once they say they are done (input tools are paused until then).`;
    },
  }),
  tool({
    name: 'ff_handback',
    description: 'End a handoff and resume automation. After a "login" handoff: closes the plain login window if the user left it open, then relaunches automation with the session it saved (cookies, the tab). Reports where the user left the tab.',
    args: {},
    write: true,
    async handler(_a, ctx) {
      const login = ctx.opts.profile !== PERSONAL ? readLogin(profileKey(ctx.opts)) : null;
      if (login) {
        if (!(await closePlain(login))) fail('LOGIN_WINDOW_OPEN', 'the login window is still open (it did not close when asked: maybe a "close tabs?" prompt)', 'Ask the user to close that Firefox window (their login is kept), then call ff_handback again.');
        const b = await ctx.browser(); // resumes the saved session (index.ts getBrowser finishes the login)
        const ctxId = await b.context();
        const info = await b.callPage(ctxId, '() => ({ url: location.href, title: document.title })').catch(() => ({ url: '?', title: '?' }));
        return `login handoff ended after ${Math.round((Date.now() - Date.parse(login.since)) / 1000)} s; automation resumed with the login window's session\ncurrent tab: ${info.title} — ${info.url}${b.launchNotes.length ? `\n${b.launchNotes.map((n) => `note: ${n}`).join('\n')}` : ''}`;
      }
      const b = await ctx.browser();
      const was = b.handoff;
      b.handoff = null;
      await b.afterHandback();
      const ctxId = await b.context();
      const info = await b.callPage(ctxId, '() => ({ url: location.href, title: document.title })').catch(() => ({ url: '?', title: '?' }));
      const m = b.agentWindowMode();
      return `${was ? `handoff ended after ${Math.round((Date.now() - was.since) / 1000)} s` : 'no handoff was active'}; agent window ${m === 'offscreen' ? 'parked off-screen' : m === 'minimized' ? 'minimised' : 'left on-screen'}\ncurrent tab: ${info.title} — ${info.url}`;
    },
  }),
  tool({
    name: 'ff_window',
    description: 'Show Claude\'s window on-screen or park it off-screen, for the rest of this session (config agentWindow sets the start: claude-dev parked off-screen, personal mode visible). Display only: it never lets Claude do more. Neither action activates the window, except that show restoring a minimised window brings it to the front (claude-dev always; personal mode when the user is working in their Firefox). Call it when the user asks ("let me see it" -> show, "run it in the background" -> park).',
    args: {
      action: z.enum(['show', 'park']).describe('"show": a normal window on-screen, where it was before (else centred); "park": claude-dev moves it off-screen (pages keep rendering); personal mode minimises it (there an off-screen window would be throttled anyway)'),
    },
    write: true,
    async handler(a, ctx) {
      if (currentClient()) fail('NOT_OWNER', 'this Firefox and its agent window belong to another Claude session', 'Ask in the session that owns it.');
      const b = await ctx.browser();
      return b.setWindowMode(a.action === 'show' ? 'visible' : 'offscreen');
    },
  }),
  tool({
    name: 'ff_live_view',
    description: 'A live view of this session\'s browser for the user to watch: a page on 127.0.0.1 showing Claude\'s current tab as it changes (about 10 frames/s while a call runs), the tool calls, clicks and tabs, with a Take over button (hands the browser to the user like ff_handoff) and Show window / Run in background. Call it when the user wants to watch or for a demo. action "open" returns the URL: open it in the Claude app\'s built-in browser pane if you have its tools (preview_start with the url), else give the user the link. "close" ends it (the URL stops working); "status" shows viewers and capture timing. View-only: nothing on it sends input to Firefox, and its frames go to the user only, never to Claude.',
    args: {
      action: z.enum(['open', 'close', 'status']).default('open'),
    },
    write: true,
    async handler(a, ctx) {
      if (a.action === 'close') return live.close(currentClient()) ? 'live view closed; its URL no longer works' : 'no live view was open for this session';
      if (a.action === 'status') return live.statusLine(currentClient(), true) ?? 'no live view is open for this session (ff_live_view open starts one)';
      // the view shows this session's browser: start (or attach to) it, as any browser tool does
      const b = await ctx.browser();
      const v = await live.open();
      const notes: string[] = [];
      if (b.state.headless) notes.push('This Firefox is headless: the view works, but Take over and Show window are disabled (no window to show).');
      if (currentClient()) notes.push('This session is routed through another session\'s Firefox: the view shows only this session\'s tab group; Take over is that session\'s own (ff_handoff).');
      return [
        `live view: ${live.url(v)}`,
        'Open it in the Claude app\'s built-in browser pane if you have its tools, else give the user this link (any browser on this machine). It shows only this session\'s tabs, needs no login and works until the session ends, ff_quit, ff_kill or ff_live_view close.',
        'Frames are captured only while the page is open. The user can press Take over there: your next write call then fails with HANDED_OFF; ask them what they want and call ff_handback when they say they are done.',
        ...notes,
      ].join('\n');
    },
  }),
  tool({
    name: 'ff_audit_show',
    description: 'Readable summary of the audit log. since: ISO time or relative like "30m", "2h", "1d".',
    args: {
      since: z.string().optional(),
      tool: z.string().optional(),
      writes_only: z.boolean().default(true),
      limit: z.number().int().positive().max(500).default(30),
    },
    detail: true,
    async handler(a) {
      const entries = auditRead({ since: a.since, tool: a.tool, writesOnly: a.writes_only, limit: a.limit });
      if (!entries.length) return 'No matching audit entries.';
      return entries.map((e) => {
        let s = `${localTime(e.ts).slice(11)} ${e.id} ${e.tool} ${e.status}${e.error ? ` ${e.error.code}` : ''} ${e.ms}ms`;
        if (e.target?.url) s += ` @ ${e.target.url}`;
        if (a.detail !== 'summary') s += `\n    args ${JSON.stringify(e.args).slice(0, a.detail === 'full' ? 2000 : 200)}`;
        if (e.changes?.length) s += `\n    changes ${JSON.stringify(e.changes).slice(0, a.detail === 'full' ? 4000 : 300)}`;
        return s;
      }).join('\n');
    },
  }),
];
