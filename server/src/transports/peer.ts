// several sessions: when another Claude session owns the profile's Firefox, this backend routes its
// tool calls through the owner's proxy pipe (token-authenticated MCP, the same channel the harness uses),
// tagged with a hidden __client id so the owner keeps a separate tab group, current tab and scope for us.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, readToken, workspace } from '../config.js';
import { ToolError } from '../errors.js';
import { myClientId } from '../browser/client.js';

export interface PeerResult { isError?: boolean; content: any[] }

export class Peer {
  private sock!: net.Socket;
  private id = 0;
  private pending = new Map<number, { res: (m: any) => void; rej: (e: Error) => void }>();
  closed = false;

  constructor(public ownerPid: number, public pipe: string) {}

  /** The pipe of a live proxy, from run/proxies/<pid>.json. */
  static pipeFor(ownerPid: number): string | null {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(loadConfig().runDir, 'proxies', `${ownerPid}.json`), 'utf8'));
      return j.pipe ?? null;
    } catch { return null; }
  }

  async connect(timeoutMs = 5000): Promise<void> {
    const token = readToken();
    if (!token) throw new ToolError('TOKEN_REVOKED', 'session token missing');
    this.sock = net.connect(this.pipe);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new ToolError('PEER_CONNECT', `no answer from the owning session's proxy (${this.pipe})`)), timeoutMs);
      this.sock.once('error', (e) => { clearTimeout(t); rej(new ToolError('PEER_CONNECT', `cannot reach the owning session's proxy: ${e.message}`)); });
      let authed = false;
      readline.createInterface({ input: this.sock }).on('line', (line) => {
        let m: any;
        try { m = JSON.parse(line); } catch { return; }
        if (!authed && m.auth !== undefined) {
          clearTimeout(t);
          if (m.auth === 'ok') { authed = true; res(); } else rej(new ToolError('PEER_AUTH', 'the owning session refused the token'));
          return;
        }
        const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
        if (p) { this.pending.delete(m.id); p.res(m); }
      });
      this.sock.on('connect', () => this.sock.write(JSON.stringify({ auth: token }) + '\n'));
    });
    this.sock.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.rej(new ToolError('PEER_CLOSED', 'the owning session went away during the call', 'Retry: this session launches its own Firefox if the owner has quit.'));
      this.pending.clear();
    });
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `firefox-use-peer-${myClientId()}`, version: '1' } });
  }

  private request(method: string, params: unknown, timeoutMs = 600000): Promise<any> {
    if (this.closed) return Promise.reject(new ToolError('PEER_CLOSED', 'connection to the owning session is closed'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new ToolError('PEER_TIMEOUT', `${method} timed out via the owning session`)); }, timeoutMs);
      this.pending.set(id, { res: (m) => { clearTimeout(t); m.error ? rej(new ToolError('PEER_ERROR', m.error.message)) : res(m.result); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<PeerResult> {
    return this.request('tools/call', { name, arguments: { ...args, __client: myClientId(), __workspace: workspace() } });
  }

  close() { this.closed = true; try { this.sock?.destroy(); } catch { /* ignore */ } }
}
