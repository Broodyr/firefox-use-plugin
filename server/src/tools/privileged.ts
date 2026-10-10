// privileged layer (+ ff_prefs_get/set).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROTECTED_PREFS, checkDenylist, evalPrivileged, looksLikeWrite } from '../transports/privileged.js';
import * as XS from '../browser/extScripts.js';
import { extMessage, resolveExtension } from '../browser/realms.js';
import type { Browser } from '../browser/session.js';
import { maskValue } from '../safety/mask.js';
import { fail } from '../errors.js';
import { checkUploadPath } from './input.js';
import { tool, type ToolOutput } from './registry.js';

const extArg = z.string().min(1).describe('Extension id, alias ("ubo", "vm") or unique name substring');
const areaArg = z.enum(['local', 'sync', 'session', 'managed']).default('local');
const LARGE = 100_000;

/** Values recorded in the audit log for undo; huge values are replaced by a marker (restore from a snapshot instead). */
export function auditValue(v: unknown): unknown {
  if (v === undefined) return { $absent: true };
  let n = 0;
  try { n = JSON.stringify(v)?.length ?? 0; } catch { return { $unserializable: true }; }
  return n > LARGE ? { $large: true, bytes: n } : v;
}

export const allowSet = (u?: string[]) => (u?.length ? new Set(u.map((x) => x.toLowerCase())) : undefined);

function preview(v: unknown, max: number): string {
  let s: string;
  try { s = JSON.stringify(v) ?? 'undefined'; } catch { s = String(v); }
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

async function extStorageWrite(b: Browser, id: string, area: string, items: Record<string, unknown> | null, keys: string[] | null): Promise<ToolOutput['changes']> {
  if (area === 'managed') fail('BAD_ARGS', 'storage.managed is read-only for extensions; use managed_storage_set');
  const r = items
    ? await b.callChrome<{ before: Record<string, unknown> }>(XS.EXT_STORAGE_SET, { id, area, items })
    : await b.callChrome<{ before: Record<string, unknown> }>(XS.EXT_STORAGE_REMOVE, { id, area, keys });
  const names = items ? Object.keys(items) : keys!;
  return names.map((k) => ({ kind: 'ext_storage', path: `${id}|${area}|${k}`, before: auditValue(r.before[k]), after: items ? auditValue(items[k]) : { $absent: true } }));
}

export const privilegedTools = [
  tool({
    name: 'eval_privileged',
    description: 'Escape hatch: run JS in the browser chrome (privileged) context; `return` a JSON-able value (async/await allowed). Denylisted areas (logins, key stores, sync/FxA, security/remote/debugger prefs) are refused. Pass writes:true for code that changes state (needs scope; takes a checkpoint first). Prefer the higher-level tools.',
    args: {
      code: z.string().min(1).describe('Function body, e.g. "return Services.appinfo.version"'),
      writes: z.boolean().default(false).describe('The code changes persistent state (prefs, add-ons, storage, files)'),
    },
    write: true,
    unmask: true,
    async handler(a, ctx) {
      if (!a.writes && looksLikeWrite(a.code)) fail('DECLARE_WRITES', 'this code looks like it changes persistent state', 'Re-run with writes: true (requires an approved scope; a checkpoint is taken first).');
      const b = await ctx.browser();
      checkDenylist(a.code);
      let cp: string | null = null;
      if (a.writes) {
        await ctx.requireScope('privileged', b);
        cp = await ctx.checkpoint(b, 'auto: before eval_privileged (writes)');
      }
      const r = await evalPrivileged(b, a.code);
      return { text: `(${r.type}) ${JSON.stringify(maskValue(r.value, 0, allowSet(a.unmask)), null, 1)}${cp ? `
checkpoint before: ${cp}` : ''}`, changes: a.writes ? [{ kind: 'eval_privileged', after: a.code.slice(0, 2000), before: cp }] : undefined };
    },
  }),
  tool({
    name: 'ff_prefs_get',
    description: 'Read prefs: value, type, default, whether user-set or locked.',
    args: { names: z.array(z.string().min(1)).min(1).max(100) },
    async handler(a, ctx) {
      const b = await ctx.browser();
      for (const n of a.names) checkDenylist(n, `pref ${n}`);
      const r = await b.callChrome<Record<string, any>>(XS.PREFS_GET, { names: a.names });
      return Object.entries(r).map(([n, p]) => p.exists ? `${n} = ${JSON.stringify(p.value)} (${p.type}${p.userSet ? ', user-set' : ', default'}${p.locked ? ', locked' : ''}${p.userSet && p.default !== undefined ? `; default ${JSON.stringify(p.default)}` : ''})` : `${n}: not set`).join('\n');
    },
  }),
  tool({
    name: 'ff_prefs_set',
    description: 'Set prefs live ({name: value}; null resets to default). Audited with before-values (undo-able). Security, remote, debugger, xpinstall and signon prefs are refused. Needs scope "prefs".',
    args: { values: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()])) },
    write: true,
    async handler(a, ctx) {
      const names = Object.keys(a.values);
      if (!names.length) fail('BAD_ARGS', 'no prefs given');
      for (const n of names) {
        if (PROTECTED_PREFS.test(n)) fail('DENIED', `${n} is a protected pref`, 'Debugger, remote, security, xpinstall and signon prefs are never changed by Claude.');
        checkDenylist(n, `pref ${n}`);
      }
      const b = await ctx.browser();
      await ctx.requireScope('prefs', b);
      const r = await b.callChrome<{ before: Record<string, unknown> }>(XS.PREFS_SET, { values: a.values });
      return {
        text: names.map((n) => `${n}: ${JSON.stringify(r.before[n])} -> ${a.values[n] === null ? '(default)' : JSON.stringify(a.values[n])}`).join('\n'),
        changes: names.map((n) => ({ kind: 'pref', path: n, before: r.before[n], after: a.values[n] })),
      };
    },
  }),
  tool({
    name: 'addons_list',
    description: 'Installed add-ons: id, name, version, enabled, temporary flag, internal UUID / base URL, background type, options page, update policy.',
    args: {},
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const list = await b.callChrome<any[]>(XS.ADDONS_LIST);
      return list.map((x) => {
        let s = `${x.active ? '●' : '○'} ${x.name} ${x.version} — ${x.id}${x.temporary ? ' [temporary]' : ''}${x.active ? '' : ' [disabled]'}`;
        if (a.detail !== 'summary') s += `\n    ${x.baseURL ?? '(not running)'} · MV${x.mv ?? '?'} · background: ${x.background ?? '?'}${x.options ? ` · options: ${x.options}` : ''} · autoUpdate=${x.autoUpdate} · ${x.location}`;
        else if (x.uuid) s += ` · moz-extension://${x.uuid}/`;
        return s;
      }).join('\n') || 'no add-ons';
    },
  }),
  tool({
    name: 'addons_set_enabled',
    description: 'Enable or disable an add-on. Audited (undo-able). Needs scope "addons".',
    args: { extension: extArg, enabled: z.boolean() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      await ctx.requireScope('addons', b);
      const r = await b.callChrome<{ before: boolean; after: boolean }>(XS.ADDON_SET_ENABLED, { id: ext.id, enabled: a.enabled });
      await b.devtools?.updateExtensions();
      return { text: `${ext.name}: ${r.before ? 'enabled' : 'disabled'} -> ${r.after ? 'enabled' : 'disabled'}`, changes: [{ kind: 'addon_enabled', path: ext.id, before: r.before, after: r.after }] };
    },
  }),
  tool({
    name: 'addons_reload',
    description: 'Reload an add-on (temporary add-ons re-read their files; others are disabled and re-enabled). Its background restarts; storage is kept. Needs scope "addons".',
    args: { extension: extArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      await ctx.requireScope('addons', b);
      const r = await b.callChrome<string>(XS.ADDON_RELOAD, { id: ext.id });
      await b.devtools?.updateExtensions();
      return { text: `${ext.name}: ${r}`, changes: [{ kind: 'addon_reload', path: ext.id }] };
    },
  }),
  tool({
    name: 'addons_install_local',
    description: 'Install a LOCAL extension build (directory with manifest.json, or .xpi/.zip inside the workspace or sandbox folder) as a temporary add-on. Web installs are refused. Needs scope "addons".',
    args: { path: z.string().min(1) },
    write: true,
    async handler(a, ctx) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a.path) && !/^file:/i.test(a.path)) fail('DENIED', 'add-on installs from the web are refused', 'Only local builds: a directory with manifest.json or an .xpi inside the workspace or the sandbox folder.');
      const abs = checkUploadPath(a.path.replace(/^file:\/\/\/?/i, ''));
      const isDir = fs.statSync(abs).isDirectory();
      if (isDir && !fs.existsSync(path.join(abs, 'manifest.json'))) fail('BAD_ARGS', `${abs} has no manifest.json`);
      const b = await ctx.browser();
      await ctx.requireScope('addons', b);
      const r = await b.bidi.send('webExtension.install', { extensionData: isDir ? { type: 'path', path: abs } : { type: 'archivePath', path: abs } }, 60000);
      await b.devtools?.updateExtensions();
      return { text: `installed ${r.extension} (temporary) from ${abs}`, changes: [{ kind: 'addon_install_temporary', path: r.extension, after: abs }] };
    },
  }),
  tool({
    name: 'ext_storage_get',
    description: 'Read any extension\'s storage (local | sync | session | managed) through Firefox\'s own backends. Without keys: every key with its size and a preview. Values are masked like other output; unmask reveals named keys.',
    args: {
      extension: extArg, area: areaArg,
      keys: z.array(z.string()).optional(),
      skip: z.string().optional().describe('Regex of keys to leave out (e.g. "^cache/" for uBO)'),
    },
    detail: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      const allow = allowSet(a.unmask);
      if (a.area === 'managed') {
        const m = await b.callChrome<{ data: unknown; file: string }>(XS.MANAGED_GET, { id: ext.id });
        return m.data === null ? `${ext.name}: no managed storage set (managed_storage_set writes it)` : `${ext.name} managed storage (${m.file}):\n${JSON.stringify(maskValue(m.data, 0, allow), null, 1)}`;
      }
      const r = await b.callChrome<{ values: Record<string, unknown>; sizes: Record<string, number>; skipped: string[] }>(XS.EXT_STORAGE_GET, { id: ext.id, area: a.area, keys: a.keys ?? null, skip: a.skip ?? null });
      const keys = Object.keys(r.values);
      const max = a.detail === 'full' ? 1e9 : a.detail === 'normal' ? 1500 : a.keys ? 1500 : 200;
      const total = Object.values(r.sizes).reduce((x, y) => x + Math.max(0, y), 0);
      const lines = [`${ext.name} storage.${a.area}: ${Object.keys(r.sizes).length} key(s), ~${total} chars${r.skipped.length ? ` (${r.skipped.length} skipped by pattern)` : ''}`];
      for (const k of keys) lines.push(`${k} (${r.sizes[k]}): ${preview(maskValue({ [k]: r.values[k] }, 0, allow)[k], max)}`);
      if (a.keys) for (const k of a.keys) if (!(k in r.values)) lines.push(`${k}: (absent)`);
      return lines.join('\n');
    },
  }),
  tool({
    name: 'ext_storage_set',
    description: 'Write keys into an extension\'s storage (local | sync | session); storage.onChanged fires in the extension. Diffed into the audit log (undo-able). Needs scope "ext:<extension>". For Violentmonkey scripts and uBO filters prefer their adapters (they keep in-memory state in sync).',
    args: { extension: extArg, area: areaArg, items: z.record(z.string(), z.any()) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      await ctx.requireScope(`ext:${ext.id}`, b);
      const changes = await extStorageWrite(b, ext.id, a.area, a.items, null);
      return { text: `${ext.name} storage.${a.area}: set ${Object.keys(a.items).join(', ')}`, changes };
    },
  }),
  tool({
    name: 'ext_storage_remove',
    description: 'Remove keys from an extension\'s storage (local | sync | session). Audited with before-values (undo-able). Needs scope "ext:<extension>".',
    args: { extension: extArg, area: areaArg, keys: z.array(z.string()).min(1) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      await ctx.requireScope(`ext:${ext.id}`, b);
      const changes = await extStorageWrite(b, ext.id, a.area, null, a.keys);
      return { text: `${ext.name} storage.${a.area}: removed ${a.keys.join(', ')}`, changes };
    },
  }),
  tool({
    name: 'ext_source',
    description: 'Read an installed extension\'s own source files (its .xpi or local folder), to learn how it works before driving it: without path or grep, the file list (prefix filters it); path: one file (lines from/to, or offset/length characters for minified code); grep: a regex across its text files with surrounding context (e.g. "onMessage|onConnect|sendMessage" to find its message handlers, or a command name).',
    args: {
      extension: extArg,
      path: z.string().optional().describe('File inside the extension, e.g. "manifest.json" or "background/index.js"'),
      grep: z.string().optional().describe('Regex (JS syntax); /pattern/flags also accepted'),
      prefix: z.string().optional().describe('Only files under this path'),
      from: z.number().int().positive().optional().describe('path: first line'),
      to: z.number().int().positive().optional().describe('path: last line'),
      offset: z.number().int().min(0).optional().describe('path: start character (minified files are one long line)'),
      length: z.number().int().positive().optional().describe('path: number of characters from offset'),
      context: z.number().int().min(0).max(2000).default(120).describe('grep: characters of context around each match'),
      max_matches: z.number().int().positive().max(500).default(40),
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      if (a.grep) {
        const m = /^\/(.+)\/([a-z]*)$/.exec(a.grep);
        const source = m ? m[1] : a.grep, flags = (m ? m[2] : 'i').replace('g', '');
        try { new RegExp(source, flags); } catch (e: any) { fail('BAD_ARGS', `bad regex: ${e.message}`); }
        const r = await b.callChrome<{ matches: { file: string; line: number; col: number; snippet: string }[]; total: number; scanned: number }>(XS.EXT_GREP, { id: ext.id, source, flags, prefix: a.prefix ?? a.path ?? null, ctx: a.context, max: a.max_matches }, );
        return [`${ext.name}: ${r.total} match(es) for /${source}/${flags} in ${r.scanned} text file(s)${r.total > r.matches.length ? `, first ${r.matches.length}` : ''}`,
          ...r.matches.map((x) => `${x.file}:${x.line}:${x.col}  ${x.snippet}`)].join('\n');
      }
      if (a.path) {
        const r = await b.callChrome<{ text?: string; missing?: boolean; near?: string[] }>(XS.EXT_READ, { id: ext.id, path: a.path.replace(/^\//, '') });
        if (r.missing) fail('FILE_NOT_FOUND', `${ext.name} has no ${a.path}`, r.near?.length ? `Similar: ${r.near.join(', ')}` : 'ext_source without path lists the files.');
        const text = r.text!;
        if (a.offset !== undefined || a.length !== undefined) {
          const o = a.offset ?? 0, n = a.length ?? 4000;
          return `${ext.name} ${a.path} chars ${o}–${Math.min(text.length, o + n)} of ${text.length}:\n${text.slice(o, o + n)}`;
        }
        const lines = text.split('\n');
        const from = a.from ?? 1, to = Math.min(lines.length, a.to ?? lines.length);
        const longest = Math.max(...lines.slice(from - 1, to).map((l) => l.length));
        const hint = longest > 2000 ? `\n(note: a line is ${longest} characters long: probably minified; use grep with context, or offset/length)` : '';
        return `${ext.name} ${a.path} lines ${from}–${to} of ${lines.length} (${text.length} chars)${hint}\n${lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n')}`;
      }
      const r = await b.callChrome<{ root: string; files: [string, number][] }>(XS.EXT_FILES, { id: ext.id, prefix: a.prefix ?? null });
      const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);
      return [`${ext.name}: ${r.files.length} file(s)${a.prefix ? ` under ${a.prefix}` : ''} · ${r.root}`, ...r.files.map(([f, s]) => `${f}  ${kb(s)}`)].join('\n');
    },
  }),
  tool({
    name: 'ext_page_open',
    description: 'Open one of an extension\'s own pages (e.g. uBO "dashboard.html", Violentmonkey "options/index.html") in a background agent tab. Script it with eval realm {kind:"extension", extension, page}.',
    args: { extension: extArg, path: z.string().default('').describe('Path inside the extension; default: its options page') },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      const info = (await b.callChrome<any[]>(XS.ADDONS_LIST)).find((x) => x.id === ext.id);
      if (!info?.baseURL) fail('EXTENSION_DISABLED', `${ext.name} is not running`);
      const p = (a.path || info.options || '').replace(/^\//, '');
      if (!p) fail('BAD_ARGS', `${ext.name} has no options page; pass a path`);
      const url = info.baseURL + p;
      const tab = await b.createTab(url);
      return { text: `tab ${tab}: ${url}\nrealm: {kind:"extension", extension:"${a.extension}", page:"${p}"}`, target: { tab, url } };
    },
  }),
  tool({
    name: 'ext_message',
    description: 'Send runtime.sendMessage to an extension AS ITS OWN PAGE would (from a helper frame in its background), and return the reply. For extensions whose background uses runtime.onMessage (e.g. Violentmonkey commands). Needs scope "ext:<extension>" unless writes:false.',
    args: { extension: extArg, message: z.any(), writes: z.boolean().default(true).describe('false for read-only commands (no scope needed)') },
    write: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      if (a.writes) await ctx.requireScope(`ext:${ext.id}`, b);
      const r = await extMessage(b, ext, a.message);
      const from = /from its (extension page .*)\)$/.exec(r.realm)?.[1];
      return { text: `reply (${r.type}): ${JSON.stringify(maskValue(r.value, 0, allowSet(a.unmask)), null, 1)}${from ? `\nsent from its ${from}` : ''}`, changes: a.writes ? [{ kind: 'ext_message', path: ext.id, after: a.message }] : undefined };
    },
  }),
  tool({
    name: 'managed_storage_set',
    description: 'Set an extension\'s managed storage (storage.managed, e.g. uBO adminSettings/advancedSettings/toOverwrite) for claude-dev only, then reload the extension. null clears it. Audited (undo-able). Needs scope "ext:<extension>".',
    args: { extension: extArg, data: z.record(z.string(), z.any()).nullable() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      await ctx.requireScope(`ext:${ext.id}`, b);
      await b.callChrome(XS.MANAGED_INSTALL);
      const r = await b.callChrome<{ before: unknown; file: string }>(XS.MANAGED_SET, { id: ext.id, data: a.data });
      const reload = ext.active ? await b.callChrome<string>(XS.ADDON_RELOAD, { id: ext.id }) : 'not running; applies when enabled';
      await b.devtools?.updateExtensions();
      return { text: `${ext.name} managed storage ${a.data === null ? 'cleared' : `set (${Object.keys(a.data).join(', ')})`} in ${r.file}; ${reload}`, changes: [{ kind: 'managed_storage', path: ext.id, before: r.before, after: a.data }] };
    },
  }),
];
