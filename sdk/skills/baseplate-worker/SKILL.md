---
name: baseplate-worker
description: >-
  Load when building or modifying the platform's ONE server component — the edge
  worker skeleton: the hand-rolled routing table, static-asset serving and
  the public allowlist, the single security-header wrap point, the
  canonical-origin redirect, optional-D1 with lazy schema, the cached config
  table, the structured JSON logger, the http response helpers (incl. the
  ?format=text convention), the node:test + zero-build typecheck harness,
  wrangler.toml, and the two deploy paths. Also load when a request "isn't
  routed", headers are missing on some response, or the worker must run
  without a database binding.
---

# Baseplate worker — the one server component

The server tier is exactly one deployable: an edge worker (Cloudflare Workers
in the reference) that fronts EVERY request — static assets included — and
owns routing, identity gating, headers, logging, and the optional persistence
bindings. This skill builds that skeleton from scratch: a worker that serves
the client shell, applies one security-header function to every response,
degrades gracefully with no database, and carries a Node-native test harness
with zero build steps. Everything else in the server tier (identity, quotas,
pipeline, storage) plugs into the seams this module creates.

## Capability class & tier story

Manifest class: **S — server-backed.** This module IS the one server the
zero-or-one-server property permits.

- **Server tier**: the worker is its entire backend — one routing table, one
  header function, one identity gate (added by `identity-access`), one module
  graph an auditor can read end to end.
- **Client tier**: the worker's only roles are static file host and public
  read-only JSON — the client tier must stay fully functional if the worker
  is replaced by ANY static host. Concretely: the client tier's pages and
  modules live on the public allowlist, are served without auth, and nothing
  in their module graph calls an authenticated endpoint.

## Contracts

- **PA-2** — the skeleton sets the fail-soft posture: handlers degrade
  (config falls back to defaults, features vanish without their binding)
  rather than erroring the request; the top-level catch converts any escape
  into a clean 500 JSON with the request id.
- **PA-4** — the logger's privacy rules are baked in at the foundation: never
  secrets, never chat content; info-and-above carries counts/durations/
  statuses only; user text at debug level at most.
- **PA-5** — no build step (the worker deploys as plain source), no router
  framework, dev-only dependencies limited to the typechecker; the roadmap's
  library verdicts (Hono: **skip** — "the hand-rolled router is small,
  readable, and correct; a framework tidies syntax and buys nothing") are the
  standing precedent.
- **PA-9** — the optional-binding pattern is fail-soft for *features* but the
  skeleton must leave room for fail-SAFE meters: anything spending money on a
  missing backend returns 503, never an unmetered success (enforced by the
  grant modules, enabled by the `getDb`-returns-null convention here).
- **PA-10** — `x-request-id` on every response + structured request logs are
  what make live verification and user-report correlation possible at all.

## Build plan

1. **`wrangler.toml`** (or platform equivalent): `name` (MUST match the
   dashboard worker or deploys land on an unmapped worker), `main =
   "src/index.js"` (a `main` is also what unlocks secrets — assets-only
   workers can't hold them), `compatibility_date`, `routes` for the apex AND
   www custom domains, `[assets] directory = "./public"`, `binding =
   "ASSETS"`, **`run_worker_first = true`** (the worker sees every request,
   so the future auth gate covers static assets too), `[observability]
   enabled = true`, `[vars] LOG_LEVEL = "info"`. Add resource bindings (D1,
   R2) only AFTER the resources exist — a binding to a missing resource
   fails every deploy outright. Secrets are set in the dashboard/CLI, never
   in the file.
2. **`package.json`** — private, `"type": "module"`, scripts `test` (`node
   --test src/*.test.js public/js/*.test.js`) and `typecheck` (`tsc --noEmit`
   twice: a Workers-types `tsconfig.json` for `src/`, a DOM-lib
   `tsconfig.public.json` for `public/`), devDependencies `typescript` +
   `@cloudflare/workers-types` ONLY. The package exists solely to run tests
   and the typechecker; deploy reads the source directly. Type-checking is
   opt-in per file via `// @ts-check` — types without a build step.
3. **`src/http.js`** — the response-helper leaf every module shares:
   `jsonResponse(obj, status, extraHeaders)`, `htmlResponse`, `sseResponse`
   (content-type `text/event-stream`, `cache-control: no-cache,
   no-transform`), and `textResponse` — the `?format=text` plain-text
   renderer. Codify the convention now: any admin/loop-readable list endpoint
   accepts `?format=text` and returns a plain rendering an agent CLI can
   consume without JSON plumbing.
4. **`src/log.js`** — the structured JSON logger: one JSON object per line
   (`{time, level, event, ...base, ...fields}`), levels debug<info<warn<error
   thresholded by the `LOG_LEVEL` var, `createLogger(env, base)` returning
   `{debug,info,warn,error}`. Write the privacy rules into the module
   comment; they are enforced by convention at every call site, so they must
   be WHERE call sites are written.
5. **`src/canonical.js`** — the canonical-origin redirect as a **pure leaf**
   (imports nothing): `canonicalRedirect(url)` returns a 301 to the https
   apex for any non-https or www arrival, preserving path + query, else
   null. Called FIRST in routing, before anything else. Register OAuth
   redirect URIs for the https apex only; this function is what makes that
   safe (see Pitfalls).
6. **`src/security-headers.js`** — the header policy module:
   `applySecurityHeaders(response, requestId)` is the ONE function the
   entrypoint wraps every response with. Clone the response first (asset
   responses are immutable), set `x-request-id`, apply the static header set
   (`nosniff`, `x-frame-options: DENY`, referrer-policy, HSTS, COOP
   `same-origin`, a minimal permissions-policy) without clobbering headers a
   handler set deliberately, and keep the CSP behind a module-level
   `CSP_ENABLED` switch with the full policy already written (strict
   script-src allowlist, hashes for the few inline scripts, no
   unsafe-inline/eval). Export `_internals` so the unit suite asserts the
   policy shape without a live Response.
7. **`src/assets.js`** — static serving + the public allowlist, split OUT of
   the router: `isPublicAsset(url, method)` (GET/HEAD only; icons + manifest
   + the client tier's whole public module graph, each entry with a comment
   saying WHY it is public) and `serveAsset(request, env, overrideUrl?,
   opts?)` via `env.ASSETS.fetch()` with an EXPLICIT cache policy:
   `no-cache` (store-but-revalidate; strong etags make it a cheap 304) for
   js/css/html/md/json/webmanifest and extensionless HTML routes, a short
   real TTL for icons/media only. Support an override URL (serve `/` content
   for a tier path) and dynamic response headers (the reference's COEP shell
   — which must be `no-store` with conditional headers stripped, see
   Pitfalls).
8. **`src/db.js`** — optional D1 + lazy schema: `getDb(env)` returns null
   when the binding is absent, and NOTHING may throw because of that —
   every feature keyed on the DB degrades (no accounts, no quotas, admin
   break-glass only). Schema is a single idempotent `CREATE TABLE IF NOT
   EXISTS …` block applied lazily once per isolate — no migration step to
   operate.
9. **`src/config.js`** — global site config: one JSON row in the D1 `config`
   table, admin-edited, merged over in-code defaults, cached ~30 s per
   isolate. Without a DB the defaults apply. Every tunable a panel will ever
   edit goes through this — never a redeploy for a number.
10. **`src/index.js`** — the entrypoint and the hand-rolled routing table (no
    framework — the roadmap §7 verdict). `fetch(request, env, ctx)`:
    generate `crypto.randomUUID()` as the request id, build the logger with
    `{request_id, method, path, host}`, call `route()`, log
    `request.complete` with status + duration, wrap the result in
    `applySecurityHeaders`, and catch everything into a logged 500. `route()`
    in load-bearing order: (a) `canonicalRedirect` FIRST; (b) hard-config
    sanity (missing root secret ⇒ a clear 503 misconfiguration page, fail
    closed — never a degraded session scheme); (c) `isPublicAsset` →
    `serveAsset`; (d) the client tier's page routes and public JSON; (e) the
    unauthenticated sign-in surface; (f) the identity gate — everything
    below it authed (the gate itself arrives with `identity-access`; the
    skeleton stubs it as "serve the shell"); (g) one `if (path === … &&
    method === …) return handler(…)` line per endpoint, each handler in its
    own module; (h) the asset fallback. Keep index.js about ROUTING — any
    logic beyond match-and-dispatch moves to a module.
11. **Tests** — `src/assets.test.js` (allowlist membership, cache policy per
    extension class, and — as soon as the client tier exists — the derived
    module-graph walk from `pair-architecture`), `src/security-headers.test.js`
    (the header set + CSP shape via `_internals`), `src/canonical.test.js`
    (scheme/www normalization, path+query preserved, https-apex passthrough),
    plus per-module suites as handlers land. All `node:test` +
    `node:assert/strict` — no test framework dependency.
12. **Deploy** — wire BOTH paths: git-connected auto-deploy (push to `main` →
    build → deploy) as the routine path, and direct `npx wrangler deploy` for
    immediate pushes (knowing the API token may not be able to update routes
    or zone settings — verify what's live with a probe, not an assumption).
    Verify a deploy with `curl -sI https://<apex>/` checking `x-request-id`
    and the security headers.

## Reference implementation map

| Concept | Reference file(s) |
|---|---|
| Entrypoint, request id, routing table, gate ordering | `src/index.js` |
| Static serving + public allowlist + cache policy + COEP shell | `src/assets.js` (+ `src/assets.test.js`) |
| One-function security headers + gated CSP | `src/security-headers.js` |
| Canonical-origin 301 (pure leaf) | `src/canonical.js` |
| Optional D1 + lazy idempotent schema | `src/db.js` |
| Cached admin-edited site config | `src/config.js` |
| Structured JSON logger + privacy rules | `src/log.js` |
| Response helpers incl. `?format=text` | `src/http.js` |
| Worker config: assets binding, run_worker_first, limits, bindings | `wrangler.toml` |
| Test/typecheck harness, zero-build stance | `package.json`, `tsconfig.json`, `tsconfig.public.json` |
| Deploy paths + verification | `.claude/skills/deploy/SKILL.md`, `docs/ARCHITECTURE.md` §2 |
| Request lifecycle & auth ordering (the fuller picture) | `docs/ARCHITECTURE.md` §3 |

## Acceptance checklist

- [ ] `npm test` green on the skeleton (assets, security-headers, canonical,
      http/logger suites) and `npm run typecheck` clean for both configs.
- [ ] The worker serves the client shell at the tier path and the root
      redirect behaves per the platform's routing plan.
- [ ] Live probe: every response — including static assets and error paths —
      carries `x-request-id` and the full static header set (`curl -sI` the
      root, an asset, a 404, and an `/api/*` 401).
- [ ] Live probe: `http://` and `www.` arrivals 301 to the https apex with
      path and query preserved.
- [ ] The worker runs with NO D1 binding: no throw, features degrade, and any
      money-spending endpoint that needs the meter returns 503 (PA-9).
- [ ] Cache policy verified: `cache-control: no-cache` on js/css/html/json,
      real TTL only on icons/media; any dynamically-headered shell is
      `no-store`.
- [ ] A deliberate unlisted import into the client tier's public graph fails
      `npm test` by name (the derived-graph test wired).

## Pitfalls

- **The canonical-origin story (why step 5 exists).** The reference's OAuth
  broke ONLY in Firefox Focus: Focus wipes HSTS memory every session and
  doesn't upgrade the first request, so a bare-domain visit arrived over
  http, the OAuth start built an `http://` redirect_uri, and Google rejected
  it (`redirect_uri_mismatch`). HSTS cannot protect a first hit; pinning only
  the redirect_uri would split the CSRF state cookie across origins. The fix
  is the server-side 301 to ONE canonical origin, before anything else.
- **Headers in ONE function, and clone first.** Scattered per-handler headers
  drift; the reference funnels every response through `applySecurityHeaders`
  — and clones, because asset responses are immutable and mutating them
  throws. Don't clobber deliberately-set handler headers.
- **The public-allowlist discipline.** `run_worker_first` means auth covers
  assets — good — but every module the client tier's page imports must then
  be allowlisted or the tier dies silently (four reference incidents; the
  derived-graph test is the cure). Every allowlist entry carries a comment
  saying why it is safe to serve unauthenticated.
- **Optional-D1 is a posture, not a nil-check.** "Nothing may throw because
  DB is absent" is a rule for EVERY module that touches persistence, set
  here: `getDb` returns null, callers degrade. The one inversion is PA-9 —
  meters fail safe (503), never soft.
- **Bindings before resources = broken deploys.** Declaring a D1/R2/Vectorize
  binding (or a paid-plan `[limits]` block) before the resource/plan exists
  fails EVERY deploy outright — a hard API rejection, not a no-op (the
  reference hit this twice: the Free-plan `cpu_ms` rejection and the
  bindings-before-buckets rule).
- **No native auth challenge, ever.** Installed PWAs cannot show the Basic
  Auth dialog (black screen on iOS). Unauthenticated HTML navigation gets a
  sign-in PAGE; unauthenticated `/api/*` gets a 401 JSON body; no
  `WWW-Authenticate` header is emitted.
- **The 304-drops-dynamic-headers trap.** A shell whose headers vary by user
  state (the reference's COEP isolation) must be served as a fresh 200 with
  `no-store` and the request's conditional headers stripped — a `no-cache`
  revalidation returns 304 and the browser reuses the stored response
  WITHOUT the dynamic header, silently disabling the feature.
- **Heuristic caching kills no-build clients.** Without an explicit policy,
  browsers heuristically cache the ~20 unversioned ES modules and link a
  MIXED old/new graph after multi-deploy days (reference incident
  2026-07-08: "no queries work"). `no-cache` + strong etags is the fix;
  don't regress it for a latency hunch.
- **`name` mismatch = deploy to nowhere.** If wrangler.toml's `name` differs
  from the dashboard worker, deploys succeed onto a worker the domain isn't
  mapped to. Verify what's LIVE (build stamp, header probe), not what the
  CLI said.
