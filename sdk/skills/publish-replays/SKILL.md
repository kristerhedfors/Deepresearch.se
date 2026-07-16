---
name: publish-replays
description: >-
  Load when giving a generated agent pair PUBLISHED RESEARCH REPLAYS — frozen
  research sessions served as public read-only pages under the CLIENT tier's
  URL path, where the slug completes the pair's wordplay and the replay opens
  IN PLACE inside the client-tier app so "continue on your own keys" is just
  typing — or when touching the frozen-JSON shape, the slug rules, the
  admin-only publish/unpublish endpoints, the public pre-auth reads, the
  publication shelf, or the legacy handoff aliases. Covers sourcing a session
  to freeze (interaction logs / debug exports / client-tier chats and the
  consent rule), the dot-free asset-collision guard, reserved slugs, the
  blob-store round-trip, and the short public-read TTL.
---

# Published replays — frozen research sessions as public pages

Publish the pair's best research sessions as READ-ONLY replays under wordplay
URLs on the CLIENT tier's path: the slug completes the phrase the tier's name
starts (reference: `DeepResearch.Se/cure/<slug>` reads "deep research secure
<slug>"). A publication is a frozen conversation — question plus researched
answer, possibly multi-turn — stored as one JSON blob and rendered by the
client-tier app itself, seeding a REAL conversation in place. That makes
every publication an acquisition surface: a great answer becomes a starting
point any visitor can pick up and continue on their own keys, no account, no
server in the continuation's data path.

## Capability class & tier story

**Class S — server-backed storage and admin writes; client-tier rendering.**
The one server component owns the blob store (`pub/{slug}` objects), the
public read API, and the admin-only write API. The CLIENT tier owns the
entire experience: the replay page IS the client-tier app with the frozen
messages seeded as a normal conversation, so continuing is just typing a
follow-up — which runs client-side on the visitor's own browser-direct
provider. The server serves frozen public JSON and nothing else; it learns
nothing about who reads a replay beyond a static-asset fetch, and nothing at
all about a continuation. The intro pane of the client-tier app doubles as
the publication shelf (the index endpoint feeds it), so publications are
discoverable without any extra page.

## Contracts

- **PA-4** — the frozen shape carries NO account identity, no request ids,
  no research-log internals: title, optional description/model label, a
  timestamp, and plain `{role, content}` text turns. Publishing a logged
  user's conversation requires the operator's explicit per-exchange consent
  (and incognito exchanges have no log rows to publish from at all).
  Continuations never touch the server.
- **PA-2** — a missing blob store degrades to a clear 503/empty index, not
  an error page; a missing slug renders the app's home, never a crash.
- **PA-5** — one small server module, no dependencies; replays render
  through the client's existing sanitized-markdown path — publications are
  sanitized markdown, never raw HTML.
- **PA-10** — every publish is verified live: JSON up, page 200, index
  lists it, and the replay opens in a browser with the own-keys notice.

## Build plan

1. **Choose the slug discipline FIRST — it is the product.** The slug must
   complete the pair's wordplay phrase as natural language, lowercase
   `[a-z0-9-]`, bounded length (reference: 1–80), and **dot-free** — dots
   are reserved so a slug can never collide with the viewer page's own
   asset files living under the same path prefix. Keep a RESERVED-slug set
   for every feature page that also lives under the client tier's path
   (the reference reserves `workspace` and `help`) — publishing over one
   would shadow the feature.
2. **The frozen JSON shape + validator.** One pure validation function the
   write path runs: required trimmed title (capped), optional description
   and model label (metadata only), a created-at timestamp, and 1–N
   messages with roles strictly `user|assistant` and non-empty string
   content; a total-bytes cap (a frozen session is text — the reference
   allows 2 MB, 200 messages). Deliberately the SAME shape the client tier
   chats in, so a replay IS a conversation with zero adaptation:

   ```json
   {
     "title": "Secure your cloud storage",
     "description": "One-line teaser for the shelf and under the title.",
     "model": "the-model-that-answered (optional, shown as metadata)",
     "createdAt": 1720000000000,
     "messages": [
       { "role": "user", "content": "the question" },
       { "role": "assistant", "content": "the full markdown answer" }
     ]
   }
   ```
3. **The server module.** Four faces over the blob store, keyed
   `pub/{slug}`:
   - `GET /api/pub` — the public index (newest first), edge-cacheable.
   - `GET /api/pub/:slug` — one frozen session, public, short cache TTL
     (reference: 60 s) so republishes propagate within a minute.
   - `PUT /api/pub/:slug` — publish/replace, ADMIN only.
   - `DELETE /api/pub/:slug` — unpublish, admin only.
4. **The routing split (load-bearing).** Public GETs — the replay page
   path, the slug page paths, and the pub read API — are routed BEFORE the
   identity gate; the PUT/DELETE live behind the gate plus the admin check.
   A publication is public by definition; publishing is not. Keep the two
   halves in visibly different routing sections so nobody "simplifies" them
   together.
5. **Open-in-place in the client tier.** The client-tier app recognizes
   `<tier-path>/<slug>`: fetch the frozen JSON, seed a normal conversation
   from its messages, render the title + a replay notice ("continue with
   your own keys"), and let the composer just work — the continuation runs
   the ordinary client-side pipeline on the visitor's provider. A slug that
   parses like a reserved word or fails to fetch falls through to the app's
   normal home.
6. **The publication shelf.** The client tier's first-visit intro pane
   doubles as the shelf: render the index endpoint's titles + descriptions
   as links. No separate page, no server-side templating.
7. **Legacy aliases.** If the pair ever moves its handoff URL shape, keep
   the old form working as a redirect/seed alias (the reference keeps
   `/?continue=<slug>`). Cheap to keep, expensive in dead links to drop.
8. **The sourcing workflow (operator-side, document it with the module).**
   Three ways a session arrives: (a) from the interaction log — keyword
   search, take the row's full question/answer, ONLY with the operator's
   explicit statement that this specific exchange is theirs to publish;
   (b) from a research-debug export the operator pastes; (c) run fresh for
   publication. Shape as user/assistant turns; publish the USER-VISIBLE
   conversation only — strip appended context blocks (attached-document /
   RAG-excerpt blocks inside user messages); keep the answer's markdown
   verbatim (tables, citations, sources list all render).
9. **Publish tooling.** Writes are a curl-able authed PUT (the reference
   uses the break-glass Basic Auth header from agent sessions, since the
   worker never emits a challenge); re-PUT replaces; DELETE unpublishes.
10. **The live verification ladder (every publish, no exceptions).** Four
    probes, in order:
    - `GET /api/pub/<slug>` returns the JSON (spot-check the title);
    - the slug page returns 200;
    - `GET /api/pub` lists the new entry;
    - open the page in a browser: title, rendered markdown (tables,
      citations, sources list), and the replay/own-keys notice all right,
      and a typed follow-up continues client-side.
    Publishing is an operator-facing feature with no monitoring — the
    ladder is the only thing standing between "published" and "404 shared
    on social media".

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Server module (validator, slug rules, reserved set, 4 API faces) | `src/pub.js` |
| Pre-auth routing of `/cure`, `/cure/<slug>`, `GET /api/pub*`; authed PUT/DELETE | `src/index.js` |
| Open-in-place seeding + replay notice + shelf | `public/cure/drc.js` (+ `public/cure/index.html` `#intro` pane) |
| Slug/path parsing incl. reserved words | `public/js/drc-page-core.js` (`parsePublicationRef`) |
| Sanitized markdown rendering | `public/js/markdown.js` (vendored marked + DOMPurify) |
| Blob storage | R2 `pub/{slug}` via the worker's storage binding |
| Round-trip + slug-rule unit suite (mocked R2) | `src/pub.test.js` |
| Operator publishing workflow | `.claude/skills/publish-research/SKILL.md` |
| Legacy handoff alias | `/?continue=<slug>` handling in `public/cure/drc.js` |

## Acceptance checklist

- [ ] Slug validator unit-tested: charset, length, dot rejection, reserved
      words rejected.
- [ ] Publication validator unit-tested: title required, role/content
      strictness, message count and byte caps.
- [ ] Publish → public read → index → unpublish round-trip green against a
      mocked blob store; storage-missing paths return clear 503s.
- [ ] Public GETs reachable with NO credentials; PUT/DELETE rejected
      without admin.
- [ ] Live: the frozen JSON serves, the slug page returns 200, the index
      lists it, and the replay opens in the client-tier app with the
      own-keys notice — then a typed follow-up continues on a visitor key.
- [ ] A replay of a session containing attachments shows no appended
      context blocks (user-visible turns only).
- [ ] Unpublishing removes the page and the index entry (within the read
      TTL).

## Pitfalls

- **The 60 s read TTL makes ghosts.** A re-published slug can serve the old
  copy for up to a minute — when verifying an update, wait out the TTL
  before concluding the publish failed (reference gotcha, learned live).
- **Dots in slugs collide with the viewer's own assets.** The replay pages
  live under the same path prefix as the client-tier app's files; a slug
  like `drc.js` would shadow a real asset. The dot ban is a guard, not
  taste.
- **Reserved slugs grow with the tier.** Every new feature page mounted
  under the client tier's path (`workspace`, `help` in the reference) must
  join the reserved set IN THE SAME CHANGE, or an admin can publish over
  the feature and shadow it.
- **Keep the routing split.** The reference routes public reads before the
  identity gate and writes behind admin deliberately; merging them "for
  tidiness" either locks the public pages behind sign-in (dead acquisition
  surface) or opens writes (defacement).
- **Consent is per-exchange, not per-user.** Never publish from the
  interaction log without the operator explicitly saying THIS exchange is
  theirs to publish; incognito exchanges have no rows — treat their absence
  as the answer, not an obstacle.
- **Strip the appended blocks.** User messages in logged sessions carry
  appended document/RAG context blocks; publishing them leaks attachment
  contents and reads as noise. Publish the user-visible turns only.
- **Never render publication HTML raw.** Replays go through the same
  sanitizer as chat; a publication is attacker-shaped input the moment the
  write credential leaks, and the sanitizer is the backstop.
- **The frozen shape is a compatibility contract.** The client tier seeds a
  conversation from these exact records; adding a required field or a
  richer content shape breaks every already-published replay. Extend with
  optional fields only, and keep the validator accepting the original
  shape forever.
- **Slug quality is editorial, not mechanical.** The validator can only
  enforce charset and length; whether "…secure the-cloud" reads as natural
  language is a human call — read the completed phrase aloud before
  publishing, because the URL is the headline.
