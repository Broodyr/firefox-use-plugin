// Every undocumented Firefox internal the server's privileged code relies on, in one place: the snippets that
// reach them (shared, so a Firefox change is fixed once) and a probe per internal that uses it the way the tools
// do, without side effects. ff_selfcheck runs the probes (and the first launch on a new Firefox build does), and
// internals.test.ts fails when the server imports a Firefox module or calls a gBrowser member no probe exercises.
// Mozilla makes no compatibility promise for any of this: a probe that only checks `typeof` passed on Firefox 158
// while the tracer it stood for listed no scripts at all.
import { EXT, MANIFEST_VALIDATE, STORAGE } from './extScripts.js';
import { TRACER_PROBE } from './loadtrace.js';
import { MSGLOG_INSTALL } from './msglog.js';

/** Prelude: `Nav`, the remote agent's map between BiDi context ids and browsers (NavigableManager; TabManager before). */
export const NAV = `
  let Nav;
  try { Nav = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs").NavigableManager; } catch {}
  if (!Nav?.getIdForBrowser) Nav = ChromeUtils.importESModule("chrome://remote/content/shared/TabManager.sys.mjs").TabManager;
  if (!Nav?.getIdForBrowser || !Nav?.getBrowsingContextById) throw new Error("remote agent internals changed: no getIdForBrowser/getBrowsingContextById in NavigableManager or TabManager");
`;

/** Prelude: `tt`, WebExtension tab ids <-> tabs (the ids uBO and tabs.* use). */
export const TAB_TRACKER = `
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tt = ExtensionParent.apiManager?.global?.tabTracker;
  if (typeof tt?.getId !== "function" || typeof tt?.getTab !== "function") throw new Error("extension internals changed: no tabTracker.getId/getTab");
`;

/**
 * Prelude: `RecommendedPreferences` and `recommended` ([name, value] pairs), the remote agent's automation prefs,
 * parsed from its module source (the list isn't exported). Throws when the source no longer has the list.
 */
export const RECOMMENDED = `
  const { RecommendedPreferences } = ChromeUtils.importESModule("chrome://remote/content/shared/RecommendedPreferences.sys.mjs");
  const src = await (await fetch("chrome://remote/content/shared/RecommendedPreferences.sys.mjs")).text();
  const start = src.indexOf("const COMMON_PREFERENCES");
  if (start < 0 || !RecommendedPreferences || typeof RecommendedPreferences.applyPreferences !== "function" || typeof RecommendedPreferences.alteredPrefs?.has !== "function") throw new Error("RecommendedPreferences internals changed");
  const block = src.slice(start, src.indexOf("]);", start));
  const recommended = [];
  for (const m of block.matchAll(/\\[\\s*"([^"]+)",\\s*(true|false|-?\\d+|"(?:[^"\\\\]|\\\\.)*")\\s*,?\\s*\\]/g)) recommended.push([m[1], JSON.parse(m[2])]);
`;

/** A privileged function: `({ id, path }) => true | "<what is broken>"` (id: an installed extension to read, path: its folder). */
export interface Probe { feature: string; code: string }

const WIN = `const w = Services.wm.getMostRecentWindow("navigator:browser"); if (!w) return "no browser window";`;
/** The extension to probe with: the one asked for if it runs, else any running non-privileged one. */
const PICK_EXT = `id = WebExtensionPolicy.getByID(id) ? id : WebExtensionPolicy.getActiveExtensions().find((p) => !p.isPrivileged)?.id; if (!id) return "no running extension to probe with";`;

export const PROBES: Probe[] = [
  {
    feature: 'tab handles (NavigableManager)',
    code: `() => { ${NAV} ${WIN}
      const br = w.gBrowser.selectedTab.linkedBrowser;
      const id = Nav.getIdForBrowser(br);
      const bc = id && Nav.getBrowsingContextById(id);
      return (!!bc && bc.top.embedderElement === br) || "context id round trip failed (" + id + ")"; }`,
  },
  {
    feature: 'tab groups and tab moves (gBrowser)',
    code: `() => { ${WIN}
      const g = w.gBrowser;
      const bad = ["addTabGroup", "getTabGroupById", "moveTabToExistingGroup", "adoptTab", "removeTab", "getTabForBrowser"].filter((k) => typeof g[k] !== "function");
      if (typeof g.tabs?.find !== "function") bad.push("tabs");
      if (typeof g.tabGroups?.find !== "function") bad.push("tabGroups");
      if (!g.selectedTab || g.getTabForBrowser(g.selectedTab.linkedBrowser) !== g.selectedTab) bad.push("selectedTab/getTabForBrowser");
      return !bad.length || "gBrowser changed: " + bad.join(", "); }`,
  },
  {
    feature: 'read_page (accessibility tree of the parent process)',
    code: `() => { ${WIN}
      const svc = window.__cfA11y = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);
      const doc = svc.getAccessibleFor(w.document);
      if (!doc) return "no accessible for the browser window";
      // the calls read_page makes per node, on a button of the browser's own toolbar
      let hit = null, n = 0;
      const find = (a) => { if (hit || !a || n++ > 5000) return; if (svc.getStringRole(a.role) === "pushbutton" && a.name) { hit = a; return; } for (let c = a.firstChild; c; c = c.nextSibling) find(c); };
      find(doc);
      if (!hit) return "no button in the browser window's accessibility tree (" + n + " nodes)";
      const bad = [];
      if (typeof hit.computedARIARole !== "string" || !hit.computedARIARole) bad.push("computedARIARole");
      try { const x = {}, y = {}, ww = {}, h = {}; hit.getBoundsInCSSPixels(x, y, ww, h); if (typeof ww.value !== "number") bad.push("getBoundsInCSSPixels"); } catch (e) { bad.push("getBoundsInCSSPixels: " + e.message); }
      try { const st = {}, ex = {}; hit.getState(st, ex); if (typeof st.value !== "number") bad.push("getState"); } catch (e) { bad.push("getState: " + e.message); }
      if (hit.uniqueID === undefined) bad.push("uniqueID");
      if (typeof hit.attributes?.getStringProperty !== "function") bad.push("attributes");
      try { if (typeof doc.QueryInterface(Ci.nsIAccessibleDocument).URL !== "string") bad.push("nsIAccessibleDocument.URL"); } catch (e) { bad.push("nsIAccessibleDocument: " + e.message); }
      return !bad.length || "accessibility API changed: " + bad.join(", "); }`,
  },
  {
    feature: 'extension storage (ExtensionStorageIDB, ExtensionStorage, session, sync)',
    code: `async ({ id }) => { ${PICK_EXT} ${EXT} ${STORAGE}
      await (await area.local()).get(null);
      await (await area.session()).get(null);
      const { extensionStorageSync } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageSync.sys.mjs");
      const bad = ["get", "set", "remove"].filter((k) => typeof extensionStorageSync[k] !== "function");
      if (typeof ExtensionStorageIDB.notifyListeners !== "function") bad.push("ExtensionStorageIDB.notifyListeners");
      return !bad.length || "storage API changed: " + bad.join(", "); }`,
  },
  {
    feature: 'userScripts grant (ExtensionPermissions)',
    code: `async ({ id }) => { ${PICK_EXT}
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const have = await ExtensionPermissions.get(id);
      return (Array.isArray(have?.permissions) && typeof ExtensionPermissions.add === "function") || "ExtensionPermissions changed"; }`,
  },
  {
    feature: 'ext_dev_lint / hot reload (ExtensionData manifest validation)',
    code: `async ({ path }) => {
      const v = await (${MANIFEST_VALIDATE})({ path });
      return (!v.thrown && !!v.name && !!v.version) || "manifest validation changed: " + JSON.stringify(v).slice(0, 300); }`,
  },
  {
    feature: 'leftover automation prefs (RecommendedPreferences)',
    code: `async () => { ${RECOMMENDED} return recommended.length >= 5 || "only " + recommended.length + " recommended prefs parsed"; }`,
  },
  { feature: 'trace_load tracer and breakpoint columns (Debugger API)', code: TRACER_PROBE },
  {
    feature: 'orphan BiDi session cleanup (RemoteAgent)',
    code: `() => { const { RemoteAgent } = ChromeUtils.importESModule("chrome://remote/content/components/RemoteAgent.sys.mjs"); return typeof RemoteAgent.webDriverBiDi?.deleteSession === "function" || "deleteSession missing"; }`,
  },
  {
    feature: 'uBO logger tab ids (ExtensionParent tabTracker)',
    code: `() => { ${TAB_TRACKER} ${WIN}
      const t = w.gBrowser.selectedTab;
      const tid = tt.getId(t);
      return tt.getTab(tid, null) === t || "tab id round trip failed (" + tid + ")"; }`,
  },
  {
    feature: 'managed storage (NativeManifests.lookupManifest)',
    code: `() => { const { NativeManifests } = ChromeUtils.importESModule("resource://gre/modules/NativeManifests.sys.mjs"); return typeof NativeManifests.lookupManifest === "function" || "lookupManifest missing"; }`,
  },
  {
    feature: 'downloads guard (Downloads lists)',
    code: `async () => {
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      const list = await Downloads.getList(Downloads.ALL);
      return (typeof list.addView === "function" && Array.isArray(await list.getAll())) || "Downloads list API changed"; }`,
  },
  {
    feature: 'foreground hand-back and clipboard owner (ctypes, native window handle)',
    code: `() => {
      if (Services.appinfo.OS !== "WINNT") return true;
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const u = ctypes.open("user32.dll");
      try { u.declare("GetForegroundWindow", ctypes.winapi_abi, ctypes.voidptr_t)(); } finally { u.close(); }
      ${WIN}
      const h = w.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
      return typeof h === "string" || "no native window handle"; }`,
  },
  {
    feature: 'add-on list and versions (AddonManager)',
    code: `async ({ id }) => { ${PICK_EXT}
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const a = (await AddonManager.getAddonsByTypes(["extension"])).find((x) => x.id === id);
      if (!a) return "the running extension " + id + " is not in AddonManager's list";
      const bad = ["version", "locationName", "temporarilyInstalled", "applyBackgroundUpdates", "isActive", "hidden"].filter((k) => !(k in a));
      if (typeof AddonManager.getAddonByID !== "function" || typeof AddonManager.installTemporaryAddon !== "function") bad.push("AddonManager methods");
      return !bad.length || "AddonWrapper changed: " + bad.join(", "); }`,
  },
  {
    feature: 'extension policies (WebExtensionPolicy)',
    code: `({ id }) => { ${PICK_EXT}
      const p = WebExtensionPolicy.getByID(id);
      return (!!p.extension && typeof p.mozExtensionHostname === "string" && WebExtensionPolicy.getActiveExtensions().length > 0) || "WebExtensionPolicy changed"; }`,
  },
  {
    feature: 'perf_profile / perf_memory (Gecko profiler, memory reporters)',
    code: `() => {
      const bad = ["StartProfiler", "StopProfiler", "IsActive", "getProfileDataAsync", "getProfileDataAsGzippedArrayBuffer"].filter((k) => typeof Services.profiler?.[k] !== "function");
      if (typeof Cc["@mozilla.org/memory-reporter-manager;1"]?.getService(Ci.nsIMemoryReporterManager).getReports !== "function") bad.push("memory reporters");
      return !bad.length || "profiler API changed: " + bad.join(", "); }`,
  },
  {
    feature: 'site_data_clear (Services.clearData)',
    code: `() => (typeof Services.clearData?.deleteDataFromSite === "function" && typeof Services.clearData.deleteDataFromPrincipal === "function") || "clearData API changed"`,
  },
];

/**
 * Probe sources for internals.test.ts: the chrome probes plus the internals that ff_selfcheck exercises another
 * way (the messaging-log hook, through a message the companion sends).
 */
export const COVERAGE_TEXT = [...PROBES.map((p) => p.code), MSGLOG_INSTALL].join('\n');
