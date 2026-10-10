// dialogs, HTTP auth, site permissions, downloads, clipboard.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail } from '../errors.js';
import { DEFAULT_DIALOG_POLICY, localDevHost, type DialogPolicy } from '../browser/dialogs.js';
import { DL_LIST } from '../browser/downloads.js';
import { currentClient } from '../browser/client.js';
import { sleep } from '../browser/launcher.js';
import type { Browser } from '../browser/session.js';
import { maskText } from '../safety/mask.js';
import { registerUndo } from '../snapshots/undo.js';
import { tool, tabArg, type ToolOutput } from './registry.js';

const actionArg = z.enum(['accept', 'dismiss', 'ask']).optional();

// ------------------------------------------------------------ permissions (privileged side: listing and undo)
const PERMS_LIST = `({ origin }) => {
  const p = Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
  return Services.perms.getAllForPrincipal(p).map((x) => ({ type: x.type, capability: x.capability, expireType: x.expireType, expireTime: x.expireTime }));
}`;
const PERMS_RESTORE = `({ origin, type, before }) => {
  const p = Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
  if (!before) Services.perms.removeFromPrincipal(p, type);
  else Services.perms.addFromPrincipal(p, type, before.capability, before.expireType, before.expireTime);
  return true;
}`;
const PERM_NAMES: Record<string, string> = { geo: 'geolocation', 'desktop-notification': 'notifications', 'autoplay-media': 'autoplay', popup: 'popups', 'persistent-storage': 'persistent-storage', storageAccessAPI: 'user-interaction marker (anti-tracking heuristic, set when the user or Claude interacts with the site)' };
const CAP: Record<number, string> = { 0: 'unknown', 1: 'allow', 2: 'deny', 3: 'prompt', 8: 'allow for session' };
const EXPIRE: Record<number, string> = { 0: 'permanent', 1: 'session', 2: 'until a time', 3: 'policy' };
type Perm = { type: string; capability: number; expireType: number; expireTime: number };

registerUndo('permission', async (b, c) => {
  const [origin, type] = String(c.path).split('|');
  const before = c.before && typeof c.before === 'object' && !(c.before as any).$absent ? c.before : null;
  await b.callChrome(PERMS_RESTORE, { origin, type, before });
  return { line: `permission ${type} of ${origin} -> ${before ? CAP[(before as Perm).capability] ?? (before as Perm).capability : '(not set)'}`, change: { kind: 'permission', path: c.path, before: c.after, after: c.before } };
});

async function originFor(b: Browser, origin: string | undefined, tab?: number): Promise<string> {
  if (origin) {
    try { const o = new URL(/^[a-z][\w+.-]*:\/\//i.test(origin) ? origin : `https://${origin}`).origin; if (o !== 'null') return o; } catch { /* below */ }
    fail('BAD_ARGS', `not an origin: ${origin}`);
  }
  const ctx = await b.context(tab);
  const url: string = (await b.bidi.send('browsingContext.getTree', { root: ctx, maxDepth: 0 })).contexts[0].url;
  try { const o = new URL(url).origin; if (/^https?:/.test(o)) return o; } catch { /* about: */ }
  return fail('NO_ORIGIN', `the tab shows ${url}, which has no web origin`, 'Navigate it to the site first, or pass origin.');
}

// ------------------------------------------------------------ clipboard
/** Headed Windows: read only what claude-dev itself put on the clipboard (owner window in its parent process). */
const CLIP_READ = `({ headless }) => {
  if (!headless) {
    if (Services.appinfo.OS !== "WINNT") return { ours: false, why: "the clipboard owner can only be checked on Windows" };
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    const u = ctypes.open("user32.dll");
    try {
      const A = ctypes.winapi_abi;
      const GetClipboardOwner = u.declare("GetClipboardOwner", A, ctypes.voidptr_t);
      const GetWindowThreadProcessId = u.declare("GetWindowThreadProcessId", A, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t.ptr);
      const h = GetClipboardOwner();
      if (h.isNull()) return { ours: false, why: "the clipboard has no owner window" };
      const pid = ctypes.uint32_t(0);
      GetWindowThreadProcessId(h, pid.address());
      if (pid.value !== Services.appinfo.processID) return { ours: false, why: "another application put it there" };
    } finally { u.close(); }
  }
  const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  t.init(null);
  t.addDataFlavor("text/plain");
  Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, window.browsingContext.currentWindowContext);
  const o = {};
  try { t.getTransferData("text/plain", o); } catch (e) { return { ours: true, text: null }; }
  return { ours: true, text: o.value.QueryInterface(Ci.nsISupportsString).data };
}`;

/** Write text; the previous text content is kept inside Firefox (never sent to Claude) for restore. */
const CLIP_WRITE = `({ text, restore }) => {
  const host = Cu.getGlobalForObject(Services);
  const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
  const readText = () => {
    try {
      const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      t.init(null); t.addDataFlavor("text/plain");
      Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, window.browsingContext.currentWindowContext);
      const o = {}; t.getTransferData("text/plain", o); return o.value.QueryInterface(Ci.nsISupportsString).data;
    } catch (e) { return null; }
  };
  if (restore) {
    if (!("__cfClipSaved" in host)) return "nothing to restore";
    const s = host.__cfClipSaved;
    delete host.__cfClipSaved;
    if (typeof s === "string") { helper.copyString(s); return "restored the earlier text"; }
    Services.clipboard.emptyClipboard(Ci.nsIClipboard.kGlobalClipboard);
    return "cleared (the earlier content was not text and cannot be restored)";
  }
  if (!("__cfClipSaved" in host)) host.__cfClipSaved = readText();
  helper.copyString(text);
  return "written";
}`;

export const dialogTools = [
  tool({
    name: 'dialogs_policy',
    description: 'How alert / confirm / prompt / beforeunload dialogs in this session\'s agent tabs are answered: "accept", "dismiss" or "ask" (left open: the result says OPEN and dialog_handle answers it). Default: dismiss alert/confirm/prompt, accept beforeunload. No arguments = show the policy. Dialogs in the user\'s own tabs are always left to them.',
    args: {
      alert: actionArg, confirm: actionArg, prompt: actionArg, beforeunload: actionArg,
      prompt_text: z.string().optional().describe('Text a prompt() gets when its policy is "accept" (default: empty)'),
      reset: z.boolean().default(false).describe('Back to the default policy'),
    },
    write: true,
    async handler(a, ctx): Promise<ToolOutput> {
      const b = await ctx.browser();
      const key = currentClient();
      const before = b.dialogs.policies.get(key) ?? DEFAULT_DIALOG_POLICY;
      let now: DialogPolicy = a.reset ? { ...DEFAULT_DIALOG_POLICY } : { ...before };
      for (const k of ['alert', 'confirm', 'prompt', 'beforeunload'] as const) if (a[k]) now[k] = a[k]!;
      if (a.prompt_text !== undefined) now = { ...now, prompt_text: a.prompt_text };
      b.dialogs.policies.set(key, now);
      const open = [...b.dialogs.open.values()].filter((e) => e.client === key);
      return {
        text: `dialogs: alert ${now.alert} · confirm ${now.confirm} · prompt ${now.prompt}${now.prompt_text !== undefined ? ` (text ${JSON.stringify(now.prompt_text)})` : ''} · beforeunload ${now.beforeunload}${open.length ? `\nOPEN now: ${open.map((e) => `${e.type} ${JSON.stringify(e.message.slice(0, 80))}`).join('; ')} (dialog_handle)` : ''}`,
        changes: [{ kind: 'dialogs_policy', before, after: now }],
      };
    },
  }),
  tool({
    name: 'dialog_handle',
    description: 'Answer the dialog left open in an agent tab (dialogs_policy "ask"): accept (OK; with text for a prompt) or dismiss (Cancel). Accepting a confirm that submits, buys, sends or deletes something is subject to the safety rules: the user\'s OK first.',
    args: { accept: z.boolean(), text: z.string().optional().describe('prompt(): the text to enter'), tab: tabArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const mine = [...b.dialogs.open.entries()].filter(([, e]) => e.client === currentClient());
      let hit = a.tab !== undefined ? mine.find(([c]) => c === b.state.tabs?.[String(a.tab)]) : undefined;
      if (!hit && a.tab === undefined) hit = mine.find(([c]) => c === b.state.tabs?.[String(b.cur)]) ?? (mine.length === 1 ? mine[0] : undefined);
      if (!hit) fail('NO_DIALOG', mine.length ? `${mine.length} dialog(s) open; pass the tab` : 'no dialog is open in this session\'s tabs', 'Dialogs stay open only with dialogs_policy "ask".');
      const e = await b.dialogs.answer(hit![0], a.accept, a.text);
      return `${e.type} ${JSON.stringify(maskText(e.message).slice(0, 200))}: ${e.result}`;
    },
  }),
  tool({
    name: 'http_auth',
    description: 'HTTP authentication challenges (401/407) in this session\'s agent tabs: "cancel" (default: the page shows the server\'s 401 response), "prompt" (leave Firefox\'s own dialog, for the user to answer during ff_handoff), or "credentials" — test credentials for a LOCAL development server only (localhost, 127.0.0.1, *.localhost, *.test); never real credentials. Every challenge is reported in the result of the call that hit it. No arguments = show the setting.',
    args: {
      mode: z.enum(['cancel', 'prompt', 'credentials']).optional(),
      url: z.string().optional().describe('Only challenges from matching URLs (substring, /regex/ or * glob); others are cancelled'),
      username: z.string().optional(),
      password: z.string().optional().describe('credentials mode: a test password for the local dev server'),
    },
    write: true,
    async handler(a, ctx): Promise<ToolOutput> {
      const b = await ctx.browser();
      const key = currentClient();
      const cur = b.dialogs.auth.get(key) ?? { mode: 'cancel' as const };
      if (!a.mode) return { text: `http auth: ${cur.mode}${cur.url ? ` for ${cur.url}` : ''}${cur.mode === 'credentials' ? ` as ${cur.username} (local dev hosts only)` : ''}` };
      if (a.mode === 'credentials') {
        if (!a.username || a.password === undefined) fail('BAD_ARGS', 'credentials mode needs username and password');
        if (a.url && /^[a-z]+:\/\//i.test(a.url) && !localDevHost(a.url)) fail('DENIED', `${a.url} is not a local development host`, 'Credentials are only ever sent to localhost, 127.0.0.1, [::1], *.localhost and *.test. For real sites, ff_handoff and let the user log in.');
      }
      b.dialogs.auth.set(key, { mode: a.mode, url: a.url, username: a.username, password: a.password });
      await b.dialogs.syncAuth();
      return {
        text: `http auth: ${a.mode}${a.url ? ` for ${a.url}` : ''}${a.mode === 'credentials' ? ` as ${a.username} (sent only to local dev hosts; other challenges are cancelled)` : ''}`,
        changes: [{ kind: 'http_auth', before: { mode: cur.mode, url: cur.url }, after: { mode: a.mode, url: a.url, username: a.username } }],
      };
    },
  }),
  tool({
    name: 'permissions_get',
    description: 'Site permissions stored for an origin (default: the current tab\'s): geolocation, notifications, camera, microphone, popups, autoplay, storage access, …, with allow/deny/prompt and whether permanent or for the session.',
    args: { origin: z.string().optional(), tab: tabArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const origin = await originFor(b, a.origin, a.tab);
      const list = await b.callChrome<Perm[]>(PERMS_LIST, { origin });
      if (!list.length) return `no stored permissions for ${origin} (everything at the default: ask, or the browser default)`;
      return `${list.length} permission(s) for ${origin}\n${list.map((p) => `  ${PERM_NAMES[p.type] ?? p.type}${PERM_NAMES[p.type] ? ` (${p.type})` : ''}: ${CAP[p.capability] ?? p.capability} · ${EXPIRE[p.expireType] ?? p.expireType}${p.expireType === 2 && p.expireTime ? ` ${new Date(p.expireTime).toISOString().slice(0, 16)}Z` : ''}`).join('\n')}`;
    },
  }),
  tool({
    name: 'permissions_set',
    description: 'Set a site permission for an origin (default: the current tab\'s) with WebDriver BiDi permissions: name as in the Permissions API ("geolocation", "notifications", "camera", "microphone", "persistent-storage", "midi", "storage-access", …), state granted / denied / prompt. Needs scope "site_data"; audited, undo-able.',
    args: { name: z.string().min(1), state: z.enum(['granted', 'denied', 'prompt']), origin: z.string().optional(), tab: tabArg },
    write: true,
    async handler(a, ctx): Promise<ToolOutput> {
      const b = await ctx.browser();
      const origin = await originFor(b, a.origin, a.tab);
      await ctx.requireScope('site_data', b);
      const before = await b.callChrome<Perm[]>(PERMS_LIST, { origin });
      await b.bidi.send('permissions.setPermission', { descriptor: { name: a.name }, state: a.state, origin });
      const after = await b.callChrome<Perm[]>(PERMS_LIST, { origin });
      const key = (p: Perm) => `${p.type}:${p.capability}:${p.expireType}`;
      const types = new Set([...before, ...after].map((p) => p.type));
      const changes = [...types].filter((t) => key(before.find((p) => p.type === t) ?? ({} as Perm)) !== key(after.find((p) => p.type === t) ?? ({} as Perm)))
        .map((t) => ({ kind: 'permission', path: `${origin}|${t}`, before: before.find((p) => p.type === t) ?? { $absent: true }, after: after.find((p) => p.type === t) ?? { $absent: true } }));
      const now = after.filter((p) => changes.some((c) => c.path.endsWith(`|${p.type}`)));
      return { text: `${a.name} = ${a.state} for ${origin}${now.length ? ` (stored as ${now.map((p) => `${p.type}: ${CAP[p.capability] ?? p.capability}, ${EXPIRE[p.expireType] ?? p.expireType}`).join('; ')})` : changes.length ? ' (removed from the store: back to the default)' : ' (no change)'}`, changes };
    },
  }),
  tool({
    name: 'downloads_list',
    description: 'Downloads started from this session\'s agent tabs: URL, file in the sandbox folder, state, size; plus downloads the guard blocked (from a non-local site without the user\'s OK — scope "downloads" — or outside the sandbox). The user\'s own downloads are not listed.',
    args: {},
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const r = await b.callChrome<{ downloads: any[]; others: number; events: any[]; guard: boolean }>(DL_LIST, { key: currentClient() });
      const lines = r.downloads.sort((x, y) => x.start - y.start).map((d) => `${d.state} · ${path.basename(d.path ?? '')} · ${d.total ?? d.bytes} B${d.type ? ` · ${d.type}` : ''}\n  ${maskText(d.url)}${a.detail !== 'summary' ? `\n  -> ${d.path}` : ''}`);
      for (const e of r.events) lines.push(`BLOCKED ${new Date(e.ts).toISOString().slice(11, 19)}Z ${maskText(e.url)}: ${e.why}`);
      return `${r.downloads.length} download(s) from this session's tabs${r.others ? ` (${r.others} other download(s) not listed)` : ''}${r.guard ? '' : ' · WARNING: downloads guard not running'}${lines.length ? '\n' + lines.join('\n') : ''}`;
    },
  }),
  tool({
    name: 'downloads_wait',
    description: 'Wait until a download from this session\'s tabs (matching pattern: URL or file name substring, optional) finishes, fails or is blocked; returns the file path in the sandbox folder. Counts downloads started up to lookback_ms before the call (default 10 s), so call it right after the click.',
    args: {
      pattern: z.string().optional(),
      timeout_ms: z.number().int().positive().max(600000).default(30000),
      lookback_ms: z.number().int().min(0).max(600000).default(10000),
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const t0 = Date.now(), from = t0 - a.lookback_ms;
      const match = (s: string) => !a.pattern || s.includes(a.pattern);
      const seen = (b.adapters.get(`downloadsSeen:${currentClient()}`) as Set<string> | undefined) ?? new Set<string>();
      b.adapters.set(`downloadsSeen:${currentClient()}`, seen);
      let last: any[] = [];
      for (;;) {
        const r = await b.callChrome<{ downloads: any[]; events: any[] }>(DL_LIST, { key: currentClient() });
        // what an earlier downloads_wait already reported (a block before the user's OK, a finished file) is skipped
        last = r.downloads.filter((d) => d.start >= from && !seen.has(`d${d.start}|${d.url}`) && (match(d.url) || match(path.basename(d.path ?? '')))).sort((x, y) => y.start - x.start);
        const cur = last[0];
        const blocked = r.events.find((e) => e.ts >= from && !seen.has(`e${e.ts}|${e.url}`) && match(e.url));
        if (blocked) {
          seen.add(`e${blocked.ts}|${blocked.url}`);
          for (const d of last) if (d.url === blocked.url && d.state !== 'in progress') seen.add(`d${d.start}|${d.url}`);
          fail('DOWNLOAD_BLOCKED', `${maskText(blocked.url)}: ${blocked.why}`, /non-local/.test(blocked.why) ? 'Ask the user in chat whether this download is OK; on yes, scope_set with area "downloads" (user_said) and start it again.' : undefined);
        }
        const done = cur && cur.state !== 'in progress' ? cur : undefined;
        if (done) seen.add(`d${done.start}|${done.url}`);
        if (done) {
          let size = '';
          try { size = ` · ${fs.statSync(done.path).size} B on disk`; } catch { /* removed or failed */ }
          if (done.state !== 'done') fail('DOWNLOAD_FAILED', `${maskText(done.url)}: ${done.state}`);
          return `downloaded ${maskText(done.url)}\n-> ${done.path}${size}${done.type ? ` · ${done.type}` : ''} · ${Math.round((Date.now() - t0))} ms`;
        }
        if (Date.now() - t0 > a.timeout_ms) fail('TIMEOUT', `no download${a.pattern ? ` matching ${a.pattern}` : ''} finished within ${a.timeout_ms} ms`, undefined, { inProgress: last.map((d) => `${maskText(d.url)} ${d.bytes} B`).join('; ') || 'none started' });
        await sleep(250);
      }
    },
  }),
  tool({
    name: 'clipboard_read',
    description: 'Read the clipboard text — only content claude-dev itself put there (a page\'s copy, or clipboard_write): anything another application copied (the user\'s clipboard) is refused unread. Headless Firefox has its own clipboard.',
    args: {},
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const r = await b.callChrome<{ ours: boolean; why?: string; text?: string | null }>(CLIP_READ, { headless: !!b.state.headless });
      if (!r.ours) fail('CLIPBOARD_NOT_OURS', `the clipboard holds something claude-dev did not put there (${r.why}); not read`, 'It is the user\'s. Copy in the page first (e.g. click its copy button, or key ctrl+c), then read.');
      if (r.text == null) return 'the clipboard holds no text';
      return `clipboard (${r.text.length} chars): ${JSON.stringify(maskText(r.text).slice(0, 4000))}${r.text.length > 4000 ? '…' : ''}`;
    },
  }),
  tool({
    name: 'clipboard_write',
    description: 'Put text on the clipboard (e.g. to test a page\'s paste handling with key ctrl+v). On a visible Firefox this is the system clipboard: the user\'s earlier text is kept inside Firefox (never read by Claude) and clipboard_write(restore:true) puts it back — do that when done.',
    args: { text: z.string().optional(), restore: z.boolean().default(false) },
    write: true,
    async handler(a, ctx): Promise<ToolOutput> {
      if (!a.restore && a.text === undefined) fail('BAD_ARGS', 'give text, or restore:true');
      const b = await ctx.browser();
      const r = await b.callChrome<string>(CLIP_WRITE, { text: a.text ?? '', restore: a.restore });
      return { text: a.restore ? `clipboard: ${r}` : `clipboard: ${a.text!.length} chars written${b.state.headless ? ' (headless Firefox: its own clipboard)' : ' (system clipboard; restore:true puts the user\'s earlier text back)'}`, changes: [{ kind: 'clipboard', after: a.restore ? 'restored' : `${a.text!.length} chars` }] };
    },
  }),
];
