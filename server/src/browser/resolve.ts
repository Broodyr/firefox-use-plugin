import { fail } from '../errors.js';
import type { Browser } from './session.js';
import { DOM_NODE } from './domTree.js';

export interface NodeRef { context: string; sharedId: string }

/** Find the BiDi context of the frame a ref lives in (top-level context when not in an iframe). */
async function frameContext(b: Browser, top: string, frameUrl: string): Promise<string> {
  if (!frameUrl) return top;
  const tree = await b.bidi.send('browsingContext.getTree', { root: top });
  const flat: { context: string; url: string }[] = [];
  const walk = (c: any) => { flat.push(c); for (const ch of c.children ?? []) walk(ch); };
  for (const c of tree.contexts) walk(c);
  return flat.find((c) => c.context !== top && c.url === frameUrl)?.context ?? top;
}

/** ref_N -> DOM node shared reference. */
export async function resolveRef(b: Browser, ref: string): Promise<NodeRef> {
  const r = b.refs.get(ref);
  if (!r) return fail('REF_NOT_FOUND', `unknown or expired ${ref}`, 'Refs expire on navigation. Call read_page or find again.');
  if (/^d\d+$/.test(r.uid)) {
    // DOM-walk ref (personal mode): the node is kept in this server's sandbox of the tab (iframes included)
    const n = await b.callPage(r.context, DOM_NODE, [r.uid], { raw: true }).catch(() => null);
    if (n?.type === 'node' && n.sharedId) return { context: r.context, sharedId: n.sharedId };
    return fail('REF_STALE', `${ref} (${r.aria || r.tag} ${JSON.stringify(r.name)}) is no longer in the page`, 'The page changed. Call read_page again.');
  }
  const context = await frameContext(b, r.context, r.frameUrl);
  if (r.aria && r.name) {
    try {
      const res = await b.bidi.send('browsingContext.locateNodes', {
        context, locator: { type: 'accessibility', value: { role: r.aria, name: r.name } }, maxNodeCount: r.nth + 1,
      });
      const n = res.nodes?.[r.nth];
      if (n?.sharedId) return { context, sharedId: n.sharedId };
    } catch { /* fall through to geometry */ }
  }
  // fallback: same tag (or id), closest to the recorded document position
  const found = await b.callPage(context, `(tag, id, x, y, w, h) => {
    const cands = id ? [document.getElementById(id)].filter(Boolean) : [...document.getElementsByTagName(tag || '*')];
    let best = null, bestD = Infinity;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.left + scrollX - x) + Math.abs(r.top + scrollY - y) + Math.abs(r.width - w) + Math.abs(r.height - h);
      if (d < bestD) { best = el; bestD = d; }
    }
    return bestD < 40 ? best : null;
  }`, [r.tag, r.idAttr, r.x + r.scrollX, r.y + r.scrollY, r.w, r.h], { raw: true });
  if (found?.type === 'node' && found.sharedId) return { context, sharedId: found.sharedId };
  return fail('REF_STALE', `${ref} (${r.aria || r.tag} ${JSON.stringify(r.name)}) is no longer in the page`, 'The page changed. Call read_page again.');
}
