// npm run release [-- --out=<dir>] [-- --commit]: builds the release tree (default .release-build/; not release/, the name of the branch), which is what a
// marketplace install gets. The server is bundled with esbuild, dependencies included, so the tree needs no npm
// install and no build step: Claude Code copies it into its plugin cache and runs it as is.
//
// Layout (paths match a source checkout, so the proxy, plugin.json and every path the server derives from its own
// location stay the same):
//   .claude-plugin/plugin.json                       version from package.json
//   server/proxy/proxy.mjs                           the MCP entry (plugin.json), unchanged
//   server/dist/{index,cli,setupLib}.js              one bundle per entry point; tool-manifest.json; .build-stamp
//   hooks/hooks.json  server/hooks/permissions.mjs   the permission hook for batch and the privileged realm
//   companion/  setup/  skills/                      as in the checkout
//   package.json                                     "type": "module", no dependencies (so no install runs)
//   README.md  LICENSE  THIRD_PARTY_LICENSES.md      the last one lists every bundled package with its license
// No server/src: the proxy and the server treat that as a release install (dev tools unlisted, no "running from a
// copy" check).
//
// --commit puts the tree on the local `release` branch (the marketplace's plugin source, .claude-plugin/
// marketplace.json) as one commit on top of the previous release, tagged v<version>. It refuses uncommitted source
// changes and a version that isn't newer than the branch's: Claude Code only updates an installed plugin when its
// version changes, so every release bumps "version" in package.json (patch: fixes; minor: features; major: changes
// that break existing setups or tool calls). Pushing stays a manual step: git push origin release v<version>.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const OUT = path.resolve(ROOT, outArg ?? '.release-build');
if (OUT === ROOT || ROOT.startsWith(OUT + path.sep)) throw new Error(`refusing to build into ${OUT}`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const t0 = Date.now();
fs.rmSync(OUT, { recursive: true, force: true });

// ---------------------------------------------------------------- bundle
const dist = path.join(OUT, 'server', 'dist');
const result = await build({
  entryPoints: {
    index: path.join(ROOT, 'server', 'src', 'index.ts'),
    cli: path.join(ROOT, 'server', 'src', 'cli.ts'),
    setupLib: path.join(ROOT, 'server', 'src', 'setupLib.ts'),
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // bundled CommonJS packages (pngjs, ...) call require() for Node built-ins
  banner: { js: "import { createRequire as __cfCreateRequire } from 'node:module'; const require = __cfCreateRequire(import.meta.url);" },
  legalComments: 'none', // collected into THIRD_PARTY_LICENSES.md instead
  metafile: true,
  logLevel: 'warning',
});

// ---------------------------------------------------------------- files from the checkout
const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(OUT, rel), { recursive: true });
for (const rel of ['server/proxy/proxy.mjs', 'server/hooks', 'hooks', 'companion', 'skills', 'setup']) copy(rel);
for (const rel of ['README.md', 'LICENSE']) {
  if (fs.existsSync(path.join(ROOT, rel))) copy(rel);
  else console.warn(`warning: ${rel} is missing`);
}

// the source plugin.json has no version (a dev install loads in place, so it never needs one)
const { name, ...rest } = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
fs.mkdirSync(path.join(OUT, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(OUT, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: pkg.version, ...rest }, null, 2) + '\n');

// what the permission hook reads (as npm run build writes it for a source checkout)
fs.writeFileSync(path.join(dist, 'tool-manifest.json'), execFileSync(process.execPath, [path.join(dist, 'index.js'), '--tool-manifest'], { encoding: 'utf8', windowsHide: true }));

fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  private: true,
  type: 'module',
  license: pkg.license,
  engines: pkg.engines,
  bin: pkg.bin,
}, null, 2) + '\n');

// ---------------------------------------------------------------- third-party licenses
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input);
  if (!m || packages.has(m[1])) continue;
  const dir = path.resolve(ROOT, m[1]);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  packages.set(m[1], { name: meta.name, version: meta.version, license: meta.license ?? 'see text', text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : null });
}
const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const missing = sorted.filter((p) => !p.text).map((p) => p.name);
fs.writeFileSync(path.join(OUT, 'THIRD_PARTY_LICENSES.md'), [
  '# Third-party licenses',
  '',
  `server/dist/ bundles these packages (${sorted.length}). Their licenses follow.`,
  '',
  ...sorted.map((p) => `- ${p.name} ${p.version} (${p.license})`),
  '',
  ...sorted.flatMap((p) => [`## ${p.name} ${p.version}`, '', p.text ? '```\n' + p.text + '\n```' : `License: ${p.license} (no license file in the package)`, '']),
].join('\n'));

// ---------------------------------------------------------------- build stamp (the proxy reports it in ff_dev_status)
const h = crypto.createHash('sha256');
for (const f of fs.readdirSync(dist).filter((f) => f.endsWith('.js')).sort()) { h.update(f); h.update(fs.readFileSync(path.join(dist, f))); }
fs.writeFileSync(path.join(dist, '.build-stamp'), JSON.stringify({ hash: h.digest('hex').slice(0, 12), builtAt: new Date().toISOString(), release: pkg.version }));

// ---------------------------------------------------------------- summary
const size = (f) => `${(fs.statSync(path.join(dist, f)).size / 1024 / 1024).toFixed(2)} MB`;
console.log(`release ${pkg.version} -> ${path.relative(ROOT, OUT) || OUT} in ${Date.now() - t0} ms`);
console.log(`  bundles: ${['index.js', 'cli.js', 'setupLib.js'].map((f) => `${f} ${size(f)}`).join(', ')}`);
console.log(`  bundled packages: ${sorted.length}${missing.length ? ` (no license file: ${missing.join(', ')})` : ''}`);

// ---------------------------------------------------------------- --commit: the release branch
if (process.argv.includes('--commit')) commitRelease();

function commitRelease() {
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...opts }).trim();
  if (git(['status', '--porcelain'])) throw new Error('commit or stash your changes first: a release is built from committed source');
  const source = git(['rev-parse', '--short=12', 'HEAD']);
  let parent = null;
  try { parent = git(['rev-parse', '--verify', '-q', 'refs/heads/release'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* first release */ }
  const prev = parent ? JSON.parse(git(['show', `${parent}:.claude-plugin/plugin.json`])).version : null;
  if (prev && !newer(pkg.version, prev)) throw new Error(`version ${pkg.version} is not newer than the release branch's ${prev}: bump "version" in package.json`);
  // a temporary index holding exactly the release tree, committed without touching the checkout
  const index = path.join(os.tmpdir(), `firefox-use-release-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const gitDir = git(['rev-parse', '--absolute-git-dir']);
    execFileSync('git', [`--git-dir=${gitDir}`, `--work-tree=${OUT}`, 'add', '-A', '-f', '.'], { cwd: OUT, env, windowsHide: true });
    const tree = execFileSync('git', [`--git-dir=${gitDir}`, 'write-tree'], { cwd: OUT, env, encoding: 'utf8', windowsHide: true }).trim();
    if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) throw new Error('the release tree is the same as the last release');
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Release ${pkg.version} (source ${source})`]);
    git(['update-ref', 'refs/heads/release', commit, ...(parent ? [parent] : [])]);
    git(['tag', `v${pkg.version}`, commit]);
    console.log(`release branch -> ${commit.slice(0, 12)}, tagged v${pkg.version}${prev ? ` (previous ${prev})` : ' (first release)'}`);
    console.log(`  publish: git push origin release v${pkg.version}`);
  } finally { fs.rmSync(index, { force: true }); }
}

/** a > b for x.y.z versions (pre-release suffixes ignored) */
function newer(a, b) {
  const p = (v) => v.split('-')[0].split('.').map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
