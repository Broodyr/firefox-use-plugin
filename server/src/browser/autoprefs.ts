// The remote agent's "recommended" automation prefs (RecommendedPreferences.sys.mjs: Safe Browsing off, no
// crash-session restore, ...) are set at startup only where the pref has no user value, tracked, and cleared at a
// clean shutdown. After a kill or crash they stay behind as ordinary user values, and since they then have a user
// value the agent never tracks (or clears) them again: claude-dev keeps them for good, also in a plain (login)
// window, where they make the browser look automated. At each launch of a lasting profile, the ones that are
// stuck (value == the recommended one, untracked, and not the user's own choice in their main profile) are cleared
// and handed back to the agent's tracker, so the next clean quit removes them.
import fs from 'node:fs';
import path from 'node:path';
import { detectMainProfile, loadConfig } from '../config.js';
import type { Browser } from './session.js';
import { RECOMMENDED } from './internals.js';

/** user_pref values of a profile's prefs.js (strings, numbers, booleans). */
export function readUserPrefs(dir: string | null | undefined): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (!dir) return m;
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'prefs.js'), 'utf8'); } catch { return m; }
  for (const x of text.matchAll(/^user_pref\("((?:[^"\\]|\\.)+)",\s*(.+)\);\s*$/gm)) {
    try { m.set(x[1], JSON.parse(x[2])); } catch { /* not a plain literal */ }
  }
  return m;
}

const UNSTICK = `async ({ keepIfMain, keepUserJs }) => {
  ${RECOMMENDED}
  const read = (k) => { const t = Services.prefs.getPrefType(k); return t === 32 ? Services.prefs.getStringPref(k) : t === 64 ? Services.prefs.getIntPref(k) : t === 128 ? Services.prefs.getBoolPref(k) : undefined; };
  const stuck = recommended.filter(([k, v]) => Services.prefs.prefHasUserValue(k) && !RecommendedPreferences.alteredPrefs.has(k) && read(k) === v && !(k in keepIfMain && keepIfMain[k] === v) && !keepUserJs.includes(k));
  for (const [k] of stuck) Services.prefs.clearUserPref(k);
  // tracked again: cleared at the next clean shutdown, like on a fresh start
  RecommendedPreferences.applyPreferences(new Map(stuck));
  return { stuck: stuck.map(([k]) => k), known: recommended.length };
}`;

export async function unstickAutomationPrefs(b: Browser): Promise<string | null> {
  // the user's own choices (e.g. copied by profile_sync) stay theirs
  const main = readUserPrefs(loadConfig().mainProfile ?? detectMainProfile());
  const keepIfMain = Object.fromEntries(main);
  // prefs the profile's user.js sets (claude-dev's own startup prefs) are set again at every start: not leftovers
  let keepUserJs: string[] = [];
  try { keepUserJs = [...fs.readFileSync(path.join(b.state.profileDir, 'user.js'), 'utf8').matchAll(/user_pref\("([^"]+)"/g)].map((m) => m[1]); } catch { /* none */ }
  const r = await b.callChrome<{ stuck: string[]; known: number }>(UNSTICK, { keepIfMain, keepUserJs });
  if (!r.known) return 'could not read the remote agent\'s recommended prefs (internals changed); leftover automation prefs not checked';
  return r.stuck.length ? `${r.stuck.length} automation pref(s) left behind by an unclean shutdown are tracked again and go away at the next clean quit (${r.stuck.slice(0, 6).join(', ')}${r.stuck.length > 6 ? ', …' : ''})` : null;
}
