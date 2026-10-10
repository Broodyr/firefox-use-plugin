// interception, mocking, HAR record and replay (page traffic of the agent tabs, over BiDi intercepts;
// recording reads the devtools hub, so bodies and headers are the real ones).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { workspace } from '../config.js';
import { fail } from '../errors.js';
import { harFromHub, harSummary, interceptorFor, type MockRule } from '../browser/intercept.js';
import { clock } from './console.js';
import { tool, tabArg } from './registry.js';
import { sleep } from '../browser/launcher.js';

const ruleArg = z.object({
  url: z.string().min(1).describe('URL substring, /regex/flags, or a glob with * over the whole URL'),
  method: z.string().optional(),
  action: z.enum(['fulfill', 'fail', 'delay', 'modify_headers', 'modify_body']),
  status: z.number().int().min(100).max(599).optional().describe('fulfill: status (default 200)'),
  headers: z.record(z.string(), z.string()).optional().describe('fulfill: response headers (content-type defaults to text/plain)'),
  body: z.string().optional().describe('fulfill: the body; modify_body: replace the whole body'),
  body_base64: z.string().optional().describe('fulfill: a binary body'),
  ms: z.number().int().min(0).max(120000).optional().describe('delay: milliseconds before the request goes out'),
  request_headers: z.record(z.string(), z.string().nullable()).optional().describe('modify_headers: set (or null = remove) request headers'),
  response_headers: z.record(z.string(), z.string().nullable()).optional().describe('modify_headers/modify_body: set or remove response headers'),
  replace: z.array(z.tuple([z.string(), z.string()])).optional().describe('modify_body: [from, to] text replacements in the real response'),
  times: z.number().int().positive().optional().describe('Only the first N matching requests'),
});

/** Workspace HAR path for a name: tests/fixtures/<name>.har (or a workspace-relative .har path). */
function harPath(name: string): { abs: string; rel: string } {
  const ws = path.resolve(workspace());
  const rel = name.endsWith('.har') ? name : `tests/fixtures/${name}.har`;
  const abs = path.resolve(ws, rel);
  if (!abs.toLowerCase().startsWith(ws.toLowerCase() + path.sep)) fail('PATH_REFUSED', `${name} is outside the workspace`);
  return { abs, rel: path.relative(ws, abs).split(path.sep).join('/') };
}

const ruleLine = (r: MockRule) => `${r.id} ${r.method ? `${r.method} ` : ''}${r.url} -> ${r.action}${r.action === 'fulfill' ? ` ${r.status ?? 200}` : r.action === 'delay' ? ` ${r.ms ?? 1000}ms` : ''}${r.times ? ` (first ${r.times})` : ''} · ${r.hits} hit(s)`;

export const mockTools = [
  tool({
    name: 'network_mock',
    description: 'Intercept the agent tabs\' requests (page traffic, not extensions\'): fulfill with a fake response, fail, delay, modify request/response headers, or modify the real body (text replacements). Rules are checked in order; the first match wins. Without rules: lists the active rules and the recent intercepted requests. Cleared by network_mock_clear.',
    args: { rules: z.array(ruleArg).max(50).optional(), tab: tabArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const i = interceptorFor(b);
      if (a.rules?.length) {
        for (const r of a.rules) {
          if (r.action === 'modify_body' && r.body === undefined && !r.replace?.length) fail('BAD_ARGS', 'modify_body needs body or replace');
          if (r.action === 'modify_headers' && !r.request_headers && !r.response_headers) fail('BAD_ARGS', 'modify_headers needs request_headers or response_headers');
          if (/^\/.+\/[dgimsuyv]*$/.test(r.url)) { try { new RegExp(r.url.slice(1, r.url.lastIndexOf('/'))); } catch (e: any) { fail('BAD_ARGS', `bad regex ${r.url}: ${e.message}`); } }
        }
        const added = i.addRules(a.rules);
        await i.sync();
        return [`added ${added.map((r) => r.id).join(', ')}; active rules:`, ...i.rules.map(ruleLine), 'Applies to new requests in the agent tabs (reload to apply to the current page).'].join('\n');
      }
      const lines = i.rules.length ? i.rules.map(ruleLine) : ['no mock rules'];
      if (i.replay) lines.push(`HAR replay: ${i.replay.name} (${i.replay.mode}) · ${i.replay.served} served, ${i.replay.passed} passed through, ${i.replay.unmatched.length} unmatched`);
      if (i.log.length) lines.push('recent:', ...i.log.slice(-15).map((l) => `  ${clock(l.ts)} ${l.what} ${l.url}`));
      return lines.join('\n');
    },
  }),
  tool({
    name: 'network_mock_clear',
    description: 'Remove mock rules (all, or by id) and report their hit counts.',
    args: { ids: z.array(z.string()).optional() },
    async handler(a, ctx) {
      const b = ctx.current();
      if (!b) return 'no mock rules';
      const i = interceptorFor(b);
      const gone = i.rules.filter((r) => !a.ids?.length || a.ids.includes(r.id));
      i.rules = i.rules.filter((r) => !gone.includes(r));
      await i.sync();
      return gone.length ? `removed ${gone.map(ruleLine).join('; ')}` : 'no matching rules';
    },
  }),
  tool({
    name: 'har_record',
    description: 'Start recording a tab\'s traffic (requests, headers, bodies) for a HAR fixture; har_stop writes tests/fixtures/<name>.har, masked (cookies, auth headers, token query params). Optionally navigates to url once recording.',
    args: {
      name: z.string().min(1).regex(/^[\w./-]+$/).describe('Fixture name (tests/fixtures/<name>.har) or a workspace-relative .har path'),
      url: z.string().optional().describe('Navigate here after starting'),
      include_extensions: z.boolean().default(false).describe('Also record requests made by extensions (uBO lists, GM_xmlhttpRequest)'),
      tab: tabArg,
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const i = interceptorFor(b);
      if (i.recording) fail('HAR_RECORDING', `already recording "${i.recording.name}"`, 'har_stop first.');
      const d = await b.dt();
      const context = await b.context(a.tab);
      const tab = Number(Object.entries(b.state.tabs ?? {}).find(([, v]) => v === context)?.[0]);
      harPath(a.name);
      i.recording = { name: a.name, tab, context, from: d.netCursor, started: Date.now() };
      (i.recording as any).extensions = a.include_extensions;
      let nav = '';
      if (a.url) {
        await b.bidi.send('browsingContext.navigate', { context, url: a.url, wait: 'complete' }, 60000);
        nav = `; loaded ${a.url}`;
      }
      return `recording tab${tab} as "${a.name}"${nav}. Do the steps, then har_stop.`;
    },
  }),
  tool({
    name: 'har_stop',
    description: 'Stop recording and write the HAR file (masked). Reports the request count and any bodies the devtools server didn\'t keep (over 256 kB).',
    args: {},
    write: true,
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const i = interceptorFor(b);
      const rec = i.recording;
      if (!rec) fail('HAR_NOT_RECORDING', 'not recording', 'har_record first.');
      const d = await b.dt();
      // let in-flight requests finish, and requests the hub hasn't reported yet arrive: 300 ms without news (up to 3 s)
      for (let t = 0, quiet = 0, last = d.netCursor; t < 30 && quiet < 3; t++) {
        await sleep(100);
        const busy = d.net.some((e) => e.seq > rec!.from && !e.done);
        if (busy || d.netCursor !== last) { quiet = 0; last = d.netCursor; } else quiet++;
      }
      const ext = !!(rec as any).extensions;
      const { entries, missing } = await harFromHub(b, d, rec!.tab, rec!.from, (e) => e.initiator === 'page' || (ext && e.initiator.startsWith('extension:')));
      i.recording = null;
      const { abs, rel } = harPath(rec!.name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const har = { log: { version: '1.2', creator: { name: 'firefox-use', version: '0.1.0' }, browser: { name: 'Firefox', version: b.versions?.firefox ?? '' }, pages: [], entries } };
      fs.writeFileSync(abs, JSON.stringify(har, null, 1));
      const lines = [`wrote ${rel}: ${harSummary(entries)} in ${((Date.now() - rec!.started) / 1000).toFixed(1)} s`];
      if (missing) lines.push(`WARNING: ${missing} response bod${missing === 1 ? 'y was' : 'ies were'} not kept by the devtools server (over 256 kB, or discarded); replay serves them empty (_bodyMissing in the file)`);
      if (!entries.length) lines.push('WARNING: no requests recorded (was the traffic in this tab?)');
      return { text: lines.join('\n'), changes: [{ kind: 'file', path: rel, after: `${entries.length} entries` }] };
    },
  }),
  tool({
    name: 'har_replay',
    description: 'Serve the agent tabs\' requests from a HAR file (tests/fixtures/<name>.har). mode "strict": any request not in the HAR fails and is reported; "fallthrough": it goes to the network. Repeated requests get the recorded responses in order. Mock rules still win. Stop with har_replay_stop.',
    args: { name: z.string().min(1), mode: z.enum(['strict', 'fallthrough']).default('strict') },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const i = interceptorFor(b);
      const { abs, rel } = harPath(a.name);
      if (!fs.existsSync(abs)) fail('FILE_NOT_FOUND', `${rel} does not exist`, 'Record one with har_record / har_stop.');
      const n = i.loadReplay(a.name, abs, a.mode);
      await i.sync();
      return `replaying ${rel} (${n} entries, ${a.mode}). Navigate or reload to use it; har_replay_stop reports what was served and what was missing.`;
    },
  }),
  tool({
    name: 'har_replay_stop',
    description: 'Stop HAR replay and report: responses served from the HAR, requests passed to the network (fallthrough), and requests the HAR did not have (strict: these failed).',
    args: {},
    async handler(_a, ctx) {
      const b = ctx.current();
      if (!b) return 'not replaying';
      const i = interceptorFor(b);
      const r = i.replay;
      if (!r) return 'not replaying';
      i.replay = null;
      await i.sync();
      const lines = [`stopped replaying ${r.name}: ${r.served} served, ${r.passed} passed through, ${r.unmatched.length} unmatched`];
      if (r.unmatched.length) lines.push('not in the HAR:', ...[...new Set(r.unmatched)].slice(0, 30).map((u) => `  ${u}`));
      return lines.join('\n');
    },
  }),
];
