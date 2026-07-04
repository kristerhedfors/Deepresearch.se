# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Git workflow

**Always push straight to `main` after every change.** This project does not use
feature branches or pull requests for normal work — commit each change and push
it directly to `main`.

```bash
git add -A
git commit -m "…"
git push origin main
```

## Project

A Cloudflare Worker (`src/index.js`) that serves a static chat UI (`public/`)
and a streaming `/api/chat` endpoint. Deployed via `npx wrangler deploy`
(config in `wrangler.toml`), git-connected to Cloudflare.

## LLM provider — Berget.ai

**This project uses Berget.ai, NOT Anthropic.** Berget exposes an
OpenAI-compatible API at `https://api.berget.ai/v1`.

- **Auth:** the Worker reads the `BERGET_API_TOKEN` secret (already configured
  on the Worker in the Cloudflare dashboard) and sends it as
  `Authorization: Bearer <token>`. Never hardcode the token in the repo.
- **Model:** defaults to **Mistral Small**
  (`mistralai/Mistral-Small-3.2-24B-Instruct-2506`, alias `mistral-small`),
  overridable via the optional `BERGET_MODEL` env var. Other models available
  in Berget's repo can be found at `GET https://api.berget.ai/v1/models`.
- **API shape:** OpenAI-style `POST /v1/chat/completions` with
  `stream: true`; SSE deltas arrive as `choices[0].delta.content`, terminated
  by `data: [DONE]`.

## Access control

The whole site (UI + API) is behind HTTP **Basic Auth**: username `djup`,
password `forskning`. Enforced in the Worker; `run_worker_first = true` in
`wrangler.toml` ensures auth also covers the static assets. Credentials are
overridable via the `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` secrets.
