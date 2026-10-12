// Stylus adapter: userstyles (usercss) with workspace .user.css files as the source of truth, two-way
// sync with Stylus's editor and an optional watch mode. Everything goes through Stylus's own API, the "invokeAPI"
// messages its pages send to its background (styles.*, usercss.*), never its IndexedDB ("stylish"). Sent from the
// helper frame inside its background document, which counts as an extension-page sender (as for Violentmonkey).
// Stylus applies an installed or updated style to open tabs by itself: no reload.
import fs from 'node:fs';
import path from 'node:path';
import { workspace } from '../config.js';
import { ToolError, fail } from '../errors.js';
import { extCall, resolveExtension, type ExtRef } from '../browser/realms.js';
import type { Browser } from '../browser/session.js';
import { auditAppend, newAuditId, stateDir } from '../audit/audit.js';
import { currentClient, runAsClient } from '../browser/client.js';
import { hashOf, relPath } from './violentmonkey.js';

export const STYLUS_ID = '{7a7a4a92-a2a0-41d1-9fd7-1e92480d612d}';

// ------------------------------------------------------------ the API
let refCache: ExtRef | null = null;
export async function stylusRef(b: Browser): Promise<ExtRef> {
  let ext: ExtRef;
  try { ext = await resolveExtension(b, STYLUS_ID); } catch { return fail('STYLUS_UNAVAILABLE', 'Stylus is not installed in this profile', 'Install it from addons.mozilla.org in claude-dev (the user does), or profile_sync copies it from the user\'s Firefox.'); }
  if (!ext.active) fail('STYLUS_UNAVAILABLE', 'Stylus is disabled', 'ext_write(action: "enable", id: "stylus") (needs scope "addons").');
  return (refCache = ext);
}

/** One Stylus API call: API.<apiPath>(...args) in its background. Errors keep Stylus's message, line and column. */
export async function stylusApi<T = any>(b: Browser, apiPath: string, args: unknown[] = [], timeoutMs = 30000): Promise<T> {
  const ext = refCache && refCache.active ? refCache : await stylusRef(b);
  const body = `const w = await __cfFrame();
    const msg = { data: { method: 'invokeAPI', path: ${JSON.stringify(apiPath)}, args: ${JSON.stringify(args)} }, TDM: 1 };
    let r;
    for (let i = 0; ; i++) {
      try { r = await w.browser.runtime.sendMessage(msg); break; }
      catch (e) { if (i >= 5 || !/Receiving end does not exist/.test(String(e && e.message))) throw e; await new Promise((res) => setTimeout(res, 500)); }
    }
    if (r && r.error) return { __stylusError: { message: String(r.error.message || r.error), name: r.error.name, line: r.error.line, col: r.error.col, context: r.error.context } };
    return r ? r.data : null;`;
  let r: any;
  try { r = await extCall<any>(b, ext, body, timeoutMs); } catch (e: any) {
    if (e instanceof ToolError && e.code === 'EXTENSION_NOT_FOUND') refCache = null;
    throw e;
  }
  if (r && typeof r === 'object' && r.__stylusError) {
    const x = r.__stylusError;
    throw new ToolError('STYLUS_ERROR', `Stylus ${apiPath}: ${x.message}`, undefined, { line: x.line, col: x.col, context: x.context, name: x.name });
  }
  return r as T;
}

export interface Section { code?: string; urls?: string[]; urlPrefixes?: string[]; domains?: string[]; regexps?: string[] }
export interface StylusStyle {
  id: number; name: string; enabled: boolean; installDate?: number; updateDate?: number; _size?: number;
  usercssData?: { name: string; namespace?: string; version?: string; preprocessor?: string; vars?: Record<string, any> | number };
  sourceCode?: string; sections?: Section[]; url?: string; updateUrl?: string;
}

/** Every style: src = with source (usercss) / full sections (classic); else sections without their code. */
export async function stylusStyles(b: Browser, src = false): Promise<StylusStyle[]> {
  return (await stylusApi<StylusStyle[]>(b, 'styles.getCore', [src ? { src: true, vars: true } : { sections: true, size: true }])) ?? [];
}
export async function stylusStyle(b: Browser, id: number, src = true): Promise<StylusStyle | null> {
  return (await stylusApi<StylusStyle | null>(b, 'styles.getCore', [src ? { id, src: true, vars: true } : { id, sections: true, size: true }])) ?? null;
}

/** "domain example.com, url-prefix https://x/" for a style's sections (classic styles; usercss styles after a build). */
export function matchSummary(sections: Section[] | undefined, max = 4): string {
  const parts: string[] = [];
  for (const s of sections ?? []) {
    for (const d of s.domains ?? []) parts.push(`domain ${d}`);
    for (const u of s.urlPrefixes ?? []) parts.push(`url-prefix ${u}`);
    for (const u of s.urls ?? []) parts.push(`url ${u}`);
    for (const r of s.regexps ?? []) parts.push(`regexp ${r}`);
    if (!s.domains?.length && !s.urlPrefixes?.length && !s.urls?.length && !s.regexps?.length) parts.push('everywhere');
  }
  const u = [...new Set(parts)];
  return u.length > max ? `${u.slice(0, max).join(', ')}, +${u.length - max} more` : u.join(', ') || 'no sections';
}

export const styleVersion = (s: StylusStyle) => s.usercssData?.version || '';
export const describeStyle = (s: StylusStyle) => `Stylus #${s.id} "${s.name}"${styleVersion(s) ? ` ${styleVersion(s)}` : ''}`;

/** @name / @namespace / @version from a usercss header (Stylus parses it for real; this only names things). */
export function parseUsercssMeta(code: string): { name?: string; namespace?: string; version?: string } | null {
  const m = /\/\*\s*==UserStyle==([\s\S]*?)==\/UserStyle==\s*\*\//.exec(code);
  if (!m) return null;
  const get = (k: string) => new RegExp(`^\\s*@${k}\\s+(.+?)\\s*$`, 'm').exec(m[1])?.[1];
  return { name: get('name'), namespace: get('namespace'), version: get('version') };
}

/** A Stylus parse/compile error as "file:line:col message" (Stylus's lines count from the top of the file). */
export function stylusErrorText(e: unknown, rel: string): string {
  if (e instanceof ToolError && e.code === 'STYLUS_ERROR') {
    const c = e.context as { line?: number; col?: number; context?: string } | undefined;
    const msg = e.message.replace(/^Stylus [\w.]+: /, '');
    return c?.line ? `${rel}:${c.line}:${c.col ?? 1} ${msg}${c.context ? `\n    ${c.context}` : ''}` : `${rel}: ${msg}`;
  }
  return `${rel}: ${(e as Error)?.message ?? e}`;
}

export const readStyleFile = (abs: string) => fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');

// ------------------------------------------------------------ links (workspace file <-> installed style)
export interface StyleLink {
  /** hash of the code both sides had at the last sync (file and Stylus) */
  id: number; name: string; namespace: string; fileHash: string; syncedAt: string;
  /** push on every save of the file (stylus_watch) */
  watch?: boolean;
  lastPush?: { at: string; ok: boolean; message: string };
  /** Stylus's code (hash) when the conflict was written, so the same conflict isn't reported again */
  conflict?: { stylusHash: string; file: string };
}
export interface StyleState { links: Record<string, StyleLink> }
const stateFile = () => path.join(stateDir(), 'userstyles.json');
export function readStyleState(): StyleState {
  try { return { links: JSON.parse(fs.readFileSync(stateFile(), 'utf8')).links ?? {} }; } catch { return { links: {} }; }
}
export function writeStyleState(s: StyleState) { fs.writeFileSync(stateFile(), JSON.stringify(s, null, 1)); }

export { relPath };

export interface StyleInstall { link: StyleLink; rel: string; before: StylusStyle | null; style: StylusStyle; lines: string[]; warnings: string[] }

/**
 * Install or update a workspace .user.css in Stylus (usercss.install: Stylus parses the metadata, compiles any
 * preprocessor, and updates the linked style, else the style with the same @name + @namespace, else adds one).
 */
export async function installStyleFile(b: Browser, p: string, state: StyleState, opts: { watch?: boolean } = {}): Promise<StyleInstall> {
  const { abs, rel } = relPath(p);
  const code = readStyleFile(abs);
  const meta = parseUsercssMeta(code);
  if (!meta) fail('NOT_USERCSS', `${rel} has no /* ==UserStyle== ... ==/UserStyle== */ header`, 'A usercss file starts with a metadata block: @name, @namespace, @version, then @-moz-document sections (or a @preprocessor).');
  const prev = state.links[rel];
  const all = await stylusStyles(b, true);
  const before = (prev && all.find((s) => s.id === prev.id))
    ?? all.find((s) => s.usercssData && s.name === meta!.name && (s.usercssData.namespace ?? '') === (meta!.namespace ?? '')) ?? null;
  // Stylus installs leniently (its compiler skips what it can't parse, as the editor's save does); its strict parse
  // tells what got skipped, so a typo doesn't go unnoticed
  const warnings: string[] = [];
  try { await stylusApi(b, 'usercss.build', [code, { strict: true }]); } catch (e) { warnings.push(stylusErrorText(e, rel)); }
  let style: StylusStyle;
  try {
    style = await stylusApi<StylusStyle>(b, 'usercss.install', [{ sourceCode: code, ...(before ? { id: before.id } : {}) }]);
  } catch (e) {
    throw new ToolError('STYLE_INVALID', stylusErrorText(e, rel), 'Fix the file and push again (stylus_read(kind: "check") parses without installing).');
  }
  const core = (await stylusStyle(b, style.id, false)) ?? style;
  const lines = [
    before ? `updated ${describeStyle(before)} -> ${styleVersion(core) || '(no version)'} from ${rel}` : `installed ${describeStyle(core)} from ${rel}`,
    `  ${core.sections?.length ?? 0} section(s): ${matchSummary(core.sections)} · ${core.enabled ? 'enabled' : 'DISABLED'} · applies to open tabs at once (no reload)`,
  ];
  for (const w of warnings) lines.push(`  WARNING: Stylus's parser reports ${w}\n  (installed anyway: Stylus skips what it can't parse, so that rule or block has no effect)`);
  const twins = all.filter((s) => s.id !== core.id && s.enabled && s.name.toLowerCase() === core.name.toLowerCase());
  if (twins.length) lines.push(`  WARNING: also enabled with the same name: ${twins.map(describeStyle).join(', ')}; both apply (stylus_write(action: "disable") one of them)`);
  const link: StyleLink = {
    id: core.id, name: core.name, namespace: core.usercssData?.namespace ?? '', fileHash: hashOf(code),
    syncedAt: new Date().toISOString(), watch: opts.watch ?? prev?.watch, lastPush: { at: new Date().toISOString(), ok: true, message: lines[0] },
  };
  for (const [r, l] of Object.entries(state.links)) if (r !== rel && l.id === core.id) delete state.links[r];
  state.links[rel] = link;
  writeStyleState(state);
  return { link, rel, before, style: core, lines, warnings };
}

// ------------------------------------------------------------ two-way sync
export type StyleSyncStatus = 'synced' | 'file changed' | 'stylus changed' | 'both changed' | 'conflict' | 'missing file' | 'missing in stylus';
export interface StyleLinkStatus { rel: string; link: StyleLink; status: StyleSyncStatus; style?: StylusStyle }

export async function styleLinkStatuses(b: Browser, state: StyleState): Promise<StyleLinkStatus[]> {
  if (!Object.keys(state.links).length) return [];
  const all = await stylusStyles(b, true);
  const ws = path.resolve(workspace());
  return Object.entries(state.links).map(([rel, link]) => {
    const abs = path.join(ws, rel);
    if (!fs.existsSync(abs)) return { rel, link, status: 'missing file' as const };
    const style = all.find((s) => s.id === link.id);
    if (!style) return { rel, link, status: 'missing in stylus' as const };
    const fileChanged = hashOf(readStyleFile(abs)) !== link.fileHash;
    // Stylus's own edits change its code; its updateDate doesn't reliably change (an install by id keeps it)
    const stylusHash = hashOf(style.sourceCode ?? '');
    const stylusChanged = !!style.sourceCode && stylusHash !== link.fileHash;
    let status: StyleSyncStatus = fileChanged && stylusChanged ? 'both changed' : fileChanged ? 'file changed' : stylusChanged ? 'stylus changed' : 'synced';
    if (link.conflict && stylusChanged && link.conflict.stylusHash === stylusHash) status = 'conflict';
    return { rel, link, status, style };
  });
}

/** Stylus -> file. A file that also changed is never overwritten: Stylus's version goes to <file>.stylus-conflict. */
export function pullStyle(st: StyleLinkStatus, state: StyleState, force = false): string {
  const abs = path.join(path.resolve(workspace()), st.rel);
  const code = (st.style?.sourceCode ?? '').replace(/\r\n?/g, '\n');
  if (!force && (st.status === 'both changed' || st.status === 'conflict')) {
    const file = `${abs}.stylus-conflict`;
    fs.writeFileSync(file, code);
    st.link.conflict = { stylusHash: hashOf(code), file: path.basename(file) };
    writeStyleState(state);
    return `CONFLICT ${st.rel}: changed both on disk and in Stylus; Stylus's version saved as ${path.basename(file)} (nothing overwritten). Merge, then stylus_write(action: "update") (keeps the file) or action "sync" with direction "pull" and force.`;
  }
  fs.writeFileSync(abs, code);
  st.link.fileHash = hashOf(code);
  st.link.syncedAt = new Date().toISOString();
  delete st.link.conflict;
  writeStyleState(state);
  return `pulled ${st.rel} from ${st.style ? describeStyle(st.style) : `Stylus #${st.link.id}`} (edited in Stylus)`;
}

/**
 * Background half of sync and the watch mode, per workspace: every 3 s, pull styles edited in Stylus's editor into
 * unchanged files; for links with watch on, push a file as soon as it is saved (debounced), so the page restyles
 * live. A failed push (a parse error) is reported in the next tool result.
 */
export class StylusSync {
  private timer: NodeJS.Timeout | null = null;
  private watchers = new Map<string, fs.FSWatcher>();
  private pending = new Map<string, NodeJS.Timeout>();
  private busy = false;
  lastError = '';
  readonly ws: string;
  private readonly client: string;
  constructor(private b: Browser) { this.ws = workspace(); this.client = currentClient(); }

  /** Start polling and (re)arm the watchers of the links that want one. */
  ensure() {
    const state = readStyleState();
    if (!Object.keys(state.links).length) { this.stop(); return; }
    if (!this.timer) { this.timer = setInterval(() => { void this.tick(); }, 3000); this.timer.unref?.(); }
    for (const [rel, l] of Object.entries(state.links)) {
      if (l.watch && !this.watchers.has(rel)) this.watchFile(rel);
      if (!l.watch && this.watchers.has(rel)) { this.watchers.get(rel)!.close(); this.watchers.delete(rel); }
    }
    for (const rel of [...this.watchers.keys()]) if (!state.links[rel]) { this.watchers.get(rel)!.close(); this.watchers.delete(rel); }
  }

  watching(): string[] { return [...this.watchers.keys()]; }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private watchFile(rel: string) {
    const abs = path.join(this.ws, rel);
    try {
      // the folder, not the file: editors that save by replacing the file would end a file watch
      const w = fs.watch(path.dirname(abs), (_ev, name) => {
        if (name && path.basename(String(name)) !== path.basename(abs)) return;
        clearTimeout(this.pending.get(rel));
        this.pending.set(rel, setTimeout(() => { this.pending.delete(rel); void this.push(rel); }, 300));
      });
      w.on('error', () => { this.watchers.delete(rel); });
      this.watchers.set(rel, w);
    } catch (e: any) { this.lastError = `watch ${rel}: ${e.message}`; }
  }

  private async push(rel: string) {
    if (this.b.dead) return;
    await runAsClient(this.client, async () => {
      // the user has the browser (ff_handoff, Take over in the live view): push once they hand it back
      if (this.b.handoff) { this.pending.set(rel, setTimeout(() => { this.pending.delete(rel); void this.push(rel); }, 2000)); return; }
      const state = readStyleState();
      const l = state.links[rel];
      const abs = path.join(this.ws, rel);
      if (!l?.watch || !fs.existsSync(abs) || hashOf(readStyleFile(abs)) === l.fileHash) return;
      try {
        const r = await installStyleFile(this.b, rel, state, { watch: true });
        if (r.warnings.length) this.b.attachNotes.push(`stylus watch: pushed ${rel} with parser error(s): ${r.warnings.join('; ')} (Stylus skips what it can't parse)`);
        auditAppend({ id: newAuditId(), tool: 'stylus_watch (push)', args: { path: rel }, target: {}, status: 'ok', ms: 0, write: true,
          changes: [{ kind: 'stylus_style', path: String(r.style.id), before: r.before?.sourceCode ?? null, after: `(${rel})` }] });
      } catch (e: any) {
        const msg = e instanceof ToolError ? e.message : String(e?.message ?? e);
        const s = readStyleState();
        if (s.links[rel]) { s.links[rel].lastPush = { at: new Date().toISOString(), ok: false, message: msg }; writeStyleState(s); }
        this.b.attachNotes.push(`stylus watch: push of ${rel} FAILED (the previous version stays applied): ${msg}`);
      }
    }, this.ws);
  }

  async tick() {
    if (this.busy || this.b.dead) return;
    this.busy = true;
    try {
      await runAsClient(this.client, async () => {
        const state = readStyleState();
        if (!Object.keys(state.links).length) { this.stop(); return; }
        for (const st of await styleLinkStatuses(this.b, state)) {
          if (st.status !== 'stylus changed') continue;
          const msg = pullStyle(st, state);
          auditAppend({ id: newAuditId(), tool: 'stylus_sync (auto)', args: { file: st.rel }, target: {}, status: 'ok', ms: 0, write: false, changes: [{ kind: 'file', path: st.rel, after: msg }] });
        }
      }, this.ws);
      this.lastError = '';
    } catch (e: any) { this.lastError = String(e?.message ?? e); }
    finally { this.busy = false; }
  }
}

export function stylusSync(b: Browser): StylusSync {
  const key = `stylusSync:${workspace().toLowerCase()}`;
  let s = b.adapters.get(key) as StylusSync | undefined;
  if (!s) { s = new StylusSync(b); b.adapters.set(key, s); b.closers.push(() => s!.stop()); }
  return s;
}

// ------------------------------------------------------------ snapshots (the "stylus" part)
/** Every style with its source, for a warm snapshot (Stylus keeps styles in its own IndexedDB, not storage.local). */
export async function stylusCapture(b: Browser): Promise<StylusStyle[]> {
  return (await stylusStyles(b, true)).map((s) => ({ ...s, _size: undefined }));
}

export function stylusDiff(a: StylusStyle[], b: StylusStyle[]): string[] {
  const out: string[] = [];
  const byId = (l: StylusStyle[]) => new Map(l.map((s) => [s.id, s]));
  const x = byId(a), y = byId(b);
  for (const id of new Set([...x.keys(), ...y.keys()])) {
    const p = x.get(id), q = y.get(id);
    if (!p || !q) { out.push(`Stylus #${id} "${(p ?? q)!.name}": ${p ? 'present' : 'absent'} -> ${q ? 'present' : 'absent'}`); continue; }
    if (p.enabled !== q.enabled) out.push(`${describeStyle(p)}: ${p.enabled ? 'enabled' : 'disabled'} -> ${q.enabled ? 'enabled' : 'disabled'}`);
    if (JSON.stringify(p.sourceCode ?? p.sections) !== JSON.stringify(q.sourceCode ?? q.sections)) out.push(`${describeStyle(p)}: code changed${styleVersion(p) !== styleVersion(q) ? ` (${styleVersion(p) || '-'} -> ${styleVersion(q) || '-'})` : ''}`);
  }
  return out;
}

/** Make Stylus match a snapshot: remove styles added since, put back changed or removed ones (styles.importMany). */
export async function stylusRestore(b: Browser, snap: StylusStyle[]): Promise<string[]> {
  const now = await stylusStyles(b, true);
  const want = new Map(snap.map((s) => [s.id, s]));
  const lines: string[] = [];
  const extra = now.filter((s) => !want.has(s.id));
  if (extra.length) { await stylusApi(b, 'styles.removeMany', [extra.map((s) => s.id)]); lines.push(`Stylus: removed ${extra.length} style(s) added since: ${extra.map((s) => `"${s.name}"`).join(', ')}`); }
  const cur = new Map(now.map((s) => [s.id, s]));
  const changed = snap.filter((s) => {
    const c = cur.get(s.id);
    return !c || c.enabled !== s.enabled || JSON.stringify(c.sourceCode ?? c.sections) !== JSON.stringify(s.sourceCode ?? s.sections);
  });
  if (changed.length) { await stylusApi(b, 'styles.importMany', [changed]); lines.push(`Stylus: put back ${changed.length} style(s): ${changed.map((s) => `"${s.name}"`).join(', ')}`); }
  return lines;
}
