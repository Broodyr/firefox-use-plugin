// Minimal MCP client for the harness and integration tests.
// Talks newline-delimited JSON-RPC to a server child process, a proxy child process, or a running
// proxy's named pipe. Code and arguments travel as JSON over this channel, never through a shell.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { HOME } from './env.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** Where the server and proxy are spawned from: the repo, or a release tree (CF_TEST_SERVER_ROOT=.release-build runs the suite against the bundle). */
export const SERVER_ROOT = process.env.CF_TEST_SERVER_ROOT ? path.resolve(ROOT, process.env.CF_TEST_SERVER_ROOT) : ROOT;
export { HOME };

export interface CallResult { isError: boolean; text: string; images: { data: string; mimeType: string }[]; raw: any }

export class McpClient {
  private id = 0;
  private pending = new Map<number | string, { res: (m: any) => void; rej: (e: Error) => void }>();
  readonly notifications: any[] = [];
  readonly stderr: string[] = [];
  child?: ChildProcess;
  private onNotify?: (m: any) => void;
  private onAuth?: (m: any) => void;

  private output: Writable;

  private constructor(input: Readable, output: Writable) {
    this.output = output;
    readline.createInterface({ input }).on('line', (line) => {
      if (!line.trim()) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.auth !== undefined) { this.onAuth?.(msg); return; }
      if (msg.id !== undefined && msg.method === undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        p.res(msg);
      } else if (msg.method !== undefined && msg.id === undefined) {
        this.notifications.push(msg);
        this.onNotify?.(msg);
      } else if (msg.method === 'elicitation/create' && this.onElicit) {
        // tests play the user answering the approval dialog, after elicitDelayMs (instant answers count as not shown)
        this.elicitations.push(msg.params);
        const result = this.onElicit(msg.params);
        setTimeout(() => this.write({ jsonrpc: '2.0', id: msg.id, result }), this.elicitDelayMs);
      } else if (msg.method !== undefined) {
        // server -> client request (roots/list etc.): reply empty
        this.write({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });
  }

  /** Spawn the backend server directly (default: throwaway profile, headless). */
  static spawnServer(args: string[] = ['--profile-mode=throwaway', '--headless'], env: NodeJS.ProcessEnv = {}): McpClient {
    return McpClient.spawn([path.join(SERVER_ROOT, 'server', 'dist', 'index.js'), ...args], env);
  }

  /** Spawn the hot-reload proxy (which spawns the server). */
  static spawnProxy(args: string[] = ['--profile-mode=throwaway', '--headless'], env: NodeJS.ProcessEnv = {}): McpClient {
    return McpClient.spawn([path.join(SERVER_ROOT, 'server', 'proxy', 'proxy.mjs'), ...args], env);
  }

  private static spawn(args: string[], env: NodeJS.ProcessEnv): McpClient {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const c = new McpClient(child.stdout!, child.stdin!);
    c.child = child;
    readline.createInterface({ input: child.stderr! }).on('line', (l) => { c.stderr.push(l); if (process.env.HARNESS_VERBOSE) process.stderr.write(`  | ${l}\n`); });
    child.on('exit', (code) => { for (const p of c.pending.values()) p.rej(new Error(`process exited (${code}): ${c.stderr.slice(-5).join(' | ')}`)); c.pending.clear(); });
    return c;
  }

  /** Connect to a running proxy's pipe (goes through that session's backend). */
  static async connectPipe(pipe: string, token: string): Promise<McpClient> {
    const sock = net.connect(pipe);
    await new Promise<void>((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    const c = new McpClient(sock, sock);
    const auth = await new Promise<any>((res) => {
      c.onAuth = res;
      sock.once('close', () => res({ auth: 'closed' }));
      sock.write(JSON.stringify({ auth: token }) + '\n');
    });
    if (auth.auth !== 'ok') throw new Error('proxy pipe refused the token');
    return c;
  }

  private write(m: any) { this.output.write(JSON.stringify(m) + '\n'); }

  request(method: string, params: any = {}, timeoutMs = 120000): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { res: (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: any = {}) { this.write({ jsonrpc: '2.0', method, params }); }

  /** Answer elicitation (approval dialog) requests; set before initialize to declare the capability. */
  onElicit?: (params: any) => { action: string; content?: Record<string, unknown> };
  readonly elicitations: any[] = [];
  /** how long "the user" takes to answer a dialog; the server treats an approval under 500 ms, a no under 2 s, as not shown */
  elicitDelayMs = 600;

  async initialize() {
    const capabilities = this.onElicit ? { elicitation: {} } : {};
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'firefox-use-harness', version: '0' } });
    this.notify('notifications/initialized');
    return r;
  }

  async listTools(): Promise<any[]> { return (await this.request('tools/list')).tools; }

  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 120000): Promise<CallResult> {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return {
      isError: !!r.isError,
      text: (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'),
      images: (r.content ?? []).filter((c: any) => c.type === 'image'),
      raw: r,
    };
  }

  waitNotification(method: string, timeoutMs = 30000): Promise<any> {
    const existing = this.notifications.find((n) => n.method === method);
    if (existing) { this.notifications.splice(this.notifications.indexOf(existing), 1); return Promise.resolve(existing); }
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.onNotify = undefined; rej(new Error(`no ${method} within ${timeoutMs} ms`)); }, timeoutMs);
      this.onNotify = (m) => { if (m.method === method) { clearTimeout(t); this.onNotify = undefined; this.notifications.splice(this.notifications.indexOf(m), 1); res(m); } };
    });
  }

  /** Close stdin (server watchdog quits its Firefox) and wait for exit. */
  async close(timeoutMs = 20000) {
    if (!this.child) { this.output.end(); return; }
    const exited = new Promise((r) => this.child!.once('exit', r));
    this.child.stdin!.end();
    const t = setTimeout(() => this.child!.kill(), timeoutMs);
    await exited;
    clearTimeout(t);
  }
}

/** The proxy that owns a profile right now, if any (for --profile=claude-dev through a live session). */
export function findProxyFor(profileKey: string): { pipe: string; pid: number } | null {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(HOME, 'run', `${profileKey}.json`), 'utf8'));
    const pf = path.join(HOME, 'run', 'proxies', `${st.ownerPid}.json`);
    if (!fs.existsSync(pf)) return null;
    const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
    process.kill(p.pid, 0);
    return { pipe: p.pipe, pid: p.pid };
  } catch { return null; }
}

export function readToken(): string | null {
  try { return fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim(); } catch { return null; }
}
