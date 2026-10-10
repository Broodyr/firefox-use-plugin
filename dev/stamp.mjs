// After a successful build: writes server/dist/tool-manifest.json (read by the permission hook, server/hooks/) and
// then server/dist/.build-stamp, which the hot-reload proxy watches.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const dist = path.resolve(import.meta.dirname, '..', 'server', 'dist');
fs.writeFileSync(path.join(dist, 'tool-manifest.json'), execFileSync(process.execPath, [path.join(dist, 'index.js'), '--tool-manifest'], { encoding: 'utf8', windowsHide: true }));
const h = crypto.createHash('sha256');
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) { h.update(e.name); h.update(fs.readFileSync(p)); }
} };
walk(dist);
const stamp = { hash: h.digest('hex').slice(0, 12), builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(dist, '.build-stamp'), JSON.stringify(stamp));
console.log('build stamp', stamp.hash);
