# Starter-prompt evaluation — findings ledger

Append-only. One entry per battery of `tests/starter-eval.mjs`. Entries are
never edited or deleted once written, because a `rank` in
`public/js/starters-data.js` cites a run id here as its evidence — rewriting an
entry would silently change what a shipped number means.

**What a run id looks like:** the results directory name, e.g.
`2026-07-26T07-29-27-367Z`. The results themselves are gitignored (they contain
full answer text and are large); this ledger is the permanent record.

**Promoting a rank.** A starter earns `rank` + `evidence` in
`starters-data.js` only after a run recorded here put it above the shortlist
floor (3.8). Copy the score, cite the run id, and note it below. Never
hand-tune a rank to move a starter up the strip — that is what the explore
slots are for.

---

## 2026-07-26T07-29-27-367Z — first battery (2 starters, outrospection)

- **Scope:** `STARTER_AGENTS=outrospection STARTER_LIMIT=2`, answer + judge
  model `openai/gpt-oss-120b`, budget 60 s.
- **Result:** both starters scored **1.35**; nothing cleared the floor.
- **Finding — the harness was wrong, not the starters.** Both runs retrieved
  correctly: the trace shows `outrospect: 24 items` off the outward feed, and
  the answers cited real arXiv entries from it. But `traceOf` only counted
  `search`/`search_done` events, so the judge was handed `web searches: 0,
  sources: 0` and concluded the citations were fabricated — scoring a working
  starter 1.35 for a failure that never happened.
- **Cause:** the counters describe the *research* pipeline only. Introspection
  retrieves source excerpts and outrospection reads the feed; both surface as
  `step_done` labels and neither touches a search counter. Judging every agent
  on research-shaped counters structurally under-scores the two modes that do
  not search.
- **Fix:** `traceOf` now collects the `step_done` timeline and
  `starterJudgePrompt` renders it as a `PHASE TIMELINE` block, with an explicit
  instruction not to judge capability on the web-search counters alone.
  Regression-tested in `public/js/starters-core.test.js` ("the judge prompt
  carries the phase timeline").
- **Ranks promoted:** none. Scores from this run are void — they measured the
  harness.

---

## 2026-07-26T07-31-54-775Z — second battery (6 starters, outrospection + research)

- **Scope:** `STARTER_AGENTS=outrospection,research STARTER_LIMIT=3`,
  `openai/gpt-oss-120b` for both roles, budget 60 s, concurrency 3. First run
  with the phase-timeline fix.
- **Result:** the fix held. The same two outrospection starters that scored
  1.35 on counters-only scored **3.00 and 3.05** with the timeline in the
  prompt, and `out-browser-models` scored 3.90. Research scored 5.00 / 4.40
  with one judge parse failure.
- **Ranks promoted:** none — superseded by the wider battery below, run on the
  same code an hour later.

---

## 2026-07-26T07-34-22-617Z — first full cross-agent battery

- **Scope:** all agents, `STARTER_LIMIT=4` (the first four of each queue),
  `openai/gpt-oss-120b` for both answer and judge, budget 75 s, concurrency 4.
  20 runs judged across 5 agents; `secure` and `under-construction` skipped as
  structurally undrivable from the server.
- **Means:** orchestrator 4.28, agent-builder 4.24, introspection 4.17,
  research 3.69, outrospection 2.99. **Zero dead ends** across all 20 — the
  editorial rule (name a subject *and* a task) held everywhere it was tested.
- **Ranks promoted: 14.** research `res-sv-elpris` 4.4, `res-sv-ranta` 4.25,
  `res-compare-edge` 4.0; introspection `int-pipeline` 4.65,
  `int-sv-visualisera` 4.3, `int-split` 4.05; orchestrator `orc-competitors`
  4.4, `orc-market-tech-reg` 4.4, `orc-jurisdiction` 4.15, `orc-vectordb` 4.15;
  outrospection `out-deep-research` 3.8; agent-builder `agb-minimal` 4.65,
  `agb-tutor` 4.65, `agb-news` 4.4.

### Finding 1 — a broad recency question is a bad opener

`res-news-tech` scored **2.10**, the worst non-outrospection result. It asked
for "the most significant developments in open-source AI from the past month".
The pipeline retrieved 24 sources and then wrote around them; the judge read
that, correctly, as citing unrelated material. The lesson generalises: a
recency starter needs a subject narrow enough that the sources it finds are the
sources it needs. **Rewritten** (same id, now about self-hostable model
releases and their hardware) and left unranked pending a re-run.

### Finding 2 — outrospection is the weakest agent, and it is not the starters

Outrospection is the only agent whose mean sits below the shortlist floor
(2.99), with two starters at **2.35**. The judge's notes are consistent and
specific: *"fails to cite any of the provided sources"* and *"offers a generic
overview instead of routing to the outward feed"*. `out-browser-models` also
swung 3.90 → 2.35 between two batteries an hour apart, which points at feed
coverage varying by lens rather than at the question.

This is a **product finding, not a queue problem**, and it independently
reproduces what a real user reported: `chat_logs` #636/#637 got empty-handed
outrospection answers and #638 was the user saying both were inadequate. The
starters here name their lens explicitly and *still* land at 2.35, so the
weakness is downstream of the question — in lens routing, feed coverage, or how
the retrieved entries reach the answer. Route it per the **feature-maintenance**
skill rather than by rewriting these starters; they are doing their job by
exposing it.

### Finding 3 — Agent Studio's failure mode is the opposite one

`agb-legal` scored 3.25 against 4.65/4.65/4.40 for its siblings, and the note
says it "stops short" — it produced the files but no live link. The three that
cleared the floor all shipped something reachable. For this agent a starter
earns its place by being concrete enough to *finish*, not merely to start.

<!-- Append the next entry above this line. -->
