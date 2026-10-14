// generic extension development: ext_dev_load (temporary install + hot reload on file change, with
// manifest/startup errors per reload), ext_dev_lint (Firefox's own manifest validation, plus web-ext/addons-linter
// when installed), ext_dev_inspect (realms, permissions, storage, errors, reload history, messaging log).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { REPO_ROOT } from '../config.js';
import { fail } from '../errors.js';
import * as XS from '../browser/extScripts.js';
import { resolveExtension } from '../browser/realms.js';
import type { Browser } from '../browser/session.js';
import { sleep } from '../browser/launcher.js';
import { kb, type LogEntry } from '../browser/devtools.js';
import { checkUploadPath } from './input.js';
import { clock } from './console.js';
import { messagingLog } from '../browser/msglog.js';
import { tool } from './registry.js';

interface Reload { at: number; trigger: string; ok: boolean; ms: number; errors: string[]; note?: string }
interface DevExt { id: string; name: string; dir: string; watcher: fs.FSWatcher | null; reloads: Reload[]; timer: NodeJS.Timeout | null; changed: Set<string>; busy: Promise<unknown> | null }

function devExts(b: Browser): Map<string, DevExt> {
  let m = b.adapters.get('extDev') as Map<string, DevExt> | undefined;
  if (!m) {
    m = new Map();
    b.adapters.set('extDev', m);
    const mm = m;
    b.closers.push(() => { for (const d of mm.values()) { d.watcher?.close(); if (d.timer) clearTimeout(d.timer); } });
  }
  return m;
}

interface Validation { thrown: string | null; errors: string[]; warnings: string[]; id: string | null; name: string | null; version: string | null; mv: number | null }

/** Errors the extension's own realms logged since `from` (background, pages, content scripts, workers), in the
 *  order they happened: entries from different processes reach the hub in any order (Firefox 158: a content
 *  script's "Receiving end does not exist" before the background error that caused it). */
async function errorsSince(b: Browser, id: string, from: number): Promise<string[]> {
  const d = await b.dt();
  const own = (e: LogEntry) => (e.realm.startsWith('extension:') ? 0 : 1);
  return d.log.filter((e) => e.seq > from && e.addonId === id && (e.level === 'error' || e.kind !== 'console'))
    .sort((x, y) => x.ts - y.ts || own(x) - own(y))
    .slice(-10).map((e) => `${e.text.slice(0, 300)}${e.url ? ` (${e.url.replace(/^moz-extension:\/\/[^/]+/, '')}${e.line ? `:${e.line}` : ''})` : ''}`);
}

async function reloadDev(b: Browser, dev: DevExt, trigger: string): Promise<Reload> {
  const d = await b.dt();
  const from = d.cursor;
  const t0 = Date.now();
  const r: Reload = { at: t0, trigger, ok: true, ms: 0, errors: [] };
  const v = await b.callChrome<Validation>(XS.MANIFEST_VALIDATE, { path: dev.dir }).catch((e) => ({ thrown: String(e.message), errors: [], warnings: [] } as unknown as Validation));
  if (v.thrown || v.errors.length) {
    // Firefox would refuse the new manifest: keep the running version
    r.ok = false;
    r.errors = [...(v.thrown ? [v.thrown] : []), ...v.errors];
    r.note = 'not reloaded: the manifest is invalid (the previous version keeps running)';
  } else {
    try { await b.callChrome(XS.ADDON_RELOAD, { id: dev.id }); } catch (e: any) { r.ok = false; r.errors.push(`reload failed: ${e.message}`); }
    await sleep(800); // background startup errors
    r.errors.push(...await errorsSince(b, dev.id, from));
    if (r.errors.length) r.ok = false;
  }
  r.ms = Date.now() - t0;
  dev.reloads.push(r);
  if (dev.reloads.length > 30) dev.reloads.shift();
  return r;
}

function watch(b: Browser, dev: DevExt) {
  dev.watcher?.close();
  dev.watcher = fs.watch(dev.dir, { recursive: true }, (_ev, file) => {
    const f = String(file ?? '');
    if (!f || /(^|[\\/])(node_modules|\.git|\.firefox-use)([\\/]|$)|~$|\.sw[px]$|\.tmp$/.test(f)) return;
    dev.changed.add(f.replace(/\\/g, '/'));
    if (dev.timer) clearTimeout(dev.timer);
    dev.timer = setTimeout(() => {
      dev.timer = null;
      const files = [...dev.changed];
      dev.changed.clear();
      if (b.dead) return;
      dev.busy = (dev.busy ?? Promise.resolve()).then(() => reloadDev(b, dev, `files changed: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`)).catch(() => {});
    }, 400);
  });
}

const reloadLine = (r: Reload) => `${clock(r.at)} ${r.ok ? 'reloaded' : 'FAILED'} (${r.trigger}) in ${r.ms} ms${r.note ? ` — ${r.note}` : ''}${r.errors.length ? `\n    ${r.errors.join('\n    ')}` : ''}`;

let npmGlobalRoot: string | null | undefined;
/**
 * web-ext's entry script: the plugin's own dev dependency (a source checkout after npm install), else a global
 * install (npm install -g web-ext; a release install has no node_modules). null when neither exists.
 */
export function findWebExt(): string | null {
  const local = path.join(REPO_ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  if (fs.existsSync(local)) return local;
  if (npmGlobalRoot === undefined) {
    // fixed arguments; a shell is needed to run npm's .cmd shim on Windows
    try { npmGlobalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, windowsHide: true, timeout: 15000 }).trim() || null; } catch { npmGlobalRoot = null; }
  }
  const global = npmGlobalRoot ? path.join(npmGlobalRoot, 'web-ext', 'bin', 'web-ext.js') : null;
  return global && fs.existsSync(global) ? global : null;
}

/** web-ext (addons-linter) when it is installed; null otherwise. */
export async function webExtLint(dir: string): Promise<{ errors: any[]; warnings: any[]; notices: any[] } | string | null> {
  const bin = findWebExt();
  if (!bin) return null;
  return new Promise((res) => {
    const p = spawn(process.execPath, [bin, 'lint', '--source-dir', dir, '--output', 'json', '--no-config-discovery'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => {
      try { const j = JSON.parse(out.slice(out.indexOf('{'))); res({ errors: j.errors ?? [], warnings: j.warnings ?? [], notices: j.notices ?? [] }); } catch { res(`web-ext lint output not understood: ${out.slice(0, 300)}`); }
    });
    p.on('error', (e) => res(`web-ext lint failed: ${e.message}`));
  });
}

export const extDevTools = [
  tool({
    name: 'ext_dev_load',
    description: 'Load a local extension (a workspace folder with manifest.json) as a temporary add-on and hot-reload it whenever its files change, reporting manifest and startup errors per reload. Calling it again for the same folder reloads now and shows the reload history. Content scripts already in open pages are not replaced: reload those pages. Needs scope "addons".',
    args: { path: z.string().min(1).describe('Extension folder (workspace-relative)'), watch: z.boolean().default(true).describe('Hot-reload on file changes') },
    write: true,
    async handler(a, ctx) {
      const abs = checkUploadPath(a.path);
      if (!fs.statSync(abs).isDirectory() || !fs.existsSync(path.join(abs, 'manifest.json'))) fail('BAD_ARGS', `${abs} is not a folder with manifest.json`);
      const b = await ctx.browser();
      await ctx.requireScope('addons', b);
      const devs = devExts(b);
      const existing = [...devs.values()].find((d) => d.dir.toLowerCase() === abs.toLowerCase());
      if (existing) {
        const r = await reloadDev(b, existing, 'ext_dev_load');
        if (a.watch && !existing.watcher) watch(b, existing);
        if (!a.watch && existing.watcher) { existing.watcher.close(); existing.watcher = null; }
        return [`${existing.name} (${existing.id}) from ${a.path}: ${existing.watcher ? 'watching for changes' : 'not watching'}`, ...existing.reloads.slice(-8).map(reloadLine)].join('\n');
      }
      const v = await b.callChrome<Validation>(XS.MANIFEST_VALIDATE, { path: abs });
      if (v.thrown || v.errors.length) fail('MANIFEST_INVALID', `Firefox refuses ${a.path}/manifest.json: ${[v.thrown, ...v.errors].filter(Boolean).join('; ')}`, 'Fix the manifest; ext_dev_lint shows every problem.');
      const d = await b.dt();
      const from = d.cursor;
      const t0 = Date.now();
      const r = await b.bidi.send('webExtension.install', { extensionData: { type: 'path', path: abs } }, 60000);
      await d.updateExtensions();
      const id = r.extension as string;
      await sleep(800);
      const errors = await errorsSince(b, id, from);
      const dev: DevExt = { id, name: v.name ?? id, dir: abs, watcher: null, reloads: [{ at: t0, trigger: 'first load', ok: !errors.length, ms: Date.now() - t0, errors }], timer: null, changed: new Set(), busy: null };
      devs.set(id, dev);
      if (a.watch) watch(b, dev);
      const lines = [`loaded ${dev.name} ${v.version ?? ''} (${id}, MV${v.mv}) from ${a.path} as a temporary add-on${a.watch ? '; reloads when its files change' : ''}`];
      if (v.warnings.length) lines.push(`manifest warnings: ${v.warnings.join('; ')}`);
      lines.push(errors.length ? `startup errors:\n    ${errors.join('\n    ')}` : 'no startup errors');
      return { text: lines.join('\n'), changes: [{ kind: 'addon_install_temporary', path: id, after: abs }] };
    },
  }),
  tool({
    name: 'ext_dev_lint',
    description: 'Lint a local extension folder: Firefox\'s own manifest validation (errors that stop a load, warnings), plus web-ext / addons-linter (AMO rules: unsafe innerHTML, deprecated APIs, ...) when web-ext is installed (the plugin\'s own dev dependency, or npm install -g web-ext).',
    args: { path: z.string().min(1) },
    detail: true,
    async handler(a, ctx) {
      const abs = checkUploadPath(a.path);
      const b = await ctx.browser();
      const v = await b.callChrome<Validation>(XS.MANIFEST_VALIDATE, { path: abs });
      const lines = [`Firefox: ${v.thrown || v.errors.length ? 'REFUSES the manifest' : 'manifest OK'}${v.name ? ` (${v.name} ${v.version ?? ''}, MV${v.mv})` : ''}`];
      for (const e of [v.thrown, ...v.errors].filter(Boolean)) lines.push(`  error: ${e}`);
      for (const w of v.warnings) lines.push(`  warning: ${w}`);
      const wl = await webExtLint(abs);
      if (wl === null) lines.push('addons-linter: not run (web-ext is not installed; the user can add it with npm install -g web-ext)');
      else if (typeof wl === 'string') lines.push(`addons-linter: ${wl}`);
      else {
        lines.push(`addons-linter: ${wl.errors.length} error(s), ${wl.warnings.length} warning(s), ${wl.notices.length} notice(s)`);
        const max = a.detail === 'full' ? 200 : a.detail === 'normal' ? 60 : 25;
        for (const [kind, list] of [['error', wl.errors], ['warning', wl.warnings], ...(a.detail === 'summary' ? [] : [['notice', wl.notices]])] as [string, any[]][]) {
          for (const m of list.slice(0, max)) lines.push(`  ${kind} ${m.code}: ${m.message}${m.file ? ` (${m.file}${m.line ? `:${m.line}` : ''})` : ''}`);
        }
      }
      return lines.join('\n');
    },
  }),
  tool({
    name: 'ext_dev_inspect',
    description: 'One extension at a glance: its realms (background, open pages, workers, content scripts per tab), permissions (granted host and API permissions), storage sizes, recent errors, hot-reload history (ext_dev_load) and, with messages:"on", a log of runtime messages and port traffic between its contexts (messages:"off" stops it).',
    args: {
      extension: z.string().min(1).describe('id, alias or name'),
      messages: z.enum(['on', 'off']).optional().describe('Start or stop the messaging log for this extension'),
      limit: z.number().int().positive().max(300).default(40),
    },
    detail: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const ext = await resolveExtension(b, a.extension);
      const d = await b.dt();
      await d.updateExtensions();
      const info = await b.callChrome<any>(`async ({ id }) => {
        const pol = WebExtensionPolicy.getByID(id);
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const ad = await AddonManager.getAddonByID(id);
        const m = pol && pol.extension && pol.extension.manifest || {};
        return {
          version: ad && ad.version, temporary: !!(ad && ad.temporarilyInstalled), active: !!pol, host: pol && pol.mozExtensionHostname,
          mv: m.manifest_version, background: m.background ? (m.background.service_worker ? 'service worker' : m.background.page ? 'page' : 'scripts') : 'none',
          permissions: pol ? [...pol.permissions] : [], origins: pol ? pol.allowedOrigins.patterns.map((p) => p.pattern) : [],
          optional: [...(m.optional_permissions || []), ...(m.optional_host_permissions || [])],
          contentScripts: (m.content_scripts || []).map((c) => (c.matches || []).join(' ') + ' -> ' + (c.js || []).join(', ') + ' @' + (c.run_at || 'document_idle')),
        };
      }`, { id: ext.id });
      const lines = [`${ext.name} ${info.version ?? ''} (${ext.id}) · MV${info.mv ?? '?'} · background: ${info.background}${info.temporary ? ' · temporary' : ''}${info.active ? '' : ' · DISABLED'}`];
      // realms
      const realms: string[] = [];
      const csByTab = new Map<string, number>();
      for (const t of d.targets.values()) {
        if (!t.alive) continue;
        const id = t.addonId ?? d.addonForUrl(t.url);
        if (id !== ext.id) continue;
        if (t.type === 'content_script') {
          const tab = await b.tabForBc(d.topBcForWindow(t.innerWindowId));
          const k = tab !== undefined ? `tab${tab}` : 'other tab';
          csByTab.set(k, (csByTab.get(k) ?? 0) + 1);
        } else realms.push(`${t.type === 'frame' ? (/_generated_background_page|background/.test(t.url ?? '') ? 'background' : 'page') : t.type} ${(t.url ?? '').replace(/^moz-extension:\/\/[^/]+/, '')}`);
      }
      if (csByTab.size) realms.push(`content scripts: ${[...csByTab].map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(', ')}`);
      lines.push(`realms: ${realms.length ? realms.join('; ') : 'none running'}`);
      if (info.contentScripts.length) lines.push(`declared content scripts: ${info.contentScripts.join(' | ')}`);
      lines.push(`permissions: ${info.permissions.filter((p: string) => !p.startsWith('internal:')).join(', ') || 'none'}`);
      lines.push(`host access: ${info.origins.join(', ') || 'none'}${info.optional.length ? ` · optional: ${info.optional.join(', ')}` : ''}`);
      // storage sizes
      const sizes: string[] = [];
      for (const area of ['local', 'sync', 'session']) {
        const r = await b.callChrome<any>(XS.EXT_STORAGE_GET, { id: ext.id, area, keys: null, sizesOnly: true, skip: null }).catch(() => null);
        if (r && Object.keys(r.sizes ?? {}).length) sizes.push(`${area} ${Object.keys(r.sizes).length} key(s) ${kb(Object.values<number>(r.sizes).reduce((x, y) => x + Math.max(0, y), 0))}`);
      }
      lines.push(`storage: ${sizes.join(', ') || 'empty'}`);
      const errs = d.log.filter((e) => e.addonId === ext.id && (e.level === 'error' || e.kind !== 'console')).slice(-5);
      lines.push(errs.length ? `recent errors:\n${errs.map((e) => `  ${clock(e.ts)} [${d.realmLabel(e)}] ${e.text.slice(0, 200)}`).join('\n')}` : 'recent errors: none');
      const dev = devExts(b).get(ext.id);
      if (dev) lines.push(`hot reload (${dev.watcher ? 'watching' : 'not watching'} ${dev.dir}):`, ...dev.reloads.slice(-5).map((r) => `  ${reloadLine(r)}`));
      // messaging log
      const log = messagingLog(b);
      await log.pull();
      if (a.messages === 'on') { await log.start(ext.id); lines.push('messaging log: on (runtime messages and port traffic of this extension)'); }
      if (a.messages === 'off') { await log.stop(ext.id); lines.push('messaging log: off'); }
      const entries = log.entries(ext.id);
      const hook = log.hookErrors();
      if (hook.errors) lines.push(`messaging log: ${hook.errors} message(s) of watched extensions could not be logged (${hook.firstError}); a Firefox update may have changed its messaging internals: run ff_selfcheck`);
      if (entries.length || log.watching(ext.id)) {
        lines.push(`messages (${entries.length}${log.watching(ext.id) ? ', logging' : ''}):`);
        for (const m of entries.slice(-a.limit)) lines.push(`  ${clock(m.ts)} ${m.kind} ${m.from} -> ${m.to}: ${m.text}`);
      }
      return lines.join('\n');
    },
  }),
];
