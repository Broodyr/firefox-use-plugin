// npm run test:personal: the parity suites (page, input, parity) against personal mode,
// plus personal.test.ts. Each file runs on a plain throwaway profile set up like personal-mode.ps1 does;
// its claude-dev-mode steps use the test template like the other suites, so no claude-dev is needed.
import { spawnSync } from 'node:child_process';
import { preflight } from './env.mjs';

if (!preflight({ what: 'the personal-mode suites' })) process.exit(1);

const files = ['page', 'input', 'parity', 'personal'].map((f) => `dev/harness/tests/${f}.test.ts`);
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', ...files], {
  stdio: 'inherit', env: { ...process.env, CF_TEST_PERSONAL: '1' },
});
process.exit(r.status ?? 1);
