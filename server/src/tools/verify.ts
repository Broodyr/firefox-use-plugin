// verify: the inner loop after every edit. Reload (or navigate), wait, evaluate checks, and report
// in one call: new errors (every realm, with stacks), uBO activity on the tab, userscript activity, an
// accessibility-tree diff before -> after, and screenshots when asked (or when a check fails).
import { z } from 'zod';
import type { Browser } from '../browser/session.js';
import { evalIn, type RealmSpec } from '../browser/realms.js';
import { renderUboEntry, uboLogger, UBO_ID } from '../adapters/ubo.js';
import { mapVmStacks } from '../adapters/violentmonkey.js';
import { pageTools } from './page.js';
import { renderEntries } from './console.js';
import { tool, tabArg, type Ctx, type ToolOutput } from './registry.js';

const realmArg = z.object({
  kind: z.enum(['page', 'userscript', 'content', 'extension', 'privileged', 'worker']),
  extension: z.string().optional(), page: z.string().optional(), script: z.string().optional(), url: z.string().optional(),
});

const checkArg = z.union([
  z.string().min(1).describe('JS expression in the page; passes when truthy'),
  z.object({ expr: z.string().min(1), realm: realmArg.optional(), name: z.string().optional(), equals: z.any().optional() }),
  z.object({ selector: z.string().min(1), state: z.enum(['present', 'absent', 'visible', 'hidden']).default('present'), name: z.string().optional() }),
  z.object({ text: z.string().min(1), absent: z.boolean().default(false), name: z.string().optional() }),
]);

type Check = z.infer<typeof checkArg>;

const handler = (name: string) => pageTools.find((t) => t.name === name)!.handler;

/** Accessibility tree as lines without ref ids, for a text diff across a reload (refs never survive one). */
async function a11yLines(ctx: Ctx, tab?: number): Promise<string[]> {
  const out = await handler('read_page')({ tab, filter: 'all', detail: 'summary', max_chars: 1e9 }, ctx) as string;
  return out.split('\n').filter((l) => !/· snap_\d+/.test(l)).map((l) => l.replace(/\[ref_\d+\] /, '').trim()).filter(Boolean);
}

function multisetDiff(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  const added: string[] = [];
  for (const x of b) { const n = count.get(x) ?? 0; if (n > 0) count.set(x, n - 1); else added.push(x); }
  const removed: string[] = [];
  for (const [x, n] of count) for (let i = 0; i < n; i++) removed.push(x);
  return { added, removed };
}

async function runCheck(b: Browser, c: Check, tab: number | undefined): Promise<{ name: string; pass: boolean; value: string }> {
  try {
    if (typeof c === 'string' || 'expr' in c) {
      const expr = typeof c === 'string' ? c : c.expr;
      const realm = (typeof c === 'string' ? { kind: 'page' } : c.realm ?? { kind: 'page' }) as RealmSpec;
      const r = await evalIn(b, realm, expr, { tab, depth: 2, timeoutMs: 10000 });
      const v = r.value;
      const pass = typeof c !== 'string' && 'equals' in c && c.equals !== undefined ? JSON.stringify(v) === JSON.stringify(c.equals) : !!v && v !== '[undefined]';
      return { name: (typeof c !== 'string' && c.name) || expr, pass, value: JSON.stringify(v)?.slice(0, 160) ?? 'undefined' };
    }
    const ctxId = await b.context(tab);
    if ('selector' in c) {
      const st = await b.callPage(ctxId, `(sel) => { const el = document.querySelector(sel); if (!el) return { n: 0 }; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { n: document.querySelectorAll(sel).length, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }; }`, [c.selector]);
      const pass = c.state === 'present' ? st.n > 0 : c.state === 'absent' ? st.n === 0 : c.state === 'visible' ? st.n > 0 && st.visible : st.n === 0 || !st.visible;
      return { name: c.name ?? `${c.selector} ${c.state}`, pass, value: st.n ? `${st.n} match(es), ${st.visible ? 'visible' : 'not visible'}` : 'no match' };
    }
    const has = await b.callPage(ctxId, '(t) => (document.body ? document.body.innerText : "").includes(t)', [c.text]);
    return { name: c.name ?? `text ${JSON.stringify(c.text)}${c.absent ? ' absent' : ''}`, pass: c.absent ? !has : has, value: has ? 'found' : 'not found' };
  } catch (e: any) {
    return { name: typeof c === 'string' ? c : (c as any).name ?? (c as any).expr ?? (c as any).selector ?? (c as any).text, pass: false, value: `threw: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

export const verifyTools = [
  tool({
    name: 'verify',
    description: 'The inner loop after every edit: reload the tab (or navigate to url), wait, evaluate checks, and report in ONE call — pass/fail per check, new console errors from every realm (page, userscripts, uBO, extensions) with stacks, uBO logger activity on the tab (blocks, cosmetic hides, scriptlet injections), userscript activity, and an accessibility-tree diff before -> after. Checks: JS expressions (truthy = pass), {expr, realm?, equals?}, {selector, state}, {text, absent?}. Screenshots: on_fail (default), after, both, none.',
    args: {
      url: z.string().optional().describe('Navigate here; default: reload the current page'),
      checks: z.array(checkArg).default([]),
      tab: tabArg,
      wait: z.enum(['load', 'networkidle']).default('load'),
      wait_for: z.string().optional().describe('CSS selector to wait for after the load'),
      settle_ms: z.number().int().min(0).max(10000).default(300).describe('Extra time for late scripts (document-idle userscripts, timers)'),
      screenshots: z.enum(['on_fail', 'after', 'both', 'none']).default('on_fail'),
      dom_diff: z.boolean().default(true),
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const images: ToolOutput['images'] = [];
      const uboOn = (b.versions ?? await b.versionsInfo()).addons?.some((x: any) => x.id === UBO_ID && x.active);
      const log = uboOn ? uboLogger(b) : null;
      if (log) { await log.touch().catch(() => {}); await log.poll().catch(() => {}); }
      const before = a.dom_diff ? await a11yLines(ctx, a.tab).catch(() => null) : null;
      if (a.screenshots === 'both') images.push(...(((await handler('screenshot')({ tab: a.tab }, ctx)) as ToolOutput).images ?? []));
      const c0 = d.cursor, u0 = log?.cursor ?? 0;
      const t0 = Date.now();
      const nav = await handler('navigate')({ url: a.url ?? 'reload', tab: a.tab, wait: a.wait, timeout_ms: 30000 }, ctx) as ToolOutput | string;
      const navText = typeof nav === 'string' ? nav : nav.text;
      const loadMs = Date.now() - t0;
      let waitNote = '';
      if (a.wait_for) {
        const ctxId = await b.context(a.tab);
        const ok = await b.callPage(ctxId, `(sel, ms) => new Promise((res) => { if (document.querySelector(sel)) return res(true); const mo = new MutationObserver(() => { if (document.querySelector(sel)) { mo.disconnect(); res(true); } }); mo.observe(document, { childList: true, subtree: true, attributes: true }); setTimeout(() => { mo.disconnect(); res(false); }, ms); })`, [a.wait_for, 10000]);
        if (!ok) waitNote = `wait_for ${a.wait_for}: not found within 10 s`;
      }
      if (a.settle_ms) await new Promise((r) => setTimeout(r, a.settle_ms));
      // dev userscripts that started on this URL at the previous verify: give them up to 3 s more (Violentmonkey's
      // content-mode injection waits on its background, slow under load; checks run too early were a false fail)
      const docKey = navText.split('\n')[0].replace(/^.* — /, '').replace(/#.*$/, '');
      const startsMap = (b.adapters.get('verifyStarts') as Map<string, string[]> | undefined) ?? new Map<string, string[]>();
      b.adapters.set('verifyStarts', startsMap);
      const started = () => new Set(d.log.filter((e) => e.seq > c0 && e.text.startsWith('[claude-start] ')).map((e) => { try { return String(JSON.parse(e.text.slice(15)).script); } catch { return ''; } }));
      const expected = startsMap.get(docKey) ?? [];
      const tw = Date.now();
      while (expected.some((s) => !started().has(s)) && Date.now() - tw < 3000) await new Promise((r) => setTimeout(r, 100));
      const startedNow = started();
      const missing = expected.filter((s) => !startedNow.has(s));
      const waitedMs = Date.now() - tw;
      startsMap.set(docKey, [...startedNow]);
      const results = [];
      for (const c of a.checks) results.push(await runCheck(b, c, a.tab));
      const passed = results.filter((r) => r.pass).length;
      const failed = results.length - passed;
      const ctxId = await b.context(a.tab);
      const tabHandle = Number(Object.entries(b.state.tabs ?? {}).find(([, v]) => v === ctxId)?.[0]);
      const tabBc = [...b.bcTab.entries()].find(([, h]) => h === tabHandle)?.[0];
      const collect = () => {
        const mine = d.log.filter((e) => e.seq > c0).filter((e) => e.bc === undefined || tabBc === undefined || e.bc === tabBc || e.source === 'extension' || e.source === 'browser');
        return { mine, errors: mine.filter((e) => e.level === 'error' && !(e.source === 'browser' && (/AboutNewTab|FaviconLoader/.test(e.text) || /^(chrome:\/\/remote\/|resource:\/\/gre\/modules\/EventEmitter)/.test(e.url ?? '')))) };
      };
      // a failed check usually has an error behind it, and console capture is asynchronous (seconds on a loaded
      // machine): give it up to 1.5 s before reporting "0 new errors"
      for (const te = Date.now(); failed && !collect().errors.length && Date.now() - te < 1500;) await new Promise((r) => setTimeout(r, 100));
      const { mine, errors } = collect();
      const lines: string[] = [];
      const url = navText.split('\n')[0];
      lines.push(`verify ${url} — ${results.length ? `${passed}/${results.length} check(s) passed` : 'no checks'} · loaded in ${loadMs} ms · ${errors.length} new error(s)`);
      if (waitNote) lines.push(waitNote);
      if (missing.length) lines.push(`NOTE: dev userscript(s) that started here at the previous verify did not start this time (waited 3 s): ${missing.join(', ')}. Disabled, @match changed, or a failed install? us_read(kind: "list" | "logs").`);
      else if (expected.length && waitedMs > 150) lines.push(`(waited ${waitedMs} ms for dev userscript(s) ${expected.join(', ')} to start)`);
      for (const r of results) lines.push(`${r.pass ? '✔' : '✖'} ${r.name} → ${r.value}`);
      // Violentmonkey positions -> workspace file lines, as console_read and us_read(kind: "logs") show them
      const labelled = <T extends (typeof mine)[number]>(xs: T[]) => { const out = xs.map((e) => ({ ...e, realm: d.realmLabel(e) })); return b.personal ? out : mapVmStacks(b, out); };
      if (errors.length) lines.push('errors:', ...renderEntries(await labelled(errors), 'normal', 10));
      const us = mine.filter((e) => e.realm.startsWith('content:Violentmonkey') || e.realm.startsWith('userscript:') || e.text.startsWith('[claude-mark]'));
      if (us.length) lines.push(`userscript activity (${us.length}):`, ...renderEntries(await labelled(us), 'summary', 8));
      if (log) {
        await log.poll().catch(() => {});
        const ue = log.entries.filter((e) => e.seq > u0 && (e.tab === undefined || e.tab === tabHandle));
        if (ue.length) {
          const by = (v: string) => ue.filter((e) => e.verdict === v).reduce((n, e) => n + e.count, 0);
          const inj = ue.filter((e) => e.verdict === 'injected');
          lines.push(`uBO: ${by('blocked')} blocked, ${by('allowed')} allowed, ${by('modified')} modified, ${by('hidden')} cosmetic, ${inj.length} scriptlet injection(s)${log.conflict ? ' (logger busy elsewhere)' : ''}`);
          for (const e of [...inj, ...ue.filter((x) => x.realm === 'message' && /scriptlet|error|fail/i.test(x.text ?? ''))].slice(0, 8)) lines.push(`  ${renderUboEntry(e)}`);
        }
      }
      if (before) {
        const after = await a11yLines(ctx, a.tab).catch(() => null);
        if (after) {
          const df = multisetDiff(before, after);
          if (df.added.length || df.removed.length) {
            lines.push(`DOM (a11y) before -> after: +${df.added.length} -${df.removed.length}`);
            for (const x of df.added.slice(0, 15)) lines.push(`  + ${x}`);
            for (const x of df.removed.slice(0, 15)) lines.push(`  - ${x}`);
            if (df.added.length + df.removed.length > 30) lines.push('  …');
          } else lines.push('DOM (a11y) before -> after: unchanged');
        }
      }
      if (a.screenshots === 'after' || a.screenshots === 'both' || (a.screenshots === 'on_fail' && (failed || errors.length))) {
        const shot = (await handler('screenshot')({ tab: a.tab }, ctx)) as ToolOutput;
        images.push(...(shot.images ?? []));
        lines.push(`screenshot${a.screenshots === 'both' ? 's (before, after)' : ''}: ${shot.text.split('\n').find((l) => l.startsWith('saved:')) ?? ''}`);
      }
      lines.push(`cursors: console c${d.cursor}${log ? ` · uBO u${log.cursor}` : ''}`);
      if (results.length && failed === results.length && !errors.length && !us.length) lines.push('hint: every check failed and no userscript ran: is the script\'s @match right for this URL (ports!), and enabled? us_list / us_logs.');
      return { text: lines.join('\n'), images };
    },
  }),
];
