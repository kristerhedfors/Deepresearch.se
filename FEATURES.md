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
exists. RESIDUAL: overlay-persistence UX and the DRC-side file provider need a
live pass so attachments/project files reliably reach the VM on both DRS and
DRC.

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

The `developer_mode` knob: a committed dense source-RAG index answers "how are
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

### F-11 · Feedback mode — per-reply dialogue with the dev agent — ✅ SHIPPED (medium)

Per-reply user feedback as dialogue threads the development agent gathers,
decides on, acts on, and replies into — the third loop-feeding queue
(`src/feedback.js`). See the **feedback-loop** skill.

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
