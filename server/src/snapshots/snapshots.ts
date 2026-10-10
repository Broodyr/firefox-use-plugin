// snapshots and rollback.
// Warm snapshot (Firefox running): non-default prefs, add-on enabled states, every extension's storage.local/sync
// and the per-profile managed storage. Stored as JSON under <workspace>/.firefox-use/snapshots/<id>/.
// Cold snapshot: a copy of the profile directory taken while Firefox is stopped, under HOME/snapshots/<profile>/.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ensureDir, loadConfig } from '../config.js';
import { stateDir } from '../audit/audit.js';
import { ToolError, fail } from '../errors.js';
import * as XS from '../browser/extScripts.js';
import type { Browser } from '../browser/session.js';
import { PROTECTED_PREFS } from '../transports/privileged.js';
import { UBO_ID, uboCapture, uboDiff, uboRestoreData, type UboUserData } from '../adapters/ubo.js';
import { STYLUS_ID, stylusCapture, stylusDiff, stylusRestore, type StylusStyle } from '../adapters/stylus.js';

/** Prefs never captured or restored: protected branches, per-run bookkeeping, telemetry, extension UUIDs. */
export const PREF_SKIP = '^(devtools\\.debugger\\.|remote\\.|security\\.|xpinstall\\.|signon\\.|devtools\\.chrome\\.enabled$|app\\.update\\.|toolkit\\.telemetry\\.|datareporting\\.|browser\\.laterrun\\.|idle\\.|places\\.|services\\.|identity\\.|extensions\\.webextensions\\.uuids$|extensions\\.webextensions\\.ExtensionStorageIDB\\.|extensions\\.lastAppBuildId$|extensions\\.lastAppVersion$|extensions\\.lastPlatformVersion$|extensions\\.databaseSchema$|extensions\\.xpiState$|extensions\\.pendingOperations$|media\\.gmp|browser\\.sessionstore\\.|browser\\.startup\\.|browser\\.pagethumbnails\\.|browser\\.migration\\.|dom\\.push\\.|gfx\\.|layers\\.|nimbus\\.|browser\\.newtabpage\\.|storage\\.vacuum\\.|privacy\\.purge_trackers\\.|browser\\.engagement\\.|browser\\.bookmarks\\.|distribution\\.|network\\.predictor\\.|network\\.trr\\.|termsofuse\\.|captchadetection\\.|doh-rollout\\.)';

const MAX_VALUE = 2_000_000;

export interface SnapMeta { id: string; label: string; ts: string; profile: string; auto: boolean; kind: 'warm' | 'cold'; firefox?: string; notes?: string[]; dir: string }

export interface WarmData {
  prefs: Record<string, unknown>;
  addons: Record<string, { active: boolean; version: string; temporary: boolean; name: string; source?: string | null }>;
  storage: Record<string, { local?: Record<string, unknown>; sync?: Record<string, unknown>; skipped: string[] }>;
  managed: Record<string, unknown>;
  /** uBO's user-authored state through its own messaging: restored with targeted writes, independent of storage layout */
  ubo?: UboUserData;
  /** Stylus's styles with their source (its own IndexedDB, which storage.local doesn't cover), through its API */
  stylus?: StylusStyle[];
}

/** ISO timestamp -> local "YYYY-MM-DD HH:MM:SS" (snapshot ids use local time too). */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const newId = (kind: 'warm' | 'cold') => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${kind === 'cold' ? 'c' : 's'}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 5)}`;
};

/** Keys never captured per extension (derived caches); uBO keeps downloaded/compiled filter lists in storage.local. */
async function skipFor(b: Browser, id: string): Promise<string | null> {
  if (id !== 'uBlock0@raymondhill.net') return null;
  // cache/<list id> are downloaded lists (re-fetchable); keep user-authored entries (cache/user-filters etc.)
  try {
    const r = await b.callChrome<{ values: Record<string, any> }>(XS.EXT_STORAGE_GET, { id, area: 'local', keys: ['availableFilterLists'], skip: null });
    const lists = Object.keys(r.values.availableFilterLists ?? {}).filter((k) => !k.startsWith('user-'));
    const esc = lists.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return `^cache/(compiled/|selfie/${esc.length ? `|(${esc.join('|')}|public_suffix_list\\.dat|assets\\.json)$` : ''})`;
  } catch { return '^cache/(compiled/|selfie/)'; }
}

export async function captureWarm(b: Browser): Promise<{ data: WarmData; notes: string[] }> {
  const notes: string[] = [];
  const prefs = await b.callChrome<Record<string, unknown>>(XS.PREFS_USER, { skip: PREF_SKIP });
  const addons = await b.callChrome<WarmData['addons']>(XS.ADDON_STATES);
  const storage: WarmData['storage'] = {};
  const managed: Record<string, unknown> = {};
  for (const id of await b.callChrome<string[]>(XS.MANAGED_LIST).catch(() => [])) {
    managed[id] = (await b.callChrome<{ data: unknown }>(XS.MANAGED_GET, { id })).data;
  }
  for (const [id, a] of Object.entries(addons)) {
    if (!a.active) continue;
    const skip = await skipFor(b, id);
    const entry: WarmData['storage'][string] = { skipped: [] };
    for (const area of ['local', 'sync'] as const) {
      try {
        const r = await b.callChrome<{ values: Record<string, unknown>; sizes: Record<string, number>; skipped: string[] }>(XS.EXT_STORAGE_GET, { id, area, keys: null, skip });
        for (const [k, n] of Object.entries(r.sizes)) {
          if (n > MAX_VALUE && k in r.values) { delete r.values[k]; entry.skipped.push(`${area}:${k}`); notes.push(`${a.name}: ${area}.${k} (${n} chars) too large; not captured`); }
        }
        entry.skipped.push(...r.skipped.map((k) => `${area}:${k}`));
        if (Object.keys(r.values).length) entry[area] = r.values;
      } catch (e: any) {
        if (area === 'local') notes.push(`${a.name}: storage.${area} unreadable (${e.message})`);
      }
    }
    storage[id] = entry;
  }
  let ubo: UboUserData | undefined;
  if (addons[UBO_ID]?.active) {
    try { ubo = await uboCapture(b); } catch (e: any) { notes.push(`uBlock Origin: user data not captured (${e.message})`); }
  }
  let stylus: StylusStyle[] | undefined;
  if (addons[STYLUS_ID]?.active) {
    try { stylus = await stylusCapture(b); } catch (e: any) { notes.push(`Stylus: styles not captured (${e.message})`); }
  }
  return { data: { prefs, addons, storage, managed, ...(ubo ? { ubo } : {}), ...(stylus ? { stylus } : {}) }, notes };
}

export function snapshotsDir(): string { return stateDir('snapshots'); }
function coldDir(profile: string): string { return ensureDir(path.join(HOME, 'snapshots', profile)); }

function pointerFile(profile: string) { return path.join(ensureDir(loadConfig().runDir), `${profile}.last-checkpoint.json`); }

/** Take and store a warm snapshot. */
export async function takeWarm(b: Browser, label: string, auto: boolean): Promise<SnapMeta> {
  const { data, notes } = await captureWarm(b);
  const id = newId('warm');
  const dir = ensureDir(path.join(snapshotsDir(), id));
  const meta: SnapMeta = { id, label, ts: new Date().toISOString(), profile: b.state.key, auto, kind: 'warm', firefox: b.versions?.firefox, notes, dir };
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  if (!b.state.throwaway) fs.writeFileSync(pointerFile(b.state.key), JSON.stringify({ id, dir, ts: meta.ts }));
  pruneAuto();
  return meta;
}

/** Keep the newest 20 automatic warm snapshots in this workspace. */
function pruneAuto() {
  const all = listSnapshots().filter((s) => s.kind === 'warm' && s.auto);
  for (const s of all.slice(0, Math.max(0, all.length - 20))) { try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* in use */ } }
}

export function listSnapshots(profile?: string): SnapMeta[] {
  const out: SnapMeta[] = [];
  const read = (dir: string) => { try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); out.push({ ...m, dir }); } catch { /* partial */ } };
  const base = snapshotsDir();
  for (const d of fs.readdirSync(base)) read(path.join(base, d));
  const cold = path.join(HOME, 'snapshots');
  if (fs.existsSync(cold)) for (const p of fs.readdirSync(cold)) {
    if (profile && p !== profile) continue;
    for (const d of fs.readdirSync(path.join(cold, p))) read(path.join(cold, p, d));
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function findSnapshot(id: string): SnapMeta {
  const s = listSnapshots().find((x) => x.id === id);
  if (!s) fail('SNAPSHOT_NOT_FOUND', `no snapshot ${id}`, 'snapshot_list shows the available ones.');
  return s!;
}

export function readWarm(s: SnapMeta): WarmData {
  if (s.kind !== 'warm') fail('BAD_ARGS', `${s.id} is a cold snapshot (a profile copy); restore it whole with restore(id)`);
  return JSON.parse(fs.readFileSync(path.join(s.dir, 'data.json'), 'utf8'));
}

// ------------------------------------------------------------ diff
const j = (v: unknown) => { try { return JSON.stringify(v); } catch { return String(v); } };
const short = (v: unknown, n = 120) => { const s = v === undefined ? '(absent)' : j(v); return s.length > n ? s.slice(0, n) + `… (${s.length})` : s; };

export function diffWarm(a: WarmData, b: WarmData, detail: string): string[] {
  const out: string[] = [];
  const keys = (x: object) => Object.keys(x);
  for (const k of new Set([...keys(a.prefs), ...keys(b.prefs)])) {
    if (j(a.prefs[k]) !== j(b.prefs[k])) out.push(`pref ${k}: ${short(a.prefs[k])} -> ${short(b.prefs[k])}`);
  }
  for (const k of new Set([...keys(a.addons), ...keys(b.addons)])) {
    const x = a.addons[k], y = b.addons[k];
    if (!x || !y) out.push(`add-on ${(x ?? y)!.name}: ${x ? 'present' : 'absent'} -> ${y ? 'present' : 'absent'}`);
    else if (x.active !== y.active || x.version !== y.version) out.push(`add-on ${x.name}: ${x.active ? 'on' : 'off'} ${x.version} -> ${y.active ? 'on' : 'off'} ${y.version}`);
  }
  if (a.ubo && b.ubo) out.push(...uboDiff(a.ubo, b.ubo));
  if (a.stylus && b.stylus) out.push(...stylusDiff(a.stylus, b.stylus));
  for (const id of new Set([...keys(a.storage), ...keys(b.storage)])) {
    // uBO's raw storage mirrors the ubo part above; show it only in full detail
    if (id === UBO_ID && a.ubo && b.ubo && detail !== 'full') continue;
    const name = a.addons[id]?.name ?? b.addons[id]?.name ?? id;
    for (const area of ['local', 'sync'] as const) {
      const x = a.storage[id]?.[area] ?? {}, y = b.storage[id]?.[area] ?? {};
      const changed = [...new Set([...keys(x), ...keys(y)])].filter((k) => j(x[k]) !== j(y[k]));
      if (!changed.length) continue;
      if (detail === 'summary' && changed.length > 8) out.push(`${name} storage.${area}: ${changed.length} keys changed (${changed.slice(0, 8).join(', ')}, …)`);
      else for (const k of changed) out.push(`${name} storage.${area}.${k}: ${short(x[k], detail === 'full' ? 2000 : 120)} -> ${short(y[k], detail === 'full' ? 2000 : 120)}`);
    }
  }
  for (const id of new Set([...keys(a.managed), ...keys(b.managed)])) {
    if (j(a.managed[id]) !== j(b.managed[id])) out.push(`managed storage ${id}: ${short(a.managed[id])} -> ${short(b.managed[id])}`);
  }
  return out;
}

// ------------------------------------------------------------ restore
export interface RestoreResult { lines: string[]; changes: { kind: string; path?: string; before?: unknown; after?: unknown }[] }

/** parts: prefs | addons | ext_storage | ext_storage:<id> | managed | ubo | stylus (default all). */
export async function restoreWarm(b: Browser, snap: WarmData, parts?: string[]): Promise<RestoreResult> {
  const want = (p: string, id?: string) => !parts?.length || parts.includes(p) || (id !== undefined && parts.includes(`${p}:${id}`));
  const lines: string[] = [];
  const changes: RestoreResult['changes'] = [];
  const cur = (await captureWarm(b)).data;
  if (want('prefs')) {
    const values: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(snap.prefs), ...Object.keys(cur.prefs)])) {
      if (PROTECTED_PREFS.test(k)) continue;
      if (j(snap.prefs[k]) !== j(cur.prefs[k])) values[k] = k in snap.prefs ? snap.prefs[k] : null;
    }
    if (Object.keys(values).length) {
      const r = await b.callChrome<{ before: Record<string, unknown> }>(XS.PREFS_SET, { values });
      for (const k of Object.keys(values)) changes.push({ kind: 'pref', path: k, before: r.before[k], after: values[k] });
    }
    lines.push(`prefs: ${Object.keys(values).length} changed`);
  }
  if (want('addons')) {
    let n = 0;
    for (const [id, s] of Object.entries(snap.addons)) {
      const c = cur.addons[id];
      if (!c) {
        // temporary add-ons vanish with a Firefox restart; a snapshot can't reinstall them, but can say how
        if (id === 'companion@firefox-use') lines.push(`add-on ${s.name}: not installed (it is reinstalled at every launch)`);
        else if (s.temporary) lines.push(`add-on ${s.name} (temporary) is not installed: reinstall it with addons_install_local(${JSON.stringify(s.source ?? '<its source folder>')})`);
        else lines.push(`add-on ${s.name}: no longer installed (skipped)`);
        continue;
      }
      if (c.active !== s.active) {
        await b.callChrome(XS.ADDON_SET_ENABLED, { id, enabled: s.active });
        changes.push({ kind: 'addon_enabled', path: id, before: c.active, after: s.active });
        n++;
      }
    }
    lines.push(`add-ons: ${n} enabled state(s) changed`);
  }
  const reload = new Set<string>();
  // uBO: its own messaging (ubo part) instead of raw storage, unless ext_storage:<uBO id> is asked for explicitly
  const uboByMessaging = !!snap.ubo && want('ubo') && !parts?.includes(`ext_storage:${UBO_ID}`);
  if (uboByMessaging && snap.ubo) {
    if (await b.callChrome<boolean>(`({ id }) => !!WebExtensionPolicy.getByID(id)`, { id: UBO_ID })) {
      const l = await uboRestoreData(b, snap.ubo);
      lines.push(...(l.length ? l : ['uBO: user data unchanged']));
      if (l.length) changes.push({ kind: 'ubo_restore_part', path: UBO_ID, after: '(from snapshot)' });
    } else lines.push('uBlock Origin: not running; user data not restored');
  }
  if (snap.stylus && want('stylus')) {
    if (await b.callChrome<boolean>(`({ id }) => !!WebExtensionPolicy.getByID(id)`, { id: STYLUS_ID })) {
      const l = await stylusRestore(b, snap.stylus);
      lines.push(...(l.length ? l : ['Stylus: styles unchanged']));
      if (l.length) changes.push({ kind: 'stylus_restore_part', path: STYLUS_ID, after: '(from snapshot)' });
    } else lines.push('Stylus: not running; styles not restored');
  }
  for (const [id, s] of Object.entries(snap.storage)) {
    if (!want('ext_storage', id)) continue;
    if (id === UBO_ID && uboByMessaging) continue;
    const name = snap.addons[id]?.name ?? id;
    const live = await b.callChrome<boolean>(`({ id }) => !!WebExtensionPolicy.getByID(id)`, { id });
    if (!live) { lines.push(`${name}: not running; storage not restored`); continue; }
    for (const area of ['local', 'sync'] as const) {
      const want = s[area] ?? {}, now = cur.storage[id]?.[area] ?? {};
      const skipped = new Set(s.skipped.filter((x) => x.startsWith(`${area}:`)).map((x) => x.slice(area.length + 1)));
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(want)) if (j(v) !== j(now[k])) set[k] = v;
      const remove = Object.keys(now).filter((k) => !(k in want) && !skipped.has(k));
      if (Object.keys(set).length) await b.callChrome(XS.EXT_STORAGE_SET, { id, area, items: set });
      if (remove.length) await b.callChrome(XS.EXT_STORAGE_REMOVE, { id, area, keys: remove });
      const n = Object.keys(set).length + remove.length;
      if (n) {
        reload.add(id);
        lines.push(`${name} storage.${area}: ${Object.keys(set).length} set, ${remove.length} removed`);
        for (const k of Object.keys(set)) changes.push({ kind: 'ext_storage', path: `${id}|${area}|${k}`, after: '(from snapshot)' });
        for (const k of remove) changes.push({ kind: 'ext_storage', path: `${id}|${area}|${k}`, after: { $absent: true } });
      }
    }
  }
  if (want('managed')) {
    for (const id of new Set([...Object.keys(snap.managed), ...Object.keys(cur.managed)])) {
      if (j(snap.managed[id]) === j(cur.managed[id])) continue;
      await b.callChrome(XS.MANAGED_INSTALL);
      await b.callChrome(XS.MANAGED_SET, { id, data: snap.managed[id] ?? null });
      changes.push({ kind: 'managed_storage', path: id, before: cur.managed[id] ?? null, after: snap.managed[id] ?? null });
      reload.add(id);
      lines.push(`managed storage ${id}: restored`);
    }
  }
  // extensions keep in-memory state (Violentmonkey's script list, uBO's filters): reload them to pick up storage
  for (const id of reload) {
    if (await b.callChrome<boolean>(`({ id }) => !!WebExtensionPolicy.getByID(id)`, { id })) {
      await b.callChrome(XS.ADDON_RELOAD, { id }).catch(() => {});
      lines.push(`reloaded ${snap.addons[id]?.name ?? id}`);
    }
  }
  await b.devtools?.updateExtensions();
  return { lines, changes };
}

// ------------------------------------------------------------ cold snapshots (profile copies)
const COLD_SKIP = new Set(['parent.lock', 'lock', '.parentlock', 'cache2', 'startupCache', 'crashes', 'minidumps', 'thumbnails', 'shader-cache', 'jumpListCache', 'datareporting', 'saved-telemetry-pings']);

export function copyProfileCold(src: string, dst: string) {
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !COLD_SKIP.has(path.basename(p)) && !p.endsWith('-wal') && !p.endsWith('-shm') });
}

/** Copy a (stopped) profile into HOME/snapshots/<profile>/<id>/profile. */
export function takeColdCopy(profileKey: string, profileDir: string, label: string, auto: boolean, firefox?: string): SnapMeta {
  const id = newId('cold');
  const dir = ensureDir(path.join(coldDir(profileKey), id));
  copyProfileCold(profileDir, path.join(dir, 'profile'));
  const meta: SnapMeta = { id, label, ts: new Date().toISOString(), profile: profileKey, auto, kind: 'cold', firefox, dir };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  // keep the newest 3 automatic cold snapshots per profile
  const autos = listSnapshots(profileKey).filter((s) => s.kind === 'cold' && s.auto && s.profile === profileKey);
  for (const s of autos.slice(0, Math.max(0, autos.length - 3))) { try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  return meta;
}

/**
 * Daily automatic cold snapshot: on the first launch of the local calendar day, taken just before launching
 * Firefox (the profile is not in use then). Returns a launch note, or null when none was due.
 */
export function maybeDailyCold(profileKey: string, profileDir: string): string | null {
  if (process.env.FIREFOX_USE_NO_COLD) return null;
  const last = listSnapshots(profileKey).filter((s) => s.kind === 'cold' && s.profile === profileKey).pop();
  if (last && new Date(last.ts).toDateString() === new Date().toDateString()) return null;
  const t0 = Date.now();
  try {
    const m = takeColdCopy(profileKey, profileDir, 'auto: daily (before launch)', true);
    return `cold snapshot ${m.id} (daily, before launch) in ${Date.now() - t0} ms`;
  } catch (e: any) {
    return `daily cold snapshot FAILED: ${e?.message ?? e}`;
  }
}

/** Replace a stopped profile directory with a cold snapshot; the previous contents are kept beside it. */
export function restoreColdCopy(snap: SnapMeta, profileDir: string): string {
  const src = path.join(snap.dir, 'profile');
  if (!fs.existsSync(src)) throw new ToolError('SNAPSHOT_BROKEN', `${snap.id} has no profile copy`);
  const keep = `${profileDir}.pre-restore`;
  fs.rmSync(keep, { recursive: true, force: true });
  fs.renameSync(profileDir, keep);
  copyProfileCold(src, profileDir);
  return keep;
}

export function lastCheckpoint(profile: string): { id: string; dir: string } | null {
  try { return JSON.parse(fs.readFileSync(pointerFile(profile), 'utf8')); } catch { return null; }
}
