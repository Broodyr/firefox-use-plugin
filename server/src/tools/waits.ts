// waits. All take timeout_ms (default 10000); on timeout they fail with TIMEOUT and report what DID
// happen: current URL/state and the console errors that arrived during the wait.
import { z } from 'zod';
import { evalIn } from '../browser/realms.js';
import { sleep } from '../browser/launcher.js';
import type { Browser } from '../browser/session.js';
import { ToolError } from '../errors.js';
import { matcher, queryConsole, renderEntries, sourcesArg } from './console.js';
import { netLine, queryNet } from './network.js';
import { frameArg, realmArg, toSpec } from './realms.js';
import { tool, tabArg } from './registry.js';

const timeoutArg = z.number().int().positive().max(300000).default(10000);

async function timeoutError(b: Browser, what: string, tab: number | undefined, startSeq: number, extra: Record<string, unknown> = {}): Promise<never> {
  const context: Record<string, unknown> = { ...extra };
  try {
    const ctx = await b.context(tab);
    context.page = await b.callPage(ctx, '() => `${document.title} — ${location.href} (readyState ${document.readyState})`');
  } catch { /* no page */ }
  try {
    const errs = await queryConsole(b, { since: `c${startSeq}`, level: 'error' });
    if (errs.length) context.errorsDuringWait = renderEntries(errs, 'summary', 5);
  } catch { /* no devtools */ }
  throw new ToolError('TIMEOUT', `timed out waiting for ${what}`, 'Check the page state below; raise timeout_ms or wait for something else.', context);
}

async function startCursor(b: Browser): Promise<number> {
  try { return (await b.hub()).cursor; } catch { return 0; }
}

/** In-page wait using a MutationObserver plus polling (CSS visibility changes don't mutate the DOM). */
const SELECTOR_WAIT = `(selector, state, timeout) => new Promise((resolve) => {
  const t0 = Date.now();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  let mo, iv, done = false;
  const check = () => {
    if (done) return;
    let els;
    try { els = document.querySelectorAll(selector); } catch (e) { finish({ error: String(e.message) }); return; }
    const n = els.length;
    const ok = state === 'attached' ? n > 0 : state === 'detached' ? n === 0 : [...els].some(visible);
    if (ok) finish({ ok: true, count: n, ms: Date.now() - t0, html: n ? els[0].outerHTML.slice(0, 200) : '' });
    else if (Date.now() - t0 > timeout) finish({ ok: false, count: n, visible: [...els].filter(visible).length });
  };
  const finish = (r) => { done = true; mo && mo.disconnect(); clearInterval(iv); resolve(r); };
  mo = new MutationObserver(check);
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: false });
  iv = setInterval(check, 100);
  check();
})`;

const TEXT_WAIT = `(pattern, flags, isRe, timeout) => new Promise((resolve) => {
  const t0 = Date.now();
  const re = isRe ? new RegExp(pattern, flags) : null;
  const iv = setInterval(check, 100);
  function check() {
    const t = document.body ? document.body.innerText : '';
    const hit = re ? re.exec(t) : (t.toLowerCase().includes(pattern.toLowerCase()) ? [pattern] : null);
    if (hit) { clearInterval(iv); resolve({ ok: true, match: String(hit[0]).slice(0, 200), ms: Date.now() - t0 }); }
    else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve({ ok: false, text: t.slice(0, 300) }); }
  }
  check();
})`;

/** Retry an in-page wait across navigations (the document may be replaced while waiting). */
async function pageWait(b: Browser, tab: number | undefined, fn: string, args: unknown[], timeoutMs: number): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const left = timeoutMs - (Date.now() - t0);
    if (left <= 0) return { ok: false };
    try {
      const ctx = await b.context(tab);
      const r = await b.callPage(ctx, fn, [...args, left], { awaitPromise: true });
      if (r?.error) throw new ToolError('BAD_ARGS', r.error);
      return r;
    } catch (e: any) {
      if (e instanceof ToolError && e.code === 'BAD_ARGS') throw e;
      // context discarded by a navigation: try again in the new document
      await sleep(100);
    }
  }
}

export const waitTools = [
  tool({
    name: 'wait_for_selector',
    description: 'Wait until a CSS selector is attached, visible or detached in the page (or a frame).',
    args: { selector: z.string().min(1), state: z.enum(['attached', 'visible', 'detached']).default('attached'), tab: tabArg, frame: frameArg, timeout_ms: timeoutArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const seq = await startCursor(b);
      let r: any;
      if (a.frame !== undefined) {
        r = await evalIn(b, { kind: 'page' }, `return await (${SELECTOR_WAIT})(${JSON.stringify(a.selector)}, ${JSON.stringify(a.state)}, ${a.timeout_ms});`, { tab: a.tab, frame: a.frame, timeoutMs: a.timeout_ms + 5000 }).then((x) => x.value);
      } else {
        r = await pageWait(b, a.tab, SELECTOR_WAIT, [a.selector, a.state], a.timeout_ms);
      }
      if (!r?.ok) return timeoutError(b, `${a.selector} to be ${a.state}`, a.tab, seq, { matches: r?.count ?? 0, visibleMatches: r?.visible });
      return `${a.selector} ${a.state} after ${r.ms} ms (${r.count} match${r.count === 1 ? '' : 'es'})${r.html ? `\n${r.html}` : ''}`;
    },
  }),
  tool({
    name: 'wait_for_text',
    description: 'Wait until the page\'s visible text contains a string (case-insensitive) or matches /regex/flags.',
    args: { text: z.string().min(1), tab: tabArg, timeout_ms: timeoutArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const seq = await startCursor(b);
      const m = /^\/(.+)\/([a-z]*)$/.exec(a.text);
      const r = await pageWait(b, a.tab, TEXT_WAIT, m ? [m[1], m[2], true] : [a.text, '', false], a.timeout_ms);
      if (!r?.ok) return timeoutError(b, `text ${a.text}`, a.tab, seq, r?.text ? { pageTextStart: r.text } : {});
      return `found ${JSON.stringify(r.match)} after ${r.ms} ms`;
    },
  }),
  tool({
    name: 'wait_for_console',
    description: 'Wait for a console entry (any realm: page, content scripts, extensions, workers, Browser Console) matching a pattern. Only entries after the call starts count, unless since is given.',
    args: {
      pattern: z.string().min(1).describe('Substring or /regex/'),
      level: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional(),
      realm: z.string().optional().describe('Realm label filter, e.g. "content:Violentmonkey", "extension:", "page"'),
      sources: sourcesArg,
      tab: tabArg,
      since: z.string().optional().describe('Cursor "c123" to also accept earlier entries'),
      timeout_ms: timeoutArg,
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const seq = d.cursor;
      const since = a.since ?? `c${seq}`;
      const t0 = Date.now();
      for (;;) {
        const hits = await queryConsole(b, { pattern: a.pattern, level: a.level, realm: a.realm, sources: a.sources ?? ['page', 'content', 'extension', 'worker', 'browser'], tab: a.tab, since });
        if (hits.length) return `${renderEntries(hits.slice(0, 1), 'normal', 1)[0]}\nafter ${Date.now() - t0} ms · cursor: c${hits[0].seq}`;
        if (Date.now() - t0 > a.timeout_ms) return timeoutError(b, `console ${a.pattern}`, a.tab, seq);
        await sleep(100);
      }
    },
  }),
  tool({
    name: 'wait_for_network_idle',
    description: 'Wait until a tab has had no requests in flight for idle_ms (requests matching ignore, and ones pending > 10 s, e.g. long-polls, are ignored).',
    args: { idle_ms: z.number().int().min(50).max(30000).default(500), ignore: z.string().optional().describe('Substring or /regex/ of URLs to ignore'), tab: tabArg, timeout_ms: timeoutArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const seq = d.cursor;
      const tabCtx = await b.context(a.tab);
      const handle = a.tab ?? b.cur ?? undefined;
      const ignore = a.ignore ? matcher(a.ignore) : () => false;
      const t0 = Date.now();
      for (;;) {
        const now = Date.now();
        let busy = 0, last = 0;
        for (const e of d.net) {
          if (now - e.ts > 60000 || ignore(e.url) || e.initiator !== 'page') continue;
          if ((await b.tabForBc(e.bc)) !== handle) continue;
          last = Math.max(last, e.lastUpdate);
          if (!e.done && now - e.ts < 10000) busy++;
        }
        // BiDi in-flight tracking covers requests the devtools hub has not attributed yet
        const bidiBusy = !(await b.waitNetworkIdle(tabCtx, 0, 0));
        if (!busy && !bidiBusy && now - last >= a.idle_ms) return `network idle (${a.idle_ms} ms) after ${now - t0} ms`;
        if (now - t0 > a.timeout_ms) return timeoutError(b, 'network idle', a.tab, seq, { inFlight: busy });
        await sleep(100);
      }
    },
  }),
  tool({
    name: 'wait_for_navigation',
    description: 'Wait for the tab to navigate (full load, or in-page pushState / replaceState / hash change), optionally to a URL matching url_pattern (substring or /regex/). Returns once the new document is past "loading".',
    args: { url_pattern: z.string().optional(), tab: tabArg, timeout_ms: timeoutArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const seq = await startCursor(b);
      const tabCtx = await b.context(a.tab);
      const match = a.url_pattern ? matcher(a.url_pattern) : null;
      const t0 = Date.now();
      // mark the current document (in this server's sandbox): a document without the mark is a new one
      const mark = `nav${t0}${Math.random().toString(36).slice(2, 6)}`;
      let startHref: string | null = null;
      try { startHref = await b.callPage(tabCtx, '(m) => { window.__cfNavMark = m; return location.href; }', [mark]); } catch { /* navigating already */ }
      for (;;) {
        let st: { href: string; rs: string; same: boolean } | null = null;
        try { st = await b.callPage(tabCtx, '(m) => ({ href: location.href, rs: document.readyState, same: window.__cfNavMark === m })', [mark]); } catch { /* between documents */ }
        // new document (full navigation), or the same document with a new URL (pushState / replaceState / hash)
        const navigated = st && (st.same ? startHref !== null && st.href !== startHref : true);
        if (st && navigated && st.rs !== 'loading' && (!match || match(st.href))) return `navigated to ${st.href}${st.same ? ' (in-page)' : ''} after ${Date.now() - t0} ms`;
        if (Date.now() - t0 > a.timeout_ms) return timeoutError(b, `navigation${a.url_pattern ? ` to ${a.url_pattern}` : ''}`, a.tab, seq, { url: st?.href ?? startHref });
        await sleep(100);
      }
    },
  }),
  tool({
    name: 'wait_for_request',
    description: 'Wait for a request (page or extension-made) whose URL matches url_pattern (substring or /regex/), sent after the call starts; phase "response" (default) waits for it to finish.',
    args: { url_pattern: z.string().min(1), phase: z.enum(['request', 'response']).default('response'), initiator: z.string().optional(), since: z.string().optional().describe('Request cursor "r123" to also accept earlier requests'), timeout_ms: timeoutArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const d = await b.hub();
      const seq = d.cursor;
      const since = a.since ?? `r${d.netCursor}`;
      const t0 = Date.now();
      for (;;) {
        const hits = (await queryNet(b, { filter: a.url_pattern, initiator: a.initiator, since })).filter((e) => a.phase === 'request' || e.done || !!e.status);
        if (hits.length) return `${await netLine(b, hits[0])}\nafter ${Date.now() - t0} ms`;
        if (Date.now() - t0 > a.timeout_ms) return timeoutError(b, `request ${a.url_pattern}`, undefined, seq);
        await sleep(100);
      }
    },
  }),
  tool({
    name: 'wait_for_expr',
    description: 'Generic wait: poll an expression in a realm (default page) until it is truthy; returns its value.',
    args: { expr: z.string().min(1), realm: realmArg, tab: tabArg, frame: frameArg, poll_ms: z.number().int().min(20).max(5000).default(100), timeout_ms: timeoutArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const seq = await startCursor(b);
      const spec = toSpec(a.realm);
      const t0 = Date.now();
      let last: unknown, lastErr = '';
      for (;;) {
        try {
          const r = await evalIn(b, spec, a.expr, { tab: a.tab, frame: a.frame, depth: 2, timeoutMs: Math.max(1000, a.timeout_ms - (Date.now() - t0)) });
          last = r.value;
          lastErr = '';
          if (last && last !== '[undefined]' && last !== 0) return `truthy after ${Date.now() - t0} ms: ${JSON.stringify(last).slice(0, 1000)}`;
        } catch (e: any) { lastErr = `${e.code ?? ''} ${e.message}`; if (e.code === 'BAD_ARGS' || /SyntaxError/.test(e.message)) throw e; }
        if (Date.now() - t0 > a.timeout_ms) return timeoutError(b, `${a.expr} to be truthy`, a.tab, seq, { lastValue: JSON.stringify(last)?.slice(0, 300), lastError: lastErr || undefined });
        await sleep(a.poll_ms);
      }
    },
  }),
];
