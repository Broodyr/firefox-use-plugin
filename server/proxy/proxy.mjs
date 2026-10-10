#!/usr/bin/env node
// firefox-use hot-reload proxy.
//
// Owns the stdio MCP connection to Claude Code and runs the real server (server/dist/index.js)
// as a child. When server/dist/.build-stamp changes it starts a candidate backend, and only if the
// candidate initialises and lists tools does it drain and detach the old one, promote the new one
// and send notifications/tools/list_changed. A failed build keeps the last good backend.
//
// Zero dependencies on purpose: keep changes rare (a running session keeps the proxy it started with).
//
// Extras:
//   ff_dev_status            proxy version, backend build, reloads, errors
//   ff_dev_call(tool, args)  forwards any backend tool by name (fallback if a tool refresh is missed)
//                            Both are listed only in a source checkout (server/src present); a release
//                            install still answers them, unlisted, and lists them when the backend is down.
//   named pipe               \\.\pipe\firefox-use-proxy-<pid>, token-authenticated, lets the test
//                            harness and other sessions call tools through this backend (one BiDi session per Firefox)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROXY_VERSION = '1.1.0';
const ROOT = process.env.FIREFOX_USE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV_CHECKOUT = fs.existsSync(path.join(ROOT, 'server', 'src'));
const ENTRY = path.join(ROOT, 'server', 'dist', 'index.js');
const STAMP = path.join(ROOT, 'server', 'dist', '.build-stamp');
const BASE = process.env.FIREFOX_USE_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'firefox-use');
const RUN_DIR = path.join(BASE, 'run');
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\firefox-use-proxy-${process.pid}` : path.join(os.tmpdir(), `firefox-use-proxy-${process.pid}.sock`);
const BACKEND_ARGS = process.argv.slice(2);
const INIT_TIMEOUT_MS = 20000;
const DRAIN_TIMEOUT_MS = 30000;
const DETACH_TIMEOUT_MS = 10000;

const log = (...a) => process.stderr.write(`[proxy] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- state
let clientInit = null;          // params of the client's initialize
let initResult = null;          // backend's initialize result (patched)
let active = null;              // current Backend
let generation = 0;
let reloading = false;
const queue = [];               // [{msg, from}] waiting for an active backend
const inflight = new Map();     // backendKey -> {from, id, gen, method, tool}
const status = {
  proxyVersion: PROXY_VERSION, proxyPid: process.pid, pipe: PIPE, root: ROOT, devCheckout: DEV_CHECKOUT,
  backend: null, build: null, startedAt: new Date().toISOString(),
  lastReload: null, lastError: null, reloads: 0, crashes: 0,
};

// ---------------------------------------------------------------- client (Claude Code) side
const toClient = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const clientEndpoint = { name: 'client', send: toClient };

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { if (line.trim()) handleIncoming(parse(line), clientEndpoint); });
rl.on('close', () => { log('stdin closed, shutting down'); shutdown(0); });

function parse(line) { try { return JSON.parse(line); } catch { log('bad JSON from peer:', line.slice(0, 200)); return null; } }

// ---------------------------------------------------------------- dev tools
const DEV_TOOLS = [
  {
    name: 'ff_dev_status',
    description: 'Hot-reload proxy status: proxy version, backend build hash and time, last reload, reload/crash errors. Use when tools seem stale or missing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ff_dev_call',
    description: 'Call any firefox backend tool by name. Fallback for tools added by a rebuild that have not appeared in the tool list yet.',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string', description: 'Backend tool name, e.g. "navigate"' }, args: { type: 'object', description: 'Tool arguments' } },
      required: ['tool'], additionalProperties: false,
    },
  },
];

function devStatus() {
  return {
    ...status,
    backendReady: !!active?.ready,
    reloading,
    queued: queue.length,
    inflight: [...inflight.values()].map((f) => f.tool || f.method),
    recentBackendStderr: active ? active.stderrTail.slice(-15) : [],
  };
}

// ---------------------------------------------------------------- routing
function handleIncoming(msg, from) {
  if (!msg) return;
  if (msg.method === undefined) return routeResponseFromClient(msg, from);
  const isRequest = msg.id !== undefined;
  if (msg.method === 'initialize' && isRequest) return onInitialize(msg, from);
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'ping' && isRequest) return from.send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'tools/call' && isRequest) {
    const name = msg.params?.name;
    if (name === 'ff_dev_status') return from.send({ jsonrpc: '2.0', id: msg.id, result: textResult(JSON.stringify(devStatus(), null, 1)) });
    if (name === 'ff_dev_call') {
      const a = msg.params.arguments || {};
      if (typeof a.tool !== 'string') return from.send({ jsonrpc: '2.0', id: msg.id, result: textResult('ff_dev_call: "tool" is required', true) });
      msg = { ...msg, params: { ...msg.params, name: a.tool, arguments: a.args || {} } };
    }
  }
  if (msg.method === 'notifications/cancelled') {
    const key = keyFor(from, msg.params?.requestId);
    const f = inflight.get(key);
    if (f && active && f.gen === active.gen) active.send({ ...msg, params: { ...msg.params, requestId: key } });
    return;
  }
  dispatch(msg, from);
}

function dispatch(msg, from) {
  if (!active?.ready || reloading) {
    if (!active && !reloading && !startingFirst && msg.id !== undefined) {
      if (msg.method === 'tools/list') return from.send({ jsonrpc: '2.0', id: msg.id, result: { tools: DEV_TOOLS } });
      return from.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `firefox backend is not running: ${status.lastError || 'no build yet (run npm run build)'}` } });
    }
    queue.push({ msg, from });
    return;
  }
  sendToBackend(active, msg, from);
}

function keyFor(from, id) { return from === clientEndpoint ? id : `${from.name}:${JSON.stringify(id)}`; }

function sendToBackend(b, msg, from) {
  if (msg.id === undefined) return b.send(msg);
  const key = keyFor(from, msg.id);
  inflight.set(key, { from, id: msg.id, gen: b.gen, method: msg.method, tool: msg.method === 'tools/call' ? msg.params?.name : undefined });
  b.send({ ...msg, id: key });
}

function onBackendMessage(b, msg) {
  if (!msg) return;
  if (msg.method === undefined) {
    // response
    if (typeof msg.id === 'string' && msg.id.startsWith('proxy:')) return b.resolveOwn(msg);
    const f = inflight.get(msg.id);
    if (!f) return;
    inflight.delete(msg.id);
    let out = { ...msg, id: f.id };
    if (f.method === 'tools/list' && msg.result && DEV_CHECKOUT) out = { ...out, result: { ...msg.result, tools: [...(msg.result.tools || []), ...DEV_TOOLS] } };
    f.from.send(out);
    if (b.draining && ![...inflight.values()].some((x) => x.gen === b.gen)) b.draining();
    return;
  }
  if (msg.id !== undefined) {
    // backend -> client request: remap id per generation
    if (b !== active) return;
    toClient({ ...msg, id: `b${b.gen}:${JSON.stringify(msg.id)}` });
    return;
  }
  // notification
  if (b !== active && msg.method !== 'notifications/message') return;
  if (msg.method === 'notifications/tools/list_changed' && b !== active) return;
  toClient(msg);
}

function routeResponseFromClient(msg, from) {
  if (from !== clientEndpoint || typeof msg.id !== 'string') return;
  const m = /^b(\d+):(.*)$/.exec(msg.id);
  if (!m || !active || Number(m[1]) !== active.gen) return;
  active.send({ ...msg, id: JSON.parse(m[2]) });
}

function textResult(text, isError = false) { return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }; }

// ---------------------------------------------------------------- initialize
let startingFirst = false;
async function onInitialize(msg, from) {
  if (from !== clientEndpoint) {
    // external harness connection: answer from cache
    const r = initResult || { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'firefox-use-proxy', version: PROXY_VERSION } };
    return from.send({ jsonrpc: '2.0', id: msg.id, result: r });
  }
  clientInit = msg.params;
  if (!active && fs.existsSync(ENTRY)) {
    startingFirst = true;
    try { await promote(await startBackend()); } catch (e) { status.lastError = String(e.message || e); log('initial backend failed:', status.lastError); }
    startingFirst = false;
  }
  initResult = patchInit(active?.initResult) || {
    protocolVersion: clientInit?.protocolVersion || '2025-06-18',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'firefox-use-proxy', version: PROXY_VERSION },
  };
  from.send({ jsonrpc: '2.0', id: msg.id, result: initResult });
  flushQueue();
}

function patchInit(r) {
  if (!r) return null;
  return { ...r, capabilities: { ...(r.capabilities || {}), tools: { ...(r.capabilities?.tools || {}), listChanged: true } } };
}

// ---------------------------------------------------------------- backend lifecycle
class Backend {
  constructor(gen) {
    this.gen = gen;
    this.ready = false;
    this.own = new Map();
    this.ownId = 0;
    this.stderrTail = [];
    this.exited = false;
    this.child = spawn(process.execPath, [ENTRY, ...BACKEND_ARGS], {
      cwd: process.cwd(),
      env: { ...process.env, FIREFOX_USE_PROXY_PID: String(process.pid), FIREFOX_USE_BACKEND_GEN: String(gen) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.pid = this.child.pid;
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => { if (l.trim()) onBackendMessage(this, parse(l)); });
    readline.createInterface({ input: this.child.stderr }).on('line', (l) => {
      this.stderrTail.push(l); if (this.stderrTail.length > 200) this.stderrTail.shift();
      process.stderr.write(`[backend#${gen}] ${l}\n`);
    });
    this.exitPromise = new Promise((res) => this.child.on('exit', (code, sig) => { this.exited = true; this.exitCode = code ?? sig; res(); onBackendExit(this); }));
    this.child.stdin.on('error', () => {});
  }
  send(msg) { if (!this.exited) this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  request(method, params, timeoutMs) {
    const id = `proxy:${++this.ownId}`;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.own.delete(id); rej(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.own.set(id, { res: (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); } });
      this.send({ jsonrpc: '2.0', id, method, params });
      this.exitPromise.then(() => { if (this.own.has(id)) { this.own.delete(id); clearTimeout(t); rej(new Error(`backend exited (${this.exitCode}) during ${method}: ${this.stderrTail.slice(-5).join(' | ')}`)); } });
    });
  }
  resolveOwn(msg) { const p = this.own.get(msg.id); if (p) { this.own.delete(msg.id); p.res(msg); } }
  kill() { if (!this.exited) try { this.child.kill(); } catch {} }
}

function readStamp() { try { return JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { return null; } }

async function startBackend() {
  const b = new Backend(++generation);
  try {
    const init = await b.request('initialize', clientInit || { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'firefox-use-proxy', version: PROXY_VERSION } }, INIT_TIMEOUT_MS);
    b.initResult = init;
    b.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await b.request('tools/list', {}, INIT_TIMEOUT_MS);
    b.toolCount = list.tools?.length ?? 0;
    b.build = readStamp();
    return b;
  } catch (e) {
    b.kill();
    throw e;
  }
}

async function promote(b) {
  active = b;
  b.ready = true;
  status.backend = { pid: b.pid, gen: b.gen, tools: b.toolCount, startedAt: new Date().toISOString() };
  status.build = b.build;
  status.lastError = null;
}

function flushQueue() {
  while (queue.length && active?.ready && !reloading) {
    const { msg, from } = queue.shift();
    sendToBackend(active, msg, from);
  }
}

function failInflight(gen, why) {
  for (const [key, f] of inflight) {
    if (f.gen !== gen) continue;
    inflight.delete(key);
    f.from.send({ jsonrpc: '2.0', id: f.id, error: { code: -32603, message: why } });
  }
}

async function detach(b) {
  // let in-flight calls finish, then ask for a graceful detach (BiDi session.end, Firefox keeps running)
  if ([...inflight.values()].some((f) => f.gen === b.gen)) {
    await Promise.race([new Promise((r) => { b.draining = r; }), sleep(DRAIN_TIMEOUT_MS)]);
  }
  failInflight(b.gen, 'backend was reloaded while this call was running; retry it');
  b.send({ jsonrpc: '2.0', method: 'notifications/firefox-use/detach' });
  try { b.child.stdin.end(); } catch {}
  await Promise.race([b.exitPromise, sleep(DETACH_TIMEOUT_MS)]);
  b.kill();
}

let reloadPending = false;
async function reload(reason) {
  if (reloading) { reloadPending = true; return; }
  if (!clientInit) return; // not initialised yet; the first initialize starts the backend
  reloading = true;
  const t0 = Date.now();
  try {
    const candidate = await startBackend();
    const old = active;
    if (old) {
      old.ready = false;
      old.retiring = true;
      await detach(old);
    }
    await promote(candidate);
    status.reloads++;
    status.lastReload = { at: new Date().toISOString(), reason, ms: Date.now() - t0, ok: true, build: candidate.build };
    log(`reloaded (${reason}) -> backend#${candidate.gen} in ${Date.now() - t0} ms`);
    reloading = false;
    flushQueue();
    toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  } catch (e) {
    status.lastError = `reload failed (${reason}): ${e.message || e}`;
    status.lastReload = { at: new Date().toISOString(), reason, ms: Date.now() - t0, ok: false, error: String(e.message || e) };
    log(status.lastError);
    reloading = false;
    flushQueue();
  }
  if (reloadPending) { reloadPending = false; reload('queued rebuild'); }
}

let crashTimes = [];
function onBackendExit(b) {
  if (b !== active || b.retiring) return;
  status.crashes++;
  const tail = b.stderrTail.slice(-5).join(' | ');
  status.lastError = `backend#${b.gen} exited unexpectedly (${b.exitCode}): ${tail}`;
  log(status.lastError);
  failInflight(b.gen, `firefox backend crashed: ${tail}`);
  active = null;
  crashTimes = crashTimes.filter((t) => Date.now() - t < 60000).concat(Date.now());
  if (crashTimes.length > 3) { log('crash loop: not restarting until the next build'); return; }
  setTimeout(() => reload('restart after crash'), 1000 * crashTimes.length);
}

// ---------------------------------------------------------------- build watcher
let lastStampText = null;
try { lastStampText = fs.readFileSync(STAMP, 'utf8'); } catch {}
fs.watchFile(STAMP, { interval: 400 }, () => {
  let text = null;
  try { text = fs.readFileSync(STAMP, 'utf8'); } catch { return; }
  if (text === lastStampText) return;
  lastStampText = text;
  reload('rebuild');
});

// ---------------------------------------------------------------- harness pipe
let connSeq = 0;
function readToken() { try { return fs.readFileSync(path.join(BASE, 'token'), 'utf8').trim(); } catch { return null; } }
const pipeServer = net.createServer((sock) => {
  const ep = { name: `x${++connSeq}`, authed: false, send: (m) => { if (!sock.destroyed) sock.write(JSON.stringify(m) + '\n'); } };
  readline.createInterface({ input: sock }).on('line', (line) => {
    const msg = parse(line);
    if (!msg) return;
    if (!ep.authed) {
      const tok = readToken();
      if (tok && msg.auth === tok) { ep.authed = true; ep.send({ auth: 'ok', proxyPid: process.pid }); }
      else { ep.send({ auth: 'denied' }); sock.destroy(); }
      return;
    }
    handleIncoming(msg, ep);
  });
  sock.on('error', () => {});
  sock.on('close', () => { for (const [k, f] of inflight) if (f.from === ep) inflight.delete(k); });
});
pipeServer.on('error', (e) => log('pipe error:', e.message));
pipeServer.listen(PIPE, () => {
  try {
    fs.mkdirSync(path.join(RUN_DIR, 'proxies'), { recursive: true });
    fs.writeFileSync(path.join(RUN_DIR, 'proxies', `${process.pid}.json`), JSON.stringify({ pid: process.pid, pipe: PIPE, root: ROOT, cwd: process.cwd(), startedAt: status.startedAt }));
  } catch (e) { log('could not write proxy run file:', e.message); }
});

// ---------------------------------------------------------------- shutdown
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  fs.unwatchFile(STAMP);
  try { fs.unlinkSync(path.join(RUN_DIR, 'proxies', `${process.pid}.json`)); } catch {}
  pipeServer.close();
  if (active) {
    // stdin EOF without a detach notice = Claude Code went away: backend's watchdog ends the browser session
    active.retiring = true;
    try { active.child.stdin.end(); } catch {}
    await Promise.race([active.exitPromise, sleep(DETACH_TIMEOUT_MS)]);
    active.kill();
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (e) => { log('uncaught:', e.stack || e); });
