// Live view (SPEC §6.23): a page on 127.0.0.1 that shows a session's current agent tab as a stream of captures,
// with the tool calls as they run, where Claude clicked and which tabs its group has. View-only, with one control
// (Take over, a handoff) and the window's display switch (Show window / Run in background).
//
// One HTTP server per backend (the one that owns the Firefox), one view per Claude session (routed sessions get their
// own). Frames are captured only while a viewer is connected, kept in memory (latest only), and go to the user's
// eyes only: never to disk, the audit log or a tool result. Port and tokens persist per proxy (run/live-<pid>.json),
// so a backend hot reload serves the same URLs and the page reconnects by itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ensureDir, loadConfig } from '../config.js';
import { auditAppend, newAuditId } from '../audit/audit.js';
import { maskText } from '../safety/mask.js';
import { clientWorkspace, currentClient, runAsClient, runAsClientSync } from '../browser/client.js';
import { isAlive, ownerPid } from '../browser/launcher.js';
import type { Browser } from '../browser/session.js';
import { livePage } from './page.js';

/** What the live view needs from the backend (index.ts). */
export interface LiveHost {
  /** the attached Browser, if any (never launches) */
  current(): Browser | null;
  /** attach to the Firefox this session owns and is running (after a hot reload); never launches */
  attach(): Promise<Browser | null>;
  /** URL of a login handoff in progress (the profile is open as an ordinary Firefox), else null */
  login(): string | null;
}

interface TabRow { tab: number; title: string; url: string; current: boolean }
interface Check { url: string; title: string; sx: number; sy: number; n: number; w: number; h: number }

/** Pages Firefox won't capture (privileged scope): the view shows their title and URL instead. */
const PRIVILEGED = /^(moz-extension|chrome|resource|view-source|jar):|^about:(?!blank|srcdoc)/i;

/**
 * Cheap change check before an idle capture (in this server's sandbox, invisible to the page): URL, scroll position,
 * DOM mutation count (an observer installed on first use), viewport size, title.
 */
const CHECK = `() => {
  const g = globalThis;
  if (!g.__liveObs) {
    g.__liveN = 0;
    try { g.__liveObs = new MutationObserver((l) => { g.__liveN += l.length; }); g.__liveObs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); } catch { g.__liveN = -1; }
  }
  return { url: location.href, title: document.title, sx: Math.round(scrollX), sy: Math.round(scrollY), n: g.__liveN < 0 ? Date.now() : g.__liveN, w: innerWidth, h: innerHeight };
}`;

class View {
  readonly viewers = new Set<http.ServerResponse>();
  frame: { seq: number; buf: Buffer; type: string; ctx: string } | null = null;
  seq = 0;
  readonly stats = { captures: 0, failed: 0, skipped: 0, ms: 0, maxMs: 0, lastMs: 0 };
  capturing = false;
  /** a capture took longer than 2 s: 1 per 5 s until one is quick again */
  slow = false;
  stale = false;
  /** write tool calls in flight (call id -> tool) */
  readonly inflight = new Map<number, string>();
  lastChange = Date.now();
  last: (Check & { ctx: string }) | null = null;
  /** the tab picked in the page's tab strip; null = follow Claude's current tab */
  viewTab: number | null = null;
  readonly captions: Record<string, unknown>[] = [];
  tabs: TabRow[] = [];
  tabsJson = '';
  tabsAt = 0;
  stateJson = '';
  placeholder = '';
  timer: NodeJS.Timeout | null = null;
  due = 0;
  /** said once in Claude's next tool result (the user took over here) */
  note: string | null = null;
  closed = false;
  constructor(readonly client: string, readonly token: string, readonly ws: string | undefined) {}
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

class LiveServer {
  private srv: http.Server | null = null;
  private starting: Promise<void> | null = null;
  port = 0;
  readonly views = new Map<string, View>();
  host: LiveHost | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  private get file() { return path.join(loadConfig().runDir, `live-${ownerPid()}.json`); }
  private cfg() {
    const c = loadConfig().liveView ?? {};
    const fps = Number(process.env.FIREFOX_USE_LIVE_FPS ?? c.activeFps ?? 10);
    return { format: c.format === 'png' ? 'image/png' : 'image/jpeg', quality: Math.min(1, Math.max(0.1, c.quality ?? 0.6)), fps: Math.min(30, Math.max(1, fps)) };
  }

  url(v: View) { return `http://127.0.0.1:${this.port}/live/${v.token}/`; }

  /** Listen on the given port (a hot reload: the old backend may still hold it for a moment), else a free one. */
  async start(want = 0): Promise<void> {
    if (this.srv) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const listen = (p: number) => new Promise<http.Server>((res, rej) => {
        const s = http.createServer((q, r) => { void this.handle(q, r).catch(() => { try { r.writeHead(500); r.end(); } catch { /* gone */ } }); });
        s.once('error', rej);
        s.listen(p, '127.0.0.1', () => { s.off('error', rej); res(s); });
      });
      let srv: http.Server | null = null;
      for (const t0 = Date.now(); want && !srv && Date.now() - t0 < 40000;) {
        try { srv = await listen(want); } catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      srv ??= await listen(0);
      srv.unref();
      this.srv = srv;
      this.port = (srv.address() as any).port;
      this.heartbeat = setInterval(() => { for (const v of this.views.values()) for (const r of v.viewers) r.write(': ping\n\n'); }, 15000);
      this.heartbeat.unref();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  private persist() {
    try {
      if (!this.views.size) { fs.rmSync(this.file, { force: true }); return; }
      ensureDir(path.dirname(this.file));
      fs.writeFileSync(this.file, JSON.stringify({ port: this.port, views: [...this.views.values()].map((v) => ({ client: v.client, token: v.token, ws: v.ws })) }));
    } catch { /* best effort */ }
  }

  /** After a hot reload: the views this session had, on the same port and tokens. */
  async restore(): Promise<void> {
    const dir = loadConfig().runDir;
    // views of sessions that are gone
    try { for (const f of fs.readdirSync(dir)) { const m = /^live-(\d+)\.json$/.exec(f); if (m && Number(m[1]) !== ownerPid() && !isAlive(Number(m[1]))) fs.rmSync(path.join(dir, f), { force: true }); } } catch { /* no run dir */ }
    let saved: { port: number; views: { client: string; token: string; ws?: string }[] } | null = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return; }
    if (!saved?.views?.length) return;
    for (const s of saved.views) this.views.set(s.client, new View(s.client, s.token, s.ws));
    await this.start(saved.port);
    if (this.port !== saved.port) this.persist();
  }

  async open(client = currentClient()): Promise<View> {
    await this.start();
    let v = this.views.get(client);
    if (!v) {
      v = new View(client, crypto.randomBytes(16).toString('hex'), clientWorkspace());
      this.views.set(client, v);
      this.persist();
    }
    return v;
  }

  /** End a view: its page shows "stopped" and its URL stops working. */
  close(client: string, note = 'the live view was closed') {
    const v = this.views.get(client);
    if (!v) return false;
    v.closed = true;
    if (v.timer) clearTimeout(v.timer);
    this.send(v, 'state', { state: 'stopped', note });
    for (const r of v.viewers) { try { r.end(); } catch { /* gone */ } }
    v.viewers.clear();
    this.views.delete(client);
    this.persist();
    return true;
  }

  closeAll(note: string) { for (const c of [...this.views.keys()]) this.close(c, note); this.stop(); }

  /** Backend reload: drop the connections (the pages reconnect to the next backend), keep the run file. */
  detach() { for (const v of this.views.values()) { if (v.timer) clearTimeout(v.timer); for (const r of v.viewers) { try { r.destroy(); } catch { /* gone */ } } } this.stop(); }

  private stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.srv?.close();
    this.srv = null;
  }

  // ------------------------------------------------------------ HTTP
  private byToken(tok: string): View | null {
    const want = sha(tok);
    let found: View | null = null;
    for (const v of this.views.values()) if (crypto.timingSafeEqual(sha(v.token), want)) found = v;
    return found;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const notFound = () => { res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('not found'); };
    // DNS rebinding: only our own host names
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return notFound();
    const u = new URL(req.url ?? '/', 'http://x');
    const m = /^\/live\/([0-9a-f]{32})(\/(events|frame|takeover|window|view)?)?$/.exec(u.pathname);
    const v = m ? this.byToken(m[1]) : null;
    if (!m || !v || v.closed) return notFound();
    const what = m[3] ?? '';
    const base = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (!what) {
      if (req.method !== 'GET') return notFound();
      if (!m[2]) { res.writeHead(302, { ...base, location: `/live/${v.token}/` }); res.end(); return; }
      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, {
        ...base, 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      });
      res.end(livePage(nonce));
      return;
    }
    // the stream, the frames and the controls only for the page itself: another site can't read or drive them
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return notFound();
    if (what === 'events' && req.method === 'GET') return this.events(v, req, res, base);
    if (what === 'frame' && req.method === 'GET') {
      const f = v.frame;
      if (!f) { res.writeHead(204, base); res.end(); return; }
      res.writeHead(200, { ...base, 'content-type': f.type, 'x-frame-seq': String(f.seq) });
      res.end(f.buf);
      return;
    }
    // controls: a header a cross-origin page can't send without a CORS preflight, which this server never answers
    if (req.method !== 'POST' || req.headers['x-live-view'] !== '1') return notFound();
    const body = await readBody(req).catch(() => null);
    if (body === null) return notFound();
    let r: { status: number; json: unknown };
    try {
      r = what === 'takeover' ? await this.takeover(v)
        : what === 'window' ? await this.window(v, body.action)
          : await this.viewTab(v, body.tab);
    } catch (e: any) { r = { status: 409, json: { error: String(e?.message ?? e) } }; }
    res.writeHead(r.status, { ...base, 'content-type': 'application/json' });
    res.end(JSON.stringify(r.json));
  }

  private events(v: View, req: http.IncomingMessage, res: http.ServerResponse, base: Record<string, string>) {
    res.writeHead(200, { ...base, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    v.viewers.add(res);
    req.on('close', () => { v.viewers.delete(res); });
    const one = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    one('hello', { label: this.label(v), routed: !!v.client });
    v.stateJson = '';
    this.emitState(v);
    if (v.tabsJson) one('tabs', { tabs: v.tabs, viewing: v.viewTab });
    for (const c of v.captions.slice(-12)) one('tool', c);
    if (v.frame) one('frame', this.frameMeta(v));
    v.tabsAt = 0;
    void this.ensureBrowser().then(() => this.kick(v));
  }

  /** a viewer of a view restored after a hot reload: attach to this session's Firefox (never launches) */
  private async ensureBrowser(): Promise<Browser | null> {
    const b = this.host?.current();
    if (b && !b.dead) return b;
    return (await this.host?.attach().catch(() => null)) ?? null;
  }

  private send(v: View, type: string, data: unknown) {
    if (!v.viewers.size) return;
    const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of v.viewers) { try { r.write(s); } catch { /* gone */ } }
  }

  // ------------------------------------------------------------ state
  private label(v: View): string {
    const b = this.host?.current();
    if (b && !b.dead) { try { return withClient(v.client, () => b.groupLabel); } catch { /* below */ } }
    return v.client ? 'Claude (another session)' : 'Claude';
  }

  /** What the controls can do now, with the reason when they can't. */
  private controls(v: View, b: Browser | null): { takeover: string | null; window: string | null; windowMode: string | null } {
    const login = this.host?.login();
    const headless = b?.state.headless;
    const h = b && !b.dead ? withClient(v.client, () => b.handoff) : null;
    let takeover: string | null = null, window: string | null = null;
    if (v.client) {
      takeover = 'this session drives a Firefox another Claude session owns: ask Claude in chat to hand it over (ff_handoff)';
      window = 'only the Claude session that owns this Firefox can show or park its window';
    } else if (login) takeover = window = 'a login handoff is running: the profile is open as an ordinary Firefox window';
    else if (!b || b.dead) takeover = window = 'Firefox is not running for this session';
    else if (h) { takeover = 'you have the browser'; window = 'you have the browser: tell Claude when you are done'; }
    else if (headless) {
      window = 'this Firefox is headless: there is no window to show';
      // tests: Take over in a headless session (no window is shown)
      takeover = process.env.FIREFOX_USE_TEST_TAKEOVER ? null : window;
    }
    const mode = b && !b.dead && !headless ? withClient(v.client, () => b.agentWindowMode()) : null;
    return { takeover, window, windowMode: mode === 'none' ? null : mode };
  }

  private emitState(v: View) {
    if (v.closed) return;
    const b = this.host?.current() ?? null;
    const live = b && !b.dead ? b : null;
    const login = this.host?.login();
    const h = live ? withClient(v.client, () => live.handoff) : null;
    if (!h && v.note) v.note = null;
    let state: string, note: string;
    if (login) { state = 'login'; note = `logging in in a normal Firefox window (${maskText(login)})`; }
    else if (h) { state = 'handed-off'; note = h.by === 'live view' ? 'you have the browser: tell Claude when you\'re done' : `you have the browser (${maskText(h.reason)}): tell Claude when you're done`; }
    else if (!live) { state = 'idle'; note = 'Firefox is not running for this session; the view resumes with Claude\'s next browser tool'; }
    else if (v.inflight.size) { state = 'running'; note = [...v.inflight.values()].pop()!; }
    else { state = 'idle'; note = ''; }
    const dialog = live ? [...live.dialogs.open.values()].find((e) => e.client === v.client) : undefined;
    const s = {
      state, note, label: this.label(v), stale: v.stale,
      dialog: dialog ? `${dialog.type} "${maskText(dialog.message).slice(0, 120)}" is open: the page waits for it` : null,
      controls: this.controls(v, live),
    };
    const j = JSON.stringify(s);
    if (j === v.stateJson) return;
    v.stateJson = j;
    this.send(v, 'state', s);
  }

  // ------------------------------------------------------------ capture pacing
  kick(v: View) { this.schedule(v, 0); }

  private schedule(v: View, ms: number) {
    if (v.closed || !v.viewers.size) { if (v.timer) clearTimeout(v.timer); v.timer = null; return; }
    const at = Date.now() + ms;
    if (v.timer && v.due <= at) return;
    if (v.timer) clearTimeout(v.timer);
    v.due = at;
    v.timer = setTimeout(() => { v.timer = null; void this.tick(v); }, ms);
    v.timer.unref();
  }

  private interval(v: View) { return v.inflight.size ? 1000 / this.cfg().fps : v.slow ? 5000 : 1000; }

  private async tick(v: View) {
    if (v.closed || !v.viewers.size || v.capturing) return;
    this.emitState(v);
    const b = this.host?.current();
    if (!b || b.dead || this.host?.login()) { this.schedule(v, 1000); return; }
    v.capturing = true;
    try { await runAsClient(v.client, () => this.captureOnce(v, b), v.ws); } catch { /* reported as stale */ }
    finally {
      v.capturing = false;
      this.emitState(v);
      this.schedule(v, this.interval(v));
    }
  }

  private async refreshTabs(v: View, b: Browser) {
    v.tabsAt = Date.now();
    const rows = (await b.listTabs()).filter((t) => t.agent).map((t) => ({ tab: t.tab, title: maskText(t.title ?? ''), url: maskText(t.url ?? ''), current: t.tab === b.cur }));
    if (v.viewTab != null && !rows.some((r) => r.tab === v.viewTab)) v.viewTab = null;
    const j = JSON.stringify([rows, v.viewTab]);
    v.tabs = rows;
    if (j !== v.tabsJson) { v.tabsJson = j; this.send(v, 'tabs', { tabs: rows, viewing: v.viewTab }); }
  }

  private async check(b: Browser, ctx: string): Promise<Check | null> {
    let t: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { t = setTimeout(() => r(null), 1000); });
    try { return await Promise.race([b.callPage(ctx, CHECK, [], { awaitPromise: false }).catch(() => null), late]); } finally { clearTimeout(t); }
  }

  private frameMeta(v: View) {
    const f = v.frame!;
    const row = v.tabs.find((t) => t.tab === (f as any).tab);
    const dims = imageSize(f.buf);
    const c = v.last && v.last.ctx === f.ctx ? v.last : null;
    return { seq: f.seq, tab: (f as any).tab ?? null, url: c ? maskText(c.url) : row?.url ?? '', title: c ? maskText(c.title) : row?.title ?? '', w: dims.w, h: dims.h, cssW: c?.w ?? dims.w, cssH: c?.h ?? dims.h };
  }

  private async captureOnce(v: View, b: Browser) {
    const active = v.inflight.size > 0;
    if (Date.now() - v.tabsAt > (active ? 1000 : 3000)) await this.refreshTabs(v, b).catch(() => {});
    const tab = v.viewTab ?? b.cur ?? v.tabs[0]?.tab;
    if (tab == null) return;
    let ctx: string;
    try { ctx = await b.context(tab); } catch { v.tabsAt = 0; return; }
    const row = v.tabs.find((t) => t.tab === tab);
    if (row && PRIVILEGED.test(row.url)) return this.showPlaceholder(v, tab, row, 'Firefox does not capture extension and browser pages');
    v.placeholder = '';
    // a page waiting in a dialog can't answer the check (measured: the capture itself still returns at once)
    const inDialog = [...b.dialogs.open.values()].some((e) => e.context === ctx);
    if (!inDialog && (!active || v.last?.ctx !== ctx)) {
      const c = await this.check(b, ctx);
      if (c) {
        const changed = !v.last || v.last.ctx !== ctx || c.url !== v.last.url || c.sx !== v.last.sx || c.sy !== v.last.sy || c.n !== v.last.n || c.w !== v.last.w || c.h !== v.last.h || c.title !== v.last.title;
        v.last = { ...c, ctx };
        if (changed) v.lastChange = Date.now();
        // nothing changed for 30 s: no capture until something does (a tool call, a mutation, a scroll)
        else if (!active && Date.now() - v.lastChange > 30000 && v.frame?.ctx === ctx && !v.stale) { v.stats.skipped++; return; }
      }
    }
    const cfg = this.cfg();
    const t0 = Date.now();
    // a capture still running after 2 s (a stuck page, an open modal): say "stale" now, not when it returns
    const staleTimer = setTimeout(() => { v.stale = true; v.slow = true; this.emitState(v); }, 2000);
    try {
      const r = await b.bidi.send('browsingContext.captureScreenshot', { context: ctx, origin: 'viewport', format: cfg.format === 'image/png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: cfg.quality } }, 15000);
      const ms = Date.now() - t0;
      v.stats.captures++; v.stats.ms += ms; v.stats.lastMs = ms; v.stats.maxMs = Math.max(v.stats.maxMs, ms);
      v.slow = ms > 2000;
      v.stale = false;
      v.frame = { seq: ++v.seq, buf: Buffer.from(r.data, 'base64'), type: cfg.format, ctx };
      (v.frame as any).tab = tab;
      this.send(v, 'frame', this.frameMeta(v));
    } catch (e: any) {
      v.stats.failed++;
      if (/privileged|System access/i.test(String(e?.message))) {
        // the tab list may predate the navigation: name the page it shows now
        await this.refreshTabs(v, b).catch(() => {});
        return this.showPlaceholder(v, tab, v.tabs.find((t) => t.tab === tab) ?? row, 'Firefox does not capture extension and browser pages');
      }
      v.stale = true;
    } finally { clearTimeout(staleTimer); }
  }

  private showPlaceholder(v: View, tab: number, row: TabRow | undefined, reason: string) {
    const key = `${tab} ${row?.url}`;
    if (v.placeholder === key) return;
    v.placeholder = key;
    this.send(v, 'placeholder', { tab, url: row?.url ?? '', title: row?.title ?? '', reason });
  }

  // ------------------------------------------------------------ controls
  private async takeover(v: View): Promise<{ status: number; json: unknown }> {
    const b = await this.ensureBrowser();
    const why = this.controls(v, b).takeover;
    if (why && why !== 'you have the browser') return { status: 409, json: { error: why } };
    if (why) return { status: 200, json: { ok: true, already: true } };
    const out = await runAsClient(v.client, async () => {
      const tab = v.viewTab ?? b!.cur ?? undefined;
      const context = await b!.context(tab);
      const handle = tab ?? b!.cur ?? 0;
      if (!b!.state.headless) await b!.showWindow(context);
      b!.cur = handle; b!.save();
      const since = Date.now();
      b!.handoff = { reason: 'the user took over from the live view', tab: handle, since, by: 'live view' };
      v.note = `HANDED_OFF: the user took over from the live view at ${new Date(since).toTimeString().slice(0, 8)} on tab ${handle}; ask them what they want, and call ff_handback when they say they're done`;
      const url = v.tabs.find((t) => t.tab === handle)?.url;
      auditAppend({ id: newAuditId(), tool: 'live_view_takeover', args: {}, target: { tab: handle, url, client: v.client || undefined }, status: 'ok', ms: Date.now() - since, write: true });
      return { tab: handle };
    }, v.ws);
    this.emitState(v);
    this.kick(v);
    return { status: 200, json: { ok: true, ...out } };
  }

  private async window(v: View, action: unknown): Promise<{ status: number; json: unknown }> {
    if (action !== 'show' && action !== 'park') return { status: 400, json: { error: 'action must be show or park' } };
    const b = await this.ensureBrowser();
    const why = this.controls(v, b).window;
    if (why) return { status: 409, json: { error: why } };
    const t0 = Date.now();
    const text = await runAsClient(v.client, () => b!.setWindowMode(action === 'show' ? 'visible' : 'offscreen'), v.ws);
    auditAppend({ id: newAuditId(), tool: 'live_view_window', args: { action }, target: { client: v.client || undefined }, status: 'ok', ms: Date.now() - t0, write: true });
    v.stateJson = '';
    this.emitState(v);
    return { status: 200, json: { ok: true, text } };
  }

  private async viewTab(v: View, tab: unknown): Promise<{ status: number; json: unknown }> {
    if (tab !== null && !(typeof tab === 'number' && v.tabs.some((t) => t.tab === tab))) return { status: 400, json: { error: 'not one of this session\'s tabs' } };
    v.viewTab = tab as number | null;
    v.tabsJson = '';
    v.tabsAt = 0;
    this.kick(v);
    return { status: 200, json: { ok: true } };
  }

  // ------------------------------------------------------------ hooks from the tool wrapper and input tools
  toolStart(name: string, args: Record<string, unknown>, write: boolean): ((status: 'ok' | 'error', code?: string) => void) | null {
    const v = this.views.get(currentClient());
    if (!v || v.closed) return null;
    const id = ++callSeq;
    const t0 = Date.now();
    const target = captionTarget(args);
    const start = { id, phase: 'start', name, target, ts: t0 };
    v.captions.push(start);
    if (v.captions.length > 40) v.captions.splice(0, v.captions.length - 40);
    this.send(v, 'tool', start);
    if (write) { v.inflight.set(id, name); this.emitState(v); this.kick(v); }
    return (status, code) => {
      const end = { id, phase: 'end', name, target, status, code: code ?? null, ms: Date.now() - t0, ts: Date.now() };
      v.captions.push(end);
      this.send(v, 'tool', end);
      if (v.inflight.delete(id) || write) {
        // right after a call that can change the page: a fresh frame and tab list
        v.lastChange = Date.now();
        v.tabsAt = 0;
        this.kick(v);
      }
      this.emitState(v);
    };
  }

  pointer(p: { kind: 'click' | 'drag' | 'scroll' | 'type'; tab: number | null; x: number; y: number; w?: number; h?: number; x2?: number; y2?: number }) {
    const v = this.views.get(currentClient());
    if (v?.viewers.size) this.send(v, 'pointer', p);
  }

  watching(client = currentClient()): boolean { return !!this.views.get(client)?.viewers.size; }

  /** the note for Claude's next tool result after a Take over (once) */
  takeNote(client = currentClient()): string | null { const v = this.views.get(client); const n = v?.note ?? null; if (v) v.note = null; return n; }

  /** One line for ff_status / ff_live_view status (null without a view). */
  statusLine(client = currentClient(), detail = false): string | null {
    const v = this.views.get(client);
    if (!v) return null;
    const s = v.stats;
    const avg = s.captures ? Math.round(s.ms / s.captures) : 0;
    const head = `live view: ${this.url(v)} · ${v.viewers.size} viewer(s) · ${s.captures} frame(s)${s.captures ? ` (capture avg ${avg} ms, max ${s.maxMs} ms)` : ''}`;
    if (!detail) return head;
    return [head, `skipped (no change for 30 s): ${s.skipped} · failed: ${s.failed} · ${v.slow ? 'backed off to 1 per 5 s (slow captures)' : `pacing: ${this.cfg().fps}/s while a call runs, 1/s idle`}${v.stale ? ' · STALE' : ''}`].join('\n');
  }
}

let callSeq = 0;

/** b.handoff etc. are per session: read them in that session's context */
function withClient<T>(client: string, f: () => T): T { return runAsClientSync(client, f); }

/** What a caption shows for a call: the URL, ref, point, file or selector (masked); never typed text. */
function captionTarget(args: Record<string, unknown>): string {
  for (const k of ['url', 'path', 'ref', 'target', 'selector', 'from', 'style', 'script', 'id', 'kind', 'action', 'op']) {
    const x = args[k];
    if (x === undefined || x === null || x === '') continue;
    const s = typeof x === 'object' ? ('x' in (x as any) ? `(${(x as any).x}, ${(x as any).y})` : '') : String(x);
    if (s) return maskText(s).slice(0, 160);
  }
  return '';
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { n += (c as Buffer).length; if (n > 4096) throw new Error('too large'); chunks.push(c as Buffer); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

/** Pixel size of a JPEG (SOFn marker) or PNG (IHDR). */
export function imageSize(b: Buffer): { w: number; h: number } {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0 };
}

export const live = new LiveServer();
