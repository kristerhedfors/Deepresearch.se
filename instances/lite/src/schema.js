// @ts-check
// A dependency-free combinator validator whose validate() NEVER throws: it
// coerces/normalizes where safe and returns { ok, value, errors } (research-
// pipeline step 1). The integration pattern is hardenJson(schema, value) =
// ok ? value : original, so a schema miss degrades byte-identically to the
// pre-schema behavior and the last-ditch normalizer takes over.

/** @typedef {{ ok: boolean, value: any, errors: string[] }} Result */

export const S = {
  /** @returns {(v:any)=>Result} */
  string: () => (v) => (typeof v === "string" ? ok(v) : bad("not a string", "")),
  boolean: () => (v) => (typeof v === "boolean" ? ok(v) : bad("not a boolean", false)),
  number: () => (v) => (typeof v === "number" && Number.isFinite(v) ? ok(v) : bad("not a number", 0)),
  /** @param {string[]} allowed */
  stringEnum: (allowed) => (v) => (allowed.includes(v) ? ok(v) : bad(`not in {${allowed.join(",")}}`, allowed[0])),
  /** @param {(v:any)=>Result} item */
  arrayOf: (item) => (v) => {
    if (!Array.isArray(v)) return bad("not an array", []);
    const out = [];
    const errs = [];
    for (let i = 0; i < v.length; i++) {
      const r = item(v[i]);
      if (r.ok) out.push(r.value);
      else errs.push(`[${i}] ${r.errors.join(", ")}`);
    }
    return errs.length ? { ok: false, value: out, errors: errs } : ok(out);
  },
  /** @param {Record<string,(v:any)=>Result>} shape */
  object: (shape) => (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return bad("not an object", {});
    const out = /** @type {Record<string, any>} */ ({});
    const errs = [];
    for (const k of Object.keys(shape)) {
      const r = shape[k](/** @type {any} */ (v)[k]);
      out[k] = r.value;
      if (!r.ok) errs.push(`${k}: ${r.errors.join(", ")}`);
    }
    return errs.length ? { ok: false, value: out, errors: errs } : ok(out);
  },
};

/** @param {any} value @returns {Result} */
function ok(value) {
  return { ok: true, value, errors: [] };
}
/** @param {string} msg @param {any} fallback @returns {Result} */
function bad(msg, fallback) {
  return { ok: false, value: fallback, errors: [msg] };
}

/**
 * @param {(v:any)=>Result} schema
 * @param {any} value
 * @returns {Result}
 */
export function validate(schema, value) {
  try {
    return schema(value);
  } catch {
    return { ok: false, value, errors: ["validator threw"] };
  }
}

/**
 * @param {(v:any)=>Result} schema
 * @param {any} value the model's parsed JSON
 * @returns {any} the validated value if clean, else the original (fall-through)
 */
export function hardenJson(schema, value) {
  const r = validate(schema, value);
  return r.ok ? r.value : value;
}
