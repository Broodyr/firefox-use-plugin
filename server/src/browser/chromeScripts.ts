// Functions evaluated in the privileged (chrome) context of a browser.xhtml window over BiDi
// (moz:scope "chrome"). Each is sent as source and called with one JSON argument.

/** Shared prelude: map BiDi top-level context ids <-> <tab> elements via the remote agent's TabManager. */
const TABS = `
  let Nav;
  try { Nav = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs").NavigableManager; } catch {}
  if (!Nav?.getIdForBrowser) Nav = ChromeUtils.importESModule("chrome://remote/content/shared/TabManager.sys.mjs").TabManager;
  if (!Nav?.getIdForBrowser) throw new Error("remote agent internals changed: no getIdForBrowser in NavigableManager/TabManager");
  const idOf = (tab) => Nav.getIdForBrowser(tab.linkedBrowser);
  const tabOf = (id) => {
    const bc = Nav.getBrowsingContextById(id);
    const br = bc && bc.top && bc.top.embedderElement;
    return br ? window.gBrowser.getTabForBrowser(br) : null;
  };
  // one tab group per Claude session: key '' = the owning session ("Claude"), others "Claude 2", ...
  const groupIds = () => {
    window.__claudeAgentGroups ??= {};
    if (window.__claudeAgentGroup && window.__claudeAgentGroups[''] === undefined) window.__claudeAgentGroups[''] = window.__claudeAgentGroup;
    return window.__claudeAgentGroups;
  };
  const groupById = (gid) => gid ? (window.gBrowser.getTabGroupById?.(gid) ?? window.gBrowser.tabGroups?.find((g) => g.id === gid) ?? null) : null;
  const group = (key = '') => groupById(groupIds()[key]);
`;

export const IS_AGENT_WINDOW = `() => !!window.__claudeAgent`;

export const WINDOW_HAS_CONTEXT = `(id) => { ${TABS} return !!tabOf(id) && tabOf(id).ownerDocument.defaultView === window; }`;

/**
 * The agent window is parked off-screen as a NORMAL window: a minimised window makes every page
 * `document.hidden`, which stops requestAnimationFrame, CSS transitions and the animation clock (measured: 0 rAF/s,
 * 0 ms of animation time in 1.2 s; off-screen: 144 rAF/s, transitions complete). Parking only ever MOVES the window:
 * un-minimising activates Firefox and takes the foreground from the user (measured for restore() and for
 * ShowWindow(SW_SHOWNOACTIVATE) alike), so a window the user minimised stays minimised and is reported instead.
 * Listeners (installed once): the user activating the parked window (taskbar click) brings it on-screen; their
 * minimising it is recorded for the note.
 */
const GIVE_BACK_FN = `(w) => {
  if (Services.appinfo.OS !== 'WINNT') return null;
  const { ctypes } = ChromeUtils.importESModule('resource://gre/modules/ctypes.sys.mjs');
  const u = ctypes.open('user32.dll');
  let dwm = null;
  try {
    const H = ctypes.voidptr_t, I = ctypes.int32_t, A = ctypes.winapi_abi;
    const GetForegroundWindow = u.declare('GetForegroundWindow', A, H);
    const GetWindow = u.declare('GetWindow', A, H, H, ctypes.uint32_t);
    const IsWindowVisible = u.declare('IsWindowVisible', A, I, H);
    const IsIconic = u.declare('IsIconic', A, I, H);
    const GetWindowLongW = u.declare('GetWindowLongW', A, I, H, I);
    const SetForegroundWindow = u.declare('SetForegroundWindow', A, I, H);
    let cloaked = () => false;
    try {
      dwm = ctypes.open('dwmapi.dll');
      const DwmGetWindowAttribute = dwm.declare('DwmGetWindowAttribute', A, I, H, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t);
      cloaked = (h) => { const v = ctypes.uint32_t(0); return DwmGetWindowAttribute(h, 14, v.address(), 4) === 0 && v.value !== 0; };
    } catch (e) { /* no DWM: treat every window as uncloaked */ }
    const num = (h) => Number(ctypes.cast(h, ctypes.uintptr_t).value.toString());
    const own = Number(w.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle);
    if (num(GetForegroundWindow()) !== own) return 'not foreground';
    let h = GetWindow(ctypes.voidptr_t(ctypes.UInt64(own)), 2);
    for (let i = 0; i < 500 && !h.isNull(); i++, h = GetWindow(h, 2)) {
      const ex = GetWindowLongW(h, -20);
      if (!IsWindowVisible(h) || IsIconic(h) || (ex & 0x80) || (ex & 0x08000000) || !GetWindow(h, 4).isNull() || cloaked(h)) continue;
      return SetForegroundWindow(h) ? 'handed back' : 'SetForegroundWindow refused';
    }
    return 'no other window';
  } finally { u.close(); if (dwm) dwm.close(); }
}`;

/** Where the agent window goes when it is shown: where it was before parking, else centred on the screen. */
const HOME_FN = `(w) => {
  const h = w.__claudeHome, s = w.screen;
  return h ? [h.x, h.y] : [s.availLeft + Math.max(0, (s.availWidth - w.outerWidth) / 2), s.availTop + Math.max(0, (s.availHeight - w.outerHeight) / 2)];
}`;

const PARK_FN = `(w) => {
  const OFF = -20000;
  const parked = () => w.screenX <= OFF / 2;
  if (!w.__claudeParkHooks) {
    w.__claudeParkHooks = true;
    w.addEventListener('activate', () => {
      if (!parked() || w.windowState === w.STATE_MINIMIZED) return;
      const [x, y] = (${HOME_FN})(w);
      w.moveTo(x, y);
      w.__claudeViewing = true;
    });
    w.addEventListener('sizemodechange', () => { if (w.windowState === w.STATE_MINIMIZED) w.__claudeMinimizedAt = Date.now(); });
  }
  if (w.windowState === w.STATE_MINIMIZED) return 'minimized';
  if (w.windowState !== w.STATE_NORMAL) return 'on-screen';
  if (parked()) return 'parked';
  if (w.__claudeViewing) return 'on-screen';
  w.__claudeHome = { x: w.screenX, y: w.screenY };
  w.__claudeViewing = false;
  w.moveTo(OFF, OFF);
  if (!parked()) return 'on-screen';
  // An off-screen window that is still the foreground window would take the user's typing unseen (measured: the
  // launch window keeps the foreground it took at startup). Minimising used to hand the foreground on implicitly;
  // do the same explicitly: activate the next real window in z-order (a foreground process may do that).
  try { (${GIVE_BACK_FN})(w); } catch (e) { /* not Windows, or user32 unavailable: nothing to hand back */ }
  return 'parked';
}`;

/** Park the agent window off-screen (handback, or a window set up by an older version that minimised it). Returns parked | on-screen | minimized. */
export const PARK = `({ handback }) => { if (handback) { window.__claudeViewing = false; } return (${PARK_FN})(window); }`;

/**
 * ff_window show: bring the agent window on-screen WITHOUT activating it (moving a normal window doesn't). A window the
 * user minimised is restored only because the user asked to see it: restoring takes the foreground (measured).
 */
export const SHOW = `() => {
  window.__claudeViewing = true;
  if (window.windowState === window.STATE_MINIMIZED) { window.restore(); return 'restored'; }
  if (window.screenX <= -10000) { const [x, y] = (${HOME_FN})(window); window.moveTo(x, y); }
  return 'on-screen';
}`;

/** Where the agent window is: parked off-screen, on-screen (the user brought it up), or minimized (pages hidden). */
export const WINDOW_VISIBILITY = `() => {
  if (window.windowState === window.STATE_MINIMIZED) return { state: 'minimized', since: window.__claudeMinimizedAt ?? null };
  return { state: window.screenX <= -10000 ? 'parked' : 'on-screen' };
}`;

/**
 * Mark this window as the agent window, make sure the Claude tab group exists, then place it: park off-screen, minimise,
 * or "show" (visible mode: on-screen, not activated; a window Firefox just launched hands the foreground back).
 */
export const SETUP_AGENT_WINDOW = `({ hide, label, color, key = '', launched = false }) => {
  ${TABS}
  window.__claudeAgent = true;
  const gb = window.gBrowser;
  let g = group(key);
  if (!g) {
    // the owning session adopts the window's loose tab; other sessions get a new background tab
    const tabs = key === '' ? gb.tabs.filter((t) => !t.group) : [];
    const first = tabs.length ? tabs[0] : gb.addTab('about:blank', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
    g = gb.addTabGroup([first], { label, color, insertBefore: first });
    groupIds()[key] = g.id;
    if (key === '') window.__claudeAgentGroup = g.id;
  }
  let hidden = null;
  if (hide === 'minimize' && window.windowState !== window.STATE_MINIMIZED) window.minimize();
  if (hide === 'offscreen') hidden = (${PARK_FN})(window);
  if (hide === 'show') {
    if (window.screenX <= -10000 && window.windowState === window.STATE_NORMAL) { const [x, y] = (${HOME_FN})(window); window.moveTo(x, y); }
    window.__claudeViewing = true;
    if (launched) { try { (${GIVE_BACK_FN})(window); } catch (e) { /* not Windows: nothing to hand back */ } }
  }
  return { group: g.id, tabs: g.tabs.map((t) => ({ id: idOf(t), bid: t.linkedBrowser.browserId })), windowState: window.windowState, hidden };
}`;

/** The Claude session (group key) whose tab group holds this tab; null for the user's own tabs. */
export const OWNER_OF_CONTEXT = `({ id }) => {
  ${TABS}
  const t = tabOf(id);
  if (!t || !t.group) return null;
  for (const [k, gid] of Object.entries(groupIds())) if (t.group.id === gid) return k;
  return null;
}`;

/**
 * A tab whose opener is one of Claude's tabs but which is outside Claude's groups (window.open with features opens
 * a separate popup window, visible on the user's screen): move it into the agent window (gBrowser.adoptTab swaps
 * the browser in, so the page, its history and window.opener stay), add it to the opener's group, close the empty
 * popup window. Returns the group key, or null when the tab isn't Claude's.
 */
export const ADOPT_POPUP = `async ({ id }) => {
  ${TABS}
  const bc = Nav.getBrowsingContextById(id);
  const br = bc && bc.top && bc.top.embedderElement;
  const opener = bc && bc.top && bc.top.opener;
  const openerBr = opener && opener.top && opener.top.embedderElement;
  if (!br || !openerBr) return null;
  const openerTab = window.gBrowser.getTabForBrowser(openerBr);
  if (!openerTab || !openerTab.group) return null;
  const key = Object.entries(groupIds()).find(([, gid]) => openerTab.group.id === gid)?.[0];
  if (key === undefined) return null;
  const doc = br.ownerDocument;
  const srcWin = doc.defaultView;
  let tab = srcWin.gBrowser.getTabForBrowser(br);
  if (!tab) return null;
  if (srcWin !== window) {
    // wait until the popup window has finished starting up (adoptTab needs its browser initialised)
    for (let i = 0; i < 50 && !srcWin.gBrowserInit?.delayedStartupFinished; i++) await new Promise((r) => setTimeout(r, 50));
    const adopted = window.gBrowser.adoptTab(tab, { elementIndex: window.gBrowser.tabs.indexOf(openerTab) + 1, selectTab: false });
    if (!adopted) return null;
    tab = adopted;
    if (!srcWin.closed && srcWin.gBrowser.tabs.length <= 1 && srcWin.gBrowser.selectedTab.linkedBrowser.currentURI.spec === "about:blank") srcWin.close();
  }
  const g = group(key);
  if (g && tab.group !== g) { if (typeof g.addTabs === "function") g.addTabs([tab]); else window.gBrowser.moveTabToExistingGroup(tab, g); }
  return { key, moved: srcWin !== window, id: idOf(tab) };
}`;

/** BiDi context ids of the tabs in every Claude session's group. */
export const AGENT_CONTEXTS = `() => {
  ${TABS}
  const out = [];
  for (const gid of Object.values(groupIds())) for (const t of groupById(gid)?.tabs ?? []) { const id = idOf(t); if (id) out.push(id); }
  return out;
}`;

export const LIST_TABS = `({ includeUser, key = '' }) => {
  ${TABS}
  const g = group(key);
  const agent = new Set(g ? g.tabs : []);
  // tabs of other Claude sessions' groups are never listed (not even as user tabs)
  const others = new Set();
  for (const [k, gid] of Object.entries(groupIds())) if (k !== key) for (const t of groupById(gid)?.tabs ?? []) others.add(t);
  const out = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const t of win.gBrowser.tabs) {
      const isAgent = agent.has(t);
      if (others.has(t)) continue;
      if (!isAgent && !includeUser) continue;
      out.push({ id: idOf(t), bid: t.linkedBrowser.browserId, bc: t.linkedBrowser.browsingContext?.id, agent: isAgent, url: t.linkedBrowser.currentURI.spec, title: t.label, selected: win.gBrowser.selectedTab === t, pending: t.hasAttribute('pending') });
    }
  }
  return out;
}`;

export const ADD_TO_GROUP = `({ id, key = '' }) => {
  ${TABS}
  const t = tabOf(id), g = group(key);
  if (!t || !g) return false;
  if (t.group !== g) {
    if (typeof g.addTabs === 'function') g.addTabs([t]);
    else window.gBrowser.moveTabToExistingGroup(t, g);
  }
  return true;
}`;

/** Select a tab inside its (minimised) window without focusing or raising the window. */
export const SELECT_TAB = `({ id }) => {
  ${TABS}
  const t = tabOf(id);
  if (!t) return false;
  t.ownerDocument.defaultView.gBrowser.selectedTab = t;
  return true;
}`;

export const MINIMIZE = `() => { if (window.windowState !== window.STATE_MINIMIZED) window.minimize(); return window.windowState; }`;

export const VERSIONS = `async () => {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const all = await AddonManager.getAddonsByTypes(["extension"]);
  return {
    firefox: Services.appinfo.version,
    buildId: Services.appinfo.appBuildID,
    addons: all.filter((a) => !a.isSystem && !a.isBuiltin && !a.hidden).map((a) => ({
      id: a.id, name: a.name, version: a.version, active: a.isActive, temporary: !!a.temporarilyInstalled,
      autoUpdate: a.applyBackgroundUpdates,
    })),
  };
}`;

/** no background updates for any add-on in the dev profile. */
export const PIN_ADDON_UPDATES = `async () => {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const all = await AddonManager.getAddonsByTypes(["extension"]);
  let n = 0;
  for (const a of all) if (!a.isSystem && !a.isBuiltin && !a.hidden && a.applyBackgroundUpdates !== 0) { a.applyBackgroundUpdates = 0; n++; }
  return n;
}`;

export const ADDON_INSTALLED = `async ({ id }) => {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  return !!(await AddonManager.getAddonByID(id));
}`;

/** Start the accessibility service once (one-time cost) so read_page is fast later. */
// The service shuts down when its last reference is dropped, so keep one on the chrome window.
export const START_A11Y = `() => { window.__cfA11y = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService); return true; }`;

/**
 * Walk the parent-process accessibility tree of a tab.
 * Returns { url, title, vw, vh, nodes: [[depth, role, ariaRole, name, value, states, x, y, w, h, uid, tag, idAttr, frameUrl, level]] }
 * Bounds are CSS px relative to the tab's viewport.
 */
export const A11Y_WALK = `async ({ id, maxNodes }) => {
  ${TABS}
  const svc = window.__cfA11y = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);
  const t = tabOf(id);
  if (!t) return { error: 'tab not found' };
  const br = t.linkedBrowser;
  const win = t.ownerDocument.defaultView;
  let doc = null;
  for (let i = 0; i < 40; i++) {
    const a = svc.getAccessibleFor(br);
    doc = a && a.firstChild;
    if (doc) {
      const st = {}, ex = {};
      doc.getState(st, ex);
      if (!(st.value & 0x800) && doc.childCount > 0) break; // not busy
    }
    await new Promise((r) => win.setTimeout(r, 50));
  }
  if (!doc) return { error: 'no accessible document (page still loading?)' };
  const rect = br.getBoundingClientRect();
  const ox = win.mozInnerScreenX + rect.left, oy = win.mozInnerScreenY + rect.top;
  const x = {}, y = {}, w = {}, h = {};
  const nodes = [];
  const attr = (a, k) => { try { return a.attributes.getStringProperty(k); } catch { return ''; } };
  const walk = (a, depth, frameUrl) => {
    if (!a || nodes.length >= maxNodes) return;
    const role = svc.getStringRole(a.role);
    let aria = ''; try { aria = a.computedARIARole || ''; } catch {}
    let bx = [0, 0, 0, 0];
    try { a.getBoundsInCSSPixels(x, y, w, h); bx = [x.value - ox, y.value - oy, w.value, h.value].map(Math.round); } catch {}
    const st = {}, ex = {}; a.getState(st, ex);
    let name = ''; try { name = a.name || ''; } catch {}
    let value = ''; try { value = a.value || ''; } catch {}
    let fu = frameUrl;
    if (role === 'document' && depth > 0) { try { fu = a.QueryInterface(Ci.nsIAccessibleDocument).URL; } catch {} }
    nodes.push([depth, role, aria, name, value, st.value, bx[0], bx[1], bx[2], bx[3], String(a.uniqueID), attr(a, 'tag'), attr(a, 'id'), fu, attr(a, 'level')]);
    for (let c = a.firstChild; c; c = c.nextSibling) walk(c, depth + 1, fu);
  };
  walk(doc, 0, '');
  return { url: br.currentURI.spec, title: t.label, vw: Math.round(rect.width), vh: Math.round(rect.height), truncated: nodes.length >= maxNodes, nodes };
}`;

/** Reload bypassing the cache (BiDi reload's ignoreCache is not implemented in Firefox yet). */
export const RELOAD_BYPASS_CACHE = `({ id }) => {
  ${TABS}
  const t = tabOf(id);
  if (!t) return false;
  t.linkedBrowser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY);
  return true;
}`;

/** Handoff: bring the agent window up on a tab so the user can act (log in, solve a CAPTCHA). */
export const HANDOFF_SHOW = `({ id }) => {
  ${TABS}
  const t = tabOf(id);
  if (t) t.ownerDocument.defaultView.gBrowser.selectedTab = t;
  if (window.windowState === window.STATE_MINIMIZED) window.restore();
  // parked off-screen: back to where it was (or centred), then shown to the user (the one deliberate focus change)
  if (window.screenX <= -10000) { const [x, y] = (${HOME_FN})(window); window.moveTo(x, y); }
  window.focus();
  return window.windowState;
}`;

/**
 * BiDi context ids are regenerated for every BiDi session, so tab handles are keyed on the permanent
 * browser.browserId and re-mapped to the current session's ids on attach.
 */
export const REMAP_BROWSER_IDS = `({ bids }) => {
  ${TABS}
  const want = new Set(bids), out = {};
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const t of win.gBrowser.tabs) { const bid = t.linkedBrowser.browserId; if (want.has(bid)) out[bid] = idOf(t); }
  }
  return out;
}`;

/** Active extensions: moz-extension host (uuid) -> id, name (attribution of console and network entries). */
export const EXT_LIST = `() => WebExtensionPolicy.getActiveExtensions().map((p) => ({ uuid: p.mozExtensionHostname, id: p.id, name: p.name }))`;

/** Close the tab group of a Claude session that is gone (its tabs close with it). */
export const CLOSE_CLIENT_GROUP = `({ key }) => {
  ${TABS}
  const g = group(key);
  if (!g || key === '') return 0;
  const n = g.tabs.length;
  for (const t of [...g.tabs]) window.gBrowser.removeTab(t, { animate: false });
  delete groupIds()[key];
  return n;
}`;
