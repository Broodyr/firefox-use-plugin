// Personal mode: console and network for console_read / network_read / waits from BiDi alone
// (log.entryAdded, network.* events, network data collectors for bodies), in the same entry shapes as the
// devtools hub. Only Claude's own tabs are watched: subscriptions and body collectors are per agent tab, so
// the user's tabs are never logged.
import type { Bidi, BidiEvent } from '../transports/bidi.js';
import { MAX_LOG, MAX_NET, kb, type Header, type Hub, type LogEntry, type NetEntry } from './devtools.js';

const BODY_MAX = 256 * 1024;
const hval = (h: any): Header => ({ name: String(h.name), value: h.value?.type === 'base64' ? Buffer.from(h.value.value, 'base64').toString('latin1') : String(h.value?.value ?? h.value ?? '') });

export class BidiHub implements Hub {
  readonly log: LogEntry[] = [];
  readonly net: NetEntry[] = [];
  readonly extNameById = new Map<string, string>();
  dead = false;
  private seq = 0;
  private netSeq = 0;
  private byRequest = new Map<string, NetEntry & { reqHeaders?: Header[]; resHeaders?: Header[]; ctx?: string }>();
  /** BiDi context ids are strings; entries carry a small number per top-level context (tabForBc maps it back) */
  private bcNum = new Map<string, number>();
  readonly ctxOfBc = new Map<number, string>();
  /** frame context -> its top-level context */
  readonly parentOf = new Map<string, string>();
  /** agent tab context -> its event subscription and body collector */
  private watched = new Map<string, { sub?: string; collector?: string }>();

  constructor(private bidi: Bidi) {}

  get cursor() { return this.seq; }
  get netCursor() { return this.netSeq; }
  realmLabel(e: LogEntry) { return e.realm; }
  netById(id: string) { return this.net.find((e) => e.id === id); }

  top(ctx: string): string { let c = ctx; for (let i = 0; i < 50 && this.parentOf.has(c); i++) c = this.parentOf.get(c)!; return c; }
  bcFor(ctx: string | undefined): number | undefined {
    if (!ctx) return undefined;
    const t = this.top(ctx);
    let n = this.bcNum.get(t);
    if (n === undefined) { n = this.bcNum.size + 1; this.bcNum.set(t, n); this.ctxOfBc.set(n, t); }
    return n;
  }

  /** Watch an agent tab: its console and network events, and keep its response bodies for network_body. */
  async watch(ctx: string): Promise<void> {
    if (this.watched.has(ctx) || this.dead) return;
    const w: { sub?: string; collector?: string } = {};
    this.watched.set(ctx, w);
    try {
      w.sub = (await this.bidi.send('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError'], contexts: [ctx] })).subscription;
    } catch { this.watched.delete(ctx); return; }
    try {
      w.collector = (await this.bidi.send('network.addDataCollector', { dataTypes: ['request', 'response'], maxEncodedDataSize: BODY_MAX, contexts: [ctx] })).collector;
    } catch {
      try { w.collector = (await this.bidi.send('network.addDataCollector', { dataTypes: ['response'], maxEncodedDataSize: BODY_MAX, contexts: [ctx] })).collector; } catch { /* bodies unavailable */ }
    }
  }

  /** A tab closed (or left Claude's window): drop its subscription and collector. */
  unwatch(ctx: string) {
    const w = this.watched.get(ctx);
    if (!w) return;
    this.watched.delete(ctx);
    if (w.sub) this.bidi.send('session.unsubscribe', { subscriptions: [w.sub] }).catch(() => {});
    if (w.collector) this.bidi.send('network.removeDataCollector', { collector: w.collector }).catch(() => {});
  }
  isWatched(ctx: string) { return this.watched.has(ctx); }
  watchedContexts() { return [...this.watched.keys()]; }

  onEvent({ method, params }: BidiEvent) {
    switch (method) {
      case 'browsingContext.contextCreated':
        if (params.parent) this.parentOf.set(params.context, params.parent);
        break;
      case 'browsingContext.contextDestroyed':
        this.parentOf.delete(params.context);
        this.unwatch(params.context);
        break;
      case 'log.entryAdded': return this.onLog(params);
      case 'network.beforeRequestSent': return this.onRequest(params);
      case 'network.responseCompleted': case 'network.fetchError': return this.onResponse(method, params);
    }
  }

  private onLog(p: any) {
    const frames: any[] = p.stackTrace?.callFrames ?? [];
    const f = frames[0];
    const isConsole = p.type === 'console';
    const text = String(p.text ?? '');
    this.log.push({
      seq: ++this.seq, ts: p.timestamp ?? Date.now(),
      kind: !isConsole && /^Uncaught \(in promise\)|^unhandled/i.test(text) ? 'rejection' : isConsole ? 'console' : 'error',
      level: isConsole ? (p.method === 'log' || p.method === 'info' ? p.method : p.level === 'warn' ? 'warn' : p.method ?? p.level ?? 'log') : (p.level ?? 'error'),
      text: text.slice(0, 4000), source: 'page', realm: 'page',
      url: f?.url, line: f ? f.lineNumber + 1 : undefined, col: f ? f.columnNumber + 1 : undefined,
      stack: frames.length > 1 || !isConsole ? frames.slice(0, 8).map((c) => `${c.functionName || '?'}@${c.url}:${c.lineNumber + 1}:${c.columnNumber + 1}`).join(' <- ') || undefined : undefined,
      bc: this.bcFor(p.source?.context),
    });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  private onRequest(p: any) {
    const id = p.request.request;
    let e = this.byRequest.get(id);
    if (e && p.redirectCount > 0) e = undefined; // a redirect is a new entry with the same request id
    const now = Date.now();
    if (!e) {
      e = {
        seq: ++this.netSeq, id: `r${this.netSeq}`, resourceId: 0, actor: id, ts: p.timestamp ?? now,
        method: p.request.method, url: p.request.url, cause: p.initiator?.type ?? p.request.destination ?? '?',
        isNavigation: !!p.navigation && (p.request.destination === 'document' || p.request.destination === ''),
        initiator: 'page', bc: this.bcFor(p.context), done: false, lastUpdate: now, ctx: p.context,
        reqHeaders: (p.request.headers ?? []).map(hval),
      };
      this.byRequest.set(id, e);
      this.net.push(e);
      if (this.net.length > MAX_NET) for (const x of this.net.splice(0, this.net.length - MAX_NET)) this.forget(x);
    }
  }

  private onResponse(method: string, p: any) {
    const e = this.byRequest.get(p.request.request);
    if (!e) return;
    e.lastUpdate = Date.now();
    e.done = true;
    if (method === 'network.fetchError') { e.blockedReason = p.errorText || 'failed'; return; }
    const r = p.response ?? {};
    e.status = String(r.status);
    e.statusText = r.statusText;
    e.mimeType = r.mimeType;
    e.contentSize = r.content?.size || r.bodySize || undefined;
    e.transferredSize = r.bytesReceived;
    e.fromCache = !!r.fromCache;
    const t = p.request.timings;
    if (t?.responseEnd && t?.requestTime) e.totalTime = Math.max(0, Math.round(t.responseEnd - t.requestTime));
    else e.totalTime = Math.max(0, Date.now() - e.ts);
    e.resHeaders = (r.headers ?? []).map(hval);
  }

  /** An entry leaves the ring: Firefox may let go of its collected body. */
  private forget(x: NetEntry) {
    this.byRequest.delete(x.actor);
    const ctx = (x as any).ctx as string | undefined;
    const w = ctx ? this.watched.get(this.top(ctx)) : undefined;
    if (w?.collector) for (const dataType of ['response', 'request']) this.bidi.send('network.disownData', { dataType, collector: w.collector, request: x.actor }).catch(() => {});
  }

  async responseBody(e: NetEntry, max: number): Promise<{ text: string; note: string }> {
    let r: any;
    try { r = await this.bidi.send('network.getData', { dataType: 'response', request: e.actor }); } catch (err: any) {
      return { text: '', note: `body unavailable (${err.message.replace(/^network\.getData: /, '')}); bodies are kept for Claude's tabs only, up to ${BODY_MAX / 1024} kB` };
    }
    const bytes = r.bytes ?? {};
    if (bytes.type === 'base64') {
      if (!/text|json|javascript|xml|html|css/.test(e.mimeType ?? '')) return { text: '', note: `binary body (${e.mimeType ?? '?'}, ${kb(Math.floor(String(bytes.value).length * 0.75))}), not shown` };
      const t = Buffer.from(bytes.value, 'base64').toString('utf8');
      return { text: t.slice(0, max + 1), note: `${e.mimeType ?? '?'}, ${kb(t.length)}${t.length > max ? `, showing first ${max} chars` : ''}` };
    }
    const text = String(bytes.value ?? '');
    return { text: text.slice(0, max + 1), note: `${e.mimeType ?? '?'}, ${kb(e.contentSize ?? text.length)}${text.length > max ? `, showing first ${max} chars` : ''}` };
  }

  async requestBody(e: NetEntry): Promise<string> {
    try {
      const r = await this.bidi.send('network.getData', { dataType: 'request', request: e.actor });
      const b = r.bytes ?? {};
      return b.type === 'base64' ? Buffer.from(b.value, 'base64').toString('utf8') : String(b.value ?? '');
    } catch { return ''; }
  }

  async headers(e: NetEntry): Promise<{ request: Header[]; response: Header[] }> {
    const x = this.byRequest.get(e.actor) ?? (e as any);
    return { request: x.reqHeaders ?? [], response: x.resHeaders ?? [] };
  }

  close() { this.dead = true; }
}
