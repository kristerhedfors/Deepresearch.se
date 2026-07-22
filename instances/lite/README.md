# DeepResearch Lite — a distilled instance

A **second, self-contained instance** of the DeepResearch assistant, rebuilt
**bottom-up** using [DistillSDK](../../sdk/) as the method and the deployed
**Se/cure** tier as the archetype. It is a minimal deep-research chat: ask a
question, the server runs a deterministic *triage → web search → synthesis*
pipeline and streams a cited answer.

This folder depends on **zero** parent-repo code. It is its own Cloudflare
Worker with its own `wrangler.toml`, its own client, and its own tests.

> Status: **experimental**. This is a distillation exercise — a working vertical
> slice, not a production product. It deliberately omits most of the parent's
> surface (cloud storage, RAG, projects, sandbox, MCP, admin, quotas).

## What it is (and what it distills)

| Parent capability | Here |
|---|---|
| Deterministic pipeline, no function calling (PA-1) | ✅ triage (JSON) → search → synthesis (stream) |
| Helper phases fail soft (PA-2) | ✅ triage/search degrade; the chat never errors |
| Split model routing (PA-3) | ✅ triage on a fixed JSON model, synthesis on the answer model |
| The privacy split (PA-4) | ✅ secrets server-side only; outbound carries only the query; nothing sensitive logged |
| Minimal deps, no build step (PA-5) | ✅ zero runtime deps; plain-source deploy |
| EN + SV parity in deterministic gates (PA-6) | ✅ the smalltalk gate + parity test |
| Same authentication mechanism | ✅ see below |

## Same authentication mechanism ("stay behind the same auth")

The instance re-implements the parent's identity-access mechanism **exactly**:

- Session cookie `dr_session = u.<uid>.<exp>.<hex(HMAC-SHA-256(SESSION_SECRET, "<uid>.<exp>"))>`.
- Google OIDC sign-in (no SDK): `/auth/login` → consent → `/auth/callback`,
  validating the ID-token claims (`iss` / `aud` / `exp` / `email_verified`).
- Break-glass HTTP Basic via `ADMIN_USER`/`ADMIN_PASS`.
- `SESSION_SECRET` is the **sole** key — no fallback; unset ⇒ a config-error
  page (fail closed).

Because it signs and verifies with the **same `SESSION_SECRET`** and the same
cookie format, **a visitor already signed in to the main site is signed in here
too** when this instance is served on the same registrable domain. That is the
"same auth" property: shared mechanism, shared secret, shared session — no new
login. `src/hmac.test.js` pins byte-identical cookie tags against an independent
HMAC so this can't silently drift.

## The only external dependencies (the "very specific exceptions")

No npm runtime dependencies and no build step. The instance talks to exactly
three external services, each a deliberate exception:

1. **Berget.ai** — the LLM provider (OpenAI-compatible). `BERGET_API_TOKEN`.
2. **Exa** — web search. `EXA_API_KEY`. (Set `SEARCH_ENABLED=false` to run
   search-free — the pipeline then answers directly.)
3. **Google** — the OIDC identity provider (the auth *mechanism* above).
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Everything else — the pipeline, the validator, the crypto, the SSE transport,
the markdown renderer, the client — is written from scratch in this folder.

## Layout

```
src/
  index.js      entrypoint: canonical → public surface → identity gate → authed routes
  http.js       response helpers (json/html/sse/text)
  log.js        structured JSON logger (with the privacy rules at the call sites)
  hmac.js       HMAC primitives (namespaced sign/verify over SESSION_SECRET)
  auth.js       identify() + the session cookie (parent-compatible)
  google.js     Google OIDC start/callback, no SDK
  config.js     model routing + search toggle
  berget.js     the LLM client (JSON completion + streamed completion)
  exa.js        the web-search client (query-only outbound)
  schema.js     the never-throw combinator validator
  triage.js     triage schema + the model-free normalizer + the EN/SV smalltalk gate
  prompts.js    pure prompt builders (anti-injection on triage AND synthesis)
  pipeline.js   the deterministic orchestrator (SSE), deps injectable for tests
public/
  index.html    the app shell (markup only)
  css/app.css    one stylesheet, palette in :root custom properties
  js/sse.js      the pure SSE line-buffer parser
  js/markdown.js sanitized, escape-first markdown (no vendored libs)
  js/app.js      DOM glue (imports only the pure modules)
```

## Run & try it out

```bash
cd instances/lite
npm install                 # dev-only: wrangler, typescript, workers-types
npm test                    # 61 unit tests, zero deps beyond Node
npm run typecheck           # tsc over the @ts-check'd source

# set the secrets (reuse the parent's values to share sign-in)
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put BERGET_API_TOKEN
npx wrangler secret put EXA_API_KEY
# optional break-glass:
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASS

npm run dev                 # local: http://127.0.0.1:8787
npm run deploy              # to Cloudflare (register /auth/callback as an OIDC redirect URI)
```

To keep it strictly behind the main site's sign-in, deploy it on the same
registrable domain (e.g. a route or subdomain) so the `dr_session` cookie is
shared, and register this worker's `/auth/callback` in the Google OAuth client.

## How the DistillSDK workflow went (build notes)

Built by following `node sdk/pair-cli.mjs plan …` in dependency order:
`pair-architecture` (contracts) → `baseplate-worker` → `baseplate-client` →
`provider-registry` → `research-pipeline` → `web-search` → `identity-access`.

- The SDK's **plan** command gave a correct, dependency-ordered build list and
  per-module acceptance criteria out of the box — a genuinely usable spine.
- The **PA-1..PA-10 contracts** translated cleanly into concrete code shapes
  (deterministic orchestration, fail-soft helpers, split routing, the
  namespaced-HMAC identity leaf, EN/SV parity). Each contract maps to a real
  test here rather than a comment.
- The **skills' "Build plan" + "done when"** sections were specific enough to
  implement against directly (e.g. the exact session-cookie format, the
  escape-first markdown rule, the pure SSE parser as the smallest shared-core
  exemplar).
- What the SDK does **not** hand you is the parent's exact wire details
  (Berget/Exa endpoints, the cookie's precise HMAC message) — those still come
  from reading the reference implementation. Reproducing the cookie construction
  byte-for-byte (verified by test) is what makes "same auth" real rather than
  aspirational.
