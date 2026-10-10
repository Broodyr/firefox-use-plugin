// dialogs and HTTP auth in the agent tabs.
//
// The BiDi session leaves every user prompt open (unhandledPromptBehavior "ignore"), and the server answers the
// ones in agent tabs by the owning session's policy (default: dismiss alert/confirm/prompt, accept beforeunload —
// what the remote agent did before). Dialogs in the user's own tabs stay theirs: before this, the session's default
// handler dismissed those too (in personal mode, in the user's own browser). "ask" keeps a dialog open for
// dialog_handle. While it is open the page is suspended inside alert()/confirm()/prompt(): a non-awaiting BiDi
// evaluation still runs (measured), but anything awaiting the page hangs, so tools report DIALOG_OPEN (index.ts).
//
// HTTP auth challenges fire no user prompt: the request waits behind Firefox's auth dialog, which nobody sees in
// the parked window, so the navigation hangs (measured). An authRequired intercept on the agent tabs cancels them
// (the page shows the 401 body) unless the session chose otherwise with http_auth.
import type { Browser } from './session.js';
import { urlMatcher } from './intercept.js';

export type DialogAction = 'accept' | 'dismiss' | 'ask';
export interface DialogPolicy { alert: DialogAction; confirm: DialogAction; prompt: DialogAction; beforeunload: DialogAction; prompt_text?: string }
export const DEFAULT_DIALOG_POLICY: DialogPolicy = { alert: 'dismiss', confirm: 'dismiss', prompt: 'dismiss', beforeunload: 'accept' };

export interface DialogEntry {
  seq: number; context: string; type: string; message: string; ts: number;
  /** owning session ('' = this backend's own; null = a user tab) */
  client: string | null;
  /** handling | accepted | dismissed | open | answered by the user (…) | … */
  result: string;
  defaultValue?: string;
}

export type AuthMode = 'cancel' | 'prompt' | 'credentials';
export interface AuthSetting { mode: AuthMode; url?: string; username?: string; password?: string }

/** session.new capabilities: prompts stay open until the server (or the user) answers them */
export const PROMPT_CAPS = { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } };

/** Test credentials only ever go to local development hosts (the standard exception in the safety rules). */
export function localDevHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.test');
  } catch { return false; }
}

export class DialogHandler {
  readonly entries: DialogEntry[] = [];
  seq = 0;
  readonly policies = new Map<string, DialogPolicy>();
  readonly auth = new Map<string, AuthSetting>();
  /** context -> the dialog left open for dialog_handle */
  readonly open = new Map<string, DialogEntry>();
  /** called when a dialog is left open (a call that opened it must not wait for its page) */
  readonly openWaiters = new Set<(e: DialogEntry) => void>();
  private interceptId: string | null = null;
  private contexts: string[] = [];

  constructor(private b: Browser) {
    b.tabHooks.push(() => this.syncAuth());
  }

  private push(e: Omit<DialogEntry, 'seq'>): DialogEntry {
    const x = { ...e, seq: ++this.seq };
    this.entries.push(x);
    if (this.entries.length > 50) this.entries.shift();
    return x;
  }

  async onOpened(p: any) {
    const e = this.push({ context: p.context, type: p.type, message: String(p.message ?? ''), ts: Date.now(), client: null, result: 'handling', defaultValue: p.defaultValue });
    const owner = await this.b.promptOwner(p.context).catch(() => null);
    if (owner === null) { e.result = 'user tab: left to the user'; return; }
    e.client = owner;
    const pol = this.policies.get(owner) ?? DEFAULT_DIALOG_POLICY;
    const act: DialogAction = (pol as any)[p.type] ?? 'dismiss';
    if (act === 'ask') { e.result = 'open'; this.open.set(p.context, e); for (const f of this.openWaiters) f(e); return; }
    const userText = p.type === 'prompt' && act === 'accept' && pol.prompt_text !== undefined ? { userText: pol.prompt_text } : {};
    try {
      await this.b.bidi.send('browsingContext.handleUserPrompt', { context: p.context, accept: act === 'accept', ...userText });
      e.result = act === 'accept' ? (userText.userText !== undefined ? `accepted with ${JSON.stringify(userText.userText)}` : 'accepted') : 'dismissed';
    } catch (err: any) { e.result = `could not be answered: ${err?.message ?? err}`; }
  }

  onClosed(p: any) {
    const e = this.open.get(p.context);
    if (!e) return;
    this.open.delete(p.context);
    if (e.result === 'open') e.result = `answered by the user (${p.accepted ? 'accepted' : 'dismissed'})`;
  }

  /** dialog_handle: answer the dialog left open in this context. */
  async answer(context: string, accept: boolean, text?: string): Promise<DialogEntry> {
    const e = this.open.get(context)!;
    e.result = 'handling';
    await this.b.bidi.send('browsingContext.handleUserPrompt', { context, accept, ...(text !== undefined ? { userText: text } : {}) });
    this.open.delete(context);
    e.result = `${accept ? 'accepted' : 'dismissed'}${text !== undefined ? ` with ${JSON.stringify(text)}` : ''} (dialog_handle)`;
    return e;
  }

  /** (Re)register the authRequired intercept for the agent tabs of every session (never the user's tabs). */
  async syncAuth() {
    const want = await this.b.agentContexts().catch(() => this.contexts);
    if (this.interceptId && want.length === this.contexts.length && want.every((c) => this.contexts.includes(c))) return;
    if (this.interceptId) { await this.b.bidi.send('network.removeIntercept', { intercept: this.interceptId }).catch(() => {}); this.interceptId = null; }
    this.contexts = want;
    if (!want.length) return;
    this.interceptId = (await this.b.bidi.send('network.addIntercept', { phases: ['authRequired'], contexts: want })).intercept;
  }

  async onAuth(p: any) {
    if (!p.isBlocked || !this.interceptId || !p.intercepts?.includes(this.interceptId)) return;
    const url: string = p.request?.url ?? '';
    const realm = (p.response?.authChallenges ?? []).map((c: any) => `${c.scheme}${c.realm ? ` realm "${c.realm}"` : ''}`).join(', ');
    const owner = await this.b.promptOwner(p.context).catch(() => null);
    const s: AuthSetting | null = owner === null ? null : this.auth.get(owner) ?? { mode: 'cancel' };
    let action: 'cancel' | 'default' | 'provideCredentials' = 'default', result = 'user tab: left to Firefox\'s dialog';
    let credentials: any;
    if (s) {
      const applies = !s.url || urlMatcher(s.url)(url);
      if (s.mode === 'credentials' && applies && localDevHost(url)) {
        action = 'provideCredentials'; credentials = { type: 'password', username: s.username ?? '', password: s.password ?? '' };
        result = `answered with the test credentials for ${s.username}`;
      } else if (s.mode === 'prompt') { action = 'default'; result = 'left to Firefox\'s auth dialog (ff_handoff to let the user answer)'; }
      else { action = 'cancel'; result = 'cancelled: the page shows the server\'s 401 response'; }
    }
    this.push({ context: p.context, type: 'http-auth', message: `${url}${realm ? ` (${realm})` : ''}`, ts: Date.now(), client: owner, result });
    await this.b.bidi.send('network.continueWithAuth', { request: p.request.request, action, ...(credentials ? { credentials } : {}) }).catch(() => {});
  }
}
