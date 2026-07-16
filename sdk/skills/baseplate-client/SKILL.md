---
name: baseplate-client
description: >-
  Load when building or modifying the browser chat shell — the no-build
  ES-module client both tiers share the shape of: the markup-only page, the
  glass-chrome layout, composer/turns/markdown rendering, the SSE line-buffer
  parser, the history sidebar and encrypted local store, the cached settings
  client, attachments with client-side parsing, and the localStorage
  first-paint mirrors. Also load when deciding what belongs in a pure
  `-core.js` module, when a client feature needs Node unit tests, or when
  devices show stale/mixed client code after a deploy.
---

# Baseplate client — the browser chat shell

The client is a static page plus plain ES modules: no bundler, no
transpiler, no framework — the bytes in the repo are the bytes the browser
runs. This module builds the chat shell both tiers are made of: a
markup-only HTML page, one stylesheet, a bootstrap module that wires
everything, a send loop that streams SSE into rendered turns, sanitized
markdown, an encrypted history sidebar, a cached settings client, and
attachment slots. Its central discipline is the **pure-core convention**:
every piece of client logic that can be expressed without a DOM lives in an
import-safe companion module and is unit-tested in Node, leaving only thin
DOM glue unverifiable by `npm test`.

## Capability class & tier story

Manifest class: **C — client-pure.** The shell itself must be servable by
any static host.

- **Client tier**: the shell IS the product — composer, turns, history, and
  settings all work against browser-direct providers and browser-local
  storage; nothing in the module graph may import a class-S module or call
  an authenticated endpoint (pinned by the derived-graph test, see
  `pair-architecture`).
- **Server tier**: the same shell shape talks to the worker's chat endpoint
  over SSE and to the authed settings/history-key APIs. The two tiers are
  deliberate look-and-feel twins (same chrome, composer, knobs — distinct
  palettes), so shared shell logic is written once and tier-specific wiring
  stays in each tier's page module.
- Class-X cores live under the client tree because the browser can only
  import SERVED modules while the worker's bundler can import from anywhere
  — the client tree is the one place both tiers can reach.

## Contracts

- **PA-4** — sanitized rendering of hostile content (answers quote the web),
  encrypted-at-rest local history with the key held only in memory, images
  stripped from resent history, and metadata-only persistence markers —
  the client holds its half of the privacy split.
- **PA-5** — no build step is load-bearing: vendored libraries (never CDN),
  plain ES modules, dev-only tooling; heavy vendored libs are lazy-loaded at
  first use so the normal page load never pays for them.
- **PA-7** — the pure-core convention is this module's export to every later
  client feature: logic in an import-free `-core.js`, DOM glue thin, Node
  tests against the core.
- **PA-2** — client helpers fail soft: a torn SSE frame, a private-mode
  storage throw, or a missing settings answer degrades the experience, never
  kills the render loop or the send path.
- **PA-10** — DOM/`<canvas>`/parser behavior that Node cannot exercise is
  verified live on real devices; visible build stamps and client telemetry
  beacons exist to make that possible.

## Build plan

1. **`public/index.html`** — markup ONLY: header bar (brand wordmark, header
   buttons), the chat container, the composer form, the history drawer
   shell. No styling, no behavior. The only permitted inline scripts are
   tiny first-paint bootstraps (step 10), each with a recorded CSP hash.
   PWA affordances: manifest link (with `crossorigin="use-credentials"` on
   the authed tier — manifest requests are credential-less by default and
   401 silently), apple-touch icons, theme-color.
2. **`public/css/app.css`** — the one stylesheet. Glass-chrome conventions,
   high level: fixed, click-transparent header/footer strips
   (`pointer-events: none`) whose glass ITEMS re-enable pointer events;
   content scrolls beneath; the composer is one glass pane
   (`backdrop-filter: blur(…) saturate(…)`); palette in CSS custom
   properties on `:root` so a tier or mode re-skins by swapping variables,
   not rules. Keep a CSS↔JS version handshake (a `--css-version` custom
   property the bootstrap compares) so a stale stylesheet with fresh modules
   is detected and force-reloaded.
3. **`public/js/sse.js`** — the SSE line-buffer parser as a PURE module (the
   smallest exemplar of the convention): `createSseParser()` returns a
   stateful `{push(chunk) → events[]}` that carries a partial trailing line
   between reads, ignores comment/keepalive lines and the `[DONE]`
   terminator, and DROPS malformed JSON rather than throwing — a torn frame
   must never kill the render loop. ~30 lines, fully Node-tested.
4. **`public/js/markdown.js`** — sanitized rendering wrapping the VENDORED
   globals `marked` + `DOMPurify` (classic scripts in `public/vendor/`,
   loaded before the app module; no CDN — everything stays same-origin and
   behind auth). Sanitization is mandatory: answers can quote hostile web
   content — `DOMPurify.sanitize(marked.parse(text), {FORBID_TAGS:["img"]})`
   with any image allowance an explicit, same-origin allowlist. Include a
   pure `normalizeLlmMarkdown` repair pass for the malformed-markdown
   classes real models emit (the reference: a whole GFM table streamed with
   rows joined by `||`), no-op on well-formed text, Node-tested. Fall back
   to plain text if a vendored lib is missing.
5. **`public/js/message-content.js`** — the outgoing-message pure core:
   labeled context-block builders (attached document / image metadata /
   retrieval excerpts — each block clearly delimited, never silently blended
   into the user's text), title derivation, `stripOldImages` (images ride
   only on the latest turn when resending history — provider body caps),
   and the plain-text conversation export. Import-free, Node-tested.
6. **`public/js/turns.js`** — turn rendering: user bubbles, assistant turns
   (activity slot + streamed content + per-turn tools like Raw/Copy),
   reconstruction of a stored conversation on load. Initialized once with
   the chat container and a scroll callback — it never reaches for globals.
7. **`public/js/stream.js`** — the send loop: owns the conversation array,
   drives one chat request per send (fetch → read loop → `sse.js` parser →
   dispatch events to turns/activity renderers), autosaves after every
   turn, and owns the error paths (abort, network death, backgrounded-tab
   suspension). Reading-safe streaming: scrolling up detaches auto-follow;
   a jump-to-latest button appears; bottom re-attaches.
8. **`public/js/history-store.js` + `history-ui.js`** — encrypted local
   history: conversations in IndexedDB (not localStorage — size + async
   API), AES-256-GCM under a key fetched from the server tier once per page
   life and held ONLY in memory (never persisted beside the ciphertext —
   PA-4); the sidebar lists/renames/deletes/loads. Declare any readable
   exception explicitly (the reference: RAG-indexed project chats rest
   readable, because the index already holds their text). On the client
   tier the store is the sealed-state adapter instead — same sidebar, a
   different storage module behind it.
9. **`public/js/settings.js`** — the cached settings client: one fetch,
   memoized promise, and SYNCHRONOUS question functions
   (`storageAvailable()`-style) so hot paths never await a fetch. Staleness
   window accepted and self-healing: another device's flip lands on next
   load, and the server rejects writes its own copy forbids.
10. **First-paint localStorage mirrors** — for any knob that must apply
    BEFORE the settings fetch resolves (a theme class, a capability that
    needs page-level headers), mirror the server knob into localStorage and
    apply from the cache synchronously: a tiny inline `<script>` in `<head>`
    at parse time (theme class before first paint), the module-top apply in
    the bootstrap, then reconcile when settings resolve — server
    authoritative, cache follows. One module per knob
    (`dev-mode.js`/`sandbox-mode.js` pattern), import-safe in Node with
    every `document`/`localStorage` access guarded and failing soft to
    "off".
11. **`public/js/attachments.js`** + optional parser slots — pending
    images/documents state and the composer card row; images downscaled
    client-side via canvas to fit provider body caps
    (`image-downscale.js`); optional, independently-droppable parsers:
    `docs.js` (docx as a ZIP read with `DecompressionStream` — no library),
    vendored `pdf.js` for PDFs, `exif.js` (hand-rolled TIFF/EXIF walk for
    GPS/camera/timestamp). Every parser's pure logic is Node-testable
    (`File`, `Blob`, `DecompressionStream`, `TextDecoder` are standard Node
    globals); only canvas/pdf.js rendering needs live verification.
12. **`public/js/app.js`** — bootstrap and wiring ONLY: apply the cached
    mirrors, wire scrolling/composer/knobs/submit, call each module's
    initializer, kick off the settings fetch and reconcile. Keep it a
    module map with wiring — logic that grows here moves out.
13. **Tests** — `public/js/*.test.js` run by the SAME root `npm test`
    (`node --test src/*.test.js public/js/*.test.js`): sse parser
    (partial-line carry, keepalive/[DONE] filtering, malformed tolerance),
    message-content builders, markdown normalizer, mirror modules,
    attachment parser pure cores. No DOM emulation dependency — if a test
    needs a DOM, the logic under test belongs in a core that doesn't.

## Reference implementation map

| Concept | Reference file(s) |
|---|---|
| Markup-only page + inline first-paint bootstraps | `public/index.html` |
| Glass chrome, palette variables, CSS↔JS handshake | `public/css/app.css` |
| Bootstrap/wiring + the module map | `public/js/app.js` |
| Send loop, SSE consumption, error paths | `public/js/stream.js` |
| Pure SSE line-buffer parser | `public/js/sse.js` (+ its test) |
| Turn rendering + conversation reconstruction | `public/js/turns.js` |
| Sanitized markdown + LLM-markdown repair | `public/js/markdown.js`, `public/vendor/marked.min.js`, `public/vendor/purify.min.js` |
| Outgoing-message pure core (blocks, titles, image stripping) | `public/js/message-content.js` |
| Encrypted local history + sidebar | `public/js/history-store.js`, `public/js/history-ui.js` |
| Cached settings client, synchronous questions | `public/js/settings.js` |
| First-paint localStorage mirrors | `public/js/dev-mode.js`, `public/js/sandbox-mode.js` |
| Attachments + client-side parsing slots | `public/js/attachments.js`, `public/js/image-downscale.js`, `public/js/docs.js`, `public/js/exif.js`, `public/vendor/pdf.js` |
| The client tier's twin of this shell | `public/cure/index.html`, `public/cure/drc.js`, `public/cure/drc.css` |
| Cache/build-stamp institutional knowledge | `.claude/skills/cache-helper/SKILL.md` |

## Acceptance checklist

- [ ] Every `-core.js` and pure module imports cleanly in Node and its suite
      is green under the root `npm test`; `npm run typecheck` clean for the
      DOM config.
- [ ] The page renders and round-trips a MOCKED chat: composer submit →
      intercepted endpoint returns scripted SSE → deltas render → turn
      finalizes → history autosaves and reloads.
- [ ] SSE parser suite covers partial-line carry, keepalive filtering,
      `[DONE]`, and malformed-JSON tolerance.
- [ ] Sanitization pinned: a hostile markdown fixture (script tags, event
      handlers, off-origin img) renders inert; the FORBID/allowlist asserted.
- [ ] History at rest is ciphertext (inspect IndexedDB in a live browser);
      the key is never in any persistent storage; declared readable
      exceptions are the ONLY plaintext records.
- [ ] Mirror modules: cached knob applies before settings resolve (throttle
      the network and watch first paint), server reconcile wins on mismatch,
      private-mode storage throw doesn't break boot.
- [ ] No CDN reference anywhere in the module graph (grep for `https://` in
      script/link tags and dynamic loaders).
- [ ] Live on a real device: stream, scroll-detach/reattach, and an
      attachment parse — the DOM/canvas layer Node can't cover.

## Pitfalls

- **No build step is load-bearing, not a preference.** The moment a bundler
  exists, the served bytes stop being the repo's bytes: the client tier's
  auditability claim ("read the served source") dies, the derived
  module-graph test stops matching reality, and vendored-lib integrity
  pinning gets murkier. Resist "just for JSX/TS" — the typechecker already
  runs without a build.
- **The 2026-07-08 mixed-module-graph incident.** ~20 unversioned ES modules
  under heuristic browser caching + a multi-deploy day = devices linking a
  fresh module against a stale one; the import linker fails, the bootstrap
  never runs, and Send falls through to a native form submit that looks
  like the chat "resetting". Fixes that must all exist: server `no-cache`
  policy on modules, the CSS↔JS handshake, and a VISIBLE build stamp so a
  user report can say what a device actually runs.
- **What belongs in a `-core.js`.** The test: could this function run in
  Node with no stubs? Parsing, formatting, validation, state machines,
  block/text builders — yes; anything holding a DOM node, timer-driven
  animation, or a fetch — no (inject those). If a module needs a
  `document` guard in more than one place, split it instead.
- **Sanitize at render, not at receipt.** Text is stored raw and sanitized
  every render — sanitizing once at receipt and trusting storage invites a
  second unsanitized render path. And keep `<img>` forbidden by default:
  answers embedding attacker-chosen image URLs are a tracking/exfil channel;
  any exception is a same-origin allowlist.
- **Vendored, never CDN.** A CDN outage or tamper must not break or
  compromise the client (the reference vendored its terminal lib with
  SHA-256 pins after depending on a CDN); heavy libs (PDF export) are
  lazy-injected on first use so boot never pays.
- **iOS is the hostile environment.** Installed PWAs relaunch from a cached
  shell (hence the first-paint mirrors), get discarded in the background
  (hence metadata-only pending-answer markers — never message text),
  suspend network mid-stream when backgrounded (the send loop must treat
  that as recoverable), and fetch manifests without credentials. Verify on
  a real device; the desktop browser lies.
- **Storage throws are normal.** Private mode, quota pressure, and
  enterprise policies make `localStorage`/IndexedDB access throw. Every
  touch is try-wrapped and fails soft — a storage throw may lose a
  convenience, never the boot or a send.
- **The synchronous-settings trap.** An `await loadSettings()` on the send
  path adds a round-trip and a failure mode to every message. The cached
  synchronous question + accepted staleness window (server re-validates
  writes) is the pattern; anything that can't tolerate staleness gets a
  first-paint mirror instead.
