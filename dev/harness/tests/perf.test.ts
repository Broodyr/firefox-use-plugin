// performance: perf_script_cost (per-script cost of a load), perf_profile (start/stop, saved profile,
// summary by origin), perf_memory (window breakdown, content scripts per extension).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startServer } from './helpers.ts';

const PAGE = `<!doctype html><title>perf</title>
  <script src="/lib.js"></script>
  <script>
    function busyInline(ms) { const t = performance.now(); while (performance.now() - t < ms) {} }
    new MutationObserver(function onMutations() { busyInline(25); }).observe(document.documentElement, { childList: true, subtree: true });
    function addNodes() { for (let i = 0; i < 200; i++) { const d = document.createElement('div'); d.textContent = i; document.documentElement.append(d); void document.documentElement.offsetHeight; } }
    addNodes();
    setTimeout(function longTask() { busyInline(90); }, 10);
  </script>`;
// long enough that a starved sampler (a loaded CI runner) still catches it
let libMs = 100;
const LIB = () => `function libWork() { const t = performance.now(); while (performance.now() - t < ${libMs}) {} } libWork();`;

describe('performance', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>, srv: http.Server, base = '';
  before(async () => {
    srv = http.createServer((q, r) => {
      if (q.url === '/lib.js') { r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); r.end(LIB()); return; }
      r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
    h = makeHome();
    c = await startServer(h.env);
    await c.call('navigate', { url: `${base}/` }); // the first load also starts the site's process
  });
  after(async () => { await c.close(); srv.close(); h.cleanup(); });

  it('perf_script_cost: time per script, MutationObserver callbacks, forced flushes, long tasks', async () => {
    const r = await c.call('perf_script_cost', { settle_ms: 800 });
    assert.ok(!r.isError, r.text);
    const row = (label: string) => new RegExp(`\\n  ${label}: ([\\d.]+) ms · ([\\d.]+) ms · MO (.*?) · flush (.*)`).exec(r.text);
    const inline = row('page inline scripts'), lib = row('page script lib\\.js');
    assert.ok(inline && lib, r.text);
    // sampled estimates: on a starved VM (CI) the profiler misses samples (measured: a 40 ms busy loop at 20.6 ms),
    // so the bounds check attribution (each script's own time, the right order of size), not the machine's speed
    assert.ok(Number(inline![1]) >= 35, `inline self ${inline![1]}\n${r.text}`); // 90 ms long task + MO callbacks
    assert.ok(Number(lib![1]) >= 10 && Number(lib![1]) <= 250, `lib self ${lib![1]}\n${r.text}`);
    // MutationObserver callback time / runs; forced layout from offsetHeight. On a shared CI runner the sampler misses
    // short work at random (a different column each run), so there "-" (not sampled) passes; locally both are required.
    const sampled = process.env.GITHUB_ACTIONS ? /^([\d.]+ ms \/ \d+|-)$/ : /^[\d.]+ ms \/ \d+$/;
    assert.match(inline![3], sampled, r.text);
    assert.match(inline![4], sampled, r.text);
    assert.match(r.text, /long tasks \(>= 50 ms\):\n {2}\d+ ms at \+\d+ ms: [^\n]*page inline scripts \d+ ms/, r.text);
    assert.match(r.text, /busyInline \(page inline scripts:4\)/);
    assert.match(r.text, /libWork \(page script lib\.js:1\)/);
  });

  it('perf_profile: start, busy, stop saves a profile and summarises by origin', async () => {
    let r = await c.call('perf_profile', { action: 'start' });
    assert.match(r.text, /profiler started/, r.text);
    r = await c.call('perf_profile', { action: 'start' });
    assert.match(r.text, /PROFILER_BUSY/);
    await c.call('navigate', { url: `${base}/?again` });
    await new Promise((res) => setTimeout(res, 300));
    r = await c.call('perf_profile', { action: 'stop' });
    assert.ok(!r.isError, r.text);
    // the page is among the origins (not necessarily first: on a fresh profile uBO's first filter compile can outweigh it)
    const origins = /self time by origin:\n((?: {2}.*\n)+)/.exec(r.text)?.[1] ?? '';
    assert.match(origins, /^ {2}[ \d.]+ ms {2}page http:\/\/127\.0\.0\.1:\d+$/m, r.text);
    assert.match(r.text, /libWork \(page script lib\.js:1\)/);
    const file = /saved (\S+\.json\.gz)/.exec(r.text)![1];
    const prof = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    assert.ok(prof.meta && Array.isArray(prof.processes), 'a Gecko profile');
    r = await c.call('perf_profile', { action: 'stop' });
    assert.match(r.text, /NOT_RUNNING/);
  });

  it('perf_script_cost runs + save_as / compare_to: medians before and after a change', async () => {
    // a big change (a quarter of the work): a starved sampler (CI) undercounts both sides, by up to 3x
    libMs = 200;
    let r = await c.call('perf_script_cost', { url: `${base}/`, runs: 3, settle_ms: 300, save_as: 'before' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /3 loads \+ 300 ms each: median [\d.]+ ms busy/, r.text);
    assert.match(r.text, /page script lib\.js: [\d.]+ ms · [\d.]+ ms · MO .* · \[[\d.]+–[\d.]+\]/, r.text);
    assert.match(r.text, /baseline "before" saved \(3 load\(s\)\)/);
    libMs = 50; // the "fix": lib.js does a quarter of the work (still enough for a starved sampler to see)
    r = await c.call('perf_script_cost', { url: `${base}/`, runs: 3, settle_ms: 300, compare_to: 'before' });
    assert.ok(!r.isError, r.text);
    const m = /page script lib\.js: ([\d.]+) -> ([\d.]+) ms \(-[\d.]+ ms, -(\d+)%\)/.exec(r.text);
    assert.ok(m, r.text);
    assert.ok(Number(m![1]) >= 25 && Number(m![3]) >= 25, r.text);
    assert.match((await c.call('perf_script_cost', { compare_to: 'nope' })).text, /NO_BASELINE/);
    libMs = 100;
  });

  it('perf_memory: the tab\'s window and the content scripts in it', async () => {
    const r = await c.call('perf_memory', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^http:\/\/127\.0\.0\.1:\d+\/(\?again)? \(content process pid \d+\): window [\d.]+ (KB|MB)/, r.text);
    assert.match(r.text, /JS: page/);
    assert.match(r.text, /extension content scripts in this page:\n(.*\n)* +[\d.]+ (KB|MB) {2}extension (uBlock Origin|Violentmonkey)/, r.text);
    assert.match(r.text, /process: resident [\d.]+ MB/);
  });
});
