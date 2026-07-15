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

### F-16 · Symbol language for DeepResearch.**Se/rver** — 🔵 OPEN (medium)

DeepResearch.**Se/cure** already speaks in symbols: the ghost (anonymity)
holding **pink umbrellas** (shelter), the first-visit umbrella intro
(`public/cure/umbrella.js`), and an umbrella landing for every completed
task. DeepResearch.**Se/rver** needs a sibling language — **positive**, and it
must **tell something true** about the tier (memory, stewardship, reach,
lift), tied into a similar animation: a vortex-derived first-visit intro, a
per-completed-task landing event, an ambient idle state, and a mascot
counterpart to the ghost. Design brief: `docs/SYMBOL-LANGUAGE.md`. Four
animated candidate concepts await the owner's pick in
`docs/symbol-language/proposals.html` (the Lift balloons / the Keeper
lighthouse / the Star Chart constellation / the Messenger doves); the chosen
one is then implemented in the umbrella conventions (pure Node-tested core,
DOM layer, tap-to-skip, reduced-motion, admin `anim_speed`).

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
