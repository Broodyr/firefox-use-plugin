// Scratch experiment runner (not part of the suite): node dev/harness/exp.ts <file.mjs>
import { pathToFileURL } from 'node:url';
// The file default-exports async (c, fx) => {...}; c is an McpClient on a throwaway headless profile.
import { makeHome, startFixtures, startServer } from './tests/helpers.ts';
const h = makeHome();
const fx = await startFixtures();
const c = await startServer(h.env, process.argv.includes('--headed') ? [] : []);
try {
  const mod = await import(pathToFileURL(process.argv[2]).href);
  await mod.default(c, fx, h);
} catch (e) { console.error('EXP ERROR', e); }
finally {
  if (process.env.EXP_STDERR) console.error(c.stderr.join('\n'));
  await c.close(); fx.close(); h.cleanup();
}
