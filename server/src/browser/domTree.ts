// Personal mode: read_page / find without chrome access. The parent-process accessibility tree
// needs privileged code, so this walk computes roles, names and states from the DOM instead, in this
// server's isolated sandbox (invisible to the page). It returns the same rows as chromeScripts A11Y_WALK, so
// refs.ts renders both the same way. Node ids ("d<n>") are kept in a sandbox Map of WeakRefs, which is how
// resolve.ts turns a ref back into the element (the BiDi accessibility locator needs Firefox's a11y service).
//
// Approximations: the accessible name follows the common steps of accname (aria-labelledby, aria-label,
// labels, alt/title/placeholder, contents for roles named from content); same-origin iframes and open shadow
// roots are walked; cross-origin iframes appear as one node and are not read.

/** Gecko-style role names used by refs.ts (INTERACTIVE_GECKO, CONTAINER, SKIP_ROLES) for an ARIA role. */
export const DOM_WALK = `(maxNodes) => {
  const S = { UNAVAILABLE: 0x1, SELECTED: 0x2, FOCUSED: 0x4, PRESSED: 0x8, CHECKED: 0x10, MIXED: 0x20, READONLY: 0x40,
    EXPANDED: 0x200, COLLAPSED: 0x400, FOCUSABLE: 0x100000, REQUIRED: 0x4000000, PROTECTED: 0x20000000 };
  const GECKO = { button: 'pushbutton', link: 'link', textbox: 'entry', searchbox: 'entry', checkbox: 'checkbutton', radio: 'radiobutton',
    combobox: 'combobox', listbox: 'listbox', option: 'option', menuitem: 'menuitem', menuitemcheckbox: 'check menu item',
    menuitemradio: 'radio menu item', tab: 'page tab', switch: 'switch', slider: 'slider', spinbutton: 'spinbutton', treeitem: 'outlineitem',
    heading: 'heading', img: 'graphic', list: 'list', listitem: 'list item', paragraph: 'paragraph', table: 'table', row: 'row',
    cell: 'table cell', gridcell: 'gridcell', columnheader: 'columnheader', rowheader: 'rowheader', form: 'form', group: 'grouping',
    navigation: 'landmark', main: 'landmark', banner: 'landmark', contentinfo: 'landmark', complementary: 'landmark', region: 'landmark',
    search: 'landmark', dialog: 'dialog', alert: 'alert', progressbar: 'progressbar', separator: 'separator', menu: 'menupopup',
    menubar: 'menubar', tablist: 'page tab list', tabpanel: 'property page', tree: 'outline', grid: 'table', article: 'article',
    figure: 'figure', status: 'status', toolbar: 'toolbar', generic: 'section', iframe: 'internal frame', label: 'label' };
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
    'treeitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'checkbox', 'radio', 'switch', 'label', 'listitem', 'row']);
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title']);
  const INPUT_ROLE = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio',
    range: 'slider', number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox',
    password: 'textbox', date: 'textbox', 'datetime-local': 'textbox', month: 'textbox', week: 'textbox', time: 'textbox', color: 'button', file: 'button' };

  function implicitRole(el) {
    const t = el.localName;
    switch (t) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'button': case 'summary': return 'button';
      case 'input': return el.type === 'hidden' ? '' : (INPUT_ROLE[el.type] ?? 'textbox') === 'textbox' && el.list ? 'combobox' : (INPUT_ROLE[el.type] ?? 'textbox');
      case 'textarea': return 'textbox';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'option': return 'option';
      case 'img': return el.getAttribute('alt') === '' ? '' : 'img';
      case 'svg': return el.hasAttribute('aria-label') || el.querySelector(':scope > title') ? 'img' : '';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'p': return 'paragraph';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return el.closest('article, aside, main, nav, section') ? '' : 'banner';
      case 'footer': return el.closest('article, aside, main, nav, section') ? '' : 'contentinfo';
      case 'aside': return 'complementary';
      case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'form': return 'form';
      case 'fieldset': return 'group';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return el.scope === 'row' ? 'rowheader' : 'columnheader';
      case 'dialog': return 'dialog';
      case 'hr': return 'separator';
      case 'progress': return 'progressbar';
      case 'article': return 'article';
      case 'figure': return 'figure';
      case 'label': return 'label';
      case 'iframe': return 'iframe';
      case 'details': return 'group';
      default: return '';
    }
  }
  const roleOf = (el) => (el.getAttribute('role') || '').trim().split(/\\s+/)[0] || implicitRole(el);
  const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const textOf = (el, depth = 0) => {
    if (depth > 20) return '';
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.data;
      else if (n.nodeType === 1) {
        if (SKIP_TAGS.has(n.localName) || n.getAttribute('aria-hidden') === 'true') continue;
        // a label's embedded control contributes its value, not its contents (accname 2E); keep it simple: skip it
        if (n.localName === 'select' || n.localName === 'textarea' || n.localName === 'input') continue;
        if (n.localName === 'img') s += ' ' + (n.getAttribute('alt') ?? '') + ' ';
        else if (n.localName === 'br') s += ' ';
        else { const lbl = n.getAttribute('aria-label'); s += ' ' + (lbl ?? textOf(n, depth + 1)) + ' '; }
      }
      if (s.length > 2000) break;
    }
    return s;
  };
  function nameOf(el, role) {
    const doc = el.ownerDocument;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = clean(lb.split(/\\s+/).map((id) => { const x = doc.getElementById(id); return x ? (x.getAttribute('aria-label') ?? textOf(x)) : ''; }).join(' ')); if (t) return t; }
    const al = clean(el.getAttribute('aria-label')); if (al) return al;
    const t = el.localName;
    if (t === 'input' || t === 'textarea' || t === 'select') {
      if (t === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value) || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '');
      if (t === 'input' && el.type === 'image') return clean(el.alt || el.value || 'Submit');
      const ls = el.labels ? [...el.labels].map((l) => clean(textOf(l))).filter(Boolean).join(' ') : '';
      if (ls) return ls;
      return clean(el.title || el.placeholder || '');
    }
    if (t === 'img' || t === 'area') return clean(el.getAttribute('alt') || el.title);
    if (t === 'svg') return clean(el.querySelector(':scope > title')?.textContent || '');
    if (t === 'fieldset') { const lg = el.querySelector(':scope > legend'); if (lg) return clean(textOf(lg)); }
    if (t === 'table') { const c = el.querySelector(':scope > caption'); if (c) return clean(textOf(c)); }
    if (t === 'figure') { const c = el.querySelector(':scope > figcaption'); if (c) return clean(textOf(c)); }
    if (t === 'iframe') return clean(el.title || el.name || '');
    if (NAME_FROM_CONTENT.has(role)) { const c = clean(textOf(el)); if (c) return c.slice(0, 1000); }
    return clean(el.title || '');
  }
  function valueOf(el, role) {
    const t = el.localName;
    if (role === 'link') return el.href ? String(el.href) : '';
    if (t === 'input' && (el.type === 'checkbox' || el.type === 'radio' || ['button', 'submit', 'reset', 'image', 'file'].includes(el.type))) return '';
    if (t === 'input' && el.type === 'password') return el.value ? '●'.repeat(Math.min(el.value.length, 8)) : '';
    if (t === 'input' || t === 'textarea') return String(el.value ?? '');
    if (t === 'select') return [...el.selectedOptions].map((o) => clean(o.label || o.text)).join(', ');
    if (t === 'progress' || role === 'slider' || role === 'spinbutton' || role === 'progressbar') return String(el.getAttribute('aria-valuenow') ?? el.value ?? '');
    if (el.isContentEditable && (role === 'textbox' || el === el.ownerDocument.activeElement)) return clean(el.textContent).slice(0, 500);
    return '';
  }
  const ariaBool = (el, a) => el.getAttribute(a);
  function statesOf(el, role) {
    let s = 0;
    const t = el.localName;
    if (el.disabled || ariaBool(el, 'aria-disabled') === 'true') s |= S.UNAVAILABLE;
    const checked = ariaBool(el, 'aria-checked');
    if ((t === 'input' && (el.type === 'checkbox' || el.type === 'radio') && el.checked) || checked === 'true') s |= S.CHECKED;
    if ((t === 'input' && el.indeterminate) || checked === 'mixed') s |= S.MIXED;
    if (ariaBool(el, 'aria-pressed') === 'true') s |= S.PRESSED;
    if (ariaBool(el, 'aria-selected') === 'true' || (t === 'option' && el.selected)) s |= S.SELECTED;
    const ex = ariaBool(el, 'aria-expanded') ?? (t === 'details' ? String(el.open) : t === 'summary' && el.parentElement?.localName === 'details' ? String(el.parentElement.open) : null);
    if (ex === 'true') s |= S.EXPANDED; else if (ex === 'false') s |= S.COLLAPSED;
    if (el.required || ariaBool(el, 'aria-required') === 'true') s |= S.REQUIRED;
    if (el.readOnly || ariaBool(el, 'aria-readonly') === 'true') s |= S.READONLY;
    if (t === 'input' && el.type === 'password') s |= S.PROTECTED;
    if (el === el.ownerDocument.activeElement && el !== el.ownerDocument.body) s |= S.FOCUSED;
    if (el.tabIndex >= 0 && !el.disabled) s |= S.FOCUSABLE;
    return s;
  }

  const ids = (window.__cfNodes ??= new Map());
  const idOf = (window.__cfIdOf ??= new WeakMap());
  window.__cfNextId ??= 1;
  const uid = (n) => { let id = idOf.get(n); if (!id) { id = 'd' + window.__cfNextId++; idOf.set(n, id); ids.set(id, new WeakRef(n)); } return id; };
  // forget ids of nodes that are gone (WeakRefs cleared by GC)
  if (ids.size > 50000) for (const [k, r] of ids) if (!r.deref()) ids.delete(k);

  const nodes = [];
  let truncated = false;
  const push = (row) => { if (nodes.length >= maxNodes) { truncated = true; return false; } nodes.push(row); return true; };
  const range = document.createRange();

  function walk(node, depth, fx, fy, frameUrl) {
    if (truncated) return;
    if (node.nodeType === 3) {
      const text = clean(node.data);
      if (!text) return;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      push([depth, 'text leaf', '', text.slice(0, 1000), '', 0, Math.round(r.left + fx), Math.round(r.top + fy), Math.round(r.width), Math.round(r.height), uid(node), '', '', frameUrl, '']);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;
    if (node.nodeType !== 1) { for (const c of node.childNodes) walk(c, depth, fx, fy, frameUrl); return; }
    const el = node;
    const t = el.localName;
    if (SKIP_TAGS.has(t) || el.getAttribute('aria-hidden') === 'true' || el.hidden || (t === 'input' && el.type === 'hidden')) return;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (!cs || cs.display === 'none') return;
    const invisible = cs.visibility === 'hidden' || cs.visibility === 'collapse';
    let role = roleOf(el);
    if (role === 'presentation' || role === 'none') role = '';
    if (!role && el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) role = 'textbox';
    if (!role && (el.onclick || el.getAttribute('onclick') !== null) && el.tabIndex >= 0) role = 'button';
    const r = el.getBoundingClientRect();
    let childDepth = depth;
    if (role && !invisible) {
      const name = nameOf(el, role);
      const level = role === 'heading' ? (el.getAttribute('aria-level') || (/^h([1-6])$/.exec(t)?.[1] ?? '2')) : '';
      if (!push([depth, GECKO[role] ?? role, role === 'iframe' ? '' : role, name, valueOf(el, role), statesOf(el, role),
        Math.round(r.left + fx), Math.round(r.top + fy), Math.round(r.width), Math.round(r.height), uid(el), t, el.id || '', frameUrl, String(level)])) return;
      childDepth = depth + 1;
    }
    if (t === 'iframe' || t === 'frame') {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      const ox = r.left + fx + el.clientLeft, oy = r.top + fy + el.clientTop;
      if (doc && doc.documentElement) walk(doc.body ?? doc.documentElement, childDepth, ox, oy, String(doc.URL));
      else push([childDepth, 'grouping', 'group', 'cross-origin frame (not read): ' + (el.src || '').slice(0, 200), '', 0, Math.round(r.left + fx), Math.round(r.top + fy), Math.round(r.width), Math.round(r.height), uid(el) + 'x', t, el.id || '', frameUrl, '']);
      return;
    }
    if (role === 'textbox' && (t === 'input' || t === 'textarea')) return; // its value is shown on the node
    if (t === 'select') { for (const o of el.options) walk(o, childDepth, fx, fy, frameUrl); return; }
    const kids = el.shadowRoot ? el.shadowRoot.childNodes : t === 'slot' ? el.assignedNodes({ flatten: true }) : el.childNodes;
    for (const c of (kids.length || t !== 'slot' ? kids : el.childNodes)) walk(c, childDepth, fx, fy, frameUrl);
  }
  const rootEl = document.body ?? document.documentElement;
  push([0, 'document', 'document', document.title, '', 0, 0, 0, innerWidth, innerHeight, uid(document), '', '', '', '']);
  if (rootEl) walk(rootEl, 1, 0, 0, '');
  return { url: location.href, title: document.title, vw: innerWidth, vh: innerHeight, truncated, nodes };
}`;

/** Sandbox lookup of a DOM-walk node id (resolve.ts). */
export const DOM_NODE = `(id) => { const n = window.__cfNodes?.get(id)?.deref(); return n && n.isConnected ? n : null; }`;
