---
name: ui-notes
description: >-
  Load when changing the client UI (public/ — index.html, css/app.css, js/*.js),
  the composer/header/floating chrome, the PDF report (report.js), document/image
  attachments and metadata extraction (exif.js, docs.js), the account panel /
  message center / privacy notice, or the /help/ /build/ /story/ /architecture/
  /welcome/ static pages and the public (no-auth) surface.
---

# UI notes

- Assistant answers render as **Markdown by default** (synthesis prompt asks
  for Markdown). Rendering is client-side with vendored `marked` +
  `DOMPurify` (`public/vendor/` — no CDN; everything stays behind auth).
  `markdown.js`'s `normalizeLlmMarkdown` repairs one real-world model quirk
  before parsing: GLM-4.7 streamed a whole GFM table on ONE line with its
  rows joined by `||` and no blank line before it, so CommonMark rendered it
  as literal `| … |` text (reported bug). The normalizer splits joined rows,
  detaches a table header glued to the preceding paragraph, and guarantees a
  blank line before the table — anchored on the `|---|` separator row so it's
  a strict no-op on well-formed markdown or text with no table (unit-tested).
  `synthPrompt` also now explicitly asks for each table row on its own line.
  Always sanitize: answers can quote hostile web content. Each answer has
  Raw (plain-text toggle), Copy, and **PDF** buttons — PDF generates a
  branded DeepResearch.se report client-side via vendored jsPDF
  (`public/js/report.js`; the 360KB lib is script-injected on first use
  only). The report **embeds the images the user attached to the
  question** as figures under the title: the turn object carries the
  sent data URLs (`turns.js` ← `stream.js`) and jsPDF stores the
  downscaled JPEGs verbatim (the e2e suite byte-matches them inside the
  file). The PDF is saved via the native share sheet on touch devices and
  an `<a download>` click elsewhere — NEVER jsPDF's own `doc.save()`,
  whose Safari fallback navigates the page and aborts in-flight fetches
  (this killed a streaming answer in production). Belt-and-suspenders:
  the button waits (`"when done"`) while a research stream is running.
- **Document attachments** (`public/js/docs.js`): the paperclip accepts
  images AND `pdf`/`docx`/`md`/`txt`. Docs are parsed entirely client-side
  (txt/md directly; pdf via vendored pdf.js, dynamically imported on first
  PDF; docx via a minimal ZIP reader + `DecompressionStream("deflate-raw")`
  — no library) and embedded as labeled text blocks in the API message
  (never shown in the bubble, which gets 📄 chips). Caps: 3 docs × 9K chars
  (fits the server's 32K message limit), 4 images. Attachments render as
  rounded cards with a white circular ✕, on their own line at the BOTTOM
  of the composer pane (`#pending` after the form).
- **Metadata extraction** (`public/js/exif.js`, `public/js/docs.js`): images
  and documents can carry information beyond their visible content, and the
  research pipeline is meant to be able to use it — a photo's capture
  location/time/device, or a document's author and edit history are often
  directly relevant to a research question ("where was this taken",
  "who wrote this", "what did this originally say"). Extracted client-side,
  same as the parsed text, and appended as its own labeled block
  (`--- Image metadata: name.jpg ---` / `[Document metadata]` inside the
  existing document block) — never silently blended into the main text.
  - **Images (JPEG only — EXIF is overwhelmingly a camera-photo
    phenomenon; PNG/WebP/GIF yield no metadata)**: `exif.js` is a small,
    dependency-free TIFF/EXIF parser reading GPS coordinates (converted to
    decimal + an OpenStreetMap link), capture date/time, camera
    make/model, editing software, and artist/copyright/description tags.
    Must run on the file's ORIGINAL bytes — `attachments.js` calls it
    before the canvas-based downscale, since re-encoding through
    `<canvas>.toDataURL()` strips all EXIF. The raw coordinates alone
    aren't very useful to a model or to Exa, so they're also forwarded
    separately (`body.imageLocations`) for the Worker to reverse-geocode
    into an actual place name — see "Reverse geocoding" below.
  - **DOCX**: `docProps/core.xml` (author, last-modified-by, created/
    modified dates, revision, title/subject/keywords) and `docProps/
    app.xml` (company, application), plus — the highest-value case —
    **unaccepted tracked changes and comments still physically present in
    the file**. Word stores a deletion's text in `<w:delText>` (not
    `<w:t>`) specifically so it renders struck-through/hidden; this is a
    well-known real-world metadata leak class (redacted or "removed"
    content resurfacing from the file itself — e.g. the 2003 UK "Iraq
    dossier" Word document). `docs.js` extracts deletions AND insertions
    (author + date + the actual text) plus `word/comments.xml` reviewer
    comments, lists them explicitly in the metadata block, and — unlike a
    naive tag-stripping pass — excludes deleted text from the document's
    main flowing text (insertions stay in the main text, matching how
    Word itself renders an unaccepted insertion).
  - **PDF**: pdf.js's own `getMetadata()` — the Info dictionary (Title,
    Author, Subject, Keywords, Creator, Producer, CreationDate, ModDate).
  - **Transparency**: `attachments.js` shows a badge on the pending
    attachment chip whenever metadata was found, before the user hits
    send — plain `ℹ️ metadata included` for routine properties, and a
    distinct warmer-colored `📍 location data included` (images with GPS)
    or `⚠️ tracked changes included` (docx with unaccepted deletions) for
    the two genuinely sensitive cases. The badge's title attribute holds
    the full extracted summary. This is deliberately visible before send,
    not just logged — the same transparency-first posture as the rest of
    this app's privacy design.
- **Inline quiz card** (`public/js/quiz.js`, `.quiz-*` styles): the `quiz`
  SSE event renders an interactive card in the turn body (before the stats
  footer, like the Street View embeds — it persists beside the answer, not
  in the collapsing activity panel). One question at a time: the
  alternatives as full-width buttons plus a free-text "answer in your own
  words" field; answering reveals the correct alternative, the verdict, and
  the explanation, then Next; the last answer flips to a score verdict with
  a per-question recap. Free text grades via `POST /api/quiz/grade`
  (fail-soft: an ungraded answer is visibly excluded from the score).
  Answers/completion persist via `stream.js`'s embeds registry (kind
  `"quiz"`) — a reopened conversation resumes an unfinished quiz or shows
  the finished recap, and completing one appends the score summary to the
  assistant message in history (follow-ups can discuss the result). See the
  **sse-protocol** skill for the event contract.
- Processing indicators are the site icon pulsing (`pulse-screw` keyframes).
- **Floating chrome (no hide/show):** header and footer are FIXED,
  click-transparent strips (`pointer-events: none`) whose glass items
  re-enable pointer events — content scrolls beneath the chrome and
  stays visible between the items and through their translucency. The
  header stacks TWO rows: the brand as plain characters (no pane, soft
  white text-glow, never captures clicks) and beneath it the glass
  controls row (history, New chat, account button). `#chat`
  carries top/bottom padding (5.6rem / 8rem) so the first and last
  messages can scroll clear of the fixed items.
- **Background life:** `body::before` drifts a repeating diagonal gradient
  (tiny white/navy alphas) across the sky blue — one full 280px period per
  26s loop so it's seamless; disabled under `prefers-reduced-motion`.
- **Glass chrome:** the header is transparent with the title in smaller
  type and each control (history, New chat, account) as
  its own frosted-glass container; the whole input area is ONE glass pane
  (`#composer`, rounded, backdrop-blur over the drifting waves): a
  single-line auto-growing text input on top (Enter inserts a LINE BREAK
  — only the arrow button sends; grows to ~6 lines), beneath it the
  controls row — the attach and camera buttons (round), the **model
  selector** (moved here from the header; fills the remaining space) —
  then a third row of its own — the slider filling the remaining space,
  the spelled-out time value (slider/value dim while search is off),
  and on its right end the
  **web-search knob** (default on; sends `web_search: false` when off →
  the Worker skips triage/Exa entirely and streams one Berget
  completion; a spiderweb sits inside the knob — accent blue with a
  soft glow when on, grey when off — and press-and-holding the knob
  opens the info popover that used to hang off a separate 🔍 button,
  removed to give the slider its footer space) — and back on the controls
  row a round accent
  **arrow send button** that becomes
  a **square stop button** (same element, swapped icon, never disabled)
  while a response is streaming — clicking it aborts the in-flight
  request (`stream.js`'s `stopGeneration()`) but keeps whatever streamed
  so far as normal conversation context (a `*(Stopped.)*` marker is
  appended, not an error), so the composer is immediately ready for a
  follow-up. Distinct from "New chat" (`clearHistory()`), which also
  aborts but discards everything on screen instead. "New chat" in the
  header clears the on-screen conversation and its in-memory state —
  it does NOT delete the conversation from encrypted local history (see
  "Chat history" above); the previous conversation stays listed in the
  history panel until explicitly deleted there.
- **User documentation** at `/help/` (auth-gated static page): every
  control explained with real screenshots (`public/help/img/`, captured
  via Playwright) and the privacy meaning of each — linked from the
  account panel. Re-capture the screenshots when the composer/header
  changes visibly (the header and composer screenshots are now stale —
  the history button was added, then the model selector moved from the
  header into the composer row with the search knob/slider on their own
  row below — not yet recaptured).
- **"About this project"** at `/build/` (auth-gated static page, linked
  from the account panel): states the site's actual purpose — a
  demonstration of building a SaaS-style app over a weekend, **entirely
  through the Claude Code iPhone app** (domain purchase, every deploy,
  every service configured, source/config never viewed directly on any
  other device — the one exception being the D1 database UUID, which had
  to be hand-copied from the Cloudflare dashboard URL; source:
  https://github.com/kristerhedfors/Deepresearch.se), invite-only and
  never placed on the market — plus a
  restricted-use-cases section grounded in the EU AI Act (Article 5
  prohibited practices mapped onto a text research tool, and an honest
  read of why the Article 2(6)/2(8) research and pre-market exemptions
  don't cleanly apply to continuous real-world use by invited people).
- **"The build story"** at `/story/` (auth-gated static page, its own
  top-level account-panel entry): fetches and renders
  `public/build/history.md` (the complete, prompt-by-prompt build
  history, moved from `docs/` so it's part of the shipped product and
  not just a repo file) via the same vendored `marked`/`DOMPurify`
  pipeline the chat UI uses, flowing with normal page scroll — and
  NEVER sideways: tables and code wrap instead of forcing width. Append
  to `history.md`, not rewrite — it's a chronological record; keep
  adding a new section per session the way earlier entries did.
- **"The architecture story"** at `/architecture/` (public static page,
  self-contained like /story/, added 2026-07-12): pairs the two tiers —
  DeepResearch.**Se/rver** vs DeepResearch.**Se/cure** — on
  privacy and capabilities, with inline-SVG visualizations: the two
  data-path diagrams (Worker-orchestrated vs browser-orchestrated), the
  paired privacy table (privacy by policy+encryption vs privacy by
  structure), the paired capabilities table, and the shared execution
  sandbox section documenting the WebVM Debian disk decision (stock
  `debian_large_20230522` ~4.7 GiB kept AS-IS — lazy block streaming +
  IndexedDB cache + boot avoidance beat an image diet; decision
  2026-07-12). Each tier keeps its identity color everywhere on the page
  (DRS flag blue, DRC dark olive from drc.css); everything is
  direct-labeled, never color-alone. Linked from the account panel (after
  "The build story") and the /welcome/ landing cards. In user-facing copy
  the tiers' SHORT names are the slashed tokens **Se/rver** and
  **Se/cure** — NEVER the internal DRC/DRS acronyms (2026-07-12
  directive; the sweep that enforced it covered /architecture/, /help/,
  /welcome/, and the /cure page + drc.js popovers — see CLAUDE.md's
  amended branding rule).
- **Account panel** (`public/js/account.js`) is five views: the default
  view shows only the rolling 5-hour window (the one that actually gates
  the next message) and the **Feedback mode** knob (directly on the
  summary, NOT in Settings — deliberate placement; it toggles the body's
  `feedback-mode` class, revealing a Feedback button on EVERY assistant
  reply, existing ones included — the buttons are always in the DOM,
  `turns.js`, CSS shows them), plus navigation (Messages, Feedback, Full
  usage & history, Settings, About this project, The build story,
  The architecture story, Documentation, Admin, Sign out); "Full usage & history" drills into
  today/this-week/this-month (reuses the cached `/api/me` response);
  "Messages" is the message center; "Feedback" lists the user's feedback
  entries as dialogue threads with the development agent — reply box,
  Withdraw, unread-reply badge from `/api/me`'s `unread_feedback`
  (server side `src/feedback.js`; the agent side is the **feedback-loop**
  skill); "Settings" holds the other knobs (cloud/Shodan/Maps).
- **Message center** (`GET /api/messages`, `src/user-api.js` +
  `src/user-messages.js`): account-level notices for EVERY user — quota
  exhausted, quota available again, sign-in approved, quota changed by an
  admin — plus, for admins only, the same pending-approvals and
  operational-alerts data `/admin`'s Notifications section shows (fetched
  from a lighter `GET /api/admin/notifications`), so routine Approve/
  Dismiss doesn't require leaving the main app. **Zero-retention
  discipline**: the `user_messages` D1 table has no content column at
  all — only `type`/`period`/`kind` enums and timestamps ever get stored,
  nothing derived from a chat message or a model's answer, matching the
  privacy notice's promise that conversations are never stored. "Quota
  available again" isn't a separately logged event — a stored
  `quota_exceeded` row is annotated `resolved` at READ time by comparing
  its `(period, kind)` against the caller's CURRENT quota state
  (`src/quota.js`'s `quotaExceeded()`), so a lifted block resolves itself
  without a second write. Inserts are deduped per `(user, type, period,
  kind)` within a 1-hour window so a user hammering send while blocked
  gets one message, not one per attempt. Opening the list marks
  everything read; the header's notification badge (`/api/me`'s
  `notifications.total`) now applies to every identity, not just admins.
- **Privacy notice** on first visit (Berget/Exa processing, metadata-only
  logs, no stored conversations — except the ≤15 min answer-recovery
  buffer, disclosed in the notice); acknowledgement remembered for a year
  in the `dr_privacy_ack` cookie.
- **Public surface** (`isPublicAsset` in `src/assets.js`) — served without
  auth: branding (`/favicon.ico`, `/manifest.webmanifest`, `/icons/*` —
  iOS/Chrome fetch these *without* credentials, so gating them silently
  breaks PWA icons) plus the **promotional surface**: `/welcome/` (the
  landing page), `/help/`, `/build/`, `/story/`, `/architecture/`, the
  promo video
  (`/llm-assiterad-utveckling.mp4`), and the support files those pages
  render with (`/js/markdown.js`, vendored `marked`/`DOMPurify` — all
  public on GitHub anyway). The app itself and every `/api/*` stay gated.
- **Landing page** (`public/welcome/index.html`): signed-out visitors
  hitting `/` get this promotional page (hero, the promo video, cards to
  story/about/docs/GitHub, a sign-in CTA noting invite-only approval)
  instead of a bare login form; `/login` remains the explicit sign-in
  page and the target for auth bounces on other paths. Signed-in users
  at `/` get the app, as always.
- **First-visit onboarding animations (2026-07-12):** both tiers greet a
  first-time visitor once, gated by plain localStorage UI flags and
  replayable with `?anim=1`; both respect `prefers-reduced-motion` and
  are pure decoration (fully fail-soft, tap-to-skip/dismiss).
  - *Landing* (`dr_welcome_seen`, inline in `welcome/index.html`): the
    page wears the DRS glass header (ghost + account buttons — account
    goes to `/login`, ghost to `/cure`, with the app's glow/shimmer). A
    what-it-does/-doesn't overlay card shows first; dismissing it sends
    a little ghost mascot dancing in along the top (travel transition on
    the wrapper, dance keyframes on the SVG body, arm rotate to point),
    which points at the ghost button with a speech bubble explaining it
    as the door to DeepResearch.**Se/cure**.
  - *DRC* (`dr_umbrella_seen`, `public/cure/umbrella.js`, wired in
    `drc.js` boot — plays BEFORE the intro pane, never over a deep
    link): the logotype vortex → umbrella canvas animation. Pure
    timeline/geometry core (phase ramps in `paramsAt`, orthographic
    quarter-circle camera in `project`) is Node-tested in
    `public/js/umbrella-intro.test.js`; the canvas layer draws the
    fleet of spinning logo vortices that untwist into 8-panel
    beach-umbrella tops, get contours drawn while color drains, then
    tilt to a 3D side view (shaft + J-hook fade in) where the wireframe
    umbrellas spin, sway and sink. The FIRST tap stops and removes the
    overlay immediately (straight to cleanup + onDone — no fade to wait
    through), so it can never sit in the way of the page. PACE: the scene
    runs at `BASE_SPEED` (2.5× the original design — 2026-07-12 "make it
    2.5× as fast by default") times the admin's `anim_speed` site-config
    multiplier — the /admin Configuration slider ("Intro animation",
    log-scaled 4^(v/100) so ¼×–4× with the default exactly at center),
    served publicly at `GET /api/anim` (pre-auth route in src/index.js,
    60 s browser cache + the ~30 s config cache ⇒ ~90 s propagation);
    drc.js time-boxes that fetch to ~900 ms and falls back to 1, and
    umbrella.js clamps it (`clampAnimMult`, mirroring src/config.js's
    [0.25, 4] clamp). Speed scales the CLOCK, not the T marks.
- **History pane rows & the iOS paint constraint (2026-07-08):** each
  chat row is a swipe-to-reveal card (`history-ui.js`): swiping left
  slides the WHOLE card via inline `margin-left` (`.swiped` parks it at
  −88px) uncovering a lazily-mounted rename/🗑-delete strip; mouse
  devices get a hover fade-in overlay instead. HARD-WON RULES (four
  failed fixes on a real iPhone): (1) a row AT REST must be
  structurally identical to a project row — just the open button. A row
  that PERMANENTLY carries an absolutely-positioned (even `opacity: 0`)
  strip inside the backdrop-filtered `.history-panel` renders INVISIBLE
  on real iOS Safari (present in DOM, selectable, unpainted). (2) The
  slide must be pure LAYOUT (`margin-left`) — a `transform` on the
  card, even transient during the drag, breaks painting the same way
  (h7: card flickered, never moved). (3) The drag must be driven by
  TOUCH events with `preventDefault()` once claimed horizontal
  (`touchmove` registered `passive: false`) — pointer events +
  `touch-action: pan-y` are NOT honored for horizontal drags inside
  this vertically-scrollable panel on real iOS: Safari starts a native
  scroll, fires `pointercancel`, and stops delivering moves (h8/h9:
  list nudged down a few px, card never slid) — AND all DOM/style
  mutations must happen at `touchstart`, not at gesture-claim time:
  mutating mid-touch (mounting the strip, toggling overflow) makes iOS
  cancel the active touch (h10/h11). (4) Every style the interaction
  needs is INLINE (mountActions) so a device wedged on a stale
  stylesheet still gets working mechanics. (5) ALL hover behavior — JS
  handlers and CSS `:hover` rules alike, including `:hover` checks in
  cleanup code — is gated behind `matchMedia("(hover: hover)")` /
  `@media (hover: hover)`: iOS fires mouse-compat events on taps and
  its emulated hover sticks to the last-touched card for SECONDS
  (traced `mouseleave` 14s late), producing phantom buttons and stuck
  highlights (h15/h16). (6) `flex: 1; min-height: 0` on a list inside
  the panel's `overflow-y:auto` flex column collapses it on iOS and
  paints cards over the panel's other children (the original "text in
  the background" report) — the panel scrolls as a whole instead. A
  vertical scroll gesture closes any swiped-open card (iOS-Mail
  convention). Linux WebKit reproduces NONE of these, and
  synthetic-event tests bypass native gesture arbitration —
  desktop/Playwright green means nothing here; verify on a real
  device. The debug trace overlay was removed in h17 (git history has
  it); the `[hN · …]` stamp line stays — see the **on-device-trace**
  skill before removing it. All interaction artifacts
  (strip, `overflow: hidden`, transform, transition) are mounted at
  gesture-claim and removed on close. The pane also self-diagnoses: a
  bracketed status stamp (`[h7 · N here + M in projects · cloud: …]`)
  always renders at the pane bottom (build marker + local/undecryptable
  counts + the `pullNewer` checked/restored/failed summary), and every
  empty-list cause gets an explicit note (undecryptable records,
  settings not loaded, knob off, restore failures). Bump the stamp AND
  the `--css-version`/`CSS_VERSION` handshake pair (app.css ↔ app.js —
  it force-reloads a stale cached stylesheet, which the boot guard's
  module-graph repair does not cover) whenever CSS and JS must move
  together.

## The image deck (public/js/imagedeck.js)

Requested 2026-07-09: the Street View/map frame strips became one
conversation-wide, ordered IMAGE DECK with an enlarged slideshow.

- **Registration**: `renderStreetViewFrames` (activity.js) pushes every
  rendered frame into the deck (`addDeckEntries` — url, caption, and the
  optional per-frame `lat`/`lng`/`kind:"map"` the server now sends on
  `streetview_frames`; see the **sse-protocol** skill). Thumbnails get
  `cursor: zoom-in` and click-open the deck at themselves.
- **The lightbox** (`openDeck`): enlarged image, ‹/›/arrow-key navigation
  AND touch swipe (horizontal, 40px threshold, the ask input excluded —
  added 2026-07-09 after "can't swipe back or forth") across EVERY image
  the conversation has produced (in order), Escape or backdrop click
  closes, "N / M" position. Upper-left MINI-MAP of the
  current image's position: a free Maps Embed iframe with
  `pointer-events: none` inside an `<a>` to the keyless Google Maps link
  — the iframe paints, the link takes the click (no key → a plain
  "Open in Google Maps" link stands; map-kind entries skip the iframe,
  the big image IS a map). Styles: `.imagedeck-*` in app.css.
- **Per-image chat panel**: the input at the lightbox's bottom submits
  through app.js's `onDeckAsk` wiring → for a PHOTO image,
  `setPovAnchor(point)` (activity.js: sets `currentPov` to the image's
  position AND heading — frames carry per-frame `heading` from the
  server since 2026-07-09 — so the server's POV path reproduces EXACTLY
  that frame, answers about it, and renders a fresh Street View there
  as the new current location); for a MAP image, `setMapViewAnchor`
  (map_view, zoom 17). Then the ordinary composer submit — the whole
  anchor machinery (moves, nearby search, here-asks, scene captures)
  continues from that point with no new server protocol. The loose
  scene gate routes image-referential questions ("What do we have
  here" — English "here" gained parity with Swedish "här" the same
  day); non-visual questions go to ordinary research, by design.
- **Waypoints on the interactive map**: plain NUMBERED pins (image
  miniature markers were tried 2026-07-09 and removed by explicit
  decision 2026-07-10 — they cluttered the map); clicking a pin still
  opens the deck at that stop's image when `nearestDeckIndex(p, 30m)`
  finds one (the LATEST image within the radius wins, not the closest). Jump and nearby-place
  destinations now ALWAYS emit their frame (previously only as the
  no-embed-key fallback) so every stop has a deck image.
- **Scope**: the deck is conversation-scoped and live-session only —
  `resetStreetViewPov()` (new chat / conversation switch) also calls
  `resetDeck()`, and data URLs are never persisted (a reloaded
  conversation keeps answers and links, not imagery — same as the
  strips themselves). Pure registry core is Node-tested
  (imagedeck.test.js).
