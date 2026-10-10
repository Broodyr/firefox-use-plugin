import { EventEmitter } from 'node:events';
import { ToolError } from '../errors.js';

export interface BidiEvent { method: string; params: any }

export class BidiError extends ToolError {
  constructor(public bidiError: string, message: string, public method: string) {
    super(`BIDI_${bidiError.toUpperCase().replace(/\s+/g, '_')}`, `${method}: ${message}`);
  }
}

/** WebDriver BiDi client over WebSocket (Node >= 22 global WebSocket). */
export class Bidi extends EventEmitter {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; method: string; timer: NodeJS.Timeout }>();
  closed = false;
  sessionId: string | null = null;

  constructor(public url: string) { super(); }

  static async probe(url: string): Promise<boolean> {
    return new Promise((res) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { return res(false); }
      const t = setTimeout(() => { try { ws.close(); } catch {} res(false); }, 1500);
      ws.onopen = () => { clearTimeout(t); ws.close(); res(true); };
      ws.onerror = () => { clearTimeout(t); res(false); };
    });
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new ToolError('BIDI_CONNECT', `cannot connect to ${this.url}`));
    });
    this.ws.onmessage = (m) => this.onMessage(String(m.data));
    this.ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.rej(new ToolError('BIDI_CLOSED', `connection closed during ${p.method}`)); }
      this.pending.clear();
      this.emit('close');
    };
  }

  private onMessage(data: string) {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'error') p.rej(new BidiError(msg.error, msg.message ?? msg.error, p.method));
      else p.res(msg.result);
      return;
    }
    if (msg.type === 'event') this.emit('event', { method: msg.method, params: msg.params } as BidiEvent);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new ToolError('BIDI_CLOSED', `BiDi connection is closed (${method})`, 'Run ff_launch to reconnect.'));
    const id = ++this.id;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new ToolError('BIDI_TIMEOUT', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, method, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async newSession(timeoutMs = 30000, capabilities: Record<string, unknown> = {}): Promise<{ browserName?: string; browserVersion?: string }> {
    const r = await this.send('session.new', { capabilities }, timeoutMs);
    this.sessionId = r.sessionId;
    return r.capabilities ?? {};
  }

  async endSession(): Promise<void> {
    if (this.closed) return;
    try { await this.send('session.end', {}, 5000); } catch { /* already gone */ }
    this.sessionId = null;
  }

  close() {
    if (!this.closed) try { this.ws.close(); } catch { /* ignore */ }
    this.closed = true;
  }
}

/** Convert a BiDi RemoteValue into plain JS (nodes become {node: sharedId}). */
export function fromRemote(v: any, depth = 0): any {
  if (!v || typeof v !== 'object' || depth > 20) return v;
  switch (v.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return v.value;
    case 'number':
      if (v.value === 'NaN') return NaN;
      if (v.value === '-0') return -0;
      if (v.value === 'Infinity') return Infinity;
      if (v.value === '-Infinity') return -Infinity;
      return v.value;
    case 'bigint': return `${v.value}n`;
    case 'date': return v.value;
    case 'regexp': return `/${v.value.pattern}/${v.value.flags ?? ''}`;
    case 'array': case 'set': case 'nodelist': case 'htmlcollection':
      return v.value ? v.value.map((x: any) => fromRemote(x, depth + 1)) : `[${v.type}]`;
    case 'object': case 'map':
      if (!v.value) return `[${v.type}]`;
      return Object.fromEntries(v.value.map(([k, x]: [any, any]) => [typeof k === 'string' ? k : JSON.stringify(fromRemote(k, depth + 1)), fromRemote(x, depth + 1)]));
    case 'node': return { node: v.sharedId, nodeName: v.value?.localName ?? v.value?.nodeName };
    case 'window': return '[window]';
    case 'error': return '[error]';
    default: return `[${v.type}]`;
  }
}
