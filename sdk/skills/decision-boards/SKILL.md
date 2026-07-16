---
name: decision-boards
description: >-
  Load when building the pair's admin decision boards — the mechanism where an
  agent session produces a list (risks, features, findings), the human decides
  over it in an admin panel (votes, scores, notes, an explicit priority), and
  the choices feed back to agent loops as a FIXED work order — or when adding
  a new board, a *_reviews table, a ?format=text loop input, a per-board CLI,
  or the boards discovery index. Covers the shared board core a new board
  implements none of itself, the catalog/façade/mirror disciplines, the two
  board kinds (priority backlog vs votes-only attention), and the nine-step
  checklist for standing up a new board.
---

# Decision boards — human-decided work orders for agent loops

A decision board is how the pair puts a human in command of an agent loop
without meetings: **the agent produces the list, the human decides over it,
the loop reads the decisions back as its plan.** One shared core implements
the whole choice mechanism (votes, scores, notes, explicit priority,
orderings, persistence); each board is a thin catalog over it. The payoff is
human-in-the-loop by construction — the approval happened on the board, so
loops need no per-item approval round-trips, and wide work can fan out
against the human's exact priority order.

## Capability class & tier story

**Class S** — boards live in the one server component, behind the admin
gate (`deps: identity-access, observability`). They exist only on the server
tier; the client tier has no admin surface by design. The board CORE is a
pure, dependency-free, Node-testable module (the class-X style applied
inside a class-S feature): validation, orderings, and projection logic run
without D1 or a DOM, with only the row upserts touching the database. The
loops that consume boards are class D (see `feedback-loops`,
`agent-dev-workflow`); this module is the surface they read.

## Contracts

- **PA-5 (carried):** the core is one small dependency-free module; a new
  board implements NONE of the choice mechanics itself, and any new choice
  field extends the core once — never forks per board.
- **PA-10 (enforced):** boards are truth surfaces feeding measured loops — a
  status flips only in the same commit as the verified work, items the loop
  can't code-fix are recorded as operational rather than silently closed,
  and the mirror discipline is test-named drift, not hope.
- **PA-4 (carried):** board rows hold the admin's choices over CODE catalogs
  — no user content; review rows are keyed by stable item ids so catalog
  edits never orphan them; the dynamic-queue variant (feedback) carries its
  own consent story in `feedback-loops`.
- **PA-2 (carried):** a board endpoint degrades without D1 (empty review
  state over the code catalog) instead of erroring the admin page.

## Build plan

The nine steps, from scratch, for the FIRST board (steps 0–2 are one-time;
each later board is steps 3–9 over a new catalog):

0. **The shared core module** (`board.js` pattern) — generic,
   dependency-free, Node-tested. It owns:
   - **Choice-state validation:** `validateBoardPatch` (score: short free
     text; note; priority 1–999; `null` clears a field) and
     `validateBoardVote` (`{dir:"up"|"down"}` → ±1), with caps.
   - **The two orderings:** `orderBoardItems(items, mode, rankOf)` — mode
     `"priority"` (the work order: explicit priorities ascending first,
     then votes desc, then documented rank) and `"rank"` (the documented
     view). **Stable sort** — ties keep input order, so callers pass the
     catalog in its authored order and never add explicit order fields.
     **Closed items sink** to a tail: the core hardcodes
     `status === "open"` as the work set.
   - **`reviewState(row)`** — the choice-state defaults every projection
     spreads.
   - **D1 review-row helpers:** load/get/vote/patch as UPSERTS on a
     six-column table (`item_id` PK, votes, score, note, priority,
     updated_at). The `table` argument is a CODE CONSTANT, never input.
1. **Source-of-truth doc** — a living register `.md` with a §-numbered,
   priority-ordered backlog of stable-id items, maintenance rules
   (mirror-in-same-commit, priority-overrides-doc-order, ids-are-forever),
   and an append-only history log.
2. **Catalog module** `<board>.js` — `<BOARD>_ITEMS`: stable ids, array
   order = doc order, a documented RANK dimension (severity, impact — pick
   the word and palette that fit the board's meaning), a `status`, a real
   summary. Plus a projection (spreading `reviewState`), an ordering
   wrapper, a `format<Board>Text` (the loop's numbered plain-text input),
   and the endpoint handler. **Façade rule:** the module RE-EXPORTS the
   core's validators under its own names — never copies them — and a unit
   test pins identity (`board.validateReviewPatch === validateBoardPatch`).
   **Mirror rule:** the catalog mirrors the register §-by-§ — same ids,
   same order, same statuses — and any register edit updates the catalog in
   the SAME commit; the unit suite names the drift.
3. **D1 table** `<board>_reviews` in the lazy schema — the same six columns
   every time.
4. **Route** — `/api/admin/<board>` + subpaths dispatched to the handler
   (the admin gate is already upstream in the entrypoint). Support
   `?format=text` and `?order=` (the panel shows ONE view; the alternate
   ordering exists for the scripts).
5. **Panel section** — one row per item: grip (finger-sized hit target) ·
   rank badge · status/priority badges · title · right-aligned ▲/▼ votes ·
   caret; a detail fold with summary + priority/score/note inputs and ONE
   Save that PATCHes all three. Drag-to-reorder writes priority 1..N (only
   changed items PATCH); a "Reset to default order" button (confirm first)
   clears every priority back to the documented ranking. No sort-toggle
   tabs — the panel always shows the drag-reorderable work order, and open
   items show the `#n` position the loop will see. Every interpolated value
   goes through the HTML escaper; votes/saves re-fetch and re-render (no
   optimistic state).
6. **CLI** `scripts/<board>` on break-glass credentials — list /`--json`/
   the second ordering /`--vote ID up`/`--set ID '{…}'`.
7. **Discovery registry** — ONE static registry module of every fetchable
   board (`id/title/purpose/feeds_loop/api/text_query/orderings/order_help/
   script/skill`), served as `GET /api/admin/boards` with a `?format=text`
   render that prints each board's EXACT fetch line, wrapped by
   `scripts/boards`. Pure and D1-free so it answers even without the
   database. Every new board (and every read-only tap like the interaction
   log) registers here — a fresh session pops up every board in one call.
   Fill `order_help` with HOW to choose an ordering, not just names.
8. **Tests** — catalog shape + mirror discipline (ids in order, valid
   statuses, real summaries), both orderings, the façade-identity check,
   the `?format=text` render. The core is covered once, centrally.
9. **Docs + the loop side** — the project-memory file-table row, a row in
   the board-loops doc, and a loop skill that says **read the board before
   every round** — the admin's ordering IS the plan; the loop never
   re-ranks it. Closing an item flips catalog `status` + register tag +
   history line in the same commit as the work.

**The second board KIND — votes-only attention boards.** Same core, minus
drag/priority: the catalog's items are the admin SURFACES themselves, ▲/▼
thumbs are injected into each surface's own header (no board widget at
all), and ordering reuses `"priority"` mode with no priorities ever set —
which collapses to exactly votes-desc with catalog-order tiebreak, so the
"reshapes purely on thumbs" behavior falls straight out of the shared core.
Net-negative items collapse and sink. Its `?format=text` answers a
different question — *"which surface has the human's attention now?"* — one
level above the per-board work orders: a session reads it first, then reads
the chosen surface's own board. All items stay `status:"open"` (a live
surface has no closed notion).

**Variants that reuse only the CONVENTION, not the core:** a dynamic user
queue (rows user-created, choice = a status lifecycle + dialogue replies)
and read-only taps (no choices). They keep the shared shape — admin-gated
endpoint, `?format=text` written for an agent to read, a `scripts/<name>`
CLI, a discovery entry — without forcing their row model into the core.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| The shared core (validation, orderings, reviewState, D1 upserts) | `src/board.js` (+ `src/board.test.js` incl. the façade-identity pins) |
| Reference priority board (security fixes) | `src/security-risks.js` ⇄ `SECURITY-RISKS.md` §3, D1 `security_reviews`, `scripts/security` |
| Second priority board (feature build) | `src/features.js` ⇄ `FEATURES.md` §3, D1 `features_reviews`, `scripts/features` |
| Votes-only attention board | `src/panels.js`, `public/js/admin.js` `loadPanels()`, `scripts/panels` |
| Discovery index | `src/admin-boards.js` (`ADMIN_BOARDS`), `GET /api/admin/boards`, `scripts/boards` |
| Panel UX (rows, drag, reset, toggles) | `public/js/admin.js` (`wireBoardItemToggle`, `enableBoardReorder`, `wireBoardReset`), `public/css/admin.css` |
| Routing + lazy schema | `src/admin-api.js`, `src/db.js` |
| Data-flow diagrams for every loop | `docs/DECISION-BOARD-LOOPS.md` |
| The loop runbooks | `.claude/skills/decision-boards/SKILL.md`, `.claude/skills/feature-board/SKILL.md` (§5 is the nine-step original) |
| Convention-only variants | `src/feedback.js` (dynamic queue), `src/chatlog.js` (read-only tap) |

## Acceptance checklist

- [ ] The core's suites are green: patch/vote validation, both orderings
      incl. stable-sort tiebreaks and closed-item sinking, `reviewState`
      defaults, the upsert SQL shape.
- [ ] Each board's suite pins catalog shape AND the mirror discipline —
      editing the register without the catalog (or vice versa) fails a
      named test in `npm test`.
- [ ] The façade-identity test proves the board's re-exported surface IS
      the core (`===`), not a copy.
- [ ] A loop can consume `?format=text`: numbered, priority-first,
      unprioritized by votes-then-rank, closed items as a one-line tail.
- [ ] Drag-reorder round-trips: drag → PATCH priority 1..N → reload shows
      the same order → the CLI prints the same numbering.
- [ ] `scripts/boards` lists every board with a working fetch line; a new
      board's discovery entry + expected-count test updated in its commit.
- [ ] The panel works with D1 absent (catalog renders, choices disabled or
      failing soft) and every interpolated value is HTML-escaped.
- [ ] Closing an item flips catalog status + register tag + history line in
      the same commit as the fix/build (spot-check the log).

## Pitfalls

- **Ids are forever.** D1 review rows are keyed by item id — renumbering a
  catalog orphans every vote/note/priority the admin ever set. Shipped
  items keep their id; new items take the next free one.
- **The active status must be literally `"open"`.** The core hardcodes it
  for the open-vs-closed split; name the CLOSED statuses per board
  (`fixed`/`accepted`, `shipped`/`dropped`).
- **Pass the catalog in its authored order.** The orderings are stable
  sorts that use input order as the final tiebreak — adding explicit order
  fields duplicates state the array already encodes.
- **Reuse the shared "score" field, relabelled.** The features board keeps
  the core's `score` but labels it *Effort* in the panel and renders
  `effort=` in the text — extend vocabulary per board, never the schema.
- **Drag can't resurrect a closed item.** On reload the server re-sorts
  open-first, so a closed item dragged up sinks again — expected, not a
  bug; don't "fix" it client-side.
- **No order-toggle tabs in the panel** (owner directive, 2026-07-15): the
  panel shows ONE view — the work order the loop will execute; alternate
  orderings live on the API for the scripts.
- **The loop never re-ranks.** The single most tempting violation: the
  admin's explicit priority is the FIXED plan; unprioritized items follow
  votes, then documented rank. Fan out top-N in that order onto DISJOINT
  files, and keep the shared catalog/register edits for the orchestrator to
  integrate.
- **Operational items stay honest.** An item that can't be closed in code
  (a provider-dashboard cap) is reported as operational and left open —
  the board is a truth surface, not a checkbox.
- **The table name is a code constant.** The core's D1 helpers interpolate
  it into SQL — it must never come from user input.
- **When a new choice field is needed (assignee, tag), extend the core
  once** — a per-board fork is exactly the hand-mirrored-copy drift PA-7
  exists to forbid elsewhere.
