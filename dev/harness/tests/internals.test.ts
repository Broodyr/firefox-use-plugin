// Firefox internals: every Firefox module the server imports and every gBrowser member it uses is exercised by a
// self-check probe (static, no Firefox); ff_selfcheck passes on this Firefox; the first launch of a lasting profile
// on a new Firefox build runs the self-check once and reports it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { McpClient, NAMED_ARGS, makeHome, namedProfile, startServer } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

describe('Firefox internals', () => {
  it('every Firefox module and gBrowser member the server uses has a self-check probe', async () => {
    // (the dev build: internals.js is a module of its own there, not in the release bundle)
    const { COVERAGE_TEXT } = await import(pathToFileURL(path.join(ROOT, 'server', 'dist', 'browser', 'internals.js')).href);
    const modules = new Map<string, string>(), members = new Map<string, string>();
    for (const f of sources(path.join(ROOT, 'server', 'src'))) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      // module URLs anywhere (also in a list of URLs to try: Mozilla is moving modules from resource:// to moz-src:///)
      for (const m of text.matchAll(/importESModule\(\s*["']([^"']+)["']|["']((?:resource:\/\/gre\/modules|moz-src:\/\/|chrome:\/\/remote\/content)\/[^"']+\.sys\.mjs)["']/g)) {
        const url = m[1] ?? m[2];
        if (!modules.has(url)) modules.set(url, rel);
      }
      for (const m of text.matchAll(/gBrowser\??\.([A-Za-z_$][\w$]*)/g)) if (!members.has(m[1])) members.set(m[1], rel);
    }
    assert.ok(modules.size >= 10 && members.size >= 5, `scan found ${modules.size} modules, ${members.size} gBrowser members`);
    const missing = [
      ...[...modules].filter(([u]) => !COVERAGE_TEXT.includes(u)).map(([u, f]) => `module ${u} (${f})`),
      ...[...members].filter(([m]) => !new RegExp(`\\b${m.replace(/\$/g, '\\$')}\\b`).test(COVERAGE_TEXT)).map(([m, f]) => `gBrowser.${m} (${f})`),
    ];
    assert.deepEqual(missing, [], `add a probe to server/src/browser/internals.ts for:\n${missing.join('\n')}`);
  });

  describe('on this Firefox', () => {
    let c: McpClient, h: ReturnType<typeof makeHome>;
    before(async () => { h = makeHome(); c = await startServer(h.env); });
    after(async () => { await c.close(); h.cleanup(); });

    // TEMPORARY (2026-10-13): which URL jsdebugger.sys.mjs loads from on this Firefox (159 moved it to moz-src)
    it('diagnostic: jsdebugger.sys.mjs URLs', async () => {
      const r = await c.call('eval_privileged', { code: `const out = {}; for (const u of ["moz-src:///devtools/platform/jsdebugger.sys.mjs", "resource://gre/modules/jsdebugger.sys.mjs"]) { try { out[u] = typeof ChromeUtils.importESModule(u).addDebuggerToGlobal; } catch (e) { out[u] = "ERR " + (e && e.message || e); } } return out;` });
      console.log(`[diagnostic] jsdebugger.sys.mjs on this Firefox: ${r.text.replace(/\s+/g, ' ').slice(0, 600)}`);
    });

    it('ff_selfcheck: every internal works', async () => {
      const r = await c.call('ff_selfcheck', {});
      assert.ok(!r.isError, r.text);
      assert.match(r.text, /^(\d+)\/\1 internals OK \(Firefox [\d.]+/, r.text);
      assert.doesNotMatch(r.text, /✖/, r.text);
    });
  });

  describe('at launch', () => {
    let c: McpClient, h: ReturnType<typeof makeHome>;
    before(async () => { h = makeHome(namedProfile); c = McpClient.spawnServer(NAMED_ARGS, h.env); await c.initialize(); });
    after(async () => { await c.close(); h.cleanup(); });

    it('the first launch on a new Firefox build runs the self-check once', async () => {
      let r = await c.call('ff_launch', {});
      assert.ok(!r.isError, r.text);
      assert.doesNotMatch(r.text, /SELF-CHECK|self-check/, 'a passing first check says nothing');
      const file = path.join(h.home, 'run', 'selfcheck.json');
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.match(rec['test-named']?.key ?? '', /^Firefox [\d.]+ \(build \d+\), Violentmonkey /, JSON.stringify(rec));
      assert.deepEqual(rec['test-named'].broken, []);
      // the same build again: no check
      await c.call('ff_quit', {});
      r = await c.call('ff_launch', {});
      assert.doesNotMatch(r.text, /self-check/i, r.text);
      // an "update" since the last check
      rec['test-named'].key = 'Firefox 100.0 (build 1), Violentmonkey 1.0, Stylus none';
      fs.writeFileSync(file, JSON.stringify(rec));
      await c.call('ff_quit', {});
      r = await c.call('ff_launch', {});
      assert.match(r.text, /self-check after the update \(Firefox 100\.0 \(build 1\), [^>]*-> Firefox [\d.]+ \(build \d+\), [^:]*: all \d+ internals OK/, r.text);
    });
  });
});
