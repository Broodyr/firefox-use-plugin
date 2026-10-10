// Accessibility snapshots (read_page / find) and ref_N handles.
// A ref stays valid until its tab navigates. It's resolved to a DOM node through the BiDi
// accessibility locator (role + name + occurrence), falling back to tag/id + geometry.

export interface RawNode {
  depth: number; role: string; aria: string; name: string; value: string; states: number;
  x: number; y: number; w: number; h: number; uid: string; tag: string; idAttr: string; frameUrl: string; level: string;
}

export interface RefInfo {
  ref: string; context: string; uid: string; aria: string; name: string; nth: number;
  tag: string; idAttr: string; frameUrl: string; x: number; y: number; w: number; h: number; scrollX: number; scrollY: number;
}

export interface Snapshot { id: string; context: string; lines: Map<string, string>; order: string[] }

const S = {
  UNAVAILABLE: 0x1, SELECTED: 0x2, FOCUSED: 0x4, PRESSED: 0x8, CHECKED: 0x10, MIXED: 0x20, READONLY: 0x40,
  EXPANDED: 0x200, COLLAPSED: 0x400, BUSY: 0x800, INVISIBLE: 0x8000, FOCUSABLE: 0x100000, REQUIRED: 0x4000000, PROTECTED: 0x20000000,
};

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell']);
const INTERACTIVE_GECKO = new Set(['pushbutton', 'link', 'entry', 'password text', 'checkbutton', 'radiobutton', 'combobox',
  'listbox', 'option', 'combobox option', 'menuitem', 'check menu item', 'radio menu item', 'page tab', 'switch', 'slider',
  'spinbutton', 'toggle button', 'outlineitem', 'buttonmenu', 'summary']);
const SKIP_ROLES = new Set(['text leaf', 'whitespace', 'statictext', 'internal frame', 'combobox list']);
const CONTAINER = new Set(['section', 'text container', 'generic', 'paragraph', 'document', 'list item', 'list', 'table cell', 'grouping', 'form', 'landmark', 'label', 'text']);

export const toRaw = (n: any[]): RawNode => ({
  depth: n[0], role: n[1], aria: n[2], name: n[3], value: n[4], states: n[5], x: n[6], y: n[7], w: n[8], h: n[9],
  uid: n[10], tag: n[11], idAttr: n[12], frameUrl: n[13], level: n[14],
});

export class RefStore {
  private next = 1;
  private byRef = new Map<string, RefInfo>();
  private byUid = new Map<string, string>(); // `${context}|${uid}` -> ref
  private snaps = new Map<string, Snapshot>();
  private snapSeq = 1;

  resetContext(context: string) {
    for (const [ref, info] of this.byRef) if (info.context === context) { this.byRef.delete(ref); this.byUid.delete(`${context}|${info.uid}`); }
    for (const [id, s] of this.snaps) if (s.context === context) this.snaps.delete(id);
  }

  get(ref: string) { return this.byRef.get(ref.replace(/^\[|\]$/g, '')); }

  /** Assign refs for one walk. Returns per-node ref names and whether each is interactive. */
  assign(context: string, nodes: RawNode[], scroll: { x: number; y: number }): string[] {
    const seen = new Map<string, number>();
    return nodes.map((n) => {
      const key = `${n.aria}\u0000${n.name}`;
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      if (SKIP_ROLES.has(n.role) || (n.depth === 0 && n.role === 'document')) return '';
      const k = `${context}|${n.uid}`;
      let ref = this.byUid.get(k);
      if (!ref) { ref = `ref_${this.next++}`; this.byUid.set(k, ref); }
      this.byRef.set(ref, { ref, context, uid: n.uid, aria: n.aria, name: n.name, nth, tag: n.tag, idAttr: n.idAttr, frameUrl: n.frameUrl,
        x: n.x, y: n.y, w: n.w, h: n.h, scrollX: scroll.x, scrollY: scroll.y });
      return ref;
    });
  }

  saveSnapshot(context: string, lines: Map<string, string>, order: string[]): string {
    const id = `snap_${this.snapSeq++}`;
    this.snaps.set(id, { id, context, lines, order });
    const forCtx = [...this.snaps.values()].filter((s) => s.context === context);
    while (forCtx.length > 8) this.snaps.delete(forCtx.shift()!.id);
    return id;
  }

  getSnapshot(id: string) { return this.snaps.get(id); }
}

export const isInteractive = (n: RawNode) =>
  INTERACTIVE.has(n.aria) || INTERACTIVE_GECKO.has(n.role) || ((n.states & S.FOCUSABLE) !== 0 && n.role !== 'document');

function stateTags(n: RawNode): string[] {
  const t: string[] = [];
  if (n.states & S.UNAVAILABLE) t.push('disabled');
  if (n.states & S.CHECKED) t.push('checked');
  if (n.states & S.MIXED) t.push('mixed');
  if (n.states & S.PRESSED) t.push('pressed');
  if ((n.states & S.SELECTED) && ['option', 'combobox option', 'page tab', 'outlineitem', 'gridcell'].includes(n.role)) t.push('selected');
  if (n.states & S.EXPANDED) t.push('expanded');
  if (n.states & S.REQUIRED) t.push('required');
  if (n.states & S.READONLY && ['entry', 'textbox'].includes(n.role)) t.push('readonly');
  if (n.states & S.FOCUSED) t.push('focused');
  return t;
}

const q = (s: string, max = 100) => JSON.stringify(s.length > max ? s.slice(0, max) + '…' : s);

/** One line per node. Returns null for nodes the filter hides. */
export function renderNode(n: RawNode, ref: string, vw: number, vh: number, filter: 'interactive' | 'all', parentName: string): string | null {
  if (!ref) return null;
  const interactive = isInteractive(n);
  if (filter === 'interactive' && !interactive && n.role !== 'heading') return null;
  if (filter === 'all' && CONTAINER.has(n.role) && !n.name && !interactive) return null;
  if (filter === 'all' && !interactive && n.name && n.name === parentName && CONTAINER.has(n.role)) return null;
  const role = n.aria || n.role;
  let s = `[${ref}] ${role}`;
  if (n.role === 'heading' && n.level) s += ` h${n.level}`;
  if (n.name) s += ` ${q(n.name)}`;
  const isPw = (n.states & S.PROTECTED) !== 0 || n.role === 'password text';
  if (n.value && n.role !== 'link' && !(n.role === 'heading')) s += ` value=${isPw ? '"<masked>"' : q(n.value, 80)}`;
  if (n.role === 'link' && n.value) s += ` -> ${q(n.value, 80)}`;
  const st = stateTags(n);
  if (st.length) s += ` [${st.join(', ')}]`;
  if (n.w === 0 && n.h === 0) s += ' (hidden)';
  else if (n.y + n.h < 0 || n.y > vh || n.x + n.w < 0 || n.x > vw) s += ' (offscreen)';
  if (n.frameUrl) s += ' (in iframe)';
  return s;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  for (const ref of b.order) {
    const before = a.lines.get(ref), now = b.lines.get(ref)!;
    if (before === undefined) out.push(`+ ${now}`);
    else if (before !== now) out.push(`~ ${now}`);
  }
  for (const ref of a.order) if (!b.lines.has(ref)) out.push(`- ${a.lines.get(ref)}`);
  return out;
}
