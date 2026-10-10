// external kill switches: setup/kill.ps1 and `firefox-use kill`
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, makeHome, startFixtures, startServer } from './helpers.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const kind of ['kill.ps1', 'cli'] as const) {
  describe(`kill switch: ${kind}`, () => {
    it('revokes the token, kills Firefox, server refuses afterwards', async () => {
      // no named profiles: kill.ps1 also kills any Firefox running a configured profile, which must not hit the real claude-dev
      const h = makeHome((cfg) => { cfg.profiles = {}; });
      const fx = await startFixtures();
      const c = await startServer(h.env);
      try {
        const nav = await c.call('navigate', { url: fx.url('/page2.html') });
        const st = (await c.call('ff_status', {})).text;
        assert.match(st, /pid \d+/, `navigate: ${nav.text}\nff_status: ${st}\nstderr: ${c.stderr.slice(-10).join('\n')}`);
        const pid = Number(/pid (\d+)/.exec(st)![1]);
        const launcher = /\(launcher (\d+)\)/.exec(st)?.[1];
        assert.ok(alive(pid));
        const env = { ...process.env, ...h.env };
        const out = kind === 'kill.ps1'
          ? execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'setup', 'kill.ps1')], { env, encoding: 'utf8' })
          : execFileSync(process.execPath, [path.join(ROOT, 'server', 'dist', 'cli.js'), 'kill'], { env, encoding: 'utf8' });
        assert.match(out, /token revoked/);
        assert.match(out, new RegExp(`killed Firefox (tree )?(${pid}${launcher ? `|${launcher}` : ''})`));
        assert.ok(!fs.existsSync(path.join(h.home, 'token')));
        for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200));
        assert.ok(!alive(pid), 'Firefox gone');
        const r = await c.call('navigate', { url: fx.url('/page2.html') });
        assert.ok(r.isError);
        assert.match(r.text, /TOKEN_REVOKED/);
      } finally {
        await c.close(); fx.close(); h.cleanup();
      }
    });
  });
}
