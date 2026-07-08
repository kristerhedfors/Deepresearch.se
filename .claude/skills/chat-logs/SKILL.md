---
name: chat-logs
description: >-
  Load when debugging what users actually asked and what the pipeline
  answered, investigating a reported bad answer or error, or whenever you
  need the latest live interactions — questions, answers, research steps,
  errors — pulled off the production site. Covers the /api/admin/chatlogs
  endpoints (src/chatlog.js), the scripts/chatlogs helper, the ghost
  (incognito) opt-out, and the D1 chat_logs table.
---

# The chat interaction log — full Q&A visibility for agentic debugging

## What it is

Since 2026-07-08 the server logs **every completed research interaction in
full** — the complete question, the complete answer, the conversation as
sent, the research metadata (queries run, sources found, triage complexity,
sub-questions, costs), any error, and the timing/token stats — into the D1
`chat_logs` table (`src/chatlog.js`, schema in `src/db.js`). This replaced
the earlier metadata-only logging posture, by explicit product decision, to
give full visibility for improving the product.

**The one exception is the ghost (incognito) toggle**: a conversation
started with the ghost pressed sends `incognito: true` on every
`/api/chat` request and NO chat_logs row is ever written for it (the
metadata-only Workers Logs and usage/quota accounting still happen). Never
weaken this: the ghost is the user's anonymous-chat promise, disclosed in
`/help/` and the privacy notice. MCP tool calls (`/mcp`, channel `mcp`)
are always logged — they're machine-to-machine.

Both entry points log through the same `recordChatLog` (fail-soft — a log
failure must never break a chat): `src/chat.js` in its `finally` block
(status `ok` / `error` / `disconnected`), and `src/mcp.js` on both the
success and failure paths.

## Reading the latest interactions (the thing you usually want)

The break-glass Basic Auth credentials are in the `BASIC_AUTH_USER` /
`BASIC_AUTH_PASS` env vars (already set in this environment — the e2e
suite uses the same ones). The helper script is the fastest path:

```bash
scripts/chatlogs              # last 10 interactions, readable text, newest first
scripts/chatlogs 25           # last 25
scripts/chatlogs --errors     # only status != ok (failures, disconnects)
scripts/chatlogs --q "term"   # substring match on question OR answer
scripts/chatlogs --id 42      # ONE interaction with full conversation + meta (JSON)
scripts/chatlogs --json       # JSON instead of text
scripts/chatlogs --params "user=3&channel=mcp&since=1751970000000&model=..."
```

Raw curl, when you need something the script doesn't wrap:

```bash
curl -sS -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  "https://deepresearch.se/api/admin/chatlogs?limit=10&format=text"
```

Query params on `GET /api/admin/chatlogs`: `limit` (default 20, max 200),
`before_id` (paging cursor, exclusive), `user`, `model`, `channel`
(`chat`|`mcp`), `status` (`ok`|`error`|`disconnected`), `errors=1`
(shorthand for status != ok), `since` (epoch ms), `q` (literal substring
against question OR answer), `format=text`. `GET /api/admin/chatlogs/<id>`
returns one row including the parsed `conversation` and `meta`.

The `request_id` field on every row correlates with Workers Logs entries
and the `(ref …)` string in client-side error bubbles (see the
**live-verify** skill) — a user report → `--q` on their question text →
`request_id` → `wrangler tail` / Workers Logs is the intended debugging
chain.

## Shape notes (things that will surprise you otherwise)

- **List responses already carry the FULL question and answer** — that's
  the point (one curl, no follow-ups). Only `conversation` (the whole
  message array, inline images scrubbed to size-stamped placeholders) and
  `meta` need the `/:id` view or `full` handling.
- **Truncation is explicit**: fields over their caps (`LOG_CAPS` —
  question 32K, answer 300K, conversation 400K, meta 200K chars) end with
  `…[truncated N chars]`, so a trimmed log never silently poses as
  complete. Caps exist to stay under D1's 2 MB row ceiling.
- `meta` carries `queries` (every search actually run), `sources`
  (n/title/url as numbered in the answer), `complexity`, `subquestions`,
  `conflicts`, cache counts, and `berget_cost`/`exa_cost` — enough to
  replay the research decisions without the SSE trace.
- `status="disconnected"` means the client went away mid-stream but the
  pipeline finished and the answer was parked in the recovery cache — the
  logged answer is still the complete one.
- Writes are fail-soft and the table is schema-managed like everything
  else in `src/db.js` (lazy `CREATE TABLE IF NOT EXISTS`) — no migration
  step; the first request after deploy creates it.

## Retention

Deliberately unbounded for now (the product decision was full visibility;
"skip the zero-retention paradigm"). If the table ever needs pruning, do
it as an explicit admin action — do not add silent TTLs.
