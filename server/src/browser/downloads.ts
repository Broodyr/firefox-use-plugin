// downloads: a guard in the browser (a Downloads list view) that knows which Claude session's tab
// started each download, cancels downloads from agent tabs that come from a non-local origin unless that session
// has the user's OK (scope area "downloads"), and cancels any agent download whose file would land outside the
// sandbox folder. The user's own tabs in claude-dev are never touched or listed.
import { covers } from './scope.js';
import type { Browser } from './session.js';

const TABS_OF = `
  const groupKeyOfBc = (bcId) => {
    const bc = BrowsingContext.get(bcId);
    const br = bc && bc.top && bc.top.embedderElement;
    if (!br) return null;
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const t = win.gBrowser.getTabForBrowser(br);
      if (!t) continue;
      const groups = win.__claudeAgentGroups ?? {};
      if (win.__claudeAgentGroup && groups[''] === undefined) groups[''] = win.__claudeAgentGroup;
      for (const [k, gid] of Object.entries(groups)) if (t.group && t.group.id === gid) return { key: k, page: br.currentURI ? br.currentURI.spec : '' };
      return null;
    }
    return null;
  };
`;

/** Install once per Firefox (kept on the shared system global, which lives as long as the browser); idempotent. */
export const DL_GUARD_INSTALL = `async () => {
  const host = Cu.getGlobalForObject(Services);
  // the sandbox = the profile's download folder (checked at launch to be an existing folder)
  const sandbox = Services.prefs.getStringPref("browser.download.dir", "");
  const G = host.__cfDownloads ??= { allowed: {}, allowAll: false, events: [], owner: new WeakMap(), view: null, sandbox };
  G.sandbox = sandbox;
  if (G.view) return "already installed";
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  ${TABS_OF}
  const local = (u, page) => {
    let url = u;
    if (/^(blob|data):/.test(u)) { url = u.startsWith("blob:") ? u.slice(5) : page; }
    try {
      const x = new URL(url);
      if (x.protocol === "file:") return true;
      const h = x.hostname.replace(/^\\[|\\]$/g, "").toLowerCase();
      return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".test");
    } catch (e) { return false; }
  };
  const inside = (p) => { const s = G.sandbox.replace(/[\\\\/]+$/, "").toLowerCase(); const q = String(p).toLowerCase(); return q === s || q.startsWith(s + "\\\\") || q.startsWith(s + "/"); };
  const note = (e) => { G.events.push({ ts: Date.now(), ...e }); if (G.events.length > 200) G.events.shift(); };
  G.view = {
    onDownloadAdded(d) {
      const o = d.source.browsingContextId ? groupKeyOfBc(d.source.browsingContextId) : null;
      if (!o) return; // the user's own tab (or no tab): theirs
      G.owner.set(d, o.key);
      const url = d.source.url;
      if (!local(url, o.page) && !G.allowAll && !G.allowed[o.key]) {
        d.cancel().then(() => d.removePartialData()).catch(() => {});
        note({ key: o.key, url, action: "blocked", why: "download from a non-local site without the user's OK" });
      } else if (d.target.path && !inside(d.target.path)) {
        d.cancel().then(() => d.removePartialData()).catch(() => {});
        note({ key: o.key, url, action: "blocked", why: "target " + d.target.path + " is outside the sandbox folder" });
      }
    },
  };
  const list = await Downloads.getList(Downloads.ALL);
  await list.addView(G.view);
  return "installed";
}`;

export const DL_POLICY = `({ allowed, allowAll }) => {
  const G = Cu.getGlobalForObject(Services).__cfDownloads;
  if (!G) return false;
  G.allowed = allowed; G.allowAll = allowAll;
  return true;
}`;

export const DL_LIST = `async ({ key }) => {
  const G = Cu.getGlobalForObject(Services).__cfDownloads;
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const all = await (await Downloads.getList(Downloads.ALL)).getAll();
  let others = 0;
  const out = [];
  for (const d of all) {
    if (!G || G.owner.get(d) !== key) { others++; continue; }
    out.push({
      url: d.source.url, path: d.target.path, start: d.startTime ? d.startTime.getTime() : 0,
      state: d.succeeded ? "done" : d.canceled ? "canceled" : d.error ? "failed: " + (d.error.message || d.error.result || "error") : d.stopped ? "stopped" : "in progress",
      bytes: d.currentBytes, total: d.hasProgress ? d.totalBytes : null, type: d.contentType || null,
    });
  }
  const events = G ? G.events.filter((e) => e.key === key) : [];
  return { downloads: out, others, events, guard: !!G };
}`;

/** Push which sessions have the user's OK for non-local downloads into the browser's guard. */
export async function syncDownloadApprovals(b: Browser): Promise<void> {
  if (b.personal) return;
  const allowed: Record<string, boolean> = {};
  const approved = (key: string, scope: any) => covers(scope, 'downloads') || b.sessionApprovedFor(key).includes('downloads');
  allowed[''] = approved('', b.state.scope);
  for (const [k, ci] of Object.entries(b.state.clients ?? {})) allowed[k] = approved(k, (ci as any).scope);
  // throwaway profiles need no approvals unless scope enforcement is on (tests), like every other scope check
  const allowAll = !!b.state.throwaway && !process.env.FIREFOX_USE_ENFORCE_SCOPE;
  await b.callChrome(DL_POLICY, { allowed, allowAll }).catch(() => {});
}
