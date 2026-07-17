# DeepResearch.se

**Innovation and research into the privacy capabilities of LLM
applications** — how far a real, useful research assistant can be pushed
toward *provable* privacy, and where that trades against capability. The
proof is the site itself: a fully open-sourced, independently verifiable
pair — **DeepResearch.Se/cure**, the public client-side tier where the
research runs entirely in the browser and the server is absent from every
data path, and **DeepResearch.Se/rver**, the signed-in tier where a server
buys capability and protects what it handles with encryption and policy.
Still experimental and nowhere near production-ready; MIT-licensed, so every
privacy claim is yours to verify. The `/architecture/` page visualizes the
trade.

A first-class part of that security story, stated up front: the live site —
the **Se/cure** tier included — is deployed on Cloudflare and served
directly from this GitHub repository (git-connected: a push to `main` is
what production runs). That serving chain is what makes the claims
independently verifiable, and it is also the trust boundary. So to make it
really secure, build upon it: the point of the project is for anyone to
fork this architecture and deploy it for their own use case, ideally in an
environment that is already network- and authentication-restricted — the
"Installing your own instance" section below is the complete walkthrough.
What the architecture provides is an easily extendable platform with some
peculiar features (a browser-side research pipeline, sealed browser-local
state, lendable capability grants, an in-browser Linux VM), and those
features are the subject of the exploration in this research and innovation
project.

The **Se/rver** tier is a deep-research AI assistant on Cloudflare Workers: a
static chat UI plus a streaming `/api/chat` endpoint that runs a
Worker-orchestrated research pipeline (triage → search waves → gap check →
cited synthesis → post-validation) with **no function calling** —
deterministic JSON-mode and streamed calls only. Berget.ai's EU-hosted, OpenAI-compatible models are the
primary LLM provider; Anthropic (`claude-*`) and OpenAI (`gpt-*`) are
optional, key-gated answer-model providers behind the `src/providers.js`
registry (the JSON planning phases always stay on Berget). Exa is the web
search; the Hugging Face Hub joins as an auxiliary search source, and opt-in
enrichments (Shodan host intelligence, Google Maps / Street View) feed the
pipeline context. Google sign-in gates the whole site; D1 stores accounts,
real-cost research quotas, the chat interaction log, and feedback threads;
opt-in R2 + Vectorize hold encrypted cloud history and document RAG; an
`/admin` console shows usage and approves users. The pipeline is also
exposed as an MCP tool (`POST /mcp`, `deep_research`).

```
browser / PWA / MCP client ── Google OIDC session ──> Worker (src/index.js)
    ├── static UI            public/ (env.ASSETS)
    ├── POST /api/chat       src/chat.js → src/pipeline.js
    │     ├── LLMs           src/providers.js → berget.js | anthropic.js | openai.js
    │     ├── web search     src/exa.js (+ src/search-sources.js: hf.js)
    │     └── enrichments    src/enrichment.js (shodan.js, maps-enrichment.js)
    ├── POST /mcp            src/mcp.js (deep_research tool)
    ├── /admin, /api/admin/* admin console (usage, users, chatlogs, feedback)
    ├── D1  (accounts, quotas, config, chat_logs, feedback, answer recovery, game saves)
    └── R2 + Vectorize (opt-in encrypted cloud history + document RAG)
```

See `docs/ARCHITECTURE.md` for the full design, `CLAUDE.md` for the code
layout and load-bearing invariants, and `.claude/skills/` for the
per-area working guides. The complete prompt-by-prompt build history — the
origin story of the first weekend, kept as the record of how it began —
lives in `public/build/history.md` (rendered in-app at `/story/`; `/build/`
holds the project purpose and EU AI Act use restrictions).

## The Agent-Pair SDK

The architecture is also distilled into a reusable form: the **Agent-Pair
SDK** (`sdk/`) — a design, a 33-module skill library, a machine-readable
module registry, and a dependency-free CLI for building **agent pairs** like
this one: one AI-assistant product shipped as a wholly-in-browser client tier
plus a one-edge-worker server tier, with at most one server component across
the whole pair. Every module maps back to the files in this repo that already
realize it, and carries the incident history that made those files what they
are. It is currently design + skill library only — nothing in `src/` or
`public/` imports it.

- **`docs/AGENT-PAIR-SDK.md`** — the complete standalone documentation: the
  pair abstraction, capability classes, contracts PA-1…PA-10, the full module
  catalog, the CLI, and the implementation order.
- `sdk/README.md` — the catalog front page; `sdk/DESIGN.md` the full design;
  `sdk/ROADMAP.md` the build-order rationale.
- `node sdk/pair-cli.mjs list|show|plan|validate` — explore the registry,
  compute a build order for a module selection, check manifest integrity.

## Installing your own instance

Everything below reproduces the production setup end-to-end. You need:

- A **Cloudflare account** and, optionally, a domain with its zone active
  in that account. Note: the committed `wrangler.toml` sets
  `[limits] cpu_ms = 300_000`, which requires the **Workers Paid** plan —
  on the Free plan the deploy API rejects it outright, so delete the
  `[limits]` block first.
- A **Berget.ai** account and API token — the primary LLM provider
  (OpenAI-compatible API, EU-hosted).
- An **Exa** API key — the web-search provider.
- A **Google Cloud project** for the OAuth sign-in client.
- Node.js with `npx` for wrangler (CLI deploys and local dev).

### 1. Clone and adapt `wrangler.toml`

```bash
git clone https://github.com/kristerhedfors/Deepresearch.se
cd Deepresearch.se
```

In `wrangler.toml`:

- `name` — must match the Worker's name in your Cloudflare dashboard
  exactly, or deploys land on a different Worker than your domain maps to.
- `routes` — replace the `deepresearch.se` custom-domain patterns with your
  own domain (the zone must be active in the same account; Cloudflare
  provisions DNS + TLS automatically), or delete the block to serve from
  `*.workers.dev`.
- Leave `[assets]` (`run_worker_first = true` is what lets the auth gate
  cover the static UI) and `[observability]` as they are.
- `[limits] cpu_ms = 300_000` — keep on Workers Paid, delete on Free (see
  above).
- The committed `[[r2_buckets]]` and `[[vectorize]]` blocks point at
  production resources — **delete them for now** (they make every deploy
  fail unless the named resources exist); step 7 recreates them.

### 2. Create the D1 database

```bash
npx wrangler d1 create deepresearch-se
```

Paste the printed `database_id` into the `[[d1_databases]]` block in
`wrangler.toml`. (Dashboard alternative: Storage & Databases → D1 → Create;
the full UUID is visible in the database page's URL.) The schema applies
itself on first use — there is no migration step.

Without the binding the Worker still runs, but degraded: Google sign-in
bounces with a clear message, no quotas — break-glass Basic Auth only.

### 3. First deploy (unlocks secrets)

An assets-only Worker has **no Variables & Secrets section** in the
dashboard — the `main` script must be deployed once before secrets can be
attached:

```bash
npx wrangler deploy
```

For continuous deploys, connect the repo to the Worker in the dashboard
(Workers & Pages → your Worker → Settings → Build) — every push to `main`
then auto-deploys, which is how production runs.

### 4. Google OAuth client

Follow `docs/GOOGLE-AUTH.md` §1 for the console walkthrough. In short:
OAuth consent screen (External, scopes `openid email profile` only,
**publish it** — Testing mode breaks for non-test users), then an OAuth
client ID of type Web application with the redirect URI
`https://<your-domain>/auth/google/callback` (exact match; add the `www`
variant if you serve it, and `http://127.0.0.1:8787/auth/google/callback`
for local dev). Copy the client ID and secret.

### 5. Secrets and variables

Set on the Worker (Settings → Variables and Secrets in the dashboard, or
`npx wrangler secret put <NAME>`). All are required:

| Secret | Purpose |
|---|---|
| `BERGET_API_TOKEN` | Berget.ai API auth (sent as `Authorization: Bearer`) |
| `EXA_API_KEY` | Exa web search (sent as `x-api-key`) |
| `SESSION_SECRET` | HMAC key for the session cookie and OAuth-state cookie — a high-entropy random string, `openssl rand -hex 32`. It is the **sole** signing key: there is no fallback. If it is unset the Worker has no signing key and serves a configuration-error page instead of running any auth flow keyless (an earlier admin-credential fallback was removed — it left every session cookie offline-brute-forceable against `ADMIN_PASS`). Rotating it invalidates every session. |
| `ADMIN_USER` / `ADMIN_PASS` | Break-glass Basic Auth (curl/scripts/emergencies) — the Worker **fails closed without them**. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | The OAuth client from step 4 |

Optional but recommended — enables encrypted, client-side chat history
(`GET /api/history-key`, `src/history-key.js`):

| Secret | Purpose |
|---|---|
| `HISTORY_KEY_SECRET` | Any long random string. Derives each user's local-history encryption key (HMAC-SHA256, per user id) — never sent to the client itself, only the derived key is. **Fails closed, not soft**: without it, `/api/history-key` returns 503 and the client hides the History button entirely rather than storing conversations unencrypted. Rotating it invalidates every previously-saved conversation (the old key can no longer be re-derived to decrypt them). |

Optional feature-gate secrets — each one simply switches its feature on;
absent, the models/knobs never appear:

| Secret | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Claude answer models (`claude-*`) in the model dropdown (`src/anthropic.js`) |
| `OPENAI_API_KEY` | GPT answer models (`gpt-*`) in the model dropdown (`src/openai.js`) |
| `SHODAN_API_KEY` | The per-user Shodan host-intelligence knob (`src/shodan.js`) |
| `GOOGLE_MAPS_API_KEY` | The per-user Google Maps / Street View knob (`src/googlemaps.js`) — see `wrangler.toml`'s notes for the Google Cloud APIs it needs and the optional referrer-locked `GOOGLE_MAPS_EMBED_KEY` |
| `HUGGINGFACE_API_TOKEN` | Higher-rate Hugging Face Hub search (`src/hf.js` works without it) |

Plaintext variables (dashboard "Variables", or `[vars]`):

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL` | The Google account that gets — and keeps — the admin role on sign-in. Set as a dashboard variable, deliberately not committed in `wrangler.toml`. **The only path to admin**: the admin API cannot promote anyone. |
| `LOG_LEVEL` | `debug` \| `info` (default) \| `warn` \| `error` — already in `wrangler.toml` |
| `BERGET_MODEL` | Optional default-model override (falls back to Mistral Small) |
| `BERGET_EMBED_MODEL` | Optional embedding-model override for document RAG (falls back to `intfloat/multilingual-e5-large`, 1024 dims). The Vectorize index (step 7) is created with fixed dimensions — a model with different dimensions needs the index recreated. |

(`BASIC_AUTH_USER`/`BASIC_AUTH_PASS` are accepted as legacy fallbacks for
`ADMIN_USER`/`ADMIN_PASS`; `BERGET_URL`, `ANTHROPIC_URL`, `OPENAI_URL`,
`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL` exist solely so tests can point at
mocks — never set them in production.)

### 6. First sign-in

Deploy (push to `main`, or `npx wrangler deploy`), open the site, sign in
with the Google account matching `ADMIN_EMAIL` — that first sign-in
auto-provisions the row with the admin role. Every account (admin included)
accepts the terms of use once, right after first sign-in. Every other
Google account then lands as `pending` on an awaiting-approval page until
approved in `/admin` (where default quotas, Exa cost, max time budget, and
the default model are also configured; settings live in the D1 `config`
table).

### 7. Optional: cloud storage + document RAG (R2 + Vectorize)

Enables the signed-in tier's implicit cloud storage — conversations and
projects are always stored in the cloud when these resources exist (there
is no per-account switch; the never-cloud tier is Se/cure) — and
server-side retrieval for large attached documents.
Entirely optional — without these resources the app runs browser-only
(large-document RAG still works locally via
OPFS/IndexedDB, using `POST /api/embed` for embeddings only):

```bash
npx wrangler r2 bucket create deepresearch-se-storage
npx wrangler vectorize create deepresearch-se-rag --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index deepresearch-se-rag --property-name=u --type=string
```

Then restore the `[[r2_buckets]]` and `[[vectorize]]` blocks in
`wrangler.toml` (binding names `STORAGE` and `RAG_INDEX`) and deploy.
**Create the resources first** — a binding that points at a nonexistent
bucket/index makes every deploy fail outright. What lands where (and what
is/isn't encrypted) is documented in `docs/ARCHITECTURE.md` §9 and the
**storage-privacy** skill (`.claude/skills/storage-privacy/`).

## Develop locally

```bash
npx wrangler dev
```

Local secrets go in `.dev.vars` (gitignored):

```
BERGET_API_TOKEN=...
EXA_API_KEY=...
SESSION_SECRET=...
ADMIN_USER=...
ADMIN_PASS=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAIL=...
HISTORY_KEY_SECRET=...
```

Break-glass Basic Auth (`curl -u`) is the practical way to hit local
endpoints; a real Google round-trip needs the `127.0.0.1:8787` redirect
URI from step 4. Note client-disconnect detection doesn't fire in
`wrangler dev` local mode — verify streaming behavior in production logs.

## Tests

```bash
npm test              # unit suite: node --test src/*.test.js public/js/*.test.js (no deps)
npm run typecheck     # tsc --noEmit on src/ + public/ (checked JSDoc, dev-only)

cd tests && npm install && npm run fixtures   # Playwright E2E, once
npm run test:mocked   # free — /api/chat & friends intercepted
npm run test:live     # spends real tokens against the live site
```

The E2E suite runs against the live site using the break-glass credentials
(`BASIC_AUTH_USER`/`BASIC_AUTH_PASS` env vars). Three eval harnesses live
in `tests/` (`eval:models`, `eval:bench`, `eval:hf`) with append-only
findings ledgers — see `docs/ARCHITECTURE.md` §12 and CLAUDE.md.

## Logging

Structured JSON logs (one object per line) with a per-request `request_id`,
also returned to clients as the `x-request-id` response header. Persisted
via `[observability]` (dashboard: Worker → Logs), live via
`npx wrangler tail`. Workers Logs never carry secrets or chat content;
user text appears at `debug` only. (Separately, and by explicit disclosed
design, the D1 `chat_logs` interaction log stores each completed
exchange's full question and answer for debugging — unless the
conversation used the ghost/incognito toggle. See `docs/ARCHITECTURE.md`
§9.)

## License

[MIT](LICENSE). The vendored libraries in `public/vendor/` (marked,
DOMPurify, jsPDF, pdf.js) keep their own licenses.
