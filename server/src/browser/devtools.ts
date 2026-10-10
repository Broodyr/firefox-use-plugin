// The devtools hub: one persistent RDP connection with a parent-process watcher (the Browser Toolbox setup).
// Watching every target type (process, frame, worker, content_script) gives ONE stream of console messages
// and errors from pages, content scripts, extension background pages, workers and browser chrome,
// and of network events including extension-made requests, with headers and bodies.
// Its targets are also the realms for evaluation in content scripts and extension pages.
import { Rdp } from '../transports/rdp.js';
import { ToolError } from '../errors.js';

export type Source = 'page' | 'content' | 'extension' | 'worker' | 'browser';

export interface TargetInfo {
  actor: string;
  type: 'frame' | 'content_script' | 'worker' | 'process' | 'service_worker' | 'shared_worker';
  url?: string;
  title?: string;
  addonId?: string | null;
  /** browsing context of the frame (top-level tab BC for top frames) */
  bc?: number;
  innerWindowId?: number;
  topInnerWindowId?: number;
  consoleActor?: string;
  threadActor?: string;
  /** releases console/eval object grips (memory bounds) */
  objectsManager?: string;
  processId?: number;
  remoteType?: string;
  alive: boolean;
}

export interface LogEntry {
  seq: number;
  ts: number;
  kind: 'console' | 'error' | 'rejection';
  level: string;
  text: string;
  source: Source;
  /** realm label: "page", "content:<addon>", "extension:<addon>", "worker:<url>", "browser" */
  realm: string;
  addonId?: string;
  url?: string;
  line?: number;
  col?: number;
  stack?: string;
  category?: string;
  innerWindowId?: number;
  /** top-level browsing context id (-> tab handle at read time) */
  bc?: number;
}

export interface NetEntry {
  seq: number;
  id: string;
  resourceId: number;
  actor: string;
  ts: number;
  method: string;
  url: string;
  cause: string;
  isNavigation: boolean;
  /** "page" | "extension:<id>" | "browser" */
  initiator: string;
  initiatorDoc?: string;
  bc?: number;
  innerWindowId?: number;
  status?: string;
  statusText?: string;
  mimeType?: string;
  contentSize?: number;
  transferredSize?: number;
  totalTime?: number;
  blockedReason?: number | string;
  fromCache?: boolean;
  done: boolean;
  remoteAddress?: string;
  /** last time an update arrived (network idle detection) */
  lastUpdate: number;
}

export interface Header { name: string; value: string }

/**
 * What console/network/wait tools read: the devtools hub (claude-dev), or BidiHub (personal mode),
 * which builds the same entries from BiDi log and network events.
 */
export interface Hub {
  readonly log: LogEntry[];
  readonly net: NetEntry[];
  readonly cursor: number;
  readonly netCursor: number;
  readonly dead: boolean;
  readonly extNameById: Map<string, string>;
  realmLabel(e: LogEntry): string;
  netById(id: string): NetEntry | undefined;
  responseBody(e: NetEntry, max: number): Promise<{ text: string; note: string }>;
  requestBody(e: NetEntry): Promise<string>;
  headers(e: NetEntry): Promise<{ request: Header[]; response: Header[] }>;
}

export const kb = (n?: number) => (n === undefined ? '?' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}kB` : `${(n / 1048576).toFixed(1)}MB`);

export const MAX_LOG = 3000;
export const MAX_NET = Number(process.env.FIREFOX_USE_NET_RING) || 1500;
/** Response bodies the devtools server keeps per request (Firefox's default is 1 MB); set on the default branch only. */
export const BODY_LIMIT = 256 * 1024;

export class Devtools implements Hub {
  rdp: Rdp;
  watcher = '';
  readonly targets = new Map<string, TargetInfo>();
  readonly log: LogEntry[] = [];
  readonly net: NetEntry[] = [];
  private netByRes = new Map<number, NetEntry>();
  private seq = 0;
  private netSeq = 0;
  /** moz-extension host (uuid) -> {id, name}; refreshed through the resolver when an unknown uuid shows up */
  readonly extByUuid = new Map<string, { id: string; name: string }>();
  readonly extNameById = new Map<string, string>();
  /** listeners for waits */
  private waiters = new Set<() => void>();
  dead = false;
  /** memory bounds: object grips waiting to be released, per objects-manager actor; counters for ff_status */
  private gripQueue = new Map<string, string[]>();
  private gripTimer: NodeJS.Timeout | null = null;
  readonly stats = { gripsReleased: 0, netReleased: 0, releaseErrors: 0 };

  constructor(public port: number, private refreshExtensions: () => Promise<{ uuid: string; id: string; name: string }[]>) {
    this.rdp = new Rdp(port);
  }

  async start(): Promise<void> {
    await this.rdp.connect();
    this.rdp.onClose = () => { this.dead = true; this.notify(); };
    this.rdp.on((p) => this.onPacket(p));
    await this.updateExtensions();
    const proc = await this.rdp.request('root', 'getProcess', { id: 0 });
    const w = await this.rdp.request(proc.processDescriptor.actor, 'getWatcher', { isServerTargetSwitchingEnabled: true });
    this.watcher = w.actor;
    for (const t of ['process', 'frame', 'worker', 'content_script']) {
      await this.rdp.request(this.watcher, 'watchTargets', { targetType: t }, 20000);
    }
    await this.rdp.request(this.watcher, 'watchResources', { resourceTypes: ['console-message', 'error-message', 'network-event'] }, 20000);
  }

  close() { this.dead = true; if (this.gripTimer) clearTimeout(this.gripTimer); this.rdp.close(); }

  /**
   * Console arguments and exceptions arrive as object grips the devtools server keeps alive until released. We format
   * them on arrival and never need them again, so release them in batches (the toolbox does the same on clear).
   */
  private releaseGrips(target: TargetInfo | undefined, resource: unknown) {
    const om = target?.objectsManager;
    if (!om) return;
    const ids: string[] = [];
    const walk = (x: any, depth: number) => {
      if (!x || typeof x !== 'object' || depth > 6) return;
      if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
      if ((x.type === 'object' || x.type === 'longString') && typeof x.actor === 'string') ids.push(x.actor);
      for (const k of Object.keys(x)) if (k !== 'actor') walk(x[k], depth + 1);
    };
    walk(resource, 0);
    if (!ids.length) return;
    const q = this.gripQueue.get(om) ?? [];
    q.push(...ids);
    this.gripQueue.set(om, q);
    if (!this.gripTimer) this.gripTimer = setTimeout(() => this.flushGrips(), 200);
  }

  private flushGrips() {
    this.gripTimer = null;
    const alive = new Set([...this.targets.values()].filter((t) => t.alive && t.objectsManager).map((t) => t.objectsManager));
    for (const [om, ids] of this.gripQueue) {
      this.gripQueue.delete(om);
      if (!alive.has(om)) continue; // the target is gone, and its objects with it
      this.rdp.request(om, 'releaseObjects', { actorIDs: ids }, 10000).then(() => { this.stats.gripsReleased += ids.length; }, () => { this.stats.releaseErrors++; });
    }
  }

  /** A network event actor holds headers and the response body; release it once our ring no longer lists it. */
  private releaseNet(e: NetEntry) {
    if (!e.actor || this.dead) return;
    this.rdp.request(e.actor, 'release', {}, 10000).then(() => { this.stats.netReleased++; }, () => { this.stats.releaseErrors++; });
  }

  async updateExtensions() {
    try {
      for (const e of await this.refreshExtensions()) { this.extByUuid.set(e.uuid, { id: e.id, name: e.name }); this.extNameById.set(e.id, e.name); }
    } catch { /* best effort */ }
  }

  addonForUrl(url?: string): string | undefined {
    const m = url && /^moz-extension:\/\/([^/]+)/.exec(url);
    if (!m) return undefined;
    const e = this.extByUuid.get(m[1]);
    if (!e) { void this.updateExtensions(); return undefined; }
    return e.id;
  }

  /** Wake waits whenever anything arrives. */
  onChange(f: () => void): () => void { this.waiters.add(f); return () => this.waiters.delete(f); }
  notify() { for (const f of [...this.waiters]) { try { f(); } catch { /* ignore */ } } }

  // ------------------------------------------------------------ ingestion
  private onPacket(p: any) {
    switch (p.type) {
      case 'target-available-form': this.addTarget(p.target); break;
      case 'target-destroyed-form': { const t = this.targets.get(p.target?.actor); if (t) t.alive = false; this.pruneTargets(); break; }
      case 'resources-available-array':
        for (const [type, arr] of p.array ?? []) for (const r of arr) this.onResource(type, r, p.from);
        this.notify();
        break;
      case 'resources-updated-array':
        for (const [type, arr] of p.array ?? []) for (const r of arr) if (type === 'network-event') this.onNetUpdate(r);
        this.notify();
        break;
    }
  }

  private addTarget(f: any) {
    this.targets.set(f.actor, {
      actor: f.actor, type: f.targetType, url: f.url, title: f.title, addonId: f.addonId ?? null,
      bc: f.browsingContextID, innerWindowId: f.innerWindowId, topInnerWindowId: f.topInnerWindowId,
      consoleActor: f.consoleActor, threadActor: f.threadActor, objectsManager: f.objectsManagerActor, processId: f.processID, remoteType: f.remoteType, alive: true,
    });
  }

  /** Keep the newest 200 destroyed targets (late messages from a just-closed document still get attributed). */
  private pruneTargets() {
    let dead = 0;
    for (const t of this.targets.values()) if (!t.alive) dead++;
    if (dead <= 300) return;
    for (const [k, t] of this.targets) { if (!t.alive) { this.targets.delete(k); if (--dead <= 200) break; } }
  }

  get liveTargets() { let n = 0; for (const t of this.targets.values()) if (t.alive) n++; return n; }

  /** The tab-level browsing context for a window: top frame target's BC. */
  topBcForWindow(innerWindowId?: number): number | undefined {
    if (!innerWindowId) return undefined;
    let t: TargetInfo | undefined;
    for (const x of this.targets.values()) if (x.type === 'frame' && x.innerWindowId === innerWindowId) { t = x; break; }
    if (!t) return undefined;
    if (t.topInnerWindowId && t.topInnerWindowId !== t.innerWindowId) {
      for (const x of this.targets.values()) if (x.type === 'frame' && x.innerWindowId === t.topInnerWindowId) return x.bc;
    }
    return t.bc;
  }

  classify(target: TargetInfo | undefined, url: string | undefined): { source: Source; realm: string; addonId?: string } {
    if (target?.type === 'content_script') {
      const id = target.addonId ?? this.addonForUrl(url);
      return { source: 'content', realm: `content:${target.title ?? id}`, addonId: id ?? undefined };
    }
    if (target?.type === 'worker' || target?.type === 'service_worker' || target?.type === 'shared_worker') {
      const id = this.addonForUrl(target.url);
      return { source: id ? 'extension' : 'worker', realm: `worker:${target.url ?? '?'}`, addonId: id };
    }
    // fast-mode userscripts (companion userScripts API) are named by their //# sourceURL
    const fast = url && /^claude-fast\/([^/]+)\.user\.js$/.exec(url);
    if (fast) return { source: 'content', realm: `userscript:${fast[1]} (fast)`, addonId: 'companion@firefox-use' };
    if (target?.type === 'frame') {
      const id = target.addonId ?? this.addonForUrl(target.url);
      if (id) return { source: 'extension', realm: `extension:${this.extNameById.get(id) ?? id}`, addonId: id };
      // a content script's console call / error is reported through the page's window target
      const cs = this.addonForUrl(url);
      if (cs) return { source: 'content', realm: `content:${this.extNameById.get(cs) ?? cs}`, addonId: cs };
      return { source: 'page', realm: 'page' };
    }
    // process targets (parent = Browser Console) and unknown
    const id = this.addonForUrl(url);
    if (id) return { source: 'extension', realm: `extension:${this.extNameById.get(id) ?? id}`, addonId: id };
    return { source: 'browser', realm: target?.remoteType ? `process:${target.remoteType}` : 'browser' };
  }

  private onResource(type: string, r: any, from: string) {
    if (type === 'network-event') return this.onNetEvent(r);
    const target = this.targets.get(from) ?? [...this.targets.values()].find((t) => from.startsWith(t.actor));
    if (type === 'console-message') {
      const m = r.message ?? r;
      const text = (m.arguments ?? []).map(gripText).join(' ');
      const c = this.classify(target, m.filename);
      this.push({
        kind: 'console', ts: m.timeStamp ?? Date.now(), level: m.level ?? 'log', text, ...c,
        url: m.filename, line: m.lineNumber, col: m.columnNumber, stack: stackText(m.stacktrace),
        innerWindowId: m.innerWindowID, bc: this.bcFor(target, m.innerWindowID),
      });
    } else if (type === 'error-message') {
      const e = r.pageError ?? r;
      const c = this.classify(target, e.sourceName);
      this.push({
        kind: e.isPromiseRejection ? 'rejection' : 'error', ts: e.timeStamp ?? Date.now(),
        level: e.warning ? 'warn' : e.info ? 'info' : 'error',
        text: (e.isPromiseRejection && !/^Uncaught/.test(e.errorMessage ?? '') ? 'Uncaught (in promise) ' : '') + (typeof e.errorMessage === 'object' ? gripText(e.errorMessage) : String(e.errorMessage ?? '')),
        ...c, url: e.sourceName, line: e.lineNumber, col: e.columnNumber, stack: stackText(e.stacktrace), category: e.category,
        innerWindowId: e.innerWindowID, bc: this.bcFor(target, e.innerWindowID),
      });
    }
    // formatted: the server-side object grips are no longer needed
    if (type === 'console-message' || type === 'error-message') this.releaseGrips(target, r);
  }

  private bcFor(target: TargetInfo | undefined, innerWindowId?: number): number | undefined {
    if (target?.type === 'frame') return this.topBcForWindow(target.innerWindowId) ?? target.bc;
    return this.topBcForWindow(innerWindowId ?? target?.innerWindowId);
  }

  private push(e: Omit<LogEntry, 'seq'>) {
    this.log.push({ ...e, text: e.text.slice(0, 4000), seq: ++this.seq });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  get cursor() { return this.seq; }
  get netCursor() { return this.netSeq; }

  private onNetEvent(r: any) {
    const doc: string | undefined = r.cause?.loadingDocumentUri ?? undefined;
    let initiator = 'page';
    let id = this.addonForUrl(doc);
    if (!id && r.innerWindowId) {
      // extension documents (background pages) may load through data:/about: documents; use the window's target
      for (const t of this.targets.values()) if (t.type === 'frame' && t.innerWindowId === r.innerWindowId) { id = t.addonId ?? this.addonForUrl(t.url) ?? undefined; break; }
    }
    if (id) initiator = `extension:${id}`;
    else if (r.chromeContext) initiator = 'browser';
    else if (!doc && !r.innerWindowId) initiator = 'browser';
    const e: NetEntry = {
      seq: ++this.netSeq, id: `r${this.netSeq}`, resourceId: r.resourceId, actor: r.actor, ts: r.timeStamp ?? Date.now(),
      method: r.method, url: r.url, cause: r.cause?.type ?? '?', isNavigation: !!r.isNavigationRequest,
      initiator, initiatorDoc: doc, innerWindowId: r.innerWindowId, bc: initiator === 'page' ? this.topBcForWindow(r.innerWindowId) : undefined,
      done: false, blockedReason: r.blockedReason || undefined, lastUpdate: Date.now(),
    };
    this.net.push(e);
    this.netByRes.set(r.resourceId, e);
    if (this.net.length > MAX_NET) for (const x of this.net.splice(0, this.net.length - MAX_NET)) { this.netByRes.delete(x.resourceId); this.releaseNet(x); }
  }

  private onNetUpdate(r: any) {
    const e = this.netByRes.get(r.resourceId);
    if (!e) return;
    const u = r.resourceUpdates ?? {};
    e.lastUpdate = Date.now();
    if (u.status !== undefined) e.status = u.status;
    if (u.statusText !== undefined) e.statusText = u.statusText;
    if (u.mimeType) e.mimeType = u.mimeType;
    if (u.contentSize !== undefined) e.contentSize = u.contentSize;
    if (u.transferredSize !== undefined) e.transferredSize = u.transferredSize;
    if (u.totalTime !== undefined) e.totalTime = u.totalTime;
    if (u.remoteAddress) e.remoteAddress = u.remoteAddress;
    if (u.fromCache !== undefined) e.fromCache = u.fromCache;
    if (u.blockedReason) e.blockedReason = u.blockedReason;
    if (u.responseEndAvailable || u.responseContentCompleteAvailable || u.blockedReason) e.done = true;
    if (e.bc === undefined && e.initiator === 'page') e.bc = this.topBcForWindow(e.innerWindowId);
  }

  /** Realm label with the extension's current name (it may have been unknown when the entry arrived). */
  realmLabel(e: LogEntry): string {
    if (!e.addonId) return e.realm;
    const name = this.extNameById.get(e.addonId);
    return name ? e.realm.replace(e.addonId, name) : e.realm;
  }

  netById(id: string): NetEntry | undefined {
    return this.net.find((e) => e.id === id);
  }

  async responseBody(e: NetEntry, max: number): Promise<{ text: string; note: string }> {
    let r: any;
    try { r = await this.rdp.request(e.actor, 'getResponseContent'); } catch (err: any) {
      return { text: '', note: `body unavailable (${err.message}); the entry may have been released` };
    }
    const c = r.content ?? {};
    if (r.contentDiscarded) return { text: '', note: 'body was discarded (too large or not kept)' };
    if (c.encoding === 'base64') return { text: '', note: `binary body (${c.mimeType}, ${kb(c.size)}), not shown` };
    const text = await this.longString(c.text, max + 1);
    return { text, note: `${c.mimeType ?? '?'}, ${kb(c.size ?? text.length)}${text.length > max ? `, showing first ${max} chars` : ''}` };
  }

  /** The whole response body as the devtools server kept it (text, or base64 for binary), for HAR files. */
  async responseContentRaw(e: NetEntry): Promise<{ text?: string; encoding?: string; mimeType?: string; size?: number; note?: string }> {
    const r = await this.rdp.request(e.actor, 'getResponseContent');
    const c = r.content ?? {};
    if (r.contentDiscarded) return { mimeType: c.mimeType, note: 'body was discarded (over the 256 kB devtools limit, or not kept)' };
    if (c.text === undefined) return { mimeType: c.mimeType, note: 'no body' };
    return { text: await this.longString(c.text, 50_000_000), encoding: c.encoding === 'base64' ? 'base64' : undefined, mimeType: c.mimeType, size: c.size };
  }

  async requestBody(e: NetEntry): Promise<string> {
    const r = await this.rdp.request(e.actor, 'getRequestPostData');
    return this.longString(r.postData?.text);
  }

  async headers(e: NetEntry): Promise<{ request: Header[]; response: Header[] }> {
    const [req, res] = await Promise.all([
      this.rdp.request(e.actor, 'getRequestHeaders').catch(() => ({ headers: [] })),
      this.rdp.request(e.actor, 'getResponseHeaders').catch(() => ({ headers: [] })),
    ]);
    return { request: req.headers, response: res.headers };
  }

  // ------------------------------------------------------------ requests on targets
  /** Fetch a longString grip's full text. */
  async longString(g: any, max = 2_000_000): Promise<string> {
    if (!g || typeof g !== 'object' || g.type !== 'longString') return typeof g === 'string' ? g : gripText(g);
    const r = await this.rdp.request(g.actor, 'substring', { start: 0, end: Math.min(g.length, max) });
    return r.substring + (g.length > max ? '…' : '');
  }

  /**
   * Evaluate in a target's console (content script sandbox, extension page, worker), with top-level await.
   * The code must evaluate to a string (callers wrap it with a serializer).
   */
  async evaluate(consoleActor: string, text: string, timeoutMs = 30000): Promise<{ result?: any; exception?: string; stack?: string }> {
    return rdpEvaluate(this.rdp, consoleActor, text, timeoutMs);
  }
}

/** Evaluate in a console actor with top-level await (`frameActor`: inside a paused frame, no await). */
export async function rdpEvaluate(rdp: Rdp, consoleActor: string, text: string, timeoutMs = 30000, extra: Record<string, unknown> = {}): Promise<{ result?: any; exception?: string; stack?: string }> {
  const res = new Promise<any>((resolve, reject) => {
    let resultID: string | undefined;
    const early: any[] = [];
    const timer = setTimeout(() => { off(); reject(new ToolError('EVAL_TIMEOUT', `evaluation did not finish within ${timeoutMs} ms`, 'Long-running or never-resolving promise? Narrow the code.')); }, timeoutMs);
    const off = rdp.on((p) => {
      if (p.type !== 'evaluationResult' || p.from !== consoleActor) return;
      if (resultID === undefined) { early.push(p); return; }
      if (p.resultID !== resultID) return;
      clearTimeout(timer); off(); resolve(p);
    });
    rdp.request(consoleActor, 'evaluateJSAsync', { text, mapped: { await: !extra.frameActor }, ...extra }, timeoutMs).then((r) => {
      resultID = r.resultID;
      const hit = early.find((p) => p.resultID === resultID);
      if (hit) { clearTimeout(timer); off(); resolve(hit); }
    }, (e) => { clearTimeout(timer); off(); reject(e); });
  });
  const p = await res;
  if (p.exception !== undefined && p.exception !== null) {
    const msg = typeof p.exceptionMessage === 'string' ? p.exceptionMessage : gripText(p.exceptionMessage ?? p.exception);
    return { exception: msg, stack: p.exceptionStack ? stackText(p.exceptionStack) : undefined };
  }
  return { result: p.result };
}

// ------------------------------------------------------------ grip formatting
export function gripText(g: any, depth = 0): string {
  if (g === null) return 'null';
  if (typeof g !== 'object') return String(g);
  switch (g.type) {
    case 'undefined': return 'undefined';
    case 'null': return 'null';
    case 'NaN': return 'NaN';
    case 'Infinity': return 'Infinity';
    case '-Infinity': return '-Infinity';
    case '-0': return '-0';
    case 'longString': return `${g.initial}… (${g.length} chars)`;
    case 'symbol': return `Symbol(${g.name ?? ''})`;
    case 'BigInt': return `${g.text}n`;
    case 'object': return objectText(g, depth);
    default: return `[${g.type}]`;
  }
}

function objectText(g: any, depth: number): string {
  const p = g.preview ?? {};
  const cls = g.class ?? 'Object';
  if (depth > 2) return `[${cls}]`;
  if (p.kind === 'Error' || /Error$/.test(cls)) return `${p.name ?? cls}: ${p.message ?? ''}`;
  if (cls === 'Function') return `function ${g.displayName ?? g.name ?? ''}()`;
  if (p.kind === 'DOMNode') return `<${(p.nodeName ?? 'node').toLowerCase()}${p.attributes?.id ? `#${p.attributes.id}` : ''}${p.attributes?.class ? `.${String(p.attributes.class).split(/\s+/).join('.')}` : ''}>`;
  if (p.kind === 'ArrayLike' && Array.isArray(p.items)) return `[${p.items.map((x: any) => gripText(x, depth + 1)).join(', ')}${p.length > p.items.length ? ', …' : ''}]`;
  if (p.kind === 'MapLike' && Array.isArray(p.entries)) return `${cls}{${p.entries.map(([k, v]: any) => `${gripText(k, depth + 1)} => ${gripText(v, depth + 1)}`).join(', ')}}`;
  if (p.ownProperties) {
    const parts = Object.entries(p.ownProperties).map(([k, d]: any) => `${k}: ${d && 'value' in d ? gripText(d.value, depth + 1) : '[getter]'}`);
    const more = (p.ownPropertiesLength ?? parts.length) > parts.length ? ', …' : '';
    return `${cls === 'Object' ? '' : cls + ' '}{${parts.join(', ')}${more}}`;
  }
  if (p.url) return `${cls} ${p.url}`;
  return `[${cls}]`;
}

export function stackText(st: any): string | undefined {
  if (!Array.isArray(st) || !st.length) return undefined;
  return st.slice(0, 8).map((f: any) => `${f.functionName || '?'}@${f.filename ?? f.sourceURL ?? '?'}:${f.lineNumber ?? f.line ?? '?'}:${f.columnNumber ?? f.column ?? '?'}`).join(' <- ');
}
