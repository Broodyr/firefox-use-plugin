// interception: mock rules and HAR replay through BiDi network.addIntercept on the agent tabs (page
// traffic; extension-made requests are invisible to BiDi). HAR recording reads the devtools hub, which has
// headers and bodies. One Interceptor per Claude session (client), registered for that session's agent tabs.
import fs from 'node:fs';
import { ToolError } from '../errors.js';
import { maskText } from '../safety/mask.js';
import type { BidiEvent } from '../transports/bidi.js';
import type { Browser } from './session.js';
import { currentClient } from './client.js';
import { kb, type Devtools, type NetEntry } from './devtools.js';

export type MockAction = 'fulfill' | 'fail' | 'delay' | 'modify_headers' | 'modify_body';

export interface MockRule {
  id: string;
  /** substring, /regex/flags, or a glob with * (matched against the whole URL) */
  url: string;
  method?: string;
  action: MockAction;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  body_base64?: string;
  ms?: number;
  request_headers?: Record<string, string | null>;
  response_headers?: Record<string, string | null>;
  replace?: [string, string][];
  /** stop matching after this many hits */
  times?: number;
  hits: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; httpVersion: string; headers: { name: string; value: string }[]; queryString: { name: string; value: string }[]; cookies: []; headersSize: -1; bodySize: number; postData?: { mimeType: string; text: string } };
  response: { status: number; statusText: string; httpVersion: string; headers: { name: string; value: string }[]; cookies: []; content: { size: number; mimeType: string; text?: string; encoding?: string }; redirectURL: string; headersSize: -1; bodySize: number };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _initiator?: string;
  _bodyMissing?: string;
}

/** Same normalisation on both sides: recorded URLs are masked, so live URLs are masked before lookup. */
export const harKey = (method: string, url: string) => `${method.toUpperCase()} ${maskText(url.replace(/#.*$/, ''))}`;

/**
 * Bodies keep their syntax: token-shaped strings and secret query parameters in URLs (a page's
 * <script src="app.js?token=…">) are masked, not header-like text (that could be code). A masked URL in a body is
 * requested as ?token=%3Cmasked%3E on replay, which masks to the same key.
 */
const SECRET_PARAM = /([?&;][^=&#\s"'<>]*?(?:token|key|secret|session|auth|sig|password)[^=&#\s"'<>]*=)([^&#\s"'<>]+)/gi;
const maskBody = (s: string) => s
  .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt:masked>')
  .replace(/\b(Bearer)\s+[A-Za-z0-9\-._~+/]{16,}=*/g, '$1 <masked>')
  .replace(SECRET_PARAM, '$1<masked>');

export function urlMatcher(p: string): (u: string) => boolean {
  // "/api/data" is a path, not a regex with flags "data": only valid flags make it a regex
  const re = /^\/(.+)\/([dgimsuyv]*)$/.exec(p);
  if (re) { const r = new RegExp(re[1], re[2]); return (u) => r.test(u); }
  if (p.includes('*')) {
    const r = new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return (u) => r.test(u);
  }
  return (u) => u.includes(p);
}

const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-connection']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
const hv = (v: string) => ({ type: 'string', value: v });
const bidiHeaders = (h: { name: string; value: string }[]) => h.map((x) => ({ name: x.name, value: hv(x.value) }));
const plain = (h: any[]) => (h ?? []).map((x: any) => ({ name: x.name, value: typeof x.value === 'string' ? x.value : x.value?.value ?? '' }));

function setHeaders(list: { name: string; value: string }[], changes: Record<string, string | null> = {}) {
  const out = list.filter((x) => !(x.name.toLowerCase() in Object.fromEntries(Object.keys(changes).map((k) => [k.toLowerCase(), 1]))));
  for (const [k, v] of Object.entries(changes)) if (v !== null) out.push({ name: k, value: v });
  return out;
}

export class Interceptor {
  rules: MockRule[] = [];
  private nextRule = 1;
  private interceptId: string | null = null;
  private contexts: string[] = [];
  replay: { name: string; file: string; mode: 'strict' | 'fallthrough'; byKey: Map<string, HarEntry[]>; used: Map<string, number>; served: number; passed: number; unmatched: string[] } | null = null;
  recording: { name: string; tab: number; context: string; from: number; started: number } | null = null;
  readonly log: { ts: number; url: string; what: string }[] = [];
  private handler = (e: BidiEvent) => { if (e.method === 'network.beforeRequestSent' && e.params?.isBlocked && this.interceptId && e.params.intercepts?.includes(this.interceptId)) void this.handle(e.params); };

  constructor(private b: Browser, readonly client: string) {
    b.bidi.on('event', this.handler);
    b.closers.push(() => b.bidi.off('event', this.handler));
    b.tabHooks.push((ctx, client) => (client === this.client && this.active ? this.sync([...this.contexts, ctx]) : Promise.resolve()));
  }

  get active() { return this.rules.length > 0 || !!this.replay; }

  /** (Re)register the intercept for this session's agent tabs, or remove it when nothing is active. */
  async sync(contexts?: string[]) {
    const want = this.active ? contexts ?? (await this.b.listTabs()).filter((t) => t.agent).map((t) => t.id) : [];
    const same = want.length === this.contexts.length && want.every((c) => this.contexts.includes(c)) && !!this.interceptId === this.active;
    if (same) return;
    if (this.interceptId) { await this.b.bidi.send('network.removeIntercept', { intercept: this.interceptId }).catch(() => {}); this.interceptId = null; }
    this.contexts = want;
    if (!want.length) return;
    const r = await this.b.bidi.send('network.addIntercept', { phases: ['beforeRequestSent'], contexts: want });
    this.interceptId = r.intercept;
  }

  addRules(rules: Omit<MockRule, 'id' | 'hits'>[]): MockRule[] {
    const added = rules.map((r) => ({ ...r, id: `m${this.nextRule++}`, hits: 0 }));
    this.rules.push(...added);
    return added;
  }

  private note(url: string, what: string) { this.log.push({ ts: Date.now(), url, what }); if (this.log.length > 300) this.log.shift(); }

  private async handle(p: any) {
    const id = p.request.request as string;
    const url = p.request.url as string;
    const method = p.request.method as string;
    const send = (m: string, params: Record<string, unknown>) => this.b.bidi.send(m, { request: id, ...params }).catch((e) => this.note(url, `error ${m}: ${e.message}`));
    try {
      const rule = this.rules.find((r) => (!r.method || r.method.toUpperCase() === method) && (r.times === undefined || r.hits < r.times) && urlMatcher(r.url)(url));
      if (rule) {
        rule.hits++;
        this.note(url, `${rule.id} ${rule.action}`);
        return await this.apply(rule, p, send);
      }
      if (this.replay) {
        const k = harKey(method, url);
        const list = this.replay.byKey.get(k);
        if (list?.length) {
          // repeated requests get the recorded responses in order; the last one repeats
          const n = this.replay.used.get(k) ?? 0;
          this.replay.used.set(k, n + 1);
          const h = list[Math.min(n, list.length - 1)];
          this.replay.served++;
          const r = h.response;
          const body = r.content.text === undefined ? undefined : r.content.encoding === 'base64' ? { type: 'base64', value: r.content.text } : { type: 'string', value: r.content.text };
          return await send('network.provideResponse', {
            statusCode: r.status, reasonPhrase: r.statusText || 'OK',
            headers: bidiHeaders(r.headers.filter((x) => !DROP_RESPONSE.has(x.name.toLowerCase()) && !/^<masked>$/.test(x.value))),
            ...(body ? { body } : {}),
          });
        }
        if (/^\/favicon\.ico$/.test(new URL(url).pathname)) {
          // the browser asks for it on its own; not the page's traffic
          return await send('network.provideResponse', { statusCode: 404, reasonPhrase: 'Not Found', headers: [], body: { type: 'string', value: '' } });
        }
        if (this.replay.mode === 'strict') {
          this.replay.unmatched.push(`${method} ${url}`);
          this.note(url, 'har: unmatched, failed (strict)');
          return await send('network.failRequest', {});
        }
        this.replay.passed++;
      }
      await send('network.continueRequest', {});
    } catch (e: any) {
      this.note(url, `error: ${e.message}`);
      await send('network.continueRequest', {});
    }
  }

  private async apply(r: MockRule, p: any, send: (m: string, params: Record<string, unknown>) => Promise<unknown>) {
    switch (r.action) {
      case 'fail': return send('network.failRequest', {});
      case 'delay': await new Promise((res) => setTimeout(res, r.ms ?? 1000)); return send('network.continueRequest', {});
      case 'fulfill': {
        const headers = Object.entries(r.headers ?? {}).map(([name, value]) => ({ name, value }));
        if (!headers.some((h) => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'content-type', value: r.body_base64 ? 'application/octet-stream' : 'text/plain; charset=utf-8' });
        const body = r.body_base64 !== undefined ? { type: 'base64', value: r.body_base64 } : { type: 'string', value: r.body ?? '' };
        return send('network.provideResponse', { statusCode: r.status ?? 200, reasonPhrase: 'OK', headers: bidiHeaders(headers), body });
      }
      case 'modify_headers':
        if (!r.response_headers) return send('network.continueRequest', { headers: bidiHeaders(setHeaders(plain(p.request.headers), r.request_headers)) });
      // response headers need the upstream response: fall through
      case 'modify_body': {
        const up = await this.upstream(p, r.request_headers);
        let body = up.body;
        if (r.action === 'modify_body') {
          let text = body.toString('utf8');
          if (r.body !== undefined) text = r.body;
          for (const [from, to] of r.replace ?? []) text = text.split(from).join(to);
          body = Buffer.from(text, 'utf8');
        }
        const headers = setHeaders(up.headers.filter((x) => !DROP_RESPONSE.has(x.name.toLowerCase())), r.response_headers);
        return send('network.provideResponse', { statusCode: up.status, reasonPhrase: up.statusText || 'OK', headers: bidiHeaders(headers), body: { type: 'base64', value: body.toString('base64') } });
      }
    }
  }

  /** Fetch the real response from this server (the request's own headers, cookies included). GET/HEAD only. */
  private async upstream(p: any, reqChanges?: Record<string, string | null> | null) {
    const method = p.request.method as string;
    if (!['GET', 'HEAD'].includes(method) && (p.request.bodySize ?? 0) > 0) throw new ToolError('MOCK_UNSUPPORTED', 'modify_body / response_headers need the upstream response; requests with a body are not replayed');
    const headers: Record<string, string> = {};
    for (const h of setHeaders(plain(p.request.headers), reqChanges ?? {})) if (!HOP.has(h.name.toLowerCase())) headers[h.name] = h.value;
    const res = await fetch(p.request.url, { method, headers, redirect: 'manual' });
    const out: { name: string; value: string }[] = [];
    res.headers.forEach((value, name) => out.push({ name, value }));
    return { status: res.status, statusText: res.statusText, headers: out, body: Buffer.from(await res.arrayBuffer()) };
  }

  // ------------------------------------------------------------ HAR
  loadReplay(name: string, file: string, mode: 'strict' | 'fallthrough') {
    let har: any;
    try { har = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new ToolError('HAR_INVALID', `can't read ${file}: ${e.message}`); }
    const entries: HarEntry[] = har?.log?.entries ?? [];
    const byKey = new Map<string, HarEntry[]>();
    for (const e of entries) {
      const k = harKey(e.request.method, e.request.url);
      const l = byKey.get(k) ?? [];
      l.push(e);
      byKey.set(k, l);
    }
    // a response the recording couldn't keep is only served when there is nothing better for that request
    // (an empty 200 next to a non-empty one for the same request is a body the devtools server lost, too)
    const lost = (e: HarEntry) => !!e._bodyMissing || (e.response.status === 200 && !e.response.content.text);
    for (const [k, l] of byKey) { const good = l.filter((e) => !lost(e)); if (good.length && good.length < l.length) byKey.set(k, good); }
    this.replay = { name, file, mode, byKey, used: new Map(), served: 0, passed: 0, unmatched: [] };
    return entries.length;
  }
}

export function interceptorFor(b: Browser): Interceptor {
  const key = `intercept:${currentClient()}`;
  let i = b.adapters.get(key) as Interceptor | undefined;
  if (!i) { i = new Interceptor(b, currentClient()); b.adapters.set(key, i); }
  return i;
}

/** Build HAR entries from the devtools hub's requests of one tab since `from` (masked). */
export async function harFromHub(b: Browser, d: Devtools, tab: number, from: number, include: (e: NetEntry) => boolean): Promise<{ entries: HarEntry[]; missing: number }> {
  const out: HarEntry[] = [];
  let missing = 0;
  for (const e of d.net) {
    // incomplete or aborted requests (no status: a load replaced by the next one) would replay as empty responses
    if (e.seq <= from || !include(e) || !e.status || e.status === '0') continue;
    if (e.initiator === 'page' && (await b.tabForBc(e.bc)) !== tab) continue;
    const hdr = await d.headers(e).catch(() => ({ request: [], response: [] }));
    const maskH = (h: { name: string; value: string }[]) => h.map((x) => ({ name: x.name, value: /^(cookie|set-cookie|authorization|proxy-authorization)$/i.test(x.name) ? '<masked>' : maskText(x.value) }));
    const raw = await d.responseContentRaw(e).catch(() => null);
    let post: string | undefined;
    if (!['GET', 'HEAD'].includes(e.method)) post = await d.requestBody(e).catch(() => undefined);
    const url = maskText(e.url);
    let qs: { name: string; value: string }[] = [];
    try { qs = [...new URL(url.replace(/<masked>/g, 'masked')).searchParams].map(([name, value]) => ({ name, value })); } catch { /* not a URL */ }
    const mime = raw?.mimeType ?? e.mimeType ?? '';
    const entry: HarEntry = {
      startedDateTime: new Date(e.ts).toISOString(), time: e.totalTime ?? 0,
      request: { method: e.method, url, httpVersion: 'HTTP/1.1', headers: maskH(hdr.request), queryString: qs, cookies: [], headersSize: -1, bodySize: post?.length ?? 0, ...(post ? { postData: { mimeType: hdr.request.find((h) => /^content-type$/i.test(h.name))?.value ?? '', text: maskBody(post) } } : {}) },
      response: {
        status: Number(e.status ?? 0), statusText: e.statusText ?? '', httpVersion: 'HTTP/1.1', headers: maskH(hdr.response), cookies: [],
        content: { size: raw?.size ?? e.contentSize ?? 0, mimeType: mime, ...(raw?.text !== undefined ? (raw.encoding === 'base64' ? { text: raw.text, encoding: 'base64' } : { text: maskBody(raw.text) }) : {}) },
        redirectURL: hdr.response.find((h) => /^location$/i.test(h.name))?.value ?? '', headersSize: -1, bodySize: e.transferredSize ?? -1,
      },
      cache: {}, timings: { send: 0, wait: e.totalTime ?? 0, receive: 0 },
      _initiator: e.initiator,
    };
    const emptyButSent = raw?.text === '' && (e.contentSize ?? 0) > 0;
    if ((raw?.text === undefined || emptyButSent) && !/^(204|304)$/.test(String(e.status)) && e.method !== 'HEAD') { entry._bodyMissing = raw?.note ?? 'body not available'; missing++; }
    out.push(entry);
  }
  return { entries: out, missing };
}

export const harSummary = (entries: HarEntry[]) => `${entries.length} request(s), ${kb(entries.reduce((n, e) => n + (e.response.content.text?.length ?? 0), 0))} of bodies`;
