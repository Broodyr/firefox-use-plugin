// realms and evaluation: realms_list, eval, inspect_xray.
import { z } from 'zod';
import { evalIn, listRealms, type RealmSpec } from '../browser/realms.js';
import { maskValue } from '../safety/mask.js';
import { fail } from '../errors.js';
import { allowSet } from './privileged.js';
import { tool, tabArg } from './registry.js';

export const realmArg = z.object({
  kind: z.enum(['page', 'userscript', 'content', 'extension', 'privileged', 'worker']),
  extension: z.string().optional().describe('content/extension: id or alias (ubo, vm, companion)'),
  page: z.string().optional().describe('extension: "background" (default) or a page path, e.g. "dashboard.html"'),
  script: z.string().optional().describe('userscript: Violentmonkey script name or id'),
  url: z.string().optional().describe('worker: URL substring'),
}).default({ kind: 'page' }).describe('Realm: {kind:"page"} (default), {kind:"content", extension:"ubo"}, {kind:"extension", extension:"vm", page?}, {kind:"userscript", script}, {kind:"worker", url?}, {kind:"privileged"}');

export const frameArg = z.union([z.number().int().min(0), z.string()]).optional()
  .describe('Frame: index among the tab\'s iframes, URL substring, or the <iframe> ref');

export function toSpec(r: z.infer<typeof realmArg>): RealmSpec {
  switch (r.kind) {
    case 'content': if (!r.extension) fail('BAD_ARGS', 'realm content needs extension'); return { kind: 'content', extension: r.extension! };
    case 'extension': if (!r.extension) fail('BAD_ARGS', 'realm extension needs extension'); return { kind: 'extension', extension: r.extension!, page: r.page };
    case 'userscript': if (!r.script) fail('BAD_ARGS', 'realm userscript needs script'); return { kind: 'userscript', script: r.script! };
    case 'worker': return { kind: 'worker', url: r.url };
    default: return { kind: r.kind } as RealmSpec;
  }
}

/** Rewrite an expression so a sandbox reads the page's (waived) view: window.x -> window.wrappedJSObject.x, x -> window.wrappedJSObject.x */
function waivedExpr(expr: string): string {
  const e = expr.trim();
  if (/^(window|self|globalThis)\b/.test(e)) return e.replace(/^(window|self|globalThis)\b/, 'window.wrappedJSObject');
  if (/^document\b/.test(e)) return e.replace(/^document\b/, 'document.wrappedJSObject');
  if (/^[A-Za-z_$][\w$]*/.test(e)) return `window.wrappedJSObject.${e}`;
  return e;
}

const probe = (expr: string) => `
  try {
    const v = (${expr});
    let own = null;
    return { ok: true, typeof: typeof v, value: v };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }`;

export const realmTools = [
  tool({
    name: 'realms_list',
    description: 'Every JS realm reachable for a tab: page and iframes, each extension\'s content-script sandbox (uBO, Violentmonkey, ...), workers; plus every extension background/page and the privileged realm. Each line shows the realm spec to pass to eval.',
    args: { tab: tabArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      return (await listRealms(b, a.tab)).join('\n');
    },
  }),
  tool({
    name: 'eval',
    description: 'Evaluate JS in a realm and return a serialised result. Code is an expression, or a function body with `return` (await allowed). Realms: page (default), content (an extension\'s content-script sandbox in this tab), extension (background or a page), userscript (Violentmonkey\'s content sandbox), worker, privileged. Xray-wrapped values are labelled; xray:"waive" shows the page-side value.',
    args: {
      code: z.string().min(1),
      realm: realmArg,
      tab: tabArg,
      frame: frameArg,
      await_promise: z.boolean().default(true),
      serialize_depth: z.number().int().min(0).max(8).default(3),
      xray: z.enum(['label', 'waive']).default('label'),
      timeout_ms: z.number().int().positive().max(120000).default(30000),
    },
    write: true,
    unmask: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const r = await evalIn(b, toSpec(a.realm), a.code, { tab: a.tab, frame: a.frame, depth: a.serialize_depth, waive: a.xray === 'waive', awaitPromise: a.await_promise, timeoutMs: a.timeout_ms });
      const v = maskValue(r.value, 0, allowSet(a.unmask));
      const body = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, null, 1);
      return { text: `[${r.realm}] (${r.type}${r.xray ? ', Xray' : ''}) ${body}` };
    },
  }),
  tool({
    name: 'inspect_xray',
    description: 'Explain how an expression resolves on each side of the Xray boundary: in a content-script/userscript sandbox (Xray view), the same sandbox through wrappedJSObject (waived), and the page realm. For "works on the page, undefined in the sandbox" bugs.',
    args: {
      expr: z.string().min(1).describe('Expression, e.g. "window.myLib" or "document.body.dataset"'),
      realm: realmArg.describe('The sandbox realm (content or userscript); default {kind:"userscript"} = Violentmonkey content sandbox'),
      tab: tabArg,
      frame: frameArg,
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const spec = a.realm.kind === 'page' ? { kind: 'content', extension: 'vm' } as RealmSpec : toSpec(a.realm);
      if (spec.kind !== 'content' && spec.kind !== 'userscript') fail('BAD_ARGS', 'inspect_xray compares a content/userscript sandbox with the page');
      const o = { tab: a.tab, frame: a.frame, depth: 1 };
      const run = async (label: string, s: RealmSpec, e: string, waive = false) => {
        try {
          const r = await evalIn(b, s, probe(e), { ...o, waive });
          const v: any = r.value;
          if (!v?.ok) return { label, line: `${label}: throws ${v?.error}`, t: 'throws' };
          return { label, line: `${label}: typeof ${v.typeof} = ${JSON.stringify(maskValue(v.value)).slice(0, 300)}`, t: v.typeof as string };
        } catch (e: any) { return { label, line: `${label}: unavailable (${e.code ?? ''} ${e.message})`, t: 'n/a' }; }
      };
      const w = waivedExpr(a.expr);
      const sandbox = await run('sandbox (Xray view)', spec, a.expr);
      const waived = await run(`sandbox via wrappedJSObject (${w})`, spec, w);
      const page = await run('page realm', { kind: 'page' }, a.expr);
      const lines = [sandbox.line, waived.line, page.line];
      if (sandbox.t === 'undefined' && page.t !== 'undefined' && page.t !== 'throws') {
        lines.push(`=> The page defines it as an expando the Xray view hides. In the sandbox use ${w} (Violentmonkey: unsafeWindow.${a.expr.replace(/^(window|self)\./, '')}). Pass objects into the page with cloneInto() and functions with exportFunction().`);
      } else if (sandbox.t === 'throws' && page.t !== 'throws') {
        lines.push('=> Throws only in the sandbox: often a page-defined object accessed through Xray (methods/properties added by page script are invisible), or a permission/CSP difference.');
      } else if (sandbox.t === page.t) {
        lines.push('=> Same type on both sides; if values differ, page code may have modified a native prototype (Xray shows the native view).');
      }
      return lines.join('\n');
    },
  }),
];
