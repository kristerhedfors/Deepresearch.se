---
name: sse-protocol
description: >-
  Load when changing the /api/chat streaming protocol or the client activity
  rendering (public/js/activity.js, turns.js, stream.js) — the status/delta/done
  event vocabulary and the forward-compatibility rule that clients must ignore
  unknown status types and fields.
---

# /api/chat SSE protocol

OpenAI-style text deltas plus custom `status` events that the UI renders as
live activity (spinners, expandable sources, stats). Clients must ignore
unknown `status` types (forward compatibility).

- `{"choices":[{"delta":{"content":"…"}}]}` — text chunk
- `{"status":{"type":"step_start","id":"plan","label":"Analyzing request…"}}` — pipeline step spinner
- `{"status":{"type":"step_done","id":"plan","label":"Planned 3 search angles","details":["query …"]}}` — checkmark; `details` renders as an expandable list
  - The `id` names the phase/service so the user sees which external
    source is being contacted: `plan`/`gap1…`/`synth`/`validate` (pipeline
    phases), `geocode` (OpenStreetMap Nominatim reverse-geocode), `shodan`
    (Shodan host lookup), `maps` (Google Maps Platform lookup — Places +
    Street View + Static Maps). The client records every `status` event — plus
    the full generated answer and every error (server- or client-side,
    funnelled through `turns.js`'s single `setError` sink) — into a per-turn
    structured log for the "Copy research JSON" debug button
    (`public/js/activity.js`'s `buildResearchDebugJson`), so the export is
    the COMPLETE response, not just its live activity.
- `{"status":{"type":"search_start","round":1,"query":"…","source":"web","service":"Web search"}}` — spinner on
- `{"status":{"type":"search_done","round":1,"query":"…","source":"web","service":"Web search","results":5,"duration_ms":830,"sources":[{"title":"…","url":"…"}]}}` — expandable source list
  - `source`/`service` (added 2026-07-08) name the PROVIDER that ran the
    search: `"web"`/`"Web search"` for Exa, or a search-source registry
    entry's id/display name (e.g. `"hf"`/`"Hugging Face Hub"` —
    `src/search-sources.js`). The client renders the service name on every
    card (a user report showed hub and web searches indistinguishable
    before this) and MUST fall back to the web wording when the fields are
    absent — older stored turns predate them. Search-step tracking is keyed
    by `source + "|" + query` (the same query text may run on two
    providers in one round).
- `{"status":{"type":"streetview_embed","lat":59.4,"lng":17.9}}` — the Google
  Maps enrichment resolved a location with Street View coverage; the client
  renders an inline, navigable Maps JS SDK `StreetViewPanorama` beside the
  answer (using the browser key it holds from `/api/settings` — the key is
  deliberately NOT in this event, so it never enters the "Copy research JSON"
  export) and tracks the user's pans as the POV sent back with follow-up
  queries (`street_view_pov`). SDK load failure → Embed iframe fallback (no
  POV capture). No browser key configured → the client ignores the event and
  the keyless link stands.
- `{"status":{"type":"streetview_frames","query":"Maskinistvägen 11","frames":[{"dir":"north","url":"data:image/jpeg;base64,…"}]}}`
  — the actual snapped Street View frames the vision-describe helper reasoned
  about (up to 4, JPEG data URLs); the client renders them as a captioned
  thumbnail strip beside the answer so the user sees the SAME imagery the
  model saw. Each frame carries a cardinal `dir` ("north") OR a free-form
  `label` ("your current view" — the POV capture path, where the server
  fetched exactly the frame the user panned the live panorama to).
  Deliberately bulky — the ONE event whose payload is compacted before
  entering the per-turn research log (`activity.js`'s
  `sanitizeResearchEvent`: frame count + directions/labels only), so the
  "Copy research JSON" export stays small.
  Both embed events are ALSO recorded in `stream.js`'s `convEmbeds`
  registry, persisted in the conversation record as `embeds` and
  RE-RENDERED on history load (`turns.js` `renderStoredConversation`):
  the panorama is rebuilt from its coordinates via the Maps JS SDK, and
  the frame strip from its stored data URLs (kept in the encrypted record
  like user-attached images; `capEmbedBytes` drops the oldest embeds'
  URLs past ~4 MB — metadata stays for the copy-text export). Reopened
  conversations used to lose all Street View imagery (reported
  2026-07-08). The registry also feeds the header's copy-conversation
  export (id-numbered `[Embedded element #N: …]` lines) — any NEW event
  type that renders a persistent turn-body element must do the same (see
  the **add-research-source** skill, section 6).
- `{"status":{"type":"quiz","quiz":{"title":"…","intro":"…","questions":[{"question":"…","alternatives":["…","…"],"correct":1,"explanation":"…"}]}}}`
  — the inline-quiz capability (src/quiz.js's deterministic `quizIntent`
  gate, with a fail-soft triage `quiz:true` backup flag for typos/paraphrases
  the regexes miss — the first production request arrived as "Bygg en wuiz…"
  — + src/pipeline.js's `runQuizGeneration`; /api/chat channel only, gated by
  `state.quizzes` — the MCP channel keeps getting plain text). The quiz
  REPLACES synthesis as the answer: the `intro` streams first as ordinary
  deltas (that's the assistant message history/chatlog/answer-recovery hold),
  then this ONE event carries the full hardened question set — `correct` is
  the 0-based index into `alternatives` (the key ships to the client
  deliberately: multiple-choice grades locally; it's a self-study tool, not
  an exam). The client (public/js/quiz.js) renders an interactive card in the
  turn body: sequential questions, the alternatives as buttons PLUS a
  free-text "own words" field (graded via `POST /api/quiz/grade`, fail-soft
  to a visible "ungraded"), immediate feedback with explanations, and a final
  score verdict with a recap. Persistence follows the embed rules above:
  recorded in `stream.js`'s `convEmbeds` registry (kind `"quiz"`, with the
  user's `answers` updated as they're given and a `completed` flag),
  re-rendered on history load (resuming an unfinished quiz or showing the
  finished recap), referenced in the copy-text export via `embedRef` — and on
  completion the score summary is APPENDED to the quiz's assistant message in
  history (stream.js `quizHooks`) so follow-up questions can discuss the
  result. Compacted to title + question count in the per-turn research log
  (`sanitizeResearchEvent`). A dropped stream loses the interactive quiz
  (answer recovery returns only the intro text) — accepted fail-soft.
- `{"status":{"type":"discard_text"}}` — clear the answer streamed so far and
  keep waiting (post-validation found problems; the corrected answer follows)
- `{"status":{"type":"done","model":"mistralai/…","rounds":2,"searches":4,"duration_ms":6400,"prompt_tokens":1234,"completion_tokens":97}}` — stats footer
- `{"error":"…"}` — shown as an error in the bubble
- Stream terminates with `data: [DONE]`
