---
name: feature-board
description: >-
  Load when running the FEATURE-BUILD loop from the live site — "work the
  features board", "build the next feature", "loop on FEATURES.md", the owner
  says they'll drive work via the priority board — or when touching
  src/features.js, FEATURES.md, scripts/features, the admin panel's Features
  section, or the features_reviews D1 table. ALSO the go-to for IMPLEMENTING A
  NEW LOOP / priority board in this repo (the general pattern: a panel where
  Claude Code produces a list, the admin sets a priority order, and a Claude
  Code loop reads it back and works top-down). Covers the run-the-loop cycle
  (read board → fan out by priority → build a tier → verify → flip status →
  push), the mirror discipline (catalog ⇄ FEATURES.md §3 in the same commit),
  the status lifecycle (open → PARTIAL → SHIPPED / DROPPED), and the nine-step
  checklist to stand up another board. ALSO covers the ATTENTION-loop variant
  (§6): a votes-only selection board with no backlog, no drag, and no board
  widget — the admin panels reshaped purely by ▲/▼ thumbs (src/panels.js).
  Companion to the decision-boards skill (the shared mechanism) and
  docs/DECISION-BOARD-LOOPS.md (the data-flow diagrams).
---

# Feature-board loop — the second priority channel

The **features board** is the second admin-decided priority order that feeds a
Claude Code loop (the first is the security-fix board). Where security orders
*fixes*, this orders *build work*. The owner sorts `FEATURES.md` §3 on the
admin panel (drag the headers, or set explicit priorities), then invokes Claude
as a loop that reads the board and builds top-down.

This skill is TWO things:

1. **Run the loop** — the recurring build cycle (§1–§4 below).
2. **Implement a loop** — the general playbook for standing up a NEW priority
   board in this repo (§5), with the features board as the worked example.

Read `docs/DECISION-BOARD-LOOPS.md` for the data-flow diagrams (the board ⇄
loop cycle, the live request sequence, and each loop's work cycle), and the
**decision-boards** skill for the shared mechanism and the discovery layer
(`scripts/boards`).

---

## 1. Read the board FIRST — it is the plan

The admin's ordering IS the loop's work order. Never re-rank it.

```bash
scripts/features                 # the build order, readable text (the loop's input)
scripts/features --impact        # the documented-impact view (JSON)
scripts/features --json          # JSON instead of text
# or straight: GET /api/admin/features?format=text  (break-glass creds)
```

The text output is a numbered, top-down build order:

```
FEATURE BUILD ORDER (admin-decided; build top-down — see FEATURES.md §3)

1. F-1 [high] (admin priority 1) votes=2 effort=~2 days — Graduate the sandbox…
   <summary>
   ADMIN NOTE: <direction, if any>
...
Shipped/dropped: F-6 [shipped], F-8 [shipped], …
```

- **Explicit priority is the FIXED order.** Prioritized items come first
  (ascending). Unprioritized items follow by votes, then documented impact,
  then §3 order. Shipped/dropped items are the tail — context, not work.
- `§3`'s default order is used ONLY when the board carries no priorities. When
  in doubt, the board wins.
- Read the `ADMIN NOTE` — it's the owner's direction for that item.

## 2. The build cycle (one round)

```
read board → take top open item(s) → build a TIER → verify → flip status → push → repeat
```

1. **Take the top open item** in the fixed order (or fan out the top-N to
   sub-agents on DISJOINT files — see §3). Read the item's `FEATURES.md` §3
   entry for the full description, and the skill it names.
2. **Build a tier.** Features here grow through registry/catalog **seams**
   (`games.js`, `search-sources.js`, `providers.js`, the board core itself) and
   must hold the load-bearing invariants (no function calling in the pipeline,
   fail-soft helpers, split model routing, the privacy split, EN+SV parity).
   Ship a coherent tier, not a half-wired one.
3. **Verify.** `npm test` + `npm run typecheck` always; PLUS the change's real
   check — the **verify**/live-verify convention (anything touching a provider,
   D1, or the DOM is verified live, not just unit-tested).
4. **Flip status in the SAME commit as the work** (the mirror discipline):
   - `src/features.js` catalog `status`: `open → shipped` (or `dropped`), or
     leave `open` and note the residual if only a tier landed
     (`🟡 PARTIAL` in §3).
   - `FEATURES.md` §3 status tag + one line on what landed (files + mechanism).
   - a dated `FEATURES.md` §4 history line.
5. **Push.** The panel reflects the new state on the next deploy; the D1 review
   row (votes/notes/priority) stays as the audit trail. Start the next round
   from step 1 against the owner's re-sorted board.

## 3. Fan out by priority (parallel rounds)

For a wide round, take the top-N open items *in the fixed order* and dispatch
one sub-agent per item (the Agent tool), each on a DISJOINT set of files so they
don't collide. Keep the shared edits — `FEATURES.md` + the `src/features.js`
catalog (the mirror discipline) — for the orchestrator to integrate, and have
agents report their status-flip rather than commit it. Verify each diff, run the
full suite, then flip each item's status + doc + history in one integrating
commit.

## 4. Status lifecycle & the mirror discipline

`🔵 OPEN` (planned) → `🟡 PARTIAL` (a tier shipped, more planned) →
`✅ SHIPPED` (done), or `⚪ DROPPED` at any point (record who/when/why). The
board core treats catalog `status === "open"` as the work set; everything else
sinks to the shipped/dropped tail.

**Ids are forever.** The admin's votes/effort/notes/priority live in D1
(`features_reviews`) keyed by the F-id, so a shipped item KEEPS its id and new
items take the next free `F-n`. Never renumber.

**Mirror in the same commit.** `FEATURES.md` §3 is the source of truth;
`src/features.js`'s `FEATURE_ITEMS` is its code mirror (same ids, same order,
same statuses). Any §3 edit updates the catalog in the same commit — the unit
suite (`src/features.test.js`) pins the shape (F-1..F-N in order, valid
statuses, real summaries).

---

## 5. Implementing a NEW loop (priority board) — the checklist

A priority board is the same machine over a new catalog. Copy the features
board (itself copied from the security board) and swap the item shape. The nine
steps (each verified by `src/features.js` / `src/security-risks.js` as the
reference):

1. **Source-of-truth doc** — a living `<THING>.md` with a §3 priority-ordered
   backlog, maintenance rules (mirror-in-same-commit, priority-overrides-doc-
   order, stable ids), and a §4 append-only history log. `FEATURES.md` is the
   template.
2. **Catalog module** `src/<board>.js` — `<BOARD>_ITEMS` (stable ids, array
   order = doc order, a documented RANK dimension + a `status`), a projection
   (`project<Item>`, spreading `reviewState`), an ordering
   (`order<Item>s` wrapping `orderBoardItems` with the board's rank), a
   `format<Board>Text` (the loop's numbered input), and the endpoint handler.
   **Re-export the board core's validators façade-style**
   (`export const validateReviewPatch = validateBoardPatch`) — never copy them;
   a test pins identity.
3. **D1 table** `<board>_reviews` in `src/db.js`'s SCHEMA — the same six
   columns (`item_id` PK, votes, score, note, priority, updated_at).
4. **Route** in `src/admin-api.js` — `/<board>` + `/<board>/…` → the handler
   (the admin gate is already upstream in `index.js`).
5. **Panel section** in `public/admin/index.html` + a render fn in
   `public/js/admin.js` — reuse the shared board UX: `class="board
   reorderable"` (the panel has ONE view — the drag-reorderable work order;
   no order-toggle tabs, 2026-07-15 owner directive), `class="rowitem
   board-item"` with `dataset.id`, a `.head` (grip · rank badge ·
   status/priority badges · title · votes · caret) and a `.board-detail`
   (summary + the priority/score/note inputs + Save). Wire
   `wireBoardItemToggle(el)` for tap-to-open, `enableBoardReorder(container,
   ids => …)` for drag-to-priority, and `wireBoardReset(btn, path, getItems,
   reload)` for the "Reset to default order" button (clears every priority →
   the documented ranking). Add rank badge colors to `public/css/admin.css`.
6. **CLI** `scripts/<board>` — copy `scripts/features`
   (list / `--json` / the second ordering / `--vote ID up` / `--set ID '{…}'`).
   `chmod +x`.
7. **Register for discovery** — append ONE entry to `ADMIN_BOARDS` in
   `src/admin-boards.js` (`id/title/purpose/feeds_loop/api/text_query/
   orderings/order_help/script/skill`). Fill `order_help` with HOW to pick each
   ordering, not just the names. Update `src/admin-boards.test.js`'s
   expected-ids/count.
8. **Tests** — `src/<board>.test.js`: catalog shape + mirror discipline
   (ids in order, valid statuses, real summaries), the two orderings, the
   façade-is-the-core identity check, and the `?format=text` rendering. The
   board core (`src/board.js`) itself is already covered.
9. **Docs** — the `docs/CODE-LAYOUT.md` `src/` table row + the
   `docs/TESTING.md` test-suite note; the doc's
   maintenance rules; a row in `docs/DECISION-BOARD-LOOPS.md` §1; and a loop
   skill (or a section here) that says **read the board before every round** —
   a board is pointless if the loop doesn't start there.

### Board-shape decisions worth stealing from the features board

- **Reuse the shared "score" field, relabelled.** The board core validates
  `{score, note, priority}`. The features board keeps `data-f="score"` but
  labels it **Effort** in the panel and renders `effort=` in the text — the
  mechanism is generic, the vocabulary is board-specific.
- **Pick a rank that isn't severity.** Security ranks by `severity` (red
  palette). Features rank by `impact` with a POSITIVE palette (`imp-*`) — a
  high-impact feature is desirable, not a danger. Choose the rank word and
  colors that fit the board's meaning.
- **`status === "open"` is the work set.** The core's ordering hardcodes
  `"open"` for the open-vs-closed split, so the active status MUST be literally
  `open`; name the closed statuses whatever fits (`shipped`/`dropped`,
  `fixed`/`accepted`).
- **Drag writes priority 1..N.** The panel's `enableBoardReorder` PATCHes only
  the items whose priority changed; on reload the server re-sorts (open first),
  so closed items sink even if dragged up — expected, not a bug.

---

## 6. The attention board — a votes-only selection variant

The **panel selection board** (`src/panels.js`, `scripts/panels`, D1
`panels_reviews`) is a decision board of a **different kind** from the two
backlog channels above. It is the reference for a whole class of loop, so it's
worth understanding as its own pattern.

**What makes it different**

- **Its items ARE the admin panels themselves** — Notifications, Usage, Users,
  the Security/Features boards, Configuration — not a list of work.
- **No board widget.** There is no "panels" section on `/admin`. Instead
  `loadPanels()` injects ▲/▼ thumbs into *each panel's own header* and
  re-sequences the `<section>`s. The board is invisible as a widget; it's
  expressed only as the admin view reshaping.
- **It reshapes purely on votes.** No drag, no explicit priority number. Vote a
  panel up → it floats to the top; vote it net-negative → it collapses (body
  hidden) and sinks. That's the whole interaction.
- **The order is ATTENTION, not a backlog.** The focus order
  (`scripts/panels` / `GET /api/admin/panels?format=text`) answers *"which admin
  surface is the owner working on now?"* — one level ABOVE the per-board work
  orders. A session reads it to pick a surface, then reads THAT surface's own
  board (`scripts/security`, `scripts/features`) for the items within it.

**Why it's still the same machine.** It reuses `src/board.js`'s
`orderBoardItems` in `"priority"` mode — but *never sets a priority*, so the
ordering collapses to exactly *votes-desc, catalog order as tiebreak*. The
"reshapes purely on thumbs" behavior falls straight out of the shared core.
`src/panels.js` is therefore a thin façade (catalog + projection +
`formatPanelsText` + endpoint), same as the security/features boards. All
panels are `status: "open"` — a live admin surface has no closed notion.

**Running the attention loop.** When the owner drives a session by voting
panels rather than naming a task:

```bash
scripts/panels                    # the focus order (top = what's in focus now)
scripts/panels --vote users up    # (the owner does this from the /admin headers)
```

Read `scripts/panels` FIRST to see the top surface, work that surface's own
board top-down, and re-read between rounds — the owner's votes are the plan.
A net-negative panel is one the owner has explicitly pushed out of the way;
don't work it unless asked.

**Building another votes-only board** is the §5 checklist minus the drag/
priority UI: give each rendered item a ▲/▼ vote widget instead of a board
section, skip `enableBoardReorder`, order by `"priority"` mode with no
priorities set, and phrase the `?format=text` header as the loop's question.
`src/panels.js` + `public/js/admin.js`'s `loadPanels()` are the reference.

---

## Running it as a standing loop

The owner drives most work through these boards. A typical standing invocation:
"work the features board" → read `scripts/features`, build the top open item(s)
in the fixed order, flip status, push, repeat until the open set is empty or the
owner stops. Between rounds the owner re-sorts the panel; each round re-reads
the board so the latest order always wins. For a combined session, run
`scripts/boards` first to pop up BOTH channels (security + features) and work
them in whatever cross-board order the owner asks for.
