// tools: snapshot, snapshot_cold, snapshot_list, snapshot_diff, restore, undo.
import { z } from 'zod';
import { auditRead, type AuditEntry } from '../audit/audit.js';
import * as XS from '../browser/extScripts.js';
import type { Browser } from '../browser/session.js';
import { fail } from '../errors.js';
import {
  captureWarm, diffWarm, findSnapshot, listSnapshots, localTime, readWarm, restoreColdCopy, restoreWarm, takeColdCopy, takeWarm,
} from '../snapshots/snapshots.js';
import { tool, type Ctx } from './registry.js';
import { UNDO_HANDLERS } from '../snapshots/undo.js';

/** Quit Firefox, run fn on the stopped profile, relaunch and reopen the agent tabs. */
async function withStoppedFirefox<T>(ctx: Ctx, fn: (profileDir: string, key: string, firefox?: string) => T): Promise<{ r: T; b: Browser }> {
  const b = await ctx.browser();
  if (b.state.throwaway) fail('THROWAWAY', 'cold snapshots work on named profiles; this is a throwaway copy (deleted when it stops)');
  const urls = (await b.listTabs()).filter((t) => t.agent).map((t) => t.url);
  const { profileDir, key } = b.state;
  const ff = b.versions?.firefox;
  const approvals = b.approvals();
  await b.quit();
  ctx.setBrowser(null);
  let r: T;
  try { r = fn(profileDir, key, ff); } finally {
    const nb = await ctx.browser();
    nb.adoptApprovals(approvals);
    nb.launchedNow = false;
    const first = await nb.context().catch(() => null);
    if (first && urls[0] && urls[0] !== 'about:blank') await nb.bidi.send('browsingContext.navigate', { context: first, url: urls[0], wait: 'complete' }, 60000).catch(() => {});
    for (const u of urls.slice(1)) await nb.createTab(u).catch(() => {});
  }
  return { r: r!, b: await ctx.browser() };
}

const CORE_UNDOABLE = new Set(['pref', 'ext_storage', 'addon_enabled', 'managed_storage']);
const UNDOABLE = { has: (k: string) => CORE_UNDOABLE.has(k) || UNDO_HANDLERS.has(k) };
const masked = (v: unknown) => /<masked>|<jwt:masked>/.test(JSON.stringify(v) ?? '');

/** Apply the inverse of one audit entry's changes. */
async function undoEntry(b: Browser, e: AuditEntry): Promise<{ lines: string[]; changes: NonNullable<AuditEntry['changes']> }> {
  const lines: string[] = [], changes: NonNullable<AuditEntry['changes']> = [];
  for (const c of [...(e.changes ?? [])].reverse()) {
    if (!UNDOABLE.has(c.kind)) { lines.push(`  ${c.kind}${c.path ? ` ${c.path}` : ''}: not undoable (restore a snapshot instead)`); continue; }
    const before: any = c.before;
    if (before && typeof before === 'object' && (before.$large || before.$unserializable)) { lines.push(`  ${c.path}: value too large for the audit log; restore a snapshot instead`); continue; }
    if (masked(before)) { lines.push(`  ${c.path}: before-value was masked in the audit log (secret); restore a snapshot instead`); continue; }
    if (c.kind === 'pref') {
      const r = await b.callChrome<{ before: Record<string, unknown> }>(XS.PREFS_SET, { values: { [c.path!]: before ?? null } });
      changes.push({ kind: 'pref', path: c.path, before: r.before[c.path!], after: before ?? null });
      lines.push(`  pref ${c.path} -> ${JSON.stringify(before ?? '(default)')}`);
    } else if (c.kind === 'ext_storage') {
      const [id, area, ...rest] = c.path!.split('|');
      const key = rest.join('|');
      const absent = before && typeof before === 'object' && before.$absent;
      const r = absent
        ? await b.callChrome<{ before: Record<string, unknown> }>(XS.EXT_STORAGE_REMOVE, { id, area, keys: [key] })
        : await b.callChrome<{ before: Record<string, unknown> }>(XS.EXT_STORAGE_SET, { id, area, items: { [key]: before } });
      changes.push({ kind: 'ext_storage', path: c.path, before: r.before[key] ?? { $absent: true }, after: before });
      lines.push(`  ${id} storage.${area}.${key} -> ${absent ? '(removed)' : JSON.stringify(before).slice(0, 80)}`);
    } else if (c.kind === 'addon_enabled') {
      const r = await b.callChrome<{ before: boolean; after: boolean }>(XS.ADDON_SET_ENABLED, { id: c.path, enabled: !!before });
      changes.push({ kind: 'addon_enabled', path: c.path, before: r.before, after: r.after });
      lines.push(`  ${c.path} -> ${before ? 'enabled' : 'disabled'}`);
    } else if (c.kind === 'managed_storage') {
      await b.callChrome(XS.MANAGED_INSTALL);
      const r = await b.callChrome<{ before: unknown }>(XS.MANAGED_SET, { id: c.path, data: before ?? null });
      await b.callChrome(XS.ADDON_RELOAD, { id: c.path }).catch(() => {});
      changes.push({ kind: 'managed_storage', path: c.path, before: r.before, after: before ?? null });
      lines.push(`  managed storage ${c.path} -> ${before === null ? '(cleared)' : 'previous value'}; reloaded`);
    } else {
      const r = await UNDO_HANDLERS.get(c.kind)!(b, c);
      changes.push(r.change);
      lines.push(`  ${r.line}`);
    }
  }
  changes.push({ kind: 'undo_of', path: e.id });
  return { lines, changes };
}

export const snapshotTools = [
  tool({
    name: 'snapshot',
    description: 'Warm checkpoint while Firefox runs: non-default prefs, add-on enabled states, every extension\'s storage (local, sync; uBO\'s downloaded-list caches excluded), managed storage, and uBO\'s user data (filters, settings, lists, rules) via its own messaging. Stored under .firefox-use/snapshots/<id>/.',
    args: { label: z.string().default('manual') },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const t0 = Date.now();
      const m = await takeWarm(b, a.label, false);
      return { text: `snapshot ${m.id} (${a.label}) in ${Date.now() - t0} ms${m.notes?.length ? `\nnotes: ${m.notes.join('; ')}` : ''}`, changes: [{ kind: 'snapshot', path: m.id }] };
    },
  }),
  tool({
    name: 'snapshot_cold',
    description: 'Full copy of the profile directory: quits Firefox, copies, relaunches and reopens the agent tabs. For risky operations. (A daily one is taken automatically before launch.)',
    args: { label: z.string().default('manual') },
    write: true,
    async handler(a, ctx) {
      const t0 = Date.now();
      const { r } = await withStoppedFirefox(ctx, (dir, key, ff) => takeColdCopy(key, dir, a.label, false, ff));
      return { text: `cold snapshot ${r.id} (${a.label}) in ${Date.now() - t0} ms: ${r.dir}`, changes: [{ kind: 'snapshot_cold', path: r.id }] };
    },
  }),
  tool({
    name: 'snapshot_list',
    description: 'Snapshots (warm in this workspace, cold for the profile): id, time, label, automatic or manual.',
    args: { limit: z.number().int().positive().max(200).default(20) },
    async handler(a) {
      const all = listSnapshots();
      if (!all.length) return 'no snapshots';
      return all.slice(-a.limit).map((s) => `${s.id} ${s.kind} ${localTime(s.ts)} ${s.profile} ${s.auto ? '[auto] ' : ''}${s.label}`).join('\n');
    },
  }),
  tool({
    name: 'snapshot_diff',
    description: 'What changed between two warm snapshots, or between one and the current state (b = "current"): prefs, add-on states, extension storage keys, managed storage.',
    args: { a: z.string(), b: z.string().default('current') },
    detail: true,
    async handler(a, ctx) {
      const x = readWarm(findSnapshot(a.a));
      let y;
      if (a.b === 'current') y = (await captureWarm(await ctx.browser())).data;
      else y = readWarm(findSnapshot(a.b));
      const lines = diffWarm(x, y, a.detail ?? 'summary');
      return lines.length ? `${lines.length} difference(s) ${a.a} -> ${a.b}:\n${lines.join('\n')}` : `no differences ${a.a} -> ${a.b}`;
    },
  }),
  tool({
    name: 'restore',
    description: 'Restore a snapshot: warm ones fully or by parts (prefs, addons, ext_storage, ext_storage:<id>, managed, ubo = uBO\'s filters/settings/lists/rules through its own messaging; affected extensions are reloaded); cold ones replace the whole profile (Firefox restarts). A warm snapshot of the current state is taken first. Needs scope "restore".',
    args: { id: z.string(), parts: z.array(z.string()).optional() },
    write: true,
    async handler(a, ctx) {
      const s = findSnapshot(a.id);
      const b = await ctx.browser();
      await ctx.requireScope('restore', b);
      const before = await takeWarm(b, `auto: before restore ${a.id}`, true);
      if (s.kind === 'cold') {
        if (s.profile !== b.state.key) fail('BAD_ARGS', `${s.id} is a snapshot of ${s.profile}, not ${b.state.key}`);
        const { r } = await withStoppedFirefox(ctx, (dir) => restoreColdCopy(s, dir));
        return { text: `restored cold snapshot ${s.id}; previous profile kept at ${r}\ncheckpoint of the state before: ${before.id}`, changes: [{ kind: 'restore_cold', path: s.id, before: before.id }] };
      }
      const res = await restoreWarm(b, readWarm(s), a.parts);
      return { text: `restored ${s.id}${a.parts ? ` (${a.parts.join(', ')})` : ''}:\n${res.lines.join('\n') || 'nothing differed'}\ncheckpoint of the state before: ${before.id}`, changes: [...res.changes, { kind: 'restore', path: s.id, before: before.id }] };
    },
  }),
  tool({
    name: 'undo',
    description: 'Incremental rollback from the audit log: undo one entry by auditId, or the last n undoable changes (prefs, extension storage, add-on enabled state, managed storage, uBO filters/settings/lists, Violentmonkey scripts/values, Stylus styles/variables). Needs scope "restore".',
    args: { target: z.union([z.string().regex(/^a\d{8}-/), z.number().int().positive().max(50)]).describe('An auditId, or n = the last n changes') },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      await ctx.requireScope('restore', b);
      const log = auditRead({ writesOnly: true, limit: 5000 });
      const undone = new Set(log.flatMap((e) => (e.changes ?? []).filter((c) => c.kind === 'undo_of').map((c) => c.path!)));
      let entries: AuditEntry[];
      if (typeof a.target === 'string') {
        const e = log.find((x) => x.id === a.target);
        if (!e) fail('AUDIT_NOT_FOUND', `no audit entry ${a.target} in this workspace`, 'ff_audit_show lists them.');
        if (undone.has(e!.id)) fail('ALREADY_UNDONE', `${a.target} was already undone`);
        entries = [e!];
      } else {
        entries = log.filter((e) => e.status === 'ok' && e.tool !== 'undo' && !undone.has(e.id) && (e.changes ?? []).some((c) => UNDOABLE.has(c.kind))).slice(-a.target).reverse();
        if (!entries.length) return 'nothing to undo';
      }
      const lines: string[] = [];
      const changes: NonNullable<AuditEntry['changes']> = [];
      for (const e of entries) {
        lines.push(`${e.id} ${e.tool}:`);
        const r = await undoEntry(b, e);
        lines.push(...r.lines);
        changes.push(...r.changes);
      }
      return { text: lines.join('\n'), changes };
    },
  }),
];
