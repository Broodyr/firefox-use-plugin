// scope approvals: before the first lasting change in a task, Claude asks the user once for a
// concrete scope, records it with scope_set, and writes inside it then go ahead without prompting.
import { ToolError } from '../errors.js';

export interface Scope {
  description: string;
  /** areas: prefs | addons | privileged | restore | site_data | downloads | ubo_trust | ext:<alias|id|*> */
  areas: string[];
  /** the user's words approving it, as quoted by Claude */
  userSaid: string;
  approvedAt: string;
  /** warm checkpoint taken before the first change inside this scope */
  checkpoint?: string;
}

export const AREAS_HELP = 'areas: "prefs", "addons", "privileged" (eval_privileged writes), "restore" (restore/undo), "site_data" (cookies, local/session storage, service workers, site_data_clear, site permissions), "downloads" (lets agent tabs download from non-local sites), "ubo_trust" (lets My filters run trusted-* scriptlets), "ext:<ubo|vm|companion|extension id|*>" (that extension\'s storage, messages, managed storage; for ubo: My filters, advanced settings, lists; for vm: userscripts and their values; for stylus: userstyles)';

export const ALIASES: Record<string, string> = {
  ubo: 'uBlock0@raymondhill.net',
  vm: '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}',
  companion: 'companion@firefox-use',
  stylus: '{7a7a4a92-a2a0-41d1-9fd7-1e92480d612d}',
};

export function normalizeArea(a: string): string {
  const m = /^ext:(.+)$/.exec(a.trim());
  if (!m) return a.trim();
  return `ext:${ALIASES[m[1]] ?? m[1]}`;
}

export function covers(scope: Scope | null | undefined, area: string): boolean {
  if (!scope) return false;
  const want = normalizeArea(area);
  return scope.areas.some((a) => a === want || (a === 'ext:*' && want.startsWith('ext:')));
}

export function scopeRequired(area: string, scope: Scope | null | undefined): ToolError {
  return new ToolError('SCOPE_REQUIRED',
    scope ? `"${area}" is outside the approved scope (${scope.description}: ${scope.areas.join(', ')})` : `"${area}" changes lasting state and no scope is approved for this task`,
    `Call scope_set(description, areas) once with the concrete scope (e.g. "modify uBO My filters and Violentmonkey scripts in claude-dev for this task"): it asks the user in an approval dialog when the client has one; otherwise ask in chat first and pass their words as user_said. Then retry. ${AREAS_HELP}.`);
}
