// Privileged (chrome-context) evaluation with the denylist.
// The transport itself is BiDi "moz:scope": "chrome"; Browser.callChrome does the call.
// This module adds the checks every *caller-supplied* privileged code path goes through:
// a source denylist, and a before/after guard on the protected pref branches.
import { ToolError } from '../errors.js';
import type { Browser } from '../browser/session.js';

/** Sources that must never be touched from privileged code (credentials, sync/FxA, key stores). */
const DENY: [RegExp, string][] = [
  [/Services\s*\.\s*logins|nsILoginManager|LoginManager|LoginHelper|logins\.json|loginManager/i, 'saved logins'],
  [/key[34]\.db|cert[89]\.db|nsIPK11|PK11|OSKeyStore|nsIX509CertDB|osKeyStore/i, 'key and certificate stores'],
  [/FxAccounts|fxAccounts|services-sync|Weave|resource:\/\/services-sync|resource:\/\/gre\/modules\/FxA|identity\.fxaccounts/i, 'Firefox Sync / accounts'],
  [/nsILoginInfo|formautofill|FormAutofill|CreditCard|creditcards|autofill-profiles/i, 'saved logins / payment data'],
];

/** Pref branches privileged code may not change: remote-control, debugger, security, add-on install policy. */
export const PROTECTED_PREFS = /^(devtools\.debugger\.|remote\.|security\.|xpinstall\.|devtools\.chrome\.enabled$|signon\.)/;

/** Throw DENIED if the code references a denylisted source. */
export function checkDenylist(code: string, what = 'privileged code'): void {
  for (const [re, label] of DENY) {
    const m = re.exec(code);
    if (m) {
      throw new ToolError('DENIED', `${what} references ${label} ("${m[0]}"), which is on the privileged denylist`,
        'The dev profile has no secrets by design; this area is never automated. Ask the user if you believe this is a mistake.');
    }
  }
  // literal pref writes to a protected branch
  const pw = /(?:set(?:Bool|Int|Char|String|Complex)Pref|clearUserPref|lockPref|unlockPref|resetBranch|deleteBranch)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (let m; (m = pw.exec(code));) {
    if (PROTECTED_PREFS.test(m[1])) throw new ToolError('DENIED', `${what} writes the protected pref ${m[1]}`, 'Debugger, remote, security and xpinstall prefs are never changed by Claude.');
  }
}

/** Snapshot of every user-set protected pref (name -> value), to detect changes made indirectly. */
const PROTECTED_SNAPSHOT = `() => {
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

const PROTECTED_RESTORE = `({ changed }) => {
  for (const [n, was] of Object.entries(changed)) {
    try {
      if (!was) { Services.prefs.clearUserPref(n); continue; }
      const [user, v, t] = was;
      if (!user) Services.prefs.clearUserPref(n);
      else if (t === 32) Services.prefs.setStringPref(n, v);
      else if (t === 64) Services.prefs.setIntPref(n, v);
      else if (t === 128) Services.prefs.setBoolPref(n, v);
    } catch {}
  }
  return true;
}`;

/**
 * Run caller-supplied privileged code: denylist check, then evaluation with a guard that reverts any change
 * to a protected pref and reports it as DENIED. Returns the JSON-able result.
 */
export async function evalPrivileged(b: Browser, code: string, o: { timeoutMs?: number } = {}): Promise<{ value: unknown; type: string }> {
  checkDenylist(code);
  const before = await b.callChrome<Record<string, unknown>>(PROTECTED_SNAPSHOT);
  let out: { value: unknown; type: string };
  try {
    out = await b.callChrome(`async ({ code }) => {
      const fn = new Function("return (async () => {\\n" + code + "\\n})()");
      let v;
      try { v = await fn(); }
      catch (e) { return { exception: String(e && e.message || e), stack: String(e && e.stack || '').split('\\n').slice(0, 6).join('\\n') }; }
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      const seen = new WeakSet();
      const ser = (x, d) => {
        if (x === undefined) return '[undefined]';
        if (typeof x === 'function') return '[function ' + (x.name || 'anonymous') + ']';
        if (typeof x === 'bigint') return x + 'n';
        if (typeof x === 'symbol') return String(x);
        if (!x || typeof x !== 'object') return x;
        if (seen.has(x)) return '[circular]';
        seen.add(x);
        if (d > 4) return '[' + (x.constructor && x.constructor.name || 'object') + ']';
        try {
          if (x instanceof Ci.nsISupports && !(x instanceof Object)) return '[xpcom ' + String(x) + ']';
        } catch {}
        if (x instanceof Error) return { error: String(x.message), stack: String(x.stack || '').split('\\n').slice(0, 4).join('\\n') };
        if (Array.isArray(x)) return x.slice(0, 200).map((y) => ser(y, d + 1));
        if (x instanceof Map) return { '[Map]': [...x.entries()].slice(0, 200).map(([k, y]) => [ser(k, d + 1), ser(y, d + 1)]) };
        if (x instanceof Set) return { '[Set]': [...x].slice(0, 200).map((y) => ser(y, d + 1)) };
        const o = {};
        let n = 0;
        for (const k of Object.keys(x)) { if (n++ >= 200) { o['…'] = 'more keys'; break; } try { o[k] = ser(x[k], d + 1); } catch (e) { o[k] = '[throws]'; } }
        return o;
      };
      return { value: ser(v, 0), type };
    }`, { code }, undefined);
  } finally {
    const after = await b.callChrome<Record<string, unknown>>(PROTECTED_SNAPSHOT).catch(() => before);
    const changed: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = before[k] ?? null;
    }
    if (Object.keys(changed).length) {
      await b.callChrome(PROTECTED_RESTORE, { changed }).catch(() => {});
      throw new ToolError('DENIED', `privileged code changed protected pref(s) ${Object.keys(changed).join(', ')}; the change was reverted`,
        'Debugger, remote, security and xpinstall prefs are never changed by Claude.');
    }
  }
  const r = out as any;
  if (r && r.exception !== undefined) throw new ToolError('PRIVILEGED_EXCEPTION', r.exception, 'The code threw; see stack.', { stack: r.stack });
  return out;
}

/**
 * Heuristic for eval_privileged without writes:true: obvious persistent-state changes (prefs, add-ons, files,
 * extension storage). Narrow on purpose; it only nudges Claude to declare writes (scope + checkpoint).
 */
export function looksLikeWrite(code: string): boolean {
  return /\b(set(?:Bool|Int|Char|String|Complex)Pref|clearUserPref|resetBranch|deleteBranch)\s*\(|\.(uninstall|enable|disable|reload|installTemporaryAddon|getInstallForFile|getInstallForURL)\s*\(|applyBackgroundUpdates\s*=|\bIOUtils\.(write|remove|move|copy|setPermissions)|\bstorage\.(local|sync|session)\.(set|remove|clear)\b/.test(code);
}
