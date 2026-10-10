// Privileged functions for the extension tools (run in the chrome window over BiDi, one JSON arg).

const AM = `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");`;

/** Resolve an add-on (by id) to its live policy/extension; throws if not installed. */
const EXT = `
  const pol = WebExtensionPolicy.getByID(id);
  const ext = pol && pol.extension;
  if (!ext) throw new Error("extension " + id + " is not running (disabled or not installed); addons_set_enabled it first");
`;

export const ADDONS_LIST = `async () => {
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

/** id/alias resolution helper: an id, or a case-insensitive name match. */
export const ADDON_FIND = `async ({ q }) => {
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

export const ADDON_SET_ENABLED = `async ({ id, enabled }) => {
  ${AM}
  const a = await AddonManager.getAddonByID(id);
  if (!a) throw new Error("no add-on " + id);
  const before = a.isActive;
  if (enabled && !a.isActive) await a.enable();
  if (!enabled && a.isActive) await a.disable();
  return { before, after: a.isActive };
}`;

export const ADDON_RELOAD = `async ({ id }) => {
  ${AM}
  const a = await AddonManager.getAddonByID(id);
  if (!a) throw new Error("no add-on " + id);
  if (a.temporarilyInstalled && typeof a.reload === "function") { await a.reload(); return "reloaded (temporary add-on)"; }
  await a.disable({ allowSystemAddons: false });
  await a.enable();
  return "reloaded (disable + enable)";
}`;

export const ADDON_UNINSTALL_TEMP = `async ({ id }) => {
  ${AM}
  const a = await AddonManager.getAddonByID(id);
  if (!a) return false;
  if (!a.temporarilyInstalled) throw new Error(id + " is not a temporary add-on; refusing to uninstall it");
  await a.uninstall();
  return true;
}`;

/** Wake an event page / background and report whether it is running. */
export const EXT_WAKE = `async ({ id }) => {
  ${EXT}
  if (ext.backgroundState === "running" || !ext.wakeupBackground) return ext.backgroundState || "running";
  try { await Promise.race([ext.wakeupBackground(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
  return ext.backgroundState || "unknown";
}`;

/** Storage areas, read and written from the parent through Firefox's own storage backends. */
const STORAGE = `
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

/** keys: null = all; returns { values } or with sizesOnly { sizes } */
export const EXT_STORAGE_GET = `async ({ id, area: which, keys, sizesOnly, skip }) => {
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

/**
 * Hashes of string values (Violentmonkey code:<id>), computed inside Firefox so megabytes of code never cross BiDi:
 * CRLF normalised, the dev prelude (between the markers) removed, SHA-256, first 16 hex digits (= hashOf in Node).
 */
export const EXT_STORAGE_HASHES = `async ({ id, keys, strip }) => {
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

/** Returns before-values for the audit log (undefined -> key did not exist). */
export const EXT_STORAGE_SET =`async ({ id, area: which, items }) => {
  ${EXT}
  ${STORAGE}
  const s = await area[which]();
  const before = await s.get(Object.keys(items));
  await s.set(items);
  return { before };
}`;

export const EXT_STORAGE_REMOVE = `async ({ id, area: which, keys }) => {
  ${EXT}
  ${STORAGE}
  const s = await area[which]();
  const before = await s.get(keys);
  await s.remove(keys);
  return { before };
}`;

/**
 * Managed storage (storage.managed), per profile: the in-process override of NativeManifests' "storage"
 * lookup serves JSON from <profile>/claude-managed-storage/<id>.json. (The Windows registry route for managed storage
 * is per user, so it would also reach the user's MAIN profile; this override never leaves claude-dev.)
 */
export const MANAGED_INSTALL = `() => {
  const { NativeManifests } = ChromeUtils.importESModule("resource://gre/modules/NativeManifests.sys.mjs");
  if (NativeManifests.__claudeManaged) return "already installed";
  const dir = PathUtils.join(PathUtils.profileDir, "claude-managed-storage");
  const orig = NativeManifests.lookupManifest.bind(NativeManifests);
  NativeManifests.lookupManifest = async function (type, name, context) {
    if (type === "storage") {
      const file = PathUtils.join(dir, name.replace(/[^\\w@.{}-]/g, "_") + ".json");
      try { if (await IOUtils.exists(file)) return { path: file, manifest: { name, type: "storage", data: await IOUtils.readJSON(file) } }; } catch (e) { Cu.reportError(e); }
    }
    return orig(type, name, context);
  };
  NativeManifests.__claudeManaged = true;
  return "installed";
}`;

export const MANAGED_SET = `async ({ id, data }) => {
  const dir = PathUtils.join(PathUtils.profileDir, "claude-managed-storage");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const file = PathUtils.join(dir, id.replace(/[^\\w@.{}-]/g, "_") + ".json");
  let before = null;
  try { if (await IOUtils.exists(file)) before = await IOUtils.readJSON(file); } catch {}
  if (data === null) { await IOUtils.remove(file, { ignoreAbsent: true }); }
  else await IOUtils.writeJSON(file, data);
  return { before, file };
}`;

export const MANAGED_GET = `async ({ id }) => {
  const file = PathUtils.join(PathUtils.profileDir, "claude-managed-storage", id.replace(/[^\\w@.{}-]/g, "_") + ".json");
  try { if (await IOUtils.exists(file)) return { data: await IOUtils.readJSON(file), file }; } catch {}
  return { data: null, file };
}`;

export const MANAGED_LIST = `async () => {
  const dir = PathUtils.join(PathUtils.profileDir, "claude-managed-storage");
  try { return (await IOUtils.getChildren(dir)).filter((f) => f.endsWith(".json")).map((f) => PathUtils.filename(f).slice(0, -5)); } catch { return []; }
}`;

/** Every non-default pref (for snapshots); protected and denylisted branches are skipped. */
export const PREFS_USER = `({ skip }) => {
  const re = new RegExp(skip);
  const out = {};
  for (const n of Services.prefs.getChildList("")) {
    if (!Services.prefs.prefHasUserValue(n) || re.test(n)) continue;
    const t = Services.prefs.getPrefType(n);
    const get = (br) => t === 32 ? br.getStringPref(n) : t === 64 ? br.getIntPref(n) : t === 128 ? br.getBoolPref(n) : null;
    let v;
    try { v = get(Services.prefs); } catch { continue; }
    // a user value equal to the default is not a real difference (setting it back may clear it)
    try { if (get(Services.prefs.getDefaultBranch("")) === v) continue; } catch {}
    out[n] = v;
  }
  return out;
}`;

export const PREFS_GET = `({ names }) => {
  const out = {};
  for (const n of names) {
    const t = Services.prefs.getPrefType(n);
    if (t === 0) { out[n] = { exists: false }; continue; }
    let v = null;
    try { v = t === 32 ? Services.prefs.getStringPref(n) : t === 64 ? Services.prefs.getIntPref(n) : Services.prefs.getBoolPref(n); } catch {}
    let def = null;
    try { const d = Services.prefs.getDefaultBranch(""); def = t === 32 ? d.getStringPref(n) : t === 64 ? d.getIntPref(n) : d.getBoolPref(n); } catch { def = undefined; }
    out[n] = { exists: true, value: v, type: t === 32 ? "string" : t === 64 ? "int" : "bool", userSet: Services.prefs.prefHasUserValue(n), locked: Services.prefs.prefIsLocked(n), default: def };
  }
  return out;
}`;

/** values: name -> value | null (null = reset to default). Returns the before state for undo. */
export const PREFS_SET = `({ values }) => {
  const before = {};
  for (const [n, v] of Object.entries(values)) {
    const t = Services.prefs.getPrefType(n);
    before[n] = t === 0 || !Services.prefs.prefHasUserValue(n) ? null : t === 32 ? Services.prefs.getStringPref(n) : t === 64 ? Services.prefs.getIntPref(n) : Services.prefs.getBoolPref(n);
    if (v === null) { Services.prefs.clearUserPref(n); continue; }
    if (typeof v === "boolean") Services.prefs.setBoolPref(n, v);
    else if (typeof v === "number" && Number.isInteger(v)) Services.prefs.setIntPref(n, v);
    else Services.prefs.setStringPref(n, String(v));
  }
  return { before };
}`;

/**
 * An installed extension's own files (ext_source): its .xpi (zip reader) or, for temporary add-ons, its folder.
 * Files are read through the extension's moz-extension:// URL, so permanent and temporary installs look the same.
 */
const EXT_FILE_LIST = `
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

export const EXT_FILES = `async ({ id, prefix }) => {
  ${EXT_FILE_LIST}
  return { root: root.spec, files: prefix ? files.filter((f) => f[0].startsWith(prefix)) : files };
}`;

export const EXT_READ = `async ({ id, path }) => {
  ${EXT_FILE_LIST}
  if (!files.some((f) => f[0] === path)) return { missing: true, near: files.map((f) => f[0]).filter((f) => f.includes(path.split("/").pop())).slice(0, 10) };
  return { text: await read(path) };
}`;

/** Regex search across an extension's text files, inside Firefox (only the matches travel back). */
export const EXT_GREP = `async ({ id, source, flags, prefix, ctx, max }) => {
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
        out.push({ file: p, line, col, snippet: text.slice(Math.max(0, i - ctx), i + m[0].length + ctx).replace(/\\s*\\n\\s*/g, " ⏎ ") });
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return { matches: out, total, scanned };
}`;

/** Add-on enabled states (for snapshots). */
export const ADDON_STATES = `async () => {
  ${AM}
  const all = await AddonManager.getAddonsByTypes(["extension"]);
  const src = (a) => { try { const u = a.temporarilyInstalled && WebExtensionPolicy.getByID(a.id)?.baseURL; return u && u.startsWith("file:") ? Services.io.newURI(u).QueryInterface(Ci.nsIFileURL).file.path : (u || null); } catch { return null; } };
  return Object.fromEntries(all.filter((a) => !a.isSystem && !a.isBuiltin && !a.hidden).map((a) => [a.id, { active: a.isActive, version: a.version, temporary: !!a.temporarilyInstalled, name: a.name, ...(a.temporarilyInstalled ? { source: src(a) } : {}) }]));
}`;
