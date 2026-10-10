import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { z } from 'zod';
import * as CS from '../browser/chromeScripts.js';
import { diffSnapshots, renderNode, toRaw, type RawNode } from '../browser/refs.js';
import { resolveRef } from '../browser/resolve.js';
import type { Browser } from '../browser/session.js';
import { stateDir } from '../audit/audit.js';
import { fail } from '../errors.js';
import { refArg, tabArg, tool, type Detail } from './registry.js';
import { compCall } from '../adapters/companion.js';
import { readState } from '../adapters/violentmonkey.js';

const BLOCKED_URL = /^about:(config|logins|preferences|settings|policies|profiles|debugging)/i;
export function checkUrl(url: string) {
  if (BLOCKED_URL.test(url.trim())) {
    fail('URL_REFUSED', `${url} is off-limits`, 'Browser security settings and saved logins are never automated.');
  }
}

async function pageInfo(b: Browser, context: string) {
  try {
    return await b.callPage(context, '() => ({ url: location.href, title: document.title, readyState: document.readyState })');
  } catch { return { url: '?', title: '?', readyState: '?' }; }
}

// ------------------------------------------------------------ accessibility snapshots
interface Snap { header: string; lines: Map<string, string>; order: string[]; rendered: string[]; nodes: RawNode[]; refs: string[] }

async function takeSnapshot(b: Browser, context: string, filter: 'interactive' | 'all', root: string | undefined, detail: Detail): Promise<Snap> {
  const walk = await b.a11yWalk(context, 20000);
  if (walk.error) fail('A11Y_UNAVAILABLE', walk.error, 'Wait for the page to load (navigate wait="load"), then retry.');
  const scroll = await b.callPage(context, '() => ({ x: scrollX, y: scrollY })').catch(() => ({ x: 0, y: 0 }));
  const nodes: RawNode[] = walk.nodes.map(toRaw);
  const refs = b.refs.assign(context, nodes, scroll);
  const nameMax = detail === 'full' ? 400 : detail === 'normal' ? 150 : 80;
  let start = 0, end = nodes.length;
  if (root) {
    const r = root.replace(/^\[|\]$/g, '');
    start = refs.indexOf(r);
    if (start < 0) fail('REF_NOT_FOUND', `${root} is not in the current page`, 'Call read_page without root first.');
    end = start + 1;
    while (end < nodes.length && nodes[end].depth > nodes[start].depth) end++;
  }
  const lines = new Map<string, string>(), order: string[] = [], rendered: string[] = [];
  const stack: { depth: number; name: string }[] = [];
  for (let i = start; i < end; i++) {
    const n = nodes[i];
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    const parentName = stack.length ? stack[stack.length - 1].name : '';
    const nn = n.name.length > nameMax ? { ...n, name: n.name.slice(0, nameMax) + '…' } : n;
    if (filter === 'all' && n.role === 'text leaf') {
      // page text: shown in "all" mode unless it only repeats the parent's name
      const text = nn.name.trim();
      if (!text || parentName.includes(n.name.trim())) continue;
      const key = `t_${n.uid}`;
      const line = `text ${JSON.stringify(text)}`;
      lines.set(key, line); order.push(key);
      rendered.push('  '.repeat(stack.length) + line);
      continue;
    }
    if (filter === 'all' && n.role === 'label') continue; // its text is already the control's name
    const line = renderNode(nn, refs[i], walk.vw, walk.vh, filter, parentName);
    if (line === null) continue;
    lines.set(refs[i], line);
    order.push(refs[i]);
    rendered.push(filter === 'all' ? '  '.repeat(stack.length) + line : line);
    stack.push({ depth: n.depth, name: n.name });
  }
  const header = `${walk.title} — ${walk.url}\n${order.length} of ${nodes.length} nodes (${filter}${root ? `, root ${root}` : ''})${walk.truncated ? ' [tree truncated]' : ''} · viewport ${walk.vw}x${walk.vh}`;
  return { header, lines, order, rendered, nodes, refs };
}

// ------------------------------------------------------------ screenshots
async function maskPasswordsAndScale(b: Browser, context: string, png: Buffer, origin: 'viewport' | 'document', element: string | null, scale: number | undefined, box?: { x: number; y: number }) {
  const rects: number[][] = await b.callPage(context, `(origin, el, box) => {
    const dpr = devicePixelRatio;
    let ox = 0, oy = 0;
    if (box) { ox = box.x - scrollX; oy = box.y - scrollY; }
    else if (el) { const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; }
    else if (origin === 'document') { ox = -scrollX; oy = -scrollY; }
    const out = [];
    const docs = [document];
    for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
    for (const d of docs) {
      const fr = d === document ? { left: 0, top: 0 } : d.defaultView.frameElement.getBoundingClientRect();
      for (const i of d.querySelectorAll('input[type=password]')) {
        const r = i.getBoundingClientRect();
        if (r.width && r.height) out.push([(r.left + fr.left - ox) * dpr, (r.top + fr.top - oy) * dpr, r.width * dpr, r.height * dpr]);
      }
    }
    return out;
  }`, [origin, element ? { sharedId: element } : null, box ?? null]).catch(() => []);
  if (!rects.length && (!scale || scale === 1)) return { png, masked: 0, width: 0, height: 0, scaled: 1, untouched: true };
  let img: PNG = PNG.sync.read(png);
  for (const [x, y, w, h] of rects) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(img.width, Math.ceil(x + w)), y1 = Math.min(img.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * img.width + xx) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; img.data[i + 3] = 255; }
  }
  const s = scale ?? 1;
  if (s < 1) img = downscale(img, s);
  return { png: PNG.sync.write(img), masked: rects.length, width: img.width, height: img.height, scaled: s, untouched: false };
}

function downscale(src: PNG, s: number): PNG {
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  const dst = new PNG({ width: w, height: h });
  const fx = src.width / w, fy = src.height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx0 = Math.floor(x * fx), sy0 = Math.floor(y * fy), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * fx)), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * fy));
    const acc = [0, 0, 0, 0]; let n = 0;
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { const i = (yy * src.width + xx) * 4; acc[0] += src.data[i]; acc[1] += src.data[i + 1]; acc[2] += src.data[i + 2]; acc[3] += src.data[i + 3]; n++; }
    const o = (y * w + x) * 4;
    for (let k = 0; k < 4; k++) dst.data[o + k] = Math.round(acc[k] / n);
  }
  return dst;
}

function pngSize(buf: Buffer) { return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; }

export const pageTools = [
  tool({
    name: 'navigate',
    description: 'Navigate the tab to a URL, or "back" / "forward" / "reload". wait: none | interactive | load | networkidle.',
    args: {
      url: z.string().describe('URL, or "back", "forward", "reload"'),
      tab: tabArg,
      wait: z.enum(['none', 'interactive', 'load', 'networkidle']).default('load'),
      bypass_cache: z.boolean().default(false).describe('reload only: bypass the cache'),
      timeout_ms: z.number().int().positive().default(30000),
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const bidiWait = a.wait === 'none' ? 'none' : a.wait === 'interactive' ? 'interactive' : 'complete';
      // fast-mode userscripts get their GM values baked into the registration, rebuilt (debounced) after a write:
      // apply pending rebuilds first, or this load runs with the old values
      if (!b.personal && Object.values(readState().links).some((l) => l.mode === 'fast')) await compCall(b, 'return await cf.flush();', 10000).catch(() => {});
      const errBefore = b.console.length;
      const t0 = Date.now();
      let bypassNote = '';
      if (a.url === 'back' || a.url === 'forward') {
        await b.bidi.send('browsingContext.traverseHistory', { context, delta: a.url === 'back' ? -1 : 1 }, a.timeout_ms);
        if (a.wait !== 'none') {
          for (let i = 0; i < a.timeout_ms / 100; i++) {
            const st = (await pageInfo(b, context)).readyState;
            if (st === 'complete' || (a.wait === 'interactive' && st === 'interactive')) break;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      } else if (a.url === 'reload' && a.bypass_cache && b.personal) {
        // needs chrome access (BiDi reload has no ignoreCache yet): a normal reload
        await b.bidi.send('browsingContext.reload', { context, wait: bidiWait }, a.timeout_ms);
        bypassNote = ' (bypass_cache is not available in personal mode: reloaded normally)';
      } else if (a.url === 'reload' && a.bypass_cache) {
        // mark the current document in our sandbox; the mark disappears with the new document
        await b.callPage(context, '() => { window.__cfOld = true; }');
        await b.callChrome(CS.RELOAD_BYPASS_CACHE, { id: context });
        const deadline = Date.now() + a.timeout_ms;
        for (;;) {
          const st = await b.callPage(context, '() => window.__cfOld ? "old" : document.readyState').catch(() => 'old');
          if (st === 'complete' || a.wait === 'none' && st !== 'old' || a.wait === 'interactive' && st === 'interactive') break;
          if (Date.now() > deadline) fail('NAVIGATION_TIMEOUT', `reload did not finish within ${a.timeout_ms} ms`);
          await new Promise((r) => setTimeout(r, 50));
        }
      } else if (a.url === 'reload') {
        await b.bidi.send('browsingContext.reload', { context, wait: bidiWait }, a.timeout_ms);
      } else {
        checkUrl(a.url);
        await b.bidi.send('browsingContext.navigate', { context, url: a.url, wait: bidiWait }, a.timeout_ms);
      }
      let idleNote = '';
      if (a.wait === 'networkidle' && !(await b.waitNetworkIdle(context, 500, Math.max(1000, a.timeout_ms - (Date.now() - t0))))) idleNote = ' (network did not go idle before the timeout)';
      const info = await pageInfo(b, context);
      const errs = b.console.slice(errBefore).filter((c) => c.level === 'error' && c.context === context);
      const lines = [`${info.title || '(no title)'} — ${info.url}`, `ready: ${info.readyState} · ${Date.now() - t0} ms${idleNote}${bypassNote}`];
      if (errs.length) lines.push(`console errors (${errs.length}):`, ...errs.slice(-5).map((e) => `  ${e.text.slice(0, 200)}`));
      return { text: lines.join('\n'), target: { url: info.url } };
    },
  }),
  tool({
    name: 'read_page',
    description: 'Accessibility tree of the page (from Firefox\'s parent-process a11y service) with ref_N handles for click/form_input/screenshot. filter "interactive" (default; plus headings) or "all". root limits to a subtree. since=<snapshot id> returns only what changed (+ added, - removed, ~ changed).',
    args: {
      tab: tabArg,
      filter: z.enum(['interactive', 'all']).default('interactive'),
      root: refArg.optional(),
      since: z.string().regex(/^snap_\d+$/).optional(),
    },
    detail: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const s = await takeSnapshot(b, context, a.filter, a.root, a.detail ?? 'summary');
      const id = b.refs.saveSnapshot(context, s.lines, s.order);
      if (a.since) {
        const prev = b.refs.getSnapshot(a.since);
        if (!prev || prev.context !== context) return `${s.header} · ${id}\n(${a.since} is unknown or expired after navigation; full snapshot follows)\n${s.rendered.join('\n')}`;
        const d = diffSnapshots(prev, { id, context, lines: s.lines, order: s.order });
        return `${s.header} · ${id} · diff vs ${a.since}: ${d.length} change(s)\n${d.join('\n') || '(no changes)'}`;
      }
      return `${s.header} · ${id}\n${s.rendered.join('\n')}`;
    },
  }),
  tool({
    name: 'find',
    description: 'Search the page\'s accessibility tree by role, name, value or text (case-insensitive substring). Returns matching refs.',
    args: { query: z.string().min(1), tab: tabArg, limit: z.number().int().positive().max(200).default(20) },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const s = await takeSnapshot(b, context, 'all', undefined, 'normal');
      const q = a.query.toLowerCase();
      const hits: { line: string; score: number }[] = [];
      s.nodes.forEach((n, i) => {
        if (!s.refs[i]) return;
        const name = n.name.toLowerCase();
        const hay = `${n.aria} ${n.role} ${name} ${n.value.toLowerCase()}`;
        if (!hay.includes(q)) return;
        const line = renderNode(n, s.refs[i], 1e6, 1e6, 'all', '') ?? `[${s.refs[i]}] ${n.aria || n.role} ${JSON.stringify(n.name.slice(0, 100))}`;
        hits.push({ line, score: (name === q ? 0 : name.startsWith(q) ? 1 : 2) + (n.role === 'text leaf' ? 3 : 0) });
      });
      hits.sort((x, y) => x.score - y.score);
      if (!hits.length) return `no match for ${JSON.stringify(a.query)} (${s.nodes.length} nodes searched)`;
      return `${hits.length} match(es) for ${JSON.stringify(a.query)}${hits.length > a.limit ? `, first ${a.limit}` : ''}\n${hits.slice(0, a.limit).map((h) => h.line).join('\n')}`;
    },
  }),
  tool({
    name: 'get_page_text',
    description: 'Main content of the page as plain text (main/article/[role=main] if present, else body).',
    args: { tab: tabArg },
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const r = await b.callPage(context, `() => {
        const root = document.querySelector('main, [role=main], article') || document.body || document.documentElement;
        return { title: document.title, url: location.href, text: root ? root.innerText : '' };
      }`);
      const text = String(r.text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      return `${r.title} — ${r.url}\n\n${text}`;
    },
  }),
  tool({
    name: 'screenshot',
    description: 'Screenshot of the viewport, one element (ref), the full page, or a zoomed region of the previous screenshot. Password fields are blacked out. {x, y} coordinates given to click/hover/drag/scroll afterwards refer to THIS image\'s pixels. The full-resolution PNG is saved under .firefox-use/artifacts/.',
    args: {
      tab: tabArg,
      ref: refArg.optional().describe('Capture just this element'),
      full_page: z.boolean().default(false),
      region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional()
        .describe('Zoom: [x0, y0, x1, y1] in the previous screenshot\'s pixels; captured at full resolution'),
      scale: z.number().min(0.1).max(1).optional().describe('Downscale the returned image (default: fit within 1568 px)'),
    },
    async handler(a, ctx) {
      const b = await ctx.browser();
      let context = await b.context(a.tab);
      let element: string | null = null;
      let clip: any;
      if (a.ref) { const n = await resolveRef(b, a.ref); context = n.context; element = n.sharedId; clip = { type: 'element', element: { sharedId: element } }; }
      if (a.region) {
        const prev = b.shots.get(context);
        const f = prev?.factor ?? 1, ox = prev?.ox ?? 0, oy = prev?.oy ?? 0;
        const [x0, y0, x1, y1] = a.region;
        if (x1 <= x0 || y1 <= y0) fail('BAD_ARGS', 'region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0');
        clip = { type: 'box', x: ox + x0 / f, y: oy + y0 / f, width: (x1 - x0) / f, height: (y1 - y0) / f };
      }
      const origin = a.full_page || clip ? 'document' : 'viewport';
      const geo = await b.callPage(context, `(el) => {
        const r = el ? el.getBoundingClientRect() : null;
        return { dpr: devicePixelRatio, sx: scrollX, sy: scrollY, ex: r ? r.left + scrollX : 0, ey: r ? r.top + scrollY : 0 };
      }`, [element ? { sharedId: element } : null]);
      const shot = await b.bidi.send('browsingContext.captureScreenshot', { context, origin, ...(clip ? { clip } : {}) }, 60000);
      const raw = Buffer.from(shot.data, 'base64');
      // full-resolution artifact (masked)
      const box = clip?.type === 'box' ? { x: clip.x, y: clip.y } : undefined;
      const full = await maskPasswordsAndScale(b, context, raw, origin, element, 1, box);
      const file = path.join(stateDir('artifacts'), `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(file, full.png);
      const { width, height } = pngSize(full.png);
      const fit = Math.min(1, 1568 / Math.max(width, height));
      const scale = a.scale ?? (fit < 1 ? fit : undefined);
      const out = scale && scale < 1 ? await maskPasswordsAndScale(b, context, raw, origin, element, scale, box) : full;
      const dims = pngSize(out.png);
      // remember how this image's pixels map to the page, for {x, y} input coordinates
      const factor = geo.dpr * dims.width / width;
      const ox = clip?.type === 'box' ? clip.x : element ? geo.ex : origin === 'document' ? 0 : geo.sx;
      const oy = clip?.type === 'box' ? clip.y : element ? geo.ey : origin === 'document' ? 0 : geo.sy;
      b.shots.set(context, { factor, ox, oy, w: dims.width, h: dims.height });
      return {
        text: `${width}x${height}${dims.width !== width ? ` (returned at ${dims.width}x${dims.height})` : ''}${full.masked ? ` · ${full.masked} password field(s) masked` : ''}\ncoordinates for click/hover/drag/scroll now refer to this ${dims.width}x${dims.height} image\nsaved: ${file}`,
        images: [{ data: out.png.toString('base64'), mimeType: 'image/png' }],
      };
    },
  }),
  tool({
    name: 'form_input',
    description: 'Set the value of an input, textarea, select (by option value or label; array for multi-select), checkbox/radio (true/false) or contenteditable, firing input/change events.',
    args: { ref: refArg, value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const n = await resolveRef(b, a.ref);
      const r = await b.callPage(n.context, `(el, value) => {
        const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const tag = el.localName;
        if (tag === 'select') {
          const want = Array.isArray(value) ? value.map(String) : [String(value)];
          let hit = 0;
          for (const o of el.options) { const m = want.includes(o.value) || want.includes(o.label) || want.includes(o.text.trim()); if (m) hit++; if (el.multiple || m) o.selected = m; }
          if (!hit) return { error: 'no option matches ' + JSON.stringify(value) + '; options: ' + [...el.options].map((o) => o.label).slice(0, 30).join(' | ') };
          fire('input'); fire('change');
          return { ok: 'selected ' + [...el.selectedOptions].map((o) => o.label).join(', ') };
        }
        if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          const want = value === true || value === 'true' || value === 1 || value === 'on';
          if (el.checked !== want) el.click();
          return { ok: (el.checked ? 'checked' : 'unchecked') };
        }
        if (tag === 'input' && el.type === 'file') return { error: 'file inputs: use set_files' };
        if (tag === 'input' || tag === 'textarea') {
          if (el.type === 'password') return { error: 'refusing to fill a password field (credentials are never entered)' };
          el.focus();
          el.value = String(value);
          fire('input'); fire('change');
          return { ok: 'value set' };
        }
        if (el.isContentEditable) { el.focus(); el.textContent = String(value); el.dispatchEvent(new InputEvent('input', { bubbles: true })); return { ok: 'content set' }; }
        return { error: 'element <' + tag + '> is not a form control' };
      }`, [{ sharedId: n.sharedId }, a.value]);
      if (r?.error) fail('FORM_INPUT', r.error);
      return `${a.ref}: ${r.ok}`;
    },
  }),
  tool({
    name: 'resize',
    description: 'Emulate a viewport size for the tab (omit width and height to reset).',
    args: { width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), tab: tabArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const viewport = a.width && a.height ? { width: a.width, height: a.height } : null;
      await b.bidi.send('browsingContext.setViewport', { context, viewport });
      return viewport ? `viewport ${a.width}x${a.height}` : 'viewport reset';
    },
  }),
];
