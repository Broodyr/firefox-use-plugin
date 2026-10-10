// version pins: baseline written at the first launch of a lasting profile; a version change is reported at
// the next launch and the regression tests re-run in the background (newly failing ones named in ff_status);
// pins_update accepts the new versions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpClient, NAMED_ARGS, makeHome, namedProfile } from './helpers.ts';

describe('version pins', () => {
  let c: McpClient, h: ReturnType<typeof makeHome>;
  before(async () => { h = makeHome(namedProfile); c = McpClient.spawnServer(NAMED_ARGS, h.env); await c.initialize(); });
  after(async () => { await c.close(); h.cleanup(); });

  it('baseline, change detected with a test re-run, pins_update', async () => {
    let r = await c.call('ff_launch', {});
    assert.match(r.text, /pins\.json written \(baseline: Firefox [\d.]+, \d+ add-on\(s\)\)/, r.text);
    const pinsFile = path.join(h.workspace, '.firefox-use', 'pins.json');
    const pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
    pins.firefox = '100.0';
    fs.writeFileSync(pinsFile, JSON.stringify(pins));
    fs.mkdirSync(path.join(h.workspace, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(h.workspace, 'tests', 'ok.test.json'), JSON.stringify({ name: 'ok', cases: [{ url: 'data:text/html,<h1>Hi</h1>', assert: [{ selector: 'h1' }] }] }));
    fs.writeFileSync(path.join(h.workspace, 'tests', 'broke.test.json'), JSON.stringify({ name: 'broke', cases: [{ url: 'data:text/html,<h1>Hi</h1>', assert: [{ selector: 'h2' }] }] }));
    // both passed before the "update"
    fs.writeFileSync(path.join(h.workspace, '.firefox-use', 'test-results.json'), JSON.stringify({ ok: { pass: true, at: 'x' }, broke: { pass: true, at: 'x' } }));
    await c.call('ff_quit', {});
    r = await c.call('ff_launch', {});
    assert.match(r.text, /versions changed since pins\.json: Firefox 100\.0 -> [\d.]+ — re-running the regression tests headless/, r.text);
    let st = await c.call('ff_status', {});
    for (let i = 0; i < 120 && !/regression tests after the change/.test(st.text); i++) { await new Promise((res) => setTimeout(res, 1000)); st = await c.call('ff_status', {}); }
    assert.match(st.text, /regression tests after the change: 1\/2 test file\(s\) pass · NEWLY FAILING: broke/, st.text);
    r = await c.call('pins_update', {});
    assert.match(r.text, /Firefox 100\.0 -> /);
    r = await c.call('pins_update', { accept: true });
    assert.match(r.text, /pins\.json updated: Firefox [\d.]+/);
    assert.doesNotMatch((await c.call('ff_status', {})).text, /version change since pins\.json/);
  });
});
