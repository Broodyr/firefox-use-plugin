// ff_selfcheck: every undocumented Firefox internal the plugin relies on, probed in a few seconds, so a Firefox
// update says which features broke at launch (pins detect the version change) instead of failing mid-task.
import { STYLUS_ID, stylusApi } from '../adapters/stylus.js';
import { tool } from './registry.js';
import type { Browser } from '../browser/session.js';
import { FIRST_STATEMENT, debuggerFor, debuggerIfRunning } from '../browser/debugger.js';
import { vmScripts } from '../adapters/violentmonkey.js';

/** [feature, privileged probe returning true or an error text] */
const CHROME_PROBES: [string, string][] = [
  ['tab handles (NavigableManager)', `() => { const { NavigableManager: N } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs"); return typeof N.getBrowsingContextById === "function" && typeof N.getIdForBrowser === "function" || "NavigableManager API changed"; }`],
  ['tab groups (gBrowser.addTabGroup)', `() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); return typeof w.gBrowser.addTabGroup === "function" && typeof w.gBrowser.getTabGroupById === "function" || "tab group API changed"; }`],
  ['read_page (accessibility service)', `() => !!Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService) || "no accessibility service"`],
  ['extension storage (ExtensionStorageIDB)', `() => { const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs"); return typeof ExtensionStorageIDB.open === "function" || "ExtensionStorageIDB.open missing"; }`],
  ['userScripts grant (ExtensionPermissions)', `() => { const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs"); return typeof ExtensionPermissions.add === "function" || "ExtensionPermissions.add missing"; }`],
  ['ext_dev_lint (ExtensionData.loadManifest)', `() => { const { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs"); return typeof ExtensionData.prototype.loadManifest === "function" || "loadManifest missing"; }`],
  ['messaging log (BroadcastConduit._recv)', `() => { const { BroadcastConduit } = ChromeUtils.importESModule("resource://gre/modules/ConduitsParent.sys.mjs"); return typeof BroadcastConduit.prototype._recv === "function" || "_recv missing"; }`],
  ['leftover automation prefs (RecommendedPreferences)', `async () => { const { RecommendedPreferences: R } = ChromeUtils.importESModule("chrome://remote/content/shared/RecommendedPreferences.sys.mjs"); const src = await (await fetch("chrome://remote/content/shared/RecommendedPreferences.sys.mjs")).text(); return (R && typeof R.alteredPrefs?.has === "function" && typeof R.applyPreferences === "function" && src.includes("const COMMON_PREFERENCES")) || "RecommendedPreferences changed"; }`],
  ['trace_load tracer (Debugger in a fresh compartment)', `() => { const { addDebuggerToGlobal } = ChromeUtils.importESModule("resource://gre/modules/jsdebugger.sys.mjs"); const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { freshCompartment: true }); addDebuggerToGlobal(sb); return typeof sb.Debugger === "function" && typeof ChromeUtils.dateNow === "function" || "Debugger/dateNow missing"; }`],
  ['orphan BiDi session cleanup (RemoteAgent)', `() => { const { RemoteAgent } = ChromeUtils.importESModule("chrome://remote/content/components/RemoteAgent.sys.mjs"); return typeof RemoteAgent.webDriverBiDi?.deleteSession === "function" || "deleteSession missing"; }`],
];

export async function runSelfcheck(b: Browser): Promise<{ ok: string[]; broken: string[] }> {
  const ok: string[] = [], broken: string[] = [];
  const add = (name: string, r: unknown) => (r === true ? ok.push(name) : broken.push(`${name}: ${r}`));
  for (const [name, fn] of CHROME_PROBES) add(name, await b.callChrome(fn).catch((e) => String(e.message)));
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
