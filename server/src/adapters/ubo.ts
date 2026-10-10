// uBlock Origin adapter. Everything goes through uBO's own messaging: a port opened from a helper
// frame inside uBO's background document. The frame has uBO's origin, so uBO treats the port as one of its own
// privileged pages (dashboard, logger) — no visible tab, and uBO's in-memory state stays consistent.
import { ToolError, fail } from '../errors.js';
import { extCall, resolveExtension, type ExtRef } from '../browser/realms.js';
import { sleep } from '../browser/launcher.js';
import type { Browser } from '../browser/session.js';

export const UBO_ID = 'uBlock0@raymondhill.net';

export async function uboRef(b: Browser): Promise<ExtRef> {
  let ext: ExtRef;
  try { ext = await resolveExtension(b, UBO_ID); } catch { return fail('UBO_UNAVAILABLE', 'uBlock Origin is not installed in this profile'); }
  if (!ext.active) fail('UBO_UNAVAILABLE', 'uBlock Origin is disabled', 'addons_set_enabled ubo true (needs scope "addons").');
  return ext;
}

const PORT = `
  const w = await __cfFrame();
  let s = w.__cfUbo;
  if (!s) {
    s = w.__cfUbo = { pending: new Map(), seq: 1, port: null };
    s.connect = () => {
      s.port = w.browser.runtime.connect({ name: 'firefox-use-' + Math.random().toString(36).slice(2) });
      s.port.onMessage.addListener((m) => { const r = s.pending.get(m.msgId); if (r) { s.pending.delete(m.msgId); r.res(m.msg); } });
      s.port.onDisconnect.addListener(() => { s.port = null; for (const r of s.pending.values()) r.rej(new Error('uBO closed the port')); s.pending.clear(); });
    };
  }
  if (!s.port) s.connect();
  const send = (channel, msg, ms) => new Promise((res, rej) => {
    const id = s.seq++;
    const timer = setTimeout(() => { s.pending.delete(id); rej(new Error('uBO did not answer ' + channel + '/' + msg.what + ' within ' + ms + ' ms')); }, ms);
    s.pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    s.port.postMessage({ channel, msgId: id, msg });
  });`;

/** One request on a uBO messaging channel ("dashboard", "loggerUI", "default", ...). */
export async function uboSend<T = any>(b: Browser, channel: string, msg: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  const ext = await uboRef(b);
  try {
    return await extCall<T>(b, ext, `${PORT}\nreturn await send(${JSON.stringify(channel)}, ${JSON.stringify(msg)}, ${timeoutMs});`, timeoutMs + 5000);
  } catch (e: any) {
    if (e instanceof ToolError && e.code === 'EVAL_EXCEPTION') throw new ToolError('UBO_ERROR', e.message.replace(/ \(in extension:.*\)$/, ''), 'uBO internals may have changed in this version (check ubo_status).');
    throw e;
  }
}

/** Several requests in one round trip, in order. */
export async function uboBatch(b: Browser, reqs: { channel: string; msg: Record<string, unknown> }[], timeoutMs = 60000): Promise<any[]> {
  const ext = await uboRef(b);
  return extCall<any[]>(b, ext, `${PORT}\nconst out = [];\nfor (const r of ${JSON.stringify(reqs)}) out.push(await send(r.channel, r.msg, ${timeoutMs}));\nreturn out;`, timeoutMs + 5000);
}

// ------------------------------------------------------------ filters: lint with uBO's own parser
export interface LintResult { line: number; text: string; kind: string; error?: string; compiled?: string; exception?: boolean; procedural?: boolean }

/**
 * Parse filter lines with uBO's static filtering parser (the one behind the My filters editor), so syntax errors
 * read exactly as uBO reports them. Cosmetic filters also return their compiled selector (JSON for procedural ones).
 */
export async function uboLint(b: Browser, lines: string[]): Promise<LintResult[]> {
  const ext = await uboRef(b);
  return extCall<LintResult[]>(b, ext, `
    const sfp = await import('/js/static-filtering-parser.js');
    const p = new sfp.AstFilterParser({ interactive: true, nativeCssHas: true });
    const msgFor = () => {
      if (p.isUnsupported()) return 'Unsupported filter syntax';
      switch (p.astError) {
        case sfp.AST_ERROR_UNSUPPORTED: return 'Invalid filter: Unsupported filter syntax';
        case sfp.AST_ERROR_REGEX: return 'Invalid filter: Bad regular expression';
        case sfp.AST_ERROR_PATTERN: return 'Invalid filter: Bad pattern';
        case sfp.AST_ERROR_DOMAIN_NAME: return 'Invalid filter: Bad domain name';
        case sfp.AST_ERROR_OPTION_BADVALUE: return 'Invalid filter: Bad value assigned to a valid option';
        case sfp.AST_ERROR_OPTION_DUPLICATE: return 'Invalid filter: Duplicate filter option';
        case sfp.AST_ERROR_OPTION_UNKNOWN: return 'Invalid filter: Unsupported filter option';
        case sfp.AST_ERROR_IF_TOKEN_UNKNOWN: return 'Invalid filter: Unknown preparsing token';
        case sfp.AST_ERROR_UNTRUSTED_SOURCE: return 'Invalid filter: Filter requires trusted source';
        case sfp.AST_ERROR_CAPABILITY: return 'Filter unsupported on current platform';
        default: return 'Invalid filter' + (p.isCosmeticFilter() && p.result && p.result.error ? ': ' + p.result.error : '');
      }
    };
    return ${JSON.stringify(lines)}.map((text, i) => {
      p.parse(text);
      const kind = p.isComment() ? 'comment' : p.isScriptletFilter() ? 'scriptlet' : p.isHtmlFilter() ? 'html' : p.isCosmeticFilter() ? 'cosmetic' : p.isExtendedFilter() ? 'extended' : p.isNetworkFilter() ? 'network' : text.trim() === '' ? 'blank' : 'unknown';
      const out = { line: i + 1, text, kind };
      if (p.hasError() || p.isUnsupported()) out.error = msgFor();
      if (kind !== 'comment' && kind !== 'blank') out.exception = p.isException();
      if (kind === 'cosmetic' && !out.error && p.result) { out.compiled = p.result.compiled; out.procedural = typeof p.result.compiled === 'string' && p.result.compiled.startsWith('{'); }
      return out;
    });`);
}

// ------------------------------------------------------------ tab id mapping (uBO tab ids are WebExtension tab ids)
const TAB_IDS = `({ tabIds }) => {
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tt = ExtensionParent.apiManager.global.tabTracker;
  const out = {};
  for (const id of tabIds) { try { const t = tt.getTab(id, null); out[id] = t ? t.linkedBrowser.browserId : null; } catch { out[id] = null; } }
  return out;
}`;
const EXT_TAB_ID = `({ bid }) => {
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tt = ExtensionParent.apiManager.global.tabTracker;
  for (const w of Services.wm.getEnumerator("navigator:browser")) for (const t of w.gBrowser.tabs) if (t.linkedBrowser.browserId === bid) return tt.getId(t);
  return null;
}`;

/** Our tab handle -> WebExtension tab id (for uBO and tabs.* calls). */
export async function extTabId(b: Browser, tab?: number): Promise<number> {
  const ctx = await b.context(tab);
  await b.listTabs(true);
  const handle = Object.entries(b.state.tabs ?? {}).find(([, v]) => v === ctx)?.[0];
  const bid = handle ? b.state.tabBids?.[handle] : undefined;
  if (bid === undefined) fail('TAB_NOT_FOUND', 'cannot map this tab to a WebExtension tab id');
  const id = await b.callChrome<number | null>(EXT_TAB_ID, { bid });
  if (id === null) fail('TAB_NOT_FOUND', 'tab is gone');
  return id!;
}

// ------------------------------------------------------------ logger (uBO's loggerUI channel)
export interface UboEntry {
  seq: number;
  ts: number;
  realm: string;           // network | cosmetic | extended | message
  type: string;            // main_frame, image, dom, scriptlet, info, ...
  verdict: string;         // blocked | allowed | modified | hidden | injected | message | '' (no filter)
  filter?: string;
  source?: string;
  url?: string;
  docHostname?: string;
  tabId?: number;
  tab?: number;
  text?: string;
  count: number;
}

const MAX_ENTRIES = 3000;
const POLL_MS = 1000;
const IDLE_STOP_MS = 15 * 60 * 1000;

/**
 * uBO's logger only records while someone reads it (its buffer is drained by each read and switched off after 30 s
 * unread), and it has a single owner. This poller owns it while the adapter is in use, keeps a ring buffer here,
 * and releases it after 15 minutes without use.
 */
export class UboLogger {
  readonly entries: UboEntry[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastUse = 0;
  private polling = false;
  private readonly ownerId = `firefox-use-${process.pid}`;
  private tabIdCache = new Map<number, number | null>();
  private waiters = new Set<() => void>();
  startedAt = 0;
  conflict = false;
  lastError = '';

  constructor(private b: Browser) {}

  get running() { return this.timer !== null; }
  get cursor() { return this.seq; }

  /** Start (or keep) polling; resolves after the first read, so entries from now on are captured. */
  async touch(): Promise<void> {
    this.lastUse = Date.now();
    if (this.timer) return;
    this.startedAt = Date.now();
    await this.poll();
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
    this.timer.unref?.();
  }

  onChange(f: () => void): () => void { this.waiters.add(f); return () => this.waiters.delete(f); }

  /** Read everything uBO has buffered right now (also used before answering a query). */
  async poll(): Promise<void> {
    if (this.polling) { while (this.polling) await sleep(20); return; }
    if (this.b.dead) { this.stop(false); return; }
    if (Date.now() - this.lastUse > IDLE_STOP_MS) { await this.release(); return; }
    this.polling = true;
    try {
      const r = await uboSend<any>(this.b, 'loggerUI', { what: 'readAll', ownerId: this.ownerId, tabIdsToken: 0 }, 10000);
      if (r?.unavailable) { this.conflict = true; return; }
      this.conflict = false;
      this.lastError = '';
      const raw: string[] = r?.entries ?? [];
      if (raw.length) await this.ingest(raw);
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
    } finally { this.polling = false; }
  }

  private async ingest(raw: string[]) {
    const parsed: any[] = [];
    for (const s of raw) { if (!s) continue; try { parsed.push(JSON.parse(s)); } catch { /* skip */ } }
    const unknown = [...new Set(parsed.map((p) => p.tabId).filter((t) => typeof t === 'number' && t >= 0 && !this.tabIdCache.has(t)))];
    if (unknown.length) {
      try {
        const bids = await this.b.callChrome<Record<string, number | null>>(TAB_IDS, { tabIds: unknown });
        const byBid = new Map(Object.entries(this.b.state.tabBids ?? {}).map(([h, bid]) => [bid, Number(h)]));
        for (const t of unknown) { const bid = bids[t]; this.tabIdCache.set(t, bid == null ? null : byBid.get(bid) ?? null); }
      } catch { /* leave unmapped */ }
    }
    for (const p of parsed) {
      const e = normalize(p);
      e.tab = typeof p.tabId === 'number' ? this.tabIdCache.get(p.tabId) ?? undefined : undefined;
      const last = this.entries[this.entries.length - 1];
      if (last && last.realm === e.realm && last.verdict === e.verdict && last.filter === e.filter && last.url === e.url && last.text === e.text && last.tabId === e.tabId) { last.count++; last.ts = e.ts; continue; }
      e.seq = ++this.seq;
      this.entries.push(e);
    }
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    for (const f of [...this.waiters]) { try { f(); } catch { /* ignore */ } }
  }

  /** Give the logger back to uBO (and clear in-memory filters, like closing uBO's logger does). */
  async release(): Promise<void> {
    this.stop(false);
    try { await uboSend(this.b, 'loggerUI', { what: 'releaseView', ownerId: this.ownerId }, 5000); } catch { /* uBO gone */ }
  }

  stop(_release = true) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function normalize(p: any): UboEntry {
  const f = p.filter ?? {};
  let verdict = '';
  if (p.realm === 'message') verdict = 'message';
  else if (p.realm === 'cosmetic') verdict = String(f.raw ?? '').startsWith('#@#') ? 'allowed' : 'hidden';
  else if (p.realm === 'extended') verdict = String(f.raw ?? '').startsWith('#@#') ? 'allowed' : p.type === 'scriptlet' ? 'injected' : 'modified';
  else if (f.result === 1) verdict = f.modifier ? 'modified' : 'blocked';
  else if (f.result === 2) verdict = 'allowed';
  else if (f.result === 3) verdict = 'modified';
  return {
    seq: 0, ts: typeof p.tstamp === 'number' ? p.tstamp * 1000 : Date.now(), realm: String(p.realm ?? '?'), type: String(p.type ?? ''),
    verdict, filter: f.raw, source: f.source, url: p.url, docHostname: p.docHostname, tabId: p.tabId, text: p.text, count: 1,
  };
}

export function uboLogger(b: Browser): UboLogger {
  let l = b.adapters.get('uboLogger') as UboLogger | undefined;
  if (!l) {
    l = new UboLogger(b);
    b.adapters.set('uboLogger', l);
    b.closers.push(() => l!.stop());
  }
  return l;
}

export function renderUboEntry(e: UboEntry, detail = 'summary'): string {
  const t = new Date(e.ts);
  const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  const where = e.tab !== undefined ? `tab${e.tab}` : e.tabId !== undefined && e.tabId < 0 ? 'bg' : e.tabId !== undefined ? `ext-tab${e.tabId}` : '-';
  const body = e.realm === 'message'
    ? e.text ?? ''
    : `${e.verdict || 'no-match'} ${e.type}${e.filter ? ` ${e.filter}` : ''}${e.url ? `  ${detail === 'summary' && e.url.length > 140 ? e.url.slice(0, 140) + '…' : e.url}` : ''}`;
  return `${hh} u${e.seq} [${where}] ${e.realm} ${body}${e.count > 1 ? ` ×${e.count}` : ''}`;
}

// ------------------------------------------------------------ settings, filters, lists (shared by tools and snapshots)
export async function readFilters(b: Browser): Promise<{ content: string; enabled: boolean; trusted: boolean }> {
  const r = await uboSend<any>(b, 'dashboard', { what: 'readUserFilters' });
  return { content: String(r?.content ?? ''), enabled: r?.enabled !== false, trusted: !!r?.trusted };
}

/** Save My filters and apply them (writeUserFilters + the mandatory reloadAllFilters). */
export async function writeFilters(b: Browser, content: string, enabled: boolean, trusted: boolean): Promise<number> {
  const t0 = Date.now();
  await uboBatch(b, [
    { channel: 'dashboard', msg: { what: 'writeUserFilters', content, enabled, trusted } },
    { channel: 'default', msg: { what: 'reloadAllFilters' } },
  ]);
  return Date.now() - t0;
}

export async function readHidden(b: Browser): Promise<{ current: Record<string, unknown>; default: Record<string, unknown>; admin: Record<string, unknown> }> {
  const r = await uboSend<any>(b, 'dashboard', { what: 'readHiddenSettings' });
  return { current: r?.current ?? {}, default: r?.default ?? {}, admin: r?.admin ?? {} };
}

/** uBO replaces its whole hidden-settings object on write, so always send the full, merged set. */
export async function writeHidden(b: Browser, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const h = await readHidden(b);
  const before: Record<string, unknown> = {};
  const next = { ...h.current };
  for (const [k, v] of Object.entries(values)) {
    if (!(k in h.default)) fail('BAD_ARGS', `unknown uBO advanced setting "${k}"`, 'ubo_advanced_get lists them.');
    if (k in h.admin) fail('DENIED', `"${k}" is set by the administrator (managed storage) and can't be changed here`, 'managed_storage_set changes admin settings.');
    before[k] = h.current[k];
    next[k] = v === null ? h.default[k] : v;
  }
  const content = Object.entries(next).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' ') : v}`).join('\n');
  await uboSend(b, 'dashboard', { what: 'writeHiddenSettings', content });
  return before;
}

export async function selectedLists(b: Browser): Promise<{ selected: string[]; available: Record<string, any> }> {
  const r = await uboSend<any>(b, 'dashboard', { what: 'getLists' });
  const available = r?.available ?? {};
  return { selected: Object.entries(available).filter(([, v]: any) => !v.off).map(([k]) => k), available };
}

export async function setLists(b: Browser, selected: string[]): Promise<void> {
  await uboBatch(b, [
    { channel: 'default', msg: { what: 'applyFilterListSelection', toSelect: selected } },
    { channel: 'default', msg: { what: 'reloadAllFilters' } },
  ]);
}

// ------------------------------------------------------------ user data for warm snapshots (the "ubo" part)
/** uBO's user-authored state, read through its own messaging (side-effect free, unlike backupUserData). */
export interface UboUserData {
  version?: string;
  userSettings: Record<string, unknown>;
  /** changed from default only */
  hiddenSettings: Record<string, unknown>;
  selectedFilterLists: string[];
  whitelist: string[];
  permanentRules: string[];
  userFilters: string;
  userFiltersEnabled: boolean;
  userFiltersTrusted: boolean;
}

/** Settings that are derived, or restored through another path. */
const US_SKIP = ['importedLists', 'externalLists', 'userFiltersTrusted', 'noCosmeticFiltering', 'noLargeMedia', 'noRemoteFonts', 'noScripting', 'noCSPReports', 'canLeakLocalIPAddresses', 'cnameUncloakEnabled'];

export async function uboCapture(b: Browser): Promise<UboUserData> {
  const ext = await uboRef(b);
  const r = await extCall<any>(b, ext, `${PORT}
    const us = await send('default', { what: 'userSettings' }, 30000);
    const hs = await send('dashboard', { what: 'readHiddenSettings' }, 30000);
    const lists = await send('dashboard', { what: 'getLists' }, 30000);
    const wl = await send('default', { what: 'getWhitelist' }, 30000);
    const rules = await send('dashboard', { what: 'getRules' }, 30000);
    const uf = await send('dashboard', { what: 'readUserFilters' }, 30000);
    const hidden = {};
    for (const k of Object.keys(hs.current || {})) if (JSON.stringify(hs.current[k]) !== JSON.stringify((hs.default || {})[k])) hidden[k] = hs.current[k];
    return {
      version: w.browser.runtime.getManifest().version,
      userSettings: us, hiddenSettings: hidden,
      selectedFilterLists: Object.entries(lists.available || {}).filter(([, v]) => !v.off).map(([k]) => k),
      whitelist: wl.whitelist || [], permanentRules: rules.permanentRules || [],
      userFilters: uf.content || '', userFiltersEnabled: uf.enabled !== false, userFiltersTrusted: !!uf.trusted,
    };`, 60000);
  for (const k of US_SKIP) delete r.userSettings?.[k];
  return r as UboUserData;
}

const J = (v: unknown) => JSON.stringify(v);
const filterSet = (t: string) => new Set(t.split('\n').map((s) => s.trim()).filter(Boolean));

export function uboDiff(a: UboUserData, c: UboUserData): string[] {
  const out: string[] = [];
  if (a.userFilters !== c.userFilters) {
    const x = filterSet(a.userFilters), y = filterSet(c.userFilters);
    const add = [...y].filter((s) => !x.has(s)), rem = [...x].filter((s) => !y.has(s));
    out.push(`uBO My filters: ${add.length} added, ${rem.length} removed${add.length + rem.length <= 6 ? ` (${[...add.map((s) => '+' + s), ...rem.map((s) => '-' + s)].join(', ')})` : ''}`);
  }
  if (a.userFiltersEnabled !== c.userFiltersEnabled) out.push(`uBO My filters enabled: ${a.userFiltersEnabled} -> ${c.userFiltersEnabled}`);
  if (a.userFiltersTrusted !== c.userFiltersTrusted) out.push(`uBO My filters trusted: ${a.userFiltersTrusted} -> ${c.userFiltersTrusted}`);
  for (const k of new Set([...Object.keys(a.hiddenSettings), ...Object.keys(c.hiddenSettings)])) {
    if (J(a.hiddenSettings[k]) !== J(c.hiddenSettings[k])) out.push(`uBO advanced ${k}: ${J(a.hiddenSettings[k]) ?? '(default)'} -> ${J(c.hiddenSettings[k]) ?? '(default)'}`);
  }
  for (const k of new Set([...Object.keys(a.userSettings), ...Object.keys(c.userSettings)])) {
    if (J(a.userSettings[k]) !== J(c.userSettings[k])) out.push(`uBO setting ${k}: ${J(a.userSettings[k])} -> ${J(c.userSettings[k])}`);
  }
  const setDiff = (name: string, x: string[], y: string[]) => {
    const add = y.filter((s) => !x.includes(s)), rem = x.filter((s) => !y.includes(s));
    if (add.length || rem.length) out.push(`uBO ${name}: ${[...add.map((s) => '+' + s), ...rem.map((s) => '-' + s)].join(', ').slice(0, 300)}`);
  };
  setDiff('lists', a.selectedFilterLists, c.selectedFilterLists);
  setDiff('trusted sites', a.whitelist, c.whitelist);
  setDiff('rules', a.permanentRules, c.permanentRules);
  return out;
}

/** Bring uBO back to a captured state with targeted writes (not restoreUserData: that wipes uBO and re-downloads every list). */
export async function uboRestoreData(b: Browser, snap: UboUserData): Promise<string[]> {
  const cur = await uboCapture(b);
  const lines: string[] = [];
  if (cur.userFilters !== snap.userFilters || cur.userFiltersEnabled !== snap.userFiltersEnabled || cur.userFiltersTrusted !== snap.userFiltersTrusted) {
    await writeFilters(b, snap.userFilters, snap.userFiltersEnabled, snap.userFiltersTrusted);
    lines.push('uBO My filters restored');
  }
  const hs: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(snap.hiddenSettings), ...Object.keys(cur.hiddenSettings)])) {
    if (J(snap.hiddenSettings[k]) !== J(cur.hiddenSettings[k])) hs[k] = k in snap.hiddenSettings ? snap.hiddenSettings[k] : null;
  }
  if (Object.keys(hs).length) { await writeHidden(b, hs); lines.push(`uBO advanced settings: ${Object.keys(hs).join(', ')}`); }
  const us = Object.keys(snap.userSettings).filter((k) => J(snap.userSettings[k]) !== J(cur.userSettings[k]));
  if (us.length) {
    await uboBatch(b, us.map((name) => ({ channel: 'default', msg: { what: 'userSettings', name, value: snap.userSettings[name] } })));
    lines.push(`uBO settings: ${us.join(', ')}`);
  }
  if (J([...snap.selectedFilterLists].sort()) !== J([...cur.selectedFilterLists].sort())) { await setLists(b, snap.selectedFilterLists); lines.push('uBO filter list selection restored'); }
  if (J([...snap.whitelist].sort()) !== J([...cur.whitelist].sort())) { await uboSend(b, 'default', { what: 'setWhitelist', whitelist: snap.whitelist.join('\n') }); lines.push('uBO trusted sites restored'); }
  const toAdd = snap.permanentRules.filter((r) => !cur.permanentRules.includes(r)), toRemove = cur.permanentRules.filter((r) => !snap.permanentRules.includes(r));
  if (toAdd.length || toRemove.length) { await uboSend(b, 'dashboard', { what: 'modifyRuleset', permanent: true, toAdd: toAdd.join('\n'), toRemove: toRemove.join('\n') }); lines.push(`uBO rules: +${toAdd.length} -${toRemove.length}`); }
  return lines;
}
