// resource server: serves the workspace's resources/ (uBO user resources) and scripts/ (userscripts)
// on 127.0.0.1 with no-store caching, a content hash per response, a request log (to confirm what uBO or
// Violentmonkey actually fetched) and optional artificial latency (resource_latency).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { workspace } from '../config.js';
import { stateDir } from '../audit/audit.js';
import type { Browser } from '../browser/session.js';

export interface Served { ts: number; path: string; query: string; hash: string; status: number; bytes: number; ua: string }

export interface BundleInfo { text: string; hash: string; resources: { file: string; names: string[]; fixes: string[] }[]; warnings: string[] }

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * uBO's resource parser (redirect-engine resourcesFromString) ends a resource at the first whitespace-only line and
 * drops lines starting with "// " or "#" at column 0. Build a bundle that survives that: one `/// name.js` block per
 * resources/*.js file, blank lines inside a resource turned into `//` comments.
 */
export function buildBundle(dir: string): BundleInfo {
  const out: string[] = [];
  const resources: BundleInfo['resources'] = [];
  const warnings: string[] = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort() : [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const fixes: string[] = [];
    let i = 0;
    const header: string[] = [];
    while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('/// '))) { if (lines[i].startsWith('/// ')) header.push(lines[i].trim()); i++; }
    if (!header.some((h) => /^\/\/\/ \S+\.(js|txt|css|html)$/i.test(h) && !/^\/\/\/ (alias|world|dependency) /.test(h))) header.unshift(`/// ${f}`);
    const names = header.filter((h) => !/^\/\/\/ (world|dependency) /.test(h)).map((h) => h.replace(/^\/\/\/ (alias )?/, ''));
    const body: string[] = [];
    let blank = 0;
    for (const [n, l] of lines.slice(i).entries()) {
      if (l.trim() === '') { body.push('//'); blank++; continue; }
      if (l.startsWith('#')) warnings.push(`${f}:${i + n + 1}: uBO drops lines starting with "#" at column 0; indent it`);
      body.push(l);
    }
    while (body.length && body[body.length - 1] === '//') { body.pop(); blank--; }
    if (blank > 0) fixes.push(`${blank} blank line(s) -> "//" (a blank line would end the resource in uBO)`);
    if (/`[^`]*\n\s*\n[^`]*`/.test(src)) warnings.push(`${f}: a template literal spans a blank line; it now contains "//" there`);
    out.push([...header, ...body].join('\n'));
    resources.push({ file: f, names, fixes });
  }
  const text = out.join('\n\n') + '\n';
  return { text, hash: sha(text), resources, warnings };
}

export class ResourceServer {
  private srv: http.Server | null = null;
  port = 0;
  readonly log: Served[] = [];
  readonly latency = new Map<string, number>();
  private waiters = new Set<() => void>();

  constructor(public root: string) {}

  get origin() { return `http://127.0.0.1:${this.port}`; }
  get resourcesDir() { return path.join(this.root, 'resources'); }
  get scriptsDir() { return path.join(this.root, 'scripts'); }
  get running() { return !!this.srv; }

  /** Start on the port this workspace used last (so uBO's userResourcesLocation keeps working), else a free one. */
  async start(): Promise<void> {
    if (this.srv) return;
    const stateFile = path.join(stateDir(), 'resource-server.json');
    let want = 0;
    try { want = JSON.parse(fs.readFileSync(stateFile, 'utf8')).port ?? 0; } catch { /* first run */ }
    const listen = (p: number) => new Promise<http.Server>((res, rej) => {
      const s = http.createServer((q, r) => this.handle(q, r));
      s.once('error', rej);
      s.listen(p, '127.0.0.1', () => { s.off('error', rej); res(s); });
    });
    try { this.srv = await listen(want); } catch { this.srv = await listen(0); }
    this.srv.unref();
    this.port = (this.srv.address() as any).port;
    fs.writeFileSync(stateFile, JSON.stringify({ port: this.port, root: this.root }));
  }

  stop() { this.srv?.close(); this.srv = null; }

  onRequest(f: () => void): () => void { this.waiters.add(f); return () => this.waiters.delete(f); }

  bundle(): BundleInfo { return buildBundle(this.resourcesDir); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://x');
    const delay = this.latency.get(u.pathname) ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    let body: Buffer | null = null;
    let type = 'text/plain; charset=utf-8';
    if (u.pathname === '/resources/bundle.js' || u.pathname === '/resources/') {
      body = Buffer.from(this.bundle().text);
    } else {
      const m = /^\/(resources|scripts)\/(.+)$/.exec(u.pathname);
      if (m) {
        const base = m[1] === 'resources' ? this.resourcesDir : this.scriptsDir;
        const file = path.resolve(base, decodeURIComponent(m[2]));
        if (file.startsWith(path.resolve(base) + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          body = fs.readFileSync(file);
          if (/\.(m?js)$/.test(file)) type = 'text/javascript; charset=utf-8';
          else if (/\.css$/.test(file)) type = 'text/css; charset=utf-8';
          else if (/\.json$/.test(file)) type = 'application/json';
        }
      }
    }
    const status = body ? 200 : 404;
    const hash = body ? sha(body) : '';
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'x-content-hash': hash });
    res.end(body ?? 'not found');
    this.log.push({ ts: Date.now(), path: u.pathname, query: u.search, hash, status, bytes: body?.length ?? 0, ua: String(req.headers['user-agent'] ?? '') });
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    for (const f of [...this.waiters]) { try { f(); } catch { /* ignore */ } }
  }
}

/** The resource server for the current workspace (one per workspace, kept by the Browser that owns Firefox). */
export async function resourceServer(b: Browser): Promise<ResourceServer> {
  const root = path.resolve(workspace());
  const key = `resources:${root.toLowerCase()}`;
  let s = b.adapters.get(key) as ResourceServer | undefined;
  if (!s) {
    s = new ResourceServer(root);
    b.adapters.set(key, s);
    b.closers.push(() => { s!.stop(); b.adapters.delete(key); });
  }
  await s.start();
  return s;
}
