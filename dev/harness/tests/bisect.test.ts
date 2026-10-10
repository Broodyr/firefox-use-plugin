// bisect: three userscripts from a test's setup, one of which breaks the page; delta debugging in throwaway
// probes finds it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startFixtures, startServer } from './helpers.ts';

describe('bisect', () => {
  let c: McpClient, fx: Awaited<ReturnType<typeof startFixtures>>, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(); fx = await startFixtures(); c = await startServer(h.env); });
  after(async () => { await c.close(); fx.close(); h.cleanup(); });

  it('finds the userscript that breaks the page', async () => {
    const port = new URL(fx.url('/')).port;
    const us = (name: string, body: string) => `// ==UserScript==\n// @name        ${name}\n// @namespace   cf-test\n// @match       http://127.0.0.1:${port}/*\n// @grant       none\n// @inject-into content\n// ==/UserScript==\n${body}\n`;
    fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(h.workspace, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'a.user.js'), us('bs-a', "document.documentElement.dataset.a = '1';"));
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'b.user.js'), us('bs-b', "document.querySelector('h1').remove();"));
    fs.writeFileSync(path.join(h.workspace, 'scripts', 'c.user.js'), us('bs-c', "document.documentElement.dataset.c = '1';"));
    fs.writeFileSync(path.join(h.workspace, 'tests', 'heading.test.json'), JSON.stringify({
      name: 'heading',
      setup: { userscripts: ['scripts/a.user.js', 'scripts/b.user.js', 'scripts/c.user.js'] },
      cases: [{ url: fx.url('/page2.html'), steps: [{ eval: 'new Promise((r) => setTimeout(r, 400))' }], assert: [{ selector: 'h1', state: 'present' }] }],
    }));
    let r = await c.call('test_run', { names: ['heading'], live: true }, 300000);
    assert.match(r.text, /^0\/1 test file\(s\) passed/, r.text);
    r = await c.call('bisect', { test: 'heading', dimensions: { userscripts: true }, live: true }, 900000);
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^minimal failing set: userscript bs-b \(scripts\/b\.user\.js\)\n/, r.text);
    assert.match(r.text, /all 3 item\(s\) on: FAILS/);
    assert.match(r.text, /all items off: passes/);
  });
});
