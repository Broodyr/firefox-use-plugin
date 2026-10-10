// The listed tool surface (2026-10-08): one READ and one WRITE tool per area (site_read / site_write, ext_read /
// ext_write, us_*, ubo_*, ff_*), plus a few families merged by kind (wait_for, tabs, console_read, network_read /
// network_write). Claude Code allows tools by name, so "allow every *_read, ask for every *_write" keeps a
// meaningful permission line, and new features become a new kind/action instead of a new tool.
//
// A composite is only a routing layer: resolveTool() maps {kind|action|op: x, ...args} to the existing tool before
// anything else runs, so validation, personal-mode refusals, handoff, scope, masking and the audit log all apply to
// the real operation. The old tool names stay callable (batch steps, regression-test JSON, recipes) but are not listed.
import { ToolError } from '../errors.js';
import { inputSchema, type ToolDef } from './registry.js';

interface Variant {
  value: string;
  /** the existing tool it runs */
  tool: string;
  /** arguments this variant sets itself (not shown to the caller) */
  fixed?: Record<string, unknown>;
  /** allowed values of an argument (e.g. only the reading ops of local_storage in site_read) */
  allow?: Record<string, unknown[]>;
  /** arguments that must not be given in this variant (e.g. ubo lists enable/disable in ubo_read) */
  deny?: string[];
  /** used when the discriminator is left out (old calls keep working) */
  isDefault?: boolean;
  /** one-line description (default: the tool's first sentence) */
  desc?: string;
}

interface Composite { name: string; disc: 'kind' | 'action' | 'op'; readOnly: boolean; summary: string; variants: Variant[] }

const v = (value: string, tool: string, more: Omit<Variant, 'value' | 'tool'> = {}): Variant => ({ value, tool, ...more });

export const COMPOSITES: Composite[] = [
  {
    name: 'tabs', disc: 'op', readOnly: false,
    summary: 'Agent tabs (the "Claude" tab group in the agent window; the user\'s tabs only when they name one).',
    variants: [v('list', 'tabs_list', { isDefault: true }), v('create', 'tabs_create'), v('select', 'tabs_select'), v('close', 'tabs_close')],
  },
  {
    // not read-only: kind "expr" (the default) evaluates page code
    name: 'wait_for', disc: 'kind', readOnly: false,
    summary: 'Wait until something happens (timeout_ms, default 10 s); on timeout the error reports what did happen. Default kind "expr".',
    variants: [
      v('expr', 'wait_for_expr', { isDefault: true }), v('selector', 'wait_for_selector'), v('text', 'wait_for_text'), v('console', 'wait_for_console'),
      v('network_idle', 'wait_for_network_idle'), v('navigation', 'wait_for_navigation'), v('request', 'wait_for_request'),
      v('download', 'downloads_wait'), v('ubo_event', 'wait_for_ubo_event'),
    ],
  },
  {
    name: 'console_read', disc: 'kind', readOnly: true,
    summary: 'The unified console (page, content scripts, userscripts, extensions, workers, Browser Console). Default kind "entries".',
    variants: [v('entries', 'console_entries', { isDefault: true }), v('errors', 'errors_summary'), v('clear', 'console_clear')],
  },
  {
    name: 'network_read', disc: 'kind', readOnly: true,
    summary: 'Network requests of the tabs and extensions. Default kind "requests".',
    variants: [v('requests', 'network_requests', { isDefault: true }), v('body', 'network_body'), v('headers', 'headers_inspect')],
  },
  {
    name: 'network_write', disc: 'action', readOnly: false,
    summary: 'Change the agent tabs\' traffic: mock/fail/delay/rewrite requests, record or replay a HAR.',
    variants: [
      v('mock', 'network_mock'), v('mock_clear', 'network_mock_clear'),
      v('har_record', 'har_record'), v('har_stop', 'har_stop'), v('har_replay', 'har_replay'), v('har_replay_stop', 'har_replay_stop'),
    ],
  },
  {
    name: 'site_read', disc: 'kind', readOnly: true,
    summary: 'Read site data of an origin (default: the current tab\'s; any origin without loading it). Values are masked; unmask names one.',
    variants: [
      v('cookies', 'cookies_get'),
      v('local_storage', 'local_storage', { allow: { op: ['list', 'get', undefined] }, desc: 'localStorage of an origin (op list, default, or get with key); values under secret-looking keys are masked.' }),
      v('session_storage', 'session_storage', { allow: { op: ['list', 'get', undefined] }, desc: 'sessionStorage of the current tab or a frame (op list or get).' }),
      v('indexeddb', 'indexeddb_list'), v('indexeddb_records', 'indexeddb_read'), v('cache_storage', 'cache_storage_list'),
      v('service_workers', 'service_workers', { fixed: { op: 'list' }, desc: 'Service worker registrations of an origin (default the current tab\'s; origin "all" for every one).' }), v('permissions', 'permissions_get'),
    ],
  },
  {
    name: 'site_write', disc: 'action', readOnly: false,
    summary: 'Change site data (scope "site_data"; audited; localStorage changes, new cookies and permissions are undo-able). Clearing a whole site: site_data_clear.',
    variants: [
      v('cookie_set', 'cookies_set'), v('cookie_delete', 'cookies_delete'),
      v('local_storage', 'local_storage', { allow: { op: ['set', 'remove', 'clear'] }, desc: 'localStorage of the tab\'s or any origin: op set (key, value) / remove (key) / clear; undo-able.' }),
      v('session_storage', 'session_storage', { allow: { op: ['set', 'remove', 'clear'] }, desc: 'sessionStorage of the current tab or a frame: op set / remove / clear.' }),
      v('service_worker_unregister', 'service_workers', { fixed: { op: 'unregister' }, desc: 'Unregister service workers of an origin (scope URL, or "all"; not undo-able).' }), v('permission_set', 'permissions_set'),
    ],
  },
  {
    name: 'ext_read', disc: 'kind', readOnly: true,
    summary: 'Read installed extensions: the add-on list, any extension\'s storage, its own files.',
    variants: [v('addons', 'addons_list'), v('storage', 'ext_storage_get'), v('source', 'ext_source')],
  },
  {
    name: 'ext_write', disc: 'action', readOnly: false,
    summary: 'Act on installed extensions (scope "addons" or "ext:<id>"; audited, undo-able where noted).',
    variants: [
      v('enable', 'addons_set_enabled', { fixed: { enabled: true }, desc: 'Enable an add-on (scope "addons"; undo-able).' }), v('disable', 'addons_set_enabled', { fixed: { enabled: false }, desc: 'Disable an add-on (scope "addons"; undo-able).' }),
      v('reload', 'addons_reload'), v('install_local', 'addons_install_local'),
      v('storage_set', 'ext_storage_set'), v('storage_remove', 'ext_storage_remove'), v('managed_storage', 'managed_storage_set'),
      v('message', 'ext_message'), v('page_open', 'ext_page_open'),
    ],
  },
  {
    name: 'us_read', disc: 'kind', readOnly: true,
    summary: 'Read userscripts (Violentmonkey and fast mode): list, GM values, logs, two-way sync status, diff vs the main profile.',
    variants: [
      v('list', 'us_list'), v('values', 'us_values'), v('logs', 'us_logs'), v('sync_status', 'us_sync_status'),
      v('main_diff', 'us_sync_main', { fixed: { apply: false }, desc: 'Compare with the user\'s main profile (only read there): all scripts, or the diff for one script.' }),
    ],
  },
  {
    name: 'us_write', disc: 'action', readOnly: false,
    summary: 'Change userscripts (manager mode needs scope "ext:vm"; fast mode needs none).',
    variants: [
      v('install', 'us_install'), v('update', 'us_update'),
      v('enable', 'us_set_enabled', { fixed: { enabled: true }, desc: 'Enable a userscript (Violentmonkey or fast mode).' }), v('disable', 'us_set_enabled', { fixed: { enabled: false }, desc: 'Disable a userscript (Violentmonkey or fast mode).' }),
      v('uninstall', 'us_uninstall'), v('values_set', 'us_values_set'), v('sync', 'us_sync'),
      v('sync_main', 'us_sync_main', { fixed: { apply: true }, desc: 'Copy one script from the user\'s main profile into claude-dev\'s Violentmonkey (values:true also its GM values; refused for a workspace-linked script unless force).' }), v('dev_prelude', 'us_dev_prelude'), v('fast_gm', 'us_fast_gm'),
    ],
  },
  {
    name: 'stylus_read', disc: 'kind', readOnly: true,
    summary: 'Read Stylus userstyles: list (where each applies, linked workspace file), one style\'s source, which styles match a URL or tab, check a .user.css without installing, sync status.',
    variants: [v('list', 'stylus_list', { isDefault: true }), v('source', 'stylus_source'), v('for_url', 'stylus_for_url'), v('check', 'stylus_check'), v('sync_status', 'stylus_sync_status')],
  },
  {
    name: 'stylus_write', disc: 'action', readOnly: false,
    summary: 'Change Stylus userstyles from workspace .user.css files (scope "ext:stylus"; audited, undo-able; open tabs restyle at once).',
    variants: [
      v('install', 'stylus_install'), v('update', 'stylus_update'),
      v('enable', 'stylus_set_enabled', { fixed: { enabled: true }, desc: 'Enable a Stylus style.' }), v('disable', 'stylus_set_enabled', { fixed: { enabled: false }, desc: 'Disable a Stylus style.' }),
      v('uninstall', 'stylus_uninstall'), v('vars', 'stylus_vars'), v('sync', 'stylus_sync'), v('watch', 'stylus_watch'),
    ],
  },
  {
    name: 'ubo_read', disc: 'kind', readOnly: true,
    summary: 'Read uBlock Origin: status, advanced settings, My filters, lists, the logger; test a filter or scriptlet without saving it; backup.',
    variants: [
      v('status', 'ubo_status'), v('advanced', 'ubo_advanced_get'), v('filters', 'ubo_filters_get'),
      v('lists', 'ubo_lists', { deny: ['enable', 'disable'] }), v('logger', 'ubo_logger'),
      v('test_filter', 'ubo_test_filter'), v('test_scriptlet', 'ubo_test_scriptlet'), v('backup', 'ubo_backup'),
    ],
  },
  {
    name: 'ubo_write', disc: 'action', readOnly: false,
    summary: 'Change uBlock Origin (scope "ext:ubo"; trust needs "ubo_trust"; audited, undo-able).',
    variants: [
      v('advanced_set', 'ubo_advanced_set'), v('filters_set', 'ubo_filters_set'), v('filters_add', 'ubo_filters_add'), v('filters_remove', 'ubo_filters_remove'),
      v('trust_my_filters', 'ubo_trust_my_filters'), v('lists', 'ubo_lists'),
      v('set_resources', 'ubo_set_resources'), v('reload_resources', 'ubo_reload_resources'), v('restore', 'ubo_restore'),
    ],
  },
  {
    name: 'ff_read', disc: 'kind', readOnly: true,
    summary: 'Read browser state: prefs, checkpoints, downloads, the audit log, the clipboard, the dialog and HTTP-auth policies.',
    variants: [
      v('prefs', 'ff_prefs_get'), v('snapshots', 'snapshot_list'), v('snapshot_diff', 'snapshot_diff'), v('downloads', 'downloads_list'),
      v('audit', 'ff_audit_show'), v('clipboard', 'clipboard_read'),
      v('dialogs', 'dialogs_policy', { deny: ['alert', 'confirm', 'prompt', 'beforeunload', 'prompt_text', 'reset'] }),
      v('http_auth', 'http_auth', { deny: ['mode', 'url', 'username', 'password'] }),
    ],
  },
  {
    name: 'ff_write', disc: 'action', readOnly: false,
    summary: 'Change browser state: prefs (scope "prefs"), checkpoints, dialog policy / answer, HTTP auth, the clipboard, version pins.',
    variants: [
      v('prefs_set', 'ff_prefs_set'), v('snapshot', 'snapshot'), v('snapshot_cold', 'snapshot_cold'),
      v('dialogs_policy', 'dialogs_policy'), v('dialog_answer', 'dialog_handle'), v('http_auth', 'http_auth'),
      v('clipboard', 'clipboard_write'), v('pins', 'pins_update'),
    ],
  },
];

const BY_COMPOSITE = new Map(COMPOSITES.map((c) => [c.name, c]));

/** Tools that are reached only through a composite (callable, not listed). */
export const HIDDEN = new Set(COMPOSITES.flatMap((c) => c.variants.map((x) => x.tool)));

/**
 * A composite call -> the tool it runs, with its arguments (the discriminator removed, fixed values set).
 * Underlying names pass through unchanged, so resolving twice is harmless.
 */
export function resolveTool(name: string, args: Record<string, unknown>): string {
  const c = BY_COMPOSITE.get(name);
  if (!c) return name;
  const d = args[c.disc];
  const variant = d === undefined ? c.variants.find((x) => x.isDefault) : c.variants.find((x) => x.value === d);
  if (!variant) {
    throw new ToolError('BAD_ARGS', d === undefined ? `${name} needs ${c.disc}` : `${name}: unknown ${c.disc} ${JSON.stringify(d)}`,
      `${c.disc}: ${c.variants.map((x) => `"${x.value}"`).join(', ')}`);
  }
  // check everything before changing args: a failed call is resolved again (and reported) by runTool
  for (const [k, vals] of Object.entries(variant.allow ?? {})) {
    if (!vals.includes(args[k])) throw new ToolError('BAD_ARGS', `${name} ${c.disc} "${variant.value}": ${k} must be one of ${vals.filter((x) => x !== undefined).map((x) => JSON.stringify(x)).join(', ')}`, c.readOnly ? `Changes go through ${name.replace(/_read$/, '_write')}.` : `Reading goes through ${name.replace(/_write$/, '_read')}.`);
  }
  for (const k of variant.deny ?? []) {
    if (args[k] !== undefined) throw new ToolError('BAD_ARGS', `${name} ${c.disc} "${variant.value}" does not take ${k}`, c.readOnly ? `Changes go through ${name.replace(/_read$/, '_write')}.` : '');
  }
  delete args[c.disc];
  Object.assign(args, variant.fixed ?? {});
  return variant.tool;
}

const firstSentence = (s: string) => {
  // "e.g." and friends don't end a sentence
  const t = s.replace(/\s+/g, ' ').replace(/\b(e\.g|i\.e|etc)\./g, '$1\u0001');
  const m = /^(.{20,240}?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t.slice(0, 240)).replace(/\u0001/g, '.').trim();
};

/** old tool names in descriptions -> the composite call that replaces them (aliases still work, but read the new form) */
const RENAMES: [RegExp, string][] = COMPOSITES.flatMap((c) => c.variants.filter((x) => x.tool !== c.name && !BY_COMPOSITE.has(x.tool))
  .map((x) => [new RegExp(`\\b${x.tool}\\b(?!\\()`, 'g'), `${c.name}(${c.disc}: "${x.value}")`] as [RegExp, string]));
export function renameRefs(s: string): string { for (const [re, to] of RENAMES) s = s.replace(re, to); return s; }

/**
 * What the permission hook (server/hooks/permissions.mjs) needs to know: each listed tool's read-only flag, and the
 * listed tool an unlisted name runs under (the write composite when both reach it, e.g. local_storage).
 */
export function toolManifest(listed: { name: string; annotations?: Record<string, unknown> }[]): { tools: Record<string, { readOnly: boolean }>; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};
  for (const c of COMPOSITES) for (const x of c.variants) if (!aliases[x.tool] || !c.readOnly) aliases[x.tool] = c.name;
  return { tools: Object.fromEntries(listed.map((t) => [t.name, { readOnly: t.annotations?.readOnlyHint === true }])), aliases };
}

/** The listed tools: composites (flat object schemas, discriminator first) plus every tool not reached through one. */
export function listedTools(tools: ToolDef[]): { name: string; description: string; inputSchema: any; annotations?: Record<string, unknown> }[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const out = tools.filter((t) => !HIDDEN.has(t.name) && !BY_COMPOSITE.has(t.name))
    .map((t) => ({ name: t.name, description: renameRefs(t.description), inputSchema: inputSchema(t), ...(t.write ? {} : { annotations: { readOnlyHint: true } }) }));
  for (const c of COMPOSITES) {
    const props: Record<string, any> = {};
    const usedBy = new Map<string, string[]>();
    const lines: string[] = [];
    for (const x of c.variants) {
      const def = byName.get(x.tool);
      if (!def) throw new Error(`composite ${c.name}: no tool ${x.tool}`);
      lines.push(`- ${c.disc} "${x.value}"${x.isDefault ? ' (default)' : ''}: ${x.desc ?? firstSentence(renameRefs(def.description))}`);
      const js: any = inputSchema(def);
      for (let [k, s] of Object.entries<any>(js.properties ?? {})) {
        if (x.fixed && k in x.fixed) continue;
        if (x.deny?.includes(k)) continue;
        // only the values this variant accepts (site_read: op list|get)
        if (x.allow?.[k] && Array.isArray(s.enum)) s = { ...s, enum: s.enum.filter((e: unknown) => x.allow![k].includes(e)), default: undefined };
        if (s.description) s = { ...s, description: renameRefs(s.description) };
        const u = usedBy.get(k) ?? [];
        u.push(x.value);
        usedBy.set(k, u);
        if (!props[k]) { props[k] = { ...s }; continue; }
        const { description: _a, default: _b, ...p } = props[k];
        const { description: _c, default: _d, ...q } = s;
        // the same name with another type in another variant: accept anything here, the tool validates it
        if (JSON.stringify(p) === JSON.stringify(q)) continue;
        // the same values from several variants: one enum
        if (Array.isArray(p.enum) && Array.isArray(q.enum) && p.type === q.type) { props[k] = { ...props[k], enum: [...new Set([...p.enum, ...q.enum])] }; continue; }
        props[k] = { description: [props[k].description, s.description].filter(Boolean).filter((d, i, all) => all.indexOf(d) === i).join(' / ') };
      }
    }
    const all = c.variants.length;
    for (const [k, u] of usedBy) {
      if (u.length >= all || ['max_chars', 'detail', 'unmask'].includes(k)) continue;
      props[k] = { ...props[k], description: `${props[k].description ? `${props[k].description} ` : ''}(${c.disc}: ${u.join(', ')})` };
    }
    const disc = { type: 'string', enum: c.variants.map((x) => x.value), description: `What to ${c.readOnly ? 'read' : c.name === 'tabs' ? 'do' : 'change'}${c.variants.some((x) => x.isDefault) ? `; default "${c.variants.find((x) => x.isDefault)!.value}"` : ''}` };
    out.push({
      name: c.name,
      description: `${c.summary}\n${lines.join('\n')}`,
      inputSchema: { type: 'object', properties: { [c.disc]: disc, ...props }, ...(c.variants.some((x) => x.isDefault) ? {} : { required: [c.disc] }), additionalProperties: false },
      annotations: { readOnlyHint: c.readOnly },
    });
  }
  return out;
}
