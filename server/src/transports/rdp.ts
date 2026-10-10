import net from 'node:net';
import { ToolError } from '../errors.js';

const UNSOLICITED = new Set([
  'newSource', 'tabNavigated', 'frameUpdate', 'resources-available-array', 'target-available-form',
  'target-destroyed-form', 'resources-updated-array', 'resources-destroyed-array', 'evaluationResult',
  'paused', 'resumed', 'consoleAPICall', 'pageError', 'networkEvent', 'networkEventUpdate', 'tabListChanged',
  'addonListChanged', 'workerListChanged', 'processListChanged', 'descriptor-destroyed', 'forwardingCancelled',
]);

/** Minimal Firefox DevTools remote protocol client (length-prefixed JSON over TCP). */
export class Rdp {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private listeners: ((p: any) => void)[] = [];
  closed = false;
  onClose?: () => void;

  constructor(public port: number) {}

  /** Listen to every packet (events and replies). Returns an unsubscribe function. */
  on(f: (p: any) => void): () => void {
    this.listeners.push(f);
    return () => { const i = this.listeners.indexOf(f); if (i >= 0) this.listeners.splice(i, 1); };
  }

  connect(timeoutMs = 5000): Promise<any> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.close(); rej(new ToolError('RDP_CONNECT', `no RDP greeting on port ${this.port}`)); }, timeoutMs);
      this.sock = net.connect(this.port, '127.0.0.1');
      this.sock.on('error', (e) => { clearTimeout(timer); rej(new ToolError('RDP_CONNECT', `RDP connect failed: ${e.message}`)); });
      this.sock.on('data', (d) => this.onData(Buffer.from(d)));
      this.sock.on('close', () => {
        this.closed = true;
        for (const q of this.waiting.values()) for (const w of q) w.done({ error: 'closed', message: 'devtools connection closed' });
        this.waiting.clear();
        this.onClose?.();
      });
      this.once((p) => p.from === 'root' && p.applicationType !== undefined, (p) => { clearTimeout(timer); res(p); });
    });
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(58);
      if (colon < 0) return;
      const len = parseInt(this.buf.subarray(0, colon).toString(), 10);
      if (this.buf.length < colon + 1 + len) return;
      const pkt = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString());
      this.buf = this.buf.subarray(colon + 1 + len);
      for (const l of [...this.listeners]) l(pkt);
    }
  }

  private once(pred: (p: any) => boolean, cb: (p: any) => void) {
    const f = (p: any) => { if (pred(p)) { this.listeners.splice(this.listeners.indexOf(f), 1); cb(p); } };
    this.listeners.push(f);
  }

  /** Replies come back in order per actor, so pending requests are a FIFO per actor. */
  private waiting = new Map<string, { done: (p: any) => void }[]>();
  private replyRouter = (p: any) => {
    if (!p.from || (p.type && UNSOLICITED.has(p.type))) return;
    const q = this.waiting.get(p.from);
    const w = q?.shift();
    if (q && !q.length) this.waiting.delete(p.from);
    w?.done(p);
  };

  request(to: string, type: string, extra: Record<string, unknown> = {}, timeoutMs = 10000): Promise<any> {
    if (this.closed) return Promise.reject(new ToolError('RDP_CLOSED', `devtools connection closed (${type})`));
    if (!this.listeners.includes(this.replyRouter)) this.listeners.unshift(this.replyRouter);
    return new Promise((res, rej) => {
      let settled = false;
      const entry = {
        done: (p: any) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          p.error ? rej(new ToolError('RDP_ERROR', `${type}: ${p.error} ${p.message ?? ''}`)) : res(p);
        },
      };
      // on timeout the slot stays queued (a late reply must still be consumed in order) but is ignored
      const timer = setTimeout(() => { settled = true; rej(new ToolError('RDP_TIMEOUT', `${to}.${type} timed out`)); }, timeoutMs);
      let q = this.waiting.get(to);
      if (!q) this.waiting.set(to, (q = []));
      q.push(entry);
      const s = JSON.stringify({ to, type, ...extra });
      this.sock.write(`${Buffer.byteLength(s)}:${s}`);
    });
  }

  /** Evaluate in the parent process (privileged). Used for recovery when BiDi is unusable. */
  async evalParent(text: string, timeoutMs = 10000): Promise<any> {
    const proc = await this.request('root', 'getProcess', { id: 0 });
    const target = await this.request(proc.processDescriptor.actor, 'getTarget');
    const consoleActor = target.process.consoleActor;
    const result = new Promise<any>((res, rej) => {
      const timer = setTimeout(() => rej(new ToolError('RDP_TIMEOUT', 'parent evaluation timed out')), timeoutMs);
      let resultID: string | undefined;
      const f = (p: any) => {
        if (p.type === 'evaluationResult' && p.from === consoleActor && (resultID === undefined || p.resultID === resultID)) {
          clearTimeout(timer);
          this.listeners.splice(this.listeners.indexOf(f), 1);
          p.exception ? rej(new ToolError('RDP_EVAL', JSON.stringify(p.exceptionMessage))) : res(p.result);
        }
      };
      this.listeners.push(f);
      this.request(consoleActor, 'evaluateJSAsync', { text, mapped: { await: true } }).then((r) => { resultID = r.resultID; }, rej);
    });
    return result;
  }

  close() { try { this.sock?.destroy(); } catch { /* ignore */ } }
}

/** End an orphaned BiDi session left by a crashed backend, without restarting Firefox. */
export async function clearOrphanBidiSession(rdpPort: number): Promise<string> {
  const rdp = new Rdp(rdpPort);
  await rdp.connect();
  try {
    return String(await rdp.evalParent(`(async () => {
      const { RemoteAgent } = ChromeUtils.importESModule("chrome://remote/content/components/RemoteAgent.sys.mjs");
      const bidi = RemoteAgent.webDriverBiDi;
      const id = bidi.session?.id;
      if (!id) return 'no session';
      bidi.deleteSession();
      return 'deleted ' + id;
    })()`));
  } finally {
    rdp.close();
  }
}
