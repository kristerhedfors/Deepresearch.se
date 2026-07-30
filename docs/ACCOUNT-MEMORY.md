# Account memory — a linked note graph, stored the way Obsidian stores knowledge

*(Shipped 2026-07-30. **Code:** `public/js/memory-core.js` (the note model,
Obsidian serialization and the extraction prompt — pure), `public/js/zip-core.js`
(the hand-rolled ZIP writer — pure), `src/memory.js` (D1 + the three endpoints +
the extraction tail), `public/js/account-memory.js` (Settings → Memory),
`memory_notes` in `src/db.js`, the `memory` knob in `src/settings.js`.
Experimental, like everything here. Background and the decision to build it:
`docs/AGENTIC-GRAPHS.md` §5.4.)*

## 1. What it is

The research pipeline forgets everything structural between runs. Every request
re-derives who the entities are and how they relate, because the only thing that
survives a turn is prose in a chat log, and prose is not queryable.

Account memory is the missing half: durable **notes**, one per entity the
account researches, linked to each other. It is the "knowledge graph" sense of
*graph* rather than the control-flow sense the Orchestrator already implements
(`docs/AGENTIC-GRAPHS.md` §2 keeps the two apart).

The storage format is not an internal one that gets converted on the way out.
**The store already is an Obsidian vault**: one Markdown file per note, YAML
frontmatter for its properties, `[[wikilinks]]` as the only edge type. Export is
therefore a layout pass (`vaultFiles`), not a translation — which is the point.
A user can take the whole thing and keep using it in a tool this project does
not control.

## 2. The note model

| Field | Meaning |
|---|---|
| `slug` | Identity **and** link target. Derived from the title; keeps non-ASCII letters and hyphens, strips path separators and Obsidian link syntax. |
| `title` | The entity's canonical name. |
| `type` | Closed vocabulary: `person`, `organisation`, `place`, `concept`, `event`, `source`, `note`. Each maps to a vault folder. |
| `body` | 1–4 sentences of durable fact. |
| `links` | Other note slugs. The graph's edges. |
| `tags` | Lowercase topic words, hyphenated (Obsidian tags cannot contain spaces). |

The vocabulary is closed for the same reason the Orchestrator's agent kinds are:
the extractor is a model, and an open vocabulary drifts into hundreds of
near-synonyms no folder layout can use. `note` is the escape hatch.

Bounds live in one place (`memory-core.js`): 500 notes per account, 80-character
titles, 1200-character bodies, 12 links and 6 tags per note, 6 notes proposed per
turn. A memory that grows without limit stops being memory and becomes a second
chat log.

**Merging accumulates, it does not overwrite.** A second mention of the same
slug unions links and tags, takes the newer body, and preserves the original
`created_at`. So the graph only ever gains edges, and a note's age survives
being re-mentioned. Eviction past the cap is by least-recently-touched, which is
the right axis here: a note the user keeps returning to stays fresh through
`updated_at` on every merge.

## 3. How notes get written

One JSON-mode call on the fixed `DEFAULT_MODEL`, run by `src/chat.js` **after**
the answer has streamed:

```
answer streamed → usage recorded → chat-log row → runMemoryExtraction
```

It upholds the load-bearing invariants rather than carving an exception:

- **Invariant 1** — no function calling. The extractor returns JSON; the Worker
  writes the rows. There is no write tool and no agent deciding to remember.
- **Invariant 3** — split routing. Extraction is a planning-class phase, so it
  runs on the fixed reliable JSON model, never the user's answer model.
- **Invariant 2** — fail-soft. Every path inside `runMemoryExtraction` returns
  a count with a reason; nothing throws. A memory that fails to learn changes
  nothing about the answer the user already received. The reasons are worth
  grepping in logs: `off`, `incognito`, `no_account`, `thin_answer`,
  `nothing_durable`, `error`.

The prompt is deliberately conservative and says so repeatedly: returning zero
notes is the correct and common outcome. It refuses passing phrasing, the
assistant's own reasoning, anything true only for this conversation, and
anything that looks like a credential, key, payment or health detail — skipping
the note entirely rather than redacting it.

Notes follow the user's language (invariant 6's spirit), so a Swedish
conversation yields a Swedish vault, and the ZIP writer sets the UTF-8 name flag
so those filenames survive export on every platform.

## 4. Privacy posture (invariant 4)

**Se/rver only, and that is a structural statement rather than a policy one.**
Memory is account-scoped server-side state, so it is only coherent in the tier
where the server is inside the trust boundary (owner directive, 2026-07-24).
Se/cure has no memory of this kind and must keep having none — its posture is
that the server is in no data path at all.

Every endpoint refuses an identity without a user row, which is also what keeps
a **Se/rver TOKEN** out: a token can never satisfy the signed-in gate, so the
server-token guarantee ("a token reads nothing Se/rver stores") is unaffected by
this feature. Break-glass identities are refused too — a shared operational
credential should not accumulate one person's research notes.

### The exposure this adds, stated plainly

A memory note is a **distilled, linked, cross-referenced summary** of what an
account researched. That is materially easier to read — and to re-identify a
person from — than the raw conversations it was built from, even though it
contains strictly less text. Adding it is a real increase in exposure, not a
reorganization of existing exposure, and the three limits below are what bound
it. Each has a test in `src/memory.test.js`.

| Limit | Why it is load-bearing |
|---|---|
| **Off by default** | The only knob that creates a new long-lived record of what a person researched. Opt-in, and an off knob does not even cost a model call. |
| **Never in incognito** | The ghost toggle already suppresses the `chat_logs` row. A memory note outlives that row, so if incognito did not cover it, incognito would mean less than the UI promises. |
| **Reset deletes** | `DELETE FROM memory_notes WHERE user_id = ?`. No tombstone, no soft-delete column. |

The Settings screen shows every note in full rather than a count. A store of
what the system has quietly decided to remember about someone has to be
inspectable, not merely deletable — a reset button over an opaque store asks the
user to take it on faith.

## 5. The surface

**Settings → Memory** (`public/js/account-memory.js`), one level below the gear
icon, the same door treatment as LLM sharing and the MCP server — it holds a
switch, a browsable store and two actions, which is a screen rather than a knob.

- the switch (**Remember what I research**), with the full explanation in the
  press-and-hold info popover;
- what is stored: note count, link count, per-type breakdown, remaining room;
- **Download vault (.zip)** — a plain navigation to `/api/memory/export`, so the
  browser owns the transfer and it behaves the same in the installed PWA;
- **Reset memory** — behind a `confirm()`, the one irreversible control on the
  screen, sitting next to the download the user would wish they had tapped first;
- the notes themselves, read-only, links rendered as the `[[wikilinks]]` they
  are in the export so the screen and the vault match.

### Endpoints

| Route | Does |
|---|---|
| `GET /api/memory` | Notes plus counts, for the screen. |
| `GET /api/memory/export` | The vault as `deepresearch-memory-<date>.zip`. |
| `DELETE /api/memory` | Reset. |

All three refuse anything but a signed-in account.

## 6. The exported vault

```
Memory.md              generated index — links every note, regenerated each export
People/…md             one file per note, filed by type
Organisations/…md
Places/…md
Concepts/ Events/ Sources/ Notes/
```

Each note:

```markdown
---
title: "Ada Lovelace"
type: "person"
created: 2026-01-02
updated: 2026-07-30
tags: [computing]
---

# Ada Lovelace

Wrote the first published algorithm intended for a machine.

## Related

- [[Charles Babbage]]
```

Links appear in the **body**, not only in frontmatter, because Obsidian's graph
view and backlinks pane resolve body links — a frontmatter-only list would
export a graph with no visible edges. The index says out loud that it is
regenerated, so a user who edits it in Obsidian is not silently surprised on the
next download.

### Why the ZIP writer is hand-rolled

Invariant 5: no runtime dependencies. The repo already hand-rolls the read
direction (`public/js/docs.js`'s central-directory reader for `.docx`), and
writing is the easier half. Entries are **stored**, not deflated — no compressor
to get wrong, no async step, and the note caps bound a vault well under a
megabyte. Output is deterministic for a given input (the DOS timestamp is an
argument, not the clock), so two exports of an unchanged vault are byte-identical
and a test can assert on exact bytes. `zip-core.test.js` verifies it with an
independently written reader **and** against the system `unzip`.

## 7. What is not built

- **No retrieval yet.** Notes are written and exported; nothing reads them back
  into a research request. That is the obvious next step and it is a separate,
  benchmarkable change — dropping a memory block into the synthesis prompt
  affects every answer, so it belongs behind the bench gate
  (`tests/bench-gate.mjs`), not bundled with the storage.
- **No import.** A vault edited in Obsidian cannot be uploaded back.
- **No per-note editing** in the UI beyond reset-everything.
- **No Se/cure equivalent.** If browser-local memory is ever wanted for Se/cure
  it is a different design (client-held, sealed, travelling in the workspace),
  not this one with a flag flipped.
