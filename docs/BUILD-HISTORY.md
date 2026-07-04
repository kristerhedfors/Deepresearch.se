# Build history — Deepresearch.se

The complete, chronological record of how this site was built in a single
session with Claude Code (model `claude-fable-5`, briefly `claude-opus-4-8`
mid-session): every prompt as it was written, what was done in response,
what broke, what was discovered, and the commit that landed each step.

**The whole thing happened in one day.** First commit 2026-07-04 11:54,
final commit 2026-07-04 22:11 — roughly ten hours from "Deploy hello world"
to a deployed deep-research assistant with a five-phase pipeline, time
budgeting, PWA support, image input, and a fully modular codebase. 35
commits, all pushed straight to `main`, each one verified live before the
next prompt.

> **One redaction.** The prompt in step 8 originally contained the site's
> Basic Auth password in plain text. Two prompts later it was deliberately
> moved out of the repo into Cloudflare Worker secrets, so it is redacted
> here as `djup:<redacted>`. Everything else is verbatim.

---

## Phase 1 — Getting anything on the internet (11:54–12:31)

### 1. "Deploy hello world"

The repo was empty except for the initial commit. A minimal static page was
created and a first deploy attempted via Cloudflare.

- Commits: `5cd1b6c` (Initial commit), `e59f779` (Deploy hello world web app)

### 2. "Make it clear in CLAUDE.md that we always push straight to main after every change"

Project process decision, recorded permanently: no feature branches, no PRs
— every change commits and pushes to `main` immediately. This rule governed
all 30+ commits that followed.

- Commit: `54a66b0`

### 3. "Its not on the web, whats wrong with" + a pasted Cloudflare build log ending "Failed: error occurred while running deploy command"

First real failure. The Cloudflare git-connected build couldn't find
anything to deploy. Diagnosis from the pasted log: the deploy command
expected a static-assets layout that didn't exist yet.

- Fix 1: add a proper static `index.html` (`601bc31`)
- Fix 2: add `wrangler.toml` with an `[assets]` block pointing at `public/`
  and move the page there — the error "Could not detect a directory
  containing static files" went away (`93abdcf`)

### 4. "Workers page works but not for my domain. Also we will want lots of active content not just static, this will be an ai chatbot, tellme which creds to set up"

Two things at once:

- The site worked at `*.workers.dev` but not at `deepresearch.se` — fixed by
  adding custom-domain routes for the apex and `www` to `wrangler.toml`
  (`b5f6900`).
- Forward planning for the chatbot: the answer at this point was an
  Anthropic-style API key. (This turned out to be wrong for this project —
  see step 8, where the provider became Berget.ai.)

### 5. "Added manually but also add as code and push!!!" — followed by an interrupt: "Push to main!!! Should be clear from claude.md!!!"

The routes had been added by hand in the dashboard; the same config was
committed as code. The interrupt is worth retelling: the push-to-main rule
had been written into CLAUDE.md two prompts earlier, and this was the moment
it got enforced with three exclamation marks. It never needed enforcing
again.

### 6. First chatbot: "Cloudflare worker settings says secrets cannot be configured for sites with only static content"

A streaming chatbot Worker was written (at this point still targeting the
Claude Messages API, `c55044c`). But the Cloudflare dashboard refused to
accept secrets: **an assets-only Worker has no Variables & Secrets section**.
The discovery: adding a `main` script entry to `wrangler.toml` (a real
Worker, not just static assets) unlocks the secrets UI. This is also what
made `run_worker_first = true` possible later, so Basic Auth could cover the
static assets too.

---

## Phase 2 — Berget.ai, auth, and web search (13:08–13:55)

### 7–8. "We're using berget.ai so we have BERGET_API_TOKEN configured for the worker, make this clear in claude.md, set basic auth djup:\<redacted\> and allow basic llm queries to Mistral Small which is available in their model repo"

Provider decision: **Berget.ai, not Anthropic** — an OpenAI-compatible API
at `https://api.berget.ai/v1`, EU-hosted, with `mistralai/Mistral-Small-3.2-24B-Instruct-2506`
as the default model. The Worker was rewritten to speak OpenAI-style
`POST /v1/chat/completions` with `stream: true` and SSE deltas
(`choices[0].delta.content` … `data: [DONE]`). HTTP Basic Auth was added in
front of everything.

- Commit: `4b67b4f`

### 9–10. "Move to secrets" / "Those are now secrets in cloudflare worker"

The Basic Auth credentials had initially been set as plain vars. They were
moved to Worker secrets (`BASIC_AUTH_USER` / `BASIC_AUTH_PASS`) and the code
changed to **fail closed**: if either secret is unset, every request is
denied rather than the site falling open. This is why the password is
redacted in this document — it exists only as a secret now.

- Commit: `85c139b`

### 11. "We will use exa for web search, we have EXA_API_KEY Configured for cloudflare worker and this is exa's integration prompt. Persist valuable knowledge in claude.md: …" (full Exa API guide pasted)

Exa web search added as a tool the model could call:
`POST https://api.exa.ai/search` with `x-api-key`, `type: "auto"`,
`numResults: 5`, and `contents: { highlights: true }` (token-efficient
excerpts instead of full page text). The pasted integration guide's key
gotchas were persisted into CLAUDE.md: `highlights`/`text` must be nested
under `contents` on `/search`, `useAutoprompt` is deprecated, use
`includeDomains` not `includeUrls`. Discovered empirically: Exa returns
HTTP 402 when the key is missing.

- Commit: `8bfaaf9`

### 12. "Refactor for clarity, maintainability and production level logging"

First refactor: the single Worker file was split into modules
(`index/auth/chat/berget/exa/log/http`), and structured JSON logging was
added — one object per line with `{time, level, event, request_id}`, a
`LOG_LEVEL` var, an `x-request-id` response header for correlating logs,
and a privacy rule that still holds: **never log secrets or message
content**; user text only at `debug`, `info`+ carries counts, durations,
statuses, token usage.

- Commit: `1a63507`

---

## Phase 3 — Becoming a *deep research* product (14:24–15:16)

### 13. "Add live indicators showing when content is fetched and some numbers and expandable info while waiting so user sees whats going on"

Custom `status` events were added to the SSE stream alongside the text
deltas — `search_start` / `search_done` with query, result count, duration
and an expandable source list; a `done` event with model, rounds, tokens,
CO₂. The UI renders them as live step bars with spinners that resolve to
checkmarks. Clients ignore unknown status types, which kept every later
pipeline change backward-compatible.

- Commit: `7aa2835`

### 14. "Site name is deepresearch so thats what we want with follow-up questions if needed"

The product thesis, in one sentence. The system prompt was rebuilt around
deep research: ask a clarifying question when the request is ambiguous,
otherwise search, then answer with citations.

- Commit: `ef0601a`

### 15. A model misbehaves: `fc4cc23`

Discovered in live testing: Mistral Small sometimes emitted its tool call
as *text* — literally printing `web_search{"query": …}` into the answer —
instead of using the function-calling channel. Users saw JSON garbage. The
immediate fix detected the pattern, discarded the garbled text via a new
`discard_text` status event, executed the search anyway, and recovered.
(The real fix came in step 18: stop depending on function calling
entirely.)

- Commit: `fc4cc23` (Handle Mistral pseudo tool calls; recover instead of showing garbage)

### 16. "add a model dropdown so I can select among the available models on Barriatoil"

("Barriatoil" = voice-input rendering of *Berget.ai* — prompts in this
session were often dictated.) A `GET /api/models` endpoint was added that
proxies Berget's catalog, filtered to text models supporting streaming +
JSON mode, cached ~5 min per isolate. The client dropdown persists the
selection in `localStorage`; the Worker validates the requested model (400
on unknown) and falls back to the default if the catalog is unreachable.

- Commit: `cdb4da1`

### 17. "Did you not add the g l m five point two? Make sure to check the model's a p i to see which models are available."

GLM-5.2 seemed to be missing from the dropdown. Checking the live API
showed it *was* in the catalog but with `status.up: false` (maintenance) —
the filter had been hiding down models entirely. Changed to include them
greyed out and disabled, so they become selectable automatically the moment
Berget brings them back.

- Commit: `5e347d0`

### 18. "Make sure deep research has a well designed algorithm with search iterarions and post validation"

The biggest single change of the session. The chat handler was rebuilt from
a model-driven tool-call loop into a **Worker-orchestrated five-phase
pipeline** with no function calling at all — every phase is a direct
JSON-mode call, so it's deterministic and works on any JSON-mode model
(this also permanently killed the pseudo-tool-call bug from step 15):

1. **Triage** (JSON): direct reply | one clarifying question | research plan
   with 2–4 queries covering different angles
2. **Search wave**: planned queries via Exa, deduped, capped
3. **Gap check** (JSON, iterated): audit coverage, run follow-up queries for
   missing angles
4. **Synthesis** (streamed): answer built ONLY from a numbered source
   registry, `[n]` citations + a "Sources:" list
5. **Post-validation** (JSON): fact-check the draft against the sources; on
   "revise" the UI discards the draft (`discard_text`) and streams the
   corrected answer

Helper phases fail soft — a broken triage or validation degrades the answer,
never the request.

- Commit: `1b9edb1`

---

## Phase 4 — Images, and a mobile bug hunt (15:35–18:01)

### 19. "Add the support to attach images for models that support image input."

Vision support: models exposing `capabilities.vision` accept OpenAI-style
multimodal content (`image_url` with a data URI). The Worker rejects images
sent to non-vision models with a 400 that lists vision-capable
alternatives. Image parts of the latest user message are forwarded to the
synthesis phase so research can use them; the text-only JSON helper phases
see an `[N image(s) attached]` marker instead.

- Commit: `6b66151`

### 20. "File upload button does nothing at the moment on mobile."

The attach button was `disabled` with a hover tooltip on non-vision models
— which on a touch device means *nothing happens and nothing explains why*.
Tooltips don't exist on touch. Fixed by keeping the button tappable but
dimmed, offering a one-tap confirm to switch to a vision-capable model.

- Commit: `3dc7d03`

### 21. "Check logs for the error"

Uploads from a phone *still* failed. The structured logs (found via the
`x-request-id` header) showed Berget rejecting the request:
**"Request payload too large"**. The limit isn't documented, so it was
bisected live against the API: a 1.0M-character body succeeded, 1.2M was
rejected — Berget caps request bodies around 1 MB, and a single phone photo
as a base64 data URI blows straight past that.

The fix went in on both sides:

- **Client**: downscale before attaching — canvas → JPEG, max 1280px, a
  quality ladder targeting ≤280K chars per image and ≤700K per message; and
  strip images from all but the latest message when resending history.
- **Server** (`src/chat.js`): hard caps — 4 images/message, 8/request, 300K
  chars/image, 750K total.

- Commit: `08ce6a0`

---

## Phase 5 — Identity: icon, theme, PWA (18:52–19:33)

### 22. A grid of candidate icons was attached: "Upper row second from left, use that as our PWA and site icon"

First icon pass: favicon, PWA manifest, `icon-192`/`icon-512`, maskable
variant, apple-touch-icon.

- Commit: `0d8c767`
- (Model was switched to `claude-opus-4-8` and back to `claude-fable-5`
  around here via `/model`; "Push to main when done" kept the workflow.)

### 23–24. "Not good, use this ‹ChatGPT image link›" → "This is the one and dont crop it, this is what we want: ‹ChatGPT image link›"

Two rounds of icon iteration, sourced from ChatGPT-generated artwork: first
the flat flag-swirl version (`b2f50aa`), then the final airbrushed swirl,
full-frame and uncropped (`c4a1d0a`).

### 25. "The sky blue at the outer edges, lets have this as the background color of deepresearch.se. Also, when we need an icon showing processing is ongoing, we want a tiny version of this symbol pulsating in and out with each pulse screwing the inner twisted yellow spiral inward and outward"

The icon became the design system: its edge color (`#6fc3fd`) became the
site background, and the processing indicator became a tiny version of the
icon animated with a custom `pulse-screw` keyframe — scaling in and out
while rotating, so each pulse "screws" the spiral inward and outward.

- Commit: `be035bb`

### 26. Markdown answers: `860fe8b`

Full-width answer bubbles and **Markdown rendering by default** (the
synthesis prompt asks for Markdown). Rendering is client-side with
*vendored* `marked` + `DOMPurify` — no CDN, so everything stays behind
Basic Auth. Sanitization is non-negotiable: answers can quote hostile web
content, and `<img>` is forbidden outright so rendered answers can't fire
third-party requests (tracking pixels). Each answer got Raw and Copy
buttons.

- Commit: `860fe8b`

---

## Phase 6 — PWA reality check (20:15–20:25)

### 27. "Call this branch golden-saturday as a checkooint. Remove sub title 'deep research', title already says that. Collapse all research action bars to one expandable once conplete answer is produced, we only want them all showing during ongoing research"

A checkpoint branch `golden-saturday` was created (the one exception to
main-only, explicitly requested as a snapshot). The header subtitle was
removed and the live activity bars now collapse into a single expandable
"Research process · N steps · M searches" bar once the answer completes.

- Commit: `a8a4afe`

### 28. "Pwa icon is not there"

Installed the PWA — no icon. Root cause: **iOS fetches `apple-touch-icon`
and Chrome downloads manifest icons *without* credentials**, so behind
Basic Auth every icon request silently 401'd. Fix: `isPublicAsset` in
`src/index.js` exempts `/favicon.ico`, `/manifest.webmanifest`, and
`/icons/*` from auth — branding only, nothing sensitive.

- Commit: `95ed330`

### 29. "Just a black screen when opening from pwa"

The nastier sibling of the same problem: a standalone PWA **cannot show the
native Basic Auth dialog** — the 401 challenge renders as a black screen on
iOS. Fix: a second auth mechanism with the same credentials. Unauthenticated
HTML navigation now gets a real login page (`/login`, `src/login.js`);
success sets a signed 30-day `dr_session` cookie (`exp.hmac(exp)`, HMAC
keyed from the credential pair, so rotating the password invalidates every
session). Basic Auth still works for curl and scripts. No
`WWW-Authenticate` challenge is ever emitted.

- Commit: `49a7c2d`

---

## Phase 7 — The time-budget engine and controls row (20:46–21:57)

### 30. "Onsce expanded post research completion the search status bars cannot be collapsed back to a single bar again... we want a slider just below the output window aboveninput field and send button covering the width of the screen to set the estimated time to spend while searching. Make an accurate estimation on how to conduct search based on logged history... Careful algo design required"

Two items:

- **Bug**: after collapsing, re-expanding the activity bars made the summary
  bar `display:none`, so the group couldn't be folded back. Fixed with a
  `.done` class that keeps the summary bar visible in both states.
- **Feature**: the research-time slider, backed by `src/budget.js` — the
  "careful algo" prompt produced per-model **EWMA statistics** of each
  pipeline phase's duration (alpha 0.3, seeded with measured priors, per
  isolate, fed by every completed phase). The planner allocates a requested
  budget statically — triage + synthesis always paid, validation reserved
  next as the quality gate, ~60% of the remainder buys 1–4 search angles,
  the rest buys gap rounds — plus runtime deadline checks between phases
  (budget +15% grace; extra gap rounds are cut first, validation last, with
  a visible "Validation skipped" step when it happens).

- Commit: `a636645`

### 31. "Add clear chat button, and exa web search knob on/off, enabled by default. If off the ONLY use berget.ai to produce response. Also add data privacy info on first visit then remember in a cookie"

New chat button; a web-search toggle (off → the Worker skips triage/Exa
entirely and streams a single Berget completion); and a first-visit privacy
notice (Berget/Exa processing, nothing stored server-side, metadata-only
logs) remembered for a year in the `dr_privacy_ack` cookie.

- Commit: `ce3ca76`

### 32. "Web search shall be just a round knob in a placeholder for a knob to be in one of two positions. Have research time show to the left of slider and have just a symbol with popup info about web search to save space. Also remove text 'research time', just have a clock symbol and the numbers to the left of slider"

Controls-row compaction: the toggle became a round two-position knob in a
track, web-search info moved into a 🔍 symbol with a popup, and the label
text was replaced by a clock symbol plus the numeric value.

- Commit: `eb55cf4`

### 33. "Also prevent east-west scrolling entirely. Also, scrolling back while generating pops back down when releasing finger from screen. Instead stay where you are and have a down arrow button appear bottom right corner which takes you back, or just scroll to the bottom shall also attach and follow continued generation."

Horizontal scrolling eliminated (wide content scrolls inside its own
container, never the page). Streaming became reading-safe: scrolling up
during generation *detaches* auto-follow and stays put; a down-arrow button
appears bottom-right to jump back; scrolling to the bottom manually
re-attaches follow. One subtle bug found here: the jump used smooth
scrolling, and the animation itself re-triggered the "user scrolled"
detector, detaching follow again — fixed by jumping with an instant
`scrollTop` set instead.

- Commit: `dd146fc`

### 34. "Let the knob on the slider be the clock symbol and thus remove current clock symbol to free up space for a wider slider. Allow slider to reach 10min with slightly exponential scaling, we want higher granularity in the lower end but top out at 10min at high end" — "Yes! Word! Also use the common new chat symbol instead of the text 'new chat'"

The slider thumb became the clock (SVG data-URI thumb), the freed space
widened the slider, and the scale became **quadratic**: position 0–100 maps
to 15 s–10 min with fine granularity at the low end, snapping to
human-friendly increments (5 s / 15 s / 30 s by range). Research depth
scales with the budget (up to 6 query angles, 4 gap rounds, 20 searches at
the top end). "New chat" text became the standard compose icon.

- Commits: `1624122`, `a80f206`

---

## Phase 8 — Final refactor and this document (22:11)

### 35. "Refactor for code clarity, modularity and maintainability"

Both sides restructured:

- **Server**: `src/chat.js` shrank to a ~110-line handler
  (parse → validate → resolve model → stream pipeline → stats). The pipeline
  moved to `src/pipeline.js`, prompts to `src/prompts.js`, message/image
  validation to `src/validation.js`, conversation helpers to
  `src/conversation.js`.
- **Client**: the inline monolith became `public/js/` ES modules — `app.js`
  (state + wiring + SSE), `turns.js` (bubbles, Raw/Copy), `activity.js`
  (step bars, stats, collapse), `markdown.js` (sanitized rendering),
  `timescale.js` (the quadratic scale, pure functions) — with all CSS in
  `public/css/app.css` and `index.html` down to 72 lines of markup.

Verification caught two things before push: a **prompt template bug**
(`${maxQueries}` inside a single-quoted string would have reached the model
literally — fixed to a template literal), and three Playwright browser-test
failures that turned out to be stale tests (they predated the privacy
overlay and the knob redesign), not product bugs — the tests were updated
(pre-set the ack cookie, click the knob track).

- Commit: `01ee273`

### 36. "Save this entire prompt history to disk in the repo, I will write something on linkedin about it and need the entire history from start to finish and the exact steps stored to be able to retell in detail"

This document.

---

## How every step was verified

No change was declared done on faith:

- **Live curl probes** against `https://deepresearch.se` with Basic Auth —
  status codes, SSE event streams, `/api/models` output, auth behavior
  (including confirming the 401-without-challenge and public-asset paths).
- **Playwright browser tests** (Chromium in the sandbox) against a local
  copy of the UI — send flows, activity bars, knob/slider interactions,
  scroll behavior, privacy overlay.
- **Structured logs** in the Cloudflare dashboard, correlated by the
  `x-request-id` response header. (Live `wrangler tail` wasn't possible
  from the sandbox — no API token and `api.cloudflare.com` blocked by the
  egress proxy — so the dashboard was the log surface.)
- **`npx wrangler deploy --dry-run`** to validate config before pushes that
  touched `wrangler.toml`.

## The discoveries worth retelling

1. **An assets-only Cloudflare Worker can't hold secrets** — you must add a
   `main` script before the Variables & Secrets UI appears.
2. **PWAs and Basic Auth are enemies twice over**: icon fetches go out
   without credentials (silent 401 → no icon), and a standalone PWA can't
   render the native auth dialog (black screen). The fixes are public
   branding assets and a cookie-based login page beside Basic Auth.
3. **Berget rejects bodies over ~1 MB**, undocumented — found by bisecting
   live (1.0M chars OK, 1.2M rejected). Phone photos need client-side
   downscaling before this is usable on mobile.
4. **Small models fake tool calls as text.** The durable fix wasn't
   detection — it was removing function calling from the architecture:
   a Worker-orchestrated pipeline of direct JSON-mode calls is
   deterministic and works on any JSON-mode model.
5. **Don't hide down models** — grey them out. GLM-5.2 "missing" was
   actually `status.up: false`; hiding it just looked like a bug.
6. **Touch devices have no tooltips.** A disabled button with a hover hint
   is a dead button on mobile.
7. **Smooth scrolling can fight your own scroll detector** — an animated
   jump-to-bottom re-triggered the "user scrolled away" logic; instant
   `scrollTop` didn't.
8. **EWMA phase timings beat guessing**: seeding per-model duration stats
   with measured priors and updating on every completed phase makes a time
   budget you can actually plan against.

## Full commit ledger

| # | Commit | Time | Subject |
|---|---|---|---|
| 1 | `5cd1b6c` | 11:59 | Initial commit |
| 2 | `e59f779` | 11:54 | Deploy hello world web app |
| 3 | `54a66b0` | 11:55 | Document git workflow: push straight to main after every change |
| 4 | `601bc31` | 12:06 | Add static index.html for Cloudflare Pages |
| 5 | `93abdcf` | 12:17 | Configure Cloudflare Workers static assets deploy |
| 6 | `b5f6900` | 12:31 | Add custom domain routes to wrangler config |
| 7 | `c55044c` | 12:52 | Add streaming AI chatbot Worker (Claude Messages API) |
| 8 | `4b67b4f` | 13:08 | Switch chatbot to Berget.ai + add Basic Auth |
| 9 | `85c139b` | 13:10 | Move Basic Auth credentials to secrets (fail closed) |
| 10 | `8bfaaf9` | 13:45 | Add Exa web search as a tool for the chatbot |
| 11 | `1a63507` | 13:55 | Refactor Worker into modules; add production structured logging |
| 12 | `7aa2835` | 14:24 | Add live activity indicators to the chat UI |
| 13 | `ef0601a` | 14:33 | Make the assistant a deep-research bot with clarifying follow-ups |
| 14 | `fc4cc23` | 14:36 | Handle Mistral pseudo tool calls; recover instead of showing garbage |
| 15 | `cdb4da1` | 14:52 | Add model dropdown backed by Berget's model catalog |
| 16 | `5e347d0` | 14:59 | Show down models greyed out instead of hiding them (e.g. GLM-5.2) |
| 17 | `1b9edb1` | 15:16 | Rebuild deep research as an orchestrated pipeline with validation |
| 18 | `6b66151` | 15:35 | Add image attachments for vision-capable models |
| 19 | `3dc7d03` | 15:47 | Fix attach button dead on mobile for non-vision models |
| 20 | `08ce6a0` | 18:01 | Fix mobile image uploads: compress client-side for Berget's ~1MB body limit |
| 21 | `0d8c767` | 18:52 | Add site icon and PWA support (flag-swirl icon, manifest) |
| 22 | `b2f50aa` | 19:00 | Replace site/PWA icon with the flat flag-swirl artwork |
| 23 | `c4a1d0a` | 19:17 | Use the airbrushed swirl artwork as the icon, full frame and uncropped |
| 24 | `be035bb` | 19:23 | Sky-blue theme from the icon + pulsating icon as processing indicator |
| 25 | `860fe8b` | 19:33 | Full-width answers, markdown rendering by default, Raw/Copy tools |
| 26 | `a8a4afe` | 20:15 | Remove header subtitle; collapse activity bars after the answer |
| 27 | `95ed330` | 20:20 | Serve icons and manifest without Basic Auth so PWA icons work |
| 28 | `49a7c2d` | 20:25 | Fix PWA black screen: login page + session cookie alongside Basic Auth |
| 29 | `a636645` | 20:46 | Fix activity re-collapse; add research time-target slider with budget planner |
| 30 | `ce3ca76` | 20:53 | Add clear-chat button, web-search on/off knob, first-visit privacy notice |
| 31 | `eb55cf4` | 21:04 | Compact controls row: round two-position knob, info symbol, clock + value |
| 32 | `dd146fc` | 21:09 | No horizontal scrolling; reading-safe streaming with jump-to-latest |
| 33 | `1624122` | 21:52 | Clock-symbol slider thumb; quadratic time scale up to 10 minutes |
| 34 | `a80f206` | 21:57 | Scale research depth with the time budget; icon for New chat |
| 35 | `01ee273` | 22:11 | Refactor server and client for clarity, modularity, maintainability |

*(All times 2026-07-04, commit-author local time. The first two commits'
timestamps are out of order because the GitHub-generated initial commit was
merged after work had started.)*
