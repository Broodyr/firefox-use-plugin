// site storage: cookies, localStorage / sessionStorage, IndexedDB, Cache Storage, service workers,
// clearing site data. Reads need nothing; writes need scope "site_data" and are audited (cookies created by
// cookies_set and localStorage changes are undo-able). Values are masked like everything else, plus
// values under secret-looking keys / every cookie value, unless unmask names them.
import { z } from 'zod';
import { fail } from '../errors.js';
import * as SS from '../browser/siteScripts.js';
import { frameContext } from '../browser/realms.js';
import type { Browser } from '../browser/session.js';
import { maskText, maskValue } from '../safety/mask.js';
import { registerUndo } from '../snapshots/undo.js';
import { auditValue, allowSet } from './privileged.js';
import { frameArg } from './realms.js';
import { tool, tabArg, type ToolOutput } from './registry.js';

const originArg = z.string().optional().describe('Origin ("https://example.com") or host; default: the origin of the current tab (or of `frame`)');
/** storage keys whose values are treated as secrets (masked unless unmask names the key) */
const SECRET_KEY = /(token|secret|session|auth|passw|credential|api[_-]?key|jwt|sid$|csrf|xsrf)/i;

type Allow = Set<string> | undefined;
const maskItem = (key: string, v: string | null, allow: Allow): string | null => {
  if (v == null) return v;
  if (SECRET_KEY.test(key) && !allow?.has(key.toLowerCase())) return `<masked: ${v.length} chars>`;
  return maskText(v, allow);
};
const preview = (s: string | null, max: number) => (s == null ? 'null' : s.length > max ? `${JSON.stringify(s.slice(0, max))}… (${s.length} chars)` : JSON.stringify(s));
const auditItem = (key: string, v: string | null | undefined) => (v === null || v === undefined ? { $absent: true } : SECRET_KEY.test(key) ? '<masked>' : auditValue(v));

/** "https://x.com", "https://x.com/path", "x.com" -> origin; a page's origin by default. */
async function siteOrigin(b: Browser, a: { origin?: string; tab?: number; frame?: number | string }): Promise<{ origin: string; context?: string }> {
  if (a.origin) {
    let u: URL;
    try { u = new URL(/^[a-z][\w+.-]*:\/\//i.test(a.origin) ? a.origin : `https://${a.origin}`); } catch { fail('BAD_ARGS', `not an origin: ${a.origin}`); }
    if (!/^https?:$/.test(u!.protocol)) fail('BAD_ARGS', `site storage tools take http(s) origins, not ${u!.protocol}`, 'Extension storage: ext_storage_get.');
    return { origin: u!.origin };
  }
  const context = await frameContext(b, await b.context(a.tab), a.frame);
  const url: string = (await b.bidi.send('browsingContext.getTree', { root: context, maxDepth: 0 })).contexts[0].url;
  let o = 'null';
  try { o = new URL(url).origin; } catch { /* about: */ }
  if (!/^https?:/.test(o)) fail('NO_ORIGIN', `the ${a.frame !== undefined ? 'frame' : 'tab'} shows ${url}, which has no web origin`, 'Navigate it to the site first, or pass origin.');
  return { origin: o, context };
}

function cookieMatches(c: any, domain?: string): boolean {
  if (!domain) return true;
  const d = domain.replace(/^\./, '').toLowerCase(), cd = String(c.domain).replace(/^\./, '').toLowerCase();
  return d === cd || d.endsWith(`.${cd}`) || cd.endsWith(`.${d}`);
}
const cookieValue = (c: any): string => (c.value?.type === 'string' ? c.value.value : `[base64, ${String(c.value?.value ?? '').length} chars]`);

// ------------------------------------------------------------ web storage (local / session)
async function webStorage(b: Browser, kind: 'local' | 'session', a: any): Promise<{ origin: string; res: any }> {
  const o = await siteOrigin(b, a);
  // a document's own storage when the tab (or frame) shows that origin; any other origin's localStorage directly
  let pageCtx = o.context;
  if (a.origin && !pageCtx) {
    const ctx = await frameContext(b, await b.context(a.tab), a.frame).catch(() => null);
    if (ctx) {
      const url: string = (await b.bidi.send('browsingContext.getTree', { root: ctx, maxDepth: 0 })).contexts[0].url;
      try { if (new URL(url).origin === o.origin) pageCtx = ctx; } catch { /* about: */ }
    }
  }
  if (pageCtx) return { origin: o.origin, res: JSON.parse(await b.callPage(pageCtx, SS.PAGE_STORAGE, [kind, a.op, a.key ?? null, a.value ?? null])) };
  if (kind === 'session') fail('NO_DOCUMENT', `sessionStorage belongs to a tab, and no agent tab shows ${o.origin}`, 'Navigate a tab there (or pass the frame that shows it), then retry without origin.');
  return { origin: o.origin, res: await b.callChrome(SS.LS, { origin: o.origin, op: a.op, key: a.key ?? null, value: a.value ?? null }) };
}

function storageTool(kind: 'local' | 'session') {
  const name = `${kind}_storage`;
  return tool({
    name,
    description: kind === 'local'
      ? 'Read or change localStorage of the current tab\'s origin (or any origin, without loading it): op list (default) / get / set / remove / clear. Values under secret-looking keys are masked (unmask: [key]). Writes need scope "site_data"; audited, undo-able.'
      : 'Read or change sessionStorage of the current tab (or a frame): op list (default) / get / set / remove / clear. sessionStorage belongs to the tab, so the tab must show the origin. Writes need scope "site_data"; audited.',
    args: {
      op: z.enum(['list', 'get', 'set', 'remove', 'clear']).default('list'),
      key: z.string().optional(),
      value: z.string().optional().describe('op set: the string to store (JSON.stringify objects yourself)'),
      origin: originArg,
      tab: tabArg,
      frame: frameArg,
    },
    write: true,
    detail: true,
    unmask: true,
    async handler(a, ctx): Promise<ToolOutput> {
      if (['get', 'set', 'remove'].includes(a.op) && a.key === undefined) fail('BAD_ARGS', `op ${a.op} needs key`);
      if (a.op === 'set' && a.value === undefined) fail('BAD_ARGS', 'op set needs value');
      const b = await ctx.browser();
      const allow = allowSet(a.unmask);
      const writing = !['list', 'get'].includes(a.op);
      if (writing) await ctx.requireScope('site_data', b);
      const { origin, res } = await webStorage(b, kind, a);
      const label = `${kind}Storage of ${origin}`;
      if (a.op === 'list') {
        const items: [string, string][] = res.items;
        const max = a.detail === 'full' ? 2000 : a.detail === 'normal' ? 300 : 80;
        return { text: `${items.length} item(s) in ${label}${items.length ? '\n' : ''}${items.slice(0, 200).map(([k, v]) => `  ${JSON.stringify(k)} = ${preview(maskItem(k, v, allow), max)}`).join('\n')}${items.length > 200 ? `\n  … ${items.length - 200} more` : ''}` };
      }
      if (a.op === 'get') return { text: `${label} ${JSON.stringify(a.key)} = ${preview(maskItem(a.key!, res.value, allow), a.detail === 'summary' ? 4000 : 20000)}` };
      const before: Record<string, string | null> = res.before;
      const changes = Object.entries(before).slice(0, 500).map(([k, v]) => ({
        kind: kind === 'local' ? 'web_storage' : 'session_storage', path: `${kind}|${origin}|${k}`,
        before: auditItem(k, v), after: a.op === 'set' ? auditItem(k, a.value) : { $absent: true },
      }));
      const what = a.op === 'clear' ? `cleared ${Object.keys(before).length} item(s)` : a.op === 'set' ? `${JSON.stringify(a.key)} ${before[a.key!] == null ? 'added' : 'changed'}` : `${JSON.stringify(a.key)} ${before[a.key!] == null ? 'was not set' : 'removed'}`;
      return { text: `${label}: ${what}${kind === 'session' ? ' (tab-bound: not undo-able)' : ''}`, changes };
    },
  });
}

registerUndo('web_storage', async (b, c) => {
  const [, origin, ...rest] = String(c.path).split('|');
  const key = rest.join('|');
  const absent = !c.before || (typeof c.before === 'object' && (c.before as any).$absent);
  const r = await b.callChrome(SS.LS, { origin, op: absent ? 'remove' : 'set', key, value: absent ? null : String(c.before) });
  return { line: `localStorage of ${origin} ${JSON.stringify(key)} -> ${absent ? '(removed)' : 'previous value'}`, change: { kind: 'web_storage', path: c.path, before: auditItem(key, r.before[key]), after: c.before } };
});

registerUndo('cookie', async (b, c) => {
  // only cookies that did not exist before can be undone (other before-values are masked in the audit log)
  const [domain, path, ...rest] = String(c.path).split('|');
  const name = rest.join('|');
  await b.bidi.send('storage.deleteCookies', { filter: { name, domain, path } });
  return { line: `cookie ${name} (${domain}${path}) -> deleted (did not exist before)`, change: { kind: 'cookie', path: c.path, before: '<masked>', after: { $absent: true } } };
});

export const siteStorageTools = [
  tool({
    name: 'cookies_get',
    description: 'List cookies (all, or by domain / name): name, domain, path, flags, expiry, size. Values are masked; unmask: ["<cookie name>"] reveals one (audited).',
    args: {
      domain: z.string().optional().describe('Domain: also matches parent-domain cookies sent to it and subdomain cookies'),
      name: z.string().optional(),
    },
    detail: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const allow = allowSet(a.unmask);
      const r = await b.bidi.send('storage.getCookies', { filter: a.name ? { name: a.name } : {} });
      const list = (r.cookies as any[]).filter((c) => cookieMatches(c, a.domain));
      if (!list.length) return `no cookies${a.domain ? ` for ${a.domain}` : ''}${a.name ? ` named ${a.name}` : ''}`;
      const lines = list.slice(0, 300).map((c) => {
        const v = allow?.has(String(c.name).toLowerCase()) ? maskText(cookieValue(c), allow) : `<masked: ${cookieValue(c).length} chars>`;
        const exp = c.expiry ? `expires ${new Date(c.expiry * 1000).toISOString().slice(0, 16)}Z` : 'session';
        return `${c.name}=${v} · ${c.domain}${c.path}${c.httpOnly ? ' · httpOnly' : ''}${c.secure ? ' · secure' : ''} · sameSite=${c.sameSite}${a.detail === 'summary' ? '' : ` · ${exp} · ${c.size} B`}`;
      });
      return `${list.length} cookie(s)${list.length > 300 ? ' (first 300)' : ''}\n${lines.join('\n')}`;
    },
  }),
  tool({
    name: 'cookies_set',
    description: 'Set a cookie (BiDi storage.setCookie). Needs scope "site_data"; audited; a cookie that did not exist before is undo-able.',
    args: {
      name: z.string().min(1),
      value: z.string(),
      domain: z.string().min(1).describe('e.g. "example.com" (also sent to subdomains when it starts with ".")'),
      path: z.string().default('/'),
      http_only: z.boolean().default(false),
      secure: z.boolean().default(false),
      same_site: z.enum(['strict', 'lax', 'none']).default('lax').describe('"none" needs secure'),
      expires: z.union([z.number(), z.string()]).optional().describe('Epoch seconds or an ISO date; omit for a session cookie'),
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      await ctx.requireScope('site_data', b);
      let expiry: number | undefined;
      if (a.expires !== undefined) {
        expiry = typeof a.expires === 'number' ? Math.round(a.expires) : Math.round(Date.parse(a.expires) / 1000);
        if (!Number.isFinite(expiry)) fail('BAD_ARGS', `expires: not a date: ${a.expires}`);
      }
      const existed = (await b.bidi.send('storage.getCookies', { filter: { name: a.name, domain: a.domain, path: a.path } })).cookies.length > 0;
      await b.bidi.send('storage.setCookie', { cookie: {
        name: a.name, value: { type: 'string', value: a.value }, domain: a.domain, path: a.path,
        httpOnly: a.http_only, secure: a.secure, sameSite: a.same_site, ...(expiry !== undefined ? { expiry } : {}),
      } });
      return {
        text: `cookie ${a.name} ${existed ? 'replaced' : 'set'} for ${a.domain}${a.path}${expiry ? ` until ${new Date(expiry * 1000).toISOString()}` : ' (session)'}`,
        changes: [{ kind: 'cookie', path: `${a.domain}|${a.path}|${a.name}`, before: existed ? '<masked>' : { $absent: true }, after: '<masked>' }],
      };
    },
  }),
  tool({
    name: 'cookies_delete',
    description: 'Delete cookies by name and/or domain (path optional). Needs scope "site_data"; audited (not undo-able: values are never logged).',
    args: { name: z.string().optional(), domain: z.string().optional(), path: z.string().optional() },
    write: true,
    async handler(a, ctx) {
      if (!a.name && !a.domain) fail('BAD_ARGS', 'give name and/or domain', 'To clear every cookie of a site use site_data_clear(origin, ["cookies"]).');
      const b = await ctx.browser();
      await ctx.requireScope('site_data', b);
      const r = await b.bidi.send('storage.getCookies', { filter: a.name ? { name: a.name } : {} });
      const hit = (r.cookies as any[]).filter((c) => cookieMatches(c, a.domain) && (!a.path || c.path === a.path));
      for (const c of hit) await b.bidi.send('storage.deleteCookies', { filter: { name: c.name, domain: c.domain, path: c.path } });
      return {
        text: hit.length ? `deleted ${hit.length} cookie(s): ${hit.slice(0, 30).map((c) => `${c.name} (${c.domain}${c.path})`).join(', ')}` : 'no matching cookies',
        changes: hit.map((c) => ({ kind: 'cookie_deleted', path: `${c.domain}|${c.path}|${c.name}`, before: '<masked>', after: { $absent: true } })),
      };
    },
  }),
  storageTool('local'),
  storageTool('session'),
  tool({
    name: 'indexeddb_list',
    description: 'IndexedDB of an origin (default: the current tab\'s): databases with version, object stores (keyPath, autoIncrement, record count) and indexes. First-party storage; the site need not be open.',
    args: { origin: originArg, tab: tabArg, frame: frameArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const { origin } = await siteOrigin(b, a);
      const dbs = await b.callChrome<any[]>(SS.IDB_LIST, { origin });
      if (!dbs.length) return `no IndexedDB databases for ${origin}`;
      return `${dbs.length} database(s) for ${origin}\n` + dbs.map((d) => `db ${JSON.stringify(d.name)} v${d.version}: ${d.stores.length ? '' : 'no object stores'}\n` + d.stores.map((s: any) =>
        `  store ${JSON.stringify(s.name)}: ${s.count} record(s) · keyPath ${JSON.stringify(s.keyPath)}${s.autoIncrement ? ' · autoIncrement' : ''}${s.indexes.length ? ` · indexes: ${s.indexes.map((i: any) => `${i.name}(${JSON.stringify(i.keyPath)}${i.unique ? ' unique' : ''}${i.multiEntry ? ' multiEntry' : ''})`).join(', ')}` : ''}`).join('\n')).join('\n');
    },
  }),
  tool({
    name: 'indexeddb_read',
    description: 'Read records of an IndexedDB object store (or one of its indexes), with an optional key range, paging and direction. Values are serialised (Dates, Blobs, typed arrays labelled) and masked.',
    args: {
      db: z.string(),
      store: z.string(),
      index: z.string().optional(),
      query: z.object({ only: z.any().optional(), lower: z.any().optional(), upper: z.any().optional(), lower_open: z.boolean().optional(), upper_open: z.boolean().optional() }).optional()
        .describe('Key range on the store key (or the index key): {only} or {lower?, upper?, lower_open?, upper_open?}'),
      limit: z.number().int().min(1).max(500).default(20),
      offset: z.number().int().min(0).default(0),
      direction: z.enum(['next', 'prev', 'nextunique', 'prevunique']).default('next'),
      origin: originArg,
      tab: tabArg,
      frame: frameArg,
    },
    detail: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const allow = allowSet(a.unmask);
      const { origin } = await siteOrigin(b, a);
      const r = await b.callChrome<{ total: number; rows: any[]; keyPath: unknown }>(SS.IDB_READ, { origin, db: a.db, store: a.store, index: a.index, query: a.query, limit: a.limit, offset: a.offset, direction: a.direction });
      const max = a.detail === 'full' ? 20000 : a.detail === 'normal' ? 1500 : 300;
      const lines = r.rows.map((x) => {
        const v = JSON.stringify(maskValue(x.value, 0, allow));
        return `  ${JSON.stringify(x.key)}${x.primaryKey !== undefined ? ` (primary ${JSON.stringify(x.primaryKey)})` : ''} → ${v.length > max ? `${v.slice(0, max)}… (${v.length} chars)` : v}`;
      });
      return `${a.db}/${a.store}${a.index ? ` index ${a.index}` : ''} of ${origin}: ${r.total} record(s)${a.query ? ' in range' : ''}; showing ${r.rows.length ? `${a.offset + 1}-${a.offset + r.rows.length}` : 'none'}${r.total > a.offset + r.rows.length ? ` (next: offset ${a.offset + r.rows.length})` : ''}\n${lines.join('\n')}`;
    },
  }),
  tool({
    name: 'cache_storage_list',
    description: 'Cache Storage (the Cache API used by service workers) of an origin: caches, entry counts and the first entries (method, URL, status, content type).',
    args: { origin: originArg, cache: z.string().optional().describe('Only this cache'), limit: z.number().int().min(1).max(500).default(20).describe('Entries listed per cache'), tab: tabArg, frame: frameArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const { origin } = await siteOrigin(b, a);
      const list = await b.callChrome<any[]>(SS.CACHES_LIST, { origin, cache: a.cache, limit: a.limit });
      if (!list.length) return `no Cache Storage caches for ${origin}${a.cache ? ` named ${a.cache}` : ''}`;
      return list.map((c) => `cache ${JSON.stringify(c.name)}: ${c.count} entr${c.count === 1 ? 'y' : 'ies'}\n` + c.entries.map((e: any) =>
        `  ${e.method} ${e.url} → ${e.status ?? '?'}${e.type ? ` ${e.type}` : ''}${e.length ? ` ${e.length} B` : ''}`).join('\n') + (c.count > c.entries.length ? `\n  … ${c.count - c.entries.length} more` : '')).join('\n');
    },
  }),
  tool({
    name: 'service_workers',
    description: 'Service worker registrations: op "list" (of an origin, default the current tab\'s; origin "all" for every one) or "unregister" (scope URL, or "all" for the origin\'s). Unregistering needs scope "site_data" and is audited (not undo-able).',
    args: {
      op: z.enum(['list', 'unregister']).default('list'),
      origin: z.string().optional().describe('Origin, host, or "all" (list only); default: the current tab\'s origin'),
      scope: z.string().optional().describe('unregister: the registration scope URL, or "all"'),
      tab: tabArg,
    },
    write: true,
    async handler(a, ctx): Promise<ToolOutput> {
      const b = await ctx.browser();
      const all = a.origin === 'all';
      if (all && a.op !== 'list') fail('BAD_ARGS', 'unregister needs one origin');
      const origin = all ? null : (await siteOrigin(b, a)).origin;
      const regs = await b.callChrome<any[]>(SS.SW_LIST, { origin });
      if (a.op === 'list') {
        if (!regs.length) return { text: `no service workers${origin ? ` for ${origin}` : ''}` };
        const w = (x: any) => (x ? `${x.state}${x.handlesFetch ? ', handles fetch' : ''}` : '-');
        return { text: regs.map((r) => `${r.scope}\n  script ${r.script} · active: ${w(r.active)}${r.waiting ? ` · waiting: ${w(r.waiting)}` : ''}${r.installing ? ` · installing: ${w(r.installing)}` : ''}${r.lastUpdate ? ` · updated ${new Date(r.lastUpdate * 1000).toISOString().slice(0, 16)}Z` : ''}`).join('\n') };
      }
      if (!a.scope) fail('BAD_ARGS', 'unregister needs scope (a registration scope URL from op list, or "all")');
      const targets = a.scope === 'all' ? regs : regs.filter((r) => r.scope === a.scope);
      if (!targets.length) fail('NOT_FOUND', `no registration ${a.scope === 'all' ? '' : `with scope ${a.scope} `}for ${origin}`, 'service_workers (op list) shows the scopes.');
      await ctx.requireScope('site_data', b);
      const lines: string[] = [];
      for (const r of targets) lines.push(`${r.scope}: ${await b.callChrome<string>(SS.SW_UNREGISTER, { origin, scope: r.scope })}`);
      return { text: `${lines.join('\n')}\n(open pages keep their worker until they reload)`, changes: targets.map((r) => ({ kind: 'service_worker_unregistered', path: r.scope, before: r.script })) };
    },
  }),
  tool({
    name: 'site_data_clear',
    description: 'Clear stored data of an origin (default: the current tab\'s), or of its whole site with site:true (every origin of the registrable domain). types: cookies, storage (localStorage, IndexedDB, Cache Storage, service workers, other quota storage), cache (HTTP/image cache), permissions. Needs scope "site_data"; audited; CANNOT be undone (snapshots do not cover site data).',
    args: {
      origin: originArg,
      types: z.array(z.enum(['cookies', 'storage', 'cache', 'permissions'])).min(1).default(['cookies', 'storage']),
      site: z.boolean().default(false).describe('The whole site (subdomains included), not just this origin'),
      tab: tabArg,
    },
    write: true,
    async handler(a, ctx): Promise<ToolOutput> {
      const b = await ctx.browser();
      const { origin } = await siteOrigin(b, a);
      await ctx.requireScope('site_data', b);
      const FLAGS: Record<string, string[]> = {
        cookies: ['CLEAR_COOKIES'],
        storage: ['CLEAR_DOM_STORAGES?', 'CLEAR_DOM_QUOTA'],
        cache: ['CLEAR_NETWORK_CACHE', 'CLEAR_IMAGE_CACHE?', 'CLEAR_JS_CACHE?', 'CLEAR_CSS_CACHE?'],
        permissions: ['CLEAR_SITE_PERMISSIONS'],
      };
      const r = await b.callChrome<{ failed: number; site: string | null }>(SS.SITE_CLEAR, { origin, site: a.site, flags: a.types.flatMap((t) => FLAGS[t]) });
      return {
        text: `cleared ${a.types.join(', ')} for ${r.site ? `the site ${r.site} (all its origins)` : origin}${r.failed ? ` (some cleaners failed: flags ${r.failed})` : ''}. Open pages keep what they hold in memory until they reload.`,
        changes: [{ kind: 'site_data_clear', path: r.site ?? origin, after: a.types }],
      };
    },
  }),
];
