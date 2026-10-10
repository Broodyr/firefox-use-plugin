import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig, setupCommand, workspace } from '../config.js';
import { resolveRef } from '../browser/resolve.js';
import type { Browser } from '../browser/session.js';
import { fail } from '../errors.js';
import { refArg, tabArg, tool } from './registry.js';

// WebDriver key codes for named keys
const KEYS: Record<string, string> = {
  cancel: '', help: '', backspace: '', tab: '', clear: '', return: '', enter: '',
  shift: '', control: '', ctrl: '', alt: '', option: '', pause: '', escape: '', esc: '',
  space: ' ', pageup: '', pagedown: '', end: '', home: '', arrowleft: '', left: '',
  arrowup: '', up: '', arrowright: '', right: '', arrowdown: '', down: '',
  insert: '', delete: '', del: '', meta: '', cmd: '', command: '', win: '', super: '',
  f1: '', f2: '', f3: '', f4: '', f5: '', f6: '', f7: '', f8: '', f9: '',
  f10: '', f11: '', f12: '',
};
const MODS = new Set(['', '', '', '']);
const BUTTONS = { left: 0, middle: 1, right: 2 } as const;

function keyValue(name: string): string {
  if ([...name].length === 1) return name;
  const v = KEYS[name.toLowerCase()];
  if (!v) fail('BAD_KEY', `unknown key "${name}"`, 'Use names like Enter, Tab, Escape, ArrowDown, Backspace, F5, or combos like ctrl+a.');
  return v!;
}

const point = z.union([refArg, z.object({ x: z.number(), y: z.number() })]);
type Point = z.infer<typeof point>;
const coordsArg = z.enum(['screenshot', 'viewport']).default('screenshot')
  .describe('{x, y} space: pixels of the last screenshot of this tab (default; falls back to viewport CSS px if none since the last navigation), or viewport CSS px');

/**
 * {x, y} -> viewport CSS px. Screenshot coordinates are mapped through the last screenshot's
 * scale and origin; if the point is outside the viewport the page is scrolled to bring it in.
 */
export async function toViewport(b: Browser, ctx: string, p: { x: number; y: number }, coords: 'screenshot' | 'viewport'): Promise<{ x: number; y: number }> {
  const shot = coords === 'screenshot' ? b.shots.get(ctx) : undefined;
  if (!shot) return { x: Math.round(p.x), y: Math.round(p.y) };
  const dx = shot.ox + p.x / shot.factor, dy = shot.oy + p.y / shot.factor;
  const v = await b.callPage(ctx, `(dx, dy) => {
    if (dx < scrollX || dx >= scrollX + innerWidth || dy < scrollY || dy >= scrollY + innerHeight) scrollTo({ left: dx - innerWidth / 2, top: dy - innerHeight / 2, behavior: 'instant' });
    return { x: dx - scrollX, y: dy - scrollY };
  }`, [dx, dy]);
  return { x: Math.round(v.x), y: Math.round(v.y) };
}

async function origin(b: Browser, ctx: string, p: Point, coords: 'screenshot' | 'viewport' = 'screenshot'): Promise<{ context: string; move: any; x?: number; y?: number }> {
  if (typeof p === 'string') {
    const n = await resolveRef(b, p);
    await b.callPage(n.context, '(el) => el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })', [{ sharedId: n.sharedId }]);
    return { context: n.context, move: { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: n.sharedId } } } };
  }
  const v = await toViewport(b, ctx, p, coords);
  return { context: ctx, move: { type: 'pointerMove', x: v.x, y: v.y, origin: 'viewport' }, x: v.x, y: v.y };
}

const describePoint = (p: Point, o: { x?: number; y?: number }) =>
  typeof p === 'string' ? p : `(${p.x}, ${p.y})${o.x !== undefined && (o.x !== Math.round(p.x) || o.y !== Math.round(p.y)) ? ` = viewport (${o.x}, ${o.y})` : ''}`;

/** Lay out modifier keys around pointer actions on a shared tick timeline. */
function withModifiers(pointerActions: any[], modifiers: string[]) {
  const mods = modifiers.map(keyValue);
  const keyActs = [...mods.map((value) => ({ type: 'keyDown', value })), ...pointerActions.map(() => ({ type: 'pause' })), ...mods.map((value) => ({ type: 'keyUp', value }))];
  const ptrActs = [...mods.map(() => ({ type: 'pause' })), ...pointerActions, ...mods.map(() => ({ type: 'pause' }))];
  const sources: any[] = [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: ptrActs }];
  if (mods.length) sources.unshift({ type: 'key', id: 'kbd', actions: keyActs });
  return sources;
}

async function perform(b: Browser, context: string, actions: any[]) {
  await b.bidi.send('input.performActions', { context, actions });
  await b.bidi.send('input.releaseActions', { context }).catch(() => {});
}

async function urlOf(b: Browser, context: string) { return b.callPage(context, '() => location.href').catch(() => '?'); }

export function checkUploadPath(p: string): string {
  const abs = path.resolve(workspace(), p);
  const roots = [path.resolve(workspace()), path.resolve(loadConfig().sandboxDir)].map((r) => r.toLowerCase() + path.sep);
  if (!roots.some((r) => (abs.toLowerCase() + path.sep).startsWith(r))) fail('PATH_REFUSED', `${p} is outside the workspace and the sandbox folder`, 'Only files inside the workspace or the sandbox folder can be uploaded.');
  if (!fs.existsSync(abs)) fail('FILE_NOT_FOUND', `${abs} does not exist`);
  return abs;
}

export const inputTools = [
  tool({
    name: 'click',
    description: 'Click an element (ref, scrolled into view first) or viewport coordinates with trusted input (isTrusted: true). count=2 double-clicks.',
    args: {
      target: point.describe('ref_N, or {x, y} in viewport CSS pixels'),
      button: z.enum(['left', 'middle', 'right']).default('left'),
      modifiers: z.array(z.string()).default([]).describe('e.g. ["ctrl"], ["shift"]'),
      count: z.number().int().min(1).max(3).default(1),
      coords: coordsArg,
      tab: tabArg,
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const top = await b.context(a.tab);
      const t0 = Date.now();
      const o = await origin(b, top, a.target, a.coords);
      const { context, move } = o;
      const btn = BUTTONS[a.button];
      const clicks = Array.from({ length: a.count }, () => [{ type: 'pointerDown', button: btn }, { type: 'pointerUp', button: btn }]).flat();
      await perform(b, context, withModifiers([move, ...clicks], a.modifiers));
      // a click may start a navigation a little later; if one started, wait for the new page (max 5 s)
      await new Promise((r) => setTimeout(r, 200));
      let after = '';
      if ((b.navStarted.get(top) ?? 0) >= t0) {
        for (let i = 0; i < 50; i++) {
          const st = await b.callPage(top, '() => [location.href, document.readyState]').catch(() => null);
          if (st && st[1] !== 'loading') { after = st[0]; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        after ||= await urlOf(b, top);
      }
      return { text: `clicked ${describePoint(a.target, o)}${after ? `\nnavigated to ${after}` : ''}`, target: after ? { url: after } : undefined };
    },
  }),
  tool({
    name: 'type',
    description: 'Type text with trusted key events into the focused element, or into ref (focused first). "\\n" presses Enter.',
    args: { text: z.string(), ref: refArg.optional(), tab: tabArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      let context = await b.context(a.tab);
      if (a.ref) {
        const n = await resolveRef(b, a.ref);
        context = n.context;
        const pw = await b.callPage(context, '(el) => { el.scrollIntoView({ block: "center", behavior: "instant" }); el.focus(); return el.localName === "input" && el.type === "password"; }', [{ sharedId: n.sharedId }]);
        if (pw) fail('REFUSED', 'refusing to type into a password field');
      } else {
        const pw = await b.callPage(context, '() => { const e = document.activeElement; return !!e && e.localName === "input" && e.type === "password"; }');
        if (pw) fail('REFUSED', 'the focused element is a password field; credentials are never entered');
      }
      const acts: any[] = [];
      for (const ch of a.text) {
        const v = ch === '\n' ? '' : ch;
        acts.push({ type: 'keyDown', value: v }, { type: 'keyUp', value: v });
      }
      await perform(b, context, [{ type: 'key', id: 'kbd', actions: acts }]);
      return `typed ${[...a.text].length} character(s)${a.ref ? ` into ${a.ref}` : ''}`;
    },
  }),
  tool({
    name: 'key',
    description: 'Press keys with trusted events. Space-separated sequence; "+" joins a chord. Examples: "Enter", "ctrl+a Backspace", "shift+Tab".',
    args: { keys: z.string().min(1), repeat: z.number().int().min(1).max(100).default(1), tab: tabArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const acts: any[] = [];
      for (let i = 0; i < a.repeat; i++) {
        for (const chord of a.keys.trim().split(/\s+/)) {
          const parts = chord === '+' ? ['+'] : chord.split('+').filter(Boolean).map(keyValue);
          for (const p of parts) acts.push({ type: 'keyDown', value: p });
          for (const p of [...parts].reverse()) acts.push({ type: 'keyUp', value: p });
        }
      }
      await perform(b, context, [{ type: 'key', id: 'kbd', actions: acts }]);
      return `pressed ${a.keys}${a.repeat > 1 ? ` x${a.repeat}` : ''}`;
    },
  }),
  tool({
    name: 'drag',
    description: 'Drag with trusted mouse input from one ref/point to another.',
    args: { from: point, to: point, coords: coordsArg, tab: tabArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const top = await b.context(a.tab);
      const f = await origin(b, top, a.from, a.coords);
      const t = await origin(b, top, a.to, a.coords);
      await perform(b, f.context, [{
        type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
        actions: [f.move, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 50 }, { ...t.move, duration: 300 }, { type: 'pointerUp', button: 0 }],
      }]);
      return 'dragged';
    },
  }),
  tool({
    name: 'input',
    description: 'Raw BiDi input.performActions chain (pointer, key, wheel sources). Pointer origins may be {"ref": "ref_N"}. Use for gestures the shortcuts do not cover.',
    args: { actions: z.array(z.record(z.string(), z.any())).min(1), tab: tabArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const context = await b.context(a.tab);
      const sources = await Promise.all(a.actions.map(async (src: any) => ({
        ...src,
        actions: await Promise.all((src.actions ?? []).map(async (act: any) => {
          if (act?.origin?.ref) {
            const n = await resolveRef(b, act.origin.ref);
            return { ...act, origin: { type: 'element', element: { sharedId: n.sharedId } } };
          }
          return act;
        })),
      })));
      await perform(b, context, sources);
      return `performed ${sources.length} input source(s)`;
    },
  }),
  tool({
    name: 'hover',
    description: 'Move the mouse over an element (ref) or point with trusted input, e.g. to open hover menus or tooltips.',
    args: { target: point.describe('ref_N, or {x, y}'), coords: coordsArg, tab: tabArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const top = await b.context(a.tab);
      const o = await origin(b, top, a.target, a.coords);
      await b.bidi.send('input.performActions', { context: o.context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [o.move] }] });
      return `hovering ${describePoint(a.target, o)}`;
    },
  }),
  tool({
    name: 'scroll',
    description: 'Scroll with trusted mouse-wheel input over an element (ref) or point, or the middle of the viewport. amount is in wheel ticks of 100 px.',
    args: {
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(50).default(3),
      target: point.optional(),
      coords: coordsArg,
      tab: tabArg,
    },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const top = await b.context(a.tab);
      let context = top, x = 0, y = 0, org: any = 'viewport';
      if (a.target !== undefined) {
        const o = await origin(b, top, a.target, a.coords);
        context = o.context;
        if (typeof a.target === 'string') org = o.move.origin; else { x = o.x!; y = o.y!; }
      } else {
        const vp = await b.callPage(top, '() => ({ w: innerWidth, h: innerHeight })');
        x = Math.round(vp.w / 2); y = Math.round(vp.h / 2);
      }
      const d = a.amount * 100;
      const [deltaX, deltaY] = { up: [0, -d], down: [0, d], left: [-d, 0], right: [d, 0] }[a.direction];
      const read = () => b.callPage(top, '() => ({ x: Math.round(scrollX), y: Math.round(scrollY), maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight) })');
      const start = await read();
      let pos = start;
      // Firefox drops input that arrives right after a page load (dom.input_events.security.*; off in claude-dev
      // through the remote agent's recommended prefs, on in personal mode): resend once if nothing moved
      for (let attempt = 0; attempt < 2; attempt++) {
        await b.bidi.send('input.performActions', { context, actions: [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x, y, deltaX, deltaY, origin: org }] }] });
        // smooth scrolling (on in most users' Firefox) animates: wait until the position settles
        let still = 0, moved = false;
        for (const t0 = Date.now(); Date.now() - t0 < 1500;) {
          await new Promise((r) => setTimeout(r, 50));
          const p = await read();
          moved = p.x !== start.x || p.y !== start.y;
          still = p.x === pos.x && p.y === pos.y ? still + 1 : 0;
          pos = p;
          if (moved ? still >= 3 : Date.now() - t0 > 400) break;
        }
        const canMove = deltaY > 0 ? pos.y < pos.maxY : deltaY < 0 ? pos.y > 0 : deltaX < 0 ? pos.x > 0 : true;
        if (moved || !canMove || a.target !== undefined) break;
      }
      return `scrolled ${a.direction} ${a.amount}; page scroll now (${pos.x}, ${pos.y}), max y ${pos.maxY}`;
    },
  }),
  tool({
    name: 'scroll_to',
    description: 'Scroll an element (ref) into the middle of the viewport.',
    args: { ref: refArg },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const n = await resolveRef(b, a.ref);
      const r = await b.callPage(n.context, '(el) => { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; }', [{ sharedId: n.sharedId }]);
      return `${a.ref} now at viewport (${r.x}, ${r.y})`;
    },
  }),
  tool({
    name: 'set_files',
    description: 'Set the files of an <input type=file> (paths inside the workspace or the sandbox folder only).',
    args: { ref: refArg, paths: z.array(z.string()).min(1) },
    write: true,
    async handler(a, ctx) {
      const b = await ctx.browser();
      const files = a.paths.map(checkUploadPath);
      const n = await resolveRef(b, a.ref);
      try {
        await b.bidi.send('input.setFiles', { context: n.context, element: { sharedId: n.sharedId }, files });
      } catch (e: any) {
        // Firefox builds File objects for automation in the content process only with dom.file.createInChild
        // (the remote agent's recommended prefs set it; personal mode switches those off)
        if (b.personal && /InvalidStateError/.test(String(e?.message))) {
          fail('PERSONAL_SETUP_NEEDED', 'file uploads are not enabled for personal mode in this Firefox profile', `The user can enable them by re-running ${setupCommand('personal-mode.ps1')} and answering yes to "file uploads" (sets dom.file.createInChild).`);
        }
        throw e;
      }
      return { text: `${a.ref}: ${files.length} file(s) set`, changes: files.map((f) => ({ kind: 'upload', path: f })) };
    },
  }),
];
