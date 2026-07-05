// Cloudflare Worker for Deepresearch.se — entrypoint.
//
// Responsibilities: assign a request id, resolve the caller's identity
// (Google-provisioned D1 user via the session cookie, or the admin-secrets
// break-glass over Basic Auth), route APIs vs static assets, slide the
// session cookie, and emit structured request logs. wrangler.toml sets
// run_worker_first = true so auth also covers the assets, which are served
// via env.ASSETS.
//
// Module map:
//   src/auth.js      — identity: session cookie + admin break-glass
//   src/google.js    — Google OIDC sign-in (the only user-facing login)
//   src/login.js     — sign-in page (PWAs can't answer a 401 challenge)
//   src/accounts.js  — user accounts (D1)
//   src/quota.js     — config, usage accounting, quota enforcement
//   src/admin-api.js — /api/admin/* JSON API
//   src/chat.js      — /api/chat: streaming research pipeline
//   src/berget.js    — Berget.ai client + SSE consumption
//   src/exa.js       — Exa web_search
//   src/db.js        — optional D1 binding + schema
//   src/log.js       — structured JSON logger (LOG_LEVEL var)
//   src/http.js      — response helpers

import { handleAdminApi } from "./admin-api.js";
import { clearSessionCookie, createSessionCookie, identify } from "./auth.js";
import { defaultModel, listModels } from "./berget.js";
import { handleChat } from "./chat.js";
import { getDb } from "./db.js";
import { handleGoogleCallback, handleGoogleStart } from "./google.js";
import { jsonResponse } from "./http.js";
import { createLogger } from "./log.js";
import { loginPage, pendingPage } from "./login.js";
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
      const { response, identity } = await route(request, env, url, log);
      // Note: for /api/chat this marks headers-sent; the end of the SSE
      // stream is logged separately as chat.complete.
      log.info("request.complete", {
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      const out = withRequestId(response, requestId);
      // Sliding sessions: past the cookie's half-life, reissue it so active
      // PWA users never see a login screen again.
      if (identity?.refreshCookie) {
        out.headers.append("Set-Cookie", await createSessionCookie(env, identity.id));
      }
      return out;
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

// Returns {response, identity} — identity only when resolved, so the
// caller can slide the session cookie.
async function route(request, env, url, log) {
  if (isPublicAsset(url, request.method)) {
    return { response: await env.ASSETS.fetch(request) };
  }

  // ---- unauthenticated: sign-in surface -----------------------------------
  if (url.pathname === "/login" && request.method === "GET") {
    return { response: htmlResponse(loginPage(url.searchParams.get("flash") || ""), 200) };
  }
  if (url.pathname === "/auth/google" && request.method === "GET") {
    return { response: await handleGoogleStart(request, env, url) };
  }
  if (url.pathname === "/auth/google/callback" && request.method === "GET") {
    return { response: await handleGoogleCallback(request, env, url, log) };
  }

  // ---- everything else requires an identity ------------------------------
  const identity = await identify(request, env);
  if (!identity) {
    log.warn("auth.denied", { reason: "unauthenticated" });
    if (url.pathname.startsWith("/api/")) {
      return { response: jsonResponse({ error: "Authentication required." }, 401) };
    }
    // Sign-in page instead of a WWW-Authenticate challenge: installed PWAs
    // cannot show the native Basic Auth dialog (black screen on iOS).
    return { response: htmlResponse(loginPage(""), 401) };
  }

  const response = await routeAuthed(request, env, url, log, identity);
  return { response, identity };
}

async function routeAuthed(request, env, url, log, identity) {
  if (url.pathname === "/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/login", "Set-Cookie": clearSessionCookie() },
    });
  }

  // Approval gate: pending users are parked on the waiting page — no APIs,
  // no app, no admin — until the admin flips them to active. The page
  // auto-refreshes, so approval takes effect without a re-login.
  if (identity.pending) {
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Your account is awaiting approval.", pending: true }, 403);
    }
    return htmlResponse(pendingPage(identity), 200);
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
