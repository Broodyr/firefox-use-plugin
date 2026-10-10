// daily cold snapshot: taken before the first launch of the local day and reported as a launch note.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McpClient, NAMED_ARGS, makeHome, namedProfile } from './helpers.ts';

describe('daily cold snapshot', () => {
  let h: ReturnType<typeof makeHome>;
  before(() => { h = makeHome(namedProfile); });
  after(() => h.cleanup());

  it('first launch of the day takes one and says so; the next launch does not', async () => {
    const c = McpClient.spawnServer(NAMED_ARGS, h.env);
    await c.initialize();
    try {
      let r = await c.call('ff_launch', {});
      assert.match(r.text, /note: cold snapshot (c\d{8}-\d{6}-\w+) \(daily, before launch\) in \d+ ms/);
      const id = /cold snapshot (c\S+)/.exec(r.text)![1];
      r = await c.call('snapshot_list', {});
      assert.match(r.text, new RegExp(`${id} cold \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d test-named \\[auto\\] auto: daily`));
      r = await c.call('ff_quit', {});
      assert.ok(!r.isError, r.text);
      r = await c.call('ff_launch', {});
      assert.doesNotMatch(r.text, /cold snapshot/);
      assert.match(r.text, /note: checkpoint s\d{8}/);
      r = await c.call('ff_status', {});
      assert.match(r.text, /last checkpoint: s\S+ \(auto: at launch, \d\d:\d\d:\d\d\)/);
    } finally { await c.close(); }
  });
});
