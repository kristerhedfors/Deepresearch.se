// @ts-check
// Cloudflare Worker for Deepresearch.se — entrypoint.
//
// Responsibilities: assign a request id, resolve the caller's identity
// (Google-provisioned D1 user via the session cookie, or the admin-secrets
// break-glass over Basic Auth), route APIs vs static assets, slide the
// session cookie, and emit structured request logs. wrangler.toml sets
// run_worker_first = true so auth also covers the assets, which are served
// via env.ASSETS.
//
// Gate ordering (load-bearing, enforced in route/routeAuthed):
//   identity → terms acceptance → approval → handlers.
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
//   src/games.js     — /api/games: the games registry/shelf + per-game dispatch
//                      (Tokemon: src/tokemon-api.js, game core src/tokemon.js)
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
import { configErrorPage, loginPage, pendingPage, termsPage } from "./login.js";
import {
  handleClientError,
  handleHistoryKey,
  handleMe,
  handleMessages,
  handleModels,
} from "./user-api.js";
import { handleFeedbackApi } from "./feedback.js";
import { handleSettingsGet, handleSettingsPut } from "./settings.js";
import { handleStorage } from "./storage.js";
import { handleVault } from "./vault.js";
import { handleEmbed, handleRag } from "./rag.js";
import { handleQuizGrade } from "./quiz-api.js";
import { handleGames } from "./games.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */
/**
 * What `route` hands back to `fetch`: the response, plus the resolved
 * identity (when there is one) so the session cookie can slide.
 * @typedef {{ response: Response, identity?: Identity }} RouteResult
 */

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
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
        error: /** @type {any} */ (err)?.message || String(err),
        stack: /** @type {any} */ (err)?.stack,
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
/**
 * @param {URL} url
 * @param {string} method
 * @returns {boolean}
 */
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
/**
 * @param {Request} request
 * @param {Env} env
 * @param {string | null} [overrideUrl] serve this path instead of the request's
 * @returns {Promise<Response>}
 */
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

/**
 * Top-level routing: config sanity, the public (unauthenticated) surface,
 * then the identity gate ahead of everything else. Returns the identity
 * only when resolved, so the caller can slide the session cookie.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @returns {Promise<RouteResult>}
 */
async function route(request, env, url, log, ctx, requestId) {
  // Hard configuration requirement: SESSION_SECRET must be set. It is the sole
  // key that signs/verifies session and OAuth-state cookies — the legacy
  // admin-credential-derived fallback was removed (it re-exposed the admin
  // password to offline brute force from any captured cookie; see src/auth.js).
  // Without the secret there is no safe way to run sessions, so instead of
  // degrading, present a clear misconfiguration message across the whole site.
  if (!env.SESSION_SECRET) {
    log.error("config.missing_session_secret", {});
    if (url.pathname.startsWith("/api/")) {
      return {
        response: jsonResponse({ error: "Server not configured: SESSION_SECRET is missing." }, 503),
      };
    }
    return { response: htmlResponse(configErrorPage(), 503) };
  }

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

/**
 * Routing behind the identity gate: logout, then the terms and approval
 * gates (in that order), then the API/admin/asset handlers.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @returns {Promise<Response>}
 */
async function routeAuthed(request, env, url, log, identity, ctx, requestId) {
  if (url.pathname === "/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/login", "Set-Cookie": clearSessionCookie() },
    });
  }

  // ---- terms gate, then approval gate (order is load-bearing) ------------
  const termsResponse = await termsGate(request, env, url, identity);
  if (termsResponse) return termsResponse;

  // Approval gate: pending users are parked on the waiting page — no APIs,
  // no app, no admin — until the admin flips them to active. The page
  // auto-refreshes, so approval takes effect without a re-login.
  if (identity.pending) {
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Your account is awaiting approval.", pending: true }, 403);
    }
    return htmlResponse(pendingPage(identity), 200);
  }

  const apiResponse = await routeApi(request, env, url, log, identity, ctx, requestId);
  if (apiResponse) return apiResponse;

  // ---- admin-only: the JSON API and the admin UI assets ------------------
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

/**
 * Terms gate: every account must accept the terms of use once, right
 * after first sign-in — before the approval wait, the app, or any API.
 * The break-glass identity has no user row to record acceptance on and
 * is exempt (it's the operator). /build/ (About) and /story/ (build
 * history) stay readable pre-acceptance so the full text the terms
 * summarize is one tap away, and /logout is handled before this gate.
 * Static assets (js/css/vendor/markdown files, matched by file extension)
 * always pass through — they're inert code, not gated content, and
 * /build/ + /story/ need their own scripts and history.md to render.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Identity} identity
 * @returns {Promise<Response | null>} null when the gate lets the request through
 */
async function termsGate(request, env, url, identity) {
  if (!identity.user || identity.user.terms_accepted_at) return null;

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

/**
 * The signed-in (non-admin-gated) API surface, one route per handler
 * module. Returns null when nothing matched, so routeAuthed can continue
 * to the admin routes and the asset fallback.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @returns {Promise<Response | null>}
 */
async function routeApi(request, env, url, log, identity, ctx, requestId) {
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
  // Feedback mode (src/feedback.js): the user's own feedback entries and
  // their dialogue threads with the development agent.
  if (url.pathname === "/api/feedback" || url.pathname.startsWith("/api/feedback/")) {
    return handleFeedbackApi(request, env, url, log, identity);
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
  // The secret-keyed project vault (src/vault.js): client-encrypted project
  // archives under a user-held secret the server never sees. Deliberately
  // NOT knob-gated — each store is its own explicit consent, and the blob
  // is ciphertext only.
  if (url.pathname.startsWith("/api/vault/")) {
    return handleVault(request, env, url, log, identity);
  }
  // The games subsystem (src/games.js): GET /api/games lists the shelf the
  // account panel renders; /api/games/<id>/* dispatches to the registered
  // game's own API (Tokemon: src/tokemon-api.js, core in src/tokemon.js).
  if (url.pathname === "/api/games" || url.pathname.startsWith("/api/games/")) {
    return handleGames(request, env, url, log, identity);
  }
  if (url.pathname === "/api/client-error" && request.method === "POST") {
    return handleClientError(request, log, identity);
  }
  return null;
}

/**
 * @param {string} html
 * @param {number} status
 * @returns {Response}
 */
function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Master switch for the Content-Security-Policy header (below). CSP is the
// strongest defense here but the most brittle while the integrations are still
// in flux — a single missed subresource host silently breaks a feature (e.g.
// Maps/Street View), so it stays OFF until that surface stabilizes. Flip to
// `true` to enforce; when doing so, re-verify the script-src hashes and the
// Maps/*.googleapis/*.gstatic origins against a live page (watch the browser
// console for CSP violations). Every OTHER security header below is safe and
// stays on unconditionally regardless of this flag.
const CSP_ENABLED = false;

// Content-Security-Policy for every response. The app renders untrusted LLM
// output and third-party web-search content into the DOM, so this is the
// second line of defense behind DOMPurify (markdown.js): even a sanitizer
// bypass or a tampered vendored purify.min.js cannot execute injected script
// under this policy. Currently gated OFF by CSP_ENABLED above.
//
// script-src is a strict allowlist — 'self' (the ES-module app + vendored
// libs), the two Google Maps hosts (the Street View SDK, loaded on demand),
// and the sha256 hashes of the ONLY two inline scripts in the whole surface:
// index.html's non-module boot guard and story/index.html's inline module.
// There is NO 'unsafe-inline' and NO 'unsafe-eval', so injected inline
// <script> / on*= handlers do not run. If either inline script is edited,
// recompute its hash (the boot guard only loses its safety net on a mismatch;
// the core app is external modules and is unaffected):
//   node -e 'const c=require("crypto"),h=require("fs").readFileSync("public/index.html","utf8").match(/<script>([\s\S]*?)<\/script>/)[1];console.log("sha256-"+c.createHash("sha256").update(h).digest("base64"))'
// Maps pulls tiles/styles/XHR from *.googleapis.com / *.gstatic.com; if any
// Maps subresource is ever blocked, renderStreetViewEmbed already fails soft
// to the keyless google.com Embed iframe (frame-src), so Street View degrades
// rather than breaking. img-src stays broad (data:/blob:/https:) for user
// uploads, server data-URL frames, and Maps imagery.
const BOOT_GUARD_HASH = "'sha256-w5cPLY1sDxZyXuQvRq2aJ4i2L1jyBf4ulNgTL0pzf10='";
const STORY_INLINE_HASH = "'sha256-ATMgXgI8+2fgznyrbCNX5n9ZAqIHL8/YoN64WD6CwlI='";
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' https://maps.googleapis.com https://maps.gstatic.com ${BOOT_GUARD_HASH} ${STORY_INLINE_HASH}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://*.googleapis.com https://*.gstatic.com",
  "frame-src https://www.google.com",
  "upgrade-insecure-requests",
].join("; ");

// Applied to every response (see below). frame-ancestors (CSP) plus
// X-Frame-Options both block clickjacking of the authenticated app; nosniff
// stops MIME confusion on served/stored content; HSTS pins HTTPS; the
// Referrer-Policy / COOP / Permissions-Policy lines minimize leakage and
// cross-window/API exposure. All are static and carry no breakage risk.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  // geolocation=(self): the Tokemon game (/games/tokemon/) walks the map by
  // real GPS position; everything else stays denied.
  "permissions-policy": "geolocation=(self), microphone=(), camera=(), payment=()",
};

// Every response carries x-request-id so a user report can be correlated
// with the matching log entries, plus the site-wide security headers. Clone
// first: asset responses are immutable.
/**
 * @param {Response} response
 * @param {string} requestId
 * @returns {Response}
 */
function withRequestId(response, requestId) {
  const out = new Response(response.body, response);
  out.headers.set("x-request-id", requestId);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // Don't clobber a header a handler set deliberately (none set these today).
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  // CSP is opt-in (see CSP_ENABLED) — off while integrations are in flux.
  if (CSP_ENABLED && !out.headers.has("content-security-policy")) {
    out.headers.set("content-security-policy", CSP);
  }
  return out;
}
