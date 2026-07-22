// @ts-check
// Google OIDC sign-in, server-side, no SDK (identity-access step 4).
//
//   /auth/login    -> mint state, set signed single-use state cookie, 302 to Google
//   /auth/callback -> verify state, exchange code, validate ID-token CLAIMS
//                     (iss / aud / exp / email_verified), mint the session cookie
//
// The ID token arrives directly from Google's token endpoint over TLS, so its
// SIGNATURE is not re-verified here (the TLS channel + client_secret exchange
// is the trust anchor); the CLAIMS are validated. Auto-provision is implicit:
// any Google account with a verified email becomes a user whose uid IS the
// normalized email; ADMIN_EMAIL becomes admin. No database — the cookie is the
// whole account (bottom-up; a real deployment would add a user row for
// disable-on-demand, which this instance deliberately omits).

import { createSessionCookie, signState, verifyState, ADMIN_ID } from "./auth.js";
import { htmlResponse } from "./http.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "dr_oauth_state";
const OAUTH_TIMEOUT_MS = 10_000;

/** @param {{ GOOGLE_CLIENT_ID?: string, GOOGLE_CLIENT_SECRET?: string }} env */
export function googleConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** @param {string} email @returns {string} */
export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** @param {URL} url @returns {string} the exact redirect_uri for this host */
function redirectUri(url) {
  return `${url.origin}/auth/callback`;
}

/** @param {string} n @returns {string} n random bytes, hex */
function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Start route: mint state, set a signed single-use state cookie, 302 to consent.
 * @param {URL} url
 * @param {any} env
 * @param {import('./log.js').Logger} log
 * @returns {Promise<Response>}
 */
export async function googleLogin(url, env, log) {
  const state = randomHex(16);
  const stateSig = await signState(env, state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: String(env.GOOGLE_CLIENT_ID),
    redirect_uri: redirectUri(url),
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  // Ground truth for redirect_uri_mismatch debugging: log the exact uri + a
  // client_id prefix (never the secret).
  log.info("auth.login_start", {
    redirect_uri: redirectUri(url),
    client_id: String(env.GOOGLE_CLIENT_ID || "").slice(0, 24),
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.GOOGLE_AUTH_URL || AUTH_URL}?${params}`,
      "Set-Cookie":
        `${STATE_COOKIE}=${state}.${stateSig}; Max-Age=600; Path=/auth/callback; ` +
        "Secure; HttpOnly; SameSite=Lax",
    },
  });
}

/** @param {string} code @param {string} detail (logged, never shown) */
function loginRedirect(code) {
  return new Response(null, { status: 303, headers: { Location: `/?login=${code}` } });
}

/** @param {string} jwt @returns {any|null} decoded payload (claims), no sig check */
function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
  } catch {
    return null;
  }
}

/**
 * Callback route: verify state, exchange the code, validate ID-token claims,
 * mint the session cookie. Every failure 303s to `/?login=<code>` with the
 * detail in the log, never in the URL.
 * @param {URL} url
 * @param {Request} request
 * @param {any} env
 * @param {import('./log.js').Logger} log
 * @returns {Promise<Response>}
 */
export async function googleCallback(url, request, env, log) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const cookies = request.headers.get("Cookie") || "";
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${STATE_COOKIE}=([^;]+)`));
  if (!m || !(await verifyState(env, state, m[1]))) {
    log.warn("auth.callback_bad_state", {});
    return loginRedirect("state-failed");
  }
  if (!code) return loginRedirect("no-code");

  let payload;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OAUTH_TIMEOUT_MS);
    const resp = await fetch(env.GOOGLE_TOKEN_URL || TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: String(env.GOOGLE_CLIENT_ID),
        client_secret: String(env.GOOGLE_CLIENT_SECRET),
        redirect_uri: redirectUri(url),
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!resp.ok) {
      log.warn("auth.token_exchange_failed", { status: resp.status });
      return loginRedirect("google-failed");
    }
    const tok = await resp.json();
    payload = decodeJwtPayload(tok.id_token);
  } catch (e) {
    log.error("auth.token_exchange_error", { message: String(e && /** @type {any} */ (e).message) });
    return loginRedirect("google-failed");
  }

  if (!payload) return loginRedirect("google-failed");
  const issOk = payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
  if (!issOk) return loginRedirect("google-failed");
  if (payload.aud !== env.GOOGLE_CLIENT_ID) return loginRedirect("google-failed");
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return loginRedirect("google-failed");
  if (payload.email_verified !== true) return loginRedirect("email-unverified");

  const email = normalizeEmail(payload.email);
  if (!email) return loginRedirect("google-failed");
  const adminEmail = normalizeEmail(env.ADMIN_EMAIL || "");
  const uid = adminEmail && email === adminEmail ? ADMIN_ID : email;
  log.info("auth.sign_in_ok", { admin: uid === ADMIN_ID });

  const cookie = await createSessionCookie(env, uid);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": [cookie, `${STATE_COOKIE}=; Max-Age=0; Path=/auth/callback`].join(", "),
    },
  });
}

/** A tiny sign-in page for anonymous visitors (served, not stored). */
export function loginPage(env) {
  const configured = googleConfigured(env);
  const btn = configured
    ? `<a class="btn" href="/auth/login">Sign in with Google</a>`
    : `<p class="muted">Google sign-in is not configured on this instance.</p>`;
  return htmlResponse(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepResearch Lite — sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
    display: grid; place-items: center; background: #0b0f14; color: #e6edf3; }
  .card { max-width: 22rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 .3rem; }
  .tail { color: #7ee787; font-weight: 700; }
  .muted { color: #8b949e; }
  .btn { display: inline-block; margin-top: 1rem; padding: .6rem 1.1rem; border-radius: .6rem;
    background: #238636; color: #fff; text-decoration: none; font-weight: 600; }
</style></head><body>
<div class="card">
  <h1>DeepResearch<span class="tail">.Se/rv+</span></h1>
  <p class="muted">A distilled research instance. Behind the same sign-in as the main site.</p>
  ${btn}
</div></body></html>`);
}
