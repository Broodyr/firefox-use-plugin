// npm run test:live — a short check of the tools against the REAL claude-dev profile (its extensions, prefs and
// data; the integration suite runs on a clean template, which can drift from it). Nothing lasting: a local page in
// a tab of its own, reads, one click, a dialog, then everything it opened is closed.
//
// If a Claude session owns claude-dev, the check runs inside that Firefox as a separate session (its own tab group,
// like a routed session; the owner's tabs and current tab are untouched) and ff_quit closes only that group.
// Otherwise it starts claude-dev itself (headless unless --headed) and quits it at the end.
//
//   npm run test:live [-- --headed] [-- --verbose]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClient, findProxyFor, readToken, type CallResult } from './client.ts';
import { preflight } from './env.mjs';

// the one check that needs the real claude-dev profile: say how to set it up when it's missing
if (!findProxyFor('claude-dev') && !preflight({ addons: false, claudeDev: true, what: 'the live check (npm run test:live)' })) process.exit(1);

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const PAGE = `<!doctype html><title>firefox-use live check</title>
<h1>Live check</h1><button id="b" onclick="document.title = 'clicked'; alert('live check alert')">Press</button>
<p id="out">waiting</p>
<script>
  console.log('live-check page script ran');
  fetch('/data.json').then((r) => r.json()).then((j) => { document.getElementById('out').textContent = 'data ' + j.n; });
</script>`;

const srv = http.createServer((req, res) => {
  if (req.url === '/data.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"n":42}'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(PAGE);
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(srv.address() as any).port}/`;

// ------------------------------------------------------------ connect
const live = findProxyFor('claude-dev');
let c: McpClient;
let routed = false;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-live-check-'));
if (live) {
  const token = readToken();
  if (!token) { console.error('no session token (setup not run, or the kill switch was engaged)'); process.exit(2); }
  c = await McpClient.connectPipe(live.pipe, token);
  await c.initialize();
  routed = true;
  console.log(`claude-dev is owned by a live session (proxy ${live.pid}): checking inside it, in a tab group of its own`);
} else {
  c = McpClient.spawnServer(['--profile=claude-dev', '--profile-mode=named', ...(argv.includes('--headed') ? [] : ['--headless'])], { FIREFOX_USE_WORKSPACE: workspace });
  await c.initialize();
  console.log(`no session owns claude-dev: starting it${argv.includes('--headed') ? '' : ' headless'} for the check (quit at the end)`);
}
// routed calls carry a client id and workspace, like a second Claude session's
const client = `s${process.pid}`;
const call = (tool: string, args: Record<string, unknown> = {}) => c.call(tool, routed ? { ...args, __client: client, __workspace: workspace } : args, 90000);

// ------------------------------------------------------------ steps
type Step = { name: string; tool: string; args?: Record<string, unknown>; expect?: RegExp; warnOnly?: boolean };
let tab = 0;
const results: { name: string; ok: boolean; warn?: boolean; ms: number; line: string }[] = [];
async function step(s: Step): Promise<CallResult | null> {
  const t0 = Date.now();
  let r: CallResult | null = null;
  let ok = false;
  let line = '';
  try {
    r = await call(s.tool, s.args ?? {});
    ok = !r.isError && (!s.expect || s.expect.test(r.text));
    line = r.text.split('\n').find((l) => l.trim()) ?? '';
    if (!ok && !r.isError && s.expect) line = `expected ${s.expect} in: ${r.text.slice(0, 300).replace(/\n/g, ' ⏎ ')}`;
  } catch (e: any) { line = `threw: ${e?.message ?? e}`; }
  results.push({ name: s.name, ok: ok || !!s.warnOnly, warn: !ok && s.warnOnly, ms: Date.now() - t0, line: line.slice(0, 200) });
  const mark = ok ? 'ok  ' : s.warnOnly ? 'WARN' : 'FAIL';
  console.log(`${mark} ${s.name.padEnd(28)} ${String(Date.now() - t0).padStart(6)} ms  ${line.slice(0, 140)}`);
  if (verbose && r) console.log(r.text.split('\n').map((l) => `       | ${l}`).join('\n'));
  return r;
}

try {
  const st = await step({ name: 'status', tool: 'ff_launch' });
  for (const l of (st?.text ?? '').split('\n').filter((x) => /^(note:|WARNING|install:)/.test(x))) console.log(`       ${l}`);
  await step({ name: 'self-check (internals)', tool: 'ff_selfcheck', expect: /^(\d+)\/\1 internals OK/, warnOnly: true });
  const tc = await step({ name: 'open a tab', tool: 'tabs', args: { op: 'create', url }, expect: /tab \d+ created/ });
  tab = Number(/tab (\d+) created/.exec(tc?.text ?? '')?.[1] ?? 0);
  if (!tab) throw new Error('no tab: stopping');
  await step({ name: 'wait for the page', tool: 'wait_for', args: { kind: 'text', tab, text: 'data 42' } });
  const rp = await step({ name: 'read_page (a11y tree)', tool: 'read_page', args: { tab }, expect: /button "Press"/ });
  const ref = /\[(ref_\d+)\] button "Press"/.exec(rp?.text ?? '')?.[1];
  await step({ name: 'find', tool: 'find', args: { tab, query: 'Press' }, expect: /button "Press"/ });
  await step({ name: 'click + dialog handled', tool: 'click', args: { tab, target: ref ?? 'ref_1' }, expect: /dialog: alert "live check alert" \(dismissed\)/ });
  await step({ name: 'page realm eval', tool: 'eval', args: { tab, code: 'document.title' }, expect: /"clicked"/ });
  await step({ name: 'console (unified)', tool: 'console_read', args: { kind: 'entries', tab, pattern: 'live-check' }, expect: /live-check page script ran/ });
  await step({ name: 'network', tool: 'network_read', args: { kind: 'requests', tab, filter: 'data.json' }, expect: /data\.json/ });
  await step({ name: 'realms', tool: 'realms_list', args: { tab }, expect: /\{kind:"page"\}/ });
  await step({ name: 'screenshot', tool: 'screenshot', args: { tab, scale: 0.3 }, expect: /\d+x\d+/ });
  const lv = await step({ name: 'live view open', tool: 'ff_live_view', args: { action: 'open' }, expect: /live view: http:\/\/127\.0\.0\.1:\d+\/live\/[0-9a-f]{32}\// });
  const lvUrl = /live view: (\S+)/.exec(lv?.text ?? '')?.[1];
  if (lvUrl) {
    // a viewer: the session's current tab arrives as a frame (only the check's own tab group is ever shown)
    const t0 = Date.now();
    const got = await new Promise<string>((res) => {
      let buf = '';
      const req = http.get(lvUrl + 'events', (r) => {
        r.setEncoding('utf8');
        r.on('data', (d: string) => { buf += d; const m = /event: frame\ndata: (.+)/.exec(buf); if (m) { req.destroy(); res(JSON.parse(m[1]).url); } });
      });
      req.on('error', () => res(''));
      setTimeout(() => { req.destroy(); res(''); }, 8000);
    });
    const ok = got.startsWith(url);
    results.push({ name: 'live view frame', ok, ms: Date.now() - t0, line: got ? `frame of ${got}` : 'no frame within 8 s' });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${'live view frame'.padEnd(28)} ${String(Date.now() - t0).padStart(6)} ms  ${got ? `frame of ${got}` : 'no frame within 8 s'}`);
    await step({ name: 'live view close', tool: 'ff_live_view', args: { action: 'close' }, expect: /closed/ });
  }
  await step({ name: 'site storage read', tool: 'site_read', args: { kind: 'local_storage', tab }, expect: /item\(s\) in localStorage/ });
  await step({ name: 'memory', tool: 'perf_memory', args: { tab }, expect: /window [\d.]+ (KB|MB)/ });
  await step({ name: 'errors on the page', tool: 'console_read', args: { kind: 'errors', tab }, warnOnly: true });
  await step({ name: 'add-ons', tool: 'ext_read', args: { kind: 'addons' }, expect: /uBlock Origin|Violentmonkey/ });
  await step({ name: 'Violentmonkey adapter', tool: 'us_read', args: { kind: 'list' }, expect: /script|no userscripts/i, warnOnly: true });
  await step({ name: 'uBlock Origin adapter', tool: 'ubo_read', args: { kind: 'status' }, expect: /uBlock Origin/, warnOnly: true });
  await step({ name: 'Stylus adapter', tool: 'stylus_read', args: { kind: 'list' }, expect: /Stylus: |STYLUS_UNAVAILABLE/, warnOnly: true });
} catch (e: any) {
  console.log(`stopped: ${e?.message ?? e}`);
} finally {
  if (tab) await call('tabs', { op: 'close', tab }).catch(() => {});
  if (routed) await call('ff_quit').catch(() => {}); // a routed session's ff_quit closes only its own tab group
  await c.close().catch(() => {});
  srv.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok), warned = results.filter((r) => r.warn);
console.log(`\nlive check: ${results.length - failed.length}/${results.length} passed${warned.length ? `, ${warned.length} warning(s)` : ''}${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
