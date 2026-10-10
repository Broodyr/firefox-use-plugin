// network reading: network_read, network_body, headers_inspect.
// Source: the devtools hub's network-event resources (parent-process watcher), which include extension-made
// requests (uBO list/resource fetches, GM_xmlhttpRequest via Violentmonkey) that BiDi never sees.
import { z } from 'zod';
import type { Browser } from '../browser/session.js';
import { kb, type NetEntry } from '../browser/devtools.js';
import { ALIASES } from '../browser/scope.js';
import { fail } from '../errors.js';
import { matcher, queryConsole, sinceFilter, clock } from './console.js';
import { tool, tabArg } from './registry.js';
import { sleep } from '../browser/launcher.js';

const shortMime = (m?: string) => (m ? m.split(';')[0].replace(/^(text|application)\//, '').replace('javascript', 'js') : '?');

async function initiatorLabel(b: Browser, e: NetEntry): Promise<string> {
  if (e.initiator === 'page') { const t = await b.tabForBc(e.bc); return t !== undefined ? `page tab${t}` : 'page'; }
  if (e.initiator.startsWith('extension:')) {
    const id = e.initiator.slice(10);
    const alias = Object.entries(ALIASES).find(([, v]) => v === id)?.[0];
    const script = gmXhrScript(b, e);
    return `ext:${alias ?? b.devtools?.extNameById.get(id) ?? id}${script ? ` userscript "${script}"` : ''}`;
  }
  return e.initiator;
}

/**
 * GM_xmlhttpRequest attribution: the request carries nothing naming the userscript (Violentmonkey only adds a
 * random #VMxhr fragment), so match the "[claude-gmxhr]" console marker that the dev prelude (manager mode) or the
 * companion (fast mode) logs just before the request: same URL, within 10 s.
 */
function gmXhrScript(b: Browser, e: NetEntry): string | undefined {
  const d = b.devtools;
  if (!d || b.personal || (e.initiator !== `extension:${ALIASES.vm}` && e.initiator !== `extension:${ALIASES.companion}`)) return undefined;
  const url = e.url.replace(/#VMxhr[^#]*$/, ''); // base64 id: may contain + and /
  for (let i = d.log.length - 1; i >= 0; i--) {
    const l = d.log[i];
    if (l.ts < e.ts - 10000) break;
    if (l.ts > e.ts + 2000 || !l.text.startsWith('[claude-gmxhr] ')) continue;
    try { const m = JSON.parse(l.text.slice(15)); if (m.url === url) return m.script; } catch { /* not ours */ }
  }
  return undefined;
}

export async function netLine(b: Browser, e: NetEntry): Promise<string> {
  const st = e.blockedReason ? `BLOCKED(${e.blockedReason})` : e.status ?? (e.done ? 'ERR' : '…');
  const time = e.totalTime !== undefined ? ` ${e.totalTime}ms` : '';
  return `${e.id} ${e.method} ${st} ${shortMime(e.mimeType)} ${kb(e.contentSize)}${time} [${await initiatorLabel(b, e)}${e.isNavigation ? ' nav' : ''}${e.cause && e.cause !== 'document' && !e.isNavigation ? ` ${e.cause}` : ''}${e.fromCache ? ' cache' : ''}] ${e.url}`;
}

/** Entries matching network_read filters (shared with wait_for_request). */
export async function queryNet(b: Browser, q: { filter?: string; initiator?: string; tab?: number; since?: string; status?: string; method?: string }): Promise<NetEntry[]> {
  const d = await b.hub();
  const since = sinceFilter(q.since, 0);
  const match = matcher(q.filter);
  const want = q.initiator ? (ALIASES[q.initiator] ? `extension:${ALIASES[q.initiator]}` : q.initiator) : undefined;
  const out: NetEntry[] = [];
  for (const e of d.net) {
    if (!since(e.seq, e.ts) || !match(e.url)) continue;
    if (want) {
      if (want === 'extension' ? !e.initiator.startsWith('extension:') : want.startsWith('extension:') ? e.initiator !== want : !e.initiator.startsWith(want) && e.initiator !== `extension:${want}`) continue;
    }
    if (q.method && e.method.toLowerCase() !== q.method.toLowerCase()) continue;
    if (q.status) {
      const s = e.status ?? '';
      if (q.status === 'error' ? !(e.blockedReason || (e.done && !e.status) || Number(s) >= 400) : !s.startsWith(q.status.replace(/x+$/i, ''))) continue;
    }
    if (q.tab !== undefined && (await b.tabForBc(e.bc)) !== q.tab) continue;
    out.push(e);
  }
  return out;
}

async function body(b: Browser, e: NetEntry, max: number): Promise<{ text: string; note: string }> {
  return (await b.hub()).responseBody(e, max);
}

async function findEntry(b: Browser, ref: string): Promise<NetEntry> {
  const d = await b.hub();
  if (/^r\d+$/.test(ref)) {
    const e = d.netById(ref);
    if (!e) fail('REQUEST_NOT_FOUND', `${ref} is not in the network log (it keeps the last 1500 requests)`, 'Call network_read to get current ids.');
    return e!;
  }
  // a request made just before this call may still be on its way from the devtools hub: wait briefly
  const look = () => [...d.net].reverse().find((e) => e.url === ref) ?? [...d.net].reverse().find((e) => e.url.includes(ref));
  let exact = look();
  for (let i = 0; !exact && i < 20; i++) { await sleep(100); exact = look(); }
  if (!exact) fail('REQUEST_NOT_FOUND', `no request matching ${ref}`, 'Load the page first (navigate), then call headers_inspect; or use network_read to find the id.');
  return exact!;
}

// ------------------------------------------------------------ CSP analysis
type Policy = Map<string, string[]>;
function parseCsp(header: string): Policy[] {
  // several policies may be comma-joined in one header value
  return header.split(',').map((p) => {
    const m: Policy = new Map();
    for (const part of p.split(';')) {
      const [name, ...vals] = part.trim().split(/\s+/);
      if (name && !m.has(name.toLowerCase())) m.set(name.toLowerCase(), vals);
    }
    return m;
  }).filter((m) => m.size);
}

function directive(p: Policy, chain: string[]): { name: string; vals: string[] } | null {
  for (const n of chain) { const v = p.get(n); if (v) return { name: n, vals: v }; }
  return null;
}

function allowsInline(vals: string[]): boolean {
  const l = vals.map((v) => v.toLowerCase());
  if (!l.includes("'unsafe-inline'")) return false;
  // a nonce, hash or strict-dynamic disables 'unsafe-inline'
  return !l.some((v) => /^'(nonce-|sha(256|384|512)-|strict-dynamic')/.test(v));
}

function allowsSource(vals: string[], scheme: string, host?: string, docOrigin?: string): boolean {
  const l = vals.map((v) => v.toLowerCase());
  if (l.includes("'none'")) return false;
  if (l.includes(`${scheme}:`)) return true;
  if (!host) return false;
  if (l.includes('*') && /^(https?|wss?):?$/.test(scheme)) return true;
  if (docOrigin && l.includes("'self'") && docOrigin === `${scheme}://${host}`) return true;
  const hostOnly = host.replace(/:\d+$/, '');
  return l.some((v) => {
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?/.exec(v);
    if (!m || v.startsWith("'")) return false;
    if (m[1] && m[1] !== scheme) return false;
    const h = m[2];
    const hostOk = h === hostOnly || (h.startsWith('*.') && hostOnly.endsWith(h.slice(1)));
    const port = /:(\d+)$/.exec(host)?.[1];
    const portOk = !m[3] || m[3] === '*' || m[3] === port;
    return hostOk && (portOk || (!m[3] && !port));
  });
}

export function cspReport(headers: { name: string; value: string }[], docUrl: string): string[] {
  const out: string[] = [];
  let origin: string | undefined;
  try { origin = new URL(docUrl).origin; } catch { /* ignore */ }
  const enforce = headers.filter((h) => h.name.toLowerCase() === 'content-security-policy');
  const reportOnly = headers.filter((h) => h.name.toLowerCase() === 'content-security-policy-report-only');
  if (!enforce.length && !reportOnly.length) return ['CSP: none in the response headers (a <meta http-equiv> CSP in the page would not show here)'];
  const policies = enforce.flatMap((h) => parseCsp(h.value));
  for (const [i, p] of policies.entries()) out.push(`CSP policy ${i + 1}: ${[...p.entries()].map(([k, v]) => `${k} ${v.join(' ')}`).join('; ').slice(0, 1500)}`);
  for (const h of reportOnly) out.push(`CSP report-only (not enforced): ${h.value.slice(0, 600)}`);
  const checks: [string, (p: Policy) => { ok: boolean; why: string }][] = [
    ['inline <script>', (p) => { const d = directive(p, ['script-src-elem', 'script-src', 'default-src']); return !d ? { ok: true, why: 'no script directive' } : { ok: allowsInline(d.vals), why: d.name }; }],
    ['eval / new Function', (p) => { const d = directive(p, ['script-src', 'default-src']); return !d ? { ok: true, why: 'no script directive' } : { ok: d.vals.map((v) => v.toLowerCase()).includes("'unsafe-eval'"), why: d.name }; }],
    ['blob: script', (p) => { const d = directive(p, ['script-src-elem', 'script-src', 'default-src']); return !d ? { ok: true, why: 'no script directive' } : { ok: allowsSource(d.vals, 'blob'), why: d.name }; }],
    ['data: script', (p) => { const d = directive(p, ['script-src-elem', 'script-src', 'default-src']); return !d ? { ok: true, why: 'no script directive' } : { ok: allowsSource(d.vals, 'data'), why: d.name }; }],
    ['<style> element', (p) => { const d = directive(p, ['style-src-elem', 'style-src', 'default-src']); return !d ? { ok: true, why: 'no style directive' } : { ok: allowsInline(d.vals), why: d.name }; }],
    ['style="" attribute', (p) => { const d = directive(p, ['style-src-attr', 'style-src', 'default-src']); return !d ? { ok: true, why: 'no style directive' } : { ok: allowsInline(d.vals), why: d.name }; }],
    ['blob: worker', (p) => { const d = directive(p, ['worker-src', 'child-src', 'script-src', 'default-src']); return !d ? { ok: true, why: 'no worker directive' } : { ok: allowsSource(d.vals, 'blob'), why: d.name }; }],
    ['fetch to http://127.0.0.1 (resource server)', (p) => { const d = directive(p, ['connect-src', 'default-src']); return !d ? { ok: true, why: 'no connect directive' } : { ok: allowsSource(d.vals, 'http', '127.0.0.1:1', origin), why: d.name }; }],
    ['<script src=http://127.0.0.1>', (p) => { const d = directive(p, ['script-src-elem', 'script-src', 'default-src']); return !d ? { ok: true, why: 'no script directive' } : { ok: allowsSource(d.vals, 'http', '127.0.0.1:1', origin), why: d.name }; }],
  ];
  for (const [label, f] of checks) {
    const blockers = policies.map(f).filter((r) => !r.ok);
    out.push(`  ${blockers.length ? 'BLOCKED' : 'allowed'}: ${label}${blockers.length ? ` (by ${[...new Set(blockers.map((r) => r.why))].join(', ')})` : ''}`);
  }
  if (policies.some((p) => p.has('require-trusted-types-for'))) out.push('  NOTE: require-trusted-types-for is set: innerHTML/eval-like sinks need Trusted Types');
  out.push('  (userscripts injected into the page realm and uBO scriptlets are subject to the page CSP; content-script sandboxes are not)');
  return out;
}

export const networkTools = [
  tool({
    name: 'network_requests',
    description: 'List recent requests (page AND extension-made: uBO, Violentmonkey GM_xmlhttpRequest, any add-on), each labelled with its initiator (page tabN / ext:<name>), status, type, size and time. Returns a cursor for since=. Use network_body / headers_inspect with the request id.',
    args: {
      filter: z.string().optional().describe('Substring or /regex/ over the URL'),
      initiator: z.string().optional().describe('"page", "extension", "browser", an alias (ubo, vm) or an extension id'),
      tab: tabArg.describe('Only page requests of this tab'),
      status: z.string().optional().describe('"200", "4xx", "error" (blocked, failed or >= 400)'),
      method: z.string().optional(),
      since: z.string().optional().describe('Cursor ("r123"/"123") or time ("30s", ISO); default: everything kept'),
      include_bodies: z.boolean().default(false).describe('Append the first 300 chars of each text body (max 10 requests)'),
      limit: z.number().int().positive().max(500).default(40),
    },
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const all = await queryNet(b, a);
      const rows = all.slice(-a.limit);
      const lines: string[] = [];
      for (const [i, e] of rows.entries()) {
        let l = `${clock(e.ts)} ${await netLine(b, e)}`;
        if (a.include_bodies && i >= rows.length - 10 && e.done && /text|json|javascript|xml|html/.test(e.mimeType ?? '')) {
          const bd = await body(b, e, 300);
          if (bd.text) l += `\n    body: ${JSON.stringify(bd.text.slice(0, 300))}`;
        }
        lines.push(l);
      }
      return `${lines.join('\n') || 'no matching requests'}\n${all.length > rows.length ? `(${all.length} matched; showing the last ${rows.length})\n` : ''}cursor: r${d.netCursor}`;
    },
  }),
  tool({
    name: 'network_body',
    description: 'Response body of a request from network_read (text bodies; binary ones are reported by size). Truncated to max_chars.',
    args: { request_id: z.string().regex(/^r\d+$/).describe('Request id, e.g. "r12"'), request_body: z.boolean().default(false).describe('Also show the request (POST) body') },
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const e = await findEntry(b, a.request_id);
      const max = (a.max_chars ?? 8000) - 400;
      const bd = await body(b, e, max);
      let s = `${await netLine(b, e)}\nbody: ${bd.note}\n${bd.text.slice(0, max)}`;
      if (a.request_body) {
        try {
          const t = await (await b.hub()).requestBody(e);
          s = `request body: ${t ? t.slice(0, 2000) : '(none)'}\n` + s;
        } catch { s = 'request body: unavailable\n' + s; }
      }
      return s;
    },
  }),
  tool({
    name: 'headers_inspect',
    description: 'Request and response headers of a request (id or URL), with the CSP parsed and checked against what userscripts/scriptlets need: inline scripts, eval, blob:/data: scripts, inline styles, fetches to the local resource server. Lists recent CSP violations from the console.',
    args: { target: z.string().min(1).describe('Request id ("r12") or URL (latest matching request; substring allowed)') },
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const e = await findEntry(b, a.target);
      const h = await d.headers(e);
      const req = { headers: h.request }, res = { headers: h.response };
      const fmt = (h: { name: string; value: string }[]) => h.map((x) => `  ${x.name}: ${x.value.length > 400 ? x.value.slice(0, 400) + '…' : x.value}`).join('\n') || '  (none)';
      const lines = [await netLine(b, e), `${e.status ?? '?'} ${e.statusText ?? ''}`.trim(), 'request headers:', fmt(req.headers), 'response headers:', fmt(res.headers)];
      lines.push(...cspReport(res.headers, e.url));
      const tab = await b.tabForBc(e.bc);
      const csp = await queryConsole(b, { pattern: '/Content[- ]Security[- ]Policy|CSP/i', tab, sources: ['page', 'content', 'browser'] }).catch(() => []);
      if (csp.length) lines.push(`recent CSP violations (${csp.length}):`, ...csp.slice(-5).map((c) => `  ${clock(c.ts)} ${c.text.slice(0, 300)}`));
      return lines.join('\n');
    },
  }),
];
