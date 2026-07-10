// @ts-check
// Authentication and identity for the whole site (UI + API).
//
// User-facing sign-in is GOOGLE ONLY (src/google.js): a successful Google
// login mints the signed session cookie below, which then authenticates
// every request. Two identity sources resolve here:
//
//   - USERS: D1 accounts (created by Google sign-in), identified by the
//     session cookie `u.<uid>.<expiry>.<hmac(uid.expiry)>` and re-checked
//     against the DB on every request (disabling is immediate).
//   - ADMIN break-glass: the ADMIN_USER / ADMIN_PASS Worker secrets over
//     HTTP Basic Auth (legacy fallback: BASIC_AUTH_USER / BASIC_AUTH_PASS).
//     For curl/scripts and emergencies — no database, no Google needed.
//     Legacy admin session cookies from the pre-Google era also still map
//     here so existing installs aren't logged out.
//
// PWA longevity: sessions last 365 days and slide — any authenticated
// request past the half-life gets a fresh cookie (index.js appends it), so
// an installed PWA that is opened at least twice a year never re-logs-in.
// The cookie is HttpOnly and server-set, which also exempts it from
// Safari/ITP's 7-day cap on script-writable storage.
//
// Cookie/state HMAC key: the dedicated `SESSION_SECRET` secret (a random,
// high-entropy value — deliberately not the admin password, which the cookie
// would otherwise expose to offline brute force). It is REQUIRED and is the
// sole signing AND verification key; there is no admin-credential fallback.
// When SESSION_SECRET is unset the site cannot run sessions — the entrypoint
// (src/index.js) serves a configuration-error page instead of signing cookies
// with a weaker key. Rotating SESSION_SECRET invalidates all sessions. The
// admin break-glass Basic Auth (below) is independent of this key.

import { getUserById } from "./accounts.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./accounts.js').User} User */

/**
 * A resolved caller identity. Two shapes share it: the break-glass admin
 * (`isSecretAdmin`, no `user` row) and D1 users (`user` row attached).
 * @typedef {Object} Identity
 * @property {string} id user-row id as a string, or ADMIN_ID for break-glass
 * @property {"admin" | "user"} role
 * @property {string | null} email
 * @property {string} name
 * @property {boolean} [isSecretAdmin] true only for the break-glass identity
 * @property {boolean} [pending] awaiting-approval user (index.js parks them)
 * @property {User} [user] the D1 row (absent for break-glass)
 * @property {boolean} [refreshCookie] cookie passed its half-life — reissue it
 */

const COOKIE_NAME = "dr_session";
const SESSION_TTL_S = 365 * 24 * 3600; // 1 year, sliding
const REFRESH_BELOW_S = SESSION_TTL_S / 2;

export const ADMIN_ID = "admin";

/**
 * The break-glass Basic Auth credentials, or null when unset (which makes
 * the whole site fail closed — see identify).
 * @param {Env} env
 * @returns {{ user: string, pass: string } | null}
 */
function adminCreds(env) {
  const user = env.ADMIN_USER || env.BASIC_AUTH_USER;
  const pass = env.ADMIN_PASS || env.BASIC_AUTH_PASS;
  return user && pass ? { user: String(user), pass: String(pass) } : null;
}

/** @returns {Identity} the break-glass admin identity (no D1 row) */
export function adminIdentity() {
  return { id: ADMIN_ID, role: "admin", email: null, name: "Admin", isSecretAdmin: true };
}

/** @param {User} user @returns {Identity} */
function userIdentity(user) {
  return {
    id: String(user.id),
    role: user.role === "admin" ? "admin" : "user",
    email: user.email,
    name: user.name || user.email,
    // Approval gate: pending users authenticate but only ever see the
    // waiting page (index.js enforces) until the admin activates them.
    pending: user.status === "pending",
    user,
  };
}

/**
 * Resolves who is making this request, or null. Order: Basic header
 * (admin secrets break-glass), then session cookie. Sets `refreshCookie`
 * on the identity when the cookie has passed its half-life.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Identity | null>}
 */
export async function identify(request, env) {
  const creds = adminCreds(env);
  if (!creds) return null; // fail closed

  const basic = parseBasicHeader(request);
  if (basic) {
    if (safeEqual(basic.user, creds.user) && safeEqual(basic.pass, creds.pass)) {
      return adminIdentity();
    }
    return null; // explicit bad credentials — don't fall through to cookie
  }

  const session = await verifySessionCookie(request, env);
  if (!session) return null;
  const refreshCookie = session.exp * 1000 - Date.now() < REFRESH_BELOW_S * 1000;

  if (session.uid === ADMIN_ID) return { ...adminIdentity(), refreshCookie };
  const user = await getUserById(env, Number(session.uid)).catch(() => null);
  if (user && (user.status === "active" || user.status === "pending")) {
    return { ...userIdentity(user), refreshCookie };
  }
  return null;
}

/**
 * Mints the signed, year-long session cookie (Set-Cookie header value).
 * @param {Env} env
 * @param {string} [uid] user-row id as a string; defaults to the admin id
 * @returns {Promise<string>}
 */
export async function createSessionCookie(env, uid = ADMIN_ID) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await signHmac(env, `${uid}.${exp}`);
  return (
    `${COOKIE_NAME}=u.${uid}.${exp}.${sig}; Max-Age=${SESSION_TTL_S}; Path=/; ` +
    "Secure; HttpOnly; SameSite=Lax"
  );
}

/** @returns {string} a Set-Cookie value that expires the session cookie */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

// HMAC helpers for the OAuth state cookie (src/google.js).
/**
 * @param {Env} env
 * @param {string} state
 * @returns {Promise<string>} hex HMAC tag over the namespaced state
 */
export async function signState(env, state) {
  return signHmac(env, `state.${state}`);
}
/**
 * Verifies the OAuth state cookie `<state>.<sig>` against the callback's
 * state param — both the equality and the signature must hold.
 * @param {Env} env
 * @param {string} state the `state` query param Google echoed back
 * @param {string} cookieValue
 * @returns {Promise<boolean>}
 */
export async function verifyState(env, state, cookieValue) {
  const [cState, cSig] = String(cookieValue).split(".");
  if (!cState || !cSig || !safeEqual(cState, state)) return false;
  return verifyHmac(env, `state.${state}`, cSig);
}

/**
 * @param {Request} request
 * @returns {{ user: string, pass: string } | null} decoded Basic credentials
 */
function parseBasicHeader(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/**
 * Returns {uid, exp} from a valid cookie, or null. Accepts the
 * pre-multiuser legacy format `<exp>.<sig>` as the admin identity so
 * existing sessions survive upgrades.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<{ uid: string, exp: number } | null>}
 */
async function verifySessionCookie(request, env) {
  const cookies = request.headers.get("Cookie") || "";
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split(".");

  if (parts[0] === "u" && parts.length === 4) {
    const [, uid, expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (!uid || !Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    return (await verifyHmac(env, `${uid}.${expStr}`, sig)) ? { uid, exp } : null;
  }

  if (parts.length === 2) {
    const [expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    return (await verifyHmac(env, expStr, sig)) ? { uid: ADMIN_ID, exp } : null;
  }
  return null;
}

/** @param {Uint8Array} rawBytes @returns {Promise<CryptoKey>} */
function importHmacKey(rawBytes) {
  return crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// The HMAC key for signing/verifying session (and OAuth-state) cookies.
//
// SESSION_SECRET is the SOLE key — there is NO fallback. An earlier design
// derived a key from the admin credentials when SESSION_SECRET was unset (and,
// worse, honored it alongside a configured secret), which kept every session
// cookie offline-brute-forceable against ADMIN_PASS — the cookie message
// `<uid>.<exp>` is known to its holder — and forgeable to any uid / to admin
// once ADMIN_PASS was recovered. That fallback is gone: cookie integrity is
// bounded only by SESSION_SECRET's entropy. When SESSION_SECRET is unset there
// is no signing key at all (returns []); the entrypoint (src/index.js) detects
// the missing secret up front and serves a configuration-error page rather than
// letting any auth flow run keyless. Rotating SESSION_SECRET invalidates all
// sessions.
/**
 * @param {Env} env
 * @returns {Promise<CryptoKey[]>} candidate verification keys (0 or 1 today)
 */
async function sessionHmacKeys(env) {
  if (!env.SESSION_SECRET) return [];
  const enc = new TextEncoder();
  return [await importHmacKey(enc.encode(String(env.SESSION_SECRET)))];
}

/** @param {ArrayBuffer} buf @returns {string} */
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {Env} env
 * @param {string} message
 * @returns {Promise<string>} hex HMAC-SHA-256 tag
 */
async function signHmac(env, message) {
  const [key] = await sessionHmacKeys(env);
  // Fail closed: never sign without SESSION_SECRET. index.js gates the whole
  // site on the secret before any signing path can run, so this is a
  // belt-and-braces guard, not a reachable state.
  if (!key) throw new Error("SESSION_SECRET is not configured");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

/**
 * True if the tag matches under ANY candidate key. With no keys configured
 * nothing verifies (fail closed).
 * @param {Env} env
 * @param {string} message
 * @param {string} sig hex tag from the cookie
 * @returns {Promise<boolean>}
 */
async function verifyHmac(env, message, sig) {
  const bytes = new TextEncoder().encode(message);
  for (const key of await sessionHmacKeys(env)) {
    const expected = toHex(await crypto.subtle.sign("HMAC", key, bytes));
    if (safeEqual(sig, expected)) return true;
  }
  return false;
}

/**
 * Constant-time-ish comparison to avoid trivial timing leaks.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
