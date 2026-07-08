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
//   src/config.js    — global site config (D1 config table, cached)
//   src/quota.js     — usage accounting + quota enforcement
//   src/user-api.js  — /api/me + /api/models + /api/client-error + /api/history-key
//   src/history-key.js — per-user key for the client's encrypted local history
//   src/settings.js  — per-user settings (/api/settings: server_history + shodan_mcp knobs)
//   src/storage.js   — opt-in R2 cloud storage (/api/convos, /api/files, /api/storage)
//   src/rag.js       — document RAG: /api/embed proxy + /api/rag/* (Vectorize)
//   src/quiz-api.js  — /api/quiz/grade: free-text quiz-answer grading (src/quiz.js)
//   src/admin-api.js — /api/admin/* JSON API
//   src/chat.js      — /api/chat: streaming research pipeline
//   src/answers.js   — /api/chat/answer: TTL'd answer recovery cache
//   src/berget.js    — Berget.ai client + SSE consumption
//   src/exa.js       — Exa web_search
//   src/db.js        — optional D1 binding + schema
//   src/log.js       — structured JSON logger (LOG_LEVEL var)
//   src/http.js      — response helpers

import { handleAdminApi } from "./admin-api.js";
import { handleAnswerAck, handleAnswerGet } from "./answers.js";
import { clearSessionCookie, createSessionCookie, identify } from "./auth.js";
import { handleChat } from "./chat.js";
import { handleMcp } from "./mcp.js";
import { handleGoogleCallback, handleGoogleStart } from "./google.js";
import { jsonResponse } from "./http.js";
import { createLogger } from "./log.js";
import { acceptTerms } from "./accounts.js";
import { loginPage, pendingPage, termsPage } from "./login.js";
import {
  handleClientError,
  handleHistoryKey,
  handleMe,
  handleMessages,
  handleModels,
} from "./user-api.js";
import { handleSettingsGet, handleSettingsPut } from "./settings.js";
import { handleStorage } from "./storage.js";
import { handleEmbed, handleRag } from "./rag.js";
import { handleQuizGrade } from "./quiz-api.js";

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const log = createLogger(env, {
      request_id: requestId,
      method: request.method,
      path: url.pathname,
    });

    try {
      const { response, identity } = await route(request, env, url, log, ctx, requestId);
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

// The public surface, served WITHOUT auth. Two kinds of things live here:
//
// Branding assets: iOS fetches apple-touch-icon and Chrome downloads
// manifest icons without credentials, so behind auth home-screen/PWA
// icons silently 401 and fall back to a generic letter.
//
// The promotional surface: the landing page (/welcome/, also served to
// signed-out visitors at /), the documentation, About, and the build
// story pages plus everything they need to render — the promo video, the
// markdown renderer, and the vendored libs (all public on GitHub anyway).
// The app itself and every /api/* stay gated.
function isPublicAsset(url, method) {
  if (method !== "GET" && method !== "HEAD") return false;
  return (
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/welcome/") ||
    url.pathname.startsWith("/help/") ||
    url.pathname.startsWith("/build/") ||
    url.pathname.startsWith("/story/") ||
    url.pathname === "/llm-assiterad-utveckling.mp4" ||
    url.pathname === "/js/markdown.js" ||
    url.pathname === "/vendor/marked.min.js" ||
    url.pathname === "/vendor/purify.min.js"
  );
}

// Serves a static asset with an EXPLICIT browser-caching policy. Without
// one (the state until 2026-07-08), browsers applied HEURISTIC caching to
// the app's ~20 unversioned ES modules — and a day with several deploys
// that changed cross-module exports left real devices with a MIXED module
// graph (a fresh stream.js importing a stale-cached activity.js). The
// import linker then fails, app.js never runs, no submit handler attaches,
// and pressing Send falls through to the browser's NATIVE form submit — a
// full page reload that looks like the chat silently resetting to a blank
// new conversation ("no queries work"). `no-cache` (= store but REVALIDATE
// every use) fixes the class: the strong etags Workers assets already emit
// make revalidation a cheap 304, and every page load links a consistent,
// current module graph. Icons/media (not part of the module graph, rarely
// changed) keep a short real TTL. The Cloudflare EDGE cache is unaffected
// and safe — it is content-addressed per deploy.
const ASSET_REVALIDATE = /\.(js|css|html|md|webmanifest)$/i;
async function serveAsset(request, env, overrideUrl = null) {
  const res = await env.ASSETS.fetch(overrideUrl ? new Request(overrideUrl, request) : request);
  const pathname = new URL(overrideUrl || request.url).pathname;
  const headers = new Headers(res.headers);
  // Extensionless paths are HTML routes (/, /welcome/, /admin) — revalidate.
  if (ASSET_REVALIDATE.test(pathname) || !/\.[a-z0-9]+$/i.test(pathname)) {
    headers.set("cache-control", "no-cache");
  } else {
    headers.set("cache-control", "public, max-age=3600");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Returns {response, identity} — identity only when resolved, so the
// caller can slide the session cookie.
async function route(request, env, url, log, ctx, requestId) {
  if (isPublicAsset(url, request.method)) {
    return { response: await serveAsset(request, env) };
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
    // Visitors hitting the root get the promotional landing page (video,
    // docs, build story, sign-in) rather than a bare login form.
    if (url.pathname === "/" && request.method === "GET") {
      return {
        response: await serveAsset(request, env, url.origin + "/welcome/"),
      };
    }
    log.warn("auth.denied", { reason: "unauthenticated" });
    if (url.pathname.startsWith("/api/")) {
      return { response: jsonResponse({ error: "Authentication required." }, 401) };
    }
    // Sign-in page instead of a WWW-Authenticate challenge: installed PWAs
    // cannot show the native Basic Auth dialog (black screen on iOS).
    return { response: htmlResponse(loginPage(""), 401) };
  }

  const response = await routeAuthed(request, env, url, log, identity, ctx, requestId);
  return { response, identity };
}

async function routeAuthed(request, env, url, log, identity, ctx, requestId) {
  if (url.pathname === "/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/login", "Set-Cookie": clearSessionCookie() },
    });
  }

  // Terms gate: every account must accept the terms of use once, right
  // after first sign-in — before the approval wait, the app, or any API.
  // The break-glass identity has no user row to record acceptance on and
  // is exempt (it's the operator). /build/ (About) and /story/ (build
  // history) stay readable pre-acceptance so the full text the terms
  // summarize is one tap away, and /logout is handled above. Static
  // assets (js/css/vendor/markdown files, matched by file extension)
  // always pass through — they're inert code, not gated content, and
  // /build/ + /story/ need their own scripts and history.md to render.
  if (identity.user && !identity.user.terms_accepted_at) {
    if (url.pathname === "/terms/accept" && request.method === "POST") {
      await acceptTerms(env, identity.user.id);
      return new Response(null, { status: 303, headers: { Location: "/" } });
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "The terms of use must be accepted first.", terms: true }, 403);
    }
    const isStaticAsset = request.method === "GET" && /\.[a-z0-9]+$/i.test(url.pathname);
    const isAllowedPage = request.method === "GET" && /^\/(build|story)(\/|$)/.test(url.pathname);
    if (isStaticAsset || isAllowedPage) {
      return serveAsset(request, env);
    }
    return htmlResponse(termsPage(identity), 200);
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
    return handleChat(request, env, log, identity, ctx, requestId);
  }
  // MCP server (Streamable HTTP, JSON-RPC 2.0): exposes the research pipeline
  // as a `deep_research` tool for other agents. Placed after the identity gate
  // so it inherits the same access control (break-glass Basic Auth header or a
  // signed-in session).
  if (url.pathname === "/mcp" && request.method === "POST") {
    return handleMcp(request, env, log, identity, ctx, requestId);
  }
  // Answer recovery (src/answers.js): poll a dropped stream's finished
  // answer back, or ack an intact delivery so the cached copy is purged.
  if (url.pathname === "/api/chat/answer" && request.method === "GET") {
    return handleAnswerGet(env, url, identity);
  }
  if (url.pathname === "/api/chat/answer" && request.method === "DELETE") {
    return handleAnswerAck(env, url, identity);
  }
  if (url.pathname === "/api/models" && request.method === "GET") {
    return handleModels(env, log);
  }
  if (url.pathname === "/api/me" && request.method === "GET") {
    return handleMe(env, identity);
  }
  if (url.pathname === "/api/history-key" && request.method === "GET") {
    return handleHistoryKey(env, identity);
  }
  if (url.pathname === "/api/messages" && request.method === "GET") {
    return handleMessages(env, identity);
  }
  // Per-user settings (server_history + shodan_mcp knobs).
  if (url.pathname === "/api/settings" && request.method === "GET") {
    return handleSettingsGet(env, identity);
  }
  if (url.pathname === "/api/settings" && request.method === "PUT") {
    return handleSettingsPut(request, env, log, identity);
  }
  // Free-text quiz-answer grading (the inline-quiz capability —
  // src/quiz-api.js; multiple-choice picks grade client-side).
  if (url.pathname === "/api/quiz/grade" && request.method === "POST") {
    return handleQuizGrade(request, env, log, identity);
  }
  // Document-RAG embedding proxy (used in BOTH storage modes) + the
  // server-side index endpoints (knob-gated inside src/rag.js).
  if (url.pathname === "/api/embed" && request.method === "POST") {
    return handleEmbed(request, env, log, identity);
  }
  if (url.pathname.startsWith("/api/rag/")) {
    return handleRag(request, env, url, log, identity);
  }
  // Opt-in cloud storage: encrypted conversation/project records + files.
  if (
    url.pathname === "/api/convos" ||
    url.pathname.startsWith("/api/convos/") ||
    url.pathname === "/api/projects" ||
    url.pathname.startsWith("/api/projects/") ||
    url.pathname === "/api/files" ||
    url.pathname.startsWith("/api/files/") ||
    url.pathname === "/api/storage"
  ) {
    return handleStorage(request, env, url, log, identity);
  }
  if (url.pathname === "/api/client-error" && request.method === "POST") {
    return handleClientError(request, log, identity);
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
    return serveAsset(request, env);
  }

  return serveAsset(request, env);
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Every response carries x-request-id so a user report can be correlated
// with the matching log entries. Clone first: asset responses are immutable.
function withRequestId(response, requestId) {
  const out = new Response(response.body, response);
  out.headers.set("x-request-id", requestId);
  return out;
}
