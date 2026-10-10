// version pins: .firefox-use/pins.json records the Firefox and add-on versions last accepted. When a
// launch finds other versions, it says so, re-runs every regression test headless in the background, and reports
// the tests that newly fail next to the version change (so a breakage is attributed to the update, not to an edit).
// pins_update accepts the current versions. Test results of every test_run are kept in test-results.json.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { stateDir } from '../audit/audit.js';
import { workspace } from '../config.js';
import type { Browser } from '../browser/session.js';
import { tool } from './registry.js';

export interface Pins { firefox: string; addons: Record<string, string>; at: string }

const pinsFile = () => path.join(stateDir(), 'pins.json');
const resultsFile = () => path.join(stateDir(), 'test-results.json');

export function readPins(): Pins | null { try { return JSON.parse(fs.readFileSync(pinsFile(), 'utf8')); } catch { return null; } }

async function currentVersions(b: Browser): Promise<Pins> {
  const v = await b.versionsInfo();
  return { firefox: v.firefox, addons: Object.fromEntries(v.addons.filter((a: any) => !a.temporary).map((a: any) => [a.id, a.version])), at: new Date().toISOString() };
}

export function diffPins(old: Pins, now: Pins, names: Map<string, string> = new Map()): string[] {
  const out: string[] = [];
  if (old.firefox !== now.firefox) out.push(`Firefox ${old.firefox} -> ${now.firefox}`);
  for (const [id, v] of Object.entries(now.addons)) {
    const n = names.get(id) ?? id;
    if (!(id in old.addons)) out.push(`${n} added (${v})`);
    else if (old.addons[id] !== v) out.push(`${n} ${old.addons[id]} -> ${v}`);
  }
  for (const id of Object.keys(old.addons)) if (!(id in now.addons)) out.push(`${names.get(id) ?? id} removed`);
  return out;
}

/** Per-test pass/fail of the latest run (test_run writes it). */
export function readResults(): Record<string, { pass: boolean; at: string }> { try { return JSON.parse(fs.readFileSync(resultsFile(), 'utf8')); } catch { return {}; } }
export function recordResults(r: { name: string; pass: boolean }[]) {
  const all = readResults();
  for (const x of r) all[x.name] = { pass: x.pass, at: new Date().toISOString() };
  fs.writeFileSync(resultsFile(), JSON.stringify(all, null, 1));
}

interface PinsState { changes: string[]; tests: 'none' | 'running' | 'done'; summary?: string; newlyFailing?: string[] }

/**
 * At launch of a lasting profile: first launch writes the baseline; a change is reported and the tests re-run.
 * The test run goes in the background (it launches its own throwaway Firefoxes); ff_status reports it.
 */
export async function pinsAtLaunch(b: Browser, runAll: () => Promise<{ name: string; pass: boolean }[]>): Promise<string | null> {
  const now = await currentVersions(b);
  const old = readPins();
  if (!old) { fs.writeFileSync(pinsFile(), JSON.stringify(now, null, 1)); return `pins.json written (baseline: Firefox ${now.firefox}, ${Object.keys(now.addons).length} add-on(s))`; }
  const names = new Map<string, string>((b.versions?.addons ?? []).map((a: any) => [a.id, a.name]));
  const changes = diffPins(old, now, names);
  if (!changes.length) return null;
  const st: PinsState = { changes, tests: 'none' };
  b.adapters.set('pins', st);
  const testsDir = path.join(workspace(), 'tests');
  const hasTests = fs.existsSync(testsDir) && fs.readdirSync(testsDir).some((f) => f.endsWith('.test.json'));
  if (hasTests) {
    st.tests = 'running';
    const before = readResults();
    void runAll().then((r) => {
      st.tests = 'done';
      st.newlyFailing = r.filter((x) => !x.pass && before[x.name]?.pass !== false).map((x) => x.name);
      st.summary = `${r.filter((x) => x.pass).length}/${r.length} test file(s) pass`;
    }, (e) => { st.tests = 'done'; st.summary = `test run failed: ${e?.message ?? e}`; });
  }
  return `versions changed since pins.json: ${changes.join('; ')}${hasTests ? ' — re-running the regression tests headless (ff_status shows the result; pins_update accepts the new versions)' : ' (pins_update accepts them)'}`;
}

/** Lines for ff_status. */
export function pinsStatus(b: Browser): string[] {
  const st = b.adapters.get('pins') as PinsState | undefined;
  if (!st) return [];
  const out = [`version change since pins.json: ${st.changes.join('; ')}`];
  if (st.tests === 'running') out.push('  regression tests: running after the version change…');
  if (st.tests === 'done') out.push(`  regression tests after the change: ${st.summary}${st.newlyFailing?.length ? ` · NEWLY FAILING: ${st.newlyFailing.join(', ')} (likely the update, not an edit)` : ''}`);
  return out;
}

export const pinsTools = [
  tool({
    name: 'pins_update',
    description: 'Accept the current Firefox and add-on versions as the new baseline in .firefox-use/pins.json (after a version change was reported and checked). Without accept:true, shows the differences.',
    args: { accept: z.boolean().default(false) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const now = await currentVersions(b);
      const old = readPins();
      const names = new Map<string, string>((b.versions?.addons ?? []).map((x: any) => [x.id, x.name]));
      const changes = old ? diffPins(old, now, names) : ['no pins.json yet'];
      if (!a.accept) return changes.length ? `differences from pins.json:\n${changes.map((c) => `  ${c}`).join('\n')}\n(pins_update accept:true makes the current versions the baseline)` : 'pins.json matches the running versions';
      fs.writeFileSync(pinsFile(), JSON.stringify(now, null, 1));
      b.adapters.delete('pins');
      return { text: `pins.json updated: Firefox ${now.firefox}, ${Object.keys(now.addons).length} add-on(s)${changes.length ? ` (${changes.join('; ')})` : ''}`, changes: [{ kind: 'file', path: '.firefox-use/pins.json', before: old, after: now }] };
    },
  }),
];
