// "Drift from the main profile and duplicate scripts", on two named test profiles: test-named stands in
// for claude-dev, test-main for the user's main profile (config mainProfile). Same-script check (a fast-mode dev copy
// disables the installed copy and gives it back on uninstall / ff_quit / the launch after a kill), the read-only drift
// report at launch, us_sync_main (diff, apply with values, refused for a workspace-linked script); the main profile's
// files never change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, ROOT, makeHome, startFixtures } from './helpers.ts';

/** Every file under dir -> size:mtime (to prove a profile was not written). */
function listing(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out.set(path.relative(dir, p), `${s.size}:${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out;
}

describe('userscript drift and duplicates', () => {
  let h: ReturnType<typeof makeHome>, fx: Awaited<ReturnType<typeof startFixtures>>;
  let dev: McpClient, main: McpClient | null = null;
  let mainDir = '', port = '';
  const env = () => ({ ...h.env, FIREFOX_USE_NO_COLD: '1' });
  const server = async (profile: string) => { const c = McpClient.spawnServer([`--profile=${profile}`, '--profile-mode=named', '--headless'], env()); await c.initialize(); return c; };
  const script = (name: string, ns: string, ver: string, body: string) =>
    `// ==UserScript==\n// @name        ${name}\n// @namespace   ${ns}\n// @version     ${ver}\n// @match       http://127.0.0.1:${port}/*\n// @grant       none\n// ==/UserScript==\n${body}\n`;
  const canvas = (ns: string, ver: string) => script('Canvas', ns, ver, `const d = document.documentElement.dataset; d.canvas = String((+d.canvas || 0) + 1); d.canvasV = '${ver}';`);
  /** install straight into Violentmonkey, as a user's own script (not linked to the workspace) */
  const vmInstall = async (c: McpClient, code: string, values?: Record<string, string>) => {
    const r = await c.call('ext_message', { extension: 'vm', message: { cmd: 'ParseScript', data: { code } } });
    assert.ok(!r.isError, r.text);
    const id = Number(/"id":\s*(\d+)/.exec(r.text)?.[1]);
    assert.ok(id > 0, r.text);
    if (values) {
      const enc = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, 's' + v]));
      const s = await c.call('ext_message', { extension: 'vm', message: { cmd: 'SetValueStores', data: { [id]: enc } } });
      assert.ok(!s.isError, s.text);
    }
    return id;
  };
  const page = async () => {
    await dev.call('navigate', { url: fx.url('/page2.html') });
    await dev.call('wait_for', { expr: 'document.documentElement.dataset.canvasV', timeout_ms: 5000 });
    await new Promise((r) => setTimeout(r, 400)); // a second copy, if any, runs too
    return (await dev.call('eval', { code: 'document.documentElement.dataset.canvas + "/" + document.documentElement.dataset.canvasV' })).text;
  };
  const write = (f: string, code: string) => { fs.mkdirSync(path.join(h.workspace, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(h.workspace, 'scripts', f), code); };

  before(async () => {
    h = makeHome((cfg, home) => {
      cfg.profiles = {};
      for (const p of ['test-named', 'test-main']) {
        const dir = path.join(home, 'profiles', p);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'user.js'), fs.readFileSync(path.join(ROOT, 'setup', 'user.js'), 'utf8').replaceAll('%SANDBOX%', path.join(home, 'sandbox').replaceAll('\\', '\\\\')));
        cfg.profiles[p] = dir;
      }
      mainDir = cfg.profiles['test-main'];
      cfg.mainProfile = mainDir;
      cfg.driftReport = true;
    });
    fx = await startFixtures();
    port = new URL(fx.url('/')).port;
  });
  after(async () => { await dev?.close(); await main?.close(); fx.close(); h.cleanup(); });

  it('same-script check: a fast-mode dev copy disables the installed copy until it is uninstalled', async () => {
    dev = await server('test-named');
    let r = await dev.call('ff_launch', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /note: userscript drift vs the main profile: could not read it \(.*no internal UUID/, 'test-main has not run yet');
    r = await dev.call('scope_set', { description: 'Violentmonkey scripts in test-named', areas: ['ext:vm'], user_said: 'yes' });
    assert.ok(!r.isError, r.text);
    const orig = await vmInstall(dev, canvas('orig', '1.2'));
    assert.match(await page(), /"1\/1\.2"/);
    write('canvas.user.js', canvas('dev', '1.3-dev'));
    await dev.call('scope_clear', {});
    r = await dev.call('us_install', { path: 'scripts/canvas.user.js', mode: 'fast' });
    assert.match(r.text, new RegExp(`SHADOWED_SCRIPT[\\s\\S]*Violentmonkey #${orig} "Canvas" 1\\.2 \\(namespace orig\\)[\\s\\S]*shadow:"keep"`), r.text);
    r = await dev.call('scope_set', { description: 'Violentmonkey scripts in test-named', areas: ['ext:vm'], user_said: 'yes' });
    r = await dev.call('us_install', { path: 'scripts/canvas.user.js', mode: 'fast' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, new RegExp(`disabled Violentmonkey #${orig} "Canvas" 1\\.2 .*same script`));
    assert.match(await page(), /"1\/1\.3-dev"/, 'one instance: the dev copy');
    r = await dev.call('us_list', {});
    assert.match(r.text, new RegExp(`#${orig} Canvas 1\\.2 \\[disabled: shadowed by scripts/canvas\\.user\\.js \\(fast cf-`));
    r = await dev.call('ff_status', {});
    assert.match(r.text, /disabled while a dev copy is installed: #\d+ "Canvas" 1\.2/);
    r = await dev.call('us_uninstall', { script: 'scripts/canvas.user.js' });
    assert.match(r.text, new RegExp(`re-enabled Violentmonkey #${orig} "Canvas" 1\\.2 \\(its dev copy scripts/canvas\\.user\\.js was uninstalled\\)`));
    assert.match(await page(), /"1\/1\.2"/);
    // shadow "keep": both run, with a warning
    r = await dev.call('us_install', { path: 'scripts/canvas.user.js', mode: 'fast', shadow: 'keep' });
    assert.match(r.text, /WARNING: Violentmonkey #\d+ "Canvas" 1\.2 .*runs alongside this dev copy/);
    assert.match(await page(), /"2\//);
    await dev.call('us_uninstall', { script: 'scripts/canvas.user.js' });
  });

  it('shadowed copies come back after ff_quit and after a kill; manager mode names the version it replaces', async () => {
    let r = await dev.call('us_install', { path: 'scripts/canvas.user.js', mode: 'fast' });
    assert.match(r.text, /disabled Violentmonkey/);
    r = await dev.call('ff_quit', {});
    assert.match(r.text, /Firefox quit\.\nre-enabled Violentmonkey #\d+ "Canvas" 1\.2 \(its fast-mode dev copy ends with this Firefox\)/);
    await dev.call('ff_launch', {});
    await dev.call('scope_set', { description: 'Violentmonkey scripts in test-named', areas: ['ext:vm'], user_said: 'yes' });
    r = await dev.call('us_install', { path: 'scripts/canvas.user.js', mode: 'fast' });
    assert.match(r.text, /disabled Violentmonkey/);
    await dev.call('ff_kill', { no_restore: true });
    await dev.close();
    fs.writeFileSync(path.join(h.home, 'token'), 'test-token-again');
    dev = await server('test-named');
    r = await dev.call('ff_launch', {});
    assert.match(r.text, /note: re-enabled Violentmonkey #\d+ "Canvas" 1\.2 \(its dev copy is gone after the restart\)/, r.text);
    await dev.call('scope_set', { description: 'Violentmonkey scripts in test-named', areas: ['ext:vm'], user_said: 'yes' });
    // manager mode, same name + namespace: Violentmonkey updates it in place
    write('canvas-orig.user.js', canvas('orig', '1.3'));
    r = await dev.call('us_install', { path: 'scripts/canvas-orig.user.js' });
    assert.match(r.text, /replaced 1\.2 → 1\.3 of Violentmonkey script #\d+/, r.text);
    assert.match(await page(), /"1\/1\.3"/);
    await dev.call('us_uninstall', { script: 'scripts/canvas-orig.user.js' });
  });

  it('the "main" profile gets its scripts (its own Firefox)', async () => {
    main = await server('test-main');
    let r = await main.call('ff_launch', {});
    assert.ok(!r.isError, r.text);
    assert.doesNotMatch(r.text, /drift/, 'no report against itself');
    r = await main.call('scope_set', { description: 'Violentmonkey scripts in test-main', areas: ['ext:vm'], user_said: 'yes' });
    assert.ok(!r.isError, r.text);
    await vmInstall(main, script('Alpha', 't', '1.3', 'window.alpha = 3;'), { k: 'main' });
    await vmInstall(main, script('Beta', 't', '1.0', 'window.beta = "main";'));
    await vmInstall(main, script('Gamma', 't', '2.0', 'window.gamma = 1;'));
    await vmInstall(main, script('Delta', 't', '1.0', 'window.delta = 1;'));
  });

  it('drift report at launch (main profile running, read from a copy) and the main column in us_list', async () => {
    await vmInstall(dev, script('Alpha', 't', '1.2', 'window.alpha = 2;'), { k: 'dev' });
    await vmInstall(dev, script('Beta', 't', '1.0', 'window.beta = "dev";'));
    await vmInstall(dev, script('Delta', 't', '1.0', 'window.delta = 1;'));
    await vmInstall(dev, script('Epsilon', 't', '1.0', 'window.eps = 1;'));
    await dev.call('ff_quit', {});
    const r = await dev.call('ff_launch', {});
    assert.match(r.text, /note: userscript drift vs the main profile \(read-only\): 3 differ: "Alpha": 1\.2 here \(#\d+\), 1\.3 in the main profile; "Beta" 1\.0 \(#\d+\): same version, different code; "Gamma" 2\.0: only in the main profile\. \d+ only in claude-dev/, r.text);
    let s = await dev.call('ff_status', {});
    assert.match(s.text, /userscript drift vs the main profile/);
    s = await dev.call('us_list', {});
    assert.match(s.text, /Alpha 1\.2 \(main: 1\.3\)/);
    assert.match(s.text, /Delta 1\.0 \(main: 1\.0\)/);
    assert.match(s.text, /Epsilon 1\.0 \(main: -\)/);
  });

  it('us_sync_main: diff, apply with values, refused for a workspace-linked script; the main profile is never written', async () => {
    await main!.call('ff_quit', {});
    await main!.close();
    main = null;
    const before = listing(mainDir);
    await dev.call('scope_set', { description: 'Violentmonkey scripts in test-named', areas: ['ext:vm'], user_said: 'yes' });
    let r = await dev.call('us_sync_main', { script: 'Alpha' });
    assert.match(r.text, /claude-dev #\d+ 1\.2 -> main profile #\d+ 1\.3 \("Alpha"\)/);
    assert.match(r.text, /- \/\/ @version {5}1\.2\n\+ \/\/ @version {5}1\.3/);
    assert.match(r.text, /- window\.alpha = 2;\n\+ window\.alpha = 3;/);
    r = await dev.call('us_sync_main', { script: 'Alpha', apply: true, values: true });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /updated Violentmonkey #\d+ "Alpha" 1\.2 -> 1\.3 from the main profile/);
    assert.match(r.text, /GM values: 1 from the main profile \(replaced 1\)/);
    r = await dev.call('us_values', { script: 'Alpha' });
    assert.match(r.text, /k = "main"/);
    r = await dev.call('us_sync_main', {});
    assert.match(r.text, /2 differ/);
    assert.doesNotMatch(r.text, /"Alpha"/);
    // a script in development here (linked to a workspace file) is never overwritten
    write('beta.user.js', script('Beta', 't', '1.1', 'window.beta = "wip";'));
    r = await dev.call('us_install', { path: 'scripts/beta.user.js' });
    assert.match(r.text, /replaced 1\.0 → 1\.1/);
    r = await dev.call('us_sync_main', { script: 'scripts/beta.user.js', apply: true });
    assert.match(r.text, /LINKED_TO_WORKSPACE[\s\S]*linked to scripts\/beta\.user\.js/);
    r = await dev.call('us_sync_main', { script: 'Gamma' });
    assert.match(r.text, /only in the main profile: #\d+ "Gamma" 2\.0/);
    const afterL = listing(mainDir);
    assert.deepEqual([...afterL].filter(([k, v]) => before.get(k) !== v), [], 'main profile files changed');
    assert.equal(afterL.size, before.size);
  });
});
