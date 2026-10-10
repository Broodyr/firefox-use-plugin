// Stylus tools (listed as stylus_read / stylus_write): userstyles from workspace .user.css files, through
// Stylus's own API, with two-way sync and an optional watch mode (save the file, the page restyles live).
import fs from 'node:fs';
import { z } from 'zod';
import { fail } from '../errors.js';
import type { Browser } from '../browser/session.js';
import {
  STYLUS_ID, describeStyle, installStyleFile, matchSummary, pullStyle, readStyleFile, readStyleState, relPath, styleLinkStatuses,
  stylusApi, stylusErrorText, stylusStyle, stylusStyles, stylusSync, styleVersion, writeStyleState, type StyleLink, type StyleState, type StylusStyle,
} from '../adapters/stylus.js';
import { hashOf } from '../adapters/violentmonkey.js';
import { registerUndo } from '../snapshots/undo.js';
import { auditValue } from './privileged.js';
import { tabArg, tool, type Ctx } from './registry.js';

const SCOPE = `ext:${STYLUS_ID}`;
const styleArg = z.union([z.string().min(1), z.number().int().positive()]).describe('Workspace .user.css path, style name, or Stylus id');

interface Resolved { style: StylusStyle; rel?: string; link?: StyleLink }

/** A style by workspace path (linked), name or Stylus id. */
async function resolveStyle(b: Browser, t: string | number, state: StyleState): Promise<Resolved> {
  const ts = String(t).replace(/\\/g, '/');
  const all = await stylusStyles(b);
  for (const [rel, link] of Object.entries(state.links)) {
    if (rel === ts || rel.endsWith('/' + ts) || link.name === ts || String(link.id) === ts) {
      const style = all.find((s) => s.id === link.id);
      if (style) return { style, rel, link };
    }
  }
  const hit = all.find((s) => String(s.id) === ts) ?? all.find((s) => s.name === ts) ?? all.find((s) => s.name.toLowerCase() === ts.toLowerCase());
  if (hit) return { style: hit };
  return fail('STYLE_NOT_FOUND', `no Stylus style matching ${JSON.stringify(t)}`, 'stylus_read(kind: "list") shows the installed styles and their workspace files.');
}

const statusTag = (st?: string) => (st && st !== 'synced' ? ` [${st.toUpperCase()}]` : '');

/** The vars of a usercss style: name = value (default), for the source header and stylus_vars. */
function varsLine(s: StylusStyle): string {
  const v = s.usercssData?.vars;
  if (!v || typeof v !== 'object' || !Object.keys(v).length) return '';
  return Object.entries(v).map(([k, x]: [string, any]) => `${k} = ${JSON.stringify(x.value ?? x.default)}${x.value !== undefined && x.value !== x.default ? ` (default ${JSON.stringify(x.default)})` : ''}`).join(', ');
}

// ------------------------------------------------------------ undo handlers
registerUndo('stylus_style', async (b, c) => {
  const id = Number(c.path);
  if (c.before == null) {
    await stylusApi(b, 'styles.remove', [id]);
    return { line: `Stylus #${id} (newly installed) removed`, change: { kind: 'stylus_removed', path: c.path, before: null, after: true } };
  }
  if (typeof c.before !== 'string') fail('UNDO_UNAVAILABLE', `Stylus #${id}: the previous code was too large to keep in the audit log`, 'restore a snapshot instead (part "stylus").');
  const cur = await stylusStyle(b, id);
  await stylusApi(b, 'usercss.install', [{ id, sourceCode: c.before }]);
  return { line: `Stylus #${id} code -> previous version`, change: { kind: 'stylus_style', path: c.path, before: auditValue(cur?.sourceCode ?? null), after: auditValue(c.before) } };
});
registerUndo('stylus_enabled', async (b, c) => {
  await stylusApi(b, 'styles.config', [Number(c.path), 'enabled', !!c.before]);
  return { line: `Stylus #${c.path} -> ${c.before ? 'enabled' : 'disabled'}`, change: { kind: 'stylus_enabled', path: c.path, before: !c.before, after: !!c.before } };
});
registerUndo('stylus_removed', async (b, c) => {
  if (!c.before || typeof c.before !== 'object' || (c.before as any).$large) fail('UNDO_UNAVAILABLE', `Stylus #${c.path}: the removed style was too large to keep in the audit log`, 'restore a snapshot instead (part "stylus").');
  await stylusApi(b, 'styles.importMany', [[c.before]]);
  return { line: `Stylus #${c.path} "${(c.before as StylusStyle).name}" put back`, change: { kind: 'stylus_style', path: c.path, before: null, after: '(undo of a removal)' } };
});
registerUndo('stylus_vars', async (b, c) => {
  const id = Number(c.path);
  await stylusApi(b, 'usercss.configVars', [id, c.before]);
  return { line: `Stylus #${id} variables -> previous values`, change: { kind: 'stylus_vars', path: c.path, before: c.after, after: c.before } };
});

async function scoped(ctx: Ctx): Promise<Browser> {
  const b = await ctx.browser();
  await ctx.requireScope(SCOPE, b);
  return b;
}

export const stylusTools = [
  tool({
    name: 'stylus_list',
    description: 'Stylus styles: id, name, version, enabled, usercss or classic, where each applies (domains, URL prefixes, regexps), and the workspace .user.css file it is linked to, with its sync status and whether it is watched.',
    args: {},
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const state = readStyleState();
      const all = await stylusStyles(b);
      const sts = await styleLinkStatuses(b, state).catch(() => []);
      const sync = stylusSync(b);
      sync.ensure();
      const watched = new Set(sync.watching());
      if (!all.length) return 'Stylus: no styles installed. Write a .user.css in the workspace (e.g. styles/x.user.css), then stylus_write(action: "install", path).';
      return [`Stylus: ${all.length} style(s)`, ...all.map((s) => {
        const st = sts.find((x) => x.link.id === s.id);
        return `#${s.id} "${s.name}"${styleVersion(s) ? ` ${styleVersion(s)}` : ''} · ${s.enabled ? 'enabled' : 'disabled'} · ${s.usercssData ? 'usercss' : 'classic'} · ${matchSummary(s.sections)}`
          + (st ? ` · file ${st.rel}${statusTag(st.status)}${watched.has(st.rel) ? ' [watching]' : ''}${st.link.lastPush && !st.link.lastPush.ok ? ` [last push FAILED: ${st.link.lastPush.message.split('\n')[0]}]` : ''}` : '');
      })].join('\n');
    },
  }),
  tool({
    name: 'stylus_source',
    description: 'One Stylus style\'s code: the usercss source (with its variables and their values in the header), or the sections of a classic style.',
    args: { style: styleArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const r = await resolveStyle(b, a.style, readStyleState());
      const s = (await stylusStyle(b, r.style.id)) ?? fail('STYLE_NOT_FOUND', `Stylus #${r.style.id} is gone`);
      const head = `${describeStyle(s)} · ${s.enabled ? 'enabled' : 'disabled'}${r.rel ? ` · file ${r.rel}` : ''}${varsLine(s) ? `\nvariables: ${varsLine(s)}` : ''}`;
      if (s.sourceCode) return `${head}\n\n${s.sourceCode}`;
      return `${head}\n\n${(s.sections ?? []).map((x) => `/* ${matchSummary([x], 20)} */\n${x.code ?? ''}`).join('\n\n')}`;
    },
  }),
  tool({
    name: 'stylus_for_url',
    description: 'Which Stylus styles match a URL (default: the tab\'s page) and whether each applies there: enabled, excluded, empty sections, toggled for the tab. With a tab, also how many Stylus sheets are injected in its page right now.',
    args: { url: z.string().optional().describe('URL to check (default: the tab\'s URL)'), tab: tabArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      let url = a.url;
      let page: { url: string; elements: number; adopted: number } | null = null;
      if (!url || a.tab) {
        page = await b.callPage(await b.context(a.tab), `() => ({ url: location.href, elements: document.querySelectorAll('style.stylus').length, adopted: [...(document.adoptedStyleSheets || [])].filter((s) => /^screen, /.test(s.media.mediaText)).length })`);
        url ??= page!.url;
      }
      const res = await stylusApi<any[]>(b, 'styles.getByUrl', [url]);
      const lines = [`${res.length} Stylus style(s) match ${url}`];
      for (const r of res) {
        const s = r.style as StylusStyle;
        const why = !s.enabled ? 'disabled' : r.excluded ? 'excluded by its exclusions' : r.excludedScheme ? 'not for the current color scheme' : r.empty ? 'matches, but the matching sections are empty' : r.tabOvr === false ? 'turned off for this tab' : 'APPLIES';
        lines.push(`#${s.id} "${s.name}"${styleVersion(s) ? ` ${styleVersion(s)}` : ''}: ${why}${r.sloppy ? ' (sloppy regexp match)' : ''}`);
      }
      if (page) lines.push(`in the page now: ${page.elements} <style class="stylus"> element(s)${page.adopted ? `, ${page.adopted} adopted sheet(s) (strict CSP)` : ''}`);
      return lines.join('\n');
    },
  }),
  tool({
    name: 'stylus_check',
    description: 'Parse and compile a workspace .user.css the way Stylus would, without installing it: errors as file:line:col with the offending text, or its sections, where they apply, preprocessor messages, and which installed style an install would update.',
    args: { path: z.string().min(1).describe('Workspace .user.css file') },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const { abs, rel } = relPath(a.path);
      let r: { style: StylusStyle; dup?: StylusStyle; logs?: unknown[] };
      try { r = await stylusApi(b, 'usercss.build', [readStyleFile(abs), { strict: true }]); } catch (e) {
        return fail('STYLE_INVALID', stylusErrorText(e, rel), 'Nothing was installed. Fix the file and check again.');
      }
      const logs = (r.logs ?? []).flat().filter(Boolean).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
      return [
        `OK ${rel}: "${r.style.name}" ${styleVersion(r.style) || '(no version)'} · ${r.style.sections?.length ?? 0} section(s): ${matchSummary(r.style.sections)}`,
        r.dup ? `an install updates ${describeStyle(r.dup)}` : 'an install adds a new style',
        ...(logs.length ? [`preprocessor: ${logs.join('; ')}`] : []),
      ].join('\n');
    },
  }),
  tool({
    name: 'stylus_sync_status',
    description: 'Linked .user.css files vs Stylus: synced, changed on disk, changed in Stylus\'s editor, changed on both (conflict), missing; and which files are watched.',
    args: {},
    async handler(_a, ctx) {
      const b = await ctx.browser();
      const sts = await styleLinkStatuses(b, readStyleState());
      const sync = stylusSync(b);
      sync.ensure();
      if (!sts.length) return 'no linked styles (stylus_write(action: "install", path) links a workspace file)';
      const watched = new Set(sync.watching());
      return [...sts.map((s) => `${s.rel} <-> Stylus #${s.link.id} "${s.link.name}": ${s.status}${s.link.conflict ? ` (conflict file ${s.link.conflict.file})` : ''}${watched.has(s.rel) ? ' [watching]' : ''}`), ...(sync.lastError ? [`last background sync error: ${sync.lastError}`] : [])].join('\n');
    },
  }),
  tool({
    name: 'stylus_install',
    description: 'Install or update a workspace .user.css in Stylus (its own usercss install: metadata, preprocessors and @var as in production). Updates the linked style, else the one with the same @name + @namespace, else adds a style; links the file for two-way sync. Open tabs restyle at once (no reload). watch:true also pushes every save of the file. Needs scope "ext:stylus".',
    args: { path: z.string().min(1).describe('Workspace .user.css file, e.g. styles/x.user.css'), watch: z.boolean().default(false).describe('Push the file to Stylus on every save, so the page restyles live') },
    write: true,
    async handler(a, ctx) {
      const b = await scoped(ctx);
      const state = readStyleState();
      const r = await installStyleFile(b, a.path, state, { watch: a.watch || undefined });
      stylusSync(b).ensure();
      return { text: [...r.lines, ...(r.link.watch ? [`  watching ${r.rel}: every save is pushed; a parse error is reported in the next result and the previous version stays applied`] : [])].join('\n'),
        changes: [{ kind: 'stylus_style', path: String(r.style.id), before: r.before ? auditValue(r.before.sourceCode ?? null) : null, after: `(${r.rel})` }] };
    },
  }),
  tool({
    name: 'stylus_update',
    description: 'Push a linked .user.css to Stylus again after editing it (by file, style name or id). Needs scope "ext:stylus".',
    args: { style: styleArg },
    write: true,
    async handler(a, ctx) {
      const b = await scoped(ctx);
      const state = readStyleState();
      let rel = Object.keys(state.links).find((r) => r === String(a.style).replace(/\\/g, '/'));
      if (!rel) { const res = await resolveStyle(b, a.style, state); rel = res.rel; }
      if (!rel) fail('NOT_LINKED', `${JSON.stringify(a.style)} is not linked to a workspace file`, 'stylus_write(action: "install", path) links one.');
      const r = await installStyleFile(b, rel!, state);
      return { text: r.lines.join('\n'), changes: [{ kind: 'stylus_style', path: String(r.style.id), before: r.before ? auditValue(r.before.sourceCode ?? null) : null, after: `(${r.rel})` }] };
    },
  }),
  tool({
    name: 'stylus_set_enabled',
    description: 'Enable or disable a Stylus style (open tabs update at once). Audited, undo-able. Needs scope "ext:stylus".',
    args: { style: styleArg, enabled: z.boolean() },
    write: true,
    async handler(a, ctx) {
      const b = await scoped(ctx);
      const r = await resolveStyle(b, a.style, readStyleState());
      await stylusApi(b, 'styles.config', [r.style.id, 'enabled', a.enabled]);
      return { text: `${describeStyle(r.style)}: ${r.style.enabled ? 'enabled' : 'disabled'} -> ${a.enabled ? 'enabled' : 'disabled'}`, changes: [{ kind: 'stylus_enabled', path: String(r.style.id), before: r.style.enabled, after: a.enabled }] };
    },
  }),
  tool({
    name: 'stylus_uninstall',
    description: 'Remove a style from Stylus (undo-able while it fits the audit log; snapshots keep it too). The workspace file is kept and unlinked. Needs scope "ext:stylus".',
    args: { style: styleArg },
    write: true,
    async handler(a, ctx) {
      const b = await scoped(ctx);
      const state = readStyleState();
      const r = await resolveStyle(b, a.style, state);
      const full = await stylusStyle(b, r.style.id);
      await stylusApi(b, 'styles.remove', [r.style.id]);
      if (r.rel) { delete state.links[r.rel]; writeStyleState(state); stylusSync(b).ensure(); }
      return { text: `${describeStyle(r.style)} removed from Stylus${r.rel ? ` (file ${r.rel} kept, no longer linked)` : ''}`, changes: [{ kind: 'stylus_removed', path: String(r.style.id), before: auditValue(full), after: true }] };
    },
  }),
  tool({
    name: 'stylus_vars',
    description: 'Set a usercss style\'s @var values ({name: value}), as its configure dialog does; open tabs update at once. stylus_read(kind: "source") lists the variables. Undo-able. Needs scope "ext:stylus".',
    args: { style: styleArg, values: z.record(z.string(), z.any()).describe('Variable name -> value, e.g. {"accent": "#ff0066"}') },
    write: true,
    async handler(a, ctx) {
      const b = await scoped(ctx);
      const r = await resolveStyle(b, a.style, readStyleState());
      const s = await stylusStyle(b, r.style.id);
      const vars = s?.usercssData?.vars;
      if (!vars || typeof vars !== 'object' || !Object.keys(vars).length) fail('NO_VARS', `${describeStyle(r.style)} has no @var variables`);
      const before = JSON.parse(JSON.stringify(vars));
      const unknown = Object.keys(a.values).filter((k) => !(k in (vars as object)));
      if (unknown.length) fail('BAD_ARGS', `unknown variable(s): ${unknown.join(', ')}`, `variables: ${Object.keys(vars as object).join(', ')}`);
      const next = JSON.parse(JSON.stringify(vars));
      for (const [k, v] of Object.entries(a.values)) next[k].value = v;
      await stylusApi(b, 'usercss.configVars', [r.style.id, next]);
      return { text: `${describeStyle(r.style)}: ${Object.entries(a.values).map(([k, v]) => `${k}: ${JSON.stringify((vars as any)[k].value ?? (vars as any)[k].default)} -> ${JSON.stringify(v)}`).join(', ')}`,
        changes: [{ kind: 'stylus_vars', path: String(r.style.id), before, after: next }] };
    },
  }),
  tool({
    name: 'stylus_sync',
    description: 'Sync linked .user.css files with Stylus: "push" (files -> Stylus), "pull" (Stylus\'s editor -> files), "auto" (each the way it changed). A style changed on both sides is never overwritten: Stylus\'s version is saved as <file>.stylus-conflict (force:true on pull overwrites the file instead). Edits in Stylus\'s editor are also pulled automatically into unchanged files every few seconds. Needs scope "ext:stylus" to push.',
    args: { direction: z.enum(['push', 'pull', 'auto']).default('auto'), force: z.boolean().default(false) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const state = readStyleState();
      const lines: string[] = [];
      const changes: { kind: string; path: string; before?: unknown; after?: unknown }[] = [];
      for (const st of await styleLinkStatuses(b, state)) {
        const push = st.status === 'file changed' || (a.direction === 'push' && (st.status === 'both changed' || st.status === 'conflict' || st.status === 'stylus changed'));
        const pull = st.status === 'stylus changed' || (a.direction === 'pull' && (st.status === 'both changed' || st.status === 'conflict'));
        if (a.direction !== 'pull' && push && st.status !== 'missing in stylus') {
          await ctx.requireScope(SCOPE, b);
          const r = await installStyleFile(b, st.rel, state);
          lines.push(r.lines[0]);
          changes.push({ kind: 'stylus_style', path: String(r.style.id), before: r.before ? auditValue(r.before.sourceCode ?? null) : null, after: `(${st.rel})` });
        } else if (a.direction !== 'push' && pull) {
          lines.push(pullStyle(st, state, a.force));
          changes.push({ kind: 'file', path: st.rel, after: '(pulled from Stylus)' });
        } else if (st.status === 'both changed' || st.status === 'conflict') {
          lines.push(pullStyle(st, state));
        } else lines.push(`${st.rel}: ${st.status}`);
      }
      stylusSync(b).ensure();
      return { text: lines.join('\n') || 'no linked styles', changes };
    },
  }),
  tool({
    name: 'stylus_watch',
    description: 'Watch a linked .user.css: every save is pushed to Stylus, so the page restyles live while you edit (a parse error is reported in the next tool result; the previous version stays applied). on:false stops. Needs scope "ext:stylus".',
    args: { style: styleArg, on: z.boolean().default(true) },
    write: true,
    async handler(a, ctx) {
      const b = await scoped(ctx);
      const state = readStyleState();
      let rel = Object.keys(state.links).find((r) => r === String(a.style).replace(/\\/g, '/'));
      if (!rel) rel = (await resolveStyle(b, a.style, state)).rel;
      if (!rel) fail('NOT_LINKED', `${JSON.stringify(a.style)} is not linked to a workspace file`, 'stylus_write(action: "install", path, watch: true) links and watches one.');
      state.links[rel!].watch = a.on;
      writeStyleState(state);
      const sync = stylusSync(b);
      sync.ensure();
      // a file edited before the watch started is pushed now, so the page matches the file
      const pending = a.on && fs.existsSync(relPath(rel!).abs) && hashOf(readStyleFile(relPath(rel!).abs)) !== state.links[rel!].fileHash;
      let extra = '';
      if (pending) { try { extra = `\n${(await installStyleFile(b, rel!, readStyleState(), { watch: true })).lines[0]}`; } catch (e: any) { extra = `\npush FAILED: ${e.message}`; } }
      return `${a.on ? 'watching' : 'stopped watching'} ${rel}${extra}`;
    },
  }),
];
