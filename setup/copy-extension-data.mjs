// User-run (like setup.ps1): copy your extensions' own data (settings, storage) from your main Firefox profile into
// claude-dev, so profile_sync's extensions come with your configuration. Your main profile is only read.
//
//   1. Close your Firefox AND claude-dev's (ff_quit, or wait until no firefox-use Firefox runs).
//   2. node setup/copy-extension-data.mjs            (add --dry-run to only list what would be copied)
//   3. Reopen your Firefox. Then ask Claude for `profile_sync apply` (installs the extensions themselves).
//
// What it does: a cold snapshot of claude-dev first (restore it with restore(<id>) to undo); copies each extension's
// storage folders (storage/default/moz-extension+++<uuid>*) and browser-extension-data/<id>; gives claude-dev the
// same internal UUIDs (so the extensions find their data) and the same "storage migrated" markers (so Firefox
// doesn't re-run its migration over the copied data). Password managers and authenticators are skipped.
// Note: extension data can include login tokens for the services those extensions talk to.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const { loadConfig, detectMainProfile, takeColdCopy } = await import(pathToFileURL(path.join(ROOT, 'server/dist/setupLib.js')).href);
const dry = process.argv.includes('--dry-run');

const cfg = loadConfig();
const MAIN = cfg.mainProfile ?? detectMainProfile();
const DEV = cfg.profiles['claude-dev'];
if (!MAIN || !DEV) { console.error('main profile or claude-dev not found (run setup.ps1 first)'); process.exit(1); }
const running = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='firefox.exe'").Count`], { encoding: 'utf8' }).trim();
if (Number(running) > 0) { console.error(`Firefox is running (${running} process(es)): close every Firefox first, including claude-dev's.`); process.exit(1); }

const CREDENTIAL = /pass(word|wort)?\b|bitwarden|1password|lastpass|keepass|dashlane|nordpass|enpass|roboform|keeper|authenticat|\b2fa\b|two.?factor|\botp\b|totp|yubi|vault/i;
const CREDENTIAL_IDS = new Set(['{446900e4-71c2-419f-a6a7-df9c091e268b}', 'admin@2fas.com']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const prefLine = (text, name) => new RegExp(`^user_pref\\("${esc(name)}",\\s*(.+)\\);\\s*$`, 'm').exec(text);

const mainPrefs = fs.readFileSync(path.join(MAIN, 'prefs.js'), 'utf8');
let devPrefs = fs.readFileSync(path.join(DEV, 'prefs.js'), 'utf8');
const mainUuids = JSON.parse(JSON.parse(prefLine(mainPrefs, 'extensions.webextensions.uuids')?.[1] ?? '"{}"'));
const devUuids = JSON.parse(JSON.parse(prefLine(devPrefs, 'extensions.webextensions.uuids')?.[1] ?? '"{}"'));
const db = JSON.parse(fs.readFileSync(path.join(MAIN, 'extensions.json'), 'utf8'));
const exts = db.addons.filter((a) => a.type === 'extension' && a.location === 'app-profile' && a.signedState < 3 && mainUuids[a.id]
  && !CREDENTIAL_IDS.has(a.id) && !CREDENTIAL.test(a.defaultLocale?.name ?? ''));
const storageRoot = path.join(MAIN, 'storage', 'default');
const mainDirs = fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot).filter((d) => d.startsWith('moz-extension+++')) : [];
const size = (p) => { let n = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) n += e.isDirectory() ? size(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size; return n; };

if (dry) {
  for (const a of exts) {
    const ds = mainDirs.filter((x) => x === `moz-extension+++${mainUuids[a.id]}` || x.startsWith(`moz-extension+++${mainUuids[a.id]}^`));
    const mb = ds.reduce((n, d) => n + size(path.join(storageRoot, d)), 0) / 1048576;
    console.log(`${a.defaultLocale?.name ?? a.id}: ${ds.length} folder(s), ${mb.toFixed(1)} MB${fs.existsSync(path.join(MAIN, 'browser-extension-data', a.id)) ? ' + browser-extension-data' : ''}`);
  }
  process.exit(0);
}

const snap = takeColdCopy('claude-dev', DEV, 'manual: before copying extension data from the main profile', false);
console.log(`claude-dev snapshot: ${snap.id} (undo: ask Claude to restore it)`);
fs.mkdirSync(path.join(DEV, 'storage', 'default'), { recursive: true });
fs.mkdirSync(path.join(DEV, 'browser-extension-data'), { recursive: true });
let folders = 0, bytes = 0;
const migrated = [];
for (const a of exts) {
  const uuid = mainUuids[a.id];
  for (const d of mainDirs.filter((x) => x === `moz-extension+++${uuid}` || x.startsWith(`moz-extension+++${uuid}^`))) {
    const dst = path.join(DEV, 'storage', 'default', d);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(path.join(storageRoot, d), dst, { recursive: true });
    folders++; bytes += size(dst);
  }
  const bed = path.join(MAIN, 'browser-extension-data', a.id);
  if (fs.existsSync(bed)) { const dst = path.join(DEV, 'browser-extension-data', a.id); fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(bed, dst, { recursive: true }); folders++; }
  devUuids[a.id] = uuid;
  const m = prefLine(mainPrefs, `extensions.webextensions.ExtensionStorageIDB.migrated.${a.id}`);
  if (m) migrated.push([a.id, m[1]]);
}
const setPref = (name, raw) => {
  const line = `user_pref("${name}", ${raw});`;
  const m = prefLine(devPrefs, name);
  devPrefs = m ? devPrefs.replace(m[0], line) : `${devPrefs.trimEnd()}\n${line}\n`;
};
setPref('extensions.webextensions.uuids', JSON.stringify(JSON.stringify(devUuids)));
for (const [id, v] of migrated) setPref(`extensions.webextensions.ExtensionStorageIDB.migrated.${id}`, v);
fs.writeFileSync(path.join(DEV, 'prefs.js'), devPrefs);
console.log(`copied data of ${exts.length} extension(s): ${folders} folder(s), ${(bytes / 1048576).toFixed(1)} MB. You can reopen Firefox now.`);
