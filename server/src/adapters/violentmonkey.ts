// Violentmonkey adapter + two-way sync. Manager mode goes through Violentmonkey's own commands
// (ParseScript, GetData, UpdateScriptInfo, MarkRemoved, GetScriptCode, SetValueStores), sent from a helper frame
// inside its background (an extension page sender). Fast mode registers the script with the companion's
// userScripts API. Workspace files (scripts/*.user.js) are the source of truth; links live in
// .firefox-use/userscripts.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, workspace } from '../config.js';
import { ToolError, fail } from '../errors.js';
import { stateDir, auditAppend, newAuditId } from '../audit/audit.js';
import { extCall, resolveExtension, type ExtRef } from '../browser/realms.js';
import type { Browser } from '../browser/session.js';
import * as XS from '../browser/extScripts.js';
import { compCall, ensureCompanion } from './companion.js';
import { resourceServer } from '../resources/server.js';
import { currentClient, runAsClient } from '../browser/client.js';

export const VM_ID = '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}';

// ------------------------------------------------------------ metadata
export interface Meta {
  name: string; namespace: string; version: string; description: string;
  match: string[]; include: string[]; exclude: string[]; excludeMatch: string[];
  grant: string[]; require: string[]; resource: string[];
  runAt: string; injectInto: string; noframes: boolean;
}

/** Offsets refer to `code` as given; callers pass LF-normalised text (readScript). */
export function parseMeta(code: string): { meta: Meta; start: number; end: number } | null {
  const m = /\/\/\s*==UserScript==\s*\n([\s\S]*?)\/\/\s*==\/UserScript==[^\n]*\n?/.exec(code);
  if (!m) return null;
  const meta: Meta = { name: '', namespace: '', version: '', description: '', match: [], include: [], exclude: [], excludeMatch: [], grant: [], require: [], resource: [], runAt: 'document-end', injectInto: 'auto', noframes: false };
  for (const line of m[1].split('\n')) {
    const kv = /^\/\/\s*@([\w:-]+)(?:\s+(.*?))?\s*$/.exec(line.trim());
    if (!kv) continue;
    const [, key, val = ''] = kv;
    switch (key) {
      case 'name': case 'namespace': case 'version': case 'description': if (!meta[key]) meta[key] = val; break;
      case 'match': case 'include': case 'exclude': case 'grant': case 'require': case 'resource': meta[key].push(val); break;
      case 'exclude-match': meta.excludeMatch.push(val); break;
      case 'run-at': meta.runAt = val; break;
      case 'inject-into': meta.injectInto = val; break;
      case 'noframes': meta.noframes = true; break;
    }
  }
  return { meta, start: m.index, end: m.index + m[0].length };
}

export const readScript = (abs: string) => fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');

/** VM's matcher is strict about ports (unlike WebExtension match patterns): warn when a @match can't hit a localhost port. */
export function metaWarnings(meta: Meta, mode: 'manager' | 'fast'): string[] {
  const w: string[] = [];
  if (!meta.name) w.push('no @name: Violentmonkey refuses the script');
  if (mode === 'manager') for (const p of meta.match) if (/^[a-z*]+:\/\/(127\.0\.0\.1|localhost)\//.test(p)) w.push(`@match ${p} has no port: Violentmonkey won't match http://127.0.0.1:<port>/ pages (use @match http://127.0.0.1:<port>/* or @include http://127.0.0.1*)`);
  if (!meta.match.length && !meta.include.length) w.push('no @match / @include: the script runs nowhere');
  return w;
}

// ------------------------------------------------------------ dev prelude (never in the file on disk)
export const PRELUDE_START = '// ==ClaudeDevPrelude== (added by firefox-use to this dev install; not in the file on disk)';
export const PRELUDE_END = '// ==/ClaudeDevPrelude==';

const PRELUDE_MARK = 'claude-dev-prelude: added by firefox-use to this dev install, not in the file on disk';
const PRELUDE_MARK_END = '/claude-dev-prelude';
/** start/end of the one-line prelude as it appears in installed code (stripped before comparing code) */
export const PRELUDE_MARK_TAGS: [string, string] = [`/*${PRELUDE_MARK}*/ `, `/*${PRELUDE_MARK_END}*/ `];

/**
 * The eval hook (eval realm {kind:"userscript"}): a listener inside the script's own scope, so a direct eval sees the
 * script's top-level variables and functions. The server dispatches a DOM event named with a per-install secret
 * (pages can't trigger it) carrying the code, and gets the result back synchronously as another event. Names are
 * __cf-prefixed so they don't shadow the script's own.
 */
export function evalHook(token: string): string {
  const T = JSON.stringify(token);
  return `try { document.addEventListener('__claude_eval_' + ${T}, function (__cfE) { var __cfR; try { __cfR = { ok: 1, v: String(eval(JSON.parse(__cfE.detail).code)) }; } catch (__cfX) { __cfR = { ok: 0, e: String(__cfX), s: String(__cfX && __cfX.stack || '') }; } document.dispatchEvent(new CustomEvent('__claude_eval_result_' + ${T}, { detail: JSON.stringify(__cfR) })); }); } catch (__cfX) {}`;
}

export const newEvalToken = () => crypto.randomBytes(9).toString('base64url');

function preludeFor(name: string, token: string): string {
  const N = JSON.stringify(name);
  return [
    evalHook(token),
    `var __claude = { mark: function (label) { console.debug('[claude-mark] ' + JSON.stringify({ script: ${N}, label: String(label), t: Math.round(performance.now() * 10) / 10 })); }, ready: function () { try { document.documentElement.setAttribute('data-claude-ready-' + ${JSON.stringify(slug(name))}, String(Date.now())); } catch (e) {} __claude.mark('ready'); } };`,
    // GM_xmlhttpRequest attribution: the request itself names no script; this marker lets network_read label it
    `try { if (typeof GM_xmlhttpRequest === 'function') { var __cfX = GM_xmlhttpRequest; GM_xmlhttpRequest = function (d) { console.debug('[claude-gmxhr] ' + JSON.stringify({ script: ${N}, method: (d && d.method) || 'GET', url: d && String(d.url) })); return __cfX.apply(this, arguments); }; } } catch (e) {}`,
    `try { if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') { var __cfGX = GM.xmlHttpRequest; GM.xmlHttpRequest = function (d) { console.debug('[claude-gmxhr] ' + JSON.stringify({ script: ${N}, method: (d && d.method) || 'GET', url: d && String(d.url) })); return __cfGX.apply(this, arguments); }; } } catch (e) {}`,
    // the script started in this document: verify waits for scripts that ran here before (filtered from console output)
    `try { console.debug('[claude-start] ' + JSON.stringify({ script: ${N} })); } catch (e) {}`,
  ].join(' ');
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'script';

/**
 * Insert the prelude after the metadata block, joined onto ONE line so line numbers in errors stay those of the
 * file: at the end of a leading "use strict" directive line (the directive must stay first), else in front of the
 * first code line.
 */
export function withPrelude(code: string, name: string, token: string): string {
  const p = parseMeta(code);
  if (!p) return code;
  const one = `/*${PRELUDE_MARK}*/ ${preludeFor(name, token)} /*${PRELUDE_MARK_END}*/ `;
  const head = code.slice(0, p.end);
  const rest = code.slice(p.end);
  const d = /^(\s*(?:\/\/[^\n]*\n\s*)*(['"])use strict\2;?)([^\n]*)/.exec(rest);
  if (d) return `${head}${d[1]}${one}${rest.slice(d[1].length)}`;
  const lead = /^(\s*(?:\/\/[^\n]*\n|\s*\n)*)/.exec(rest)![1];
  return `${head}${lead}${one}${rest.slice(lead.length)}`;
}

export function stripPrelude(code: string): string {
  const start = `/*${PRELUDE_MARK}*/ `, end = `/*${PRELUDE_MARK_END}*/ `;
  const i = code.indexOf(start), j = i >= 0 ? code.indexOf(end, i) : -1;
  if (i >= 0 && j >= 0) return code.slice(0, i) + code.slice(j + end.length);
  // older multi-line form
  const a = code.indexOf(PRELUDE_START);
  const b = a >= 0 ? code.indexOf(PRELUDE_END, a) : -1;
  return a >= 0 && b >= 0 ? code.slice(0, a) + code.slice(b + PRELUDE_END.length).replace(/^\n/, '') : code;
}

// ------------------------------------------------------------ Violentmonkey commands
let vmRefCache: ExtRef | null = null;
export async function vmRef(b: Browser): Promise<ExtRef> {
  let ext: ExtRef;
  try { ext = await resolveExtension(b, VM_ID); } catch { return fail('VM_UNAVAILABLE', 'Violentmonkey is not installed in this profile'); }
  if (!ext.active) fail('VM_UNAVAILABLE', 'Violentmonkey is disabled', 'addons_set_enabled vm true (needs scope "addons").');
  return (vmRefCache = ext);
}

export async function vmSend<T = any>(b: Browser, cmd: string, data: unknown, timeoutMs = 30000): Promise<T> {
  const ext = vmRefCache && vmRefCache.active ? vmRefCache : await vmRef(b);
  try {
    return await extCall<T>(b, ext, `const w = await __cfFrame(); return await w.browser.runtime.sendMessage({ cmd: ${JSON.stringify(cmd)}, data: ${JSON.stringify(data ?? null)} });`, timeoutMs);
  } catch (e: any) {
    if (e instanceof ToolError && e.code === 'EXTENSION_NOT_FOUND') vmRefCache = null;
    if (e instanceof ToolError && e.code === 'EVAL_EXCEPTION') throw new ToolError('VM_ERROR', `Violentmonkey ${cmd}: ${e.message.replace(/ \(in extension:.*\)$/, '')}`);
    throw e;
  }
}

export interface VmScript { id: number; name: string; namespace: string; version: string; enabled: boolean; removed: boolean; lastModified: number; meta: any; custom: any; uri: string }

export async function vmScripts(b: Browser): Promise<VmScript[]> {
  const ext = await vmRef(b);
  const r = await extCall<any[]>(b, ext, `const w = await __cfFrame(); const r = await w.browser.runtime.sendMessage({ cmd: 'GetData', data: { ids: null } }); return (r && r.scripts || []).map((s) => ({ id: s.props.id, uri: s.props.uri, lastModified: s.props.lastModified, meta: s.meta, custom: s.custom, enabled: !!s.config.enabled, removed: !!s.config.removed }));`);
  return r.map((s) => ({ ...s, name: s.meta?.name ?? '', namespace: s.meta?.namespace ?? '', version: s.meta?.version ?? '' }));
}

/** VM stores values with a one-letter type prefix: s<string>, n<number>, b<bool>, o<JSON>. */
export function decodeValue(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return v;
  const t = v[0], rest = v.slice(1);
  if (t === 's') return rest;
  if (t === 'n') return Number(rest);
  if (t === 'b') return rest === 'true';
  if (t === 'o') { try { return JSON.parse(rest); } catch { return rest; } }
  return v;
}
export function encodeValue(v: unknown): string {
  if (typeof v === 'string') return 's' + v;
  if (typeof v === 'number') return 'n' + v;
  if (typeof v === 'boolean') return 'b' + v;
  return 'o' + JSON.stringify(v);
}

export async function vmValues(b: Browser, id: number): Promise<Record<string, unknown>> {
  const r = await b.callChrome<{ values: Record<string, any> }>(XS.EXT_STORAGE_GET, { id: VM_ID, area: 'local', keys: [`val:${id}`], skip: null });
  const raw = r.values[`val:${id}`] ?? {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeValue(v)]));
}

export async function vmSetValues(b: Browser, id: number, values: Record<string, unknown>): Promise<void> {
  const enc = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, encodeValue(v)]));
  await vmSend(b, 'SetValueStores', { [id]: enc });
}

// ------------------------------------------------------------ links (workspace file <-> installed script)
export interface Link {
  mode: 'manager' | 'fast';
  /** VM script id (manager) or companion user script id (fast) */
  id: number | string;
  name: string;
  namespace: string;
  fileHash: string;
  vmLastModified?: number;
  devPrelude: boolean;
  /** secret of the eval hook in the dev prelude ({kind:"userscript"} realm) */
  evalToken?: string;
  syncedAt: string;
  conflict?: { vmLastModified: number; file: string };
}
export interface SyncState { links: Record<string, Link>; devPrelude: boolean; fastGm: 'persisted' | 'recorded' }

const stateFile = () => path.join(stateDir(), 'userscripts.json');
export function readState(): SyncState {
  try { const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); return { links: s.links ?? {}, devPrelude: s.devPrelude ?? true, fastGm: s.fastGm ?? 'persisted' }; } catch { return { links: {}, devPrelude: true, fastGm: 'persisted' }; }
}
export function writeState(s: SyncState) { fs.writeFileSync(stateFile(), JSON.stringify(s, null, 1)); }

export const hashOf = (s: string) => crypto.createHash('sha256').update(s.replace(/\r\n?/g, '\n')).digest('hex').slice(0, 16);

/** Workspace-relative path with forward slashes; files must live inside the workspace. */
export function relPath(p: string): { abs: string; rel: string } {
  const ws = path.resolve(workspace());
  const abs = path.resolve(ws, p);
  if (!abs.toLowerCase().startsWith(ws.toLowerCase() + path.sep)) fail('PATH_REFUSED', `${p} is outside the workspace (${ws})`,
    'For throwaway probe scripts use .firefox-use/scratch/ in the workspace: that folder is git-ignored, so they stay out of the project.');
  if (!fs.existsSync(abs)) fail('FILE_NOT_FOUND', abs);
  return { abs, rel: path.relative(ws, abs).split(path.sep).join('/') };
}

export const fastId = (meta: Meta) => `cf-${crypto.createHash('sha1').update(`${meta.namespace}\n${meta.name}`).digest('hex').slice(0, 12)}`;

const RUN_AT: Record<string, string> = { 'document-start': 'document_start', 'document-body': 'document_start', 'document-end': 'document_end', 'document-idle': 'document_idle' };

// ------------------------------------------------------------ same-script check
/**
 * Name used to recognise two copies of one script: case-insensitive, without a trailing "(dev)"-style tag or a
 * dotted version ("Smart Canvas 1.3-dev", "vaft (debug)").
 */
export function baseName(name: string): string {
  let s = name.trim().toLowerCase();
  for (let i = 0; i < 3; i++) s = s.replace(/\s*(?:[([](?:dev|debug|beta|test|local|wip)[)\]]|-?\s*v?\d+(?:\.\d+)+[-+.\w]*)$/i, '').trim();
  return s;
}

/**
 * Installed scripts that a dev copy disabled because they'd run alongside it (shadow:"disable"): Violentmonkey id ->
 * who shadows it. Kept per profile next to the run state, but in a file of its own: it must outlive a crash (the run
 * state is cleared then) so the next launch can re-enable them.
 */
export interface Shadow { name: string; version: string; namespace: string; by: { ws: string; rel: string; mode: 'manager' | 'fast'; id: number | string }; at: string }
const shadowFile = (b: Browser) => path.join(loadConfig().runDir, `${b.state.key}.shadows.json`);
export function readShadows(b: Browser): Record<string, Shadow> { try { return JSON.parse(fs.readFileSync(shadowFile(b), 'utf8')); } catch { return {}; } }
function writeShadows(b: Browser, s: Record<string, Shadow>) {
  if (!Object.keys(s).length) { try { fs.unlinkSync(shadowFile(b)); } catch { /* none */ } return; }
  fs.mkdirSync(path.dirname(shadowFile(b)), { recursive: true });
  fs.writeFileSync(shadowFile(b), JSON.stringify(s, null, 1));
}
const sameWs = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Enable/disable a Violentmonkey script as our own change: a linked script's sync must not pull it back as an edit. */
export async function setVmEnabled(b: Browser, id: number, on: boolean) {
  await vmSend(b, 'UpdateScriptInfo', { id, config: { enabled: on ? 1 : 0 } });
  const state = readState();
  const rel = Object.keys(state.links).find((k) => state.links[k].mode === 'manager' && Number(state.links[k].id) === id);
  if (rel) {
    const s = (await vmScripts(b)).find((x) => x.id === id);
    if (s) { state.links[rel].vmLastModified = s.lastModified; writeState(state); }
  }
}

/** Re-enable the scripts shadowed by these dev copies (filter), forgetting the records. */
export async function releaseShadows(b: Browser, which: (s: Shadow, vmId: number) => boolean, why: string): Promise<{ lines: string[]; changes: { kind: string; path: string; before: boolean; after: boolean }[] }> {
  const all = readShadows(b);
  const lines: string[] = [], changes: { kind: string; path: string; before: boolean; after: boolean }[] = [];
  const hit = Object.entries(all).filter(([id, s]) => which(s, Number(id)));
  if (!hit.length) return { lines, changes };
  const scripts = await vmScripts(b);
  for (const [id, s] of hit) {
    delete all[id];
    const vm = scripts.find((x) => x.id === Number(id) && !x.removed);
    if (!vm || vm.enabled) continue;
    await setVmEnabled(b, vm.id, true);
    lines.push(`re-enabled Violentmonkey #${id} "${s.name}" ${s.version} (${why})`);
    changes.push({ kind: 'vm_enabled', path: id, before: false, after: true });
  }
  writeShadows(b, all);
  return { lines, changes };
}

/**
 * At a launch: fast-mode dev copies are gone (the companion is a temporary add-on), and a manager-mode dev copy may
 * have been removed in Violentmonkey's own UI. Re-enable what they shadowed.
 */
export async function releaseStaleShadows(b: Browser): Promise<string[]> {
  const all = readShadows(b);
  if (!Object.keys(all).length) return [];
  const live = new Set((await vmScripts(b)).filter((s) => !s.removed).map((s) => s.id));
  const r = await releaseShadows(b, (s) => s.by.mode === 'fast' || !live.has(Number(s.by.id)), 'its dev copy is gone after the restart');
  return r.lines;
}

export interface ShadowOpts {
  /** "disable" (default): disable other installed copies while this dev copy is installed; "keep": run both, with a warning */
  shadow?: 'disable' | 'keep';
  /** throws when disabling another copy isn't allowed (scope); omitted = allowed (re-registering an install) */
  allow?: () => Promise<void>;
}

/**
 * Other installed Violentmonkey scripts that would run next to this dev copy: same base name under any namespace
 * (manager mode: the same name + namespace is the script itself, updated in place).
 */
async function sameScripts(b: Browser, meta: Meta, mode: 'manager' | 'fast', rel: string, prev?: Link) {
  const scripts = (await vmScripts(b)).filter((s) => !s.removed);
  const gone = prev?.mode === 'manager' && prev.mode !== mode ? Number(prev.id) : null; // removed below (mode switch)
  const self = mode === 'manager' ? scripts.find((s) => (prev?.mode === 'manager' && s.id === Number(prev.id)) || (s.name === meta.name && s.namespace === meta.namespace)) : undefined;
  const shadows = readShadows(b);
  const mine = (id: number) => { const s = shadows[id]; return !!s && sameWs(s.by.ws, workspace()) && s.by.rel === rel; };
  const others = scripts.filter((s) => s !== self && s.id !== gone && baseName(s.name) === baseName(meta.name) && (s.enabled || mine(s.id)));
  return { self, others, mine };
}

const desc = (s: VmScript) => `Violentmonkey #${s.id} "${s.name}" ${s.version || '(no version)'}${s.namespace ? ` (namespace ${s.namespace})` : ''}`;

export interface InstallResult { link: Link; lines: string[]; isNew: boolean; changes: { kind: string; path: string; before: unknown; after: unknown }[] }

/** Install or update one workspace file in the given mode. */
export async function installFile(b: Browser, p: string, mode: 'manager' | 'fast', state: SyncState, so: ShadowOpts = {}): Promise<InstallResult> {
  const { abs, rel } = relPath(p);
  const code = readScript(abs);
  const parsed = parseMeta(code);
  if (!parsed) fail('BAD_USERSCRIPT', `${rel} has no // ==UserScript== metadata block`);
  const meta = parsed!.meta;
  const lines = metaWarnings(meta, mode).map((w) => `WARNING: ${w}`);
  if (!meta.name) fail('BAD_USERSCRIPT', `${rel}: no @name (Violentmonkey refuses scripts without one)`);
  const prev = state.links[rel];
  const evalToken = prev?.evalToken ?? newEvalToken();
  // same-script check, before anything changes
  const dup = await sameScripts(b, meta, mode, rel, prev).catch((e) => { if (e instanceof ToolError && e.code === 'VM_UNAVAILABLE') return null; throw e; });
  const toDisable = dup ? dup.others.filter((s) => s.enabled) : [];
  if (toDisable.length && so.shadow !== 'keep' && so.allow) {
    try { await so.allow(); } catch (e) {
      if (!(e instanceof ToolError) || e.code !== 'SCOPE_REQUIRED') throw e;
      fail('SHADOWED_SCRIPT', `${toDisable.map(desc).join('; ')} ${toDisable.length > 1 ? 'are' : 'is'} the same script and would run alongside this dev copy of "${meta.name}"`,
        'Approve scope "ext:vm" (scope_set) so the other copy is disabled while the dev copy is installed (re-enabled by us_uninstall of the dev copy, ff_quit, or the next launch), or pass shadow:"keep" to run both.');
    }
  }
  const changes: InstallResult['changes'] = [];
  if (prev && prev.mode !== mode) {
    await uninstallLink(b, prev);
    lines.push(`removed the ${prev.mode}-mode install first`);
  }
  let link: Link, isNew: boolean;
  if (mode === 'manager') {
    const srv = await resourceServer(b);
    const url = rel.startsWith('scripts/') ? `${srv.origin}/${rel}` : undefined;
    const body = state.devPrelude ? withPrelude(code, meta.name, evalToken) : code;
    const r = await vmSend<any>(b, 'ParseScript', { code: body, bumpDate: true, ...(url ? { url } : {}), config: { shouldUpdate: 0 } });
    if (r?.errors?.length) lines.push(...r.errors.map((e: string) => `Violentmonkey: ${e}`));
    const id = r?.where?.id;
    if (!id) fail('VM_ERROR', `Violentmonkey did not install ${rel}: ${JSON.stringify(r).slice(0, 300)}`);
    const replaced = dup?.self && !(prev?.mode === 'manager' && Number(prev.id) === dup.self.id) ? dup.self : null;
    if (!r.isNew && !prev) lines.push(replaced
      ? `replaced ${replaced.version || '(no version)'} → ${meta.version || '(no version)'} of Violentmonkey script #${id} (same @name and @namespace: Violentmonkey updated it in place; the old code is in the audit entry and the scope checkpoint)`
      : `updated the existing Violentmonkey script #${id} (matched by @name/@namespace)`);
    const s = (await vmScripts(b)).find((x) => x.id === id);
    link = { mode, id, name: meta.name, namespace: meta.namespace, fileHash: hashOf(code), vmLastModified: s?.lastModified, devPrelude: state.devPrelude, evalToken, syncedAt: new Date().toISOString() };
    state.links[rel] = link;
    writeState(state);
    lines.unshift(`${r.isNew ? 'installed' : 'updated'} ${rel} in Violentmonkey as #${id} "${meta.name}" ${meta.version}${state.devPrelude ? ' (dev prelude)' : ''}${r?.update?.message ? ` — ${r.update.message}` : ''}`);
    isNew = !!r.isNew;
  } else ({ link, isNew } = await installFast(b, rel, code, meta, mode, state, evalToken, lines));
  if (dup) applyShadows(b, dup, toDisable, rel, link, so, lines);
  if (dup && toDisable.length && so.shadow !== 'keep') {
    for (const s of toDisable) { await setVmEnabled(b, s.id, false); changes.push({ kind: 'vm_enabled', path: String(s.id), before: true, after: false }); }
  }
  return { link, lines, isNew, changes };
}

/** Record (or report) the copies this install shadows; the disabling itself happens in installFile. */
function applyShadows(b: Browser, dup: Awaited<ReturnType<typeof sameScripts>>, toDisable: VmScript[], rel: string, link: Link, so: ShadowOpts, lines: string[]) {
  const all = readShadows(b);
  const by = { ws: workspace(), rel, mode: link.mode, id: link.id };
  const until = link.mode === 'fast' ? 'us_uninstall of the dev copy, ff_quit or the next launch re-enable it' : 'us_uninstall of the dev copy re-enables it';
  for (const s of dup.others) {
    if (dup.mine(s.id)) { all[s.id] = { ...all[s.id], by }; lines.push(`${desc(s)} stays disabled while this dev copy is installed (${until})`); continue; }
    if (so.shadow === 'keep') { lines.push(`WARNING: ${desc(s)} is the same script and runs alongside this dev copy (shadow:"keep"): its effects will be doubled on the page`); continue; }
    if (!toDisable.includes(s)) continue;
    all[s.id] = { name: s.name, version: s.version, namespace: s.namespace, by, at: new Date().toISOString() };
    lines.push(`disabled ${desc(s)}: it is the same script and would run alongside this dev copy (${until}; shadow:"keep" runs both)`);
  }
  writeShadows(b, all);
}

async function installFast(b: Browser, rel: string, code: string, meta: Meta, mode: 'fast', state: SyncState, evalToken: string, lines: string[]): Promise<{ link: Link; isNew: boolean }> {
  // fast mode: companion userScripts API
  await ensureCompanion(b);
  if (meta.require.length || meta.resource.length) lines.push('WARNING: fast mode ignores @require / @resource (use mode "manager" for those)');
  if (meta.match.length && meta.include.length) lines.push('WARNING: with both @match and @include, fast mode uses @match only (Violentmonkey takes their union)');
  const regex = meta.include.filter((x) => /^\/.*\/[a-z]*$/.test(x));
  if (regex.length) lines.push(`WARNING: fast mode can't express regex @include (${regex.join(', ')}); matching all URLs instead`);
  const globs = meta.include.filter((x) => !regex.includes(x));
  const world = meta.injectInto === 'page' ? 'MAIN' : 'USER_SCRIPT';
  if (world === 'MAIN' && meta.grant.some((g) => g !== 'none')) lines.push('WARNING: @inject-into page runs in the MAIN world, where the GM_* stubs are unavailable');
  // WebExtension match patterns have no ports (Violentmonkey needs them): a pattern with one would register nothing
  const matches = meta.match.map((m) => m.replace(/^([a-z*]+:\/\/[^/:]+):\d+\//i, '$1/'));
  if (matches.some((m, i) => m !== meta.match[i])) lines.push('note: fast mode drops the port from @match patterns (WebExtension patterns have none), so the script runs on every port of that host');
  const id = fastId(meta);
  const spec = {
    id, name: meta.name, namespace: meta.namespace, version: meta.version, description: meta.description,
    // the whole file: the companion wraps it so line numbers stay those of the file, and adds the prelude
    code, slug: slug(meta.name), devPrelude: state.devPrelude, evalHook: state.devPrelude ? evalHook(evalToken) : '',
    matches: meta.match.length ? matches : ['<all_urls>'],
    excludeMatches: meta.excludeMatch, includeGlobs: meta.match.length ? [] : globs, excludeGlobs: meta.exclude,
    runAt: RUN_AT[meta.runAt] ?? 'document_end', world, noframes: meta.noframes, gm: state.fastGm, grants: meta.grant,
  };
  const r = await compCall<{ id: string; updated: boolean }>(b, `return await cf.register(${JSON.stringify(spec)});`);
  const link: Link = { mode, id, name: meta.name, namespace: meta.namespace, fileHash: hashOf(code), devPrelude: state.devPrelude, evalToken, syncedAt: new Date().toISOString() };
  state.links[rel] = link;
  writeState(state);
  lines.unshift(`${r.updated ? 'updated' : 'registered'} ${rel} in fast mode (companion userScripts, ${world}, GM stubs: ${state.fastGm}) as ${id}; reload the page to run it`);
  return { link, isNew: !r.updated };
}

export async function uninstallLink(b: Browser, l: Link): Promise<string> {
  if (l.mode === 'manager') { await vmSend(b, 'MarkRemoved', { id: l.id, removed: true }); return `Violentmonkey #${l.id} moved to its recycle bin`; }
  await compCall(b, `return await cf.unregister(${JSON.stringify(l.id)});`);
  return `fast-mode script ${l.id} unregistered`;
}

// ------------------------------------------------------------ two-way sync
export type SyncStatus = 'synced' | 'file changed' | 'vm changed' | 'both changed' | 'conflict' | 'missing file' | 'missing in vm';

export interface LinkStatus { rel: string; link: Link; status: SyncStatus; vm?: VmScript }

export async function linkStatuses(b: Browser, state: SyncState): Promise<LinkStatus[]> {
  const out: LinkStatus[] = [];
  const managed = Object.values(state.links).some((l) => l.mode === 'manager');
  const scripts = managed ? await vmScripts(b) : [];
  const ws = path.resolve(workspace());
  for (const [rel, link] of Object.entries(state.links)) {
    const abs = path.join(ws, rel);
    if (!fs.existsSync(abs)) { out.push({ rel, link, status: 'missing file' }); continue; }
    const fileChanged = hashOf(readScript(abs)) !== link.fileHash;
    if (link.mode === 'fast') { out.push({ rel, link, status: fileChanged ? 'file changed' : 'synced' }); continue; }
    const vm = scripts.find((s) => s.id === link.id && !s.removed);
    if (!vm) { out.push({ rel, link, status: 'missing in vm' }); continue; }
    const vmChanged = vm.lastModified !== link.vmLastModified;
    let status: SyncStatus = fileChanged && vmChanged ? 'both changed' : fileChanged ? 'file changed' : vmChanged ? 'vm changed' : 'synced';
    if (link.conflict && vmChanged && link.conflict.vmLastModified === vm.lastModified) status = 'conflict';
    out.push({ rel, link, status, vm });
  }
  return out;
}

/** VM -> file. Refuses to overwrite a file that also changed: writes <file>.vm-conflict instead. */
export async function pullLink(b: Browser, st: LinkStatus, state: SyncState): Promise<string> {
  const abs = path.join(path.resolve(workspace()), st.rel);
  const vmCode = stripPrelude(String(await vmSend(b, 'GetScriptCode', st.link.id)));
  if (st.status === 'both changed' || st.status === 'conflict') {
    const file = `${abs}.vm-conflict`;
    fs.writeFileSync(file, vmCode);
    st.link.conflict = { vmLastModified: st.vm!.lastModified, file: path.basename(file) };
    writeState(state);
    return `CONFLICT ${st.rel}: changed both on disk and in Violentmonkey; Violentmonkey's version saved as ${path.basename(file)} (nothing overwritten). Merge, then us_update (keeps the file) or us_sync pull with force.`;
  }
  fs.writeFileSync(abs, vmCode);
  st.link.fileHash = hashOf(vmCode);
  st.link.vmLastModified = st.vm!.lastModified;
  st.link.syncedAt = new Date().toISOString();
  delete st.link.conflict;
  writeState(state);
  return `pulled ${st.rel} from Violentmonkey #${st.link.id} (edited in Violentmonkey)`;
}

/**
 * Background half of two-way sync: while scripts are linked, poll Violentmonkey's last-modified times and pull
 * edits made in its editor into the files (only when the file itself is unchanged; otherwise a conflict file).
 * Pushing file edits needs a scope, so that stays explicit (us_update / us_sync).
 */
export class VmSync {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  lastError = '';
  /** the workspace and session that linked the scripts (calls resolve the workspace per session) */
  readonly ws: string;
  private readonly client: string;
  constructor(private b: Browser) { this.ws = workspace(); this.client = currentClient(); }

  ensure() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 3000);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy || this.b.dead) return;
    this.busy = true;
    try {
      await runAsClient(this.client, async () => {
        const state = readState();
        if (!Object.values(state.links).some((l) => l.mode === 'manager')) { this.stop(); return; }
        for (const st of await linkStatuses(this.b, state)) {
          if (st.status !== 'vm changed' && st.status !== 'both changed') continue;
          if (st.status === 'both changed' && st.link.conflict?.vmLastModified === st.vm?.lastModified) continue;
          const msg = await pullLink(this.b, st, state);
          auditAppend({ id: newAuditId(), tool: 'us_sync (auto)', args: { file: st.rel }, target: {}, status: 'ok', ms: 0, write: false, changes: [{ kind: 'file', path: st.rel, after: msg }] });
        }
      }, this.ws);
      this.lastError = '';
    } catch (e: any) { this.lastError = String(e?.message ?? e); }
    finally { this.busy = false; }
  }
}

/**
 * Fast-mode scripts live in the companion, a temporary add-on, so they're gone after Firefox restarts. When the
 * plugin itself restarted Firefox (ff_restart, idle quit), register the workspace's fast links again.
 */
export async function restoreFastScripts(b: Browser): Promise<string[]> {
  const state = readState();
  const out: string[] = [];
  for (const [rel, l] of Object.entries(state.links)) {
    if (l.mode !== 'fast') continue;
    try { await installFile(b, rel, 'fast', state); out.push(rel); } catch { /* file gone: us_list reports the link */ }
  }
  return out;
}

export function vmSync(b: Browser): VmSync {
  const key = `vmSync:${workspace().toLowerCase()}`;
  let s = b.adapters.get(key) as VmSync | undefined;
  if (!s) { s = new VmSync(b); b.adapters.set(key, s); b.closers.push(() => s!.stop()); }
  return s;
}

// ------------------------------------------------------------ stack lines (source-mapped VM positions)
/** A Violentmonkey userscript position in a stack: moz-extension://<vm>/%20<name>.user.js#<id>:<line>[:<col>] */
const VM_POS = /moz-extension:\/\/[^/\s]+\/%20([^#\s]*?)\.user\.js#(\d+):(\d+)(:\d+)?/g;
const VM_URL = /^moz-extension:\/\/[^/\s]+\/%20([^#\s]*?)\.user\.js#(\d+)$/;

/** Lines of a source as Violentmonkey joins it: a missing final newline is added, so "a\nb" and "a\nb\n" are both 2. */
const joinedLines = (code: string) => (code.endsWith('\n') ? code : code + '\n').split('\n').length - 1;

interface VmLines {
  /** lines Violentmonkey puts in front of the script's own code: its @require files (measured on 2.49: a 2-line
   * require shifts the script by 2, with or without a final newline). The one-line dev prelude adds none. */
  off: number;
  /** lines of the installed script (0: unknown) */
  end: number;
  /** the one-line dev prelude: its line in the script, 1-based column where it starts, and its length */
  pre?: { line: number; col: number; len: number };
}

/** Where the dev prelude sits in installed code (columns after it on that line are shifted by its length). */
function preludeSpan(code: string): VmLines['pre'] {
  const [start, end] = PRELUDE_MARK_TAGS;
  const i = code.indexOf(start), j = i >= 0 ? code.indexOf(end, i) : -1;
  if (i < 0 || j < 0) return undefined;
  return { line: code.slice(0, i).split('\n').length, col: i - code.lastIndexOf('\n', i - 1), len: j + end.length - i };
}

/** Line offsets and lengths of installed Violentmonkey scripts, cached for 30 s. */
export async function vmLineOffsets(b: Browser, ids: number[]): Promise<Map<number, VmLines>> {
  let cache = b.adapters.get('vmLineOffsets') as Map<number, VmLines & { at: number }> | undefined;
  if (!cache) b.adapters.set('vmLineOffsets', (cache = new Map()));
  const need = ids.filter((id) => { const c = cache!.get(id); return !c || Date.now() - c.at > 30000; });
  if (need.length) {
    const ext = await vmRef(b);
    const r = await b.callChrome<{ values: Record<string, any> }>(XS.EXT_STORAGE_GET, { id: ext.id, area: 'local', keys: need.flatMap((i) => [`scr:${i}`, `code:${i}`]), skip: null });
    const reqs = new Map<number, string[]>();
    for (const id of need) {
      const s = r.values[`scr:${id}`];
      const map = s?.custom?.pathMap ?? {};
      reqs.set(id, (s?.meta?.require ?? []).map((u: string) => map[u] ?? u));
    }
    const all = [...new Set([...reqs.values()].flat())];
    const rr = all.length ? await b.callChrome<{ values: Record<string, any> }>(XS.EXT_STORAGE_GET, { id: ext.id, area: 'local', keys: all.map((u) => `req:${u}`), skip: null }) : { values: {} };
    for (const id of need) {
      let off = 0;
      for (const u of reqs.get(id)!) { const code = rr.values[`req:${u}`]; if (typeof code === 'string') off += joinedLines(code); }
      const code = r.values[`code:${id}`];
      cache.set(id, typeof code === 'string' ? { off, end: joinedLines(code), pre: preludeSpan(code), at: Date.now() } : { off, end: 0, at: Date.now() });
    }
  }
  return new Map(ids.map((id) => { const c = cache!.get(id); return [id, { off: c?.off ?? 0, end: c?.end ?? 0, pre: c?.pre }]; }));
}

/**
 * Rewrite Violentmonkey positions in stacks to workspace file lines (scripts/x.user.js:9:9), and point an entry
 * whose top frame is a userscript at that file (Firefox reports such errors at "sandbox eval code" or the page URL).
 * An uncaught error in a script's top-level code is reported one line past its end (Violentmonkey's wrapper): the
 * failing line is unknown there, so such a position reads "scripts/x.user.js (top-level code, line not reported)".
 */
export async function mapVmStacks<T extends { stack?: string; url?: string; line?: number; col?: number }>(b: Browser, entries: T[]): Promise<T[]> {
  const ids = new Set<number>();
  const urlId = (u?: string) => { const m = u ? VM_URL.exec(u) : null; return m ? Number(m[2]) : null; };
  for (const e of entries) {
    for (const m of (e.stack ?? '').matchAll(VM_POS)) ids.add(Number(m[2]));
    const u = urlId(e.url);
    if (u !== null) ids.add(u);
  }
  if (!ids.size) return entries;
  let offs: Map<number, VmLines>;
  try { offs = await vmLineOffsets(b, [...ids]); } catch { return entries; }
  const links = readState().links;
  const fileOf = (id: number, name: string) => Object.entries(links).find(([, l]) => l.mode === 'manager' && Number(l.id) === id)?.[0] ?? `${decodeURIComponent(name)}.user.js`;
  /** file line of a Violentmonkey position; null: in an @require; 'top': past the script's end (its wrapper) */
  const fileLine = (id: number, line: number): number | 'top' | null => {
    const o = offs.get(id) ?? { off: 0, end: 0 };
    const fl = line - o.off;
    return fl < 1 ? null : o.end && fl > o.end ? 'top' : fl;
  };
  /** file column: on the prelude's line, columns after it lose its length */
  const fileCol = (id: number, fl: number, col: number): number => {
    const p = offs.get(id)?.pre;
    return p && fl === p.line && col >= p.col + p.len ? col - p.len : col;
  };
  const TOP = ' (top-level code, line not reported)';
  return entries.map((e) => {
    const u = urlId(e.url);
    if (u !== null && e.line) {
      // the entry's own position is in the script (console calls): map it, keep the stack as is below
      const fl = fileLine(u, e.line);
      const file = fileOf(u, VM_URL.exec(e.url!)![1]);
      if (fl === 'top') e = { ...e, url: file + TOP, line: undefined, col: undefined };
      else if (fl !== null) e = { ...e, url: file, line: fl, col: e.col ? fileCol(u, fl, e.col) : e.col };
    }
    if (!e.stack) return e;
    let first: { file: string; line?: number; col?: number } | null = null;
    const top = e.stack.split(' <- ')[0];
    const stack = e.stack.replace(VM_POS, (m, name: string, id: string, line: string, col?: string) => {
      const fl = fileLine(Number(id), Number(line));
      if (fl === null) return `${m} (in an @require)`;
      const file = fileOf(Number(id), name);
      if (fl === 'top') { first ??= { file: file + TOP }; return file + TOP; }
      const fc = col ? fileCol(Number(id), fl, Number(col.slice(1))) : undefined;
      first ??= { file, line: fl, col: fc };
      return `${file}:${fl}${fc ? `:${fc}` : ''}`;
    });
    const out = { ...e, stack };
    const f = first as { file: string; line?: number; col?: number } | null;
    if (f && new RegExp(VM_POS.source).test(top) && (!e.url || /^(sandbox eval code|https?:|file:)/.test(e.url))) { out.url = f.file; out.line = f.line; out.col = f.col; }
    return out;
  });
}
