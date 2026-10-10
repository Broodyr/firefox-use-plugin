#!/usr/bin/env node
// firefox-use CLI. `firefox-use kill [--no-restore]` is the command-line kill switch.
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR, TOKEN_FILE, ensureDir, loadConfig, setupCommand } from './config.js';
import { firefoxAlive, killFirefox } from './browser/launcher.js';

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'kill') {
  try { fs.unlinkSync(TOKEN_FILE); console.log('token revoked'); } catch { console.log('token already revoked'); }
  fs.writeFileSync(path.join(ensureDir(RUN_DIR), 'killed.json'), JSON.stringify({ at: new Date().toISOString(), restore: !rest.includes('--no-restore'), by: 'cli' }));
  const dir = loadConfig().runDir;
  let n = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.json') || f === 'killed.json') continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s.personal) continue; // personal mode: the user's own Firefox is never killed
      if (typeof s.pid === 'number' && typeof s.bidiPort === 'number' && firefoxAlive(s)) { killFirefox(s); n++; console.log(`killed Firefox ${s.browserPid ?? s.pid} (${s.key})`); }
      if (typeof s.bidiPort === 'number') fs.unlinkSync(path.join(dir, f));
    } catch { /* not a run state */ }
  }
  if (!n) console.log('no firefox-use Firefox running');
  console.log(`Re-enable with: ${setupCommand('setup.ps1', '-TokenOnly')}`);
} else {
  console.log('usage: firefox-use kill [--no-restore]');
  process.exit(cmd ? 1 : 0);
}
