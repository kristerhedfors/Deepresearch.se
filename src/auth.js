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
// Everything fails closed when the admin secrets are unset (they also key
// the HMAC — rotating them invalidates all sessions).

import { getUserById } from "./accounts.js";

const COOKIE_NAME = "dr_session";
const SESSION_TTL_S = 365 * 24 * 3600; // 1 year, sliding
const REFRESH_BELOW_S = SESSION_TTL_S / 2;

export const ADMIN_ID = "admin";

function adminCreds(env) {
  const user = env.ADMIN_USER || env.BASIC_AUTH_USER;
  const pass = env.ADMIN_PASS || env.BASIC_AUTH_PASS;
  return user && pass ? { user, pass } : null;
}

export function adminIdentity() {
  return { id: ADMIN_ID, role: "admin", email: null, name: "Admin", isSecretAdmin: true };
}

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

// Resolves who is making this request, or null. Order: Basic header
// (admin secrets break-glass), then session cookie. Sets `refreshCookie`
// on the identity when the cookie has passed its half-life.
export async function identify(request, env) {
  if (!adminCreds(env)) return null; // fail closed

  const basic = parseBasicHeader(request);
  if (basic) {
    const creds = adminCreds(env);
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

export async function createSessionCookie(env, uid = ADMIN_ID) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await hmacHex(env, `${uid}.${exp}`);
  return (
    `${COOKIE_NAME}=u.${uid}.${exp}.${sig}; Max-Age=${SESSION_TTL_S}; Path=/; ` +
    "Secure; HttpOnly; SameSite=Lax"
  );
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

// HMAC helpers for the OAuth state cookie (src/google.js).
export async function signState(env, state) {
  return hmacHex(env, `state.${state}`);
}
export async function verifyState(env, state, cookieValue) {
  const [cState, cSig] = String(cookieValue).split(".");
  if (!cState || !cSig || !safeEqual(cState, state)) return false;
  return safeEqual(cSig, await hmacHex(env, `state.${state}`));
}

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

// Returns {uid, exp} from a valid cookie, or null. Accepts the
// pre-multiuser legacy format `<exp>.<sig>` as the admin identity so
// existing sessions survive upgrades.
async function verifySessionCookie(request, env) {
  const cookies = request.headers.get("Cookie") || "";
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split(".");

  if (parts[0] === "u" && parts.length === 4) {
    const [, uid, expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (!uid || !Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    const expected = await hmacHex(env, `${uid}.${expStr}`);
    return safeEqual(sig, expected) ? { uid, exp } : null;
  }

  if (parts.length === 2) {
    const [expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    const expected = await hmacHex(env, expStr);
    return safeEqual(sig, expected) ? { uid: ADMIN_ID, exp } : null;
  }
  return null;
}

async function hmacHex(env, message) {
  const creds = adminCreds(env);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`${creds.user} ${creds.pass}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison to avoid trivial timing leaks.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
