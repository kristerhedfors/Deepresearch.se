---
name: decision-boards
description: >-
  Load when building or extending an admin DECISION BOARD — a panel where
  Claude Code produces a list of items (risks, features, findings, backlog
  entries), the admin makes choices over it (votes, scores, notes, an
  explicit priority order) with nice UX, and those choices feed back into a
  Claude Code loop as its fixed work order. Covers the shared core
  src/board.js (choice-state validation, the priority-vs-rank orderings, the
  D1 review-row helpers), the catalog/façade conventions, the admin-panel UX
  patterns (public/js/admin.js's security section is the reference), the
  ?format=text loop input + scripts/<board> CLI shape, and the checklist for
  standing up a NEW board (e.g. the features panel). Also load when touching
  /api/admin/security*, a *_reviews D1 table, or wiring any panel whose
  ordering an agent loop consumes.
---

# Decision boards — the panel ⇄ loop mechanism

One mechanism, many panels. A decision board is how this project puts a
human in command of an agent loop without meetings: **Claude Code produces
the list, the admin decides over it in the panel, the loop reads the
decisions back as its plan.** The security-risk board (`/admin` → Security
risks) is the reference implementation; the features panel is the same
machine over a different catalog. Anything list-shaped that a loop works
through belongs on a board.

## The loop, end to end

1. **Produce.** Claude Code maintains a CATALOG of items in code — stable
   ids, title, a documented rank (severity/impact), status
   (`open|fixed|accepted`), a real summary — mirroring a source-of-truth doc
   (`SECURITY-RISKS.md` §3 for the security board). Catalog and doc update
   in the SAME commit, always (the mirror discipline).
2. **Present.** The admin panel renders the catalog with choice UX
   (§ UX conventions below): ▲/▼ votes, a manual score, a note, an explicit
   per-item PRIORITY, and a sort toggle between the admin's work order and
   the documented ranking.
3. **Persist.** Choices land in a per-board D1 table
   (`<board>_reviews`: item_id PK, votes, score, note, priority,
   updated_at) keyed by the stable item id — catalog edits never orphan
   them; ids are forever.
4. **Feed back.** The loop reads `GET /api/admin/<board>?format=text` (via
   `scripts/<board>` with break-glass creds): a numbered plain-text work
   order — made to be READ by the agent, not parsed. **Explicit priority is
   the FIXED order**; unprioritized items follow by votes desc, then
   documented rank; closed items sink to a one-line tail. The admin's
   ordering IS the loop's plan — human-in-the-loop by construction, no
   per-item approval round-trips needed because the approval happened on
   the board.
5. **Act & close.** The loop works top-down. Finishing an item flips its
   catalog `status` in the same commit as the work (+ the source-of-truth
   doc's tag + history-log entry where the board has one). The panel shows
   the new state on next deploy; the item's review row (votes/notes) stays
   as the audit trail.

## The shared core — `src/board.js`

Generic, dependency-free, Node-tested (`src/board.test.js`). A new board
implements NONE of this itself:

- `BOARD_CAPS`, `validateBoardPatch` (score/note/priority; null clears;
  priority 1–999), `validateBoardVote` ({dir:"up"|"down"} → ±1).
- `orderBoardItems(items, mode, rankOf)` — mode `"priority"` (the work
  order) or `"rank"` (the documented view). Items need
  `{status, priority, votes}`; ties keep INPUT order (stable sort), so pass
  the catalog in its default order and skip explicit order fields.
- `reviewState(row)` — the choice-state defaults every projection spreads.
- D1 helpers: `loadBoardReviews`, `getBoardReview`, `voteBoardRow`,
  `patchBoardRow` (upsert; only patched fields touch existing rows). The
  `table` argument is a CODE CONSTANT — never user input.

A board's own module keeps only what is item-shaped: the catalog, the
projection, the `?format=text` rendering, and the endpoint dispatch.
**Façade rule** (the bash-agent precedent): the board module RE-EXPORTS the
core's pure surface under its historical names rather than copying it, and
a test pins identity (`security.validateReviewPatch === validateBoardPatch`
in `board.test.js`).

## Standing up a NEW board (the features panel walks this list)

1. **Catalog module** `src/<board>.js`: `<BOARD>_ITEMS` (stable ids like
   `F-1…`, array order = the doc's default order), a projection, a
   `format<Board>Text`, and the endpoint handler — copy
   `src/security-risks.js` (~150 lines of board-specific code) and swap the
   item shape. Re-export the core's validators façade-style.
2. **D1 table** `<board>_reviews` in `src/db.js`'s SCHEMA (same 6 columns).
3. **Route** in `src/admin-api.js`: `/<board>` + `/<board>/…` →
   the handler (admin gate is already upstream).
4. **Panel section** in `public/admin/index.html` + a render fn in
   `public/js/admin.js` — copy the security section: badges, vote arrows,
   the three inputs + Save, the two-button sort toggle, numbered open items.
5. **CLI** `scripts/<board>` — copy `scripts/security` (list/--json/--vote/
   --set against `/api/admin/<board>`).
6. **Tests**: catalog-shape + mirror-discipline suite like
   `src/security-risks.test.js`; the core itself is already covered.
7. **Docs**: CLAUDE.md table row + the source-of-truth doc's maintenance
   rules (mirror-in-same-commit, priority-overrides-doc-order) + the skill
   that owns the board's loop (security-posture for the security board).
8. **The loop side**: the consuming skill must say "read the board before
   every round" — the board is pointless if the loop doesn't start there.

## UX conventions (the panel side, from the reference implementation)

- One `.rowitem` per item: rank badge (`sev-high/medium/low` colors), status
  badge when not open (`fixed`/`accepted`), `priority N` badge when set,
  `recurring` when applicable, then title; votes right-aligned
  (`▲ count ▼`).
- The choice row (`.sec-review` styles): Priority (number), Score (short
  free-form — a CVSS vector fits in 120 chars), Note (flex-1), one Save
  button that PATCHes all three (empty = clear).
- Sort toggle: two buttons, active one gets class `on` — "Fix order
  (priority)" ⇄ the documented ranking. In the work-order view, open items
  get their `#n` round position — that numbering is exactly what the loop
  sees.
- Every interpolated value goes through `escapeHtml` (summaries/notes are
  hand-written today, but the pattern must survive user-shaped content).
- Votes/saves just re-fetch and re-render the section (no optimistic state).

## Variants on the same loop (don't force them into src/board.js)

- **Feedback queue** (`src/feedback.js`, the **feedback-loop** skill):
  dynamic user-created rows instead of a code catalog, dialogue THREADS
  instead of votes/priority, a status lifecycle as the choice. Same
  feed-back shape: `/api/admin/feedback?format=text` + `scripts/feedback`,
  human decision on every entry before acting.
- **Chat logs** (`src/chatlog.js`): the read-only tap — no choices, but the
  same `?format=text` + `scripts/chatlogs` loop-input convention.

The convention shared by ALL of them: admin-gated `/api/admin/<name>`
endpoints, `?format=text` output written for the agent to read, a
`scripts/<name>` wrapper on the break-glass env vars, and pure logic
Node-tested. When a future variant needs a new choice field (e.g. an
assignee or a tag), extend `src/board.js` once — never fork per board.
