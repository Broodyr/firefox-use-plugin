// realms: page (BiDi), content-script sandboxes / extension pages / workers (devtools hub, RDP),
// privileged (chrome). One eval path for all of them, with the same serialiser.
import { ToolError, fail } from '../errors.js';
import { evalPrivileged } from '../transports/privileged.js';
import { ALIASES } from './scope.js';
import * as XS from './extScripts.js';
import { NAV } from './internals.js';
import { SERIALIZER, bidiEvalFunction, hasReturn, rdpEvalSource } from './serialize.js';
import type { Browser } from './session.js';
import type { TargetInfo } from './devtools.js';
import { resolveRef } from './resolve.js';
import { sleep } from './launcher.js';

export type RealmSpec =
  | { kind: 'page' }
  | { kind: 'userscript'; script: string }
  | { kind: 'content'; extension: string }
  | { kind: 'extension'; extension: string; page?: string }
  | { kind: 'privileged' }
  | { kind: 'worker'; url?: string };

export interface ExtRef { id: string; name: string; active: boolean }

/** id, alias (ubo, vm, companion) or a unique name substring -> add-on. */
export async function resolveExtension(b: Browser, q: string): Promise<ExtRef> {
  const id = ALIASES[q] ?? q;
  const r = await b.callChrome<any>(XS.ADDON_FIND, { q: id });
  if (r.error) fail('EXTENSION_NOT_FOUND', r.error, `Installed: ${(r.candidates ?? []).join('; ')}. Aliases: ubo, vm.`);
  return r;
}

/** Context id for a frame of a tab: index among child frames (document order), URL substring, or an <iframe> ref. */
export async function frameContext(b: Browser, top: string, frame?: number | string): Promise<string> {
  if (frame === undefined || frame === null || frame === '') return top;
  if (typeof frame === 'string' && /^\[?ref_\d+\]?$/.test(frame)) {
    const n = await resolveRef(b, frame.replace(/^\[|\]$/g, ''));
    const w = await b.callPage(n.context, '(el) => el.contentWindow', [{ sharedId: n.sharedId }], { raw: true });
    if (w?.type !== 'window' || !w.value?.context) fail('FRAME_NOT_FOUND', `${frame} is not an iframe with a loaded document`);
    return w.value.context;
  }
  const tree = await b.bidi.send('browsingContext.getTree', { root: top });
  const flat: { context: string; url: string }[] = [];
  const walk = (c: any) => { for (const ch of c.children ?? []) { flat.push(ch); walk(ch); } };
  for (const c of tree.contexts) walk(c);
  const hit = typeof frame === 'number' ? flat[frame] : flat.find((c) => c.url.includes(frame));
  if (!hit) fail('FRAME_NOT_FOUND', `no frame ${JSON.stringify(frame)} in this tab (${flat.length} frame(s): ${flat.map((f, i) => `${i}: ${f.url}`).join(', ').slice(0, 600)})`);
  return hit!.context;
}

/** BiDi context id -> its browsing context id and current inner window id (to match devtools targets). */
export async function contextIds(b: Browser, context: string): Promise<{ bc: number; innerWindowId: number }> {
  return b.callChrome(`({ id }) => {
    ${NAV}
    const bc = Nav.getBrowsingContextById(id);
    if (!bc) throw new Error("browsing context not found");
    return { bc: bc.id, innerWindowId: bc.currentWindowGlobal ? bc.currentWindowGlobal.innerWindowId : 0 };
  }`, { id: context });
}

async function waitTarget(b: Browser, pred: (t: TargetInfo) => boolean, ms: number): Promise<TargetInfo | undefined> {
  const d = await b.dt();
  const t0 = Date.now();
  for (;;) {
    const hit = [...d.targets.values()].reverse().find((t) => t.alive && pred(t));
    if (hit || Date.now() - t0 > ms) return hit;
    await sleep(100);
  }
}

/** The content-script target of an extension in a tab/frame. */
export async function contentTarget(b: Browser, ext: ExtRef, context: string): Promise<TargetInfo> {
  const { innerWindowId } = await contextIds(b, context);
  const t = await waitTarget(b, (x) => x.type === 'content_script' && x.addonId === ext.id && x.innerWindowId === innerWindowId, 1500);
  if (!t) fail('REALM_NOT_FOUND', `${ext.name} has no content script in this document`, 'The extension must match this URL (and have run: reload after installing it). realms_list shows the realms of a tab.');
  return t!;
}

/** The background (or another page) of an extension, waking an event page if needed. */
export async function extensionTarget(b: Browser, ext: ExtRef, page = 'background'): Promise<TargetInfo> {
  if (!ext.active) fail('EXTENSION_DISABLED', `${ext.name} is disabled`, 'addons_set_enabled it first.');
  const uuidHost = (await b.callChrome<string | null>(`({ id }) => WebExtensionPolicy.getByID(id)?.mozExtensionHostname ?? null`, { id: ext.id }))!;
  const isBg = page === 'background';
  const want = (t: TargetInfo) => t.type === 'frame' && !!t.url && t.url.startsWith(`moz-extension://${uuidHost}/`) &&
    (isBg ? /_generated_background_page\.html$/.test(t.url) || t.title === `${ext.name} Background Page` || (t.addonId === ext.id && /background/i.test(t.url)) : t.url.includes(page.replace(/^\//, '')));
  let t = await waitTarget(b, want, 300);
  if (!t && isBg) {
    await b.callChrome(XS.EXT_WAKE, { id: ext.id }).catch(() => {});
    t = await waitTarget(b, want, 3000);
    if (!t) {
      // MV3 worker backgrounds show up as worker targets
      t = await waitTarget(b, (x) => (x.type === 'worker' || x.type === 'service_worker') && !!x.url?.startsWith(`moz-extension://${uuidHost}/`), 1000);
    }
  }
  if (!t) fail('REALM_NOT_FOUND', isBg ? `${ext.name} has no running background` : `no open ${ext.name} page matching "${page}"`, isBg ? 'It may not declare a background.' : 'Open it first with ext_page_open(extension, path).');
  return t!;
}

export interface EvalResult { type: string; xray: boolean; value: unknown; realm: string }

function parseSer(s: unknown, realm: string): EvalResult {
  if (typeof s !== 'string') return { type: typeof s, xray: false, value: s, realm };
  try { const j = JSON.parse(s); return { ...j, realm }; } catch { return { type: 'string', xray: false, value: s, realm }; }
}

/** Evaluate code (an expression, or a function body with `return`) in a realm. */
export async function evalIn(b: Browser, spec: RealmSpec, code: string, o: EvalOpts = {}): Promise<EvalResult> {
  if (hasReturn(code)) return evalOnce(b, spec, code, false, o);
  try {
    return await evalOnce(b, spec, code, true, o);
  } catch (e: any) {
    // not a single expression (e.g. "a(); b"): evaluate as a script and take its completion value, like a console
    if (e instanceof ToolError && (e.code === 'EVAL_EXCEPTION' || e.code === 'PRIVILEGED_EXCEPTION') && /SyntaxError/.test(e.message)) return evalScript(b, spec, code, o);
    throw e;
  }
}

interface EvalOpts { tab?: number; frame?: number | string; depth?: number; waive?: boolean; awaitPromise?: boolean; timeoutMs?: number }

/** Script mode: the code runs as a script (no top-level await); its completion value is serialised. */
async function evalScript(b: Browser, spec: RealmSpec, code: string, o: EvalOpts): Promise<EvalResult> {
  const depth = o.depth ?? 2, waive = !!o.waive;
  if (spec.kind === 'page') {
    const top = await b.context(o.tab);
    const context = await frameContext(b, top, o.frame);
    const r = await b.bidi.send('script.evaluate', { expression: code, target: { context }, awaitPromise: o.awaitPromise ?? true, resultOwnership: 'root', userActivation: false }, o.timeoutMs ?? 30000);
    if (r.type === 'exception') throwEval(r.exceptionDetails?.text ?? 'exception', stackOfBidi(r), 'page');
    const v = r.result;
    try {
      const arg = v.handle ? { handle: v.handle } : v;
      const s = await b.bidi.send('script.callFunction', {
        functionDeclaration: `function (v) { return (${SERIALIZER})(v, ${depth}, ${waive}); }`, arguments: [arg], target: { context }, awaitPromise: false, resultOwnership: 'none',
      });
      if (s.type === 'exception') throwEval(s.exceptionDetails?.text ?? 'exception', undefined, 'page');
      return parseSer(s.result?.value, context === top ? 'page' : `page frame ${o.frame}`);
    } finally {
      if (v.handle) await b.bidi.send('script.disown', { handles: [v.handle], target: { context } }).catch(() => {});
    }
  }
  if (spec.kind === 'privileged') {
    const r = await evalPrivileged(b, `return (0, eval)(${JSON.stringify(code)});`);
    return { type: r.type, xray: false, value: r.value, realm: 'privileged' };
  }
  if (spec.kind === 'userscript') {
    const r = await evalUserscript(b, spec.script, `(${SERIALIZER})(eval(${JSON.stringify(code)}), ${depth}, ${waive})`, o);
    if (r) return r;
  }
  // RDP realms: the console evaluates scripts natively; $_ is its last result
  const { target, label } = await rdpTarget(b, spec, o);
  const d = await b.dt();
  const r1 = await d.evaluate(target.consoleActor!, code, o.timeoutMs);
  if (r1.exception !== undefined) throwEval(r1.exception, r1.stack, label);
  const r2 = await d.evaluate(target.consoleActor!, `(async () => (${SERIALIZER})(${o.awaitPromise === false ? '$_' : 'await $_'}, ${depth}, ${waive}))()`, o.timeoutMs);
  if (r2.exception !== undefined) throwEval(r2.exception, r2.stack, label);
  return parseSer(await d.longString(r2.result), label);
}

export async function rdpTarget(b: Browser, spec: RealmSpec, o: EvalOpts): Promise<{ target: TargetInfo; label: string }> {
  if (spec.kind === 'worker') {
    const d = await b.dt();
    const ws = [...d.targets.values()].filter((t) => t.alive && (t.type === 'worker' || t.type === 'service_worker' || t.type === 'shared_worker') && (!spec.url || t.url?.includes(spec.url)));
    if (!ws.length) fail('REALM_NOT_FOUND', `no running worker${spec.url ? ` matching ${spec.url}` : ''}`, 'realms_list shows workers.');
    return { target: ws[ws.length - 1], label: `worker:${ws[ws.length - 1].url}` };
  }
  if (spec.kind === 'content' || spec.kind === 'userscript') {
    const ext = await resolveExtension(b, spec.kind === 'userscript' ? 'vm' : spec.extension);
    const context = await frameContext(b, await b.context(o.tab), o.frame);
    return { target: await contentTarget(b, ext, context), label: spec.kind === 'userscript' ? `userscript:${spec.script} (Violentmonkey content sandbox)` : `content:${ext.name}` };
  }
  if (spec.kind === 'extension') {
    const ext = await resolveExtension(b, spec.extension);
    return { target: await extensionTarget(b, ext, spec.page), label: `extension:${ext.name}${spec.page && spec.page !== 'background' ? ` ${spec.page}` : ' background'}` };
  }
  return fail('BAD_ARGS', `realm ${spec.kind} is not an RDP realm`);
}

async function evalOnce(b: Browser, spec: RealmSpec, code: string, asExpr: boolean, o: EvalOpts): Promise<EvalResult> {
  const depth = o.depth ?? 2, waive = !!o.waive, awaitP = o.awaitPromise ?? true;
  if (spec.kind === 'userscript') {
    const r = await evalUserscript(b, spec.script, rdpEvalSource(code, asExpr, depth, waive, false), o);
    if (r) return r;
  }
  if (spec.kind === 'privileged') {
    const r = await evalPrivileged(b, asExpr ? `return (\n${code}\n);` : code);
    return { type: r.type, xray: false, value: r.value, realm: 'privileged' };
  }
  if (spec.kind === 'page') {
    const top = await b.context(o.tab);
    const context = await frameContext(b, top, o.frame);
    const r = await b.bidi.send('script.callFunction', {
      functionDeclaration: bidiEvalFunction(code, asExpr, depth, waive, awaitP), arguments: [], target: { context },
      awaitPromise: true, resultOwnership: 'none', userActivation: false,
    }, o.timeoutMs ?? 30000);
    if (r.type === 'exception') throwEval(r.exceptionDetails?.text ?? 'exception', stackOfBidi(r), 'page');
    return parseSer(r.result?.value, context === top ? 'page' : `page frame ${o.frame}`);
  }
  const { target, label } = await rdpTarget(b, spec, o);
  return rdpEval(b, target, code, asExpr, depth, waive, awaitP, label, o.timeoutMs);
}

async function rdpEval(b: Browser, t: TargetInfo, code: string, asExpr: boolean, depth: number, waive: boolean, awaitP: boolean, label: string, timeoutMs?: number): Promise<EvalResult> {
  if (!t.consoleActor) fail('REALM_NOT_FOUND', `${label} has no console actor`);
  const d = await b.dt();
  let r = await d.evaluate(t.consoleActor!, rdpEvalSource(code, asExpr, depth, waive, awaitP), timeoutMs);
  if (r.exception !== undefined) throwEval(r.exception, r.stack, label);
  const s = await d.longString(r.result);
  return parseSer(s, label);
}

/**
 * {kind:"userscript"} for a script installed from the workspace with the dev prelude: its eval hook evaluates inside
 * the script's own scope (its top-level variables and functions), wherever the script runs (Violentmonkey content
 * or page mode, fast mode). Synchronous: the result is serialised in the script's realm before it returns.
 * null = not one of ours: the caller falls back to Violentmonkey's content sandbox.
 */
async function evalUserscript(b: Browser, script: string, text: string, o: EvalOpts): Promise<EvalResult | null> {
  const { readState } = await import('../adapters/violentmonkey.js');
  const entry = Object.entries(readState().links).find(([rel, l]) => rel === script || rel === script.replace(/\\/g, '/') || l.name === script || String(l.id) === script);
  if (!entry || !entry[1].evalToken || !entry[1].devPrelude) return null;
  const l = entry[1];
  const label = `userscript:${l.name} (${l.mode === 'fast' ? 'fast mode' : 'Violentmonkey'})`;
  const context = await frameContext(b, await b.context(o.tab), o.frame);
  const out = await b.callPage(context, `(t, code) => {
    let out = null;
    const f = (e) => { out = e.detail; };
    document.addEventListener('__claude_eval_result_' + t, f);
    try { document.dispatchEvent(new CustomEvent('__claude_eval_' + t, { detail: JSON.stringify({ code }) })); }
    finally { document.removeEventListener('__claude_eval_result_' + t, f); }
    return out;
  }`, [l.evalToken, text]);
  if (typeof out !== 'string') {
    fail('REALM_NOT_FOUND', `userscript "${l.name}" has not run in this document`, `Check its @match / @include and reload (us_logs shows its errors). Installed ${l.mode === 'fast' ? 'in fast mode' : 'in Violentmonkey'} from ${entry[0]}; the eval hook comes with the dev prelude (a script installed by an older firefox-use version needs reinstalling).`);
  }
  const r = JSON.parse(out as string);
  if (!r.ok) throwEval(r.e, r.s ? r.s.split('\n').slice(0, 5).join(' <- ') : undefined, label);
  return parseSer(r.v, label);
}

function throwEval(msg: string, stack: string | undefined, realm: string): never {
  const syntax = /SyntaxError/.test(msg);
  throw new ToolError('EVAL_EXCEPTION', `${msg} (in ${realm})`, syntax ? 'Code is an expression, or a function body that uses `return` (await is allowed).' : undefined, stack ? { stack } : undefined);
}

function stackOfBidi(r: any): string | undefined {
  const f = r.exceptionDetails?.stackTrace?.callFrames;
  return f?.length ? f.slice(0, 5).map((c: any) => `${c.functionName || '?'}@${c.url}:${c.lineNumber}:${c.columnNumber}`).join(' <- ') : undefined;
}

/** Every realm of a tab: page + frames, extension content sandboxes, workers; plus extension backgrounds. */
export async function listRealms(b: Browser, tab?: number): Promise<string[]> {
  const top = await b.context(tab);
  const d = await b.dt();
  await d.updateExtensions();
  const out: string[] = [];
  const tree = await b.bidi.send('browsingContext.getTree', { root: top });
  const frames: { context: string; url: string; depth: number }[] = [];
  const walk = (c: any, depth: number) => { frames.push({ context: c.context, url: c.url, depth }); for (const ch of c.children ?? []) walk(ch, depth + 1); };
  for (const c of tree.contexts) walk(c, 0);
  for (const [i, f] of frames.entries()) {
    out.push(`${'  '.repeat(f.depth)}{kind:"page"${i ? `, frame:${i - 1}` : ''}}  ${f.url}`);
    let ids: { innerWindowId: number } | null = null;
    try { ids = await contextIds(b, f.context); } catch { /* gone */ }
    if (!ids) continue;
    for (const t of d.targets.values()) {
      if (!t.alive || t.type !== 'content_script' || t.innerWindowId !== ids.innerWindowId) continue;
      const alias = Object.entries(ALIASES).find(([, v]) => v === t.addonId)?.[0];
      out.push(`${'  '.repeat(f.depth + 1)}{kind:"content", extension:"${alias ?? t.addonId}"${i ? `, frame:${i - 1}` : ''}}  ${t.title} content-script sandbox${alias === 'vm' ? ' (Violentmonkey @inject-into content userscripts run here)' : ''}`);
    }
  }
  const workers = [...d.targets.values()].filter((t) => t.alive && (t.type === 'worker' || t.type === 'shared_worker' || t.type === 'service_worker'));
  const pageOrigin = (() => { try { return new URL(frames[0]?.url ?? '').origin; } catch { return ''; } })();
  for (const w of workers) if (pageOrigin && w.url?.startsWith(pageOrigin)) out.push(`{kind:"worker", url:"${w.url}"}  ${w.type}`);
  out.push('extension realms (any tab):');
  for (const t of d.targets.values()) {
    if (!t.alive || t.type !== 'frame' || !t.url?.startsWith('moz-extension://')) continue;
    const id = t.addonId ?? d.addonForUrl(t.url);
    if (!id) continue;
    const alias = Object.entries(ALIASES).find(([, v]) => v === id)?.[0];
    const bg = /_generated_background_page\.html$/.test(t.url) || /Background Page$/.test(t.title ?? '');
    const path = t.url.replace(/^moz-extension:\/\/[^/]+\//, '');
    out.push(`  {kind:"extension", extension:"${alias ?? id}"${bg ? '' : `, page:"${path}"`}}  ${d.extNameById.get(id) ?? id} ${bg ? 'background' : path}`);
  }
  out.push('{kind:"privileged"}  browser chrome (denylist applies)');
  return out;
}

/**
 * Where to send messages from as one of the extension's own pages: its background document; or, when the
 * background has no document (a service worker, or no background at all), an extension page — an open one, else
 * its options/popup page opened in a background agent tab.
 */
export async function messagingTarget(b: Browser, ext: ExtRef): Promise<{ target: TargetInfo; via: string }> {
  let bg: TargetInfo | null = null;
  try { bg = await extensionTarget(b, ext); } catch (e) { if (!(e instanceof ToolError) || e.code !== 'REALM_NOT_FOUND') throw e; }
  if (bg && bg.type === 'frame') return { target: bg, via: 'background' };
  const info = await b.callChrome<{ host: string; pages: string[] } | null>(`({ id }) => {
    const pol = WebExtensionPolicy.getByID(id); const m = pol && pol.extension && pol.extension.manifest;
    if (!m) return null;
    const pages = [m.options_ui && m.options_ui.page, m.options_page, m.action && m.action.default_popup, m.browser_action && m.browser_action.default_popup, m.sidebar_action && m.sidebar_action.default_panel].filter(Boolean);
    return { host: pol.mozExtensionHostname, pages };
  }`, { id: ext.id });
  if (!info) fail('EXTENSION_DISABLED', `${ext.name} is not running`);
  const d = await b.dt();
  const open = () => [...d.targets.values()].reverse().find((t) => t.alive && t.type === 'frame' && !!t.url?.startsWith(`moz-extension://${info!.host}/`) && !/_generated_background_page/.test(t.url));
  let t = open();
  if (!t) {
    if (!info!.pages.length) fail('REALM_NOT_FOUND', `${ext.name} has no background document and no page to send from`, 'Messages need a running extension context: its background, or one of its pages.');
    // Firefox normalises manifest page paths to absolute moz-extension:// URLs
    const p0 = info!.pages[0];
    const url = /^moz-extension:\/\//.test(p0) ? p0 : `moz-extension://${info!.host}/${p0.replace(/^\//, '')}`;
    await b.createTab(url);
    t = await waitTarget(b, (x) => x.type === 'frame' && x.url === url, 5000);
    if (!t) fail('REALM_NOT_FOUND', `opened ${url} but its realm did not appear`);
  }
  return { target: t!, via: `extension page ${t!.url!.replace(/^moz-extension:\/\/[^/]+\//, '')}${bg ? ' (the background is a worker)' : ' (no background document)'}` };
}

/**
 * Run a function body in an extension's background realm and return its JSON-able result whole (adapters).
 * The body may use `await`, and `__cfFrame()` returns a helper frame inside the background document whose window
 * has the extension's own API as an extension page (sender origin = the extension).
 */
export async function extCall<T = any>(b: Browser, ext: ExtRef, body: string, timeoutMs = 30000): Promise<T> {
  const { target: t } = await messagingTarget(b, ext);
  const code = `
    const __cfFrame = async () => {
      let f = document.getElementById('__claude_port');
      if (!f) {
        f = document.createElement('iframe');
        f.id = '__claude_port';
        (document.body || document.documentElement).append(f);
        await new Promise((r) => setTimeout(r, 50));
      }
      return f.contentWindow;
    };
    const __r = await (async () => { ${body} })();
    return JSON.stringify(__r === undefined ? null : __r);`;
  const r = await rdpEval(b, t, code, false, 1, false, true, `extension:${ext.name}`, timeoutMs);
  return typeof r.value === 'string' ? JSON.parse(r.value) : (r.value as T);
}

/**
 * Send a runtime message as the extension's own page would: from a helper frame inside its background
 * document, so the background's runtime.onMessage receives it with an extension-page sender.
 */
export async function extMessage(b: Browser, ext: ExtRef, message: unknown, timeoutMs = 15000): Promise<EvalResult> {
  const { target: t, via } = await messagingTarget(b, ext);
  const code = `
    let f = document.getElementById('__claude_port');
    if (!f) {
      f = document.createElement('iframe');
      f.id = '__claude_port';
      (document.body || document.documentElement).append(f);
      await new Promise((r) => setTimeout(r, 50));
    }
    const api = f.contentWindow.browser || f.contentWindow.chrome;
    if (!api || !api.runtime) throw new Error('no extension API in the helper frame');
    return await api.runtime.sendMessage(${JSON.stringify(message)});`;
  return rdpEval(b, t, code, false, 6, false, true, `extension:${ext.name} (as extension page, from its ${via})`, timeoutMs);
}
