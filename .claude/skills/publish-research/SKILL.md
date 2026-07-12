---
name: publish-research
description: >-
  Load when publishing a deep-research session as a frozen public replay at
  deepresearch.se/cure/<slug> — "publish this chat", "freeze this research",
  "put this session under /cure" — or when touching src/pub.js, the
  public/cure/ viewer, the /?continue= handoff, or choosing publication
  slugs. Covers the wordplay naming rule, sourcing a session (chatlogs /
  research-debug JSON / free-mode chats), the frozen JSON shape, the
  admin-only PUT, live verification, and the continue-on-own-keys flow.
---

# Publishing frozen research replays (/cure/<slug>)

## What this is

The site publishes deep-research sessions as READ-ONLY replays under
wordplay URLs: the `.se` domain completes English words, so
`deepresearch.se/cure/<slug>` reads as **"deep research secure <slug>"**.
A publication is a frozen conversation (question + researched answer,
possibly multi-turn) served by `src/pub.js` from R2 `pub/{slug}` and
opened IN PLACE by the DRC app (`public/cure/drc.js` — DRC, "deep
research secure", the client-side tier that lives at /cure): the frozen
messages seed a normal DRC conversation, so "continue with your own API
keys" is just typing a follow-up, which runs client-side on the
visitor's own provider — OpenAI/Berget key or local endpoint (see the storage-privacy skill's DRC
section). The intro glass pane doubles as the publication shelf, and
`/?continue=<slug>` is the legacy handoff form. Publishing is therefore
also an acquisition surface: a great answer becomes a starting point
anyone can pick up without an account.

## The slug naming rule (the whole point of the URL)

The slug must complete the phrase **"deep research secure <slug>"** as
natural English, lowercase-hyphenated:

- `/cure/your-cloud-storage`  → "…secure your cloud storage"
- `/cure/your-home-network`   → "…secure your home network"
- `/cure/api-keys-in-the-browser` → "…secure api keys in the browser"

Security-flavored subjects are the natural fit — that's what the /cure
reading is FOR. Slug charset is `[a-z0-9-]`, 1–80 chars, no dots (dots
are reserved so the viewer page's own assets under /cure/ can never
collide with a slug). The sibling wordplay URLs, for orientation:
`/rver` ("deep research server") is the signed-in app; `/my/project-…`
is a free-mode saved project.

## Sourcing the session to freeze

Three ways a session arrives, in practice:

1. **From the live chat logs** (signed-in app): `scripts/chatlogs`
   keyword search → the row's full question/answer (see the **chat-logs**
   skill). NEVER publish a logged user's conversation without the
   operator explicitly saying this specific exchange is theirs to
   publish (and never an incognito one — those have no rows anyway).
2. **From a research-debug JSON** the operator pastes (the activity
   pane's "Copy research JSON" — carries question, full answer, steps).
3. **Run fresh for publication** — ask the question yourself in the app,
   take the final markdown.

Shape it as user/assistant turns. Publish the USER-VISIBLE conversation
only: strip appended context blocks (attached-document/RAG-excerpt
blocks inside user messages), keep the answer's markdown verbatim
(tables, citations, the Sources list all render).

## The frozen JSON shape (`validatePublication`, src/pub.js)

```json
{
  "title": "Secure your cloud storage",
  "description": "One-line teaser shown in the /cure index and under the title.",
  "model": "the-model-that-answered (optional, shown as metadata)",
  "createdAt": 1720000000000,
  "messages": [
    { "role": "user", "content": "the question" },
    { "role": "assistant", "content": "the full markdown answer" }
  ]
}
```

Rules enforced server-side: title required; 1–200 messages; roles
strictly `user|assistant` with non-empty string content; ≤ 2 MB total.

## Publishing (admin-only writes)

`PUT /api/pub/<slug>` is behind the identity gate + admin check. From a
Claude Code session, use the break-glass Basic Auth credentials
(`BASIC_AUTH_USER` / `BASIC_AUTH_PASS` env vars — the same pair the e2e
suite uses; sent as a header, the Worker never challenges):

```bash
curl -sS -X PUT "https://deepresearch.se/api/pub/your-cloud-storage" \
  -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  -H "content-type: application/json" \
  --data @publication.json
# → {"ok":true,"slug":"your-cloud-storage","url":"/cure/your-cloud-storage"}
```

Re-PUT to the same slug replaces the publication. `DELETE` (same auth)
unpublishes. Public reads need no auth: `GET /api/pub` (index),
`GET /api/pub/<slug>` (the JSON, edge-cacheable 60 s).

## Verify live (always — see the live-verify convention)

```bash
curl -sS https://deepresearch.se/api/pub/<slug> | head -c 300   # JSON is up
curl -sS -o /dev/null -w "%{http_code}\n" https://deepresearch.se/cure/<slug>  # 200
curl -sS https://deepresearch.se/api/pub | python3 -m json.tool  # index lists it
```

Then open `/cure/<slug>` in a browser when possible: the title, the
rendered markdown, and the replay notice should all be right — the
conversation loads directly in the DRC app with the own-key notice shown.

## Gotchas learned while building it

- Replays render through `/js/markdown.js` (vendored `marked`/`DOMPurify`
  globals) — publications are sanitized markdown, never raw HTML.
- `/cure`, `/cure/<slug>`, and `/api/pub` GETs are routed BEFORE the
  identity gate in src/index.js; the PUT/DELETE live in `routeAuthed`
  behind the admin check. Keep that split — a publication is public by
  definition, publishing is not.
- The 60 s `cache-control` on the JSON means a re-published slug can
  serve the old copy for up to a minute — don't chase ghosts when
  verifying an update.
