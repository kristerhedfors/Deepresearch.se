// A tiny, pure, dependency-free schema validator.
//
// Its job is to harden the model-JSON → pipeline boundary — the historically
// fragile seam where a JSON-mode model returns an object of the wrong shape
// and the pipeline has to cope. It is deliberately LENIENT and NEVER THROWS:
// `validate(shape, value)` always returns `{ ok, value, errors }`, coercing
// and normalizing where it safely can (dropping unknown object keys, dropping
// array items that don't fit, trimming strings, coercing "true"/"false") and
// reporting `ok:false` with a list of `{path, message}` errors otherwise.
//
// It is used BEHIND the pipeline's existing fail-soft fallbacks
// (normalizeTriage etc. remain the last-ditch net): a schema miss must let the
// caller degrade exactly as it does today, never break the request. So the
// integration pattern is `ok ? value : original` — on a clean shape you get a
// normalized object, on a miss you get the raw value back untouched.
//
// Combinators: string, boolean, number, stringEnum, arrayOf, object, oneOf.

function makeErr(path, message) {
  return { path, message };
}
function ok(value) {
  return { ok: true, value, errors: [] };
}
function bad(errors) {
  return { ok: false, value: undefined, errors };
}
function fail(path, message) {
  return bad([makeErr(path, message)]);
}
// A schema node is any object carrying a `_run(value, path) -> result` method.
function node(kind, run) {
  return { kind, _run: run };
}

// A string. `trim` (default true) trims; `allowEmpty` (default true) permits
// the empty string; `coerce` (default false) turns any non-string primitive
// into its String() form leniently (used for display-only fields like the
// validator's `issues` list, matching the pipeline's historical `.map(String)`).
export function string({ trim = true, allowEmpty = true, coerce = false } = {}) {
  return node("string", (v, path) => {
    let s;
    if (typeof v === "string") s = v;
    else if (coerce && (typeof v === "number" || typeof v === "boolean" || v === null)) s = String(v);
    else return fail(path, "expected string");
    if (trim) s = s.trim();
    if (!allowEmpty && !s) return fail(path, "expected non-empty string");
    return ok(s);
  });
}

// A boolean. Leniently accepts the strings "true"/"false".
export function boolean() {
  return node("boolean", (v, path) => {
    if (typeof v === "boolean") return ok(v);
    if (v === "true") return ok(true);
    if (v === "false") return ok(false);
    return fail(path, "expected boolean");
  });
}

// A finite number. Leniently accepts a numeric string.
export function number() {
  return node("number", (v, path) => {
    if (typeof v === "number" && Number.isFinite(v)) return ok(v);
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return ok(Number(v));
    return fail(path, "expected number");
  });
}

// One of a fixed set of string literals. Trims a stray-whitespace match.
export function stringEnum(values) {
  const set = new Set(values);
  return node("enum", (v, path) => {
    if (typeof v === "string") {
      if (set.has(v)) return ok(v);
      const t = v.trim();
      if (set.has(t)) return ok(t);
    }
    return fail(path, `expected one of: ${values.join(", ")}`);
  });
}

// An array whose items each satisfy `item`. LENIENT: a non-array fails, but a
// valid array simply DROPS the items that don't validate (rather than failing
// the whole array), which matches how the pipeline has always filtered a
// model's query/issue lists. Returns the surviving, coerced items.
export function arrayOf(item) {
  return node("array", (v, path) => {
    if (!Array.isArray(v)) return fail(path, "expected array");
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const r = item._run(v[i], `${path}[${i}]`);
      if (r.ok) out.push(r.value);
    }
    return ok(out);
  });
}

// An object with keyed sub-schemas. Unknown keys are DROPPED (normalization).
// Keys in `optional` may be absent (or present-but-invalid, in which case they
// are dropped leniently); every other declared key is required and its failure
// fails the object. A null/absent value for a key counts as "not present".
export function object(shapeMap, { optional = [] } = {}) {
  const opt = new Set(optional);
  return node("object", (v, path) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail(path, "expected object");
    const out = {};
    const errors = [];
    for (const key of Object.keys(shapeMap)) {
      const present = Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined && v[key] !== null;
      if (!present) {
        if (!opt.has(key)) errors.push(makeErr(`${path}.${key}`, "missing required key"));
        continue;
      }
      const r = shapeMap[key]._run(v[key], `${path}.${key}`);
      if (r.ok) out[key] = r.value;
      else if (!opt.has(key)) errors.push(...r.errors);
      // optional-but-invalid: dropped leniently, no error
    }
    return errors.length ? bad(errors) : ok(out);
  });
}

// The first variant that validates wins; otherwise the union fails with the
// collected errors. Used for discriminated unions like triage's
// direct|clarify|research.
export function oneOf(schemas) {
  return node("oneOf", (v, path) => {
    const all = [];
    for (const s of schemas) {
      const r = s._run(v, path);
      if (r.ok) return r;
      all.push(...r.errors);
    }
    return bad(all.length ? all : [makeErr(path, "no matching variant")]);
  });
}

// Public entry: validate `value` against `shape`, returning
// `{ ok, value, errors }`. NEVER throws — a malformed schema or an unexpected
// internal error degrades to `ok:false` rather than propagating.
export function validate(shape, value) {
  try {
    if (!shape || typeof shape._run !== "function") {
      return bad([makeErr("$", "invalid schema")]);
    }
    const r = shape._run(value, "$");
    return { ok: !!r.ok, value: r.ok ? r.value : undefined, errors: r.errors || [] };
  } catch (e) {
    return bad([makeErr("$", e?.message || "validation threw")]);
  }
}
