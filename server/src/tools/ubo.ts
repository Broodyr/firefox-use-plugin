// uBlock Origin adapter tools (+ wait_for_ubo_event).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail } from '../errors.js';
import { stateDir } from '../audit/audit.js';
import { extCall, contentTarget } from '../browser/realms.js';
import { sleep } from '../browser/launcher.js';
import type { Browser } from '../browser/session.js';
import {
  UBO_ID, extTabId, readFilters, readHidden, renderUboEntry, selectedLists, setLists, uboBatch, uboLint, uboLogger, uboRef, uboSend,
  writeFilters, writeHidden, type LintResult, type UboEntry,
} from '../adapters/ubo.js';
import { registerUndo } from '../snapshots/undo.js';
import { resourceServer } from '../resources/server.js';
import { auditValue } from './privileged.js';
import { pageTools } from './page.js';
import { matcher } from './console.js';
import { tool, tabArg, type Ctx, type ToolOutput } from './registry.js';

const SCOPE = `ext:${UBO_ID}`;

// ------------------------------------------------------------ helpers
const splitLines = (t: string) => t.split(/\r?\n/);

/** Does userResourcesLocation point at a resource server running in this session? */
function resNote(b: Browser, loc: string): string {
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/resources\/bundle\.js/.exec(loc);
  if (!m) return '';
  const srv = [...b.adapters.entries()].find(([k, v]) => k.startsWith('resources:') && (v as { port?: number }).port === Number(m[1]));
  return srv ? ' (served by this session\'s resource server)' : ' (a resource server not running in this session; ubo_set_resources repoints it)';
}

function lintReport(results: LintResult[]): string[] {
  return results.filter((r) => r.error).map((r) => `line ${r.line}: ${r.error!.replace(/\n\n/g, '\n').replace(/\n/g, '\n    ')} — ${r.text}`);
}

function diffLines(before: string, after: string): string {
  const a = new Set(splitLines(before).map((s) => s.trim()).filter(Boolean));
  const b = new Set(splitLines(after).map((s) => s.trim()).filter(Boolean));
  const added = [...b].filter((x) => !a.has(x)), removed = [...a].filter((x) => !b.has(x));
  return [...added.map((x) => `+ ${x}`), ...removed.map((x) => `- ${x}`)].join('\n') || '(no line changes)';
}

/** Does a cosmetic/scriptlet filter's hostname list cover this hostname? (uBO-style suffix match, ~negation, entity.*) */
function filterCoversHost(filter: string, host: string): boolean | null {
  const m = /^([^#]*?)#[@?$%]*#/.exec(filter);
  if (!m) return null;
  if (!m[1].trim()) return true;
  const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const match = (p: string) => {
    if (p.endsWith('.*')) { const ent = p.slice(0, -2); return host === ent || host.startsWith(ent + '.') || host.includes('.' + ent + '.'); }
    return host === p || host.endsWith('.' + p);
  };
  if (parts.some((p) => p.startsWith('~') && match(p.slice(1)))) return false;
  const pos = parts.filter((p) => !p.startsWith('~'));
  return pos.length === 0 || pos.some(match);
}

async function pageHost(b: Browser, tab?: number): Promise<{ url: string; host: string }> {
  const url = await b.callPage(await b.context(tab), '() => location.href');
  let host = '';
  try { host = new URL(url).hostname; } catch { /* about: etc */ }
  return { url, host };
}

function sinceSeq(since: string | undefined, entries: UboEntry[], floor: number): (e: UboEntry) => boolean {
  if (!since) return (e) => e.seq > floor;
  const m = /^u?(\d+)$/.exec(since);
  if (m) { const n = Number(m[1]); return (e) => e.seq > n; }
  const rel = /^(\d+)(s|m|h)$/.exec(since);
  const t = rel ? Date.now() - Number(rel[1]) * { s: 1000, m: 60000, h: 3600000 }[rel[2] as 's' | 'm' | 'h'] : Date.parse(since);
  if (Number.isNaN(t)) fail('BAD_ARGS', `bad since "${since}"`, 'Use a cursor ("u123"), a duration ("30s", "5m") or an ISO time.');
  return (e) => e.ts >= t;
}

function entryMatch(e: UboEntry, q: { pattern?: string; realm?: string; verdict?: string; tab?: number }): boolean {
  if (q.realm && e.realm !== q.realm) return false;
  if (q.verdict && e.verdict !== q.verdict) return false;
  if (q.tab !== undefined && e.tab !== q.tab) return false;
  if (q.pattern) { const m = matcher(q.pattern); if (!m(`${e.filter ?? ''} ${e.url ?? ''} ${e.text ?? ''} ${e.type}`)) return false; }
  return true;
}

/** Add an in-memory filter (never saved), reload the tab, collect what uBO logged for it, remove the filter again. */
async function inMemoryTest(b: Browser, filter: string, tab: number | undefined, settleMs: number): Promise<{ entries: UboEntry[]; console: string[]; reloadMs: number }> {
  const log = uboLogger(b);
  await log.touch();
  const ctx = await b.context(tab);
  const had = await uboSend<boolean>(b, 'loggerUI', { what: 'hasInMemoryFilter', filter });
  if (!had) await uboSend(b, 'loggerUI', { what: 'toggleInMemoryFilter', filter });
  const d = await b.dt();
  const c0 = d.cursor;
  await log.poll();
  const s0 = log.cursor;
  const t0 = Date.now();
  try {
    await b.bidi.send('browsingContext.reload', { context: ctx, wait: 'complete' }, 60000);
    await sleep(settleMs);
    await log.poll();
  } finally {
    if (!had) await uboSend(b, 'loggerUI', { what: 'toggleInMemoryFilter', filter }).catch(() => {});
  }
  const handle = Object.entries(b.state.tabs ?? {}).find(([, v]) => v === ctx)?.[0];
  const entries = log.entries.filter((e) => e.seq > s0 && (handle === undefined || e.tab === undefined || e.tab === Number(handle)));
  const consoleLines = d.log.filter((e) => e.seq > c0 && (e.level === 'error' || e.level === 'warn' || /scriptlet|\+js/.test(e.text))).slice(-20).map((e) => `${e.level} [${d.realmLabel(e)}] ${e.text.slice(0, 300)}`);
  return { entries, console: consoleLines, reloadMs: Date.now() - t0 };
}

// ------------------------------------------------------------ undo handlers
registerUndo('ubo_filters', async (b, c) => {
  const cur = await readFilters(b);
  await writeFilters(b, String(c.before ?? ''), cur.enabled, cur.trusted);
  return { line: 'uBO My filters -> previous content (reloaded)', change: { kind: 'ubo_filters', before: auditValue(cur.content), after: auditValue(c.before) } };
});
registerUndo('ubo_trust', async (b, c) => {
  const cur = await readFilters(b);
  await writeFilters(b, cur.content, cur.enabled, !!c.before);
  return { line: `uBO My filters trusted -> ${!!c.before}`, change: { kind: 'ubo_trust', before: cur.trusted, after: !!c.before } };
});
registerUndo('ubo_advanced', async (b, c) => {
  const before = await writeHidden(b, { [c.path!]: c.before ?? null });
  return { line: `uBO advanced ${c.path} -> ${JSON.stringify(c.before)}`, change: { kind: 'ubo_advanced', path: c.path, before: before[c.path!], after: c.before } };
});
registerUndo('ubo_lists', async (b, c) => {
  const cur = await selectedLists(b);
  await setLists(b, c.before as string[]);
  return { line: `uBO filter lists -> ${(c.before as string[]).length} selected`, change: { kind: 'ubo_lists', before: cur.selected, after: c.before } };
});

// ------------------------------------------------------------ tools
export const uboTools = [
  tool({
    name: 'ubo_status',
    description: 'uBlock Origin overview: version, advanced-user mode, userResourcesLocation, selected lists, My filters (enabled, trusted, line count), trusted-source settings, built-in tokens that need trust, logger state.',
    args: {},
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await uboRef(b);
      const [us, hs, uf, lists, tokens] = await uboBatch(b, [
        { channel: 'default', msg: { what: 'userSettings' } },
        { channel: 'dashboard', msg: { what: 'readHiddenSettings' } },
        { channel: 'dashboard', msg: { what: 'readUserFilters' } },
        { channel: 'dashboard', msg: { what: 'getLists' } },
        { channel: 'default', msg: { what: 'getTrustedTokens' } },
      ]);
      const ver = b.versions?.addons?.find((x: any) => x.id === UBO_ID)?.version ?? (await b.versionsInfo()).addons.find((x: any) => x.id === UBO_ID)?.version;
      const avail = lists?.available ?? {};
      const sel = Object.entries(avail).filter(([, v]: any) => !v.off).map(([k]) => k);
      const filterLines = splitLines(String(uf?.content ?? '')).filter((l) => l.trim() && !l.trim().startsWith('!')).length;
      const log = b.adapters.get('uboLogger') as ReturnType<typeof uboLogger> | undefined;
      const changedHidden = Object.keys(hs?.current ?? {}).filter((k) => JSON.stringify(hs.current[k]) !== JSON.stringify(hs.default?.[k]));
      const lines = [
        `${ext.name} ${ver ?? '?'} · advanced user: ${us?.advancedUserEnabled ? 'yes' : 'no'}`,
        `userResourcesLocation: ${hs?.current?.userResourcesLocation ?? '?'}${resNote(b, String(hs?.current?.userResourcesLocation ?? ''))}`,
        `My filters: ${uf?.enabled === false ? 'DISABLED' : 'enabled'} · ${uf?.trusted ? 'trusted (trusted-* scriptlets allowed)' : 'not trusted'} · ${filterLines} filter line(s)`,
        `lists: ${sel.length} selected of ${Object.keys(avail).length} (${sel.join(', ')})`,
        `trustedListPrefixes: ${hs?.current?.trustedListPrefixes ?? '?'}`,
        `built-in tokens needing trust: ${Array.isArray(tokens) ? tokens.filter((t: string) => !t.endsWith('.js')).length : '?'} (user scriptlets from userResourcesLocation need none)`,
        `advanced settings changed from default: ${changedHidden.length ? changedHidden.join(', ') : 'none'}`,
        `logger: ${log?.running ? `owned by this session since ${new Date(log.startedAt).toLocaleTimeString()} (${log.entries.length} entries, cursor u${log.cursor})${log.conflict ? ' — uBO logger is open elsewhere (single owner)' : ''}` : 'not running (ubo_logger / wait_for_ubo_event / verify start it)'}`,
      ];
      if (a.detail !== 'summary') lines.push(`trusted tokens: ${(tokens ?? []).filter((t: string) => !t.endsWith('.js')).join(', ')}`);
      return lines.join('\n');
    },
  }),
  tool({
    name: 'ubo_advanced_get',
    description: 'uBO advanced settings (hidden settings): current value, default, and whether set by the administrator. Without names: only the ones changed from default.',
    args: { names: z.array(z.string()).optional(), all: z.boolean().default(false).describe('List every setting') },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const h = await readHidden(b);
      const keys = a.names?.length ? a.names : Object.keys(h.default).filter((k) => a.all || JSON.stringify(h.current[k]) !== JSON.stringify(h.default[k]));
      if (!keys.length) return 'all advanced settings are at their defaults (all: true lists them)';
      return keys.map((k) => k in h.default
        ? `${k} = ${JSON.stringify(h.current[k])}${JSON.stringify(h.current[k]) !== JSON.stringify(h.default[k]) ? ` (default ${JSON.stringify(h.default[k])})` : ''}${k in h.admin ? ' [admin]' : ''}`
        : `${k}: unknown setting`).join('\n');
    },
  }),
  tool({
    name: 'ubo_advanced_set',
    description: 'Change uBO advanced settings ({name: value}; null = default) through uBO\'s dashboard messaging (applies live). Audited with before-values (undo-able). Needs scope "ext:ubo".',
    args: { values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      await uboRef(b);
      if (!Object.keys(a.values).length) fail('BAD_ARGS', 'no settings given');
      await ctx.requireScope(SCOPE, b);
      const before = await writeHidden(b, a.values);
      const after = (await readHidden(b)).current;
      return {
        text: Object.keys(a.values).map((k) => `${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`).join('\n'),
        changes: Object.keys(a.values).map((k) => ({ kind: 'ubo_advanced', path: k, before: before[k], after: after[k] })),
      };
    },
  }),
  tool({
    name: 'ubo_filters_get',
    description: 'uBO "My filters": the text, whether enabled and trusted. lint:true also checks every line with uBO\'s own parser.',
    args: { lint: z.boolean().default(false) },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const f = await readFilters(b);
      const head = `My filters: ${f.enabled ? 'enabled' : 'DISABLED'}, ${f.trusted ? 'trusted' : 'not trusted'}, ${splitLines(f.content).filter((l) => l.trim()).length} line(s)`;
      let tail = '';
      if (a.lint && f.content.trim()) {
        const bad = lintReport(await uboLint(b, splitLines(f.content)));
        tail = `\nlint: ${bad.length ? `\n${bad.join('\n')}` : 'no errors'}`;
      }
      return `${head}\n---\n${f.content || '(empty)'}${tail}`;
    },
  }),
  tool({
    name: 'ubo_filters_set',
    description: 'Replace uBO "My filters" with text, then apply it (reloadAllFilters). Every line is checked with uBO\'s parser first; lines with errors are refused unless force:true. Diffed and audited (undo-able). Needs scope "ext:ubo".',
    args: { text: z.string(), force: z.boolean().default(false) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      return saveFilters(b, ctx, () => a.text, a.force);
    },
  }),
  tool({
    name: 'ubo_filters_add',
    description: 'Append lines to uBO "My filters" (lines already present are skipped), then apply. Lines are checked with uBO\'s parser first (force:true saves anyway). Audited (undo-able). Needs scope "ext:ubo".',
    args: { lines: z.array(z.string().min(1)).min(1), force: z.boolean().default(false) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      return saveFilters(b, ctx, (cur) => {
        const have = new Set(splitLines(cur).map((s) => s.trim()));
        const add = a.lines.map((s) => s.trim()).filter((s) => !have.has(s));
        return add.length ? `${cur.replace(/\s+$/, '')}${cur.trim() ? '\n' : ''}${add.join('\n')}` : cur;
      }, a.force, a.lines);
    },
  }),
  tool({
    name: 'ubo_filters_remove',
    description: 'Remove exact lines from uBO "My filters", then apply. Audited (undo-able). Needs scope "ext:ubo".',
    args: { lines: z.array(z.string().min(1)).min(1) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const drop = new Set(a.lines.map((s) => s.trim()));
      return saveFilters(b, ctx, (cur) => splitLines(cur).filter((l) => !drop.has(l.trim())).join('\n'), true);
    },
  }),
  tool({
    name: 'ubo_trust_my_filters',
    description: 'Turn uBO\'s "Allow custom filters requiring trust" (My filters trusted, for trusted-* scriptlets) on or off. Needs scope "ubo_trust" (ask for it explicitly; it lets My filters run trusted scriptlets).',
    args: { on: z.boolean() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      await ctx.requireScope('ubo_trust', b);
      const f = await readFilters(b);
      if (f.trusted === a.on) return `My filters already ${a.on ? 'trusted' : 'untrusted'}`;
      await writeFilters(b, f.content, f.enabled, a.on);
      return { text: `My filters: ${f.trusted ? 'trusted' : 'not trusted'} -> ${a.on ? 'trusted' : 'not trusted'} (filters reloaded)`, changes: [{ kind: 'ubo_trust', before: f.trusted, after: a.on }] };
    },
  }),
  tool({
    name: 'ubo_lists',
    description: 'uBO filter lists: without arguments, the selected and available lists (keys); enable / disable list keys to change the selection, then reload filters (used by bisecting). Only lists uBO already knows; new third-party list URLs are not added here. Audited (undo-able). Needs scope "ext:ubo" for changes.',
    args: { enable: z.array(z.string()).optional(), disable: z.array(z.string()).optional() },
    write: true,
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const { selected, available } = await selectedLists(b);
      if (!a.enable?.length && !a.disable?.length) {
        const fmt = (k: string) => `${k}${available[k]?.title ? ` (${available[k].title})` : ''}`;
        const rest = Object.keys(available).filter((k) => !selected.includes(k));
        return `selected (${selected.length}): ${selected.map(fmt).join(', ')}${a.detail !== 'summary' ? `\navailable (${rest.length}): ${rest.map(fmt).join(', ')}` : `\n${rest.length} more available (detail: normal lists them)`}`;
      }
      for (const k of [...(a.enable ?? []), ...(a.disable ?? [])]) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(k)) fail('DENIED', 'adding new third-party list URLs needs the user\'s OK; add it in uBO\'s dashboard, or ask the user', 'Use list keys from ubo_lists.');
        if (!(k in available)) fail('BAD_ARGS', `unknown list key "${k}"`, 'ubo_lists (no arguments) shows the keys.');
      }
      await ctx.requireScope(SCOPE, b);
      const next = [...new Set([...selected.filter((k) => !(a.disable ?? []).includes(k)), ...(a.enable ?? [])])];
      await setLists(b, next);
      const now = (await selectedLists(b)).selected;
      return { text: `lists: ${selected.length} -> ${now.length} selected${a.enable?.length ? `\n+ ${a.enable.join(', ')}` : ''}${a.disable?.length ? `\n- ${a.disable.join(', ')}` : ''}\nfilters reloaded`, changes: [{ kind: 'ubo_lists', before: selected, after: now }] };
    },
  }),
  tool({
    name: 'ubo_logger',
    description: 'uBO logger entries (structured): network requests with verdict (blocked / allowed / modified) and the filter + list that decided, cosmetic hides, scriptlet injections, uBO messages. The first call starts capturing (uBO only logs while read); later calls return new entries. Filter by tab, realm, verdict, pattern; since = cursor ("u123") or duration.',
    args: {
      tab: tabArg,
      since: z.string().optional(),
      pattern: z.string().optional().describe('Substring or /regex/ over filter, URL and message'),
      realm: z.enum(['network', 'cosmetic', 'extended', 'message']).optional(),
      verdict: z.enum(['blocked', 'allowed', 'modified', 'hidden', 'injected', 'message', '']).optional().describe('"" = requests no filter matched'),
      limit: z.number().int().positive().max(1000).default(60),
    },
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const log = uboLogger(b);
      const fresh = !log.running;
      await log.touch();
      await log.poll();
      const since = sinceSeq(a.since, log.entries, 0);
      const hits = log.entries.filter((e) => since(e) && entryMatch(e, { pattern: a.pattern, realm: a.realm, verdict: a.verdict, tab: a.tab }));
      const shown = hits.slice(-a.limit);
      const head = fresh ? `logger started (uBO records from now on; reload the page to see its requests) · cursor: u${log.cursor}` : `${hits.length} entr${hits.length === 1 ? 'y' : 'ies'}${hits.length > shown.length ? `, last ${shown.length}` : ''} · cursor: u${log.cursor}${log.conflict ? '\nWARNING: uBO\'s logger is open in another view (single owner); close it to resume capture' : ''}`;
      return [head, ...shown.map((e) => renderUboEntry(e, a.detail))].join('\n');
    },
  }),
  tool({
    name: 'wait_for_ubo_event',
    description: 'Wait for a matching uBO logger entry, e.g. a scriptlet injection or a block. pattern matches filter, URL and message (substring or /regex/). Only entries after the call (or after since) count.',
    args: {
      pattern: z.string().min(1),
      realm: z.enum(['network', 'cosmetic', 'extended', 'message']).optional(),
      verdict: z.enum(['blocked', 'allowed', 'modified', 'hidden', 'injected', 'message']).optional(),
      tab: tabArg,
      since: z.string().optional(),
      timeout_ms: z.number().int().positive().max(120000).default(10000),
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const log = uboLogger(b);
      await log.touch();
      const floor = a.since ? undefined : log.cursor;
      const since = sinceSeq(a.since, log.entries, floor ?? 0);
      const t0 = Date.now();
      const find = () => log.entries.find((e) => since(e) && entryMatch(e, { pattern: a.pattern, realm: a.realm, verdict: a.verdict, tab: a.tab }));
      for (;;) {
        const hit = find();
        if (hit) return `${renderUboEntry(hit, 'normal')}\nafter ${Date.now() - t0} ms · cursor: u${log.cursor}`;
        if (Date.now() - t0 > a.timeout_ms) {
          const recent = log.entries.filter(since).slice(-8).map((e) => renderUboEntry(e));
          fail('TIMEOUT', `no uBO logger entry matching ${JSON.stringify(a.pattern)} within ${a.timeout_ms} ms`, 'Did the page (re)load after the filter changed? ubo_logger shows everything captured.', { recentUboEntries: recent.length ? recent : 'none' });
        }
        await new Promise<void>((r) => { const off = log.onChange(() => { off(); r(); }); setTimeout(() => { off(); r(); }, 250); });
        await log.poll();
      }
    },
  }),
  tool({
    name: 'ubo_test_filter',
    description: 'Test a uBO filter WITHOUT saving it. Cosmetic / procedural filters (##, #?#, :has-text, :upward, :matches-css, …) are compiled with uBO\'s parser and run against the live page: match count, HTML snippets, optional highlighted screenshot. Network / scriptlet / HTML filters (or mode:"reload") are added as an in-memory filter, the tab reloads, and uBO\'s logger entries for it are returned. Syntax errors read exactly as uBO reports them.',
    args: {
      filter: z.string().min(1),
      tab: tabArg,
      mode: z.enum(['auto', 'query', 'reload']).default('auto'),
      highlight: z.boolean().default(false).describe('query mode: outline the matches and return a screenshot'),
      settle_ms: z.number().int().min(0).max(10000).default(800),
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const [lint] = await uboLint(b, [a.filter.trim()]);
      if (lint.error) return `INVALID (${lint.kind}): ${lint.error}\nfilter: ${a.filter}`;
      if (lint.kind === 'comment' || lint.kind === 'blank') return `not a filter (${lint.kind})`;
      const { url, host } = await pageHost(b, a.tab);
      const covers = filterCoversHost(a.filter.trim(), host);
      const scopeNote = covers === false ? `\nNOTE: the filter's hostnames don't cover ${host || url}; uBO would not apply it on this page` : '';
      const mode = a.mode === 'auto' ? (lint.kind === 'cosmetic' && !lint.exception ? 'query' : 'reload') : a.mode;
      if (mode === 'query') {
        if (lint.kind !== 'cosmetic') fail('BAD_ARGS', `query mode tests cosmetic filters; this is a ${lint.kind} filter`, 'Use mode "reload" (in-memory filter + reload).');
        const r = await queryCosmetic(b, a.tab, lint, a.highlight);
        const out: ToolOutput = {
          text: `${lint.kind}${lint.procedural ? ' (procedural)' : ''} filter: ${r.count} match(es) on ${url}${scopeNote}${r.note ? `\n${r.note}` : ''}${r.items.length ? '\n' + r.items.map((x, i) => `${i + 1}. ${x.html}${x.rect ? `  @${x.rect}` : ''}`).join('\n') : ''}`,
        };
        if (a.highlight && r.count) {
          const shot = await pageTools.find((t) => t.name === 'screenshot')!.handler({ tab: a.tab, full_page: false }, ctx) as ToolOutput;
          await unhighlight(b, a.tab, lint).catch(() => {});
          out.images = shot.images;
          out.text += `\n${shot.text}`;
        }
        return out;
      }
      const r = await inMemoryTest(b, a.filter.trim(), a.tab, a.settle_ms);
      const mine = r.entries.filter((e) => e.filter && (a.filter.includes(e.filter) || e.filter.includes(a.filter.replace(/^[^#]*/, '')) || e.filter === a.filter.trim()));
      return [
        `${lint.kind}${lint.exception ? ' exception' : ''} filter, in-memory (not saved), tab reloaded in ${r.reloadMs} ms${scopeNote}`,
        mine.length ? `uBO applied it ${mine.reduce((n, e) => n + e.count, 0)} time(s):` : 'uBO logged no use of this filter during the load',
        ...mine.slice(-20).map((e) => renderUboEntry(e, 'normal')),
        ...(r.console.length ? ['console during the load:', ...r.console] : []),
      ].join('\n');
    },
  }),
  tool({
    name: 'ubo_test_scriptlet',
    description: 'Try a scriptlet on the current page without saving a filter: adds <hostname>##+js(name, args…) as an in-memory filter, reloads the tab, reports uBO\'s injection log entries and console output (errors included), then removes the filter. Works for built-in scriptlets and for user scriptlets from userResourcesLocation.',
    args: { name: z.string().min(1).describe('e.g. "set-constant" or "user-z.js"'), args: z.array(z.string()).default([]), tab: tabArg, settle_ms: z.number().int().min(0).max(10000).default(800) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const { host, url } = await pageHost(b, a.tab);
      if (!host) fail('BAD_ARGS', `the tab has no hostname (${url}); navigate to a page first`);
      const filter = `${host}##+js(${[a.name, ...a.args].join(', ')})`;
      const [lint] = await uboLint(b, [filter]);
      if (lint.error) return `INVALID: ${lint.error}\nfilter: ${filter}`;
      const r = await inMemoryTest(b, filter, a.tab, a.settle_ms);
      const short = a.name.replace(/\.js$/, '');
      const inj = r.entries.filter((e) => e.type === 'scriptlet' && e.filter?.includes(short));
      const msgs = r.entries.filter((e) => e.realm === 'message' && e.text?.includes(short));
      return [
        `${filter} (in-memory, not saved), tab reloaded in ${r.reloadMs} ms`,
        inj.length ? `injected ${inj.reduce((n, e) => n + e.count, 0)} time(s)` : 'NOT injected: uBO logged no injection (unknown scriptlet name? not loaded from userResourcesLocation? a trusted-* token on an untrusted source?)',
        ...msgs.slice(-10).map((e) => renderUboEntry(e, 'normal')),
        ...(r.console.length ? ['console during the load:', ...r.console] : []),
      ].join('\n');
    },
  }),
  tool({
    name: 'ubo_set_resources',
    description: 'Point uBO\'s userResourcesLocation at the local resource server, which serves the workspace\'s resources/*.js as one uBO resource bundle (`/// name.js` per file; blank lines made safe for uBO\'s parser). Waits until uBO has fetched that exact version, then reloads filters, so `##+js(<file name>)` filters work. Extra local URLs may be kept alongside. Audited (undo-able). Needs scope "ext:ubo".',
    args: { urls: z.array(z.string()).optional().describe('Additional resource URLs to keep (127.0.0.1 / localhost only)') },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      await uboRef(b);
      for (const u of a.urls ?? []) if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)) fail('DENIED', `${u}: only local resource URLs (127.0.0.1 / localhost); remote resource sources need the user's OK`);
      await ctx.requireScope(SCOPE, b);
      const before = (await readHidden(b)).current.userResourcesLocation;
      const srv = await resourceServer(b);
      fs.mkdirSync(srv.resourcesDir, { recursive: true });
      const lines = await applyResources(b, a.urls ?? [], false);
      const after = (await readHidden(b)).current.userResourcesLocation;
      return { text: [`resource server: ${srv.origin} (serving ${srv.resourcesDir})`, ...lines].join('\n'), changes: before === after ? [] : [{ kind: 'ubo_advanced', path: 'userResourcesLocation', before, after }] };
    },
  }),
  tool({
    name: 'ubo_reload_resources',
    description: 'After editing resources/*.js: bump the bundle version on userResourcesLocation so uBO refetches it, confirm uBO loaded exactly the new content (resource server log, by content hash), and reload filters. Reload the page afterwards to see the new scriptlet run. Needs scope "ext:ubo".',
    args: { force: z.boolean().default(false).describe('Refetch even if the content is unchanged') },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      await uboRef(b);
      const cur = String((await readHidden(b)).current.userResourcesLocation ?? 'unset');
      if (!cur.split(/\s+/).some((u) => OUR_BUNDLE.test(u))) fail('NOT_CONFIGURED', `userResourcesLocation (${cur}) does not point at the resource server`, 'Call ubo_set_resources first.');
      await ctx.requireScope(SCOPE, b);
      const lines = await applyResources(b, [], a.force);
      const after = (await readHidden(b)).current.userResourcesLocation;
      return { text: lines.join('\n'), changes: cur === after ? [] : [{ kind: 'ubo_advanced', path: 'userResourcesLocation', before: cur, after }] };
    },
  }),
  tool({
    name: 'ubo_backup',
    description: 'uBO\'s own backup (the dashboard\'s "Back up to file" format: settings, advanced settings, lists, My filters, trusted sites, rules), saved under .firefox-use/artifacts/.',
    args: {},
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const r = await uboSend<any>(b, 'dashboard', { what: 'backupUserData' });
      if (!r?.userData) fail('UBO_ERROR', 'uBO returned no backup data');
      const file = path.join(stateDir('artifacts'), `ubo-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(r.userData, null, 1));
      const u = r.userData;
      return `${file}\nuBO ${u.version} · ${(u.selectedFilterLists ?? []).length} lists · My filters ${String(u.userFilters ?? '').split('\n').filter((l: string) => l.trim()).length} line(s) · ${Object.keys(u.hiddenSettings ?? {}).length} advanced setting(s) changed`;
    },
  }),
  tool({
    name: 'ubo_restore',
    description: 'Restore a uBO backup file (from ubo_backup or uBO\'s dashboard) with uBO\'s own restoreUserData. uBO wipes its storage, re-downloads its filter lists and restarts, like the dashboard\'s "Restore from file". For partial rollbacks prefer restore(id, ["ubo"]) or undo. Needs scope "ext:ubo".',
    args: { path: z.string().min(1) },
    write: true,
    async handler(a, ctx) {
      const file = path.resolve(a.path);
      if (!fs.existsSync(file)) fail('FILE_NOT_FOUND', file);
      let userData: any;
      try { userData = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { fail('BAD_ARGS', `not a uBO backup (JSON): ${e.message}`); }
      if (userData?.userData) userData = userData.userData;
      if (!userData?.timeStamp || !('userSettings' in userData)) fail('BAD_ARGS', 'not a uBO backup (no timeStamp / userSettings)');
      const b = await ctx.browser();
      await ctx.requireScope(SCOPE, b);
      const before = await uboSend<any>(b, 'dashboard', { what: 'backupUserData' });
      await uboSend(b, 'dashboard', { what: 'restoreUserData', userData, file: path.basename(file) }).catch(() => { /* uBO restarts and drops the port */ });
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        try { await uboSend(b, 'dashboard', { what: 'dashboardConfig' }, 3000); break; } catch { /* restarting */ }
      }
      await b.devtools?.updateExtensions();
      return { text: `restored ${file} with uBO's restoreUserData; uBO restarted and re-downloads its lists`, changes: [{ kind: 'ubo_restore', path: file, before: auditValue(before?.userData) }] };
    },
  }),
];

// ------------------------------------------------------------ user resources (userResourcesLocation -> resource server)
const OUR_BUNDLE = /^http:\/\/127\.0\.0\.1:\d+\/resources\/bundle\.js(\?.*)?$/;

/**
 * Point userResourcesLocation at the resource server's bundle (version = content hash), wait until uBO has
 * fetched exactly that version, then reload filters so scriptlet filters resolve against it.
 */
async function applyResources(b: Browser, extra: string[], force: boolean): Promise<string[]> {
  const srv = await resourceServer(b);
  const bundle = srv.bundle();
  const cur = String((await readHidden(b)).current.userResourcesLocation ?? 'unset');
  const others = cur === 'unset' ? [] : cur.split(/\s+/).filter((u) => u && !OUR_BUNDLE.test(u));
  const url = `${srv.origin}/resources/bundle.js?v=${bundle.hash}${force ? `-${Date.now().toString(36)}` : ''}`;
  const next = [...new Set([url, ...others, ...extra])].join(' ');
  const lines: string[] = [];
  if (next === cur) {
    lines.push(`userResourcesLocation already serves bundle ${bundle.hash} (unchanged since uBO last loaded it; force:true reloads anyway)`);
  } else {
    const t0 = Date.now();
    let hit = false;
    const fetched = new Promise<void>((resolve) => {
      const check = () => { if (srv.log.some((e) => e.ts >= t0 && e.path === '/resources/bundle.js' && e.query.includes(bundle.hash))) { hit = true; off(); resolve(); } };
      const off = srv.onRequest(check);
      setTimeout(() => { off(); resolve(); }, 10000);
    });
    await writeHidden(b, { userResourcesLocation: next });
    await fetched;
    await sleep(150); // uBO parses right after the fetch resolves
    await uboSend(b, 'default', { what: 'reloadAllFilters' });
    lines.push(hit
      ? `uBO fetched bundle ${bundle.hash} from the resource server and reloaded (${Date.now() - t0} ms)`
      : `WARNING: uBO did not fetch the bundle within 10 s (userResourcesLocation is set to ${url}); check ubo_logger for "Reloading" messages`);
  }
  lines.push(`userResourcesLocation: ${next}`);
  if (!bundle.resources.length) lines.push(`NOTE: ${path.relative(process.cwd(), srv.resourcesDir) || srv.resourcesDir} has no .js files yet: the bundle is empty`);
  for (const r of bundle.resources) lines.push(`  ${r.file}: ${r.names.join(', ')}${r.fixes.length ? ` (${r.fixes.join('; ')})` : ''}`);
  for (const w of bundle.warnings) lines.push(`WARNING: ${w}`);
  return lines;
}

async function saveFilters(b: Browser, ctx: Ctx, edit: (cur: string) => string, force: boolean, toLint?: string[]): Promise<ToolOutput> {
  await uboRef(b);
  const cur = await readFilters(b);
  const next = edit(cur.content);
  if (next === cur.content) return { text: 'My filters unchanged (nothing to add or remove)' };
  if (!force) {
    const bad = lintReport(await uboLint(b, toLint ?? splitLines(next)));
    if (bad.length) fail('FILTER_INVALID', `uBO's parser rejects ${bad.length} line(s):\n${bad.join('\n')}`, 'Fix them, or pass force:true to save anyway.');
  }
  await ctx.requireScope(SCOPE, b);
  const ms = await writeFilters(b, next, cur.enabled, cur.trusted);
  if (!cur.enabled) { /* writeUserFilters with enabled=false keeps it disabled; say so */ }
  return {
    text: `My filters saved and applied in ${ms} ms${cur.enabled ? '' : ' (My filters is DISABLED in uBO)'}\n${diffLines(cur.content, next)}`,
    changes: [{ kind: 'ubo_filters', before: auditValue(cur.content), after: auditValue(next) }],
  };
}

// ------------------------------------------------------------ cosmetic query (no reload)
const OUTLINE = 'outline: 3px solid #ff2d55 !important; outline-offset: -1px !important;';

async function queryCosmetic(b: Browser, tab: number | undefined, lint: LintResult, highlight: boolean): Promise<{ count: number; items: { html: string; rect?: string }[]; note?: string }> {
  const compiled = lint.compiled ?? '';
  const describeEls = `(els, hl) => {
    const out = [];
    for (const el of els) {
      if (out.length < 10) {
        const r = el.getBoundingClientRect();
        const html = el.outerHTML.replace(/\\s+/g, ' ');
        out.push({ html: html.length > 200 ? html.slice(0, 200) + '…' : html, rect: r.width || r.height ? Math.round(r.left + scrollX) + ',' + Math.round(r.top + scrollY) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : 'not rendered' });
      }
      if (hl) el.setAttribute('data-claude-ubo-test', '');
    }
    if (hl && els.length && !document.getElementById('__claude_ubo_test')) {
      const s = document.createElement('style'); s.id = '__claude_ubo_test';
      s.textContent = '[data-claude-ubo-test] { ${OUTLINE} }';
      (document.head || document.documentElement).append(s);
    }
    return { count: els.length, items: out };
  }`;
  if (!lint.procedural) {
    const sel = compiled.replace(/:(?::?after|:?before|:[a-z-]+)$/, '');
    const ctxId = await b.context(tab);
    return b.callPage(ctxId, `(sel, hl) => { let els; try { els = [...document.querySelectorAll(sel)]; } catch (e) { return { count: 0, items: [], note: 'selector error: ' + e.message }; } return (${describeEls})(els, hl); }`, [sel, highlight]);
  }
  // procedural: uBO's own engine in its content-script sandbox (contentscript-extra is injected on demand)
  const ext = await uboRef(b);
  const ctxId = await b.context(tab);
  const t = await contentTarget(b, ext, ctxId);
  const d = await b.dt();
  const run = async () => {
    const r = await d.evaluate(t.consoleActor!, `(async () => {
      if (typeof vAPI === 'undefined' || !vAPI.domFilterer) return JSON.stringify({ missing: 'domFilterer' });
      if (typeof vAPI.DOMProceduralFilterer !== 'function' && typeof vAPI.DOMProceduralFilterer !== 'object') return JSON.stringify({ missing: 'procedural' });
      const o = JSON.parse(${JSON.stringify(compiled)});
      const pf = vAPI.domFilterer.createProceduralFilter(o);
      if (!pf) return JSON.stringify({ missing: 'procedural' });
      const els = Array.from(pf.exec() || []);
      return JSON.stringify((${describeEls})(els, ${highlight}));
    })()`);
    if (r.exception) fail('UBO_ERROR', `procedural filter failed in uBO's content script: ${r.exception}`);
    return JSON.parse(await d.longString(r.result));
  };
  let res = await run();
  if (res.missing === 'procedural') {
    const tabId = await extTabId(b, tab);
    await extCall(b, ext, `const w = await __cfFrame(); await w.browser.tabs.executeScript(${tabId}, { file: '/js/contentscript-extra.js', frameId: 0 }); return true;`);
    res = await run();
  }
  if (res.missing) fail('UBO_ERROR', `uBO's content script is not active in this page (${res.missing})`, 'Is uBO enabled for this site (not whitelisted)? Reload the page.');
  return res;
}

async function unhighlight(b: Browser, tab: number | undefined, _lint: LintResult) {
  await b.callPage(await b.context(tab), `() => { document.getElementById('__claude_ubo_test')?.remove(); for (const el of document.querySelectorAll('[data-claude-ubo-test]')) el.removeAttribute('data-claude-ubo-test'); }`);
}
