// several Claude sessions per Firefox. The owning backend serves other sessions' calls (forwarded
// through its proxy pipe with a hidden client id); each call runs inside an AsyncLocalStorage context so the
// Browser can keep a separate tab group, current tab, scope, handoff and console cursor per client.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<{ client: string; workspace?: string }>();

/** '' = the owning session; otherwise the client id of a session routed through this backend. */
export function currentClient(): string { return als.getStore()?.client ?? ''; }

/** The routed session's workspace (its files, artifacts, snapshots, audit log), if this call came from one. */
export function clientWorkspace(): string | undefined { return als.getStore()?.workspace; }

export function runAsClient<T>(client: string, fn: () => Promise<T>, workspace?: string): Promise<T> { return als.run({ client, workspace }, fn); }
export function runAsClientSync<T>(client: string, fn: () => T): T { return als.run({ client }, fn); }

/** Client id for this backend when it routes through another session's proxy: the proxy pid. */
export function myClientId(): string { return `s${process.env.FIREFOX_USE_PROXY_PID || process.pid}`; }

export const GROUP_COLORS = ['blue', 'purple', 'cyan', 'green', 'pink', 'yellow', 'red', 'grey'];

/** pid of the session behind a client id ("s1234" -> 1234). */
export function clientPid(id: string): number { return Number(/^s(\d+)$/.exec(id)?.[1] ?? 0); }
