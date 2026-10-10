// regression tests: test_run (each test file in a fresh headless throwaway copy of claude-dev, driven
// through a child backend over MCP stdio: setup -> HAR replay -> cases -> assertions, screenshots of failures),
// test_record (HAR + a suggested test file from the current tab), visual_diff (PNG comparison).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { REPO_ROOT, workspace } from '../config.js';
import { fail } from '../errors.js';
import { stateDir } from '../audit/audit.js';
import { tool, tabArg } from './registry.js';
import { recordResults } from './pins.js';

// ------------------------------------------------------------ test file format
const realmSpec = z.object({ kind: z.enum(['page', 'userscript', 'content', 'extension', 'worker']), extension: z.string().optional(), page: z.string().optional(), script: z.string().optional(), url: z.string().optional() });
const assertion = z.union([
  z.object({ expr: z.string(), realm: realmSpec.optional(), equals: z.any().optional(), name: z.string().optional() }),
  z.object({ selector: z.string(), state: z.enum(['present', 'absent', 'visible', 'hidden']).default('present'), name: z.string().optional() }),
  z.object({ text: z.string(), absent: z.boolean().default(false), name: z.string().optional() }),
  z.object({ console: z.object({ level: z.enum(['debug', 'log', 'info', 'warn', 'error']).default('error'), count: z.number().int().min(0).default(0), pattern: z.string().optional() }), name: z.string().optional() }),
  z.object({ order: z.array(z.string()).min(2), name: z.string().optional() }),
]);
const testFile = z.object({
  name: z.string(),
  recorded_with: z.object({ firefox: z.string().optional(), addons: z.record(z.string(), z.string()).optional() }).optional(),
  setup: z.object({
    userscripts: z.array(z.string()).default([]),
    extensions: z.array(z.object({ local: z.string() })).default([]),
    ext_storage: z.array(z.object({ extension: z.string(), area: z.enum(['local', 'sync', 'session']).default('local'), items: z.record(z.string(), z.any()) })).default([]),
    prefs: z.record(z.string(), z.any()).optional(),
  }).default({ userscripts: [], extensions: [], ext_storage: [] }),
  fixtures: z.object({ har: z.string(), mode: z.enum(['strict', 'fallthrough']).default('strict') }).optional(),
  cases: z.array(z.object({
    name: z.string().optional(),
    url: z.string(),
    steps: z.array(z.record(z.string(), z.any())).default([]),
    assert: z.array(assertion).default([]),
  })).min(1),
});
export type TestFile = z.infer<typeof testFile>;

// ------------------------------------------------------------ child backend
/** A backend on a fresh throwaway profile, driven over MCP stdio (the same tools Claude uses). */
export class Child {
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  readonly stderr: string[] = [];
  constructor(private p: ChildProcess) {
    readline.createInterface({ input: p.stdout! }).on('line', (line) => {
      let m: any; try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
      else if (m.method && m.id !== undefined) this.write({ jsonrpc: '2.0', id: m.id, result: {} });
    });
    p.stderr!.on('data', (d) => { this.stderr.push(String(d)); if (this.stderr.length > 200) this.stderr.shift(); });
  }
  static async start(headless: boolean, addons: 'core' | 'all'): Promise<Child> {
    const args = [path.join(REPO_ROOT, 'server', 'dist', 'index.js'), '--profile-mode=throwaway', ...(headless ? ['--headless'] : [])];
    const p = spawn(process.execPath, args, {
      env: {
        ...process.env, FIREFOX_USE_WORKSPACE: workspace(), FIREFOX_USE_THROWAWAY_ADDONS: addons, FIREFOX_USE_PROXY_PID: '', FIREFOX_USE_NO_ELICIT: '1',
        // its own userscript links and audit (in .firefox-use/test-runs/<time>), not the session's
        FIREFOX_USE_STATE_DIR: path.join(stateDir('test-runs'), new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6)),
        // a throwaway profile holds no lasting state: no scope approvals there
        FIREFOX_USE_ENFORCE_SCOPE: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const c = new Child(p);
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'firefox-use test_run', version: '1' } });
    c.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return c;
  }
  private write(m: unknown) { this.p.stdin!.write(JSON.stringify(m) + '\n'); }
  rpc(method: string, params: unknown, timeoutMs = 120000): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; text: string; images: { data: string }[] }> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    const text = (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    return { ok: !r.isError, text, images: (r.content ?? []).filter((c: any) => c.type === 'image') };
  }
  async close() {
    await this.call('ff_quit', {}).catch(() => {});
    this.p.stdin!.end();
    await new Promise((r) => { const t = setTimeout(r, 5000); this.p.on('exit', () => { clearTimeout(t); r(null); }); });
    if (this.p.exitCode === null) this.p.kill();
  }
}

/** eval output "[realm] (type) <json>" -> value */
function evalValue(text: string): unknown {
  const m = /^\[[^\]]*\] \([^)]*\) ([\s\S]*?)(?:\nauditId: .*)?$/.exec(text);
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return m[1]; }
}

/** Step shorthands: {"wait_for_selector": "#main"}, {"navigate": "url"}, {"eval": "code"}, ... map to the main argument. */
function stepArgs(tool: string, raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  const main: Record<string, string> = { wait_for_selector: 'selector', wait_for_text: 'text', navigate: 'url', eval: 'code', wait_for: 'expr', wait_for_console: 'pattern', wait_for_request: 'url_pattern', click: 'target', type: 'text', key: 'keys' };
  return main[tool] && raw !== undefined ? { [main[tool]]: raw } : {};
}

interface CaseResult { name: string; pass: boolean; lines: string[]; screenshot?: string }

async function runCase(c: Child, t: TestFile, k: TestFile['cases'][number], idx: number): Promise<CaseResult> {
  const name = k.name ?? `case ${idx + 1} ${k.url}`;
  const lines: string[] = [];
  let pass = true;
  const failLine = (s: string) => { pass = false; lines.push(`  ✖ ${s}`); };
  await c.call('console_clear', {});
  const nav = await c.call('navigate', { url: k.url, wait: 'load' });
  if (!nav.ok) failLine(`navigate ${k.url}: ${nav.text.split('\n').slice(0, 2).join(' ')}`);
  for (const [si, step] of k.steps.entries()) {
    const [tool, raw] = Object.entries(step)[0] ?? [];
    if (!tool) continue;
    const r = await c.call(tool, stepArgs(tool, raw));
    if (!r.ok) { failLine(`step ${si + 1} ${tool}: ${r.text.split('\n').slice(0, 2).join(' ')}`); break; }
  }
  // console messages reach the devtools hub in batches: let the last ones arrive before console/order checks
  if (k.assert.some((a) => 'console' in a || 'order' in a)) await new Promise((r) => setTimeout(r, 600));
  for (const a of k.assert) {
    if ('expr' in a) {
      const r = await c.call('eval', { code: a.expr, realm: a.realm ?? { kind: 'page' } });
      const v = r.ok ? evalValue(r.text) : undefined;
      const ok = r.ok && ('equals' in a && a.equals !== undefined ? JSON.stringify(v) === JSON.stringify(a.equals) : !!v && v !== '[undefined]');
      const label = a.name ?? `${a.realm && a.realm.kind !== 'page' ? `[${a.realm.kind}${a.realm.extension ? ` ${a.realm.extension}` : ''}${a.realm.script ? ` ${a.realm.script}` : ''}] ` : ''}${a.expr}`;
      if (ok) lines.push(`  ✔ ${label}`); else failLine(`${label} → ${r.ok ? JSON.stringify(v) : r.text.split('\n')[0]}${'equals' in a && a.equals !== undefined ? ` (expected ${JSON.stringify(a.equals)})` : ''}`);
    } else if ('selector' in a) {
      const r = await c.call('eval', { code: `const el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return 'absent'; const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' ? 'visible' : 'hidden';` });
      const st = evalValue(r.text) as string;
      const ok = a.state === 'present' ? st !== 'absent' : a.state === 'absent' ? st === 'absent' : a.state === 'visible' ? st === 'visible' : st !== 'visible';
      if (ok) lines.push(`  ✔ ${a.name ?? `${a.selector} ${a.state}`}`); else failLine(`${a.name ?? `${a.selector} ${a.state}`} → ${st}`);
    } else if ('text' in a) {
      const r = await c.call('eval', { code: `(document.body ? document.body.innerText : '').includes(${JSON.stringify(a.text)})` });
      const has = evalValue(r.text) === true;
      const ok = a.absent ? !has : has;
      if (ok) lines.push(`  ✔ ${a.name ?? `text ${a.absent ? 'absent' : 'present'}: ${a.text}`}`); else failLine(`${a.name ?? `text ${JSON.stringify(a.text)}`} → ${has ? 'present' : 'absent'}`);
    } else if ('console' in a) {
      // the tested tab (page, its content scripts and userscripts) and extension backgrounds/workers; not the
      // browser's own messages or other tabs
      const q = { level: a.console.level, pattern: a.console.pattern, limit: 500, detail: 'normal', max_chars: 200000 };
      const tabN = Number(/^\* tab (\d+)/m.exec((await c.call('tabs_list', {})).text)?.[1]);
      const r1 = await c.call('console_read', { ...q, sources: ['page', 'content'], ...(tabN ? { tab: tabN } : {}) });
      const r2 = await c.call('console_read', { ...q, sources: ['extension', 'worker'] });
      const r = { text: `${r1.text}
${r2.text}` };
      const entries = r.text.split('\n').filter((l) => /^\d\d:\d\d:\d\d\.\d{3} /.test(l));
      const n = entries.reduce((s, l) => s + Number(/ ×(\d+) /.exec(l)?.[1] ?? 1), 0);
      const label = a.name ?? `console ${a.console.level}${a.console.pattern ? ` /${a.console.pattern}/` : ''} count = ${a.console.count}`;
      if (n === a.console.count) lines.push(`  ✔ ${label}`); else failLine(`${label} → ${n}${entries.length ? `:\n      ${entries.slice(0, 5).join('\n      ')}` : ''}`);
    } else if ('order' in a) {
      const r = await c.call('console_read', { limit: 500, detail: 'summary', max_chars: 400000 });
      const ls = r.text.split('\n');
      const at = (m: string) => {
        const label = m.startsWith('mark:') ? m.slice(5) : m;
        return ls.findIndex((l) => (m.startsWith('mark:') ? l.includes('[claude-mark]') && l.includes(`"label":${JSON.stringify(label)}`) : l.includes(label)));
      };
      const pos = a.order.map(at);
      const ok = pos.every((p) => p >= 0) && pos.every((p, i) => i === 0 || p > pos[i - 1]);
      const label = a.name ?? `order ${a.order.join(' < ')}`;
      if (ok) lines.push(`  ✔ ${label}`); else failLine(`${label} → ${a.order.map((m, i) => `${m}@${pos[i] < 0 ? 'missing' : pos[i]}`).join(', ')}`);
    }
  }
  let screenshot: string | undefined;
  if (!pass) {
    const errs = await c.call('errors_summary', {});
    if (errs.ok && !/no errors/i.test(errs.text)) lines.push(`  errors: ${errs.text.split('\n').slice(0, 6).join('\n    ')}`);
    const shot = await c.call('screenshot', {});
    if (shot.images[0]) {
      screenshot = path.join(stateDir('artifacts'), `test-${t.name.replace(/[^\w.-]+/g, '_')}-${idx + 1}-${Date.now()}.png`);
      fs.writeFileSync(screenshot, Buffer.from(shot.images[0].data, 'base64'));
    }
  }
  return { name, pass, lines, screenshot };
}

/** tests/<name>.test.json files: all, or by name. */
function findTests(names: string[] | 'all'): string[] {
  const dir = path.join(workspace(), 'tests');
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.json')).map((f) => path.join(dir, f)) : [];
  if (names === 'all') return all;
  return names.map((n) => {
    const f = all.find((x) => path.basename(x) === `${n}.test.json` || path.basename(x) === n || x === path.resolve(workspace(), n));
    if (!f) fail('TEST_NOT_FOUND', `no test ${n} in tests/`, `Tests: ${all.map((x) => path.basename(x, '.test.json')).join(', ') || 'none'}`);
    return f!;
  });
}

export interface RunOpts { headless: boolean; live: boolean; addons: 'core' | 'all'; /** bisect: change the profile after setup, before the cases */ prepare?: (c: Child) => Promise<string[]> }

export function loadTestFile(file: string): TestFile { return testFile.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }
export function parseTest(t: unknown): TestFile { return testFile.parse(t); }

export async function runTestFile(file: string, o: RunOpts): Promise<{ name: string; pass: boolean; lines: string[] }> {
  let t: TestFile;
  try { t = loadTestFile(file); } catch (e: any) { return { name: path.basename(file), pass: false, lines: [`  ✖ invalid test file: ${e.message.slice(0, 500)}`] }; }
  return runTest(t, o);
}

export async function runTest(t: TestFile, o: RunOpts): Promise<{ name: string; pass: boolean; lines: string[]; setupFailed?: boolean }> {
  const lines: string[] = [];
  const c = await Child.start(o.headless, o.addons);
  let pass = true;
  try {
    const st = await c.call('ff_status', {});
    if (t.recorded_with?.firefox) {
      const ff = /Firefox (\S+)/.exec(st.text)?.[1];
      if (ff && ff !== t.recorded_with.firefox) lines.push(`  note: recorded with Firefox ${t.recorded_with.firefox}, running ${ff}`);
    }
    for (const [id, v] of Object.entries(t.recorded_with?.addons ?? {})) {
      const m = new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*?(\\d+\\.[\\w.]+)`).exec(st.text);
      if (m && m[1] !== v) lines.push(`  note: ${id} recorded with ${v}, running ${m[1]}`);
    }
    const setupStep = async (label: string, tool: string, args: Record<string, unknown>) => {
      const r = await c.call(tool, args);
      if (!r.ok) { pass = false; lines.push(`  ✖ setup ${label}: ${r.text.split('\n').slice(0, 2).join(' ')}`); }
      return r.ok;
    };
    if (t.setup.prefs && Object.keys(t.setup.prefs).length) await setupStep('prefs', 'ff_prefs_set', { values: t.setup.prefs });
    for (const e of t.setup.extensions) await setupStep(`extension ${e.local}`, 'addons_install_local', { path: e.local });
    for (const s of t.setup.userscripts) await setupStep(`userscript ${s}`, 'us_install', { path: s, mode: 'manager' });
    for (const s of t.setup.ext_storage) await setupStep(`storage of ${s.extension}`, 'ext_storage_set', { extension: s.extension, area: s.area, items: s.items });
    if (t.fixtures && !o.live && pass) await setupStep(`HAR ${t.fixtures.har}`, 'har_replay', { name: t.fixtures.har, mode: t.fixtures.mode });
    if (pass && o.prepare) lines.push(...await o.prepare(c));
    if (!pass) return { name: t.name, pass, lines, setupFailed: true };
    if (pass) {
      for (const [i, k] of t.cases.entries()) {
        const r = await runCase(c, t, k, i);
        if (!r.pass) pass = false;
        lines.push(`${r.pass ? '✔' : '✖'} ${r.name}`, ...r.lines);
        if (r.screenshot) lines.push(`  screenshot: ${path.relative(workspace(), r.screenshot)}`);
      }
    }
    if (t.fixtures && !o.live) {
      const r = await c.call('har_replay_stop', {});
      const un = /(\d+) unmatched/.exec(r.text);
      if (un && Number(un[1]) > 0) lines.push(`  ${t.fixtures.mode === 'strict' ? 'note: requests not in the HAR failed' : 'note: requests not in the HAR went to the network'}:\n    ${r.text.split('\n').slice(2, 10).join('\n    ')}`);
    }
  } catch (e: any) {
    pass = false;
    lines.push(`  ✖ runner: ${e.message}`, ...c.stderr.slice(-5).map((s) => `    ${s.trim().slice(0, 300)}`));
  } finally {
    await c.close().catch(() => {});
  }
  return { name: t.name, pass, lines };
}

async function runFiles(files: string[], o: RunOpts, out: string[]): Promise<{ name: string; pass: boolean }[]> {
  const results: { name: string; pass: boolean }[] = [];
  for (const f of files) {
    const r = await runTestFile(f, o);
    results.push({ name: r.name, pass: r.pass });
    out.push(`${r.pass ? 'PASS' : 'FAIL'} ${r.name} (${path.relative(workspace(), f)})`, ...r.lines.map((l) => `  ${l}`));
  }
  recordResults(results);
  return results;
}

/** Every test, headless, from the HAR fixtures (the version-change re-run). */
export async function runAllTests(): Promise<{ name: string; pass: boolean }[]> {
  return runFiles(findTests('all'), { headless: true, live: false, addons: 'core' }, []);
}

// ------------------------------------------------------------ visual diff
function readPng(p: string): PNG {
  const abs = path.resolve(workspace(), p);
  if (!fs.existsSync(abs)) fail('FILE_NOT_FOUND', abs);
  return PNG.sync.read(fs.readFileSync(abs));
}

export function diffPng(a: PNG, b: PNG, threshold: number): { changed: number; total: number; image: PNG } {
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  const out = new PNG({ width: w, height: h });
  let changed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inA = x < a.width && y < a.height, inB = x < b.width && y < b.height;
      const ia = (y * a.width + x) * 4, ib = (y * b.width + x) * 4;
      let diff = !inA || !inB;
      if (!diff) {
        const d = Math.abs(a.data[ia] - b.data[ib]) + Math.abs(a.data[ia + 1] - b.data[ib + 1]) + Math.abs(a.data[ia + 2] - b.data[ib + 2]);
        diff = d > threshold * 3;
      }
      if (diff) { changed++; out.data[o] = 255; out.data[o + 1] = 0; out.data[o + 2] = 0; out.data[o + 3] = 255; }
      else {
        // unchanged pixels: faded copy of a, so the red areas have context
        const g = inA ? Math.round((a.data[ia] + a.data[ia + 1] + a.data[ia + 2]) / 3) : 255;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = Math.round(200 + g * 55 / 255); out.data[o + 3] = 255;
      }
    }
  }
  return { changed, total: w * h, image: out };
}

export const regressTools = [
  tool({
    name: 'test_run',
    description: 'Run regression tests (tests/<name>.test.json): each file in a fresh headless throwaway copy of claude-dev (only uBO and Violentmonkey active unless addons:"all"), with its setup applied (userscripts, local extensions, extension storage, prefs) and its HAR fixture replayed (or the real network with live:true). Returns pass/fail per case, failing assertions with context, errors, and a screenshot of each failure.',
    args: {
      names: z.union([z.literal('all'), z.array(z.string()).min(1)]).default('all'),
      headless: z.boolean().default(true),
      live: z.boolean().default(false).describe('Use the real network instead of the HAR fixtures'),
      addons: z.enum(['core', 'all']).default('core').describe('core: only uBO + Violentmonkey (+ the test\'s own); all: every extension copied from claude-dev'),
    },
    async handler(a) {
      const files = findTests(a.names);
      if (!files.length) return 'no tests in tests/*.test.json (test_record makes one)';
      const t0 = Date.now();
      const out: string[] = [];
      const results = await runFiles(files, { headless: a.headless, live: a.live, addons: a.addons }, out);
      const passed = results.filter((r) => r.pass).length;
      return [`${passed}/${files.length} test file(s) passed in ${((Date.now() - t0) / 1000).toFixed(1)} s${a.live ? ' (live network)' : ''}`, ...out].join('\n');
    },
  }),
  tool({
    name: 'test_record',
    description: 'Record a regression test from the current tab: loads url while recording a HAR (tests/fixtures/<name>.har), runs the steps, and writes tests/<name>.test.json with suggested assertions (title, headings, marks seen, no console errors) for you to review and edit. Then test_run(["<name>"]).',
    args: {
      name: z.string().min(1).regex(/^[\w.-]+$/),
      url: z.string().min(1),
      steps: z.array(z.record(z.string(), z.any())).default([]).describe('Same format as test cases: [{"click": {"target": "ref_3"}}, {"wait_for_selector": "#done"}]'),
      userscripts: z.array(z.string()).default([]).describe('Workspace userscripts the test should install (setup.userscripts)'),
      extensions: z.array(z.string()).default([]).describe('Local extension folders the test should load (setup.extensions)'),
      tab: tabArg,
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const call = async (n: string, args: Record<string, unknown>) => {
        const r = await ctx.call!(n, args);
        if (!r.ok) fail('STEP_FAILED', `${n}: ${r.text.split('\n').slice(0, 2).join(' ')}`);
        return r.text;
      };
      const file = path.join(workspace(), 'tests', `${a.name}.test.json`);
      if (fs.existsSync(file)) fail('FILE_EXISTS', `tests/${a.name}.test.json exists`, 'Pick another name, or delete the file first.');
      await call('console_clear', {});
      await call('har_record', { name: a.name, url: a.url, tab: a.tab, include_extensions: false });
      for (const step of a.steps) {
        const [tool, raw] = Object.entries(step)[0] ?? [];
        if (tool) await call(tool, stepArgs(tool, raw));
      }
      await new Promise((r) => setTimeout(r, 600)); // console resources (marks) arrive in batches
      const har = await call('har_stop', {});
      const context = await b.context(a.tab);
      const facts = await b.callPage(context, `() => ({ title: document.title, h1: (document.querySelector('h1') || {}).textContent || null })`);
      const marks = (await b.dt()).log.filter((e) => e.text.startsWith('[claude-mark] ')).map((e) => { try { return JSON.parse(e.text.slice(14)).label; } catch { return null; } }).filter(Boolean);
      const asserts: any[] = [{ expr: 'document.title', equals: facts.title }];
      if (facts.h1) asserts.push({ text: String(facts.h1).trim().slice(0, 80) });
      if (marks.length > 1) asserts.push({ order: [...new Set(marks)].slice(0, 5).map((m) => `mark:${m}`) });
      asserts.push({ console: { level: 'error', count: 0 } });
      const v = b.versions ?? await b.versionsInfo();
      const test = {
        name: a.name,
        recorded_with: { firefox: v?.firefox, addons: Object.fromEntries((v?.addons ?? []).filter((x: any) => /uBlock0|aecec67f/.test(x.id)).map((x: any) => [x.id, x.version])) },
        setup: { userscripts: a.userscripts, extensions: a.extensions.map((l) => ({ local: l })), ext_storage: [] },
        fixtures: { har: a.name, mode: 'strict' },
        cases: [{ url: a.url, steps: a.steps, assert: asserts }],
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(test, null, 2) + '\n');
      return { text: [`wrote tests/${a.name}.test.json (review the suggested assertions) and ${har.split('\n')[0].replace(/^wrote /, '')}`, JSON.stringify(test.cases[0].assert, null, 1)].join('\n'), changes: [{ kind: 'file', path: `tests/${a.name}.test.json` }] };
    },
  }),
  tool({
    name: 'visual_diff',
    description: 'Compare two PNG screenshots (paths in the workspace, e.g. .firefox-use/artifacts/*.png from screenshot): percent of pixels changed and a diff image (changed pixels red over a faded copy), saved to .firefox-use/artifacts/ and returned.',
    args: { a: z.string().min(1), b: z.string().min(1), threshold: z.number().int().min(0).max(255).default(16).describe('Per-channel difference that counts as changed') },
    async handler(a) {
      const A = readPng(a.a), B = readPng(a.b);
      const d = diffPng(A, B, a.threshold);
      const out = path.join(stateDir('artifacts'), `diff-${Date.now()}.png`);
      const buf = PNG.sync.write(d.image);
      fs.writeFileSync(out, buf);
      const pct = (100 * d.changed / d.total);
      const size = A.width === B.width && A.height === B.height ? `${A.width}x${A.height}` : `sizes differ: ${A.width}x${A.height} vs ${B.width}x${B.height}`;
      return { text: `${pct.toFixed(2)}% changed (${d.changed} of ${d.total} pixels, ${size}); diff image: ${path.relative(workspace(), out)}`, images: [{ data: buf.toString('base64'), mimeType: 'image/png' }] };
    },
  }),
];
