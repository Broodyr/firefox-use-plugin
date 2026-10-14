// ext_dev_inspect messaging log: runtime messages and port traffic between an extension's contexts.
// Every extension message passes through the parent process's ProxyMessenger (ExtensionParent.sys.mjs), whose
// conduit receives RuntimeMessage (runtime/tabs.sendMessage), PortConnect and PortMessage. ProxyMessenger isn't
// exported, so the hook wraps BroadcastConduit.prototype._recv (ConduitsParent.sys.mjs) once, records what the
// "ProxyMessenger" conduit receives for the watched extensions, and calls through unchanged. Feature-detected.
import { fail } from '../errors.js';
import { maskText } from '../safety/mask.js';
import type { Browser } from './session.js';

export interface MsgEntry { ts: number; kind: string; from: string; to: string; text: string }

const STORE = `const { BroadcastConduit } = ChromeUtils.importESModule("resource://gre/modules/ConduitsParent.sys.mjs"); const L = BroadcastConduit.prototype.__cfMsgLog;`;

export const MSGLOG_INSTALL = `({ ids }) => {
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

export function messagingLog(b: Browser) {
  const watched = (b.adapters.get('msgLogIds') as Set<string> | undefined) ?? new Set<string>();
  b.adapters.set('msgLogIds', watched);
  return {
    async start(id: string) {
      try { await b.callChrome(MSGLOG_INSTALL, { ids: [id] }); } catch (e: any) { fail('UNSUPPORTED', `messaging log unavailable: ${e.message}`); }
      watched.add(id);
    },
    async stop(id: string) {
      watched.delete(id);
      await b.callChrome(`({ id }) => { ${STORE} if (L) L.ids.delete(id); return true; }`, { id }).catch(() => {});
    },
    watching: (id: string) => watched.has(id),
    entries(id: string): MsgEntry[] { return (b.adapters.get(`msgLog:${id}`) as MsgEntry[] | undefined) ?? []; },
    /** Messages the hook could not log since it was installed (a changed message shape), and the first error. */
    hookErrors(): { errors: number; firstError?: string } { return (b.adapters.get('msgLogErrors') as { errors: number; firstError?: string } | undefined) ?? { errors: 0 }; },
    /** Pull new entries from the browser (kept per extension here, masked). */
    async pull(): Promise<void> {
      const got = await b.callChrome<{ log: any[]; errors: number; firstError: string | null }>(`() => { ${STORE} return L ? { log: L.log.splice(0), errors: L.errors || 0, firstError: L.firstError || null } : { log: [], errors: 0, firstError: null }; }`).catch(() => ({ log: [], errors: 0, firstError: null }));
      if (got.errors) b.adapters.set('msgLogErrors', { errors: got.errors, firstError: got.firstError ?? undefined });
      for (const m of got.log) {
        const k = `msgLog:${m.id}`;
        const list = (b.adapters.get(k) as MsgEntry[] | undefined) ?? [];
        list.push({ ts: m.ts, kind: m.kind, from: m.from, to: m.to, text: maskText(m.text) });
        if (list.length > 1000) list.splice(0, list.length - 1000);
        b.adapters.set(k, list);
      }
    },
  };
}

/**
 * ff_selfcheck: a runtime message sent by extension `id` (through `send`) must reach the hook as a "message" entry.
 * The probe's own entries are dropped, and the extension stops being watched unless it was before.
 */
export async function msglogProbe(b: Browser, id: string, send: () => Promise<unknown>): Promise<true | string> {
  const was = await b.callChrome<boolean>(`({ id }) => { ${STORE} return !!L && L.ids.has(id); }`, { id });
  await b.callChrome(MSGLOG_INSTALL, { ids: [id] });
  try {
    await send();
    for (let i = 0; i < 20; i++) {
      const r = await b.callChrome<{ hit: boolean; errors: number; firstError: string | null }>(`({ id }) => { ${STORE}
        const mine = (m) => m.id === id && /__ffSelfcheck/.test(m.text);
        const hit = L.log.some((m) => mine(m) && m.kind === "message");
        if (hit) L.log = L.log.filter((m) => !mine(m));
        return { hit, errors: L.errors || 0, firstError: L.firstError || null };
      }`, { id });
      if (r.hit) return true;
      if (r.errors) return `the hook failed on a message: ${r.firstError}`;
      await new Promise((res) => setTimeout(res, 100));
    }
    return 'a runtime message from the extension never reached the hook (message names or the conduit changed)';
  } finally {
    if (!was) await b.callChrome(`({ id }) => { ${STORE} if (L) L.ids.delete(id); return true; }`, { id }).catch(() => {});
  }
}
