// masked by default in all tool output and in the audit log.

const SENSITIVE_PARAM = /([?&;#][^=&#\s"'<>]*?(?:token|key|secret|session|auth|sig|password)[^=&#\s"'<>]*=)([^&#\s"'<>]+)/gi;
const AUTH_HEADER = /\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token) <masked>)((?:(?:Bearer|Basic|Token|Digest|Negotiate)\s+)?[^\s"';,]+)/gi;
const COOKIE_HEADER = /\b(cookie|set-cookie)(["']?\s*[:=]\s*["']?)([^"'\r\n]+)/gi;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * Mask secrets in text. `allow` (lower-case names from unmask: [...]) reveals specific items:
 * a header name (authorization, cookie, set-cookie, proxy-authorization), a query-param name, "bearer" or "jwt".
 */
export function maskText(s: string, allow?: Set<string>): string {
  if (!s) return s;
  if (!allow?.size) {
    return s
      .replace(JWT, '<jwt:masked>')
      .replace(BEARER, '$1 <masked>')
      .replace(AUTH_HEADER, '$1$2<masked>')
      .replace(COOKIE_HEADER, '$1$2<masked>')
      .replace(SENSITIVE_PARAM, '$1<masked>');
  }
  const keepHeader = (name: string) => allow.has(name.toLowerCase());
  let out = s;
  if (!allow.has('jwt')) out = out.replace(JWT, '<jwt:masked>');
  if (!allow.has('bearer') && !allow.has('authorization') && !allow.has('proxy-authorization')) out = out.replace(BEARER, '$1 <masked>');
  out = out.replace(AUTH_HEADER, (m, n, sep) => (keepHeader(n) ? m : `${n}${sep}<masked>`));
  out = out.replace(COOKIE_HEADER, (m, n, sep) => (keepHeader(n) ? m : `${n}${sep}<masked>`));
  out = out.replace(SENSITIVE_PARAM, (m, pre: string) => (allow.has(pre.slice(1, -1).toLowerCase()) ? m : `${pre}<masked>`));
  return out;
}

/** Names that unmask may never reveal (denylisted sources). */
export const NEVER_UNMASK = /^(password|passwd|pwd|logins?|signon|key4|cert9)$/i;

/** Deep-mask string leaves of a JSON-able value (used for audit arguments). */
export function maskValue<T>(v: T, depth = 0, allow?: Set<string>): T {
  if (typeof v === 'string') return maskText(v, allow) as T;
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => maskValue(x, depth + 1, allow)) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, /^(password|passwd|secret|token|cookie|authorization)$/i.test(k) && typeof x === 'string' && !allow?.has(k.toLowerCase()) ? '<masked>' : maskValue(x, depth + 1, allow)])) as T;
}
