// @ts-check
// Identity (identity-access steps 2-3). The one identity function + the session
// cookie, reproducing the parent site's construction EXACTLY so this instance
// validates the same `dr_session` cookies:
//
//   cookie:  dr_session = u.<uid>.<exp>.<sig>
//   sig   :  hex( HMAC-SHA-256( key = SESSION_SECRET, msg = "<uid>.<exp>" ) )
//   exp   :  unix seconds; 365-day TTL with SLIDING reissue past the half-life
//
// SESSION_SECRET is the SOLE key — no admin-credential fallback (the parent
// removed that because it made a captured cookie offline-brute-forceable
// against ADMIN_PASS). When it is unset, identify() returns null for cookies
// and the entrypoint serves a config-error page (index.js) rather than run any
// auth flow keyless. Break-glass admin over HTTP Basic is the only non-cookie
// identity, for curl/scripts/emergencies.

import { sign, verify, safeEqual } from "./hmac.js";

const COOKIE_NAME = "dr_session";
const SESSION_TTL_S = 365 * 24 * 60 * 60;
export const ADMIN_ID = "admin";

/**
 * @typedef {Object} Identity
 * @property {string} uid       opaque authenticated id (parent D1 row id, an
 *                              email for instance-native sign-ins, or "admin")
 * @property {boolean} isAdmin
 * @property {boolean} [refreshCookie] cookie past its half-life — reissue it
 */

/** @param {{ ADMIN_USER?: string, ADMIN_PASS?: string }} env */
function adminCreds(env) {
  return { user: env.ADMIN_USER || "", pass: env.ADMIN_PASS || "" };
}

/** @param {Request} request @returns {{ user: string, pass: string } | null} */
function parseBasic(request) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return null;
  let decoded;
  try {
    decoded = atob(h.slice(6));
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * Resolve the caller's identity: Basic break-glass first (an explicitly BAD
 * Basic header returns null WITHOUT falling through to the cookie), then the
 * session cookie. Returns null (anonymous) when nothing valid is present.
 * @param {Request} request
 * @param {{ SESSION_SECRET?: string, ADMIN_USER?: string, ADMIN_PASS?: string }} env
 * @returns {Promise<Identity | null>}
 */
export async function identify(request, env) {
  const basic = parseBasic(request);
  if (basic) {
    const { user, pass } = adminCreds(env);
    if (user && pass && safeEqual(basic.user, user) && safeEqual(basic.pass, pass)) {
      return { uid: ADMIN_ID, isAdmin: true };
    }
    return null; // explicit bad credentials — do not fall through to the cookie
  }

  const cookie = await verifySessionCookie(request, env);
  if (!cookie) return null;
  const halfLife = cookie.exp - SESSION_TTL_S / 2;
  return {
    uid: cookie.uid,
    isAdmin: cookie.uid === ADMIN_ID,
    refreshCookie: Math.floor(Date.now() / 1000) > halfLife,
  };
}

/**
 * @param {Request} request
 * @param {{ SESSION_SECRET?: string }} env
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
    return (await verify(env, "", `${uid}.${expStr}`, sig)) ? { uid, exp } : null;
  }
  // Legacy pre-multiuser format `<exp>.<sig>` maps to the admin identity.
  if (parts.length === 2) {
    const [expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    return (await verify(env, "", expStr, sig)) ? { uid: ADMIN_ID, exp } : null;
  }
  return null;
}

/**
 * Mint the signed, year-long session cookie (Set-Cookie value).
 * @param {{ SESSION_SECRET?: string }} env
 * @param {string} [uid]
 * @returns {Promise<string>}
 */
export async function createSessionCookie(env, uid = ADMIN_ID) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await sign(env, "", `${uid}.${exp}`);
  return (
    `${COOKIE_NAME}=u.${uid}.${exp}.${sig}; Max-Age=${SESSION_TTL_S}; Path=/; ` +
    "Secure; HttpOnly; SameSite=Lax"
  );
}

/** @returns {string} a Set-Cookie value that expires the session cookie */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

// OAuth state-cookie HMAC (namespaced so it can never be replayed as a session).
/** @param {{ SESSION_SECRET?: string }} env @param {string} state */
export function signState(env, state) {
  return sign(env, "state", state);
}
/**
 * @param {{ SESSION_SECRET?: string }} env
 * @param {string} state the `state` query param the provider echoed back
 * @param {string} cookieValue the `<state>.<sig>` state cookie
 * @returns {Promise<boolean>}
 */
export async function verifyState(env, state, cookieValue) {
  const [cState, cSig] = String(cookieValue).split(".");
  if (!cState || !cSig || !safeEqual(cState, state)) return false;
  return verify(env, "state", state, cSig);
}
