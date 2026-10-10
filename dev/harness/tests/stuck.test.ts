// A launch stuck on a startup dialog that headless mode hides (here: the downgrade warning for a profile last used
// by a "newer" Firefox; on the user's machine it was an AutoConfig alert) fails fast with LAUNCH_STUCK and a hint,
// instead of waiting 45 s for BiDi.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ROOT, makeHome, startServer } from './helpers.ts';

describe('stuck launch', () => {
  const h = makeHome((cfg, home) => {
    const dir = path.join(home, 'profiles', 'stuck');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'user.js'), fs.readFileSync(path.join(ROOT, 'setup', 'user.js'), 'utf8').replaceAll('%SANDBOX%', path.join(os.tmpdir(), 'cf-test-sandbox').replaceAll('\\', '\\\\')));
    fs.writeFileSync(path.join(dir, 'compatibility.ini'), '[Compatibility]\nLastVersion=999.0_20990101000000/20990101000000\n');
    cfg.profiles = { stuck: dir };
  }, false);
  after(() => h.cleanup());

  it('fails with LAUNCH_STUCK well before the 45 s timeout and names the cause', async () => {
    const c = await startServer({ ...h.env, FIREFOX_USE_NO_COLD: '1' }, ['--profile=stuck', '--profile-mode=named', '--headless']);
    try {
      const t0 = Date.now();
      const r = await c.call('ff_launch', {});
      const ms = Date.now() - t0;
      assert.match(r.text, /LAUNCH_STUCK/, r.text);
      assert.match(r.text, /startup dialog/);
      assert.ok(ms < 30000, `took ${ms} ms`);
    } finally { await c.close(); }
  });
});
