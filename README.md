# DeepResearch.se

A deep-research AI assistant on Cloudflare Workers: a static chat UI plus a
streaming `/api/chat` endpoint that runs a Worker-orchestrated research
pipeline (triage → Exa search waves → gap check → cited synthesis →
post-validation) against Berget.ai's EU-hosted, OpenAI-compatible models.
Google sign-in gates the whole site; D1 stores accounts and real-cost
research quotas; an `/admin` console shows usage and approves users.

```
browser ── Google OIDC session ──> Worker (src/index.js)
                                     ├── static UI       public/ (env.ASSETS)
                                     ├── POST /api/chat  src/chat.js → src/pipeline.js
                                     │     ├── Berget.ai src/berget.js (LLM, streaming + JSON mode)
                                     │     └── Exa       src/exa.js    (web search)
                                     ├── /admin, /api/admin/*  admin console
                                     └── D1 (accounts, quotas, config, answer recovery)
```

See `docs/ARCHITECTURE.md` for the full design and `CLAUDE.md` for
conventions. The complete prompt-by-prompt build history lives in
`public/build/history.md` (rendered in-app at `/story/`; `/build/` holds the
project purpose and EU AI Act use restrictions).

## Installing your own instance

Everything below reproduces the production setup end-to-end. You need:

- A **Cloudflare account** (Workers free tier works) and, optionally, a
  domain with its zone active in that account.
- A **Berget.ai** account and API token — the LLM provider
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
`npx wrangler secret put <NAME>`). All six secrets are required:

| Secret | Purpose |
|---|---|
| `BERGET_API_TOKEN` | Berget.ai API auth (sent as `Authorization: Bearer`) |
| `EXA_API_KEY` | Exa web search (sent as `x-api-key`) |
| `ADMIN_USER` / `ADMIN_PASS` | Break-glass Basic Auth (curl/scripts/emergencies) — **also key the session-cookie HMAC, so the Worker fails closed without them**; rotating `ADMIN_PASS` invalidates every session |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | The OAuth client from step 4 |

Optional but recommended — enables encrypted, client-side chat history
(`GET /api/history-key`, `src/history-key.js`):

| Secret | Purpose |
|---|---|
| `HISTORY_KEY_SECRET` | Any long random string. Derives each user's local-history encryption key (HMAC-SHA256, per user id) — never sent to the client itself, only the derived key is. **Fails closed, not soft**: without it, `/api/history-key` returns 503 and the client hides the History button entirely rather than storing conversations unencrypted. Rotating it invalidates every previously-saved conversation (the old key can no longer be re-derived to decrypt them). |

Plaintext variables (dashboard "Variables", or `[vars]`):

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL` | The Google account that gets — and keeps — the admin role on sign-in. Set as a dashboard variable, deliberately not committed in `wrangler.toml`. **The only path to admin**: the admin API cannot promote anyone. |
| `LOG_LEVEL` | `debug` \| `info` (default) \| `warn` \| `error` — already in `wrangler.toml` |
| `BERGET_MODEL` | Optional default-model override (falls back to Mistral Small) |

(`BASIC_AUTH_USER`/`BASIC_AUTH_PASS` are accepted as legacy fallbacks for
`ADMIN_USER`/`ADMIN_PASS`; `BERGET_URL`, `GOOGLE_AUTH_URL`,
`GOOGLE_TOKEN_URL` exist solely so tests can point at mocks — never set
them in production.)

### 6. First sign-in

Deploy (push to `main`, or `npx wrangler deploy`), open the site, sign in
with the Google account matching `ADMIN_EMAIL` — that first sign-in
auto-provisions the row with the admin role. Every other Google account
lands as `pending` on an awaiting-approval page until approved in `/admin`
(where default quotas, Exa cost, max time budget, and the default model
are also configured; settings live in the D1 `config` table).

## Develop locally

```bash
npx wrangler dev
```

Local secrets go in `.dev.vars` (gitignored):

```
BERGET_API_TOKEN=...
EXA_API_KEY=...
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

## Logging

Structured JSON logs (one object per line) with a per-request `request_id`,
also returned to clients as the `x-request-id` response header. Persisted
via `[observability]` (dashboard: Worker → Logs), live via
`npx wrangler tail`. Never logs secrets or chat content; user text appears
at `debug` only.

## License

[MIT](LICENSE). The vendored libraries in `public/vendor/` (marked,
DOMPurify, jsPDF, pdf.js) keep their own licenses.
