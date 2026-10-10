// "Drift from the main profile": read Violentmonkey's scripts from ANOTHER profile's storage on disk
// (the user's main profile, never written), compare them with claude-dev's, and sync one script on request.
//
// Firefox keeps extension storage.local in IndexedDB (ExtensionStorageIDB): one SQLite file per extension under
// storage/default/moz-extension+++<uuid>^userContextId=4294967295/idb/. The folder is copied to a temporary
// directory first (SQLite + its WAL), so a running Firefox's live files are never opened. Values are SpiderMonkey
// structured clones, snappy-compressed; values over the IDB inline limit live in <db>.files/<n> (snappy framing
// format; read directly, they are written once). Keys use IDB's key encoding (0x30, then each char + 1).
// Verified 2026-10-05 against the user's main profile while its Firefox ran (309 values, 4 external).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { detectMainProfile, loadConfig } from '../config.js';
import type { Browser } from '../browser/session.js';
import * as XS from '../browser/extScripts.js';
import { PRELUDE_MARK_TAGS, VM_ID, decodeValue, hashOf, vmScripts, type VmScript } from './violentmonkey.js';

// ------------------------------------------------------------ decoders
/** Raw snappy block. */
export function snappy(buf: Buffer): Buffer {
  let p = 0, len = 0, shift = 0;
  for (;;) { const c = buf[p++]; len += (c & 0x7f) * 2 ** shift; if (c < 0x80) break; shift += 7; }
  const out = Buffer.alloc(len);
  let o = 0;
  while (p < buf.length) {
    const tag = buf[p++], t = tag & 3;
    if (t === 0) {
      let n = tag >> 2;
      if (n >= 60) { const k = n - 59; n = 0; for (let i = 0; i < k; i++) n += buf[p++] * 2 ** (8 * i); }
      n += 1;
      buf.copy(out, o, p, p + n); p += n; o += n;
      continue;
    }
    let n: number, off: number;
    if (t === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | buf[p++]; }
    else if (t === 2) { n = (tag >> 2) + 1; off = buf.readUInt16LE(p); p += 2; }
    else { n = (tag >> 2) + 1; off = buf.readUInt32LE(p); p += 4; }
    if (!off || off > o) throw new Error('snappy: bad offset');
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
  }
  if (o !== len) throw new Error('snappy: length mismatch');
  return out;
}

/** Snappy framing format (stream identifier, then compressed / uncompressed chunks). */
export function snappyFramed(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const type = buf[p], len = buf[p + 1] | (buf[p + 2] << 8) | (buf[p + 3] << 16);
    p += 4;
    if (type === 0x00) parts.push(snappy(buf.subarray(p + 4, p + len)));
    else if (type === 0x01) parts.push(buf.subarray(p + 4, p + len));
    p += len;
  }
  return Buffer.concat(parts);
}

/** IndexedDB key -> string (only string keys; extension storage uses no others). */
export function decodeIdbKey(b: Uint8Array): string | null {
  if (b[0] !== 0x30) return null;
  let s = '';
  for (let i = 1; i < b.length;) {
    const c = b[i];
    if (!(c & 0x80)) { s += String.fromCharCode(c - 1); i++; }
    else if (!(c & 0x40)) { s += String.fromCharCode((((c & 0x3f) << 8) | b[i + 1]) - 0x7f); i += 2; }
    else { s += String.fromCharCode(((c & 0x3f) << 10) | (b[i + 1] << 2) | (b[i + 2] >> 6)); i += 3; }
  }
  return s;
}

const T = { FLOAT_MAX: 0xfff00000, HEADER: 0xfff10000, NULL: 0xffff0000, UNDEF: 0xffff0001, BOOL: 0xffff0002, INT32: 0xffff0003, STRING: 0xffff0004, DATE: 0xffff0005, ARRAY: 0xffff0007, OBJECT: 0xffff0008, BOOL_OBJ: 0xffff000a, STRING_OBJ: 0xffff000b, NUMBER_OBJ: 0xffff000c, BACKREF: 0xffff000d, MAP: 0xffff0011, SET: 0xffff0012, END: 0xffff0013 };

/** SpiderMonkey structured clone data -> JS value (the plain-data subset extension storage holds). */
export function structuredClone(buf: Buffer): unknown {
  let p = 0;
  const objs: unknown[] = [];
  const word = () => { const data = buf.readUInt32LE(p), tag = buf.readUInt32LE(p + 4); p += 8; return { tag, data }; };
  const str = (data: number) => {
    const latin1 = !!(data & 0x80000000), n = data & 0x7fffffff, bytes = latin1 ? n : n * 2;
    const s = buf.toString(latin1 ? 'latin1' : 'utf16le', p, p + bytes);
    p += (bytes + 7) & ~7;
    return s;
  };
  const read = (): unknown => {
    const w = word();
    if (w.tag === T.HEADER) return read();
    if (w.tag < T.FLOAT_MAX) return buf.readDoubleLE(p - 8);
    switch (w.tag) {
      case T.NULL: return null;
      case T.UNDEF: return undefined;
      case T.BOOL: return !!w.data;
      case T.INT32: return w.data | 0;
      case T.STRING: return str(w.data);
      case T.DATE: case T.NUMBER_OBJ: { const d = buf.readDoubleLE(p); p += 8; return w.tag === T.DATE ? new Date(d).toISOString() : d; }
      case T.BOOL_OBJ: return !!w.data;
      case T.STRING_OBJ: { const s = word(); return str(s.data); }
      case T.BACKREF: return objs[w.data];
      case T.ARRAY: case T.OBJECT: {
        const o: any = w.tag === T.ARRAY ? [] : {};
        objs.push(o);
        for (;;) {
          const k = word();
          if (k.tag === T.END) break;
          const key = k.tag === T.STRING ? str(k.data) : k.tag === T.INT32 ? (k.data | 0) : null;
          if (key === null) throw new Error(`structured clone: key tag 0x${k.tag.toString(16)}`);
          o[key] = read();
        }
        return o;
      }
      case T.MAP: case T.SET: {
        const isMap = w.tag === T.MAP, o: any = isMap ? {} : [];
        objs.push(o);
        for (;;) {
          if (buf.readUInt32LE(p + 4) === T.END) { p += 8; break; }
          const k = read();
          if (isMap) o[String(k)] = read(); else o.push(k);
        }
        return o;
      }
      default: throw new Error(`structured clone: unsupported tag 0x${w.tag.toString(16)} at ${p - 8}`);
    }
  };
  return read();
}

// ------------------------------------------------------------ another profile's extension storage
/** The extension's internal UUID in that profile (prefs.js extensions.webextensions.uuids). */
export function extUuid(profileDir: string, id: string): string | null {
  try {
    const m = /user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\);/.exec(fs.readFileSync(path.join(profileDir, 'prefs.js'), 'utf8'));
    return m ? JSON.parse(JSON.parse(`"${m[1]}"`))[id] ?? null : null;
  } catch { return null; }
}

/**
 * storage.local of an extension in another profile, read from a temporary copy. `want` picks the keys to decode
 * (others are skipped without decompressing).
 */
export function readExtStorage(profileDir: string, id: string, want: (key: string) => boolean): Map<string, unknown> {
  const uuid = extUuid(profileDir, id);
  if (!uuid) throw new Error(`${id} has no internal UUID in ${profileDir} (not installed there?)`);
  const idb = path.join(profileDir, 'storage', 'default', `moz-extension+++${uuid}^userContextId=4294967295`, 'idb');
  const db = fs.existsSync(idb) ? fs.readdirSync(idb).find((f) => f.endsWith('.sqlite')) : undefined;
  if (!db) {
    // not migrated to IndexedDB (older profiles): the JSON file
    const json = path.join(profileDir, 'browser-extension-data', id, 'storage.js');
    if (!fs.existsSync(json)) throw new Error(`no storage for ${id} in ${profileDir}`);
    const all = JSON.parse(fs.readFileSync(json, 'utf8'));
    return new Map(Object.entries(all).filter(([k]) => want(k)));
  }
  let last: unknown;
  // a copy taken while Firefox writes can be inconsistent: retry
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-extstore-'));
    try {
      for (const f of [db, `${db}-wal`]) if (fs.existsSync(path.join(idb, f))) fs.copyFileSync(path.join(idb, f), path.join(tmp, f));
      const conn = new DatabaseSync(path.join(tmp, db)); // read-write on the copy, so SQLite applies the WAL
      try {
        const out = new Map<string, unknown>();
        const filesDir = path.join(idb, db.replace(/\.sqlite$/, '.files'));
        for (const r of conn.prepare('SELECT key, data, file_ids FROM object_data').all() as any[]) {
          const k = decodeIdbKey(new Uint8Array(r.key));
          if (k === null || !want(k)) continue;
          if (r.file_ids) {
            // stored outside the database: ".<n>" is a structured-clone file
            const n = /^\.(\d+)$/.exec(String(r.file_ids).trim().split(/\s+/)[0]);
            if (!n) { out.set(k, undefined); continue; }
            out.set(k, structuredClone(snappyFramed(fs.readFileSync(path.join(filesDir, n[1])))));
          } else out.set(k, structuredClone(snappy(Buffer.from(r.data))));
        }
        return out;
      } finally { conn.close(); }
    } catch (e) { last = e; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// ------------------------------------------------------------ Violentmonkey in the main profile
export interface ProfileScript { id: number; name: string; namespace: string; version: string; enabled: boolean; lastModified: number; codeHash: string }

export const mainProfileDir = (): string | null => { const c = loadConfig(); const d = c.mainProfile ?? detectMainProfile(); return d && fs.existsSync(d) ? d : null; };

/** Violentmonkey's scripts in a profile on disk (not removed), with code hashes. */
export function profileScripts(dir: string): ProfileScript[] {
  const st = readExtStorage(dir, VM_ID, (k) => k.startsWith('scr:') || k.startsWith('code:'));
  const out: ProfileScript[] = [];
  for (const [k, v] of st) {
    if (!k.startsWith('scr:')) continue;
    const s = v as any;
    if (!s || s.config?.removed) continue;
    const id = Number(k.slice(4));
    const code = st.get(`code:${id}`);
    out.push({ id, name: s.meta?.name ?? '', namespace: s.meta?.namespace ?? '', version: s.meta?.version ?? '', enabled: !!s.config?.enabled, lastModified: s.props?.lastModified ?? 0, codeHash: typeof code === 'string' ? hashOf(code) : '' });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** One script's code and GM values from a profile on disk. */
export function profileScriptData(dir: string, id: number, values: boolean): { code: string; values?: Record<string, unknown> } {
  const st = readExtStorage(dir, VM_ID, (k) => k === `code:${id}` || (values && k === `val:${id}`));
  const code = st.get(`code:${id}`);
  if (typeof code !== 'string') throw new Error(`no code for script ${id}`);
  const raw = (st.get(`val:${id}`) ?? {}) as Record<string, unknown>;
  return { code, values: values ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeValue(v)])) : undefined };
}

// ------------------------------------------------------------ drift report
export interface DriftItem { kind: 'version' | 'code' | 'only-main'; name: string; namespace: string; here?: { id: number; version: string }; main: { id: number; version: string } }
export interface DriftReport { at: string; mainDir: string; ok: boolean; error?: string; items: DriftItem[]; onlyHere: number; same: number; lastOk?: string; mainVersions: Record<string, string> }

const keyOf = (s: { name: string; namespace: string }) => `${s.name.toLowerCase()}\n${s.namespace.toLowerCase()}`;
const reportFile = (b: Browser) => path.join(loadConfig().runDir, `${b.state.key}.drift.json`);
export function readDrift(b: Browser): DriftReport | null { try { return JSON.parse(fs.readFileSync(reportFile(b), 'utf8')); } catch { return null; } }
function writeDrift(b: Browser, r: DriftReport) { fs.mkdirSync(path.dirname(reportFile(b)), { recursive: true }); fs.writeFileSync(reportFile(b), JSON.stringify(r, null, 1)); }

/** claude-dev's code hashes (computed in Firefox, dev prelude removed). */
async function hereHashes(b: Browser, ids: number[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  return b.callChrome<Record<string, string>>(XS.EXT_STORAGE_HASHES, { id: VM_ID, keys: ids.map((i) => `code:${i}`), strip: PRELUDE_MARK_TAGS });
}

/**
 * Compare claude-dev's Violentmonkey with the main profile's (read-only). Written to run/<profile>.drift.json for
 * ff_status and us_list; a failed read keeps the time of the last successful one.
 */
export async function driftReport(b: Browser, mainDir: string): Promise<DriftReport> {
  const prev = readDrift(b);
  const at = new Date().toISOString();
  let main: ProfileScript[];
  try { main = profileScripts(mainDir); } catch (e: any) {
    const r: DriftReport = { at, mainDir, ok: false, error: String(e?.message ?? e), items: [], onlyHere: 0, same: 0, lastOk: prev?.ok ? prev.at : prev?.lastOk, mainVersions: prev?.mainVersions ?? {} };
    writeDrift(b, r);
    return r;
  }
  const here = (await vmScripts(b)).filter((s) => !s.removed);
  const hereBy = new Map<string, VmScript>(here.map((s) => [keyOf(s), s]));
  const mainBy = new Map(main.map((s) => [keyOf(s), s]));
  const sameVersion = main.map((m) => hereBy.get(keyOf(m))).filter((h): h is VmScript => !!h && h.version === mainBy.get(keyOf(h))!.version);
  const hashes = await hereHashes(b, sameVersion.map((s) => s.id));
  const items: DriftItem[] = [];
  let same = 0;
  for (const m of main) {
    const h = hereBy.get(keyOf(m));
    const mv = { id: m.id, version: m.version };
    if (!h) items.push({ kind: 'only-main', name: m.name, namespace: m.namespace, main: mv });
    else if (h.version !== m.version) items.push({ kind: 'version', name: m.name, namespace: m.namespace, here: { id: h.id, version: h.version }, main: mv });
    else if (hashes[`code:${h.id}`] && m.codeHash && hashes[`code:${h.id}`] !== m.codeHash) items.push({ kind: 'code', name: m.name, namespace: m.namespace, here: { id: h.id, version: h.version }, main: mv });
    else same++;
  }
  const mainVersions: Record<string, string> = {};
  for (const h of here) { const m = mainBy.get(keyOf(h)); if (m) mainVersions[h.id] = m.version || '(none)'; }
  const r: DriftReport = { at, mainDir, ok: true, items, onlyHere: here.filter((h) => !mainBy.has(keyOf(h))).length, same, mainVersions };
  writeDrift(b, r);
  return r;
}

const v = (x?: string) => x || '(no version)';
export function driftLine(i: DriftItem): string {
  if (i.kind === 'only-main') return `"${i.name}" ${v(i.main.version)}: only in the main profile`;
  if (i.kind === 'version') return `"${i.name}": ${v(i.here!.version)} here (#${i.here!.id}), ${v(i.main.version)} in the main profile`;
  return `"${i.name}" ${v(i.here!.version)} (#${i.here!.id}): same version, different code`;
}

/** One-line summary for launch notes / ff_status. */
export function driftSummary(r: DriftReport, max = 4): string {
  if (!r.ok) return `userscript drift vs the main profile: could not read it (${r.error})${r.lastOk ? `; last compared ${new Date(r.lastOk).toLocaleString()}` : ''}`;
  if (!r.items.length) return `userscripts match the main profile (${r.same} same, ${r.onlyHere} only in claude-dev)`;
  const shown = r.items.slice(0, max).map(driftLine).join('; ');
  return `userscript drift vs the main profile (read-only): ${r.items.length} differ: ${shown}${r.items.length > max ? `; +${r.items.length - max} more` : ''}. ${r.onlyHere} only in claude-dev. us_sync_main(script) shows the diff / copies one`;
}

/** The launch step: compare when a main profile exists (config driftReport:false turns it off). */
export async function launchDrift(b: Browser): Promise<string | null> {
  const cfg = loadConfig();
  if (cfg.driftReport === false || b.state.throwaway || b.personal) return null;
  const dir = mainProfileDir();
  if (!dir || path.resolve(dir).toLowerCase() === path.resolve(b.state.profileDir).toLowerCase()) return null;
  return driftSummary(await driftReport(b, dir));
}

// ------------------------------------------------------------ line diff (us_sync_main)
/** Compact unified-style diff: common head/tail trimmed, LCS on the rest when small enough. */
export function lineDiff(a: string, b: string, maxLines = 80, ctx = 2): string {
  const A = a.replace(/\r\n?/g, '\n').split('\n'), B = b.replace(/\r\n?/g, '\n').split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  if (s === ea && s === eb) return '(identical)';
  const a2 = A.slice(s, ea), b2 = B.slice(s, eb);
  type Op = [' ' | '-' | '+', string, number];
  let ops: Op[] = [];
  if (a2.length * b2.length <= 4e6) {
    const n = a2.length, m = b2.length, L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = a2[i] === b2[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { ops.push([' ', a2[i], s + i + 1]); i++; j++; }
      else if (j < m && (i === n || L[i * (m + 1) + j + 1] > L[(i + 1) * (m + 1) + j])) { ops.push(['+', b2[j], s + j + 1]); j++; }
      else { ops.push(['-', a2[i], s + i + 1]); i++; }
    }
  } else ops = [...a2.map((l, i): Op => ['-', l, s + i + 1]), ...b2.map((l, j): Op => ['+', l, s + j + 1])];
  const head = A.slice(Math.max(0, s - ctx), s).map((l, i): Op => [' ', l, s - Math.min(ctx, s) + i + 1]);
  const tail = A.slice(ea, ea + ctx).map((l, i): Op => [' ', l, ea + i + 1]);
  const all = [...head, ...ops, ...tail];
  // drop unchanged runs longer than 2*ctx inside
  const keep = all.map((o, i) => o[0] !== ' ' || all.slice(Math.max(0, i - ctx), i + ctx + 1).some((x) => x[0] !== ' '));
  const out: string[] = [];
  let skipped = false;
  for (let i = 0; i < all.length; i++) {
    if (!keep[i]) { if (!skipped) out.push('  …'); skipped = true; continue; }
    skipped = false;
    const [op, l] = all[i];
    out.push(`${op} ${l.length > 200 ? l.slice(0, 200) + '…' : l}`);
  }
  const changed = ops.filter((o) => o[0] !== ' ').length;
  return `@@ from line ${s + 1}: ${ops.filter((o) => o[0] === '-').length} line(s) only here, ${ops.filter((o) => o[0] === '+').length} only in main @@\n${out.slice(0, maxLines).join('\n')}${out.length > maxLines ? `\n… (${out.length - maxLines} more diff lines; ${changed} changed in all)` : ''}`;
}

