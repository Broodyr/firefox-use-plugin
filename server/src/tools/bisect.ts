// bisect: which of claude-dev's extensions / userscripts / prefs / extension storage keys make a test
// fail? Delta debugging (ddmin) over those items: every probe is a fresh headless throwaway copy of claude-dev with
// all its extensions, where the items outside the probe's subset are switched off before the test runs. claude-dev
// itself is never touched.
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { workspace } from '../config.js';
import { fail } from '../errors.js';
import * as XS from '../browser/extScripts.js';
import { resolveExtension } from '../browser/realms.js';
import { parseMeta, vmScripts } from '../adapters/violentmonkey.js';
import { loadTestFile, parseTest, runTest, type Child, type TestFile } from './regress.js';
import { tool } from './registry.js';

interface Item { kind: 'extension' | 'userscript' | 'pref' | 'storage'; id: string; label: string; extension?: string }

const CORE = new Set(['uBlock0@raymondhill.net', '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}', 'companion@firefox-use']);

/** Turn off every item not in `keep` (in the probe's child backend). */
async function disableOthers(c: Child, all: Item[], keep: Set<Item>): Promise<string[]> {
  const notes: string[] = [];
  const off = all.filter((i) => !keep.has(i));
  for (const i of off) {
    let r: { ok: boolean; text: string };
    if (i.kind === 'extension') r = await c.call('addons_set_enabled', { extension: i.id, enabled: false });
    else if (i.kind === 'userscript') r = await c.call('us_set_enabled', { script: i.id, enabled: false });
    else if (i.kind === 'pref') r = await c.call('ff_prefs_set', { values: { [i.id]: null } });
    else r = await c.call('ext_storage_remove', { extension: i.extension!, area: 'local', keys: [i.id] });
    if (!r.ok) notes.push(`  note: could not switch off ${i.label}: ${r.text.split('\n')[0]}`);
  }
  return notes;
}

/** Classic ddmin: a minimal subset of items for which the test still fails. */
async function ddmin(items: Item[], fails: (s: Item[]) => Promise<boolean>, maxSteps: number, log: string[]): Promise<{ set: Item[]; steps: number; complete: boolean }> {
  let set = items;
  let n = 2;
  let steps = 0;
  while (set.length >= 2) {
    const chunk = Math.ceil(set.length / n);
    const parts: Item[][] = [];
    for (let i = 0; i < set.length; i += chunk) parts.push(set.slice(i, i + chunk));
    let reduced = false;
    for (const p of parts) {
      if (steps >= maxSteps) return { set, steps, complete: false };
      steps++;
      if (await fails(p)) { set = p; n = 2; reduced = true; log.push(`  step ${steps}: fails with only ${p.map((x) => x.label).join(', ')}`); break; }
      log.push(`  step ${steps}: passes with only ${p.map((x) => x.label).join(', ')}`);
    }
    if (!reduced && parts.length > 1) {
      for (const p of parts) {
        if (steps >= maxSteps) return { set, steps, complete: false };
        const rest = set.filter((x) => !p.includes(x));
        if (!rest.length || rest.length === set.length) continue;
        steps++;
        if (await fails(rest)) { set = rest; n = Math.max(n - 1, 2); reduced = true; log.push(`  step ${steps}: fails without ${p.map((x) => x.label).join(', ')}`); break; }
        log.push(`  step ${steps}: passes without ${p.map((x) => x.label).join(', ')}`);
      }
    }
    if (!reduced) {
      if (n >= set.length) break;
      n = Math.min(set.length, n * 2);
    }
  }
  return { set, steps, complete: true };
}

export const bisectTools = [
  tool({
    name: 'bisect',
    description: 'Find which of claude-dev\'s extensions, userscripts, prefs or extension-storage keys make a test fail: delta debugging, each probe in a fresh headless throwaway copy of claude-dev (claude-dev is never touched). test = a regression test name (tests/<name>.test.json) or an inline {url, assert:[...]}. Returns the minimal set that still fails and every probe. Slow: one Firefox launch per probe.',
    args: {
      test: z.union([z.string(), z.object({ url: z.string(), steps: z.array(z.record(z.string(), z.any())).optional(), assert: z.array(z.any()).min(1) })]),
      dimensions: z.object({
        extensions: z.boolean().optional().describe('Enabled extensions (except uBO / Violentmonkey: add them with include_core)'),
        include_core: z.boolean().optional(),
        userscripts: z.boolean().optional().describe('Enabled Violentmonkey scripts'),
        prefs: z.array(z.string()).optional().describe('Pref names, reset to default when switched off'),
        ext_storage: z.object({ extension: z.string(), keys: z.array(z.string()).min(1) }).optional().describe('storage.local keys of one extension, removed when switched off'),
      }),
      max_steps: z.number().int().positive().max(64).default(24),
      live: z.boolean().default(false).describe('Real network instead of the test\'s HAR'),
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      // the test
      let t: TestFile;
      if (typeof a.test === 'string') {
        const f = path.join(workspace(), 'tests', a.test.endsWith('.test.json') ? a.test : `${a.test}.test.json`);
        if (!fs.existsSync(f)) fail('TEST_NOT_FOUND', `no ${path.relative(workspace(), f)}`);
        t = loadTestFile(f);
      } else t = parseTest({ name: 'inline', cases: [{ url: a.test.url, steps: a.test.steps ?? [], assert: a.test.assert }] });
      // the items, from claude-dev's current state
      const items: Item[] = [];
      const d = a.dimensions;
      if (d.extensions) {
        const list = await b.callChrome<any[]>(XS.ADDONS_LIST);
        for (const x of list) if (x.active && !x.temporary && (d.include_core || !CORE.has(x.id))) items.push({ kind: 'extension', id: x.id, label: `ext ${x.name}` });
      }
      if (d.userscripts) {
        for (const s of await vmScripts(b)) if (s.enabled && !s.removed) items.push({ kind: 'userscript', id: s.name, label: `userscript ${s.name}` });
        // the test's own setup userscripts (installed in each probe from the workspace)
        for (const f of t.setup.userscripts) {
          const name = parseMeta(fs.readFileSync(path.resolve(workspace(), f), 'utf8').replace(/\r\n?/g, '\n'))?.meta.name;
          if (name && !items.some((i) => i.kind === 'userscript' && i.id === name)) items.push({ kind: 'userscript', id: name, label: `userscript ${name} (${f})` });
        }
      }
      for (const p of d.prefs ?? []) items.push({ kind: 'pref', id: p, label: `pref ${p}` });
      if (d.ext_storage) {
        const ext = await resolveExtension(b, d.ext_storage.extension);
        for (const k of d.ext_storage.keys) items.push({ kind: 'storage', id: k, extension: ext.id, label: `${ext.name} storage ${k}` });
      }
      if (!items.length) fail('BAD_ARGS', 'no items to bisect over', 'Pick dimensions that have enabled items in claude-dev.');
      const log: string[] = [];
      let probes = 0;
      const t0 = Date.now();
      const probe = async (keep: Item[]): Promise<boolean> => {
        probes++;
        const r = await runTest(t, { headless: true, live: a.live, addons: 'all', prepare: (c) => disableOthers(c, items, new Set(keep)) });
        if (r.setupFailed) fail('BISECT_SETUP', `the test's setup failed in a probe:\n${r.lines.join('\n')}`);
        return !r.pass;
      };
      const withAll = await probe(items);
      log.push(`  all ${items.length} item(s) on: ${withAll ? 'FAILS' : 'passes'}`);
      if (!withAll) return [`the test passes with every item on (${items.length}): nothing to bisect (does it fail in claude-dev for another reason: setup, network, timing?)`, ...log].join('\n');
      const none = await probe([]);
      log.push(`  all items off: ${none ? 'FAILS' : 'passes'}`);
      if (none) return ['the test fails with every item off too: the cause is not among these items', ...log].join('\n');
      const r = await ddmin(items, probe, a.max_steps, log);
      return [
        `${r.complete ? 'minimal failing set' : `stopped after max_steps (${a.max_steps}); smallest failing set so far`}: ${r.set.map((x) => x.label).join(', ')}`,
        `${probes} probe(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s over ${items.length} item(s):`,
        ...log,
      ].join('\n');
    },
  }),
];
