// Make claude-dev look like the user's Firefox: copy the main profile's extensions (their local, AMO-signed .xpi files;
// nothing is downloaded) and its user-set prefs. The main profile is only read. Extensions are staged in addonsDir,
// so every later launch keeps them at the main profile's version. Credential and 2FA extensions never come
// along (claude-dev holds no secrets).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { detectMainProfile, loadConfig } from '../config.js';
import { fail } from '../errors.js';
import * as XS from '../browser/extScripts.js';
import { PROTECTED_PREFS, checkDenylist } from '../transports/privileged.js';
import { PREF_SKIP } from '../snapshots/snapshots.js';
import { tool } from './registry.js';

interface MainExt { id: string; name: string; version: string; active: boolean; xpi: string; signed: number }

/** Never copied into claude-dev: password managers, authenticators and similar (no secrets in the dev profile). */
const CREDENTIAL = /pass(word|wort)?\b|bitwarden|1password|lastpass|keepass|dashlane|nordpass|enpass|roboform|keeper|authenticat|\b2fa\b|two.?factor|\botp\b|totp|yubi|vault/i;
const CREDENTIAL_IDS = new Set(['{446900e4-71c2-419f-a6a7-df9c091e268b}', 'admin@2fas.com', 'support@lastpass.com', '{d634138d-c276-4fc8-924b-40a0ea21d284}', 'keepassxc-browser@keepassxc.org', 'nordpassStandalone@nordsecurity.com']);

/** Prefs that describe this machine, this profile's history or Firefox's own bookkeeping, or that claude-dev depends on. */
const SYNC_SKIP = new RegExp([
  '^devtools\\.', '^extensions\\.', '^browser\\.download\\.', '^browser\\.shell\\.', '^browser\\.uitour\\.', '^browser\\.region\\.', '^browser\\.search\\.region',
  '^browser\\.tabs\\.groups\\.', '^widget\\.', '^print\\.', '^printer_', '^font\\.internaluseonly', '^taskbar\\.', '^marionette\\.', '^toolkit\\.',
  '^app\\.', '^storage\\.', '^browser\\.contentblocking\\.cfr', '^browser\\.aboutConfig\\.', '^browser\\.rights\\.', '^trailhead\\.',
  '^sanity-test\\.', '^dom\\.forms\\.autocomplete', '^browser\\.formfill\\.', '^browser\\.urlbar\\.(quicksuggest|recentsearches)', '^browser\\.theme\\.',
  '(last|Last)(Update|Check|Run|Sync|Modified|_check|_update)', '[Tt]imestamp', 'migration', '\\.version$', 'Version$', '\\.lastSeen', '\\.firstRun',
].join('|'));

function mainExtensions(dir: string): MainExt[] {
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'extensions.json'), 'utf8'));
  const out: MainExt[] = [];
  for (const a of db.addons ?? []) {
    if (a.type !== 'extension' || a.location !== 'app-profile' || !a.id || a.signedState >= 3) continue; // Mozilla's own/system add-ons
    const xpi = a.path ?? path.join(dir, 'extensions', `${a.id}.xpi`);
    if (!xpi.endsWith('.xpi') || !fs.existsSync(xpi)) continue;
    out.push({ id: a.id, name: a.defaultLocale?.name ?? a.id, version: a.version, active: !!a.active, xpi, signed: a.signedState });
  }
  return out;
}

/** user_pref(...) lines of prefs.js, then user.js (which wins at startup). Values are JSON literals. */
function mainPrefs(dir: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of ['prefs.js', 'user.js']) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/^user_pref\("((?:[^"\\]|\\.)+)",\s*(.+)\);\s*$/gm)) {
      try { const v = JSON.parse(m[2]); if (['string', 'number', 'boolean'].includes(typeof v)) out[JSON.parse(`"${m[1]}"`)] = v; } catch { /* not a literal */ }
    }
  }
  return out;
}

const SNAPSHOT_SKIP = new RegExp(PREF_SKIP);
/** Branches holding account state, machine details or Firefox's own bookkeeping. */
const BRANCH_SKIP = /^(browser\.ipProtection\.|browser\.contextual-services\.|browser\.safebrowsing\.provider\.|browser\.crashReports\.|browser\.aboutwelcome\.|browser\.firefox-view\.|browser\.newtab\.extensionControlled|browser\.keys\.|messaging-system|ui\.osk\.|print_|screenshots\.browser\.component\.last|sidebar\.(backupState|installed\.)|browser\.search\.totalSearches|browser\.urlbar\.tipShownCount\.)|nimbus/i;
/** Bookkeeping by name: the last segment says it's a time, a counter, a cache, an id or a "seen" flag. */
const LEAF_SKIP = /^(last|next)|(time|secs|seconds|count|cache|stamp|date)$|seen|dismissed|onboard|has-?used|everOpened|didSee|firstRun|first-seen|contextId|migrat|^uid$/i;

function syncablePref(name: string): boolean {
  if (PROTECTED_PREFS.test(name) || SNAPSHOT_SKIP.test(name) || SYNC_SKIP.test(name) || BRANCH_SKIP.test(name)) return false;
  if (LEAF_SKIP.test(name.split('.').pop() ?? '')) return false;
  try { checkDenylist(name, `pref ${name}`); } catch { return false; }
  return true;
}

export const profileSyncTools = [
  tool({
    name: 'profile_sync',
    description: 'Make claude-dev look like the user\'s own Firefox: copy the main profile\'s extensions (its local AMO-signed .xpi files, enabled states kept; nothing is downloaded, later launches keep them at the main profile\'s version) and its user-set prefs (machine-specific, bookkeeping and protected prefs excluded). Password managers and authenticators are never copied. The main profile is only read. Default is a dry run listing the plan; apply:true needs scope "addons" + "prefs" (a checkpoint is taken first; prefs are undo-able).',
    args: {
      apply: z.boolean().default(false),
      extensions: z.union([z.boolean(), z.array(z.string())]).default(true).describe('true = all; or a list of extension ids / names'),
      prefs: z.boolean().default(true),
    },
    write: true,
    detail: true,
    async handler(a, ctx) {
      const dir = loadConfig().mainProfile ?? detectMainProfile();
      if (!dir || !fs.existsSync(dir)) fail('NO_MAIN_PROFILE', 'the user\'s main Firefox profile was not found', 'Set mainProfile in config.json.');
      const b = await ctx.browser();
      const lines: string[] = [];
      const changes: { kind: string; path?: string; before?: unknown; after?: unknown }[] = [];
      // ---- extensions
      let extPlan: { e: MainExt; action: 'install' | 'update' | 'state' }[] = [];
      if (a.extensions !== false) {
        const want = Array.isArray(a.extensions) ? a.extensions.map((s) => s.toLowerCase()) : null;
        const installed = new Map<string, { version: string; active: boolean }>(Object.entries(await b.callChrome<Record<string, any>>(XS.ADDON_STATES)).map(([id, s]) => [id, { version: s.version, active: s.active }]));
        const excluded: string[] = [];
        for (const e of mainExtensions(dir!)) {
          if (want && !want.includes(e.id.toLowerCase()) && !want.some((w) => e.name.toLowerCase().includes(w))) continue;
          if (CREDENTIAL_IDS.has(e.id) || CREDENTIAL.test(e.name)) { excluded.push(e.name); continue; }
          const have = installed.get(e.id);
          if (!have) extPlan.push({ e, action: 'install' });
          else if (await b.callChrome<number>('({ a, b }) => Services.vc.compare(a, b)', { a: e.version, b: have.version }) > 0) extPlan.push({ e, action: 'update' });
          else if (have.active !== e.active) extPlan.push({ e, action: 'state' });
        }
        const n = (k: string) => extPlan.filter((p) => p.action === k).length;
        lines.push(`extensions: ${n('install')} to install, ${n('update')} to update, ${n('state')} enabled-state change(s)${excluded.length ? `; never copied (credentials/2FA): ${excluded.join(', ')}` : ''}`);
        if ((a.detail ?? 'summary') !== 'summary' || !a.apply) for (const p of extPlan) lines.push(`  ${p.action} ${p.e.name} ${p.e.version}${p.e.active ? '' : ' (disabled in your Firefox)'}`);
      }
      // ---- prefs
      let prefPlan: Record<string, string | number | boolean> = {};
      if (a.prefs) {
        const src = mainPrefs(dir!);
        const names = Object.keys(src).filter(syncablePref);
        const cur = await b.callChrome<Record<string, any>>(XS.PREFS_GET, { names });
        for (const n of names) if (!cur[n]?.exists || cur[n].value !== src[n]) prefPlan[n] = src[n];
        const skipped = Object.keys(src).length - names.length;
        lines.push(`prefs: ${Object.keys(prefPlan).length} to change (of ${names.length} copyable user-set prefs; ${skipped} skipped as machine-specific, bookkeeping or protected)`);
        if ((a.detail ?? 'summary') !== 'summary') for (const [k, v] of Object.entries(prefPlan)) lines.push(`  ${k} = ${JSON.stringify(v).slice(0, 120)}`);
        else if (!a.apply) {
          const branches = new Map<string, number>();
          for (const k of Object.keys(prefPlan)) { const br = k.split('.').slice(0, 2).join('.'); branches.set(br, (branches.get(br) ?? 0) + 1); }
          lines.push(`  by branch: ${[...branches].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(', ')} (detail:"normal" lists every pref)`);
        }
      }
      if (!a.apply) { lines.push('dry run: nothing changed. apply:true copies this (needs scope "addons" + "prefs").'); return lines.join('\n'); }
      // ---- apply
      if (extPlan.length) await ctx.requireScope('addons', b);
      if (Object.keys(prefPlan).length) await ctx.requireScope('prefs', b);
      const addonsDir = loadConfig().addonsDir;
      fs.mkdirSync(addonsDir, { recursive: true });
      const failed: string[] = [];
      for (const p of extPlan) {
        try {
          if (p.action !== 'state') {
            const staged = path.join(addonsDir, `${p.e.id}.xpi`);
            fs.copyFileSync(p.e.xpi, staged); // staged = approved: later launches keep it at the main profile's version
            await b.bidi.send('webExtension.install', { extensionData: { type: 'archivePath', path: staged }, 'moz:permanent': true }, 60000);
            changes.push({ kind: 'addon_install', path: p.e.id, after: p.e.version });
          }
          const r = await b.callChrome<{ before: boolean; after: boolean }>(XS.ADDON_SET_ENABLED, { id: p.e.id, enabled: p.e.active });
          if (r.before !== r.after || p.action === 'state') changes.push({ kind: 'addon_enabled', path: p.e.id, before: r.before, after: r.after });
        } catch (e: any) { failed.push(`${p.e.name}: ${String(e?.message ?? e).slice(0, 120)}`); }
      }
      await b.callChrome(CS_PIN);
      if (Object.keys(prefPlan).length) {
        const r = await b.callChrome<{ before: Record<string, unknown> }>(XS.PREFS_SET, { values: prefPlan });
        for (const [k, v] of Object.entries(prefPlan)) changes.push({ kind: 'pref', path: k, before: r.before[k], after: v });
      }
      await b.devtools?.updateExtensions();
      await b.versionsInfo();
      lines.push(`applied: ${extPlan.length - failed.length} extension change(s), ${Object.keys(prefPlan).length} pref(s)${failed.length ? `\nfailed: ${failed.join('; ')}` : ''}`);
      lines.push('Some prefs only take effect after a restart (ff_restart).');
      return { text: lines.join('\n'), changes };
    },
  }),
];

/** keep background updates off for newly installed add-ons */
const CS_PIN = `async () => {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  for (const a of await AddonManager.getAddonsByTypes(["extension"])) if (!a.isSystem && !a.isBuiltin && !a.hidden && a.applyBackgroundUpdates !== 0) a.applyBackgroundUpdates = 0;
}`;
