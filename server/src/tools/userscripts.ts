// userscript tools: Violentmonkey (manager mode) and the companion's userScripts runner (fast mode),
// with workspace files as the source of truth and two-way sync.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sleep } from '../browser/launcher.js';
import { workspace } from '../config.js';
import { fail } from '../errors.js';
import type { Browser } from '../browser/session.js';
import {
  VM_ID, installFile, parseMeta, mapVmStacks, linkStatuses, pullLink, readScript, readShadows, readState, relPath, releaseShadows, setVmEnabled, uninstallLink,
  vmScripts, vmSend, vmSetValues, vmSync, vmValues, writeState, slug, baseName, hashOf, stripPrelude, type Link, type ShadowOpts, type SyncState,
} from '../adapters/violentmonkey.js';
import { driftLine, driftReport, driftSummary, lineDiff, mainProfileDir, profileScriptData, profileScripts, readDrift, type ProfileScript } from '../adapters/vmstore.js';
import { compCall } from '../adapters/companion.js';
import { registerUndo } from '../snapshots/undo.js';
import { auditValue } from './privileged.js';
import { renderEntries } from './console.js';
import { tool, type Ctx } from './registry.js';

const SCOPE = `ext:${VM_ID}`;
const target = z.union([z.string().min(1), z.number().int().positive()]).describe('Workspace path, script name, Violentmonkey id, or fast-mode id');

interface Resolved { rel?: string; link?: Link; mode: 'manager' | 'fast'; id: number | string; name: string }

/** A script by workspace path, name, VM id or fast id (linked scripts first). */
async function resolveScript(b: Browser, t: string | number, state: SyncState): Promise<Resolved> {
  const ts = String(t);
  for (const [rel, l] of Object.entries(state.links)) {
    if (rel === ts.replace(/\\/g, '/') || rel.endsWith('/' + ts) || l.name === ts || String(l.id) === ts) return { rel, link: l, mode: l.mode, id: l.id, name: l.name };
  }
  const vm = await vmScripts(b).catch(() => []);
  const hit = vm.find((s) => !s.removed && (String(s.id) === ts || s.name === ts));
  if (hit) return { mode: 'manager', id: hit.id, name: hit.name };
  const fast = await compCall<any[]>(b, 'return await cf.list();').catch(() => []);
  const f = fast.find((s) => s.id === ts || s.name === ts);
  if (f) return { mode: 'fast', id: f.id, name: f.name };
  return fail('SCRIPT_NOT_FOUND', `no userscript matching ${JSON.stringify(t)}`, 'us_list shows installed scripts and their workspace files.');
}

const statusOf = (st?: string) => (st && st !== 'synced' ? ` [${st.toUpperCase()}]` : '');

// ------------------------------------------------------------ undo handlers
registerUndo('vm_values', async (b, c) => {
  const id = Number(c.path);
  const cur = await vmValues(b, id);
  await vmSetValues(b, id, (c.before ?? {}) as Record<string, unknown>);
  return { line: `Violentmonkey #${id} values -> previous store`, change: { kind: 'vm_values', path: c.path, before: auditValue(cur), after: c.before } };
});
registerUndo('vm_enabled', async (b, c) => {
  await vmSend(b, 'UpdateScriptInfo', { id: Number(c.path), config: { enabled: c.before ? 1 : 0 } });
  return { line: `Violentmonkey #${c.path} -> ${c.before ? 'enabled' : 'disabled'}`, change: { kind: 'vm_enabled', path: c.path, before: !c.before, after: !!c.before } };
});
registerUndo('vm_removed', async (b, c) => {
  await vmSend(b, 'MarkRemoved', { id: Number(c.path), removed: false });
  return { line: `Violentmonkey #${c.path} restored from its recycle bin`, change: { kind: 'vm_removed', path: c.path, before: true, after: false } };
});
registerUndo('vm_script', async (b, c) => {
  const id = Number(c.path);
  if (c.before == null) { await vmSend(b, 'MarkRemoved', { id, removed: true }); return { line: `Violentmonkey #${id} (newly installed) moved to the recycle bin`, change: { kind: 'vm_removed', path: c.path, before: false, after: true } }; }
  const cur = String(await vmSend(b, 'GetScriptCode', id));
  await vmSend(b, 'ParseScript', { code: c.before, id, bumpDate: true, config: { shouldUpdate: 0 } });
  return { line: `Violentmonkey #${id} code -> previous version`, change: { kind: 'vm_script', path: c.path, before: auditValue(cur), after: auditValue(c.before) } };
});

async function requireFor(ctx: Ctx, b: Browser, mode: 'manager' | 'fast') {
  // fast mode only changes the companion (a temporary add-on of ours, gone at the next restart): no scope needed
  if (mode === 'manager') await ctx.requireScope(SCOPE, b);
}

/** Disabling another installed copy of the script (same-script check) changes Violentmonkey: scope "ext:vm". */
const shadowOpts = (ctx: Ctx, b: Browser, shadow?: 'disable' | 'keep'): ShadowOpts => ({ shadow, allow: () => ctx.requireScope(SCOPE, b) });
const shadowArg = z.enum(['disable', 'keep']).default('disable').describe('Another installed copy of the same script (same @name, any namespace; e.g. the Violentmonkey copy of a fast-mode dev copy): "disable" it while this dev copy is installed (needs scope "ext:vm"; re-enabled by us_uninstall of the dev copy, ff_quit for fast mode, or the next launch), or "keep" both running (warning)');

export const userscriptTools = [
  tool({
    name: 'us_list',
    description: 'Installed userscripts: Violentmonkey scripts (id, name, version, enabled, @match/@include, @run-at, @inject-into, last modified) and fast-mode scripts, each with the workspace file it is linked to and its sync status.',
    args: {},
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      const statuses = await linkStatuses(b, state).catch(() => []);
      const byId = new Map(statuses.map((s) => [String(s.link.id), s]));
      const lines: string[] = [];
      const vm = (await vmScripts(b)).filter((s) => !s.removed);
      const shadows = readShadows(b);
      const drift = readDrift(b);
      for (const s of vm) {
        const st = byId.get(String(s.id));
        const m = s.meta ?? {};
        const where = [...(m.match ?? []), ...(m.include ?? [])];
        const sh = shadows[s.id];
        const off = s.enabled ? '' : sh ? ` [disabled: shadowed by ${sh.by.rel} (${sh.by.mode} ${sh.by.id})]` : ' [disabled]';
        const mainV = drift?.ok ? ` (main: ${drift.mainVersions[s.id] ?? '-'})` : '';
        lines.push(`#${s.id} ${s.name} ${s.version}${mainV}${off} · ${m.runAt ?? 'document-end'}${m.injectInto && m.injectInto !== 'auto' ? ` · inject-into ${m.injectInto}` : ''} · ${where.slice(0, 3).join(' ')}${where.length > 3 ? ' …' : ''}${st ? `  ← ${st.rel}${statusOf(st.status)}` : ''}`);
        if (a.detail !== 'summary') lines.push(`    modified ${new Date(s.lastModified).toLocaleString()} · grants ${(m.grant ?? []).join(' ') || 'none'}${m.require?.length ? ` · ${m.require.length} @require` : ''}`);
      }
      const fast = await compCall<any[]>(b, 'return await cf.list();').catch(() => []);
      for (const f of fast) {
        const st = byId.get(String(f.id));
        lines.push(`fast ${f.id} ${f.name} ${f.version ?? ''}${f.enabled ? '' : ' [disabled]'} · ${f.runAt} · ${f.world} · GM ${f.gm} · ${(f.matches ?? []).slice(0, 3).join(' ')}${st ? `  ← ${st.rel}${statusOf(st.status)}` : ''}`);
      }
      for (const st of statuses) if (st.status === 'missing in vm' || st.status === 'missing file') lines.push(`link ${st.rel} -> ${st.link.mode} ${st.link.id}: ${st.status.toUpperCase()}`);
      return lines.join('\n') || 'no userscripts installed';
    },
  }),
  tool({
    name: 'us_install',
    description: 'Install a workspace userscript (e.g. scripts/x.user.js). mode "manager" (default): into Violentmonkey through its own ParseScript, so metadata, @require/@resource and GM_* behave as in production (needs scope "ext:vm"). mode "fast": registered through the companion\'s userScripts API with GM_* stubs, for sub-second iteration (no scope needed). The dev prelude (__claude.mark, GM_xmlhttpRequest attribution) is added unless turned off with us_dev_prelude. Reload the page to run it.',
    args: { path: z.string().min(1), mode: z.enum(['manager', 'fast']).default('manager'), shadow: shadowArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      const { rel } = relPath(a.path);
      await requireFor(ctx, b, a.mode);
      const prevLink = state.links[rel];
      const before = await codeBefore(b, a.mode, prevLink, readCode(rel));
      const r = await installFile(b, a.path, a.mode, state, shadowOpts(ctx, b, a.shadow));
      if (a.mode === 'manager') vmSync(b).ensure();
      return {
        text: r.lines.join('\n'),
        changes: [...(a.mode === 'manager' ? [{ kind: 'vm_script', path: String(r.link.id), before: r.isNew ? null : auditValue(before), after: `(${rel})` }] : [{ kind: 'fast_script', path: String(r.link.id), after: rel }]), ...r.changes],
      };
    },
  }),
  tool({
    name: 'us_update',
    description: 'Re-push a workspace userscript after editing it, in the mode it was installed with (default manager). Needs scope "ext:vm" for manager mode.',
    args: { path: z.string().min(1), shadow: shadowArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      const { rel } = relPath(a.path);
      const link = state.links[rel];
      const mode = link?.mode ?? 'manager';
      await requireFor(ctx, b, mode);
      const before = await codeBefore(b, mode, link, readCode(rel));
      const r = await installFile(b, a.path, mode, state, shadowOpts(ctx, b, a.shadow));
      if (mode === 'manager') vmSync(b).ensure();
      return { text: r.lines.join('\n'), changes: [...(mode === 'manager' ? [{ kind: 'vm_script', path: String(r.link.id), before: r.isNew ? null : auditValue(before), after: `(${rel})` }] : [{ kind: 'fast_script', path: String(r.link.id), after: rel }]), ...r.changes] };
    },
  }),
  tool({
    name: 'us_set_enabled',
    description: 'Enable or disable a userscript (Violentmonkey or fast mode). Audited (undo-able). Needs scope "ext:vm" for Violentmonkey scripts.',
    args: { script: target, enabled: z.boolean() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const s = await resolveScript(b, a.script, readState());
      await requireFor(ctx, b, s.mode);
      if (s.mode === 'fast') { await compCall(b, `return await cf.setEnabled(${JSON.stringify(s.id)}, ${a.enabled});`); return { text: `fast ${s.id} "${s.name}" ${a.enabled ? 'enabled' : 'disabled'}` }; }
      const cur = (await vmScripts(b)).find((x) => x.id === s.id);
      await setVmEnabled(b, Number(s.id), a.enabled);
      // enabling a shadowed copy by hand is a decision: stop managing it
      const wasShadowed = a.enabled && !!readShadows(b)[s.id];
      if (wasShadowed) await releaseShadows(b, (_x, id) => id === Number(s.id), 'enabled by hand');
      return { text: `Violentmonkey #${s.id} "${s.name}": ${cur?.enabled ? 'enabled' : 'disabled'} -> ${a.enabled ? 'enabled' : 'disabled'}${wasShadowed ? ' (no longer shadowed by its dev copy: both run)' : ''}`, changes: [{ kind: 'vm_enabled', path: String(s.id), before: !!cur?.enabled, after: a.enabled }] };
    },
  }),
  tool({
    name: 'us_uninstall',
    description: 'Uninstall a userscript: Violentmonkey scripts go to its recycle bin (restorable; undo-able), fast-mode scripts are unregistered. The workspace file is kept. Needs scope "ext:vm" for Violentmonkey scripts.',
    args: { script: target },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      const s = await resolveScript(b, a.script, state);
      await requireFor(ctx, b, s.mode);
      const msg = await uninstallLink(b, { mode: s.mode, id: s.id } as Link);
      if (s.rel) { delete state.links[s.rel]; writeState(state); }
      // the copies this dev copy shadowed run again
      const back = await releaseShadows(b, (x) => String(x.by.id) === String(s.id) && x.by.mode === s.mode, `its dev copy ${s.rel ?? s.id} was uninstalled`);
      return {
        text: [`${msg}${s.rel ? ` (link to ${s.rel} removed; the file is kept)` : ''}`, ...back.lines].join('\n'),
        changes: [...(s.mode === 'manager' ? [{ kind: 'vm_removed', path: String(s.id), before: false, after: true }] : [{ kind: 'fast_script_removed', path: String(s.id) }]), ...back.changes],
      };
    },
  }),
  tool({
    name: 'us_values',
    description: 'A userscript\'s GM_setValue storage (decoded), for Violentmonkey or fast-mode scripts.',
    args: { script: target },
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const s = await resolveScript(b, a.script, readState());
      const read = () => (s.mode === 'manager' ? vmValues(b, Number(s.id)) : compCall<Record<string, unknown>>(b, `return await cf.getValues(${JSON.stringify(s.id)});`));
      // GM_setValue reaches the store as an asynchronous message (Violentmonkey's background, or the companion):
      // a read right after the page ran can miss the latest write (seen under load). Read until two reads 250 ms
      // apart agree (at most ~2 s).
      let vals = await read();
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        const again = await read();
        if (JSON.stringify(again) === JSON.stringify(vals)) break;
        vals = again;
      }
      const keys = Object.keys(vals);
      return `${s.mode === 'manager' ? `Violentmonkey #${s.id}` : `fast ${s.id}`} "${s.name}": ${keys.length} value(s)${keys.length ? '\n' + keys.map((k) => `${k} = ${JSON.stringify(vals[k]).slice(0, 300)}`).join('\n') : ''}`;
    },
  }),
  tool({
    name: 'us_values_set',
    description: 'Set a userscript\'s GM values ({key: value}; null deletes; replace:true replaces the whole store). Violentmonkey: through its SetValueStores command (audited, undo-able; needs scope "ext:vm"). Fast mode: the companion\'s store.',
    args: { script: target, values: z.record(z.string(), z.any()), replace: z.boolean().default(false) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const s = await resolveScript(b, a.script, readState());
      await requireFor(ctx, b, s.mode);
      if (s.mode === 'fast') {
        await compCall(b, `return await cf.setValues(${JSON.stringify(s.id)}, ${JSON.stringify(a.values)}, ${a.replace});`);
        return { text: `fast ${s.id}: ${Object.keys(a.values).length} value(s) ${a.replace ? 'replaced' : 'set'} (the script is re-registered with them)` };
      }
      const id = Number(s.id);
      const before = await vmValues(b, id);
      const next: Record<string, unknown> = a.replace ? {} : { ...before };
      for (const [k, v] of Object.entries(a.values)) { if (v === null) delete next[k]; else next[k] = v; }
      await vmSetValues(b, id, next);
      return { text: `Violentmonkey #${id} "${s.name}": ${Object.keys(a.values).map((k) => `${k}: ${JSON.stringify(before[k]) ?? '(absent)'} -> ${a.values[k] === null ? '(deleted)' : JSON.stringify(a.values[k])}`).join('\n')}`, changes: [{ kind: 'vm_values', path: String(id), before: auditValue(before), after: auditValue(next) }] };
    },
  }),
  tool({
    name: 'us_logs',
    description: 'One userscript\'s log: its console output and errors (from its own realm), Violentmonkey\'s errors about it (failed @require downloads, metadata problems), and __claude.mark timings from the dev prelude. Entries can arrive late (right after a reload, and from observer/timer callbacks), so it first waits until no new entry has come for settle_ms (default 800, up to 8 s in all; 0 = read at once) and says if entries were still arriving.',
    args: { script: target, since: z.string().optional(), level: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional(), limit: z.number().int().positive().max(500).default(50), settle_ms: z.number().int().min(0).max(5000).default(800) },
    detail: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const s = await resolveScript(b, a.script, readState());
      const d = await b.dt();
      const enc = encodeURIComponent(s.name).replace(/%20/g, '%20');
      const own = (e: { url?: string; text: string; realm: string; stack?: string }) =>
        (s.mode === 'manager' && (!!e.url && (e.url.includes(`.user.js#${s.id}`) || e.url.includes(`%20${enc}.user.js`) || e.url.includes(` ${s.name}.user.js`))))
        || (s.mode === 'fast' && ((!!e.url && e.url === `claude-fast/${slug(s.name)}.user.js`) || (!!e.stack && e.stack.includes(`claude-fast/${slug(s.name)}.user.js`))))
        || e.text.includes(`"script":${JSON.stringify(s.name)}`)
        || ((e.realm.startsWith('extension:Violentmonkey') || e.realm.startsWith('extension:firefox-use')) && e.text.includes(s.name));
      const lvl = ['debug', 'log', 'info', 'warn', 'error'];
      const min = a.level ? lvl.indexOf(a.level) : 0;
      const sinceM = a.since ? matcherSince(a.since) : () => true;
      const collect = () => d.log.filter((e) => own(e) && lvl.indexOf(e.level === 'warning' ? 'warn' : e.level) >= min && sinceM(e.seq, e.ts));
      let hits = collect();
      // settle: entries of a just-reloaded page (and of throttled callbacks) keep arriving after the first read
      const firstSeq = hits.at(-1)?.seq ?? -1, t0 = Date.now();
      let quietSince = Date.now(), stillArriving = false;
      while (a.settle_ms > 0 && Date.now() - quietSince < a.settle_ms) {
        if (Date.now() - t0 > 8000) { stillArriving = true; break; }
        await new Promise((r) => setTimeout(r, 100));
        const n = collect();
        if (n.length !== hits.length || n.at(-1)?.seq !== hits.at(-1)?.seq) { hits = n; quietSince = Date.now(); }
      }
      const shown = await mapVmStacks(b, hits.slice(-a.limit).map((e) => ({ ...e, realm: d.realmLabel(e) })));
      const notes: string[] = [];
      const late = hits.filter((e) => e.seq > firstSeq).length;
      if (late) notes.push(`note: ${late} entr${late === 1 ? 'y' : 'ies'} arrived while waiting ${Date.now() - t0} ms`);
      if (stillArriving) notes.push('note: entries were still arriving after 8 s; call again for the rest');
      return [`${s.mode === 'manager' ? `Violentmonkey #${s.id}` : `fast ${s.id}`} "${s.name}": ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'}`, ...notes, ...renderEntries(shown, a.detail ?? 'summary', a.limit)].join('\n');
    },
  }),
  tool({
    name: 'us_dev_prelude',
    description: 'Turn the dev prelude on or off for dev installs (default on): __claude.mark(label) timing markers in the console, __claude.ready(), and a marker that lets network_read attribute GM_xmlhttpRequest calls to the script. It is never written to the file on disk. Re-pushes every linked script (needs scope "ext:vm" for Violentmonkey ones).',
    args: { on: z.boolean() },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      if (state.devPrelude === a.on) return `dev prelude already ${a.on ? 'on' : 'off'}`;
      state.devPrelude = a.on;
      writeState(state);
      const lines = [`dev prelude ${a.on ? 'on' : 'off'}`];
      for (const [rel, l] of Object.entries(state.links)) {
        if (l.mode === 'manager') await ctx.requireScope(SCOPE, b);
        const r = await installFile(b, rel, l.mode, state, shadowOpts(ctx, b));
        lines.push(r.lines[0]);
      }
      return { text: lines.join('\n'), changes: [{ kind: 'us_dev_prelude', after: a.on }] };
    },
  }),
  tool({
    name: 'us_fast_gm',
    description: 'Fast-mode GM_* stubs: "persisted" (GM values kept in the companion, GM_xmlhttpRequest really fetches, openInTab opens a background tab) or "recorded" (no side effects: calls are only logged). Without stubs: the current mode and the recent recorded GM calls. Changing it re-registers the fast-mode scripts.',
    args: { stubs: z.enum(['persisted', 'recorded']).optional(), limit: z.number().int().positive().max(500).default(30) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      const lines: string[] = [];
      if (a.stubs && a.stubs !== state.fastGm) {
        state.fastGm = a.stubs;
        writeState(state);
        lines.push(`fast-mode GM stubs: ${a.stubs}`);
        for (const [rel, l] of Object.entries(state.links)) if (l.mode === 'fast') lines.push((await installFile(b, rel, 'fast', state, shadowOpts(ctx, b))).lines[0]);
      } else lines.push(`fast-mode GM stubs: ${state.fastGm}`);
      const calls = await compCall<any[]>(b, `return cf.calls.slice(-${a.limit});`).catch(() => []);
      if (calls.length) lines.push('recent GM calls:', ...calls.map((c) => `${new Date(c.ts).toLocaleTimeString()} ${c.id} ${c.op}(${JSON.stringify(c.args ?? []).slice(1, -1).slice(0, 160)})`));
      return lines.join('\n');
    },
  }),
  tool({
    name: 'us_sync_status',
    description: 'Two-way sync status of linked userscripts: synced, file changed (push with us_update / us_sync), vm changed (edited in Violentmonkey\'s editor; pulled automatically while linked), both changed / conflict (Violentmonkey\'s version kept as <file>.vm-conflict, never overwritten).',
    args: {},
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      const st = await linkStatuses(b, state);
      if (!st.length) return 'no linked userscripts (us_install links a workspace file)';
      const poller = vmSync(b);
      if (st.some((s) => s.link.mode === 'manager')) poller.ensure();
      return [...st.map((s) => `${s.rel}: ${s.status}${s.link.conflict ? ` (${s.link.conflict.file})` : ''} · ${s.link.mode} ${s.link.id} · synced ${new Date(s.link.syncedAt).toLocaleTimeString()}`),
        `auto-pull of Violentmonkey edits: ${st.some((s) => s.link.mode === 'manager') ? 'on' : 'off'}${poller.lastError ? ` (last error: ${poller.lastError})` : ''}`].join('\n');
    },
  }),
  tool({
    name: 'us_sync',
    description: 'Sync linked userscripts: "push" (files -> installs), "pull" (Violentmonkey -> files), "auto" (each in the direction it changed). A script changed on both sides is never overwritten: Violentmonkey\'s version is saved as <file>.vm-conflict (force:true on pull overwrites the file instead). Needs scope "ext:vm" to push to Violentmonkey.',
    args: { direction: z.enum(['push', 'pull', 'auto']).default('auto'), path: z.string().optional(), force: z.boolean().default(false) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readState();
      const only = a.path ? relPath(a.path).rel : undefined;
      const lines: string[] = [];
      const changes: { kind: string; path?: string; before?: unknown; after?: unknown }[] = [];
      for (const st of await linkStatuses(b, state)) {
        if (only && st.rel !== only) continue;
        const push = a.direction === 'push' ? st.status !== 'synced' || a.force : a.direction === 'auto' && st.status === 'file changed';
        const pull = st.link.mode === 'manager' && (a.direction === 'pull' ? st.status !== 'synced' || a.force : a.direction === 'auto' && (st.status === 'vm changed' || st.status === 'both changed'));
        if (st.status === 'missing file' || st.status === 'missing in vm') { lines.push(`${st.rel}: ${st.status} (us_install relinks; us_uninstall drops the link)`); continue; }
        if (push && !pull) {
          await requireFor(ctx, b, st.link.mode);
          const before = st.link.mode === 'manager' ? String(await vmSend(b, 'GetScriptCode', st.link.id).catch(() => '')) : null;
          const r = await installFile(b, st.rel, st.link.mode, state, shadowOpts(ctx, b));
          lines.push(r.lines[0], ...r.lines.filter((l) => /^disabled Violentmonkey/.test(l)));
          changes.push(...r.changes);
          if (st.link.mode === 'manager') changes.push({ kind: 'vm_script', path: String(st.link.id), before: auditValue(before), after: `(${st.rel})` });
        } else if (pull) {
          if (a.force && (st.status === 'both changed' || st.status === 'conflict')) st.status = 'vm changed';
          const abs = path.join(path.resolve(workspace()), st.rel);
          const before = fs.existsSync(abs) ? readScript(abs) : null;
          lines.push(await pullLink(b, st, state));
          changes.push({ kind: 'file', path: st.rel, before: auditValue(before), after: '(from Violentmonkey)' });
        } else lines.push(`${st.rel}: ${st.status}`);
      }
      if (Object.values(state.links).some((l) => l.mode === 'manager')) vmSync(b).ensure();
      return { text: lines.join('\n') || 'no linked userscripts', changes };
    },
  }),
  tool({
    name: 'us_sync_main',
    description: 'Userscripts vs the user\'s main Firefox profile (only read there, from a temporary copy). Without script: compare all now (as the launch drift report does). With script (name, Violentmonkey id or workspace file): the diff claude-dev -> main profile for it; apply:true installs the main profile\'s code into claude-dev\'s Violentmonkey (values:true also replaces its GM values with the main profile\'s). Apply needs scope "ext:vm" and is undo-able; refused (LINKED_TO_WORKSPACE) for a script linked to a workspace file, i.e. in development here, unless force (which also drops that link; the file is kept).',
    args: { script: target.optional(), apply: z.boolean().default(false), values: z.boolean().default(false), force: z.boolean().default(false) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const dir = mainProfileDir();
      if (!dir) fail('NO_MAIN_PROFILE', 'no main Firefox profile found (profiles.ini)', 'Set mainProfile in %LOCALAPPDATA%\\firefox-use\\config.json.');
      if (path.resolve(dir!).toLowerCase() === path.resolve(b.state.profileDir).toLowerCase()) fail('NO_MAIN_PROFILE', 'this Firefox runs the main profile itself');
      if (a.script === undefined) {
        const r = await driftReport(b, dir!);
        return [driftSummary(r, 0), ...r.items.map((i) => `  ${driftLine(i)}`)].join('\n');
      }
      let main: ProfileScript[];
      try { main = profileScripts(dir!); } catch (e: any) { return fail('MAIN_UNREADABLE', `could not read Violentmonkey's data in the main profile: ${e?.message ?? e}`); }
      const here = (await vmScripts(b)).filter((s) => !s.removed);
      const state = readState();
      const ts = String(a.script);
      const key = (s: { name: string; namespace: string }) => `${s.name.toLowerCase()}\n${s.namespace.toLowerCase()}`;
      let h = here.find((s) => String(s.id) === ts || s.name === ts);
      if (!h) {
        const l = Object.entries(state.links).find(([rel, x]) => rel === ts.replace(/\\/g, '/') || rel.endsWith('/' + ts));
        if (l?.[1].mode === 'manager') h = here.find((s) => s.id === Number(l[1].id));
      }
      const m = h ? main.find((x) => key(x) === key(h!)) : main.find((x) => x.name === ts) ?? main.find((x) => x.name.toLowerCase() === ts.toLowerCase());
      if (!m) {
        const near = main.filter((x) => baseName(x.name) === baseName(h?.name ?? ts)).map((x) => `"${x.name}" (namespace ${x.namespace || '-'})`);
        return fail(h ? 'NOT_IN_MAIN' : 'SCRIPT_NOT_FOUND', h ? `"${h.name}" (namespace ${h.namespace || '-'}) is not in the main profile` : `no userscript "${ts}" here or in the main profile`,
          near.length ? `Same name in the main profile: ${near.join(', ')} (scripts are matched by name + namespace).` : 'us_sync_main without script lists the differences.');
      }
      h ??= here.find((x) => key(x) === key(m));
      const data = profileScriptData(dir!, m.id, a.values);
      const hereCode = h ? stripPrelude(String(await vmSend(b, 'GetScriptCode', h.id))) : null;
      const vv = (x: string) => x || '(no version)';
      const head = h ? `claude-dev #${h.id} ${vv(h.version)} -> main profile #${m.id} ${vv(m.version)} ("${m.name}")` : `only in the main profile: #${m.id} "${m.name}" ${vv(m.version)} (${data.code.split('\n').length} lines)`;
      const linked = h ? Object.entries(state.links).find(([, l]) => l.mode === 'manager' && Number(l.id) === h!.id) : undefined;
      if (!a.apply) {
        const same = hereCode !== null && hashOf(hereCode) === hashOf(data.code);
        return [head, hereCode !== null ? lineDiff(hereCode, data.code) : '',
          same ? 'code is identical' : linked ? `linked to ${linked[0]} (in development here): apply is refused unless force` : 'apply:true copies the main profile\'s version into claude-dev (values:true also its GM values)'].filter(Boolean).join('\n');
      }
      if (linked && !a.force) {
        fail('LINKED_TO_WORKSPACE', `"${h!.name}" (#${h!.id}) is linked to ${linked[0]} in this workspace, i.e. being developed here`,
          'A sync would overwrite that work. Finish it (or us_uninstall the dev copy) first, or pass force:true (drops the link; the file is kept).');
      }
      await ctx.requireScope(SCOPE, b);
      const lines = [head];
      const changes: { kind: string; path: string; before: unknown; after: unknown }[] = [];
      const r = await vmSend<any>(b, 'ParseScript', { code: data.code, bumpDate: true, ...(h ? { id: h.id } : {}) });
      const id = r?.where?.id;
      if (!id) fail('VM_ERROR', `Violentmonkey did not take the main profile's code: ${JSON.stringify(r).slice(0, 300)}`);
      changes.push({ kind: 'vm_script', path: String(id), before: h ? auditValue(hereCode) : null, after: `(main profile #${m.id} ${vv(m.version)})` });
      lines.push(`${h ? 'updated' : 'installed'} Violentmonkey #${id} "${m.name}" ${vv(h?.version ?? '')} -> ${vv(m.version)} from the main profile${r?.update?.message ? ` — ${r.update.message}` : ''}`);
      if (a.values) {
        const before = h ? await vmValues(b, id) : {};
        await vmSetValues(b, id, data.values ?? {});
        changes.push({ kind: 'vm_values', path: String(id), before: auditValue(before), after: auditValue(data.values) });
        lines.push(`GM values: ${Object.keys(data.values ?? {}).length} from the main profile (replaced ${Object.keys(before).length})`);
      }
      if (linked) { delete state.links[linked[0]]; writeState(state); lines.push(`force: the link to ${linked[0]} was removed (the file is kept)`); }
      await driftReport(b, dir!).catch(() => null);
      return { text: lines.join('\n'), changes };
    },
  }),
];

/** The installed code an install replaces (audit before-value): the linked script's, else the same name + namespace's. */
async function codeBefore(b: Browser, mode: 'manager' | 'fast', link: Link | undefined, file: { name: string; namespace: string } | null): Promise<string | null> {
  if (mode !== 'manager') return null;
  let id = link?.mode === 'manager' ? link.id : undefined;
  if (id === undefined && file) id = (await vmScripts(b).catch(() => [])).find((s) => !s.removed && s.name === file.name && s.namespace === file.namespace)?.id;
  return id === undefined ? null : String(await vmSend(b, 'GetScriptCode', id).catch(() => '')) || null;
}

function readCode(rel: string): { name: string; namespace: string } | null {
  try { const m = parseMeta(readScript(path.join(path.resolve(workspace()), rel))); return m ? { name: m.meta.name, namespace: m.meta.namespace } : null; } catch { return null; }
}

function matcherSince(since: string): (seq: number, ts: number) => boolean {
  const c = /^c?(\d+)$/.exec(since);
  if (c) return (seq) => seq > Number(c[1]);
  const rel = /^(\d+)(s|m|h)$/.exec(since);
  const t = rel ? Date.now() - Number(rel[1]) * { s: 1000, m: 60000, h: 3600000 }[rel[2] as 's' | 'm' | 'h'] : Date.parse(since);
  return (_seq, ts) => ts >= t;
}
