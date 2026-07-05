// Cloudflare Worker for Deepresearch.se — entrypoint.
//
// Responsibilities: assign a request id, resolve the caller's identity
// (admin secrets or a D1 user account, via Basic Auth or the session
// cookie), route APIs vs static assets, and emit structured request logs.
// wrangler.toml sets run_worker_first = true so auth also covers the
// assets, which are served via env.ASSETS.
//
// Module map:
//   src/auth.js      — identity: admin secrets + D1 users, session cookie
//   src/login.js     — login / request-access / invite pages (PWAs can't 401)
//   src/accounts.js  — users, invites, access requests (D1)
//   src/quota.js     — config, usage accounting, quota enforcement
//   src/admin-api.js — /api/admin/* JSON API
//   src/chat.js      — /api/chat: streaming research pipeline
//   src/berget.js    — Berget.ai client + SSE consumption
//   src/exa.js       — Exa web_search
//   src/db.js        — optional D1 binding + schema
//   src/log.js       — structured JSON logger (LOG_LEVEL var)
//   src/http.js      — response helpers

import {
  acceptInvite,
  createAccessRequest,
  getValidInvite,
} from "./accounts.js";
import { handleAdminApi } from "./admin-api.js";
import {
  clearSessionCookie,
  createSessionCookie,
  identify,
  verifyLogin,
} from "./auth.js";
import { defaultModel, listModels } from "./berget.js";
import { handleChat } from "./chat.js";
import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { createLogger } from "./log.js";
import { invitePage, loginPage } from "./login.js";
import { effectiveQuota, getConfig, getUsage, windowReset } from "./quota.js";

export default {
  async fetch(request, env) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const log = createLogger(env, {
      request_id: requestId,
      method: request.method,
      path: url.pathname,
    });

    try {
      const response = await route(request, env, url, log);
      // Note: for /api/chat this marks headers-sent; the end of the SSE
      // stream is logged separately as chat.complete.
      log.info("request.complete", {
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      return withRequestId(response, requestId);
    } catch (err) {
      log.error("request.failed", {
        error: err?.message || String(err),
        stack: err?.stack,
        duration_ms: Date.now() - startedAt,
      });
      return withRequestId(
        jsonResponse({ error: "Internal server error.", request_id: requestId }, 500),
        requestId,
      );
    }
  },
};

// Branding assets served WITHOUT auth: iOS fetches apple-touch-icon and
// Chrome downloads manifest icons without credentials, so behind auth
// home-screen/PWA icons silently 401 and fall back to a generic letter.
// Nothing sensitive here — the icon, favicon, and app name only.
function isPublicAsset(url, method) {
  if (method !== "GET" && method !== "HEAD") return false;
  return (
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/icons/")
  );
}

async function route(request, env, url, log) {
  if (isPublicAsset(url, request.method)) {
    return env.ASSETS.fetch(request);
  }

  // ---- unauthenticated endpoints (login, invites, access requests) -------
  if (url.pathname === "/login" && request.method === "POST") {
    return handleLogin(request, env, log);
  }
  if (url.pathname === "/login" && request.method === "GET") {
    const config = await getConfig(env);
    return htmlResponse(loginPage(url.searchParams.get("flash") || "", config.allow_access_requests), 200);
  }
  if (url.pathname === "/request-access" && request.method === "POST") {
    return handleRequestAccess(request, env, log);
  }
  if (url.pathname === "/invite" && request.method === "GET") {
    const invite = await getValidInvite(env, url.searchParams.get("token")).catch(() => null);
    return htmlResponse(invitePage(invite), invite ? 200 : 404);
  }
  if (url.pathname === "/invite" && request.method === "POST") {
    return handleInviteAccept(request, env, log);
  }

  // ---- everything else requires an identity ------------------------------
  const identity = await identify(request, env);
  if (!identity) {
    log.warn("auth.denied", { reason: "unauthenticated" });
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Authentication required." }, 401);
    }
    // HTML login form instead of a WWW-Authenticate challenge: installed
    // PWAs cannot show the native Basic Auth dialog (black screen on iOS).
    const config = await getConfig(env);
    return htmlResponse(loginPage("", config.allow_access_requests), 401);
  }

  if (url.pathname === "/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/login", "Set-Cookie": clearSessionCookie() },
    });
  }
  if (url.pathname === "/api/chat" && request.method === "POST") {
    return handleChat(request, env, log, identity);
  }
  if (url.pathname === "/api/models" && request.method === "GET") {
    return handleModels(env, log);
  }
  if (url.pathname === "/api/me" && request.method === "GET") {
    return handleMe(env, identity);
  }

  // Admin-only: the JSON API and the admin UI assets.
  if (url.pathname.startsWith("/api/admin/")) {
    if (identity.role !== "admin") return jsonResponse({ error: "Admin access required." }, 403);
    return handleAdminApi(request, env, url, log, identity);
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    if (identity.role !== "admin") {
      return new Response(null, { status: 302, headers: { Location: "/" } });
    }
    return env.ASSETS.fetch(request);
  }

  return env.ASSETS.fetch(request);
}

// POST /login: admin secrets or a user's email+password; issues the signed
// session cookie (30 days) carrying the identity.
async function handleLogin(request, env, log) {
  let user = "";
  let pass = "";
  try {
    const form = await request.formData();
    user = String(form.get("username") ?? "");
    pass = String(form.get("password") ?? "");
  } catch {
    // fall through to failure
  }
  const identity = await verifyLogin(env, user, pass);
  if (identity) {
    log.info("login.success", { role: identity.role });
    return new Response(null, {
      status: 303,
      headers: { Location: "/", "Set-Cookie": await createSessionCookie(env, identity.id) },
    });
  }
  log.warn("login.failed", {});
  const config = await getConfig(env);
  return htmlResponse(loginPage("failed", config.allow_access_requests), 401);
}

// POST /request-access (public): records a pending request for the admin.
// Always answers the same way — no probing which emails exist.
async function handleRequestAccess(request, env, log) {
  const config = await getConfig(env);
  if (!config.allow_access_requests) {
    return htmlResponse(loginPage("request-off", false), 403);
  }
  let email = "";
  let message = "";
  try {
    const form = await request.formData();
    email = String(form.get("email") ?? "");
    message = String(form.get("message") ?? "");
  } catch {
    // handled below
  }
  try {
    await createAccessRequest(env, email, message);
    log.info("access.requested", {});
  } catch (err) {
    log.warn("access.request_failed", { error: err?.message || String(err) });
  }
  return new Response(null, { status: 303, headers: { Location: "/login?flash=requested" } });
}

// POST /invite (public, token-gated): sets the password, creates the
// account, and signs the new user in.
async function handleInviteAccept(request, env, log) {
  let token = "";
  let name = "";
  let password = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") ?? "");
    name = String(form.get("name") ?? "");
    password = String(form.get("password") ?? "");
  } catch {
    // handled below
  }
  try {
    const user = await acceptInvite(env, token, { name, password });
    log.info("invite.accepted", { role: user.role });
    return new Response(null, {
      status: 303,
      headers: { Location: "/", "Set-Cookie": await createSessionCookie(env, String(user.id)) },
    });
  } catch (err) {
    const invite = await getValidInvite(env, token).catch(() => null);
    log.warn("invite.accept_failed", { error: err?.message || String(err) });
    return htmlResponse(invitePage(invite, err?.message || "Could not create the account."), 400);
  }
}

// GET /api/me — identity + usage vs quota for the user dashboard.
async function handleMe(env, identity) {
  const config = await getConfig(env);
  const usage = await getUsage(env, identity.id);
  const quota = identity.isSecretAdmin ? null : effectiveQuota(config, identity.user);
  return jsonResponse({
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role: identity.role,
    unlimited: !!identity.isSecretAdmin,
    usage,
    quota,
    resets: {
      day: windowReset("day"),
      week: windowReset("week"),
      month: windowReset("month"),
    },
    db_configured: !!(await getDb(env)),
  });
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Model catalog for the UI dropdown (filtered + cached in src/berget.js).
async function handleModels(env, log) {
  try {
    const models = await listModels(env);
    const config = await getConfig(env);
    const configured = config.default_model && models.some((m) => m.id === config.default_model && m.up);
    log.debug("models.list", { count: models.length });
    return jsonResponse({ models, default: configured ? config.default_model : defaultModel(env) });
  } catch (err) {
    log.error("models.error", { error: err?.message || String(err) });
    return jsonResponse({ error: "Could not load the model catalog." }, 502);
  }
}

// Every response carries x-request-id so a user report can be correlated
// with the matching log entries. Clone first: asset responses are immutable.
function withRequestId(response, requestId) {
  const out = new Response(response.body, response);
  out.headers.set("x-request-id", requestId);
  return out;
}
