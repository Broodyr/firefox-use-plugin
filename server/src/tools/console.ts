// unified console: page, every content-script / userscript realm, extension background pages and
// workers, the Browser Console, uncaught errors and unhandled rejections, from the devtools hub.
import { z } from 'zod';
import { mapVmStacks } from '../adapters/violentmonkey.js';
import type { Browser } from '../browser/session.js';
import type { LogEntry, Source } from '../browser/devtools.js';
import { tool, tabArg } from './registry.js';

const SOURCES = ['page', 'content', 'extension', 'worker', 'browser'] as const;
const LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;
const rank = (l: string) => ({ debug: 0, trace: 0, log: 1, info: 1, dir: 1, table: 1, warn: 2, warning: 2, error: 3, assert: 3 } as Record<string, number>)[l] ?? 1;

export const sourcesArg = z.array(z.enum(SOURCES)).optional()
  .describe('Sources to include (default all; "browser" = Browser Console, errors only unless listed explicitly)');
export const sinceArg = z.string().optional()
  .describe('Cursor from a previous result ("c123"), a time ("2026-10-03T10:00", "30s", "5m"), or omit for everything since console_clear');

/** Text matcher: "/re/flags" or case-insensitive substring. */
export function matcher(p?: string): (s: string) => boolean {
  if (!p) return () => true;
  const m = /^\/(.+)\/([dgimsuvy]*)$/.exec(p);
  if (m) {
    // "/ads/banner" is a path, not a regex with flags "banner": only valid regexes count
    try { const re = new RegExp(m[1], m[2]); return (s) => re.test(s); } catch { /* substring */ }
  }
  const q = p.toLowerCase();
  return (s) => s.toLowerCase().includes(q);
}

/** since -> predicate on (seq, ts). */
export function sinceFilter(since: string | undefined, floorSeq: number): (seq: number, ts: number) => boolean {
  if (!since) return (seq) => seq > floorSeq;
  const c = /^[cr]?(\d+)$/.exec(since);
  if (c) return (seq) => seq > Number(c[1]);
  const rel = /^(\d+)\s*(ms|s|m|h)$/.exec(since);
  const t = rel ? Date.now() - Number(rel[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[rel[2] as 's']! : Date.parse(since);
  return (_seq, ts) => !Number.isNaN(t) && ts >= t;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export interface ConsoleQuery { sources?: Source[]; level?: string; pattern?: string; since?: string; tab?: number; realm?: string }

/** Filter the devtools log the way console_read does (also used by waits and navigate reports). */
export async function queryConsole(b: Browser, q: ConsoleQuery, floorSeq = 0): Promise<(LogEntry & { tab?: number })[]> {
  const d = await b.hub();
  const since = sinceFilter(q.since, floorSeq);
  const explicitBrowser = q.sources?.includes('browser');
  const srcs = new Set<Source>(q.sources ?? SOURCES);
  const min = q.level ? rank(q.level) : 0;
  const match = matcher(q.pattern);
  const realmMatch = q.realm ? matcher(q.realm) : () => true;
  const out: (LogEntry & { tab?: number })[] = [];
  for (const e of d.log) {
    if (!since(e.seq, e.ts) || !srcs.has(e.source) || rank(e.level) < min) continue;
    if (e.text.startsWith('[claude-start] ')) continue; // the dev prelude's start marker (verify reads it), not the script's output
    if (e.source === 'browser' && !explicitBrowser && rank(e.level) < 3) continue;
    const realm = d.realmLabel(e);
    if (!match(`${e.text} ${e.url ?? ''}`) || !realmMatch(realm)) continue;
    const tab = await b.tabForBc(e.bc);
    if (q.tab !== undefined && tab !== q.tab) continue;
    out.push({ ...e, realm, tab });
  }
  return b.personal ? out : mapVmStacks(b, out);
}

/** Collapse identical entries to ×N with first and last time. */
export function renderEntries(entries: (LogEntry & { tab?: number })[], detail: string, limit: number): string[] {
  const groups = new Map<string, { e: LogEntry & { tab?: number }; n: number; first: number; last: number }>();
  for (const e of entries) {
    const k = `${e.level}|${e.realm}|${e.tab}|${e.text}|${e.url}|${e.line}`;
    const g = groups.get(k);
    if (g) { g.n++; g.last = e.ts; g.e = e; } else groups.set(k, { e, n: 1, first: e.ts, last: e.ts });
  }
  const rows = [...groups.values()].sort((a, b) => a.e.seq - b.e.seq).slice(-limit);
  const textMax = detail === 'full' ? 4000 : detail === 'normal' ? 600 : 220;
  return rows.map(({ e, n, first, last }) => {
    const where = e.url ? ` (${shortUrl(e.url)}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ''}` : ''})` : '';
    const tab = e.tab !== undefined ? ` tab${e.tab}` : '';
    const times = n > 1 ? ` ×${n} ${clock(first)}–${clock(last)}` : '';
    let s = `${clock(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.realm}${tab}]${e.kind === 'console' ? '' : ` ${e.kind}`} ${e.text.length > textMax ? e.text.slice(0, textMax) + '…' : e.text}${where}${times}`;
    if (e.stack && (detail !== 'summary' || e.kind !== 'console')) s += `\n    at ${detail === 'summary' ? e.stack.split(' <- ').slice(0, 2).join(' <- ') : e.stack}`;
    return s;
  });
}

export function shortUrl(u: string): string {
  const m = /^moz-extension:\/\/[^/]+(\/.*)$/.exec(u);
  if (m) return `ext:${m[1]}`;
  return u.length > 90 ? u.slice(0, 40) + '…' + u.slice(-45) : u;
}

/** Normalise an error message into a grouping signature. */
function signature(e: LogEntry): string {
  return `${e.realm}|${e.text.replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/(["'`]).{20,}?\1/g, '"…"').slice(0, 300)}|${e.url ?? ''}:${e.line ?? ''}`;
}

export const consoleTools = [
  tool({
    name: 'console_entries',
    description: 'Read the unified console: page, content scripts/userscripts, extension background pages, workers and the Browser Console, incl. uncaught errors and promise rejections, with script URL:line and stacks. Identical entries collapse to ×N. Returns a cursor for since=.',
    args: {
      sources: sourcesArg,
      level: z.enum(LEVELS).optional().describe('Minimum level'),
      pattern: z.string().optional().describe('Substring or /regex/ over message text and script URL'),
      realm: z.string().optional().describe('Substring or /regex/ over the realm label, e.g. "content:uBlock" or "extension:"'),
      tab: tabArg.describe('Only entries from this tab'),
      since: sinceArg,
      limit: z.number().int().positive().max(500).default(50),
    },
    detail: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const entries = await queryConsole(b, a, b.consoleFloor());
      const lines = renderEntries(entries, a.detail ?? 'summary', a.limit);
      return `${lines.length ? lines.join('\n') : 'no matching console entries'}\ncursor: c${d.cursor}${entries.length > lines.length ? ` (${entries.length} entries; showing the last ${lines.length} groups)` : ''}`;
    },
  }),
  tool({
    name: 'console_clear',
    description: 'Reset the console cursor: later console_read / errors_summary calls without since only show newer entries.',
    args: {},
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      b.setConsoleFloor(d.cursor);
      return `console cursor reset at c${d.cursor}`;
    },
  }),
  tool({
    name: 'errors_summary',
    description: 'Errors (uncaught, rejections, console.error) grouped by signature, with counts, realm, first and last occurrence and a sample stack.',
    args: { since: sinceArg, tab: tabArg, sources: sourcesArg },
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const entries = await queryConsole(b, { since: a.since, tab: a.tab, sources: a.sources, level: 'error' }, b.consoleFloor());
      const groups = new Map<string, { e: LogEntry; n: number; first: number; last: number }>();
      for (const e of entries) {
        const k = signature(e);
        const g = groups.get(k);
        if (g) { g.n++; g.last = e.ts; } else groups.set(k, { e, n: 1, first: e.ts, last: e.ts });
      }
      const rows = [...groups.values()].sort((x, y) => y.n - x.n || y.last - x.last);
      if (!rows.length) return `no errors\ncursor: c${d.cursor}`;
      const out = rows.slice(0, 40).map(({ e, n, first, last }) => {
        let s = `×${n} [${e.realm}] ${e.kind === 'console' ? 'console.error' : e.kind}: ${e.text.slice(0, a.detail === 'full' ? 2000 : 300)}${e.url ? ` (${shortUrl(e.url)}:${e.line ?? '?'})` : ''}\n    first ${clock(first)} · last ${clock(last)}`;
        if (e.stack) s += `\n    at ${a.detail === 'summary' ? e.stack.split(' <- ').slice(0, 3).join(' <- ') : e.stack}`;
        return s;
      });
      return `${rows.length} error signature(s), ${entries.length} error(s)\n${out.join('\n')}\ncursor: c${d.cursor}`;
    },
  }),
];
