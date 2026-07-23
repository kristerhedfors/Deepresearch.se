// @ts-check
// Google sign-in (OIDC authorization-code flow, server side — no SDK).
//
// This is the ONLY user-facing sign-in. Any Google account with a verified
// email can sign in; the account row is auto-provisioned on first login as
// a regular user (quota-capped), except the ADMIN_EMAIL address which gets
// the admin role. The admin can still disable users / adjust quotas in
// /admin, and the ADMIN_USER/ADMIN_PASS secrets remain as break-glass
// Basic Auth for scripts and emergencies.
//
// Flow:
//   GET /auth/google           -> signed single-use state cookie, 302 to Google
//   GET /auth/google/callback  -> verify state, exchange code, validate ID
//                                 token claims, provision/load user, set the
//                                 long-lived session cookie, 303 /
//
// The ID token arrives directly from Google's token endpoint over TLS, so
// per Google's docs signature verification is not required in this flow —
// but the claims are: iss, aud (our client id), exp, and email_verified.
//
// GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL env overrides exist for local tests
// (pointing at a mock); production always uses the defaults.

import { createUserFromGoogle, getUserByEmail, normalizeEmail, updateUser } from "./accounts.js";
import { createSessionCookie, signState, verifyState } from "./auth.js";
import { getDb } from "./db.js";
import { getConfig } from "./config.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./accounts.js').User} User */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "dr_oauth";
const STATE_TTL_S = 600;

/** @param {Env} env @returns {boolean} both OAuth secrets are set */
export function googleConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/**
 * The one email address granted the admin role (the ADMIN_EMAIL dashboard
 * var), normalized — or null when unset/malformed.
 * @param {Env} env
 * @returns {string | null}
 */
export function adminEmail(env) {
  return normalizeEmail(env.ADMIN_EMAIL || "");
}

/** @param {URL} url @returns {string} */
function redirectUri(url) {
  return `${url.origin}/auth/google/callback`;
}

/**
 * GET /auth/google — mints the signed single-use CSRF state cookie and
 * redirects to Google's consent screen.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} [log]
 * @returns {Promise<Response>}
 */
export async function handleGoogleStart(request, env, url, log) {
  if (!googleConfigured(env)) {
    return new Response("Google sign-in is not configured.", { status: 503 });
  }
  // Full-visibility trace: the EXACT redirect_uri this request builds (from the
  // request host) and the client_id, so a live tail shows precisely what Google
  // receives — the ground truth behind redirect_uri_mismatch.
  log?.info("google.start", {
    host: url.host,
    redirect_uri: redirectUri(url),
    client_id: String(env.GOOGLE_CLIENT_ID || "").slice(0, 24),
  });
  const state = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const params = new URLSearchParams({
    // googleConfigured() above guarantees the secret is set.
    client_id: String(env.GOOGLE_CLIENT_ID),
    redirect_uri: redirectUri(url),
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.GOOGLE_AUTH_URL || AUTH_URL}?${params}`,
      "Set-Cookie":
        `${STATE_COOKIE}=${state}.${await signState(env, state)}; Max-Age=${STATE_TTL_S}; ` +
        "Path=/auth/google; Secure; HttpOnly; SameSite=Lax",
    },
  });
}

/**
 * GET /auth/google/callback — verifies the CSRF state, exchanges the code
 * server-to-server, validates the ID-token claims, provisions/loads the
 * user, and sets the long-lived session cookie. Every failure path bounces
 * to /login with a flash code (never a bare error page).
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleGoogleCallback(request, env, url, log) {
  /**
   * @param {string} flash login-page flash code (src/login.js loginPage)
   * @param {string} [detail] logged, never shown to the user
   */
  const fail = (flash, detail) => {
    log.warn("google.auth_failed", { reason: flash, detail: detail || undefined });
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/login?flash=${flash}`,
        "Set-Cookie": clearStateCookie(),
      },
    });
  };

  if (!googleConfigured(env)) return fail("google-failed", "not configured");
  if (!(await getDb(env))) return fail("nodb");

  // CSRF: the state param must match the signed single-use cookie.
  const state = url.searchParams.get("state") || "";
  const cookie = (request.headers.get("Cookie") || "").match(
    new RegExp(`(?:^|;\\s*)${STATE_COOKIE}=([^;]+)`),
  )?.[1];
  if (!state || !cookie || !(await verifyState(env, state, cookie))) {
    return fail("google-failed", "state mismatch");
  }
  const code = url.searchParams.get("code");
  if (!code) return fail("google-failed", url.searchParams.get("error") || "no code");

  // Exchange the code server-to-server.
  let tokenData;
  try {
    const resp = await fetch(env.GOOGLE_TOKEN_URL || TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        // googleConfigured() above guarantees both secrets are set.
        client_id: String(env.GOOGLE_CLIENT_ID),
        client_secret: String(env.GOOGLE_CLIENT_SECRET),
        redirect_uri: redirectUri(url),
        grant_type: "authorization_code",
      }),
    });
    if (!resp.ok) return fail("google-failed", `token exchange ${resp.status}`);
    tokenData = await resp.json();
  } catch (err) {
    return fail("google-failed", /** @type {any} */ (err)?.message || String(err));
  }

  const claims = decodeJwtPayload(tokenData.id_token);
  if (!claims) return fail("google-failed", "bad id_token");
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issOk) return fail("google-failed", "bad iss");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return fail("google-failed", "bad aud");
  if (!(claims.exp * 1000 > Date.now())) return fail("google-failed", "expired");
  if (claims.email_verified !== true) return fail("google-unverified");
  const email = normalizeEmail(claims.email);
  if (!email) return fail("google-failed", "bad email");

  // Provision on first sign-in; ADMIN_EMAIL gets (and keeps) the admin
  // role and is always active. With the approval gate on (config
  // require_approval), everyone else lands as "pending": they get a
  // session, but only the waiting page until the admin approves — so
  // approval takes effect on their next request, no re-login.
  const isAdminEmail = email === adminEmail(env);
  // Provisioning, role sync and session minting are wrapped so an UNEXPECTED
  // failure here (a transient D1 read/write error, a provisioning race) honors
  // this module's contract — every failure path bounces to /login with a flash,
  // never a bare error page. Without this a throw escapes to index.js's
  // top-level catch and the user, mid-sign-in, gets the generic
  // `{"error":"Internal server error.","request_id":…}` 500 instead. This path
  // is exactly what runs "upon login" for a first-time (invite-only) signer-in,
  // where getConfig + createUserFromGoogle both touch D1.
  try {
    let user = await getUserByEmail(env, email);
    if (!user) {
      const config = await getConfig(env);
      user = await createUserFromGoogle(env, {
        email,
        name: typeof claims.name === "string" ? claims.name : "",
        sub: typeof claims.sub === "string" ? claims.sub : "",
        role: isAdminEmail ? "admin" : "user",
        status: !isAdminEmail && config.require_approval ? "pending" : "active",
      });
      log.info("google.user_created", { role: user.role, status: user.status });
    } else {
      if (user.status === "disabled") return fail("disabled");
      if (isAdminEmail && user.role !== "admin") {
        // The row exists (we just loaded it), so the update returns it.
        user = /** @type {User} */ (await updateUser(env, user.id, { role: "admin" }));
      }
    }

    log.info("login.success", { role: user.role, via: "google" });
    // The signed-in app lives at /rver (the DeepResearch.Se/rver = "deep
    // research server" wordplay; the root redirects to DRC at /cure).
    const headers = new Headers({ Location: "/rver" });
    headers.append("Set-Cookie", clearStateCookie());
    headers.append("Set-Cookie", await createSessionCookie(env, String(user.id)));
    return new Response(null, { status: 303, headers });
  } catch (err) {
    return fail("google-failed", /** @type {any} */ (err)?.message || String(err));
  }
}

/** @returns {string} a Set-Cookie value that expires the state cookie */
function clearStateCookie() {
  return `${STATE_COOKIE}=; Max-Age=0; Path=/auth/google; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Decodes (does NOT verify) a JWT's payload segment. Signature verification
 * is deliberately skipped — the token arrives directly from Google's token
 * endpoint over TLS (see the module header); the CLAIMS are validated by the
 * caller.
 * @param {unknown} jwt
 * @returns {any} the claims object, or null when malformed
 */
function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))),
    );
  } catch {
    return null;
  }
}
