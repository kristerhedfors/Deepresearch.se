# Deepresearch.se

AI research chatbot on Cloudflare Workers: a static chat UI plus a streaming
`/api/chat` endpoint backed by Berget.ai (Mistral Small), with Exa web search
available to the model as a tool. The whole site is behind HTTP Basic Auth.

## Architecture

```
browser ── Basic Auth ──> Worker (src/index.js)
                            ├── static UI          public/index.html (env.ASSETS)
                            └── POST /api/chat     src/chat.js
                                  ├── Berget.ai    src/berget.js  (LLM, streaming SSE)
                                  └── Exa          src/exa.js     (web_search tool)
```

The Worker runs the tool-call loop: the model either streams text to the
browser or requests a `web_search`; the Worker queries Exa, feeds the results
back, and the grounded answer streams out. See `CLAUDE.md` for provider
details and conventions.

## Develop

```bash
npx wrangler dev
```

Local secrets go in `.dev.vars` (gitignored):

```
BERGET_API_TOKEN=...
EXA_API_KEY=...
BASIC_AUTH_USER=...
BASIC_AUTH_PASS=...
```

## Deploy

Pushing to `main` auto-deploys via the Cloudflare git integration. Manual:

```bash
npx wrangler deploy
```

## Secrets (Worker → Settings → Variables and Secrets)

| Secret | Purpose |
|---|---|
| `BERGET_API_TOKEN` | Berget.ai API auth (Bearer) |
| `EXA_API_KEY` | Exa web search (`x-api-key`) |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Site-wide Basic Auth; fails closed if unset |

Optional vars: `BERGET_MODEL` (model override), `LOG_LEVEL` (`debug`–`error`,
default `info`, set in `wrangler.toml`).

## Logging

Structured JSON logs (one object per line) with a per-request `request_id`
that is also returned to clients as the `x-request-id` response header. View
in the Cloudflare dashboard (Worker → Logs, enabled via `[observability]`) or
live with `npx wrangler tail`.
