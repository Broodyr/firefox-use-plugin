// ff_selfcheck: every undocumented Firefox internal the plugin relies on, probed in a few seconds, so a Firefox
// update says which features broke at launch (the first launch on a new build runs it) instead of failing mid-task.
// The chrome probes live with the snippets they check (browser/internals.ts); here also the devtools hub, the
// debugger, the messaging log (a real message from the companion) and the adapters.
import fs from 'node:fs';
import path from 'node:path';
import { STYLUS_ID, stylusApi } from '../adapters/stylus.js';
import { loadConfig } from '../config.js';
import { tool } from './registry.js';
import type { Browser } from '../browser/session.js';
import { FIRST_STATEMENT, debuggerFor, debuggerIfRunning } from '../browser/debugger.js';
import { VM_ID, vmScripts } from '../adapters/violentmonkey.js';
import { PROBES } from '../browser/internals.js';
import { TRACER_PROBE, evalInContentProcess } from '../browser/loadtrace.js';
import { msglogProbe } from '../browser/msglog.js';
import { COMPANION_DIR, COMPANION_ID, compCall } from '../adapters/companion.js';

export async function runSelfcheck(b: Browser): Promise<{ ok: string[]; broken: string[] }> {
  const ok: string[] = [], broken: string[] = [];
  const add = (name: string, r: unknown) => (r === true ? ok.push(name) : broken.push(`${name}: ${r}`));
  for (const p of PROBES) add(p.feature, await b.callChrome(p.code, { id: COMPANION_ID, path: COMPANION_DIR }).catch((e) => String(e.message)));
  add('trace_load tracer and breakpoint columns (Debugger API, in a content process)', await b.dt().then((d) => evalInContentProcess(d, `String((${TRACER_PROBE})())`)).then((r) => r === 'true' || String(r), (e) => String(e.message)));
  add('messaging log (ProxyMessenger conduit hook)', await msglogProbe(b, COMPANION_ID, () => compCall(b, 'try { await browser.runtime.sendMessage({ __ffSelfcheck: 1 }); } catch (e) {} return true;')).catch((e) => String(e.message)));
  // devtools hub and the debugger connection (breakpoints, positions, first-statement event)
  add('console/network/realms (devtools hub)', await b.dt().then((d) => !d.dead || 'hub down', (e) => String(e.message)));
  const started = !debuggerIfRunning(b);
  try {
    const d = await debuggerFor(b);
    const cat = await d.eventCatalogue();
    add('debugger (watcher, breakpoint list, event breakpoints)', cat.some((e) => e.id === FIRST_STATEMENT) || 'no script first-statement event');
  } catch (e: any) { add('debugger (watcher, breakpoint list, event breakpoints)', e.message); }
  finally { const d = debuggerIfRunning(b); if (started && d && d.idle) { b.adapters.delete('debugger'); d.close(); } }
  // Violentmonkey commands (manager mode)
  add('Violentmonkey commands (GetData)', await vmScripts(b).then(() => true, (e) => String(e.message)));
  // Stylus's API (only when it is installed and on: it is optional)
  if (await b.callChrome<boolean>(`({ id }) => !!WebExtensionPolicy.getByID(id)`, { id: STYLUS_ID }).catch(() => false)) {
    const probe = ['/* ==UserStyle==', '@name selfcheck', '@namespace selfcheck', '@version 1', '==/UserStyle== */', '@-moz-document domain("example.com") { a { color: red } }'].join('\n');
    add('Stylus API (styles.getCore, usercss.build)', await stylusApi(b, 'styles.getCore', [{ id: -1 }]).then(() => stylusApi(b, 'usercss.build', [probe, { metaOnly: true }])).then(() => true, (e) => String(e.message)));
  }
  return { ok, broken };
}

/**
 * At the launch of a lasting profile: run the self-check when Firefox's build (or Violentmonkey's / Stylus's
 * version, which the adapter probes use) differs from the last passing check for this profile, recorded in the
 * run dir (run/selfcheck.json), so the first launch after any update checks once, whatever the workspace. A
 * failing check is not recorded as passed: it runs (and is reported) again at each launch until it passes.
 */
export async function selfcheckAtLaunch(b: Browser, profile: string): Promise<string | null> {
  const v = b.versions ?? await b.versionsInfo();
  const addon = (id: string) => v.addons?.find((a: any) => a.id === id)?.version ?? 'none';
  const key = `Firefox ${v.firefox} (build ${v.buildId}), Violentmonkey ${addon(VM_ID)}, Stylus ${addon(STYLUS_ID)}`;
  const file = path.join(loadConfig().runDir, 'selfcheck.json');
  let rec: Record<string, { key: string; at: string; broken: string[] }> = {};
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first check */ }
  const prev = rec[profile];
  if (prev?.key === key && !prev.broken.length) return null;
  const sc = await runSelfcheck(b).catch((e) => ({ ok: [] as string[], broken: [`self-check failed: ${e?.message ?? e}`] }));
  rec[profile] = { key, at: new Date().toISOString(), broken: sc.broken };
  try { fs.writeFileSync(file, JSON.stringify(rec, null, 1)); } catch { /* run dir not writable: check again next launch */ }
  if (sc.broken.length) return `SELF-CHECK on ${key}: ${sc.broken.length} feature(s) broken (tools that use them fail or return less): ${sc.broken.join('; ')}`;
  return prev && prev.key !== key ? `self-check after the update (${prev.key} -> ${key}): all ${sc.ok.length} internals OK` : null;
}

export const selfcheckTools = [
  tool({
    name: 'ff_selfcheck',
    description: 'Check every Firefox/extension internal the plugin depends on (tab handles, tab groups, accessibility, extension storage, debugger, tracer, messaging log, Violentmonkey commands, Stylus API, ...). Runs automatically after a Firefox update; use it when a tool fails with "internals changed".',
    args: {},
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const r = await runSelfcheck(b);
      return [`${r.ok.length}/${r.ok.length + r.broken.length} internals OK${r.broken.length ? '' : ' (Firefox ' + (b.versions?.firefox ?? '?') + ')'}`, ...r.broken.map((x) => `✖ ${x}`), ...r.ok.map((x) => `✔ ${x}`)].join('\n');
    },
  }),
];
