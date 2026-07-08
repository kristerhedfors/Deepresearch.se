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
- `{"status":{"type":"search_start","round":1,"query":"…"}}` — spinner on
- `{"status":{"type":"search_done","round":1,"query":"…","results":5,"duration_ms":830,"sources":[{"title":"…","url":"…"}]}}` — expandable source list
- `{"status":{"type":"streetview_embed","lat":59.4,"lng":17.9}}` — the Google
  Maps enrichment resolved a location with Street View coverage; the client
  renders an inline, navigable Maps Embed iframe beside the answer (using the
  browser embed key it holds from `/api/settings` — the key is deliberately
  NOT in this event, so it never enters the "Copy research JSON" export). No
  embed key configured → the client ignores it and the keyless link stands.
- `{"status":{"type":"streetview_frames","query":"Maskinistvägen 11","frames":[{"dir":"north","url":"data:image/jpeg;base64,…"}]}}`
  — the actual snapped Street View frames the vision-describe helper reasoned
  about (up to 4, direction-labeled JPEG data URLs); the client renders them
  as a captioned thumbnail strip beside the answer so the user sees the SAME
  imagery the model saw. Deliberately bulky — the ONE event whose payload is
  compacted before entering the per-turn research log (`activity.js`'s
  `sanitizeResearchEvent`: frame count + directions only), so the "Copy
  research JSON" export stays small. Like the embed, it's live-session only
  (a reloaded conversation keeps the answer + link, not the images).
- `{"status":{"type":"discard_text"}}` — clear the answer streamed so far and
  keep waiting (post-validation found problems; the corrected answer follows)
- `{"status":{"type":"done","model":"mistralai/…","rounds":2,"searches":4,"duration_ms":6400,"prompt_tokens":1234,"completion_tokens":97}}` — stats footer
- `{"error":"…"}` — shown as an error in the bubble
- Stream terminates with `data: [DONE]`
