// In-realm serialisation for eval results. The same source runs in pages (BiDi), content-script
// sandboxes, extension pages and workers (RDP). It returns a JSON string; Xray-wrapped objects are labelled.
import vm from 'node:vm';

/** function (value, maxDepth, waive) -> JSON string */
export const SERIALIZER = `function __cfSerialize(value, maxDepth, waive) {
  const seen = new WeakSet();
  const isXray = (x) => { try { return x !== null && (typeof x === 'object' || typeof x === 'function') && typeof x.wrappedJSObject !== 'undefined' && x.wrappedJSObject !== x; } catch (e) { return false; } };
  const tagOf = (x) => { try { return Object.prototype.toString.call(x).slice(8, -1); } catch (e) { return 'Object'; } };
  const ser = (x, d) => {
    let xray = false;
    if (isXray(x)) { xray = true; if (waive) { try { x = x.wrappedJSObject; } catch (e) {} } }
    const label = (s) => (xray && !waive ? '[Xray] ' : xray ? '[waived] ' : '') + s;
    if (x === undefined) return '[undefined]';
    if (x === null) return null;
    const t = typeof x;
    if (t === 'number') return Number.isFinite(x) ? x : String(x);
    if (t === 'string' || t === 'boolean') return x;
    if (t === 'bigint') return x + 'n';
    if (t === 'symbol') return String(x);
    if (t === 'function') return label('[function ' + (x.name || 'anonymous') + ']');
    if (seen.has(x)) return '[circular]';
    seen.add(x);
    const tag = tagOf(x);
    try {
      if (typeof Node !== 'undefined' && x instanceof Node || (x && typeof x.nodeType === 'number' && typeof x.nodeName === 'string')) {
        if (x.nodeType === 1) return label('<' + x.localName + (x.id ? '#' + x.id : '') + (typeof x.className === 'string' && x.className.trim() ? '.' + x.className.trim().split(/\\s+/).join('.') : '') + '>');
        if (x.nodeType === 3) return label('#text ' + JSON.stringify(String(x.data).slice(0, 80)));
        if (x.nodeType === 9) return label('#document ' + (x.URL || ''));
        return label('#node ' + x.nodeName);
      }
    } catch (e) {}
    if (tag === 'Window' || tag === 'global') { try { return label('[Window ' + x.location.href + ']'); } catch (e) { return label('[Window]'); } }
    if (x instanceof Error || tag === 'Error' || (typeof x.message === 'string' && typeof x.stack === 'string')) return { error: label(String(x.name || 'Error') + ': ' + x.message), stack: String(x.stack || '').split('\\n').slice(0, 5).join('\\n') };
    if (tag === 'Date') return label('[Date ' + (isNaN(x) ? 'Invalid' : x.toISOString()) + ']');
    if (tag === 'RegExp') return label(String(x));
    if (tag === 'Promise') return label('[Promise]');
    if (d >= maxDepth) {
      if (Array.isArray(x)) return label('[Array(' + x.length + ')]');
      return label('[' + ((x.constructor && x.constructor.name) || tag) + ']');
    }
    if (Array.isArray(x) || (tag !== 'Object' && typeof x.length === 'number' && typeof x !== 'string' && /List|Collection|Array/.test(tag))) {
      const out = [];
      const n = Math.min(x.length, 100);
      for (let i = 0; i < n; i++) { try { out.push(ser(x[i], d + 1)); } catch (e) { out.push('[throws]'); } }
      if (x.length > n) out.push('… ' + (x.length - n) + ' more');
      return xray && !waive ? { '[Xray]': tag, items: out } : out;
    }
    if (tag === 'Map') { const o = { '[Map]': [] }; let i = 0; for (const [k, v] of x) { if (i++ >= 100) break; o['[Map]'].push([ser(k, d + 1), ser(v, d + 1)]); } return o; }
    if (tag === 'Set') { const o = { '[Set]': [] }; let i = 0; for (const v of x) { if (i++ >= 100) break; o['[Set]'].push(ser(v, d + 1)); } return o; }
    const o = {};
    if (xray && !waive) o['[Xray]'] = tag;
    else if (tag !== 'Object' && x.constructor && x.constructor.name && x.constructor.name !== 'Object') o['[class]'] = x.constructor.name;
    let keys = [];
    try { keys = Object.keys(x); } catch (e) {}
    let n = 0;
    for (const k of keys) {
      if (n++ >= 100) { o['…'] = (keys.length - 100) + ' more keys'; break; }
      try { o[k] = ser(x[k], d + 1); } catch (e) { o[k] = '[throws]'; }
    }
    return o;
  };
  const top = ser(value, 0);
  return JSON.stringify({ type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, xray: isXray(value), value: top });
}`;

/**
 * Turn user code into the body of an async function. Code with a top-level `return` is a function body;
 * anything else is treated as an expression (`return (code)`).
 */
export function asBody(code: string, asExpression: boolean): string {
  return asExpression ? `return (\n${code}\n);` : code;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => unknown;
/**
 * True when the code only makes sense as a function body: it has a top-level `return` (or top-level `await`
 * outside a single expression). Decided by compiling, never running, the code in Node: an expression that
 * merely contains a `return` inside a nested function (`(() => { return 1 })()`, `p.then(r => { return r })`)
 * stays an expression. Syntax Node doesn't know is left to the browser's own fallback (expression, then script).
 */
export function hasReturn(code: string): boolean {
  try { new AsyncFunction(`return (\n${code}\n);`); return false; } catch { /* not one expression */ }
  try { new vm.Script(code); return false; } catch { /* top-level return/await, or a syntax error */ }
  try { new AsyncFunction(code); return true; } catch { return false; }
}

/** Source for RDP evaluateJSAsync (mapped.await): runs the code, serialises the result to a JSON string. */
export function rdpEvalSource(code: string, asExpression: boolean, depth: number, waive: boolean, awaitPromise = true): string {
  const a = awaitPromise ? 'async ' : '', w = awaitPromise ? 'await ' : '';
  return `(${a}() => {
  const __cfSer = ${SERIALIZER};
  const __cfV = ${w}(${a}() => {
${asBody(code, asExpression)}
  })();
  return __cfSer(__cfV, ${depth}, ${waive});
})()`;
}

/** Function declaration for BiDi script.callFunction. */
export function bidiEvalFunction(code: string, asExpression: boolean, depth: number, waive: boolean, awaitPromise = true): string {
  const a = awaitPromise ? 'async ' : '', w = awaitPromise ? 'await ' : '';
  return `${a}function () {
  const __cfSer = ${SERIALIZER};
  const __cfV = ${w}(${a}() => {
${asBody(code, asExpression)}
  })();
  return __cfSer(__cfV, ${depth}, ${waive});
}`;
}
