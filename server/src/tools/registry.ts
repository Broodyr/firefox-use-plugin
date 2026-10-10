import { z } from 'zod';
import type { Options } from '../config.js';
import type { Browser } from '../browser/session.js';

export type Detail = 'summary' | 'normal' | 'full';

export interface ToolOutput {
  text: string;
  images?: { data: string; mimeType: string }[];
  /** for state-changing tools: what changed, recorded in the audit log */
  changes?: { kind: string; path?: string; before?: unknown; after?: unknown }[];
  /** audit target override */
  target?: { tab?: number; context?: string; url?: string };
  /** full MCP content override (batch) */
  content?: unknown[];
}

export interface Ctx {
  opts: Options;
  /** Connect to (or launch) Firefox on demand. */
  browser(): Promise<Browser>;
  /** Current browser if already connected; never launches. */
  current(): Browser | null;
  setBrowser(b: Browser | null): void;
  auditId: string;
  /** throw SCOPE_REQUIRED unless an approved scope covers this area; takes the scope's checkpoint before its first change */
  requireScope(area: string, b: Browser): Promise<void>;
  /** automatic warm checkpoint; null on throwaway profiles */
  checkpoint(b: Browser, label: string): Promise<string | null>;
  /** ask the user directly (MCP elicitation); undefined when the client has no dialog for it */
  elicit?: (p: { message: string; requestedSchema: Record<string, unknown> }) => Promise<{ action: string; content?: Record<string, unknown> }>;
  /** run another tool in this session (audited on its own), e.g. the steps of test_record */
  call?: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  /** changes state: returns its auditId, logged with write=true */
  write?: boolean;
  /** has a detail argument */
  detail?: boolean;
  /** accepts unmask: [...] */
  unmask?: boolean;
  handler(args: any, ctx: Ctx): Promise<ToolOutput | string>;
}

export function tool<S extends z.ZodRawShape>(d: {
  name: string; description: string; args: S; write?: boolean; detail?: boolean; unmask?: boolean;
  handler(args: z.infer<z.ZodObject<S>> & { max_chars?: number; detail?: Detail; unmask?: string[] }, ctx: Ctx): Promise<ToolOutput | string>;
}): ToolDef {
  return { name: d.name, description: d.description, schema: z.object(d.args), write: d.write, detail: d.detail, unmask: d.unmask, handler: d.handler as any };
}

export const tabArg = z.number().int().positive().optional().describe('Tab handle from tabs_list; defaults to the current agent tab');
export const refArg = z.string().regex(/^\[?ref_\d+\]?$/).describe('Element ref from read_page or find, e.g. "ref_12"');
export const DEFAULT_MAX_CHARS = 8000;
export const unmaskArg = z.array(z.string().min(1)).max(10).optional()
  .describe('Reveal specific masked items: header names ("Cookie", "Authorization"), query-param or storage key names, or "bearer"/"jwt". Audited.');

/** JSON schema for a tool, with the shared max_chars / detail arguments. */
export function inputSchema(d: ToolDef): Record<string, unknown> {
  let s = d.schema.extend({
    max_chars: z.number().int().positive().optional().describe(`Output cap in characters (default ${DEFAULT_MAX_CHARS})`),
  });
  if (d.detail) s = s.extend({ detail: z.enum(['summary', 'normal', 'full']).optional().describe('Output detail level (default summary)') });
  if (d.unmask) s = s.extend({ unmask: unmaskArg });
  const js = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  const at = cut > max * 0.7 ? cut : max;
  return `${text.slice(0, at)}\n… [truncated: showed ${at} of ${text.length} chars. Narrow the query (root, filter, since) or raise max_chars.]`;
}
