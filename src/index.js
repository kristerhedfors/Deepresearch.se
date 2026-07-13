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
//   src/assets.js    — static-asset serving + the public (no-auth) allowlist
//   src/security-headers.js — site-wide security headers + CSP policy

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
  handleClientLog,
  handleHistoryKey,
  handleMe,
  handleMessages,
  handleModels,
} from "./user-api.js";
import { handleFeedbackApi } from "./feedback.js";
import { handleTryRedirect } from "./testpoints.js";
import { bashLiteEnabled, handleSettingsGet, handleSettingsPut } from "./settings.js";
import { handleBashStep } from "./bash-api.js";
import { handleStorage } from "./storage.js";
import { handleVault } from "./vault.js";
import { handleEmbed, handleRag } from "./rag.js";
import { handleQuizGrade } from "./quiz-api.js";
import { handleGames } from "./games.js";
import { handlePubGet, handlePubWrite } from "./pub.js";
import { getConfig } from "./config.js";
import { isPublicAsset, serveAsset } from "./assets.js";
import { applySecurityHeaders } from "./security-headers.js";

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
      host: url.host,
    });

    try {
      const { response, identity } = await route(request, env, url, log, ctx, requestId);
      // Note: for /api/chat this marks headers-sent; the end of the SSE
      // stream is logged separately as chat.complete.
      log.info("request.complete", {
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      const out = applySecurityHeaders(response, requestId);
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
      return applySecurityHeaders(
        jsonResponse({ error: "Internal server error.", request_id: requestId }, 500),
        requestId,
      );
    }
  },
};

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
  // Canonical origin. The Worker is routed on BOTH the apex and www
  // (wrangler.toml: deepresearch.se + www.deepresearch.se) AND — because
  // run_worker_first serves the Worker before any edge "Always Use HTTPS"
  // rule — it can be reached over plain http too. The whole app must live on
  // ONE origin: https://<apex>. Google OAuth's redirect_uri is registered only
  // for the https apex, so a request arriving on www OR over http builds a
  // redirect_uri Google rejects — "Error 400: redirect_uri_mismatch", hit
  // signing in from Firefox Focus, which (unlike Chrome/Safari) wipes its HSTS
  // memory every session and doesn't silently upgrade the first request to
  // https, so the bare-domain hit lands on http and the OAuth start builds an
  // http:// redirect_uri. (The site DOES send HSTS, but a browser only honors
  // it over https and only after a prior visit — which Focus discards — so the
  // server-side redirect is what actually protects that first hit.) Pinning
  // only the redirect_uri would split the CSRF state cookie across origins, so
  // canonicalize FIRST: 301 any non-canonical host/scheme → https apex,
  // preserving path + query, so the whole flow (state cookie, redirect_uri,
  // callback, session) stays on the one registered origin.
  if (url.protocol !== "https:" || url.hostname.startsWith("www.")) {
    const canonical = new URL(url.toString());
    canonical.protocol = "https:";
    if (canonical.hostname.startsWith("www.")) {
      canonical.hostname = canonical.hostname.slice("www.".length);
    }
    return { response: new Response(null, { status: 301, headers: { Location: canonical.toString() } }) };
  }

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

  // ---- the wordplay URL map (all BEFORE the identity gate) -----------------
  // The .se domain completes English words, and the two product tiers live
  // under them:
  //   DeepResearch.Se/cure — DRC, "deep research SECURE" (C = CLIENT-side):
  //       the public tier. Minimal server involvement by DESIGN: this
  //       Worker serves the static page and the public replay JSONs, and
  //       nothing else — model calls go browser→provider directly, storage
  //       is browser-local (public/cure/, public/js/drc-*.js). The root /
  //       redirects here; /my/project-<hash> reopens a browser-local saved
  //       project; /cure/<slug> is a published frozen replay (src/pub.js +
  //       the publish-research skill), continue-able in place.
  //   DeepResearch.Se/rver — DRS, "deep research SERVER" (R = REMOTE, as in
  //       a remote cloud-server): the signed-in tier with the hosted
  //       pipeline, web search, accounts, and cloud storage (handled in
  //       routeAuthed; unauthenticated visitors get the login page).
  // /free and /free/project-… are legacy aliases from DRC's free-mode era.
  // The root is the FRONT DOOR for visitors: it forwards to the client-side
  // Se/cure tier (/cure — the umbrella intro + chat), NOT the old promotional
  // landing (public/welcome/, retired as the front door but still reachable by
  // direct URL). Signed-in arrivals are forwarded to DRS (/rver) below.
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    (url.pathname === "/cure" ||
      /^\/cure\/[a-z0-9-]*$/.test(url.pathname) ||
      url.pathname === "/my" ||
      url.pathname === "/my/" ||
      url.pathname.startsWith("/my/project-") ||
      url.pathname === "/free" ||
      url.pathname === "/free/" ||
      url.pathname.startsWith("/free/project-"))
  ) {
    // The DRC page is served cross-origin isolated (COEP) so its client-side
    // execution sandbox (the experimental bash-lite tier) can boot CheerpX.
    // DRC's knob is browser-local (no server-side account to read here), and
    // the khaki page is self-contained — no cross-origin iframe to break — so
    // isolation is safe to apply unconditionally.
    return { response: await serveAsset(request, env, url.origin + "/cure/", { coep: true }) };
  }
  if (request.method === "GET" && (url.pathname === "/api/pub" || url.pathname.startsWith("/api/pub/"))) {
    const slug = url.pathname === "/api/pub" ? null : decodeURIComponent(url.pathname.slice("/api/pub/".length));
    return { response: await handlePubGet(env, slug) };
  }
  // The intro-animation speed knob (site config `anim_speed`, the admin
  // slider in /admin): public because the /cure first-visit intro reads it
  // before any identity exists. Presentation config only — one number,
  // browser-cacheable for a minute, so a slider change propagates within
  // ~90 s (this cache + the ~30 s config cache).
  if (request.method === "GET" && url.pathname === "/api/anim") {
    const cfg = await getConfig(env);
    return {
      response: jsonResponse({ speed: cfg.anim_speed }, 200, { "cache-control": "public, max-age=60" }),
    };
  }

  // ---- unauthenticated: sign-in surface -----------------------------------
  if (url.pathname === "/login" && request.method === "GET") {
    return { response: htmlResponse(loginPage(url.searchParams.get("flash") || ""), 200) };
  }
  if (url.pathname === "/auth/google" && request.method === "GET") {
    return { response: await handleGoogleStart(request, env, url, log) };
  }
  if (url.pathname === "/auth/google/callback" && request.method === "GET") {
    return { response: await handleGoogleCallback(request, env, url, log) };
  }

  // ---- everything else requires an identity ------------------------------
  const identity = await identify(request, env);
  if (!identity) {
    // Visitors hitting the root land on the client-side Se/cure tier — the
    // umbrella intro + chat — the front door for everyone not signed in.
    // (The old promotional landing at /welcome is retired as the front door
    // but still reachable by direct URL.)
    if (url.pathname === "/" && request.method === "GET") {
      return {
        response: new Response(null, { status: 302, headers: { Location: "/cure" } }),
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
      return new Response(null, { status: 302, headers: { Location: "/rver" } });
    }
    return serveAsset(request, env);
  }

  // Publishing (PUT/DELETE /api/pub/:slug) is the ONE write surface of the
  // published-replays feature — admin only (the public reads are routed
  // before the identity gate).
  if (url.pathname.startsWith("/api/pub/")) {
    if (identity.role !== "admin") return jsonResponse({ error: "Admin access required." }, 403);
    return handlePubWrite(request, env, log, decodeURIComponent(url.pathname.slice("/api/pub/".length)));
  }

  // /try/:id — the shareable deep link to a testable interaction point
  // (src/testpoints.js). Resolves the point's target and 302s there with
  // ?try=<id> merged, so the landing page's client shows the try-it banner.
  // Admin-gated inside the handler; a stale/missing link falls back to /rver.
  const tryMatch = url.pathname.match(/^\/try\/(\d+)$/);
  if (tryMatch && request.method === "GET") {
    return handleTryRedirect(env, Number(tryMatch[1]), identity);
  }

  // The signed-in app — DRS, "deep research SERVER" — lives at /rver (the
  // URL wordplay above): serve the app shell there. A signed-in arrival at
  // the root is forwarded home (the landing is for visitors).
  //
  // When this account has the experimental bash-lite sandbox on, the app
  // shell (and its assets) are served cross-origin isolated (COEP) so CheerpX
  // can boot; off (the default) they are served exactly as before, so the
  // Street View keyless-iframe fallback is untouched for everyone else.
  const coep = bashLiteEnabled(env, identity);
  if ((url.pathname === "/rver" || url.pathname === "/rver/") && request.method === "GET") {
    return serveAsset(request, env, url.origin + "/", { coep });
  }
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(null, { status: 302, headers: { Location: "/rver" } });
  }

  return serveAsset(request, env, null, { coep });
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
    return new Response(null, { status: 303, headers: { Location: "/rver" } });
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
  // One turn of the experimental bash-lite agent loop (src/bash-api.js): the
  // browser-orchestrated in-browser Linux sandbox asks what command to run
  // next. Knob-gated inside the handler (bash_lite_mcp).
  if (url.pathname === "/api/bash/step" && request.method === "POST") {
    return handleBashStep(request, env, log, identity);
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
  // Client telemetry beacon — first user is the in-browser sandbox filesystem
  // integration (public/js/sandbox.js), whose boot/mount/seed events run
  // client-side and reach Workers Logs only through this. See handleClientLog.
  if (url.pathname === "/api/client-log" && request.method === "POST") {
    return handleClientLog(request, log, identity);
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
