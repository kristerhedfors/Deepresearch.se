---
name: sse-protocol
description: >-
  Load when changing the /api/chat streaming protocol or the client activity
  rendering (public/js/activity.js, turns.js, stream.js) — the status/delta/done
  event vocabulary and the forward-compatibility rule that clients must ignore
  unknown status types and fields. ALSO covers the inline-quiz capability,
  which rides a `quiz` SSE event: src/quiz.js (the quizIntent EN+SV gate —
  invariant 6 parity — and normalizeQuiz), src/quiz-api.js (/api/quiz/grade),
  and the client card public/js/quiz.js.
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
- `{"status":{"type":"streetview_embed","lat":59.4,"lng":17.9,"heading":143,"pitch":-5}}`
  — the Google
  Maps enrichment resolved a location with Street View coverage; the client
  renders an inline, navigable Maps JS SDK `StreetViewPanorama` beside the
  answer (using the browser key it holds from `/api/settings` — the key is
  deliberately NOT in this event, so it never enters the "Copy research JSON"
  export) and tracks the user's pans as the POV sent back with follow-up
  queries (`street_view_pov`). `heading`/`pitch` are optional (absent →
  north/level): the POV-capture path sends them (2026-07-09) so the reply's
  panorama continues exactly at the user's current view instead of freezing
  them at a stale static frame. SDK load failure → Embed iframe fallback (no
  POV capture). No browser key configured → the client ignores the event and
  the keyless link stands.
- `{"status":{"type":"map_embed","lat":59.65,"lng":17.12,"zoom":17,"q":"Basaltgatan 3, 749 40 Enköping, Sweden"}}`
  — optionally also `"path":[{"lat":…,"lng":…},…]` (added 2026-07-09 with
  the journey view): when present and the SDK loaded, the client draws
  markers at every point (a waypoint with a nearby image in the
  conversation's image deck gets that image as a MINIATURE marker whose
  click opens the deck's slideshow at it — imagedeck.js), a polyline
  between them, and fits the viewport to the route; clients that don't
  know the field render the same event as a plain centered map (the
  forward-compat rule at work). ALSO optionally
  `"route":{"polyline":[{"lat":…,"lng":…},…],"durationS":540,"distanceMeters":720}`
  (added 2026-07-14): the along-the-ROADS walking path from Google Routes
  — the client draws it as a DOTTED green line beside the straight blue
  stop-to-stop line and pins a "N min walk" badge at its midpoint (the
  walking time on the map). Absent when the Routes API isn't enabled/
  errors; older clients ignore it (forward-compat). `streetview_frames` frames likewise
  gained optional per-frame `lat`/`lng`/`kind:"map"` fields the same day
  — the deck uses them for the mini-map, the waypoint matching, and the
  ask-from-this-point anchor; older clients ignore them —
  the no-Street-View-coverage counterpart of `streetview_embed` (added
  2026-07-09: a resolved location without a panorama used to show nothing
  interactive and the answer carried no link at all): the client renders an
  inline, navigable Google MAP beside the answer — a Maps JS SDK
  `google.maps.Map` (`activity.js`'s `renderMapEmbed`, reusing the
  `.streetview-embed` styling; marker at the coordinates when `q` names a
  resolved address) with FULL panorama parity (same day, follow-up
  request): pans/zooms are tracked (on `idle`, rounded ~1m/integer zoom)
  into the map view `stream.js` sends as `body.map_view` with follow-ups;
  a map-referencing follow-up (`referencesStreetViewScene`, the loose
  gate) makes the server capture ONE Static Maps image of exactly that
  area (`runMapViewCapture`, edge-cached), vision-describe it
  (map-flavored instruction), append `buildMapViewBlock` (current-center
  markdown Map-link mandate + never-fabricate line), and emit a fresh
  `map_embed` at the current center/zoom (continue-from-here). Only the
  LATEST view — across BOTH embed kinds — stays navigable: a new map or
  panorama locks the superseded embeds (dimmed, pointer-events off,
  honest label) and clears the other kind's view slot, so `map_view` and
  `street_view_pov` never ride together. SDK failure → Embed API iframe
  fallback (place mode with `q`, view mode without) — navigable, no view
  capture. Emitted only when NO `streetview_embed` fires and the browser
  embed key is configured; the key is NOT in the event (same discipline
  as the panorama). `zoom` is optional (absent → 17). Persisted in
  `convEmbeds` (kind `"map_embed"` — tiny, coords + zoom + q),
  re-rendered on history load (`turns.js`, re-locking all but the last
  naturally), referenced in the copy-text export (`embedRef`:
  "interactive Google Map at lat, lng (q)").
  — the actual snapped Street View frames the vision-describe helper reasoned
  about (up to 4, JPEG data URLs); the client renders them as a captioned
  thumbnail strip beside the answer so the user sees the SAME imagery the
  model saw. Each frame carries a cardinal `dir` ("north") OR a free-form
  `label` ("your current view" — the POV capture path when NO embed key is
  configured; with one, that path emits `streetview_embed` instead so the
  user can keep navigating).
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
- `{"status":{"type":"build","slug":"todo-app-a1b2","url":"/app/todo-app-a1b2/","files":3,"title":"Todo App"}}`
  — SDK mode published (or republished) this conversation's generated app
  (src/pipeline.js `runSdkBuild` → src/build-pub.js). The client
  (stream.js) remembers `slug` per conversation (persisted as the record's
  `buildSlug`) and sends it back as `build_slug` on the next SDK-mode send so
  an iteration republishes the SAME `/app/<slug>/` URL; the visible link
  rides in the answer text ("**Try it live:** …"), so no turn-body element is
  rendered and the embed-registry rules don't apply. Older clients ignore the
  event (forward compatibility) — they just mint a fresh slug per turn. See
  the **sdk-mode** skill.
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
- `{"status":{"type":"workflow","title":"…","agents":[{"id":"workers","kind":"deep_research","name":"…","task":"…","deps":[]}],"waves":[["workers","deno"],["critic"]]}}`
  — Orchestrator mode's resolved plan graph (src/orchestrator.js
  runOrchestration, shapes built in public/js/orchestrator-core.js), emitted
  ONCE before execution: the sub-agent nodes, their dependency edges, and the
  parallel waves the executor will run. The client (stream.js) renders the
  live workflow view (public/js/workflow-viz.js — one node per sub-agent,
  wave columns, dependency edges) in the turn body and records it in the
  embeds registry (kind `"workflow"`), so it re-renders on history load and
  gets an `embedRef` line in the copy-text export; compacted to the team's
  shape in the per-turn research log (`sanitizeResearchEvent`). Old clients
  ignore it and still see the run via the ordinary `step_*` events the mode
  also emits per agent (`agent_<id>` step ids) — forward-compat by redundancy.
- `{"status":{"type":"agent_update","id":"workers","status":"done","duration_ms":8100,"chars":2400}}`
  — one Orchestrator sub-agent's lifecycle change (running → done/failed;
  `note` carries a bounded failure reason). The client updates that node in
  the workflow view AND the statuses map stored on the workflow embed, so the
  persisted record always carries the latest node states (an interrupted run
  honestly re-renders as "running").
- `{"status":{"type":"discard_text"}}` — clear the answer streamed so far and
  keep waiting (post-validation found problems; the corrected answer follows)
- `{"status":{"type":"done","model":"mistralai/…","rounds":2,"searches":4,"duration_ms":6400,"prompt_tokens":1234,"completion_tokens":97}}` — stats footer
- `{"error":"…"}` — shown as an error in the bubble
- Stream terminates with `data: [DONE]`
