import { createRequire as __cfCreateRequire } from 'node:module'; const require = __cfCreateRequire(import.meta.url);
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// server/src/browser/client.ts
import { AsyncLocalStorage } from "node:async_hooks";
function clientWorkspace() {
  return als.getStore()?.workspace;
}
var als;
var init_client = __esm({
  "server/src/browser/client.ts"() {
    "use strict";
    als = new AsyncLocalStorage();
  }
});

// server/src/config.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
function loadConfig() {
  const configFile = path.join(HOME, "config.json");
  let mtime = 0;
  try {
    mtime = fs.statSync(configFile).mtimeMs;
  } catch {
  }
  if (cached && mtime === cachedMtime) return cached;
  cachedMtime = mtime;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
  }
  cached = {
    firefoxPath: file.firefoxPath && fs.existsSync(file.firefoxPath) ? file.firefoxPath : detectFirefox(),
    profiles: file.profiles ?? {},
    addonsDir: file.addonsDir ?? path.join(HOME, "addons"),
    sandboxDir: file.sandboxDir ?? path.join(HOME, "sandbox"),
    runDir: file.runDir ?? RUN_DIR,
    mainProfile: file.mainProfile,
    syncAddonsFromMainProfile: file.syncAddonsFromMainProfile,
    idleQuitMinutes: file.idleQuitMinutes,
    throwawayAddons: process.env.FIREFOX_USE_THROWAWAY_ADDONS ?? file.throwawayAddons,
    approvalDialog: file.approvalDialog,
    personalProfile: file.personalProfile,
    driftReport: file.driftReport,
    agentWindow: file.agentWindow,
    liveView: file.liveView
  };
  return cached;
}
function detectFirefox() {
  if (process.platform === "win32") {
    for (const hive of ["HKLM", "HKCU"]) {
      try {
        const out = execFileSync("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe`, "/ve"], { encoding: "utf8", windowsHide: true });
        const m = /REG_SZ\s+(.+)$/m.exec(out);
        if (m && fs.existsSync(m[1].trim())) return m[1].trim();
      } catch {
      }
    }
    for (const p of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      const c = p && path.join(p, "Mozilla Firefox", "firefox.exe");
      if (c && fs.existsSync(c)) return c;
    }
  }
  for (const c of ["/usr/bin/firefox", "/Applications/Firefox.app/Contents/MacOS/firefox"]) if (fs.existsSync(c)) return c;
  return "firefox";
}
function workspace() {
  const routed = clientWorkspace();
  if (routed) return routed;
  return process.env.FIREFOX_USE_WORKSPACE ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}
function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function detectMainProfile() {
  const ini = path.join(process.env.APPDATA ?? "", "Mozilla", "Firefox", "profiles.ini");
  let text;
  try {
    text = fs.readFileSync(ini, "utf8");
  } catch {
    return null;
  }
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^\[(.+)\]$/.exec(line);
    if (h) sections.push({ __name: h[1] });
    else {
      const kv = /^([^=]+)=(.*)$/.exec(line);
      if (kv && sections.length) sections[sections.length - 1][kv[1]] = kv[2];
    }
  }
  const rel = sections.find((s) => s.__name.startsWith("Install"))?.Default ?? sections.find((s) => s.Name === "default-release")?.Path;
  if (!rel) return null;
  const dir = path.isAbsolute(rel) ? rel : path.join(path.dirname(ini), rel);
  const dev = loadConfig().profiles["claude-dev"];
  if (dev && path.resolve(dev).toLowerCase() === path.resolve(dir).toLowerCase()) return null;
  return fs.existsSync(dir) ? dir : null;
}
var REPO_ROOT, VERSION, HOME, TOKEN_FILE, RUN_DIR, THROWAWAY_DIR, cached, cachedMtime;
var init_config = __esm({
  "server/src/config.ts"() {
    "use strict";
    init_client();
    REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
    HOME = process.env.FIREFOX_USE_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "firefox-use");
    TOKEN_FILE = path.join(HOME, "token");
    RUN_DIR = path.join(HOME, "run");
    THROWAWAY_DIR = path.join(HOME, "throwaway");
    cached = null;
    cachedMtime = -1;
  }
});

// server/src/safety/mask.ts
var init_mask = __esm({
  "server/src/safety/mask.ts"() {
    "use strict";
  }
});

// server/src/audit/audit.ts
import fs2 from "node:fs";
import path2 from "node:path";
function stateDir(...parts) {
  if (process.env.FIREFOX_USE_STATE_DIR) return ensureDir(path2.join(process.env.FIREFOX_USE_STATE_DIR, ...parts));
  const base = path2.join(workspace(), ".firefox-use");
  if (!fs2.existsSync(base)) {
    ensureDir(base);
    fs2.writeFileSync(path2.join(base, ".gitignore"), "*\n!.gitignore\n!pins.json\n");
  }
  return ensureDir(path2.join(base, ...parts));
}
var init_audit = __esm({
  "server/src/audit/audit.ts"() {
    "use strict";
    init_config();
    init_mask();
  }
});

// server/src/errors.ts
var init_errors = __esm({
  "server/src/errors.ts"() {
    "use strict";
  }
});

// server/src/browser/extScripts.ts
var MANIFEST_VALIDATE, AM, EXT, ADDONS_LIST, ADDON_FIND, ADDON_SET_ENABLED, ADDON_RELOAD, ADDON_UNINSTALL_TEMP, EXT_WAKE, STORAGE, EXT_STORAGE_GET, EXT_STORAGE_HASHES, BG_READY, EXT_STORAGE_SET, EXT_STORAGE_REMOVE, EXT_FILE_LIST, EXT_FILES, EXT_READ, EXT_GREP, ADDON_STATES;
var init_extScripts = __esm({
  "server/src/browser/extScripts.ts"() {
    "use strict";
    MANIFEST_VALIDATE = `async ({ path }) => {
  const { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  const data = new ExtensionData(Services.io.newFileURI(new FileUtils.File(path)));
  let manifest = null, thrown = null;
  try { manifest = await data.loadManifest(); } catch (e) { thrown = String(e && e.message || e); }
  const m = manifest || data.manifest || {};
  return { thrown, errors: (data.errors || []).map(String), warnings: (data.warnings || []).map(String), id: data.id || null, name: m.name || null, version: m.version || null, mv: m.manifest_version || null };
}`;
    AM = `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");`;
    EXT = `
  const pol = WebExtensionPolicy.getByID(id);
  const ext = pol && pol.extension;
  if (!ext) throw new Error("extension " + id + " is not running (disabled or not installed); addons_set_enabled it first");
`;
    ADDONS_LIST = `async () => {
  ${AM}
  const all = await AddonManager.getAddonsByTypes(["extension"]);
  return all.filter((a) => !a.isSystem && !a.isBuiltin && !a.hidden).map((a) => {
    const pol = WebExtensionPolicy.getByID(a.id);
    return {
      id: a.id, name: a.name, version: a.version, active: a.isActive, userDisabled: a.userDisabled,
      temporary: !!a.temporarilyInstalled, uuid: pol ? pol.mozExtensionHostname : null,
      baseURL: pol ? "moz-extension://" + pol.mozExtensionHostname + "/" : null, rootURI: pol ? pol.baseURL : null, autoUpdate: a.applyBackgroundUpdates, signed: a.signedState,
      location: a.locationName, mv: pol ? pol.manifestVersion : null,
      background: pol && pol.extension ? (pol.extension.backgroundWorkerScript ? 'worker' : pol.extension.persistentBackground === false ? 'event page' : (pol.extension.backgroundScripts || pol.extension.manifest?.background?.page) ? 'page' : 'none') : null,
      options: pol && pol.extension ? (pol.extension.manifest.options_ui?.page || pol.extension.manifest.options_page || null) : null,
    };
  });
}`;
    ADDON_FIND = `async ({ q }) => {
  ${AM}
  const all = (await AddonManager.getAddonsByTypes(["extension"])).filter((a) => !a.isSystem && !a.isBuiltin && !a.hidden);
  const exact = all.find((a) => a.id === q);
  if (exact) return { id: exact.id, name: exact.name, active: exact.isActive };
  const ql = String(q).toLowerCase();
  let byName = all.filter((a) => a.name.toLowerCase().includes(ql));
  if (!byName.length) byName = all.filter((a) => a.id.toLowerCase().includes(ql));
  if (byName.length === 1) return { id: byName[0].id, name: byName[0].name, active: byName[0].isActive };
  return { error: byName.length ? "ambiguous: " + byName.map((a) => a.name + " (" + a.id + ")").join(", ") : "no add-on matching " + q, candidates: all.map((a) => a.name + " (" + a.id + ")") };
}`;
    ADDON_SET_ENABLED = `async ({ id, enabled }) => {
  ${AM}
  const a = await AddonManager.getAddonByID(id);
  if (!a) throw new Error("no add-on " + id);
  const before = a.isActive;
  if (enabled && !a.isActive) await a.enable();
  if (!enabled && a.isActive) await a.disable();
  return { before, after: a.isActive };
}`;
    ADDON_RELOAD = `async ({ id }) => {
  ${AM}
  const a = await AddonManager.getAddonByID(id);
  if (!a) throw new Error("no add-on " + id);
  if (a.temporarilyInstalled && typeof a.reload === "function") { await a.reload(); return "reloaded (temporary add-on)"; }
  await a.disable({ allowSystemAddons: false });
  await a.enable();
  return "reloaded (disable + enable)";
}`;
    ADDON_UNINSTALL_TEMP = `async ({ id }) => {
  ${AM}
  const a = await AddonManager.getAddonByID(id);
  if (!a) return false;
  if (!a.temporarilyInstalled) throw new Error(id + " is not a temporary add-on; refusing to uninstall it");
  await a.uninstall();
  return true;
}`;
    EXT_WAKE = `async ({ id }) => {
  ${EXT}
  if (ext.backgroundState === "running" || !ext.wakeupBackground) return ext.backgroundState || "running";
  try { await Promise.race([ext.wakeupBackground(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
  return ext.backgroundState || "unknown";
}`;
    STORAGE = `
  const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const { ExtensionStorage, extensionStorageSession } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorage.sys.mjs");
  const plain = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      let x = v;
      try { if (x && typeof x.deserialize === "function") x = x.deserialize(globalThis); } catch { x = "[unreadable]"; }
      out[k] = x;
    }
    return out;
  };
  const area = {
    async local() {
      if (ExtensionStorageIDB.isMigratedExtension(ext)) {
        const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(ext));
        return {
          get: async (keys) => plain(await db.get(keys)),
          set: async (items) => { const ch = await db.set(items); if (ch) ExtensionStorageIDB.notifyListeners(id, ch); return ch; },
          remove: async (keys) => { const ch = await db.remove(keys); if (ch) ExtensionStorageIDB.notifyListeners(id, ch); return ch; },
        };
      }
      return {
        get: async (keys) => plain(await ExtensionStorage.get(id, keys)),
        set: async (items) => ExtensionStorage.set(id, items),
        remove: async (keys) => ExtensionStorage.remove(id, keys),
      };
    },
    async session() {
      return {
        get: async (keys) => plain(await extensionStorageSession.get(ext, keys)),
        set: async (items) => extensionStorageSession.set(ext, items),
        remove: async (keys) => extensionStorageSession.remove(ext, keys),
      };
    },
    async sync() {
      const { extensionStorageSync } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageSync.sys.mjs");
      return {
        get: async (keys) => plain(await extensionStorageSync.get(ext, keys, null)),
        set: async (items) => extensionStorageSync.set(ext, items, null),
        remove: async (keys) => extensionStorageSync.remove(ext, keys, null),
      };
    },
  };
`;
    EXT_STORAGE_GET = `async ({ id, area: which, keys, sizesOnly, skip }) => {
  ${EXT}
  ${STORAGE}
  const s = await area[which]();
  const all = await s.get(keys && keys.length ? keys : null);
  const re = skip ? new RegExp(skip) : null;
  const out = {}, sizes = {}, skipped = [];
  for (const [k, v] of Object.entries(all)) {
    let n = 0; try { n = JSON.stringify(v)?.length ?? 0; } catch { n = -1; }
    sizes[k] = n;
    if (re && re.test(k)) { skipped.push(k); continue; }
    if (!sizesOnly) out[k] = v;
  }
  return sizesOnly ? { sizes } : { values: out, sizes, skipped };
}`;
    EXT_STORAGE_HASHES = `async ({ id, keys, strip }) => {
  ${EXT}
  ${STORAGE}
  const s = await area.local();
  const all = await s.get(keys);
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (typeof v !== "string") continue;
    let t = v;
    const i = t.indexOf(strip[0]), j = i >= 0 ? t.indexOf(strip[1], i) : -1;
    if (i >= 0 && j >= 0) t = t.slice(0, i) + t.slice(j + strip[1].length);
    t = t.replace(/\\r\\n?/g, "\\n");
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
    out[k] = [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }
  return out;
}`;
    BG_READY = `
  if (ext.manifest?.background && ext.backgroundState !== "running" && typeof ext.promiseBackgroundStarted === "function") {
    try { await Promise.race([ext.promiseBackgroundStarted(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
  }
`;
    EXT_STORAGE_SET = `async ({ id, area: which, items }) => {
  ${EXT}
  ${STORAGE}
  ${BG_READY}
  const s = await area[which]();
  const before = await s.get(Object.keys(items));
  await s.set(items);
  return { before };
}`;
    EXT_STORAGE_REMOVE = `async ({ id, area: which, keys }) => {
  ${EXT}
  ${STORAGE}
  ${BG_READY}
  const s = await area[which]();
  const before = await s.get(keys);
  await s.remove(keys);
  return { before };
}`;
    EXT_FILE_LIST = `
  const pol = WebExtensionPolicy.getByID(id); const ext = pol && pol.extension;
  if (!ext) throw new Error("extension " + id + " is not running (disabled or not installed)");
  const root = ext.rootURI;
  const files = [];
  if (root.schemeIs("jar")) {
    const jarFile = root.QueryInterface(Ci.nsIJARURI).JARFile.QueryInterface(Ci.nsIFileURL).file;
    const zr = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zr.open(jarFile);
    try {
      const en = zr.findEntries(null);
      while (en.hasMore()) { const e = en.getNext(); if (!e.endsWith("/") && !e.startsWith("META-INF/")) files.push([e, zr.getEntry(e).realSize]); }
    } finally { zr.close(); }
  } else {
    const base = root.QueryInterface(Ci.nsIFileURL).file.path;
    const walk = async (dir) => {
      for (const c of await IOUtils.getChildren(dir)) {
        const st = await IOUtils.stat(c);
        if (st.type === "directory") await walk(c);
        else files.push([c.slice(base.length + 1).replace(/\\\\/g, "/"), st.size]);
      }
    };
    await walk(base);
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const read = async (p) => { const r = await fetch(pol.getURL(p)); if (!r.ok) throw new Error(p + ": HTTP " + r.status); return await r.text(); };
`;
    EXT_FILES = `async ({ id, prefix }) => {
  ${EXT_FILE_LIST}
  return { root: root.spec, files: prefix ? files.filter((f) => f[0].startsWith(prefix)) : files };
}`;
    EXT_READ = `async ({ id, path }) => {
  ${EXT_FILE_LIST}
  if (!files.some((f) => f[0] === path)) return { missing: true, near: files.map((f) => f[0]).filter((f) => f.includes(path.split("/").pop())).slice(0, 10) };
  return { text: await read(path) };
}`;
    EXT_GREP = `async ({ id, source, flags, prefix, ctx, max }) => {
  ${EXT_FILE_LIST}
  const re = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  const out = []; let scanned = 0, total = 0;
  for (const [p, size] of files) {
    if (prefix && !p.startsWith(prefix)) continue;
    if (!/\\.(m?js|json|html?|css|txt|md|xml|svg)$/i.test(p) || size > 8e6) continue;
    const text = await read(p); scanned++;
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      total++;
      if (out.length < max) {
        const i = m.index;
        const line = text.slice(0, i).split("\\n").length;
        const col = i - text.lastIndexOf("\\n", i - 1);
        out.push({ file: p, line, col, snippet: text.slice(Math.max(0, i - ctx), i + m[0].length + ctx).replace(/\\s*\\n\\s*/g, " \u23CE ") });
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return { matches: out, total, scanned };
}`;
    ADDON_STATES = `async () => {
  ${AM}
  const all = await AddonManager.getAddonsByTypes(["extension"]);
  const src = (a) => { try { const u = a.temporarilyInstalled && WebExtensionPolicy.getByID(a.id)?.baseURL; return u && u.startsWith("file:") ? Services.io.newURI(u).QueryInterface(Ci.nsIFileURL).file.path : (u || null); } catch { return null; } };
  return Object.fromEntries(all.filter((a) => !a.isSystem && !a.isBuiltin && !a.hidden).map((a) => [a.id, { active: a.isActive, version: a.version, temporary: !!a.temporarilyInstalled, name: a.name, ...(a.temporarilyInstalled ? { source: src(a) } : {}) }]));
}`;
  }
});

// server/src/transports/privileged.ts
var PROTECTED_PREFS, PROTECTED_SNAPSHOT;
var init_privileged = __esm({
  "server/src/transports/privileged.ts"() {
    "use strict";
    init_errors();
    PROTECTED_PREFS = /^(devtools\.debugger\.|remote\.|security\.|xpinstall\.|devtools\.chrome\.enabled$|signon\.)/;
    PROTECTED_SNAPSHOT = `() => {
  const out = {};
  const re = ${PROTECTED_PREFS.toString()};
  for (const n of Services.prefs.getChildList("")) {
    if (!re.test(n)) continue;
    const t = Services.prefs.getPrefType(n);
    try {
      out[n] = [Services.prefs.prefHasUserValue(n), t === 32 ? Services.prefs.getStringPref(n) : t === 64 ? Services.prefs.getIntPref(n) : t === 128 ? Services.prefs.getBoolPref(n) : null, t];
    } catch { out[n] = [false, null, t]; }
  }
  return out;
}`;
  }
});

// server/src/browser/scope.ts
var init_scope = __esm({
  "server/src/browser/scope.ts"() {
    "use strict";
    init_errors();
  }
});

// server/src/browser/loadtrace.ts
var ADD_DEBUGGER, LINE_OF, INSTALL, TRACER_PROBE;
var init_loadtrace = __esm({
  "server/src/browser/loadtrace.ts"() {
    "use strict";
    ADD_DEBUGGER = `
  const addDebuggerToGlobal = (() => {
    const errs = [];
    for (const url of ["moz-src:///devtools/platform/jsdebugger.sys.mjs", "resource://gre/modules/jsdebugger.sys.mjs"]) {
      try {
        const m = ChromeUtils.importESModule(url);
        if (typeof m.addDebuggerToGlobal === "function") return m.addDebuggerToGlobal;
        errs.push(url + ": no addDebuggerToGlobal");
      } catch (e) { errs.push(url + ": " + (e && e.message || e)); }
    }
    throw new Error("jsdebugger.sys.mjs could not be loaded (" + errs.join("; ") + ")");
  })();
`;
    LINE_OF = `(script, offset) => script.getOffsetMetadata(offset).lineNumber`;
    INSTALL = `(() => {
  const L = globalThis.__cfLoadTrace;
  if (L) { L.log.length = 0; L.errors = 0; L.firstError = null; L.on = true; L.attach(); return 'ok'; }
  ${ADD_DEBUGGER}
  const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { freshCompartment: true });
  addDebuggerToGlobal(sb);
  const dbg = new sb.Debugger();
  const now = typeof ChromeUtils.dateNow === "function" ? () => ChromeUtils.dateNow() : () => Date.now();
  const T = globalThis.__cfLoadTrace = { dbg, log: [], on: true, errors: 0, firstError: null };
  const lineOf = ${LINE_OF};
  const content = (g) => { try { return !Cu.getObjectPrincipal(g.unsafeDereference()).isSystemPrincipal; } catch (e) { return false; } };
  // document events on the tracer's clock (exact): system-group capture listeners on each new content window,
  // which the page can't see or stop; rows [time, event, 0, document URL, "dom", "Window"]
  const docEvents = (g) => {
    let w;
    try { if (g.class !== "Window") return; w = g.unsafeDereference(); } catch (e) { return; }
    if (!w || typeof w.addEventListener !== "function") return;
    const href = () => { try { return String(w.location.href); } catch (e) { return null; } };
    const rec = (what) => { if (T.on && T.log.length < 5000) T.log.push([now(), what, 0, href(), "dom", "Window"]); };
    const opts = { capture: true, mozSystemGroup: true };
    try {
      rec("document created");
      w.addEventListener("DOMContentLoaded", (e) => { if (e.target === w.document) rec("DOMContentLoaded"); }, opts);
      w.addEventListener("load", (e) => { if (e.target === w.document) rec("load"); }, opts);
      w.addEventListener("readystatechange", (e) => { if (e.target === w.document) rec("readyState " + w.document.readyState); }, opts);
    } catch (e) {}
  };
  T.attach = () => {
    dbg.addAllGlobalsAsDebuggees();
    for (const g of dbg.getDebuggees()) if (!content(g)) dbg.removeDebuggee(g);
    dbg.onNewGlobalObject = (g) => { if (T.on && content(g)) { try { dbg.addDebuggee(g); } catch (e) {} docEvents(g); } };
    dbg.onEnterFrame = (frame) => {
      if (!T.on || frame.older || (frame.type !== 'global' && frame.type !== 'module' && frame.type !== 'eval')) return;
      try {
        const src = frame.script.source;
        const url = src.displayURL || src.url || null;
        let href = null;
        const cls = frame.script.global.class;
        try { const g = frame.script.global.unsafeDereference(); href = String(g.location ? g.location.href : ''); } catch (e) {}
        const line = lineOf(frame.script, frame.offset);
        if (T.log.length < 5000) T.log.push([now(), url, line, href, frame.type, cls]);
      } catch (e) {
        // counted and reported, never silent: a Debugger API change must not look like "no scripts ran"
        T.errors++;
        if (!T.firstError) T.firstError = String(e && e.message || e);
      }
    };
  };
  T.attach();
  return 'ok';
})()`;
    TRACER_PROBE = `() => {
  ${ADD_DEBUGGER}
  const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { freshCompartment: true });
  addDebuggerToGlobal(sb);
  if (typeof sb.Debugger !== "function" || typeof ChromeUtils.dateNow !== "function") return "Debugger/dateNow missing";
  const dbg = new sb.Debugger();
  const target = Cu.Sandbox("http://selfcheck.invalid", { freshCompartment: true });
  const lineOf = ${LINE_OF};
  let got = null;
  try {
    dbg.addDebuggee(target);
    dbg.onEnterFrame = (frame) => {
      if (got || frame.older) return;
      try {
        const src = frame.script.source;
        got = { url: src.displayURL || src.url, line: lineOf(frame.script, frame.offset), type: frame.type, cls: frame.script.global.class };
      } catch (e) { got = { error: String(e && e.message || e) }; }
    };
    Cu.evalInSandbox("var selfcheck = 1;", target, null, "selfcheck-probe.js", 7);
    if (!got) return "onEnterFrame never fired";
    if (got.error) return "frame inspection failed: " + got.error;
    if (got.url !== "selfcheck-probe.js" || got.line !== 7) return "unexpected frame " + JSON.stringify(got);
    // the debugger's breakpoint columns (debugger.ts firstBreakable) use the same Debugger.Script API
    const fn = Cu.evalInSandbox("(function () {\\n  var a = 1;\\n})", target, null, "selfcheck-bp.js", 1);
    const script = dbg.addDebuggee(target).makeDebuggeeValue(fn).script;
    const cols = script.getPossibleBreakpoints({ line: 2 }).map((p) => p.columnNumber);
    if (!cols.length || typeof script.getChildScripts !== "function") return "breakpoint positions changed: " + JSON.stringify(cols);
    return true;
  } catch (e) { return "Debugger API failed: " + (e && e.message || e); }
  finally { dbg.onEnterFrame = undefined; dbg.removeAllDebuggees(); Cu.nukeSandbox(target); }
}`;
  }
});

// server/src/browser/msglog.ts
var MSGLOG_INSTALL;
var init_msglog = __esm({
  "server/src/browser/msglog.ts"() {
    "use strict";
    init_errors();
    init_mask();
    MSGLOG_INSTALL = `({ ids }) => {
  const { BroadcastConduit } = ChromeUtils.importESModule("resource://gre/modules/ConduitsParent.sys.mjs");
  const proto = BroadcastConduit.prototype;
  const base = proto._recv;
  if (typeof base !== "function") throw new Error("BroadcastConduit._recv not found in this Firefox (internals changed)");
  let L = proto.__cfMsgLog;
  if (!L) {
    L = proto.__cfMsgLog = { ids: new Set(), log: [], ports: new Map(), errors: 0, firstError: null };
    const text = (holder, v) => {
      try { const x = holder && typeof holder.deserialize === "function" ? holder.deserialize(globalThis, true) : v; const s = JSON.stringify(x); return s === undefined ? String(x) : s; } catch (e) { return "[" + (e && e.message || "unserializable") + "]"; }
    };
    const who = (s) => {
      if (!s) return "?";
      const path = String(s.url || "").replace(/^moz-extension:\\/\\/[^/]+/, "");
      if (s.envType === "content_child") return "content " + String(s.url || "").slice(0, 80);
      if (s.envType === "addon_child") return /background|_generated_background_page/.test(path) ? "background" : "page " + path;
      return (s.envType || "?") + " " + path;
    };
    const push = (id, kind, from, to, t) => { if (!L.ids.has(id)) return; L.log.push({ id, ts: Date.now(), kind, from, to, text: String(t).slice(0, 2000) }); if (L.log.length > 2000) L.log.shift(); };
    proto._recv = function (name, arg, meta) {
      const p = base.apply(this, arguments);
      if (this.id !== "ProxyMessenger") return p;
      try {
        const s = meta && meta.sender;
        if (name === "RuntimeMessage") {
          const id = (arg && arg.extensionId) || (s && s.extensionId) || (s && s.id);
          const to = arg && arg.query && arg.query.tabId != null ? "content tab#" + arg.query.tabId : arg && arg.tabId != null ? "content tab#" + arg.tabId : "extension pages";
          push(id, "message", who(s), to, text(arg && arg.holder));
          if (p && typeof p.then === "function") p.then((r) => push(id, "response", to, who(s), text(r, r)), (e) => push(id, "error", to, who(s), String(e && e.message || e)));
        } else if (name === "PortConnect") {
          const id = (arg && arg.extensionId) || (s && s.extensionId) || (s && s.id);
          if (arg && arg.portId != null) L.ports.set(arg.portId, { id, name: arg.name || "" });
          push(id, "connect", who(s), "port \\"" + (arg && arg.name || "") + "\\"", "");
        } else if (name === "PortMessage") {
          const port = s && L.ports.get(s.portId);
          const id = (port && port.id) || (s && s.extensionId) || (s && s.id);
          push(id, "port", who(s), "port \\"" + (port ? port.name : "?") + "\\"", text(arg && arg.holder));
        }
      } catch (e) {
        // counted and shown by ext_dev_inspect: a changed message shape must not look like "no messages"
        L.errors++;
        if (!L.firstError) L.firstError = String(e && e.message || e);
      }
      return p;
    };
  }
  for (const id of ids) L.ids.add(id);
  return [...L.ids];
}`;
  }
});

// server/src/browser/internals.ts
var NAV, TAB_TRACKER, RECOMMENDED, WIN, PICK_EXT, PROBES, COVERAGE_TEXT;
var init_internals = __esm({
  "server/src/browser/internals.ts"() {
    "use strict";
    init_extScripts();
    init_loadtrace();
    init_msglog();
    NAV = `
  const { NavigableManager: Nav } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  if (typeof Nav?.getIdForBrowser !== "function" || typeof Nav?.getBrowsingContextById !== "function") throw new Error("remote agent internals changed: no NavigableManager.getIdForBrowser/getBrowsingContextById");
`;
    TAB_TRACKER = `
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tt = ExtensionParent.apiManager?.global?.tabTracker;
  if (typeof tt?.getId !== "function" || typeof tt?.getTab !== "function") throw new Error("extension internals changed: no tabTracker.getId/getTab");
`;
    RECOMMENDED = `
  const { RecommendedPreferences } = ChromeUtils.importESModule("chrome://remote/content/shared/RecommendedPreferences.sys.mjs");
  const src = await (await fetch("chrome://remote/content/shared/RecommendedPreferences.sys.mjs")).text();
  const start = src.indexOf("const COMMON_PREFERENCES");
  if (start < 0 || !RecommendedPreferences || typeof RecommendedPreferences.applyPreferences !== "function" || typeof RecommendedPreferences.alteredPrefs?.has !== "function") throw new Error("RecommendedPreferences internals changed");
  const block = src.slice(start, src.indexOf("]);", start));
  const recommended = [];
  for (const m of block.matchAll(/\\[\\s*"([^"]+)",\\s*(true|false|-?\\d+|"(?:[^"\\\\]|\\\\.)*")\\s*,?\\s*\\]/g)) recommended.push([m[1], JSON.parse(m[2])]);
`;
    WIN = `const w = Services.wm.getMostRecentWindow("navigator:browser"); if (!w) return "no browser window";`;
    PICK_EXT = `id = WebExtensionPolicy.getByID(id) ? id : WebExtensionPolicy.getActiveExtensions().find((p) => !p.isPrivileged)?.id; if (!id) return "no running extension to probe with";`;
    PROBES = [
      {
        feature: "tab handles (NavigableManager)",
        code: `() => { ${NAV} ${WIN}
      const br = w.gBrowser.selectedTab.linkedBrowser;
      const id = Nav.getIdForBrowser(br);
      const bc = id && Nav.getBrowsingContextById(id);
      return (!!bc && bc.top.embedderElement === br) || "context id round trip failed (" + id + ")"; }`
      },
      {
        feature: "tab groups and tab moves (gBrowser)",
        code: `() => { ${WIN}
      const g = w.gBrowser;
      const bad = ["addTabGroup", "getTabGroupById", "adoptTab", "removeTab", "getTabForBrowser"].filter((k) => typeof g[k] !== "function");
      if (typeof w.customElements.get("tab-group")?.prototype?.addTabs !== "function") bad.push("tab-group addTabs");
      if (typeof g.tabs?.find !== "function") bad.push("tabs");
      if (!g.selectedTab || g.getTabForBrowser(g.selectedTab.linkedBrowser) !== g.selectedTab) bad.push("selectedTab/getTabForBrowser");
      return !bad.length || "gBrowser changed: " + bad.join(", "); }`
      },
      {
        feature: "read_page (accessibility tree of the parent process)",
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
      return !bad.length || "accessibility API changed: " + bad.join(", "); }`
      },
      {
        feature: "extension storage (ExtensionStorageIDB, ExtensionStorage, session, sync)",
        code: `async ({ id }) => { ${PICK_EXT} ${EXT} ${STORAGE}
      await (await area.local()).get(null);
      await (await area.session()).get(null);
      const { extensionStorageSync } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageSync.sys.mjs");
      const bad = ["get", "set", "remove"].filter((k) => typeof extensionStorageSync[k] !== "function");
      if (typeof ExtensionStorageIDB.notifyListeners !== "function") bad.push("ExtensionStorageIDB.notifyListeners");
      return !bad.length || "storage API changed: " + bad.join(", "); }`
      },
      {
        feature: "userScripts grant (ExtensionPermissions)",
        code: `async ({ id }) => { ${PICK_EXT}
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const have = await ExtensionPermissions.get(id);
      return (Array.isArray(have?.permissions) && typeof ExtensionPermissions.add === "function") || "ExtensionPermissions changed"; }`
      },
      {
        feature: "ext_dev_lint / hot reload (ExtensionData manifest validation)",
        code: `async ({ path }) => {
      const v = await (${MANIFEST_VALIDATE})({ path });
      return (!v.thrown && !!v.name && !!v.version) || "manifest validation changed: " + JSON.stringify(v).slice(0, 300); }`
      },
      {
        feature: "leftover automation prefs (RecommendedPreferences)",
        code: `async () => { ${RECOMMENDED} return recommended.length >= 5 || "only " + recommended.length + " recommended prefs parsed"; }`
      },
      {
        feature: "orphan BiDi session cleanup (RemoteAgent)",
        code: `() => { const { RemoteAgent } = ChromeUtils.importESModule("chrome://remote/content/components/RemoteAgent.sys.mjs"); return typeof RemoteAgent.webDriverBiDi?.deleteSession === "function" || "deleteSession missing"; }`
      },
      {
        feature: "uBO logger tab ids (ExtensionParent tabTracker)",
        code: `() => { ${TAB_TRACKER} ${WIN}
      const t = w.gBrowser.selectedTab;
      const tid = tt.getId(t);
      return tt.getTab(tid, null) === t || "tab id round trip failed (" + tid + ")"; }`
      },
      {
        feature: "managed storage (NativeManifests.lookupManifest)",
        code: `() => { const { NativeManifests } = ChromeUtils.importESModule("resource://gre/modules/NativeManifests.sys.mjs"); return typeof NativeManifests.lookupManifest === "function" || "lookupManifest missing"; }`
      },
      {
        feature: "downloads guard (Downloads lists)",
        code: `async () => {
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      const list = await Downloads.getList(Downloads.ALL);
      return (typeof list.addView === "function" && Array.isArray(await list.getAll())) || "Downloads list API changed"; }`
      },
      {
        feature: "foreground hand-back and clipboard owner (ctypes, native window handle)",
        code: `() => {
      if (Services.appinfo.OS !== "WINNT") return true;
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const u = ctypes.open("user32.dll");
      try { u.declare("GetForegroundWindow", ctypes.winapi_abi, ctypes.voidptr_t)(); } finally { u.close(); }
      ${WIN}
      const h = w.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
      return typeof h === "string" || "no native window handle"; }`
      },
      {
        feature: "add-on list and versions (AddonManager)",
        code: `async ({ id }) => { ${PICK_EXT}
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const a = (await AddonManager.getAddonsByTypes(["extension"])).find((x) => x.id === id);
      if (!a) return "the running extension " + id + " is not in AddonManager's list";
      const bad = ["version", "locationName", "temporarilyInstalled", "applyBackgroundUpdates", "isActive", "hidden"].filter((k) => !(k in a));
      if (typeof AddonManager.getAddonByID !== "function" || typeof AddonManager.installTemporaryAddon !== "function") bad.push("AddonManager methods");
      return !bad.length || "AddonWrapper changed: " + bad.join(", "); }`
      },
      {
        feature: "extension policies (WebExtensionPolicy)",
        code: `({ id }) => { ${PICK_EXT}
      const p = WebExtensionPolicy.getByID(id);
      return (!!p.extension && typeof p.mozExtensionHostname === "string" && WebExtensionPolicy.getActiveExtensions().length > 0) || "WebExtensionPolicy changed"; }`
      },
      {
        feature: "perf_profile / perf_memory (Gecko profiler, memory reporters)",
        code: `() => {
      const bad = ["StartProfiler", "StopProfiler", "IsActive", "getProfileDataAsync", "getProfileDataAsGzippedArrayBuffer"].filter((k) => typeof Services.profiler?.[k] !== "function");
      if (typeof Cc["@mozilla.org/memory-reporter-manager;1"]?.getService(Ci.nsIMemoryReporterManager).getReports !== "function") bad.push("memory reporters");
      return !bad.length || "profiler API changed: " + bad.join(", "); }`
      },
      {
        feature: "site_data_clear (Services.clearData)",
        code: `() => (typeof Services.clearData?.deleteDataFromSite === "function" && typeof Services.clearData.deleteDataFromPrincipal === "function") || "clearData API changed"`
      }
    ];
    COVERAGE_TEXT = [...PROBES.map((p) => p.code), MSGLOG_INSTALL, TRACER_PROBE].join("\n");
  }
});

// server/src/browser/serialize.ts
var AsyncFunction;
var init_serialize = __esm({
  "server/src/browser/serialize.ts"() {
    "use strict";
    AsyncFunction = Object.getPrototypeOf(async function() {
    }).constructor;
  }
});

// server/src/browser/domTree.ts
var init_domTree = __esm({
  "server/src/browser/domTree.ts"() {
    "use strict";
  }
});

// server/src/browser/resolve.ts
var init_resolve = __esm({
  "server/src/browser/resolve.ts"() {
    "use strict";
    init_errors();
    init_domTree();
  }
});

// server/src/transports/bidi.ts
var init_bidi = __esm({
  "server/src/transports/bidi.ts"() {
    "use strict";
    init_errors();
  }
});

// server/src/browser/launcher.ts
var init_launcher = __esm({
  "server/src/browser/launcher.ts"() {
    "use strict";
    init_config();
    init_errors();
    init_bidi();
  }
});

// server/src/browser/realms.ts
var init_realms = __esm({
  "server/src/browser/realms.ts"() {
    "use strict";
    init_errors();
    init_privileged();
    init_scope();
    init_extScripts();
    init_internals();
    init_serialize();
    init_resolve();
    init_launcher();
  }
});

// server/src/adapters/companion.ts
import path3 from "node:path";
var COMPANION_DIR;
var init_companion = __esm({
  "server/src/adapters/companion.ts"() {
    "use strict";
    init_config();
    init_errors();
    init_realms();
    COMPANION_DIR = path3.join(REPO_ROOT, "companion");
  }
});

// server/src/resources/server.ts
var init_server = __esm({
  "server/src/resources/server.ts"() {
    "use strict";
    init_config();
    init_audit();
  }
});

// server/src/adapters/violentmonkey.ts
var PRELUDE_MARK, PRELUDE_MARK_END, PRELUDE_MARK_TAGS;
var init_violentmonkey = __esm({
  "server/src/adapters/violentmonkey.ts"() {
    "use strict";
    init_config();
    init_errors();
    init_audit();
    init_realms();
    init_extScripts();
    init_companion();
    init_server();
    init_client();
    PRELUDE_MARK = "claude-dev-prelude: added by firefox-use to this dev install, not in the file on disk";
    PRELUDE_MARK_END = "/claude-dev-prelude";
    PRELUDE_MARK_TAGS = [`/*${PRELUDE_MARK}*/ `, `/*${PRELUDE_MARK_END}*/ `];
  }
});

// server/src/setupLib.ts
init_config();

// server/src/snapshots/snapshots.ts
init_config();
init_audit();
init_errors();
init_extScripts();
init_privileged();
import fs3 from "node:fs";
import path4 from "node:path";

// server/src/adapters/ubo.ts
init_errors();
init_realms();
init_launcher();
init_internals();
var TAB_IDS = `({ tabIds }) => {
  ${TAB_TRACKER}
  const out = {};
  for (const id of tabIds) { try { const t = tt.getTab(id, null); out[id] = t ? t.linkedBrowser.browserId : null; } catch { out[id] = null; } }
  return out;
}`;
var EXT_TAB_ID = `({ bid }) => {
  ${TAB_TRACKER}
  for (const w of Services.wm.getEnumerator("navigator:browser")) for (const t of w.gBrowser.tabs) if (t.linkedBrowser.browserId === bid) return tt.getId(t);
  return null;
}`;
var IDLE_STOP_MS = 15 * 60 * 1e3;

// server/src/adapters/stylus.ts
init_config();
init_errors();
init_realms();
init_audit();
init_client();
init_violentmonkey();

// server/src/snapshots/snapshots.ts
var newId = (kind) => {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${kind === "cold" ? "c" : "s"}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 5)}`;
};
function snapshotsDir() {
  return stateDir("snapshots");
}
function coldDir(profile) {
  return ensureDir(path4.join(HOME, "snapshots", profile));
}
function listSnapshots(profile) {
  const out = [];
  const read = (dir) => {
    try {
      const m = JSON.parse(fs3.readFileSync(path4.join(dir, "meta.json"), "utf8"));
      out.push({ ...m, dir });
    } catch {
    }
  };
  const base = snapshotsDir();
  for (const d of fs3.readdirSync(base)) read(path4.join(base, d));
  const cold = path4.join(HOME, "snapshots");
  if (fs3.existsSync(cold)) for (const p of fs3.readdirSync(cold)) {
    if (profile && p !== profile) continue;
    for (const d of fs3.readdirSync(path4.join(cold, p))) read(path4.join(cold, p, d));
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
var COLD_SKIP = /* @__PURE__ */ new Set(["parent.lock", "lock", ".parentlock", "cache2", "startupCache", "crashes", "minidumps", "thumbnails", "shader-cache", "jumpListCache", "datareporting", "saved-telemetry-pings"]);
function copyProfileCold(src, dst) {
  fs3.cpSync(src, dst, { recursive: true, filter: (p) => !COLD_SKIP.has(path4.basename(p)) && !p.endsWith("-wal") && !p.endsWith("-shm") });
}
function takeColdCopy(profileKey, profileDir, label, auto, firefox) {
  const id = newId("cold");
  const dir = ensureDir(path4.join(coldDir(profileKey), id));
  copyProfileCold(profileDir, path4.join(dir, "profile"));
  const meta = { id, label, ts: (/* @__PURE__ */ new Date()).toISOString(), profile: profileKey, auto, kind: "cold", firefox, dir };
  fs3.writeFileSync(path4.join(dir, "meta.json"), JSON.stringify(meta, null, 1));
  const autos = listSnapshots(profileKey).filter((s) => s.kind === "cold" && s.auto && s.profile === profileKey);
  for (const s of autos.slice(0, Math.max(0, autos.length - 3))) {
    try {
      fs3.rmSync(s.dir, { recursive: true, force: true });
    } catch {
    }
  }
  return meta;
}
export {
  detectMainProfile,
  loadConfig,
  takeColdCopy
};
