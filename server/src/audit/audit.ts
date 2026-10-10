import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, workspace } from '../config.js';
import { maskValue } from '../safety/mask.js';

// append-only JSONL at <workspace>/.firefox-use/audit/<date>.jsonl

export interface AuditEntry {
  id: string;
  ts: string;
  tool: string;
  args: unknown;
  target?: { tab?: number; context?: string; url?: string; profile?: string; client?: string };
  status: 'ok' | 'error';
  ms: number;
  write: boolean;
  error?: { code: string; message: string };
  changes?: { kind: string; path?: string; before?: unknown; after?: unknown }[];
  session: { pid: number; proxyPid?: number };
}

let seq = 0;
export function newAuditId(): string {
  const d = new Date();
  return `a${d.toISOString().slice(0, 10).replaceAll('-', '')}-${process.pid.toString(36)}${(++seq).toString(36).padStart(3, '0')}`;
}

export function stateDir(...parts: string[]): string {
  // test_run's child backends keep their own state (links, audit) apart from the session's: FIREFOX_USE_STATE_DIR
  if (process.env.FIREFOX_USE_STATE_DIR) return ensureDir(path.join(process.env.FIREFOX_USE_STATE_DIR, ...parts));
  const base = path.join(workspace(), '.firefox-use');
  if (!fs.existsSync(base)) {
    ensureDir(base);
    // everything but pins.json stays out of git
    fs.writeFileSync(path.join(base, '.gitignore'), '*\n!.gitignore\n!pins.json\n');
  }
  return ensureDir(path.join(base, ...parts));
}

export function auditAppend(e: Omit<AuditEntry, 'ts' | 'session'> & { ts?: string }): void {
  const entry: AuditEntry = {
    ...e,
    ts: e.ts ?? new Date().toISOString(),
    args: maskValue(e.args),
    target: maskValue(e.target),
    session: { pid: process.pid, proxyPid: process.env.FIREFOX_USE_PROXY_PID ? Number(process.env.FIREFOX_USE_PROXY_PID) : undefined },
  };
  const file = path.join(stateDir('audit'), `${entry.ts.slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function auditRead(o: { since?: string; tool?: string; writesOnly?: boolean; limit?: number }): AuditEntry[] {
  const dir = stateDir('audit');
  const sinceMs = o.since ? parseSince(o.since) : 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const out: AuditEntry[] = [];
  for (const f of files) {
    if (sinceMs && f.slice(0, 10) < new Date(sinceMs).toISOString().slice(0, 10)) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e: AuditEntry;
      try { e = JSON.parse(line); } catch { continue; }
      if (sinceMs && Date.parse(e.ts) < sinceMs) continue;
      if (o.tool && e.tool !== o.tool) continue;
      if (o.writesOnly && !e.write) continue;
      out.push(e);
    }
  }
  return out.slice(-(o.limit ?? 50));
}

/** "2026-10-02T10:00", "30m", "2h", "1d", or an audit id. */
function parseSince(s: string): number {
  const rel = /^(\d+)\s*([smhd])$/.exec(s);
  if (rel) return Date.now() - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2] as 's']!;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}
