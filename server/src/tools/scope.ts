// scope approvals.
import { z } from 'zod';
import { syncDownloadApprovals } from '../browser/downloads.js';
import { ALIASES, AREAS_HELP, normalizeArea, type Scope } from '../browser/scope.js';
import { fail } from '../errors.js';
import { tool, type Ctx } from './registry.js';

const AREA = /^(prefs|addons|privileged|restore|site_data|downloads|ubo_trust|ext:.+)$/;

const AREA_WORDS: Record<string, string> = {
  prefs: 'Firefox preferences', addons: 'add-ons (enable, disable, reload, install local builds)', privileged: 'privileged browser code that writes',
  restore: 'restoring snapshots / undo', site_data: 'site data (cookies, storage, site permissions)', downloads: 'downloads from non-local sites (into the sandbox folder)', ubo_trust: 'let uBO My filters run trusted-* scriptlets',
};
const areaWords = (a: string) => AREA_WORDS[a] ?? (a.startsWith('ext:') ? `extension ${Object.entries(ALIASES).find(([, v]) => v === a.slice(4))?.[0] ?? a.slice(4)} (its storage, settings, scripts)` : a);

/** Answers faster than this came from the client, not a person (the Claude desktop app has declined unseen in 5-12 ms). */
export const MIN_HUMAN_ANSWER_MS = 500;

/** Wrap an elicitation sender: an answer faster than a person could give means the dialog wasn't shown ("cancel"). */
export function humanElicit(send: NonNullable<Ctx['elicit']>): NonNullable<Ctx['elicit']> {
  return async (p) => {
    const t0 = Date.now();
    const r = await send(p);
    const ms = Date.now() - t0;
    return ms < MIN_HUMAN_ANSWER_MS ? { action: 'cancel', content: { instantMs: ms, instantAction: r.action } } : r;
  };
}

/** Ask the user directly with an MCP elicitation dialog. */
export async function askUser(elicit: NonNullable<Ctx['elicit']>, description: string, areas: string[]): Promise<{ decision: 'task' | 'session' | 'decline' } | { error: string }> {
  const r = await elicit({
    message: `Claude wants to make lasting changes in the claude-dev Firefox profile:\n\n${description}\n\nAreas:\n${areas.map((x) => `• ${areaWords(x)}`).join('\n')}\n\nA checkpoint is taken first, and every change is audited and can be undone.`,
    requestedSchema: {
      type: 'object',
      properties: { decision: { type: 'string', title: 'Your decision', enum: ['task', 'session', 'decline'], enumNames: ['Approve for this task', 'Approve for the rest of this session', 'Decline'] } },
      required: ['decision'],
    },
  });
  // "cancel" = dismissed or never shown (some clients advertise elicitation but don't display it, or answer it unseen: humanElicit): no answer, not a no
  if (r.action === 'cancel') {
    const c = r.content as { instantMs?: number; instantAction?: string } | undefined;
    return { error: c?.instantMs !== undefined ? `the client answered "${c.instantAction}" in ${c.instantMs} ms, too fast for a person, so the dialog wasn't shown` : 'the approval dialog was dismissed or not shown' };
  }
  if (r.action !== 'accept') return { decision: 'decline' };
  const d = (r.content as any)?.decision;
  return { decision: d === 'session' ? 'session' : d === 'task' ? 'task' : 'decline' };
}

export const scopeTools = [
  tool({
    name: 'scope_set',
    description: `Get the USER's approval for this task's lasting changes, once per task. When the client supports approval dialogs, this call itself asks the user (Approve for this task / for the rest of this session / Decline); otherwise ask in chat first, naming the concrete scope, and pass their words as user_said. Changes inside the scope then need no further prompts; anything outside fails with SCOPE_REQUIRED. Replaces any previous task scope. ${AREAS_HELP}.`,
    args: {
      description: z.string().min(5).describe('The scope in plain words, e.g. "modify Violentmonkey scripts and uBO My filters in claude-dev for the banner task"'),
      areas: z.array(z.string()).min(1),
      user_said: z.string().min(1).optional().describe('The user\'s approving words from chat, quoted (needed only when no approval dialog is available)'),
      lifetime: z.enum(['task', 'session']).optional().describe('Set by the approval dialog; "session" keeps the areas approved until this session ends'),
    },
    write: true,
    async handler(a, ctx) {
      const areas = [...new Set(a.areas.map(normalizeArea))];
      const bad = areas.filter((x) => !AREA.test(x));
      if (bad.length) fail('BAD_ARGS', `unknown area(s): ${bad.join(', ')}`, AREAS_HELP);
      const b = await ctx.browser();
      let userSaid = a.user_said;
      let lifetime: 'task' | 'session' = a.lifetime ?? 'task';
      let via = 'chat (attested by Claude)';
      const ask = ctx.elicit ? await askUser(ctx.elicit, a.description, areas).catch((e: any) => ({ error: String(e?.message ?? e) })) : null;
      if (ask && 'decision' in ask) {
        if (ask.decision === 'decline') fail('SCOPE_DECLINED', 'the user declined this scope in the approval dialog', 'Do not retry the same request; ask the user in chat what they want instead.');
        lifetime = ask.decision as 'task' | 'session';
        userSaid = `(approved in the Claude Code dialog: ${lifetime === 'session' ? 'for the rest of this session' : 'for this task'})`;
        via = 'approval dialog';
      } else if (!userSaid) {
        fail('APPROVAL_NEEDED', ask && 'error' in ask ? `no answer from the approval dialog (${ask.error})` : 'this client has no approval dialog (MCP elicitation)',
          'Ask the user in chat, naming the concrete scope; when they agree, call scope_set again with user_said quoting them.');
      }
      const prev = b.scope;
      const scope: Scope = { description: a.description, areas, userSaid: userSaid!, approvedAt: new Date().toISOString() };
      b.scope = scope;
      if (lifetime === 'session') b.addSessionAreas(areas);
      b.save();
      await syncDownloadApprovals(b);
      return {
        text: `scope approved via ${via}: ${a.description}\nareas: ${areas.join(', ')}${lifetime === 'session' ? '\nkept approved for the rest of this session (scope_clear ends only the task scope)' : ''}\nA checkpoint is taken before the first change in this scope.`,
        changes: [{ kind: 'scope', before: prev ?? null, after: { ...scope, lifetime } }],
      };
    },
  }),
  tool({
    name: 'scope_show',
    description: 'The scope approved for the current task (areas, the user\'s words, checkpoint), if any.',
    args: {},
    async handler(_a, ctx) {
      const b = ctx.current();
      const s = b?.scope;
      if (!s) return b ? 'no scope approved for this task' : 'Firefox is not connected (no scope)';
      return `scope: ${s.description}\nareas: ${s.areas.join(', ')}\nuser said: ${JSON.stringify(s.userSaid)} (${s.approvedAt})\ncheckpoint: ${s.checkpoint ?? 'not yet (taken before the first change)'}`;
    },
  }),
  tool({
    name: 'scope_clear',
    description: 'End the current task\'s scope: later lasting changes need a new approval.',
    args: {},
    write: true,
    async handler(_a, ctx) {
      const b = ctx.current();
      if (!b?.scope) return "no scope to clear";
      const prev = b.scope!;
      b.scope = null;
      b.save();
      await syncDownloadApprovals(b);
      return { text: `scope cleared (${prev.description})`, changes: [{ kind: 'scope', before: prev, after: null }] };
    },
  }),
];
