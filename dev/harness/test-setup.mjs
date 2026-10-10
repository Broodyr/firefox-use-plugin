// npm run test:setup [-- --latest]: puts the uBlock Origin and Violentmonkey that the test profiles need into
// dev/harness/.test-addons/ (git-ignored), each pinned in test-addons.json by version and SHA-256 (AMO's own hash
// for that file). A local copy with the same hash is used when there is one (the add-ons setup.ps1 staged from the
// user's Firefox); otherwise the pinned file is downloaded from addons.mozilla.org and checked against the pin.
// --latest first moves the pins to AMO's current versions (then commit test-addons.json).
// A contributor runs this; the plugin itself never downloads add-ons.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DEV_HELP, PINS, TEST_ADDONS_DIR, claudeDevProfile, coreAddons, preflight, realConfig } from './env.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PINS_FILE = path.join(import.meta.dirname, 'test-addons.json');

if (process.argv.includes('--latest')) {
  for (const a of PINS.addons) {
    const r = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${a.slug}/`);
    if (!r.ok) throw new Error(`AMO: ${a.slug}: HTTP ${r.status}`);
    const v = (await r.json()).current_version;
    if (!v?.file?.hash?.startsWith('sha256:')) throw new Error(`AMO: ${a.slug}: no sha256 for ${v?.version}`);
    if (v.version !== a.version) console.log(`${a.name}: pin ${a.version} -> ${v.version}`);
    Object.assign(a, { version: v.version, url: v.file.url, sha256: v.file.hash.slice('sha256:'.length) });
  }
  fs.writeFileSync(PINS_FILE, JSON.stringify(PINS, null, 2) + '\n');
}

fs.mkdirSync(TEST_ADDONS_DIR, { recursive: true });
for (const a of PINS.addons) {
  const dest = path.join(TEST_ADDONS_DIR, `${a.id}.xpi`);
  const label = `${a.name} ${a.version}`;
  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === a.sha256) { console.log(`${label}: already there`); continue; }
  // a local copy of exactly this file (same hash) saves the download
  const local = [process.env.FIREFOX_USE_TEST_ADDONS, realConfig().addonsDir].filter(Boolean).map((d) => path.join(d, `${a.id}.xpi`))
    .find((f) => fs.existsSync(f) && sha256(fs.readFileSync(f)) === a.sha256);
  if (local) { fs.copyFileSync(local, dest); console.log(`${label}: copied from ${local}`); continue; }
  console.log(`${label}: downloading ${a.url}`);
  const r = await fetch(a.url);
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status} from ${a.url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = sha256(buf);
  if (got !== a.sha256) throw new Error(`${label}: SHA-256 ${got} doesn't match the pin ${a.sha256}; not saved`);
  fs.writeFileSync(dest, buf);
  console.log(`${label}: saved (${(buf.length / 1024 / 1024).toFixed(1)} MB, hash checked)`);
}

const src = coreAddons();
console.log(`\nTest profiles will use the add-ons ${src?.from ?? '(none found)'}${src ? ` (${src.dir})` : ''}.`);
if (preflight()) console.log('Ready: npm run test:core (fast), npm run test:integration (all).');
if (!claudeDevProfile()) console.log(`\nnpm run test:live is the one check that needs your real claude-dev profile: ${CLAUDE_DEV_HELP}`);
