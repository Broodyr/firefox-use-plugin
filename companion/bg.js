// firefox-use companion (also the userscript runner for fast mode). Installed as a temporary add-on at every launch; the
// server drives it by evaluating cf.* in this background (RDP), so there is no message protocol to keep in sync.
// Fast mode: userscripts are registered through the userScripts API (USER_SCRIPT world) with GM_* stubs.
'use strict';

const RECORD_MAX = 500;

/** GM prelude for one script. Values are embedded so GM_getValue stays synchronous; the code is re-registered
 *  whenever stored values change, so the next page load sees them. */
function prelude(spec, values) {
  const info = { script: { name: spec.name, namespace: spec.namespace || '', version: spec.version || '', description: spec.description || '', grant: spec.grants || [], matches: spec.matches || [], runAt: spec.runAt }, scriptHandler: 'firefox-use fast mode', version: '0.2.1' };
  return `var GM_info = ${JSON.stringify(info)};
var unsafeWindow = (typeof window !== 'undefined' && window.wrappedJSObject) || globalThis;
var __cfVals = ${JSON.stringify(values)};
var __cfMode = ${JSON.stringify(spec.gm || 'persisted')};
var __cfSend = function (op, args) { try { return browser.runtime.sendMessage({ cfgm: op, id: ${JSON.stringify(spec.id)}, args: args }); } catch (e) { return Promise.reject(e); } };
var __cfRec = function (op, args) { try { __cfSend('record', [op, args]); } catch (e) {} };
var GM_getValue = function (k, d) { __cfRec('GM_getValue', [k]); return Object.prototype.hasOwnProperty.call(__cfVals, k) ? __cfVals[k] : d; };
var GM_setValue = function (k, v) { __cfVals[k] = v; __cfSend(__cfMode === 'persisted' ? 'setValue' : 'record', __cfMode === 'persisted' ? [k, v] : ['GM_setValue', [k, v]]); };
var GM_deleteValue = function (k) { delete __cfVals[k]; __cfSend(__cfMode === 'persisted' ? 'deleteValue' : 'record', __cfMode === 'persisted' ? [k] : ['GM_deleteValue', [k]]); };
var GM_listValues = function () { return Object.keys(__cfVals); };
var GM_getValues = function (keys) { var o = {}; (Array.isArray(keys) ? keys : Object.keys(keys || {})).forEach(function (k) { o[k] = GM_getValue(k, Array.isArray(keys) ? undefined : keys[k]); }); return o; };
var GM_setValues = function (o) { Object.keys(o).forEach(function (k) { GM_setValue(k, o[k]); }); };
var GM_addStyle = function (css) {
  var s = document.createElement('style'); s.textContent = css;
  var put = function () { var p = document.head || document.documentElement; if (p) p.append(s); else setTimeout(put, 0); };
  put(); return s;
};
var GM_addElement = function (parent, tag, attrs) {
  if (typeof parent === 'string') { attrs = tag; tag = parent; parent = document.head || document.documentElement; }
  var el = document.createElement(tag); Object.keys(attrs || {}).forEach(function (k) { if (k === 'textContent') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]); }); parent.append(el); return el;
};
var GM_log = function () { console.log.apply(console, arguments); };
var GM_notification = function (d) { __cfRec('GM_notification', [typeof d === 'string' ? d : (d && d.text)]); console.info('[GM_notification]', typeof d === 'string' ? d : JSON.stringify(d)); };
var GM_setClipboard = function (t) { __cfRec('GM_setClipboard', [String(t).slice(0, 200)]); };
var GM_openInTab = function (url, o) { __cfRec('GM_openInTab', [url]); if (__cfMode === 'persisted') __cfSend('openInTab', [url]); return { close: function () {}, closed: false }; };
var GM_registerMenuCommand = function (name) { __cfRec('GM_registerMenuCommand', [name]); return name; };
var GM_unregisterMenuCommand = function (name) { __cfRec('GM_unregisterMenuCommand', [name]); };
var GM_getResourceText = function (n) { __cfRec('GM_getResourceText', [n]); return ''; };
var GM_getResourceURL = function (n) { __cfRec('GM_getResourceURL', [n]); return ''; };
var GM_xmlhttpRequest = function (d) {
  var aborted = false;
  var fire = function (name, r) { try { if (!aborted && typeof d[name] === 'function') d[name](r); } catch (e) { console.error(e); } };
  if (__cfMode !== 'persisted') { __cfRec('GM_xmlhttpRequest', [d.method || 'GET', d.url]); setTimeout(function () { fire('onerror', { status: 0, error: 'recorded mode: no request made', finalUrl: d.url }); fire('onloadend', { status: 0 }); }, 0); return { abort: function () { aborted = true; } }; }
  __cfSend('xhr', [{ method: d.method || 'GET', url: String(d.url), headers: d.headers || {}, data: typeof d.data === 'string' ? d.data : d.data == null ? null : JSON.stringify(d.data), anonymous: !!d.anonymous, timeout: d.timeout || 0 }]).then(function (r) {
    if (r && r.error) { fire('onerror', r); fire('onloadend', r); return; }
    if (d.responseType === 'json') { try { r.response = JSON.parse(r.responseText); } catch (e) { r.response = null; } } else r.response = r.responseText;
    r.readyState = 4; fire('onreadystatechange', r); fire('onload', r); fire('onloadend', r);
  }, function (e) { fire('onerror', { status: 0, error: String(e) }); });
  return { abort: function () { aborted = true; } };
};
var GM = {
  info: GM_info,
  getValue: function (k, d) { return Promise.resolve(GM_getValue(k, d)); },
  setValue: function (k, v) { GM_setValue(k, v); return Promise.resolve(); },
  deleteValue: function (k) { GM_deleteValue(k); return Promise.resolve(); },
  listValues: function () { return Promise.resolve(GM_listValues()); },
  getValues: function (k) { return Promise.resolve(GM_getValues(k)); },
  setValues: function (o) { GM_setValues(o); return Promise.resolve(); },
  addStyle: function (c) { return Promise.resolve(GM_addStyle(c)); },
  addElement: function (a, b, c) { return Promise.resolve(GM_addElement(a, b, c)); },
  notification: function (d) { GM_notification(d); return Promise.resolve(); },
  setClipboard: function (t) { GM_setClipboard(t); return Promise.resolve(); },
  openInTab: function (u, o) { return Promise.resolve(GM_openInTab(u, o)); },
  registerMenuCommand: function (n) { return Promise.resolve(GM_registerMenuCommand(n)); },
  xmlHttpRequest: function (d) { return new Promise(function (res, rej) { GM_xmlhttpRequest(Object.assign({}, d, { onload: function (r) { if (d.onload) d.onload(r); res(r); }, onerror: function (r) { if (d.onerror) d.onerror(r); rej(r); } })); }); },
};
`;
}

const cf = (globalThis.cf = {
  ready: false,
  calls: [],
  timers: new Map(),
  /** GM writes being stored and rebuilds running (flush waits for both) */
  busy: 0,
  rebuilding: new Set(),

  /** After the server granted the userScripts permission: enable messaging from the USER_SCRIPT world. */
  async init() {
    if (!browser.userScripts) return { ok: false, error: 'userScripts API unavailable (permission not granted yet)' };
    try { await browser.userScripts.configureWorld({ messaging: true }); } catch (e) { return { ok: false, error: 'configureWorld: ' + e.message }; }
    if (!this.ready) {
      browser.runtime.onUserScriptMessage.addListener((m, sender) => this.onMessage(m, sender));
      this.ready = true;
    }
    return { ok: true };
  },

  async build(spec) {
    const values = (await browser.storage.local.get('gm:' + spec.id))['gm:' + spec.id] || {};
    // The prelude is joined onto line 1 and the whole file (metadata included) follows, so line numbers in errors
    // match the file on disk; sourceURL names the script in stacks and console entries (us_logs keys on it).
    const dev = spec.devPrelude ? `var __claude = { mark: function (label) { console.debug('[claude-mark] ' + JSON.stringify({ script: ${JSON.stringify(spec.name)}, label: String(label), t: Math.round(performance.now() * 10) / 10 })); }, ready: function () { __claude.mark('ready'); } }; try { console.debug('[claude-start] ' + JSON.stringify({ script: ${JSON.stringify(spec.name)} })); } catch (e) {}` : '';
    const head = (prelude(spec, values) + dev).replace(/\n/g, ' ');
    const us = {
      id: spec.id,
      matches: spec.matches && spec.matches.length ? spec.matches : ['<all_urls>'],
      // the eval hook (dev prelude) goes inside the wrapper, on line 1 too: it must share the script's scope
      js: [{ code: `${head}(function () {${spec.evalHook || ''}${spec.code}\n}).call(this);\n//# sourceURL=claude-fast/${spec.slug || spec.id}.user.js\n` }],
      runAt: spec.runAt || 'document_idle',
      world: spec.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
      allFrames: !spec.noframes,
    };
    if (spec.excludeMatches && spec.excludeMatches.length) us.excludeMatches = spec.excludeMatches;
    if (spec.includeGlobs && spec.includeGlobs.length) us.includeGlobs = spec.includeGlobs;
    if (spec.excludeGlobs && spec.excludeGlobs.length) us.excludeGlobs = spec.excludeGlobs;
    return us;
  },

  /** spec: { id, name, namespace, version, code, matches, excludeMatches, includeGlobs, excludeGlobs, runAt, world, noframes, gm, grants } */
  async register(spec) {
    const init = await this.init();
    if (!init.ok) throw new Error(init.error);
    await browser.storage.local.set({ ['script:' + spec.id]: spec });
    const us = await this.build(spec);
    const have = (await browser.userScripts.getScripts({ ids: [spec.id] })).length > 0;
    if (have) await browser.userScripts.update([us]); else await browser.userScripts.register([us]);
    return { id: spec.id, updated: have };
  },

  async unregister(id) {
    const have = (await browser.userScripts.getScripts({ ids: [id] })).length > 0;
    if (have) await browser.userScripts.unregister({ ids: [id] });
    await browser.storage.local.remove('script:' + id);
    return have;
  },

  async setEnabled(id, enabled) {
    const spec = (await browser.storage.local.get('script:' + id))['script:' + id];
    if (!spec) throw new Error('no fast-mode script ' + id);
    if (enabled) return this.register(spec);
    if ((await browser.userScripts.getScripts({ ids: [id] })).length) await browser.userScripts.unregister({ ids: [id] });
    return { id, disabled: true };
  },

  async list() {
    const reg = browser.userScripts ? await browser.userScripts.getScripts() : [];
    const all = await browser.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith('script:')).map((k) => {
      const s = all[k];
      return { id: s.id, name: s.name, version: s.version, matches: s.matches, runAt: s.runAt, world: s.world, gm: s.gm, enabled: reg.some((r) => r.id === s.id), values: Object.keys(all['gm:' + s.id] || {}).length };
    });
  },

  async getValues(id) { return (await browser.storage.local.get('gm:' + id))['gm:' + id] || {}; },

  async setValues(id, values, replace) {
    const before = await this.getValues(id);
    const next = replace ? {} : Object.assign({}, before);
    for (const [k, v] of Object.entries(values)) { if (v === null) delete next[k]; else next[k] = v; }
    await browser.storage.local.set({ ['gm:' + id]: next });
    await this.rebuild(id);
    return before;
  },

  async rebuild(id) {
    const spec = (await browser.storage.local.get('script:' + id))['script:' + id];
    if (!spec || !(await browser.userScripts.getScripts({ ids: [id] })).length) return;
    await browser.userScripts.update([await this.build(spec)]);
  },

  scheduleRebuild(id) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.runRebuild(id); }, 200));
  },

  async runRebuild(id) {
    this.rebuilding.add(id);
    try { await this.rebuild(id); } catch (e) { console.error('[companion] rebuild', e); } finally { this.rebuilding.delete(id); }
  },

  /**
   * Apply pending GM value changes now: a page load right after a GM_setValue would otherwise get the old values
   * baked into the registration (the rebuild is debounced). The server calls this before navigating.
   */
  async flush() {
    for (let i = 0; i < 100; i++) {
      const due = [...this.timers.keys()];
      for (const id of due) { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
      if (due.length) await Promise.all(due.map((id) => this.runRebuild(id)));
      else if (!this.busy && !this.rebuilding.size) return true;
      else await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  },

  record(id, op, args) {
    this.calls.push({ ts: Date.now(), id, op, args });
    if (this.calls.length > RECORD_MAX) this.calls.splice(0, this.calls.length - RECORD_MAX);
  },

  async onMessage(m, sender) {
    if (!m || typeof m.cfgm !== 'string') return undefined;
    const id = m.id, args = m.args || [];
    switch (m.cfgm) {
      case 'record': this.record(id, args[0], args[1]); return true;
      case 'setValue': case 'deleteValue': {
        this.busy++;
        try {
          const vals = await this.getValues(id);
          if (m.cfgm === 'setValue') vals[args[0]] = args[1]; else delete vals[args[0]];
          await browser.storage.local.set({ ['gm:' + id]: vals });
          this.record(id, m.cfgm === 'setValue' ? 'GM_setValue' : 'GM_deleteValue', [args[0]]);
          this.scheduleRebuild(id);
        } finally { this.busy--; }
        return true;
      }
      case 'openInTab': {
        this.record(id, 'GM_openInTab', args);
        const opener = sender && sender.tab;
        await browser.tabs.create({ url: args[0], active: false, ...(opener ? { windowId: opener.windowId, index: opener.index + 1 } : {}) });
        return true;
      }
      case 'xhr': {
        const d = args[0];
        const spec = (await browser.storage.local.get('script:' + id))['script:' + id];
        // attribution marker for network_read (the request itself carries nothing that names the script)
        console.debug('[claude-gmxhr] ' + JSON.stringify({ script: spec ? spec.name : id, method: d.method, url: d.url }));
        this.record(id, 'GM_xmlhttpRequest', [d.method, d.url]);
        try {
          const ctl = new AbortController();
          const timer = d.timeout ? setTimeout(() => ctl.abort(), d.timeout) : null;
          const res = await fetch(d.url, { method: d.method, headers: d.headers, body: d.data == null || d.method === 'GET' || d.method === 'HEAD' ? undefined : d.data, credentials: d.anonymous ? 'omit' : 'include', signal: ctl.signal });
          if (timer) clearTimeout(timer);
          const text = await res.text();
          const headers = [...res.headers.entries()].map(([k, v]) => k + ': ' + v).join('\r\n');
          return { status: res.status, statusText: res.statusText, responseText: text, finalUrl: res.url, responseHeaders: headers };
        } catch (e) {
          return { status: 0, error: String(e && e.message || e), finalUrl: d.url };
        }
      }
      default: return undefined;
    }
  },
});

// re-arm after a background restart (the permission persists for the life of the temporary add-on)
if (browser.userScripts) cf.init().catch(() => {});
