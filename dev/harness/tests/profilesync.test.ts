// profile_sync: copy the user's extensions and prefs into the dev profile (here: a throwaway copy). Reads the real
// main profile (read-only), so it is skipped on machines without one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, makeHome, startServer } from './helpers.ts';

const mainIni = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Mozilla', 'Firefox', 'profiles.ini');

describe('profile_sync', { skip: !fs.existsSync(mainIni) && 'no main Firefox profile on this machine' }, () => {
  let c: McpClient, h: ReturnType<typeof makeHome>;
  // a profiles.ini without a usable default profile (a CI image's Firefox): the server's own answer decides
  let noMain = false;
  before(async () => { h = makeHome(); c = await startServer(h.env); noMain = /NO_MAIN_PROFILE/.test((await c.call('profile_sync', {})).text); });
  after(async () => { await c.close(); h.cleanup(); });

  it('dry run lists the plan and never copies credential extensions', async (t) => {
    if (noMain) return t.skip('no main Firefox profile on this machine');
    const r = await c.call('profile_sync', {});
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /extensions: \d+ to install, \d+ to update, \d+ enabled-state change\(s\)/);
    assert.match(r.text, /prefs: \d+ to change \(of \d+ copyable user-set prefs; \d+ skipped/);
    assert.match(r.text, /dry run: nothing changed/);
    assert.doesNotMatch(r.text, /^ {2}install .*(Bitwarden|2FAS|Password Manager)/m);
    const a = await c.call('addons_list', {});
    assert.doesNotMatch(a.text, /Bitwarden|2FAS/);
  });

  it('applies one extension (enabled state kept) and the prefs; prefs are undo-able', async (t) => {
    if (noMain) return t.skip('no main Firefox profile on this machine');
    const plan = await c.call('profile_sync', { prefs: false });
    const pick = /^ {2}install (.+?) [\d.]+(?: \(disabled in your Firefox\))?$/m.exec(plan.text);
    if (!pick) return; // everything already present
    const r = await c.call('profile_sync', { apply: true, extensions: [pick[1]] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /applied: 1 extension change\(s\), \d+ pref\(s\)/);
    const a = await c.call('addons_list', {});
    assert.ok(a.text.includes(pick[1]), a.text);
    const again = await c.call('profile_sync', { extensions: [pick[1]] });
    assert.match(again.text, /extensions: 0 to install, 0 to update, 0 enabled-state change\(s\)/);
    // Firefox rewrites browser.uiCustomization.state itself when an installed extension adds a toolbar button
    assert.match(again.text, /prefs: 0 to change|prefs: 1 to change[\s\S]*by branch: browser\.uiCustomization 1/);
  });
});
