// @ts-check
// RUN-AS — the break-glass admin's identity picker (owner directive,
// 2026-07-25). One set of break-glass credentials, N distinct callers.
//
// The break-glass Basic Auth identity (src/auth.js) is a single shared
// "admin" principal. That is exactly wrong for testing anything MULTI-USER —
// compute sharing above all, where a pool is keyed by account id and the
// whole point of the feature is that two DIFFERENT people approve each
// other. Provisioning real Google accounts for that is not possible from a
// test harness, so break-glass gains a way to SAY WHO IT IS ACTING AS:
//
//   X-Run-As: user             → the break-glass principal, role downgraded
//   X-Run-As: admin            → unchanged (explicit, the default)
//   X-Run-As: <email>          → a real D1 account (impersonation)
//   X-Run-As: #<id>            → a real D1 account by row id
//   X-Run-As: test:<name>      → a SYNTHETIC identity, id `runas:<name>`
//
// The synthetic form is the multi-user testing primitive: it needs no D1
// row, produces a stable distinct `id` (so `pool_id`, consumer keys and
// approval decisions are per-persona), and is marked `synthetic` so every
// surface that shows a "platform-verified identity" can say plainly that
// this one is a test persona rather than a signed-in human.
//
// SECURITY POSTURE — run-as ADDS NO PRIVILEGE. It is honored only for a
// caller that already authenticated as break-glass admin (which can already
// read and write everything through the admin API), and every form it can
// produce is equal or LESSER privilege:
//   - `user` / `test:` / a non-admin account → role "user"; the admin
//     interface refuses them like any other user.
//   - an admin account → the privilege break-glass already had.
// A run-as identity is never itself allowed to run-as again (it is not
// `isSecretAdmin`), so the header can't be laundered through a session.
//
// This module is PURE (no env, no D1, no crypto): a spec parser plus the
// synthetic-identity builder and the cookie encoding. src/auth.js does the
// account lookups; src/index.js exposes POST /api/admin/run-as, which mints
// a normal session cookie carrying the spec so a BROWSER context can be a
// persona for a whole end-to-end run.

/** @typedef {import('./auth.js').Identity} Identity */

/** The request header that picks the acting identity. */
export const RUN_AS_HEADER = "x-run-as";

/** Session-cookie uid prefix for a run-as persona: `ra~<base64url(spec)>`.
 * base64url because the cookie payload is dot-separated and a spec may be an
 * email (dots) — encoding keeps the four-field cookie shape intact. */
export const RUN_AS_UID_PREFIX = "ra~";

/** Synthetic persona ids are namespaced so they can never collide with a D1
 * row id (numeric) or the break-glass id ("admin"). */
export const RUN_AS_ID_PREFIX = "runas:";

const NAME_MAX = 40;

/**
 * @typedef {{ kind: "admin" }
 *   | { kind: "user" }
 *   | { kind: "account", ref: string, byId: boolean }
 *   | { kind: "test", name: string }} RunAsSpec
 */

/**
 * Parse a run-as spec string. Returns null for empty/invalid input (callers
 * treat that as "no run-as", never as an error — a typo must not silently
 * escalate or produce a surprise identity).
 * @param {string | null | undefined} raw
 * @returns {RunAsSpec | null}
 */
export function parseRunAs(raw) {
  const spec = String(raw || "").trim();
  if (!spec || spec.length > 120) return null;
  const lower = spec.toLowerCase();
  if (lower === "admin") return { kind: "admin" };
  if (lower === "user") return { kind: "user" };
  if (lower.startsWith("test:")) {
    const name = sanitizeName(spec.slice(5));
    return name ? { kind: "test", name } : null;
  }
  if (spec.startsWith("#")) {
    const ref = spec.slice(1).trim();
    return /^\d+$/.test(ref) ? { kind: "account", ref, byId: true } : null;
  }
  if (spec.includes("@")) return { kind: "account", ref: lower, byId: false };
  return null;
}

/** Persona names are the visible half of a synthetic identity — keep them to
 * a slug so ids, emails and display strings are all derivable and stable.
 * @param {string} raw @returns {string} */
export function sanitizeName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX);
}

/**
 * The SYNTHETIC persona identity for `test:<name>`. No D1 row: a stable id,
 * a `.run-as.test` address (the reserved-looking suffix makes it obvious in
 * any roster that this is not a real mailbox), and `synthetic: true` so the
 * approval surfaces can label it honestly.
 * @param {string} name
 * @returns {Identity}
 */
export function syntheticIdentity(name) {
  const slug = sanitizeName(name);
  return {
    id: RUN_AS_ID_PREFIX + slug,
    role: "user",
    email: slug + "@run-as.test",
    name: slug,
    runAs: "test:" + slug,
    synthetic: true,
  };
}

/**
 * Apply the non-account forms of a spec to the break-glass identity. The
 * `account` form needs a D1 lookup and is resolved by src/auth.js.
 * @param {RunAsSpec} spec
 * @param {Identity} adminIdent the break-glass identity
 * @returns {Identity | null} null when the spec needs an account lookup
 */
export function applyLocalRunAs(spec, adminIdent) {
  if (spec.kind === "admin") return { ...adminIdent, runAs: "admin" };
  if (spec.kind === "user") {
    // Same principal, ordinary privilege: the "operate as a regular user"
    // case. isSecretAdmin is dropped so the admin surfaces refuse it.
    return { id: adminIdent.id, role: "user", email: null, name: "Admin (as user)", runAs: "user" };
  }
  if (spec.kind === "test") return syntheticIdentity(spec.name);
  return null;
}

/** Encode a spec into the session-cookie uid field.
 * @param {string} spec @returns {string} */
export function runAsUid(spec) {
  return RUN_AS_UID_PREFIX + b64urlEncode(String(spec));
}

/** Decode a session-cookie uid back to its spec, or null if it isn't one.
 * @param {string} uid @returns {string | null} */
export function runAsSpecFromUid(uid) {
  const s = String(uid || "");
  if (!s.startsWith(RUN_AS_UID_PREFIX)) return null;
  const decoded = b64urlDecode(s.slice(RUN_AS_UID_PREFIX.length));
  return decoded || null;
}

/** @param {string} s @returns {string} */
function b64urlEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} s @returns {string} */
function b64urlDecode(s) {
  try {
    const pad = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(pad + "===".slice((pad.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/**
 * The public shape of a resolved run-as identity (what POST /api/admin/run-as
 * echoes back and what the approval surfaces render).
 * @param {Identity} identity
 * @returns {{ id: string, role: string, email: string|null, name: string, synthetic: boolean, runAs: string|null }}
 */
export function runAsView(identity) {
  return {
    id: String(identity.id),
    role: identity.role,
    email: identity.email || null,
    name: identity.name || String(identity.id),
    synthetic: !!identity.synthetic,
    runAs: identity.runAs || null,
  };
}
