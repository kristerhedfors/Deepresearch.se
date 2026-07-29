---
name: starter-prompts
description: >-
  Load when working on the STARTER PROMPTS shown on an empty chat — the four
  example questions offered when a visitor opens any agent — or on the
  cross-agent evaluation system that ranks them. Triggers: "add starter
  questions", "the example prompts on the empty chat", "which openers do we
  know work", "the starter queue", "evaluate the starter prompts", "shortlist
  the best first questions", "rank the openers for <agent>", or any edit to
  public/js/starters-data.js, public/js/starters-core.js, public/js/starters.js,
  src/starters.js, scripts/starters, tests/starter-eval.mjs, or
  tests/STARTER-EVAL-FINDINGS.md. Covers the queue model (4 shown, 20+ deep,
  exploit/explore rotation), the provenance rule (starters are synthetic —
  never lifted from chat_logs), the three judged dimensions and the dead-end
  cap, how to run a battery, and how a rank gets promoted with evidence. ALSO
  EVALUATION MODE — the Settings knob "Starter prompt evaluation" that turns the
  strip into a cross-agent review batch (the proven / weak / untried / candidate
  bands, new questions every render off a browser-local seen ledger, no 👍👎:
  the verdict is a "feedback …" message in the chat the chip opened) — and the
  CANDIDATES trial pool that new questions are promoted into a queue from,
  including the rule that a session working on evaluation ADDS new candidates.
  ALSO the #XP-<nn> tag every starter
  carries, how an evaluation chip sends it so feedback ties back to the exact
  starter, and where the pipeline strips it.
---

# Starter prompts — the queue and its evaluation

## What this is

Every agent has a QUEUE of opening questions. Four show on an empty chat; at
least twenty sit behind them. Which four show is decided by
`selectStarters()`, and which ones are *known good* is decided by running them
and judging what came back.

The problem it solves is narrow and real. A newcomer opening a fresh agent used
to get a paragraph of prose and an empty box, and the questions people actually
type into that box are the weak ones — `update`, `current`, `build`. Those are
not bad questions because the model is weak; they name no subject and no task,
so the agent has nothing to act on. `chat_logs` #636 and #637 are both of them,
sent to the outrospection agent, and #638 is the user saying both answers were
inadequate.

## The pieces

| File | Role |
| --- | --- |
| `public/js/starters-data.js` | The registry — one queue per agent. The authoritative data. |
| `public/js/starters-core.js` | Pure logic: select, rotate, score, rank, validate, judge prompt. |
| `public/js/starters.js` | The DOM half — renders the strip, holds the local cursor, click signal and eval seen ledger. |
| `src/starters.js` | Server/CLI façade (re-export only; the agent-spec.js pattern). |
| `public/js/starters-core.test.js` | Unit tests + the validator run over the real registry. |
| `scripts/starters` | Offline CLI: report, queue, strip preview, aspects, shortlist, batch, coverage, validate, `--xp <n>` lookup. |
| `tests/starter-eval.mjs` | The live cross-agent battery. |
| `tests/STARTER-EVAL-FINDINGS.md` | Append-only ledger. A `rank` cites a run id here. |

## The queue model

- **`SLOT_COUNT` = 4** chips shown, **`QUEUE_MIN` = 20** minimum depth.
- **`EXPLOIT_SLOTS` = 2.** Two chips come from the shortlist (starters an eval
  run proved), two rotate through what has *not* been proven. So a newcomer
  always sees known-good openers, and the rest of the queue keeps getting
  exercised — which is what produces the evidence in the first place. An
  all-unproven queue simply explores in every slot.
- **The cursor advances when the strip is SHOWN**, not when a chip is clicked.
  Someone who reads four chips and types their own question has still seen
  those four.
- **No aspect repeats** within one strip while an unused aspect is available.
- **Language:** the strip prefers the reader's language, but falls back to the
  full pool rather than showing a one-chip strip.
- **The click signal is local-only.** `localStorage`, never sent anywhere. Not
  because it would be hard to report, but because Se/cure's whole promise is
  that the page does not phone home, and a starter-analytics beacon is exactly
  the quiet exception that promise dies of. It nudges one browser's own strip
  and is capped so three clicks cannot outrank a recorded eval result.

## The #XP tag

Every entry — queue and candidate alike — carries an `xp` number, rendered as
`#XP-07`. It is the starter's public identity, and it exists because a reviewer
reporting on a chip had no way to say *which* chip: feedback #37 quoted the
sentence back to us and asked for the same handle the try-it list already has
(`#UC-34`, `testpoints-core.js`).

Where it appears, and where it deliberately does not:

- **Evaluation-mode chips prepend it** to the message they compose
  (`tagStarterText`), so it sits in the first turn of the conversation. Send
  `feedback …` later in that chat and the entry carries it.
- **The ordinary visitor strip never tags.** A visitor's pick signal is
  local-only by design; prefixing an identifier onto their first message would
  put exactly the byte on the wire that promise says is not there — and show
  them a code they never asked about.
- **The pipeline strips it before any model call** (`starterRefOf` +
  `withoutStarterTags`, read at the top of `runPipeline`). If the tag survived,
  triage would plan against it and the search queries would carry it, so what
  got evaluated would no longer be the starter. Every user turn is swept, not
  just the first — a reopened chat replays its whole history.
- **The record keeps it.** `chat.js` still holds the untouched conversation, so
  the chat-log row gets `starter: "#XP-07"` and the feedback entry gets a
  `starter:` line of its own — a long transcript is trimmed from the FRONT, and
  that is exactly where the tag sits.
- **Se/cure does the same** in the browser (`drc.js` `send()`), importing the
  same core rather than a second copy of the rule — its pipeline has no server
  in it to do the stripping.

Numbering is **append-only**: a new starter takes max+1, and a number is never
reused or reordered. A number that moves silently re-points every feedback entry
that cited it. The validator enforces presence and uniqueness (across queues AND
candidates, which share one number space, so a promoted candidate keeps its
number); append-only is discipline.

```bash
scripts/starters --xp 7        # which starter #XP-07 names
```

## Provenance — this one is not negotiable

**Starters are SYNTHETIC.** Compose them here; never lift a question out of
`chat_logs`, verbatim or paraphrased. Live history tells you which *aspects*
deserve a slot; it never supplies the sentence. A starter is shown to every
visitor, so reusing a logged question publishes one user's chat onto a
stranger's opening screen, and a full-visibility log is not consent for that.
This matches the discipline `tests/bench-questions.mjs` already sets.

Mining aspects from history is encouraged and is how the current taxonomy was
built (`scripts/chatlogs 400 --json`, read for shape, not for text).

## The editorial rule

A starter must carry enough for the agent to act on with **no follow-up**:
a subject *and* a task. The validator enforces the floor (≥ 8 words, ends as a
complete question or instruction); judgement covers the rest.

Two opposite failure modes, one per end of the product:

- **Too vague to retrieve** — outrospection's `update`. Name the lens subject.
- **Too vague to build** — Agent Studio's `build`. Name the thing, its
  behaviour, and enough of a look to render. (`chat_logs` #584 is a user
  complaining that it asked a question instead of shipping.)

## Adding starters

1. `scripts/starters --aspects <agent>` — find declared aspects with no starter.
2. Add entries to the agent's queue in `starters-data.js`. Every entry needs
   `id` (unique registry-wide), `xp` (the next free number — see below), `text`,
   `aspect` (declared in `ASPECTS`), `lang`.
3. **Swedish in the same change** (invariant 6). `MIN_SV` = 6 per queue and the
   validator fails the build below it — English-only with "Swedish later" is
   exactly what the invariant exists to stop.
4. `scripts/starters --validate` then `npm test`.
5. `scripts/starters --strip <agent> --cursor 0|4|8` — read what a visitor
   actually sees before you believe it reads well.

Do **not** set `rank` by hand. It is promoted from a battery (below).

## Running a battery

```bash
BASIC_AUTH_USER=… BASIC_AUTH_PASS=… node tests/starter-eval.mjs
  STARTER_AGENTS=research,outrospection   # restrict agents
  STARTER_IDS=out-feed,res-sv-ranta       # restrict starters
  STARTER_LIMIT=4                         # first N per agent (smoke run)
  STARTER_BUDGET_S=75 STARTER_CONCURRENCY=4
```

Each starter is sent as the **first and only message** with that agent's mode
flags — a starter is only ever a first message, so evaluating it inside an
existing conversation measures something no visitor experiences. Runs go out
`incognito: true` so a 150-run battery does not drown the real traffic the
feedback loop reads from `chat_logs`.

Same rule as model-eval / eval-bench: **don't deploy or push mid-battery** — an
auto-deploy truncates in-flight streams and poisons the results.

### What is judged

Three dimensions, 1-5, weighted for what a *starter* is for rather than what a
benchmark question is for:

| Dimension | Weight | The question |
| --- | --- | --- |
| `capability` | 0.40 | Did the agent exercise the capability it exists for? |
| `firstImpression` | 0.35 | Would a newcomer understand what this agent is for, from this one turn? |
| `quality` | 0.25 | Is the answer accurate, specific, grounded? |

Plus **`deadEnd`** — a clarifying question, refusal or error. Not a weight but a
**cap** (`DEAD_END_CAP` = 2.5): however well the reply reads, the visitor is
back at an empty box, so it can never reach the shortlist floor (3.8).

### Judge on the timeline, not the counters

**The trap, and it has already bitten once.** Only the research pipeline
reports through search counters. Introspection retrieves source excerpts and
outrospection reads the outward feed; both surface as `step_done` labels and
neither touches `searches`/`sources`. The first battery
(`2026-07-26T07-29-27-367Z`) judged outrospection on counters alone, saw `0/0`
for runs that had just read 24 feed items, called the real citations
fabricated, and scored two good starters 1.35. With the phase timeline in the
prompt the same starters scored 3.0–3.9.

If you add a mode with a new retrieval shape, check that `traceOf` in
`starter-eval.mjs` surfaces its steps before you trust a single score.

### Agents the battery cannot cover

Reported as skipped, loudly, in the console and in `_summary.json` — a battery
that silently covered 5 of 7 agents would read as full coverage:

- **`secure`** — runs browser-direct with the server in no data path, so there
  is no server endpoint to drive. Evaluate its queue from a browser against
  `/cure`.
- **`under-construction`** — a copy-me archetype bound to no deployed surface.

## Promoting a rank

1. Run the battery. Read the `SHORTLIST` block it prints.
2. Append an entry to `tests/STARTER-EVAL-FINDINGS.md` — run id, scope, model,
   results, anything learned. Append-only; never edit a past entry, because a
   shipped `rank` cites it.
3. Add `rank` **and** `evidence` (the run id) to those starters in
   `starters-data.js`. A rank without evidence fails `--validate` — invariant 5,
   evidence-driven, applied to a number that reaches the product.
4. `npm test`, then `npm run bundle` (editing tracked source stales the
   committed introspection snapshot).

A starter that scores badly is not deleted on one run. Either rewrite the text
(it was a bad opener) or leave it unranked — the explore slots will surface it
again for a second reading.

## Evaluation mode (the Settings knob)

`Settings → Starter prompt evaluation` is a **browser-local** knob (like the
on-device models row; unlike the `/api/settings` capability knobs — it grants
nothing and is never sent anywhere). Same-origin, so flipping it covers both
tiers.

When on, the visitor strip is replaced by a **review batch**: four chips drawn
across *every* agent, one per band.

| Band | What it means | Why it is in the batch |
| --- | --- | --- |
| `proven` | rank ≥ 3.8 | Does it still hold? |
| `weak` | rank < 3.8 | Is it really bad, or was the run wrong? |
| `untried` | no rank | Most of the registry lives here. |
| `candidate` | not in a queue | A question we are considering **adding**. |

Each chip is labelled with its `#XP` tag, agent and band, and — on Se/rver —
**switches the chat mode to its agent before sending**, because a cross-agent
batch that ran everything as Deep Research would measure the wrong thing. On
Se/cure the pool is restricted to the `secure` agent, since no mode switch
exists there.

### New questions every time (owner directive, 2026-07-29)

A reviewer must never be handed a question they have already been handed while
anything is unread. The mechanism is a browser-local **seen ledger**
(`dr_starter_eval_seen`, id → times shown):

- `selectEvalBatch` orders every band **least-seen first** and, while anything
  in the pool is unseen, will not fill a band's slot with something already
  shown — a small band (there are only a handful of `weak` starters) runs out
  first, and its slot goes to the backfill rather than to a repeat. When
  *nothing* is unseen the restriction lifts and the bands are honoured again on
  the second pass.
- `starters.js` records the four **as the strip renders** and advances the
  cursor, so a new chat, a mode switch or "Four more →" all bring fresh
  material. This is the opposite of the old rule (sticky until rated), which
  was right only while a rating was what retired a batch.
- Unit-tested end to end: batch after batch must not repeat until the whole
  pool has had one pass, and the pass must strand nothing.

### No 👍/👎 — the verdict is a "feedback" message

The rating buttons are gone (same directive). A tap compressed a whole
conversation into one glyph and then left it in `localStorage`, where only that
browser could read it. The judgement now travels the way every other judgement
in this product does: the reviewer starts a message with **`feedback`** in the
chat the chip opened, `src/chat.js` files that entry with the starter's `#XP`
tag on its own line, and it lands in the queue a human already works
(`scripts/feedback`, the **feedback-loop** skill). One queue, one loop, words
instead of a glyph — and it works identically on Se/cure, which posts confirmed
feedback over the Se/rver token.

So when reading where evaluation stands, `scripts/starters --coverage` gives
the machine ranks and `scripts/feedback` gives the human half. They are
deliberately not merged into one number: a disagreement between them is a
finding.

Offline equivalents:

```bash
scripts/starters --batch --cursor 3      # exactly what the knob would serve
scripts/starters --coverage              # what is still untested, per agent and band
```

## The CANDIDATES pool

`CANDIDATES` in `starters-data.js` holds questions we are **considering
adding**. They carry no rank, are not validated as queue entries, and are never
shown to ordinary visitors — evaluation mode is their only surface. Each has a
`note` saying what it is *testing*; read that before judging the answer.

- A candidate that reviews well **moves into its agent's queue** with evidence.
- One that reviews badly is **deleted**, and the reason goes in the ledger.

Aim candidates at gaps, not at variety for its own sake. The first set exists
because the first battery left `secure` at zero coverage (no server endpoint
can drive that tier — a human is the only instrument that reaches it),
`outrospection` below the floor, and several declared aspects unfilled.

**Every session that works on starter-prompt evaluation adds new candidates**
(owner directive, 2026-07-29 — the other half of "new questions every time").
The batch now serves fresh material every render, which means a working
reviewer reaches the end of the pool; a pool that never grows quietly turns
into a re-read. Before you finish, run

```bash
scripts/starters --aspects <agent>       # declared aspects with no starter
scripts/starters --coverage              # bands per agent
```

and add a wave aimed at what those two print — the unfilled aspects first, then
`secure` (still the only tier a machine battery cannot reach), then shapes the
queues under-serve. Swedish in the same change, as everywhere else (invariant
6). New numbers continue from `max(xp) + 1`; never reuse one.
