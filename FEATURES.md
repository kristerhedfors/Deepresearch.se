# Feature Roadmap & Priority Register — deepresearch.se

**This is a LIVING document**, maintained continuously alongside
`SECURITY-RISKS.md`. Where the security register tracks *fixes to make*, this
one tracks *features to build* and *features already shipped* — the product
backlog in priority order. It is the **second channel that feeds a Claude Code
loop**: the first is the security-fix order (`SECURITY-RISKS.md` §3), this is
the feature-build order.

The admin panel renders this as the **Features** board (`/admin` → Features);
the loop reads it back with `scripts/features` /
`/api/admin/features?format=text` and builds top-down in the admin's chosen
order. See the **feature-board** skill for how to run that loop.

## Maintenance rules

1. **This register is the single source of truth for planned feature work.**
   New items get `F-<n>` ids; ids are **stable forever** (a shipped item keeps
   its id, new items take the next free `F-n`), because the admin's
   votes/effort/notes/priorities live in D1 (`features_reviews`) keyed by them.
2. **When a feature ships:** change its status to `✅ SHIPPED (YYYY-MM-DD)`,
   add one line describing what landed (files + mechanism), append a dated
   entry to the History log (§4), and move to the next-highest open item.
   Shipped items stay in the list — the register doubles as the product
   changelog.
3. **Statuses:** `🔵 OPEN` (planned / upcoming), `🟡 PARTIAL` (a tier shipped,
   more planned), `✅ SHIPPED` (done), `⚪ DROPPED` (consciously not doing —
   record who/when/why). The board's machinery treats `open` as the work set;
   everything else sinks to a "shipped/dropped" tail for context.
4. **Impact** is the documented ranking (`high` / `medium` / `low`) — the
   "how much does this move the product" view, independent of the admin's
   priority. Priority (the board) overrides it for the build order.
5. **The admin review board mirrors §3.** `src/features.js` carries a code
   catalog of the F-items (id/title/impact/status/summary) that the admin
   panel renders and the build loop orders by. Any §3 edit — new item, status
   change, reworded summary — updates that catalog **in the same commit** (the
   same mirror discipline the security board follows).
6. **The admin's explicit priority is the BUILD ORDER.** When the admin has
   prioritized items on the board (drag to reorder, or set a priority number),
   the feature loop builds them in that order — it overrides this file's §3
   default order. Unprioritized items follow by admin votes, then documented
   impact, then §3 order. Before starting a build round, ALWAYS read the board
   (`scripts/features`); §3's order is only the default when the board is
   silent.
7. **This file is public** (like the whole repo). Describe features and plans
   without leaking secrets or unshipped-surprise details you would not want an
   attacker or competitor to read early.

---

## 1. What this board is for

Two channels now feed the Claude Code loops the owner runs to move this project
forward, each an admin-decided priority order:

- **Security** (`SECURITY-RISKS.md` §3 → `scripts/security`) — the fixes.
- **Features** (this file §3 → `scripts/features`) — the build work.

The owner sorts each board in the admin panel (drag the headers into order, or
set explicit priorities), then invokes Claude as a loop that reads the board's
`?format=text` view and works top-down. Human-in-the-loop by construction: the
decision happened on the board, so the loop needs no per-item approval.

## 2. How an item moves

`🔵 OPEN` → (build a tier) → `🟡 PARTIAL` → (finish it) → `✅ SHIPPED`, or
`⚪ DROPPED` at any point. Shipping flips the catalog `status` in
`src/features.js` in the same commit as the work, plus the §3 status tag and a
§4 history line. The panel reflects it on the next deploy; the D1 review row
(votes/notes/priority) stays as the audit trail.

---

## 3. Feature backlog — priority-ordered

The default order below is the fallback the loop uses only when the board
carries no explicit priorities. Open (planned) items first, shipped/dropped
items after as the record.

### F-1 · Graduate the in-browser execution sandbox out of experimental — 🔵 OPEN (high)

The CheerpX WASM Linux sandbox + bash-lite agent (`bash_lite_mcp` knob,
default OFF) is wired end to end but still owes its **live browser
verification** on real devices (iOS Safari COEP `require-corp`, the
`client_diag` probe playbook) before it can graduate from experimental toward
default-on. See the **execution-sandbox** skill.

### F-2 · Finish mounting user files into the sandbox across both tiers — 🟡 PARTIAL (medium)

`sandbox-files.js` + the `sandbox.js` device mounts land the tiered ingest
(`/workspace` + `/mnt/<proj>-<hash>`), and the `/src` introspection mount
exists.

**The DRC half now exists** (2026-08-05). `public/js/drc-attach-core.js` is the
Se/cure attachment core: caps, name sanitizing, the wire content, and
`sessionFilesFor`, which maps the pending attachments onto the same
`{name, type, bytes}` `session` shape a `fileProvider` must resolve to and
`planMounts` consumes. Before this, `/cure`'s only `fileProvider` was
introspection's `/src` mount, so nothing a user attached could reach the VM on
that tier; `public/cure/drc.js` now composes the two, and the shell pass takes
what was mounted as two explicit flags instead of inferring `/src` from the
provider's mere presence.

Se/cure's constraint shaped the core rather than the other way round: a file's
ORIGINAL bytes stay in tab memory for one send and are never written to the
sealed localStorage state, and nothing about them reaches deepresearch.se. The
per-file and per-message byte caps are set to `sandbox-files.js`'s mount budget
(25 MB / 64 MB) so a file the composer accepts can never be silently dropped at
mount time.

**RESIDUAL, and why this stays PARTIAL.** None of it has been through a live
browser pass on either tier — not the mount, not the overlay-persistence UX,
which is the other half of the original residual and is untouched. The unit
suite exercises the pure core; whether an attached PDF actually appears under
`/workspace` in a booted CheerpX VM is a live question and has not been asked.

### F-3 · Expand the research-source registry beyond Exa + Hugging Face — 🔵 OPEN (medium)

The `search-sources.js` registry is the parallel-work seam for citable
sources. Add one or more new sources (a search provider or platform API) via
the **add-research-source** playbook — intent routing, triage-prompt note,
diversity wiring, and the unit → live → bench validation ladder.

### F-4 · Grow the games shelf beyond Tokemon — 🔵 OPEN (low)

The `games.js` registry/dispatch seam makes a new game a
register-one-entry-no-shelf-change addition. Add a second game to prove the
seam and give the account panel's Games view more to show. See the
**tokemon-game** skill.

### F-5 · Broaden and tune the model catalog — 🔵 OPEN (medium)

Keep the dropdown current as providers ship models: add/curate via the
**add-llm-provider** seam (`providers.js`) and run each new model's first
eval battery per **tune-provider-models** (synthesis / JSON / vision / quiz),
recording evidence-driven `model-profiles.js` entries only.

### F-6 · Decision-board channels (security + features) — ✅ SHIPPED (2026-07-12)

The panel ⇄ loop mechanism (`src/board.js` core + per-board catalog/façade):
the security-fix board and this features/priority board, both collapsed to
draggable headers, both discoverable via `scripts/boards`. The two admin-
decided priority orders that drive the owner's Claude Code loops.

### F-7 · Introspection mode — ask the site about its own source — ✅ SHIPPED (2026-07-11)

Introspection mode (`chat_mode: "introspection"`): a committed dense source-RAG index answers "how are
you built" from the exact deployed source, on both tiers, with an optional
`/src` sandbox mount. See the **introspection** skill.

### F-8 · DRC — the client-side secure tier at /cure — ✅ SHIPPED (high)

The whole public no-accounts tier: browser-direct provider calls on the user's
own keys, the research pipeline ported client-side, and browser-local sealed
storage — the server in no data path. See the **storage-privacy** skill.

### F-9 · The secret-keyed project vault — ✅ SHIPPED (medium)

One client-encrypted project archive per user-held secret, stored server-side
as ciphertext the server can never read — backup/cross-device transport for a
local-only project (`src/vault.js` + `public/js/vault-core.js`).

### F-10 · Published research replays (/cure/<slug>) — ✅ SHIPPED (medium)

Frozen deep-research sessions as read-only public pages, opened in place by
the DRC app so continuing on the visitor's own keys is just typing
(`src/pub.js`). See the **publish-research** skill.

### F-11 · Feedback pipeline — chat-triggered dialogue with the dev agent — ✅ SHIPPED (medium)

User feedback given straight from the chat — a message opening with the word
"feedback" (`feedbackIntent`, EN+SV) or with the `/feedback` slash command
(2026-07-26; both behind `feedbackRequested`) routes to the feedback case
(`src/pipeline.js` `runFeedbackCapture`), which replies with a canned
acknowledgment (no LLM anywhere in the path — 2026-07-24) and records a
dialogue-thread entry (`src/feedback.js`) carrying the exact text plus the
whole conversation and request metadata as debugging context; the development
agent gathers, decides on, acts on, and replies into it — the third
loop-feeding queue. Discovery is double: the structured queue plus a
`chat_logs` `meta.feedback` tag. Notes are classified by SCOPE (2026-07-24):
feedback typed as the FIRST message of a chat is generic developer feedback —
a suggestion, next steps — so it is tagged `chat/standalone`, gets an
acknowledgment that doesn't promise a conversation, and carries no transcript
instead of a one-turn fake one. Superseded the earlier per-reply Feedback
button + settings knob (2026-07-18). The gate is evaluated ABOVE the
executor-phase dispatch, so it reaches the developers from every chat mode —
Deep Research, Introspection, Agent Studio, Orchestrator, Outrospection
(feedback #26). See the **feedback-loop** skill.

### F-12 · Project pulse dashboard (/pulse) — ✅ SHIPPED (low)

Public commit-analytics dashboard over the repo's own git history — commits /
lines / new features with a day/week/month zoom (`scripts/build-pulse.mjs`).
See the **commit-analytics** skill.

### F-13 · Secondary LLM providers (Anthropic + OpenAI) — ✅ SHIPPED (high)

The `providers.js` dispatch seam plus `anthropic.js` (adapt-at-the-wire SSE)
and `openai.js` (native wire) — synthesis models beyond Berget, JSON phases
still on the fixed reliable model. See the **add-llm-provider** skill.

### F-14 · Google Maps / Street View enrichment + Tokemon AR — ✅ SHIPPED (medium)

The opt-in `google_maps` enrichment (Places / Street View / Static Maps /
Routes, POV vision-describe, the image deck) and the Tokemon street-view AR
mode built on it. See the **integrations** and **tokemon-game** skills.

### F-15 · Panel selection board — the attention loop — ✅ SHIPPED (medium)

A THIRD decision-board channel of a new KIND: instead of ordering a backlog,
its items ARE the admin panels themselves, reshaped **purely by the owner's
▲/▼ thumbs** — no drag, no explicit priority, no board widget of its own.
Voting a panel header up floats that panel to the top of the admin view;
voting one down collapses and sinks it. That live order is the admin's
**focus order** a Claude Code session reads (`scripts/panels` /
`/api/admin/panels?format=text`) to know which admin surface the owner is
working on now (`src/panels.js`, D1 `panels_reviews`, façade over
`src/board.js`). The usage tables were also folded one layer down
(`<details>`) so the view leads with the boards, not the money tables. This
"attention loop" variant is documented in the **feature-board** skill and
`docs/DECISION-BOARD-LOOPS.md`.

### F-16 · Symbol language for DeepResearch.**Se/rver** — 🟡 PARTIAL (medium)

DeepResearch.**Se/cure** already speaks in symbols: the ghost (anonymity)
holding **pink umbrellas** (shelter), the first-visit umbrella intro
(`public/cure/umbrella.js`), and an umbrella landing for every completed
task. DeepResearch.**Se/rver**'s sibling language is now DECIDED and shipped
client-side (owner's pick 2026-07-15 from the four animated candidates in
`docs/symbol-language/proposals.html`): **the BALLOON** — the balloon
itself is the symbol, one little gold-and-blue balloon (the umbrellas'
geometric sibling, powered and rising: "the server does the lifting")
among clouds in the app's corner, the ghost's counterpart on the blue side.
Round 4 (same day) re-scoped it — NO persistent figure follows the user
around on either tier: the balloon is a FIRST-VISIT GREETER, chained onto
the landing intro's completion, speaking a couple of pointer lines (what
the tier does; the ghost button as the door to Se/cure) before climbing
away and unmounting; the same directive lowered the ambient UX animation
level (slower wave drift, rarer ghost shimmer, slower ghost breathe). While
on screen, per completed task the burner flares, it climbs a notch and
hangs a pennant; clouds swish past it in ALL of its transitions
(`public/js/balloon.js` — pure Node-tested core
+ fail-soft DOM layer; wired in `app.js`/`stream.js`). Round 2 (same day)
completed the grammar: the first-visit LANDING intro
(`public/js/balloon-intro.js` — the vortex untwists into WIRE balloons, the
camera drops a full 180° twisting sideways, clouds swish past, and it ends
from below under five same-shape/different-size colored balloons; faster
than the umbrella intro, test-pinned) and the WAITING SYMBOL
(`public/js/balloon-spinner.js` — the blue tier's typing/step spinners
boomerang the balloon intro in miniature and fold, on completion, into a
BLUE ✓ via the colored balloon, where Se/cure's umbrella folds to pink;
`--check-blue` in app.css). Round 3 (2026-07-15) briefly made the grammar
granular per task (umbrella = offline, balloon = online, in both tiers, with
per-step ℹ disclosures on Se/cure) — **REVERTED by round 5 (owner directive,
2026-07-16): the animations are TIER IDENTITY again** — Se/cure wears the
umbrella on every step, Se/rver the balloon on every step, stringent and
clean — and the privacy communication moved into Se/cure's **ℹ PRIVACY
NOTICE**: a header popover laying out in detail what the session's current
configuration sends where (model route, borrowed allowances, web-search
route, recall embeddings), always available and popped up automatically when
a shared secure workspace opens (pure `privacyNoticeLines` in
`drc-page-core.js`; UX-2 in the ux-conventions registry). Design record:
`docs/SYMBOL-LANGUAGE.md` §6. RESIDUAL: live verification on real devices
(the speech-bubble duty landed with the round-4 greeter).

### F-17 · Manual publish bridge for SDK-mode builds — ✅ SHIPPED (2026-07-18) (low)

A small bridge into SDK mode (the green chat-mode-dropdown build+publish
flow at `/app/<slug>/`, `src/build-pub.js` — shipped 2026-07-18, no register
entry of its own yet), answering "can output from the execution sandbox or
introspection-mode
source work reach a live served URL without a chat/tool loop": admin-gated
`PUT /api/build/:slug` (`handleBuildManualPublish`) calls the exact same
`publishBuild` the pipeline uses, so a manually published bundle gets
identical caps and opaque-origin CSP-sandboxed serving as a model-built one
— no new storage shape, no new isolation model. `scripts/publish-app`
bundles a local directory and publishes it via the break-glass admin auth.
See the **publish-app** skill (built on top of **sdk-mode** — load that
skill first for the feature this extends).

### F-18 · Distributed secure research spaces — seal-back & aggregate/merge — 🔵 OPEN (high)

Extends the secure-workspace mechanism (`docs/WORKSPACE-SECURITY.md`;
`public/js/workspace-core.js`; the `/cure/workspace` share/unlock flow) from a
single portable session into a **distribution + collection loop** for
fan-out research. The subject of LinkedIn series article 3 (teased by articles
1 & 2 in `docs/linkedin/`) — the article documents the reference
implementation this item builds.

Two capabilities to build:

1. **Seal-back with the origin's public key.** Today a workspace link is
   symmetric — sealed under a password anyone with the link+password can open.
   For distributed nodes we want *asymmetric* return: an origin user (the
   Se/rver account that minted the distributed research spaces) publishes a
   **public key**; a node that finishes its research **seals its results to
   that public key** so that once sealed, *only the origin user* — holder of the
   private key — can open the results. The distributor hands out spaces
   preloaded with material and conversations for others to work in; the workers
   hand back results that are cryptographically readable only by the
   distributor. (Primitive choice must follow the no-own-crypto rule: prefer
   WebCrypto's asymmetric primitives / a vetted design, never a homegrown
   scheme — see article 2 and `docs/ENCRYPTION.md`.)

2. **Aggregate / merge mechanism.** The origin Se/rver user who created the
   distributed workspace links needs to **collect the sealed result bundles,
   decrypt them locally, and combine/merge the conclusions** from the whole set
   of distributed research agents into one aggregated view — the reduce step of
   a map-reduce over research spaces. Define the merged shape (per-node
   provenance preserved, conclusions reconciled), and keep the collection
   surface consistent with the DRSW/1 workspace-bundle standard
   (`docs/WORKSPACE-PROTOCOL.md`) so a sealed result is just a workspace bundle
   with an asymmetric envelope.

Fail-soft and privacy invariants carry over unchanged: no server sits in a
Se/cure data path; the sealed envelope is opaque to the server; keys never log.
Design-first per the interchange-standards discipline — spec the envelope and
merged shape before wiring UI.

### F-19 · Track MCP's stateless protocol revision — 🔵 OPEN (medium)

Filed from user feedback #33 (2026-07-26, "add this mcp update as a task").
`POST /mcp` (`src/mcp.js`) is the ONE place this project points outward — the
pipeline exposed AS a tool other agents call (`docs/ARCHITECTURE-ROADMAP.md`
§3). The next protocol revision rewrites the exact three methods we
hand-rolled. Left alone, our only outward integration drifts out of spec.

**Where we stand.** `PROTOCOL_VERSION` is `"2025-06-18"` — already
two revisions behind the published `2025-11-25`, never bumped. So this item
is a *catch-up plus a jump*, not a single bump.

**Verified against the upstream draft changelog (checked 2026-07-26,
`modelcontextprotocol.io/specification/draft/changelog`).** The revision is
in draft; a release-candidate date of 2026-07-28 was reported in the feed
that prompted the feedback but is NOT confirmed by the published revision
list, which still shows `2025-11-25` as current. Treat the date as unfixed
and the substance as settled. What lands on us:

- **The handshake goes away.** `initialize` and `notifications/initialized`
  are removed; MCP becomes stateless. Every request instead carries its
  protocol version and client capabilities in `_meta`
  (`io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientCapabilities`), clients SHOULD send
  `io.modelcontextprotocol/clientInfo`, and servers SHOULD return
  `io.modelcontextprotocol/serverInfo` in each result's `_meta`. Version
  mismatch answers `UnsupportedProtocolVersionError`.
- **`server/discover` becomes mandatory** — servers MUST implement it to
  advertise supported protocol versions, capabilities and identity. This is
  new surface, not a rename of `initialize`.
- **Protocol-level sessions and `Mcp-Session-Id` are removed**; list
  endpoints no longer vary per connection. Cross-call state becomes an
  explicit server-minted handle passed as an ordinary tool argument.
- **Every result carries a required `resultType`** (`"complete"`, or
  `"input_required"` for the new multi-round-trip pattern). Results from
  earlier-protocol servers that omit it MUST be read as `"complete"`.
- **`tools/list` results gain required `ttlMs` + `cacheScope`**
  (`CacheableResult`), and tools SHOULD come back in deterministic order —
  ours already do (a static array), so that half is free.
- **Extensions become first-class**: an `extensions` field on client and
  server capabilities. Note this is MCP's own extension concept and has
  nothing to do with invariant 7's `src/extensions.js` registry — don't let
  the shared word merge the two.
- **Standard request headers** `Mcp-Method` / `Mcp-Name` are required on
  Streamable HTTP POSTs, with a `HeaderMismatch` error.
- **Error codes are re-partitioned**: `-32020`–`-32099` is reserved for the
  spec (`UnsupportedProtocolVersion` = `-32022`), `-32000`–`-32019` stays
  implementation-defined. Our `RPC_*` constants are all standard JSON-RPC
  codes, so they are unaffected — but new codes must come from the right
  range.
- **Removed / deprecated, and all irrelevant to us — confirm, don't
  implement:** `ping`, `logging/setLevel`, `notifications/roots/list_changed`,
  SSE stream resumability (`Last-Event-ID`), the HTTP+SSE transport, and the
  Roots / Sampling / Logging features. We implement none of them.

**Scope of the work.** Add `server/discover`; accept requests with no prior
handshake and read the version + capabilities off `_meta`; emit `resultType`
and `serverInfo`; add `ttlMs`/`cacheScope` to `toolsListResult()`; return
`UnsupportedProtocolVersionError` on mismatch. **Serve both revisions at
once** — the spec's new deprecation policy guarantees a minimum twelve-month
window and removes nothing inside it, so `initialize` must keep working for
existing clients rather than being deleted. That dual support is the design
question worth settling first.

Two constraints hold throughout. The **file-layout rule** stands: all of
this is pure protocol logic, so it belongs at the TOP of `src/mcp.js` behind
no dynamic import, and `src/mcp.test.js` must still load the module without
pulling in the pipeline. And **invariant 1** is untouched: a richer inbound
protocol is still the client's model choosing to call us — orchestration
inside stays deterministic, with no function calling introduced.

Verification is the **mcp-server** skill's ladder: unit tests on the pure
helpers, then a live JSON-RPC probe of both the legacy handshake path and
the stateless path. Re-read the changelog before starting — this item was
written against a draft that can still move.

### F-20 · Reach the hosted chat clients — the MCP server as a web connector — 🟡 PARTIAL (medium)

**Built 2026-08-03; first observed working from a Claude client 2026-08-05,
mobile and the whole ChatGPT half still outstanding.** The MCP surface was
reachable from a laptop and invisible from a phone: connecting meant pasting
`claude mcp add` into a terminal — Claude Code's command, which no hosted chat
app reads. For a research assistant that is the wrong way round.

**Scope widened 2026-08-03 (owner): ChatGPT as well as Claude**, and both are
served by ONE authorization server — OAuth 2.1, CIMD preferred with DCR as
fallback, PKCE S256, the `401` + `WWW-Authenticate` handshake,
protected-resource metadata. The per-client deltas are bounded: a redirect
allowlist that is a LIST, and two adapter tools ChatGPT requires by name.

**What shipped.** Design and spec: **`docs/MCP-CONNECTOR.md`** (§4 what
exists, §4a how to verify it by hand).

- `src/oauth-metadata.js` — pure leaf: both discovery documents, the
  `REDIRECT_ALLOWLIST` + `redirectAllowed` (exact strings for Claude's
  `https://claude.ai/api/mcp/auth_callback` and ChatGPT's two callbacks, RFC
  8252 port-agnostic loopback for Claude Code), the `WWW-Authenticate` value,
  and `issuerFor`, which encodes the host split.
- `src/oauth-store.js` — three token families under their own
  `token-crypto.js` namespaces: `oac1.` code (60 s), `oat1.` access (1 h),
  `ort1.` refresh (90 d). Codes and refresh tokens also carry a D1 row keyed
  by `jti`, because a signature cannot express single use or revocation;
  access tokens are signed only, so there is no lookup on the hot path.
- `src/oauth-authorize.js` — the consent screen and code issuance, needing a
  signed-in identity, naming what connecting grants and showing the redirect
  URI's hostname. A refused `redirect_uri` renders a page rather than
  redirecting and logs `oauth.redirect_refused`; the form is bound by its own
  signed `oct1.` consent token, so the POST cannot be re-pointed.
- `src/oauth-token.js` — `POST /oauth/token`: form-urlencoded, RFC 6749 §5.2
  error codes at 400, mandatory refresh rotation delegated to the store,
  `client_credentials` refused with `unsupported_grant_type`.
- Two adapter tools for ChatGPT — `search` and `fetch`, named exactly that,
  fronting **the two hosted corpora** (the owner's decision; the alternative
  was the research pipeline) with OpenAI's fixed shapes returned both as
  `structuredContent` and as JSON-encoded content text.

**The shape held.** `https://mcp.deepresearch.se` stays the connector URL —
bare origin, no new path, no new subdomain, because protected-resource
metadata's `resource` must match what the user typed, character for character.
The authorization server is the apex, where the account, Google sign-in and
the session cookie already live. The access token resolves beside `mck1.` in
`resolveMcpKeyIdentity`, so the exposure config, the four-window quota, split
billing and the `chat_logs` row all apply unchanged — OAuth added a door, not
a second surface — and the not-a-login pin extends to it.

**Why this is PARTIAL and not SHIPPED.** Acceptance is live and cannot be
inferred from a green unit suite, and none of it can be run from a build
container: add the connector on claude.ai, complete consent, call a tool —
**then open the Claude mobile app and confirm it lists tools with no further
setup** — and repeat the whole thing on ChatGPT, which is also what settles
whether it accepts Streamable HTTP and whether its iOS app can use a connector
at all. Re-read both vendors' connector docs first; Anthropic's moved hosts
once already, `static_headers` is mid-rollout, and OpenAI's pages contradict
each other on transport.

**The stopgap remains available**: `static_headers` (beta, rollout-gated) lets
an admin paste `Bearer mck1.…` as a request header with no server involvement
— Claude-only, org-shared by design, and the fallback if the OAuth flow fails
its live check.

---

## 4. History log (append-only)

- **2026-07-12** — Register created. Seeded §3 with the current backlog: five
  open items (F-1 sandbox graduation, F-2 sandbox file-mounting, F-3 more
  research sources, F-4 more games, F-5 model catalog) and the shipped record
  (F-6…F-14). Stood up the Features board (`src/features.js`, D1
  `features_reviews`, `/api/admin/features`, `scripts/features`) as the second
  loop-feeding channel next to the security board; registered it in the
  `ADMIN_BOARDS` discovery index.
- **2026-07-12** — F-15 shipped: the Panel selection board (`src/panels.js`, D1
  `panels_reviews`, `/api/admin/panels`, `scripts/panels`), a third board
  channel of a new KIND — the ATTENTION loop. Its items are the admin panels
  themselves, reshaped purely by ▲/▼ thumbs on each panel header (no drag/
  priority, no board widget); the votes-driven focus order is what a Claude
  Code session reads to know which surface the owner is working on. Registered
  in `ADMIN_BOARDS`; documented the new loop type in the feature-board skill
  and `docs/DECISION-BOARD-LOOPS.md`. Also folded the two usage tables one
  layer down under `<details>` so the admin view leads with the boards.
- **2026-07-15** — F-16 opened: a symbol language for DeepResearch.**Se/rver**
  to pair with DeepResearch.**Se/cure**'s ghost-and-pink-umbrellas language
  (the umbrella intro; an umbrella landing per completed task). Documented the
  established Se/cure symbolism + the design brief in
  `docs/SYMBOL-LANGUAGE.md` and built four animated candidate concepts for the
  owner to pick from (`docs/symbol-language/proposals.html` — the Lift
  balloons, the Keeper lighthouse, the Star Chart constellation, the
  Messenger doves), each with a working per-completed-task landing event.
- **2026-07-15** — F-16 decided + first tier shipped: the owner picked the
  balloons from the four candidates and refined the concept — the balloon
  ITSELF is the symbol, a little guide hovering among clouds that follows the
  user around like the ghost does on Se/cure, swishing by clouds in all of
  its transitions. Shipped `public/js/balloon.js` (pure core + fail-soft DOM
  layer, Node-tested in `balloon.test.js`): burner flare + climb + pennant
  per completed task (stream.js `done` event), cloud swishes on boot/new-chat
  transitions, reduced-motion static, hidden-tab pause. Recorded the decision
  in `docs/SYMBOL-LANGUAGE.md` §5 and marked the pick on the proposals page.
  Status → PARTIAL (residual: live device verification, tap-to-explain).
- **2026-07-15** — F-16 round 2: the Se/rver landing animation + waiting
  symbol. Shipped `public/js/balloon-intro.js` (the blue tier's first-visit
  intro: vortex → wire balloons → a 180° camera drop with a sideways roll and
  swishing clouds → five same-shape/different-size balloons seen from below,
  burners glowing; ~4.1 s, faster than the umbrella intro by test-pinned
  directive; gated in app.js like /cure's with ?anim=1 replay) and
  `public/js/balloon-spinner.js` (the mountUmbrellaSpinner contract, wired
  into turns.js/activity.js: the boomerang loop never reaches the color —
  completion speed-runs into the colored balloon and folds into a BLUE ✓,
  app.css --check-blue). One shared renderer (drawBalloonFigure) keeps the
  intro, spinner, and guide the same figure; the umbrella spinner stays
  Se/cure's. CSS handshake bumped h36→h37 for the .check color change.
- **2026-07-15** — F-16 round 3: the granular per-task channel grammar. The
  umbrella now marks OFFLINE work and the balloon ONLINE work in BOTH tiers:
  Se/rver's in-browser sandbox step wears the umbrella spinner (blue-✓ finale
  via the new `check` option); on Se/cure every online step wears the balloon
  and completes into a tappable ℹ notice (`finale: "info"`) whose bubble says
  what it sent and where (`disclosureText` + the send-time `sendCtx`), while
  local steps keep the pink ✓. Unknown phases default ONLINE (over-disclosing
  is the safe failure). Codified as UX-2; classification + disclosure pure and
  Node-tested; balloon modules added to the /cure public allowlist.
- **2026-07-15** — F-16 round 4: no persistent figures + a lower UX animation
  level (owner directive). Neither tier keeps a small figure following the
  user around: a tier's character appears ONCE, for first-time visitors,
  right after the first-visit intro — pointers, then gone. Se/cure already
  had that shape (the strolling ghost and #ghostsay greeter both chain onto
  the intro's one real play); Se/rver's balloon guide was converted into the
  matching one-shot GREETER (`showBalloonGreeter`, chained onto the landing
  intro's onDone; two pointer lines — what the tier does + the ghost button
  as the door to Se/cure — then a climb-away departure and unmount; any tap
  dismisses per UX-1; `balloonReset` removed, `balloonTaskDone` a no-op once
  departed). Ambient animation lowered across both tiers: background wave
  drift 26 s → 52 s, the ghost-button glow+shimmer once a minute → once per
  three minutes (same ~4 s event), the /cure ghost-contour breathe
  3.6 s → 7.2 s. Codified as UX-3 in the ux-conventions registry; CSS
  handshake h37→h38, /cure build stamp d27→d28.
- **2026-07-16** — F-16 round 5: the round-3 per-task channel grammar was
  REVERTED (owner directive: "keep it stringent and clean with the
  animations") — the waiting symbols are TIER IDENTITY again. Se/cure wears
  the pink umbrella on every research step (→ the pink ✓), Se/rver the
  balloon on every step (→ the blue ✓); the umbrella spinner's `check`
  option, the balloon spinner's `finale:"info"` option, `phaseChannel`/
  `disclosureText` (drc-page-core.js), `stepIsLocal` (activity-core.js), and
  the per-step ℹ/leak-note UI were all removed. The privacy communication
  moved into Se/cure's ℹ PRIVACY NOTICE instead: a header ℹ button opens a
  popover laying out in detail what the session's CURRENT configuration
  sends where — model route (own key / local / borrowed proxy), web-search
  route, recall embeddings, borrowed-allowance governance — and a shared
  secure workspace unlock pops it up automatically, leading with what the
  workspace link carried (pure `privacyNoticeLines` in drc-page-core.js,
  Node-tested; `showPrivacyNotice` + `#privacypop` in cure/; UX-1
  dismissal). UX-2 rewritten in the ux-conventions registry; /cure build
  stamp d31→d32.
- **2026-07-18** — F-17 shipped: manual publish bridge into SDK mode
  (`handleBuildManualPublish`, `PUT /api/build/:slug`, admin-only) +
  `scripts/publish-app`. Answers whether the execution-sandbox/introspection
  workflow can put its output on a real served URL without a live model
  conversation — reuses SDK mode's existing `publishBuild`/caps/opaque-origin
  CSP unchanged rather than building a second publish system.
- **2026-07-26** — F-19 opened from user feedback #33 ("add this mcp update as
  a task"): track MCP's stateless protocol revision on `POST /mcp`. Checked the
  upstream draft changelog rather than trusting the feed that prompted the
  report — the substance is confirmed (the `initialize`/`notifications/
  initialized` handshake removed, per-request `_meta` version + capabilities,
  a mandatory new `server/discover`, protocol sessions and `Mcp-Session-Id`
  gone, a required `resultType`, `ttlMs`/`cacheScope` on `tools/list`, an
  `extensions` capability field, required `Mcp-Method`/`Mcp-Name` headers, a
  re-partitioned error-code range) but the reported 2026-07-28 RC date is not,
  so the item is written against the draft and says so. Recorded two things the
  feed did not: `PROTOCOL_VERSION` has been stuck at `"2025-06-18"` since it
  was written, two revisions behind the published `2025-11-25`, so this is
  catch-up plus a jump; and the new twelve-month deprecation window means both
  revisions must be served at once rather than the handshake being deleted.
  Also corrected the **mcp-server** skill, which still described a single
  `deep_research` tool and "anything else is method-not-found" after the
  `sdk_*` tools landed, and gave it an upcoming-revision section so whoever
  builds F-19 starts from the verified list.

- **2026-08-03** — F-20 opened, then widened and built the same day. Opened as
  "the MCP server is reachable from a laptop and invisible from a phone",
  written up as design and feasibility in `docs/MCP-CONNECTOR.md`; widened by
  the owner from Claude to Claude **and** ChatGPT once it turned out both want
  the SAME authorization server, so the second client cost a redirect-allowlist
  entry and two adapter tools rather than a second project. The owner then
  decided the two questions the design left open — build it now, and point
  `search`/`fetch` at the two hosted corpora rather than the research pipeline
  — and the OAuth 2.1 authorization server landed: `src/oauth-metadata.js`
  (discovery documents, the redirect allowlist as data, the host split),
  `src/oauth-store.js` (`oac1.`/`oat1.`/`ort1.`, signed plus a D1 row where
  single use and rotation need one), `src/oauth-authorize.js` (the consent screen,
  which needs a signed-in identity), `src/oauth-token.js` (form-urlencoded, RFC 6749 codes,
  mandatory rotation). Status is 🟡 PARTIAL, not shipped, and deliberately so:
  the acceptance criterion is a live check on both clients and both phones,
  which cannot be run from a build container and cannot be inferred from a
  green unit suite. Recorded in the same pass: the privacy answer (a connector
  moves nothing in invariant 4 — same call, same log row, same quota — and
  adds a consent screen and a per-connection revocable credential,
  `docs/PRIVACY-MODEL.md`), and a debugging section in the **mcp-server**
  skill, because every client reports every failure in this flow as one
  unhelpful line and the 401 + `WWW-Authenticate` step is where it usually
  dies.

- **2026-08-05** — F-2's DRC half landed: `public/js/drc-attach-core.js` gives
  Se/cure its own attachment core, and `sessionFilesFor` hands the pending
  files to the sandbox in the `session` shape `planMounts` already consumes, so
  the mount path is shared rather than duplicated. The tier's storage rule set
  the caps: original bytes stay in tab memory and never enter the sealed
  localStorage state (`public/js/drc-store.js`'s comment restated to say why
  its ~5 MB judgement still holds), the byte caps mirror `sandbox-files.js`'s
  mount budget so nothing accepted is dropped at mount, and an attachment adds
  nothing to a workspace link — `buildWorkspacePayload` keeps only string
  message content, and DRSW/1 §5.5 reserves `materials` for a revision that has
  a chunked-file convention. Status stays 🟡 PARTIAL: nothing here has been
  verified in a live browser, and overlay-persistence UX is untouched. Docs
  corrected in the same pass — `/cure/help/`'s comparison row claimed local
  file SEARCH that does not exist (Se/cure's RAG indexes chats only,
  `drc-rag.js` writes `kind: "chat"`), and `docs/WORKSPACES.md` put Se/cure's
  attachments in OPFS, which is a Se/rver store (`public/js/opfs.js` imports
  the authed stack and `/cure` may not touch it).
