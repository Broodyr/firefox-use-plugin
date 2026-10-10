// companion extension: a temporary MV3 add-on (companion/) installed over BiDi at every launch, with
// the optional userScripts permission granted from privileged code (no prompt). It runs fast-mode
// userscripts with GM_* stubs; the server drives it by evaluating cf.* in its background.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.js';
import { fail } from '../errors.js';
import { extCall, resolveExtension, type ExtRef } from '../browser/realms.js';
import type { Browser } from '../browser/session.js';

export const COMPANION_ID = 'companion@firefox-use';
export const COMPANION_DIR = path.join(REPO_ROOT, 'companion');

const GRANT = `async ({ id }) => {
  const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
  const pol = WebExtensionPolicy.getByID(id);
  if (!pol) throw new Error("companion not running");
  const have = await ExtensionPermissions.get(id);
  if (!have.permissions.includes("userScripts")) await ExtensionPermissions.add(id, { permissions: ["userScripts"], origins: [] }, pol.extension);
  return (await ExtensionPermissions.get(id)).permissions;
}`;

/** Install (if missing) and arm the companion; returns a launch note when something was done. */
export async function ensureCompanion(b: Browser): Promise<string | null> {
  const running = await b.callChrome<string | null>(`({ id }) => WebExtensionPolicy.getByID(id)?.extension?.version ?? null`, { id: COMPANION_ID });
  const want = JSON.parse(fs.readFileSync(path.join(COMPANION_DIR, 'manifest.json'), 'utf8')).version;
  let note: string | null = null;
  if (running !== want) {
    if (running) await b.callChrome(`async ({ id }) => { const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"); const a = await AddonManager.getAddonByID(id); if (a && a.temporarilyInstalled) await a.uninstall(); }`, { id: COMPANION_ID });
    await b.bidi.send('webExtension.install', { extensionData: { type: 'path', path: COMPANION_DIR } }, 60000);
    note = `companion ${want} installed (temporary add-on, userScripts granted)`;
  }
  await b.callChrome(GRANT, { id: COMPANION_ID });
  await b.devtools?.updateExtensions();
  const r = await compCall<{ ok: boolean; error?: string }>(b, 'return await cf.init();');
  if (!r.ok) fail('COMPANION_ERROR', `companion could not enable userScripts messaging: ${r.error}`);
  return note;
}

let ref: ExtRef | null = null;

/** Run a function body in the companion's background (cf.* is its API). */
export async function compCall<T = any>(b: Browser, body: string, timeoutMs = 30000): Promise<T> {
  if (!ref || !(await b.callChrome<boolean>(`({ id }) => !!WebExtensionPolicy.getByID(id)`, { id: COMPANION_ID }))) {
    ref = await resolveExtension(b, COMPANION_ID).catch(() => null);
    if (!ref) fail('COMPANION_MISSING', 'the companion extension is not installed', 'It is installed at launch; ff_restart, or any us_install with mode "fast", installs it.');
  }
  return extCall<T>(b, ref!, body, timeoutMs);
}

export async function companionVersion(b: Browser): Promise<string | null> {
  return b.callChrome<string | null>(`({ id }) => WebExtensionPolicy.getByID(id)?.extension?.version ?? null`, { id: COMPANION_ID });
}
