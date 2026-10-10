// npm run test:core | test:slow | test:integration — the integration suite split in two, files in parallel.
//   node dev/harness/run-tests.mjs [core|slow|all] [--concurrency=N] [--server-root=.release-build] [name ...]
// core: the fast files (every tool family at least once); slow: the long scenarios (bisect, acceptance-full, drift,
// login, memory, pins, regress, snapshots, uBO, debugger). Names filter files by substring (e.g. "userscripts").
// Each file is isolated (own FIREFOX_USE_HOME, workspace, throwaway Firefox), so files run in parallel; the
// throwaway profiles are copies of a clean template built once (tests/helpers.ts; CF_TEST_FROM_CLAUDE_DEV=1 copies
// claude-dev instead).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, preflight } from './env.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests');
const SLOW = new Set(['bisect', 'acceptance-full', 'drift', 'login', 'memory', 'pins', 'regress', 'snapshots', 'ubo', 'debugger', 'window', 'stuck']);
const args = process.argv.slice(2);
const set = ['core', 'slow', 'all'].includes(args[0]) ? args.shift() : 'all';
const conc = Number(args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? process.env.CF_TEST_CONCURRENCY ?? 4);
// --server-root=.release-build: spawn the server and proxy from a release tree (npm run release) instead of the repo
const serverRoot = args.find((a) => a.startsWith('--server-root='))?.split('=')[1];
if (serverRoot) process.env.CF_TEST_SERVER_ROOT = serverRoot;
// what's missing on this machine, with how to get it (no claude-dev needed unless CF_TEST_FROM_CLAUDE_DEV=1)
const fromDev = !!process.env.CF_TEST_FROM_CLAUDE_DEV;
if (!preflight({ serverRoot: serverRoot ? path.resolve(ROOT, serverRoot) : ROOT, addons: !fromDev, claudeDev: fromDev })) process.exit(1);
const names = args.filter((a) => !a.startsWith('--'));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => f.slice(0, -'.test.ts'.length))
  .filter((f) => set === 'all' || (set === 'slow') === SLOW.has(f))
  .filter((f) => !names.length || names.some((n) => f.includes(n)))
  .map((f) => path.join('dev', 'harness', 'tests', `${f}.test.ts`));
if (!files.length) { console.error(`no test files match ${set} ${names.join(' ')}`); process.exit(1); }
console.log(`${set}: ${files.length} file(s), concurrency ${conc}${serverRoot ? `, server from ${serverRoot}/` : ''}`);
const r = spawnSync(process.execPath, ['--test', `--test-concurrency=${conc}`, '--test-timeout=120000', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
