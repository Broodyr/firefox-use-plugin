// Privileged functions for site storage (run in the chrome window over BiDi, one JSON arg).
//
// Any origin's storage is reached without loading its pages: localStorage through the storage manager with the
// origin's principal (chrome window as the owner), IndexedDB and Cache Storage from a sandbox that has the origin's
// principal (wantGlobalProperties: indexedDB, caches), service workers through the SW manager, clearing through
// the clear-data service. Values are serialised inside the sandbox (SERIALIZER), so the result is plain JSON.
import { SERIALIZER } from './serialize.js';

const PRINCIPAL = `
  let principal;
  try { principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin); } catch (e) { throw new Error("not an origin: " + origin); }
`;

/** a sandbox with the origin's principal; run(src) evaluates an async expression there and returns its JSON */
const SANDBOX = `
  ${PRINCIPAL}
  const sb = Cu.Sandbox(principal, { wantGlobalProperties: ["indexedDB", "caches"], sandboxName: "firefox-use site storage", freshCompartment: true });
  Cu.evalInSandbox(${JSON.stringify(SERIALIZER)}, sb);
  Cu.evalInSandbox(\`
    var __cfOpen = (name) => new Promise((res, rej) => {
      let created = false;
      const r = indexedDB.open(name);
      r.onupgradeneeded = () => { created = true; r.transaction.abort(); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(created ? new Error("no database " + JSON.stringify(name)) : r.error);
      r.onblocked = () => rej(new Error("database " + JSON.stringify(name) + " is blocked by a pending version change"));
    });
    var __cfReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  \`, sb);
  // errors are the sandbox's objects: copy the message out before the sandbox is nuked
  const run = async (src) => { try { return JSON.parse(await Cu.evalInSandbox(src, sb)); } catch (e) { throw new Error(String((e && e.message) || e)); } finally { Cu.nukeSandbox(sb); } };
`;

export const IDB_LIST = `async ({ origin }) => {
  ${SANDBOX}
  return run(\`(async () => {
    const out = [];
    for (const d of await indexedDB.databases()) {
      const db = await __cfOpen(d.name);
      const stores = [];
      try {
        for (const s of db.objectStoreNames) {
          const st = db.transaction(s, "readonly").objectStore(s);
          const indexes = [...st.indexNames].map((n) => { const i = st.index(n); return { name: n, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; });
          stores.push({ name: s, keyPath: st.keyPath, autoIncrement: st.autoIncrement, count: await __cfReq(st.count()), indexes });
        }
      } finally { db.close(); }
      out.push({ name: d.name, version: d.version, stores });
    }
    return JSON.stringify(out);
  })()\`);
}`;

export const IDB_READ = `async ({ origin, db, store, index, query, limit, offset, direction }) => {
  ${SANDBOX}
  return run(\`(async () => {
    const q = \${JSON.stringify(query ?? null)};
    const db = await __cfOpen(\${JSON.stringify(db)});
    try {
      if (![...db.objectStoreNames].includes(\${JSON.stringify(store)})) throw new Error("no object store " + \${JSON.stringify(JSON.stringify(store))} + " (stores: " + [...db.objectStoreNames].join(", ") + ")");
      const st = db.transaction(\${JSON.stringify(store)}, "readonly").objectStore(\${JSON.stringify(store)});
      const src = \${JSON.stringify(index ?? null)} ? st.index(\${JSON.stringify(index ?? '')}) : st;
      let range = null;
      if (q && "only" in q) range = IDBKeyRange.only(q.only);
      else if (q && q.lower !== undefined && q.upper !== undefined) range = IDBKeyRange.bound(q.lower, q.upper, !!q.lower_open, !!q.upper_open);
      else if (q && q.lower !== undefined) range = IDBKeyRange.lowerBound(q.lower, !!q.lower_open);
      else if (q && q.upper !== undefined) range = IDBKeyRange.upperBound(q.upper, !!q.upper_open);
      const total = await __cfReq(src.count(range));
      const rows = [];
      await new Promise((res, rej) => {
        let skipped = false;
        const r = src.openCursor(range, \${JSON.stringify(direction)});
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c) return res();
          if (\${offset} && !skipped) { skipped = true; return c.advance(\${offset}); }
          rows.push({ key: JSON.parse(__cfSerialize(c.key, 3, false)).value, primaryKey: c.primaryKey === c.key ? undefined : JSON.parse(__cfSerialize(c.primaryKey, 3, false)).value, value: JSON.parse(__cfSerialize(c.value, 6, false)).value });
          if (rows.length >= \${limit}) return res();
          c.continue();
        };
      });
      return JSON.stringify({ total, rows, keyPath: st.keyPath });
    } finally { db.close(); }
  })()\`);
}`;

export const CACHES_LIST = `async ({ origin, cache, limit }) => {
  ${SANDBOX}
  return run(\`(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      if (\${JSON.stringify(cache ?? null)} !== null && name !== \${JSON.stringify(cache ?? '')}) continue;
      const c = await caches.open(name);
      const reqs = await c.keys();
      const entries = [];
      for (const r of reqs.slice(0, \${limit})) {
        const m = await c.match(r);
        entries.push({ method: r.method, url: r.url, status: m ? m.status : null, type: m ? m.headers.get("content-type") : null, length: m ? m.headers.get("content-length") : null });
      }
      out.push({ name, count: reqs.length, entries });
    }
    return JSON.stringify(out);
  })()\`);
}`;

export const LS = `async ({ origin, op, key, value }) => {
  ${PRINCIPAL}
  // the chrome window is only the owner the storage manager asks for; the storage is the origin's own
  const st = Services.domStorageManager.createStorage(window, principal, principal, "");
  const list = () => { const out = []; for (let i = 0; i < st.length; i++) { const k = st.key(i); out.push([k, st.getItem(k)]); } return out; };
  if (op === "list") return { items: list() };
  if (op === "get") return { value: st.getItem(key) };
  const before = op === "clear" ? Object.fromEntries(list()) : { [key]: st.getItem(key) };
  if (op === "set") st.setItem(key, value);
  else if (op === "remove") st.removeItem(key);
  else if (op === "clear") st.clear();
  return { before };
}`;

/** session/local storage from inside a document (BiDi sandbox of the tab or frame): the document's own storage */
export const PAGE_STORAGE = `(kind, op, key, value) => {
  const st = kind === "session" ? window.sessionStorage : window.localStorage;
  const list = () => { const out = []; for (let i = 0; i < st.length; i++) { const k = st.key(i); out.push([k, st.getItem(k)]); } return out; };
  const res = { origin: location.origin };
  if (op === "list") return JSON.stringify({ ...res, items: list() });
  if (op === "get") return JSON.stringify({ ...res, value: st.getItem(key) });
  const before = op === "clear" ? Object.fromEntries(list()) : { [key]: st.getItem(key) };
  if (op === "set") st.setItem(key, value);
  else if (op === "remove") st.removeItem(key);
  else if (op === "clear") st.clear();
  return JSON.stringify({ ...res, before });
}`;

const SWM = `const swm = Cc["@mozilla.org/serviceworkers/manager;1"].getService(Ci.nsIServiceWorkerManager);`;

export const SW_LIST = `({ origin }) => {
  ${SWM}
  const regs = swm.getAllRegistrations();
  const worker = (w) => w ? { script: w.scriptSpec, state: ["parsed", "installing", "installed", "activating", "activated", "redundant"][w.state] ?? String(w.state), handlesFetch: w.handlesFetchEvents } : null;
  const out = [];
  for (let i = 0; i < regs.length; i++) {
    const r = regs.queryElementAt(i, Ci.nsIServiceWorkerRegistrationInfo);
    if (origin && r.principal.origin !== origin) continue;
    out.push({ origin: r.principal.origin, scope: r.scope, script: r.scriptSpec, active: worker(r.activeWorker), waiting: worker(r.waitingWorker), installing: worker(r.installingWorker), lastUpdate: r.lastUpdateTime ? Math.round(r.lastUpdateTime / 1000) : null });
  }
  return out;
}`;

export const SW_UNREGISTER = `async ({ origin, scope }) => {
  ${PRINCIPAL}
  ${SWM}
  return new Promise((res) => swm.unregister(principal, {
    QueryInterface: ChromeUtils.generateQI(["nsIServiceWorkerUnregisterCallback"]),
    unregisterSucceeded: (ok) => res(ok ? "unregistered" : "no registration for this scope"),
    unregisterFailed: () => res("FAILED"),
  }, scope));
}`;

/** clear-data service flags by name, feature-detected (a flag that no longer exists fails loudly) */
export const SITE_CLEAR = `async ({ origin, site, flags }) => {
  ${PRINCIPAL}
  let mask = 0;
  for (const f of flags) {
    // "NAME?" = optional (only some versions have it)
    const v = Ci.nsIClearDataService[f.replace(/\\?$/, "")];
    if (typeof v === "number") mask |= v;
    else if (!f.endsWith("?")) throw new Error("nsIClearDataService." + f + " no longer exists in this Firefox");
  }
  const host = principal.baseDomain || principal.host;
  const failed = await new Promise((resolve, reject) => {
    const cb = { onDataDeleted: (failed) => resolve(failed) };
    try {
      if (!site) Services.clearData.deleteDataFromPrincipal(principal, true, mask, cb);
      else {
        // (schemeless site, origin-attributes pattern, user request, flags, callback); older builds lack the pattern
        try { Services.clearData.deleteDataFromSite(host, {}, true, mask, cb); }
        catch (e) { Services.clearData.deleteDataFromSite(host, true, mask, cb); }
      }
    } catch (e) { reject(e); }
  });
  return { failed, site: site ? host : null };
}`;
