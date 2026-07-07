// Research-activity UI: the step bars streamed during a run (searches and
// generic pipeline steps), the stats footer, and the end-of-run collapse
// into a single expandable summary bar. All functions operate on the `turn`
// object created by turns.js; scrolling is the caller's concern.

// Generic pipeline steps (plan / gap check / synthesis / validation).
export function startGenericStep(turn, id, label) {
  const details = document.createElement("details");
  details.className = "step";
  const summary = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spin";
  const lab = document.createElement("span");
  lab.textContent = label;
  summary.append(spin, lab);
  details.appendChild(summary);
  details.addEventListener("click", (e) => {
    if (!details.classList.contains("expandable")) e.preventDefault();
  });
  turn.activity.appendChild(details);
  turn.steps[id] = { details, summary, label: lab };
}

// Updates an in-progress step's label in place (spinner kept) — e.g. the
// recovery step ticking "Still researching… (Ns)" so a long wait reads as
// live progress, not a frozen screen. No-op if the step doesn't exist.
export function updateGenericStep(turn, id, label) {
  const step = turn.steps[id];
  if (step) step.label.textContent = label;
}

// Shared by finishGenericStep/finishSearchStep: marks a step's details/
// summary as finished — adds the "finished" class and swaps the spinner
// for a checkmark. Doesn't touch "expandable"; callers add that based on
// whether they have anything to show inside.
function markFinished(step) {
  step.details.classList.add("finished");
  step.summary.querySelector(".spin")?.remove();
  const check = document.createElement("span");
  check.className = "check";
  check.textContent = "✓";
  step.summary.prepend(check);
}

export function finishGenericStep(turn, s) {
  const step = turn.steps[s.id];
  if (!step) return;
  markFinished(step);
  step.label.textContent = s.label || "";
  const items = Array.isArray(s.details) ? s.details : [];
  if (items.length) {
    step.details.classList.add("expandable");
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = String(it);
      ul.appendChild(li);
    }
    step.details.appendChild(ul);
  }
}

// "Searching the web: …" with a spinner.
//
// Searches within one round run concurrently server-side (src/pipeline.js),
// so several search_start events can arrive before any search_done — keyed
// by query text (pipeline.js already dedupes queries within a round, so
// this is always a unique key) rather than assuming strict start/done
// pairing.
export function startSearchStep(turn, query) {
  const details = document.createElement("details");
  details.className = "step";
  const summary = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spin";
  const label = document.createElement("span");
  label.textContent = "Searching the web: “" + query + "”";
  summary.append(spin, label);
  details.appendChild(summary);
  // Block toggling while running (no sources to show yet).
  details.addEventListener("click", (e) => {
    if (!details.classList.contains("finished")) e.preventDefault();
  });
  turn.activity.appendChild(details);
  (turn.pendingSearchSteps ||= new Map()).set(query, { details, summary, label });
}

// Resolve the step: checkmark, counts, timing, expandable source list.
export function finishSearchStep(turn, info) {
  const step = turn.pendingSearchSteps?.get(info.query);
  if (!step) return;
  turn.pendingSearchSteps.delete(info.query);
  markFinished(step);
  step.details.classList.add("expandable");
  const n = info.results ?? 0;
  step.label.textContent =
    "Searched “" + info.query + "” · " +
    n + (n === 1 ? " result" : " results") + " · " +
    Math.round(info.duration_ms ?? 0) + " ms";
  const ul = document.createElement("ul");
  for (const src of info.sources || []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = src.url;
    a.textContent = src.title || src.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.appendChild(a);
    ul.appendChild(li);
  }
  step.details.appendChild(ul);
}

// Stats footer from the `done` event (model, duration, tokens).
export function renderStats(turn, s) {
  turn.searchCount = s.searches || 0;
  const parts = [];
  if (s.model) parts.push(String(s.model).split("/").pop());
  if (s.duration_ms != null) parts.push((s.duration_ms / 1000).toFixed(1) + " s");
  const tokens = (s.prompt_tokens || 0) + (s.completion_tokens || 0);
  if (tokens) parts.push(tokens.toLocaleString() + " tokens");
  if (s.searches) parts.push(s.searches + (s.searches === 1 ? " search" : " searches"));
  turn.stats.textContent = parts.join(" · ");
}

// Stop any step still showing a spinner now that the run is over. Every step
// normally gets its own step_done, but a RECOVERED answer (a stream that
// dropped and finished server-side) doesn't replay the step_done events for
// whatever was mid-flight when the connection died — so that step (a gap
// check, a search, synthesis) would spin FOREVER beside a finished answer,
// making a completed run look like it's still processing (the reported bug).
// Settle them neutrally: remove the spinner and add a muted mark, not the
// green ✓ (we don't have the step's verified result, only that the run has
// ended). Idempotent and safe to call on already-finished steps.
function settlePendingSteps(turn) {
  const settle = (step) => {
    if (!step || step.details.classList.contains("finished")) return;
    step.summary.querySelector(".spin")?.remove();
    step.details.classList.add("finished");
    if (!step.summary.querySelector(".check, .settled")) {
      const mark = document.createElement("span");
      mark.className = "settled";
      mark.textContent = "✓";
      step.summary.prepend(mark);
    }
  };
  for (const id in turn.steps) settle(turn.steps[id]);
  if (turn.pendingSearchSteps) {
    for (const [, step] of turn.pendingSearchSteps) settle(step);
    turn.pendingSearchSteps.clear();
  }
}

// Collapse the live activity bars into one expandable summary once the
// answer is complete. Leaves a lone bar (e.g. a direct reply) as-is. The
// .done class keeps the summary bar visible when re-expanded, so the group
// can always be folded back to a single bar.
export function collapseActivity(turn) {
  settlePendingSteps(turn); // stop any spinner a dropped/recovered run left behind
  const steps = turn.activity.querySelectorAll(":scope > .step");
  if (steps.length <= 1) return;
  const searches = turn.searchCount;
  turn.activityLabel.textContent = searches
    ? `Research process · ${steps.length} steps · ${searches} search${searches === 1 ? "" : "es"}`
    : `Research process · ${steps.length} steps`;
  // A debug affordance that lives at the top of the expanded step list:
  // copies a full JSON record of every research task this run performed
  // (steps, queries, service lookups, timings, sources, stats) for pasting
  // into Claude Code. Only added once, and only for real multi-step runs.
  if (!turn.activity.querySelector(":scope > .activity-debug")) {
    turn.activity.prepend(makeCopyDebugButton(turn));
  }
  turn.activityWrap.classList.add("done");
  turn.activityWrap.open = false;
}

// Structured, JSON-serializable record of a turn's whole research process —
// the source for the copy button below. Pure (reads only plain turn fields,
// no DOM), so it's unit-testable. `timeline` is the raw ordered event log;
// `steps`/`searches`/`sources` are convenience projections of it.
export function buildResearchDebugJson(turn) {
  const log = Array.isArray(turn.researchLog) ? turn.researchLog : [];
  const searches = log
    .filter((e) => e.type === "search_done")
    .map((e) => ({
      round: e.round,
      query: e.query,
      results: e.results,
      duration_ms: e.duration_ms,
      sources: (e.sources || []).map((s) => ({ title: s.title, url: s.url })),
    }));
  const steps = log
    .filter((e) => e.type === "step_done")
    .map((e) => ({ id: e.id, label: e.label, details: Array.isArray(e.details) ? e.details : [] }));
  // Every cited source, deduped by URL across all search rounds.
  const seen = new Set();
  const sources = [];
  for (const s of searches) {
    for (const src of s.sources) {
      if (src.url && !seen.has(src.url)) {
        seen.add(src.url);
        sources.push(src);
      }
    }
  }
  const d = turn.doneStats;
  const stats = d
    ? {
        model: d.model,
        rounds: d.rounds,
        searches: d.searches,
        duration_ms: d.duration_ms,
        prompt_tokens: d.prompt_tokens,
        completion_tokens: d.completion_tokens,
      }
    : null;
  // Every error the turn hit, server- or client-side (setError records them
  // all into the log). `answer` is the full resulting generation exactly as
  // rendered — including any post-validation revision, a "*(Stopped.)*"
  // marker, or an appended "[…error…]" note — so the export is the complete
  // response, not just its metadata.
  const answer = turn.text || "";
  const errors = log.filter((e) => e.event === "error").map((e) => e.error);
  return {
    question: turn.question || "",
    model: turn.model || d?.model || "",
    stats,
    steps,
    searches,
    sources,
    answer,
    answerChars: answer.length,
    errored: !!turn.errored,
    errors,
    timeline: log,
  };
}

function makeCopyDebugButton(turn) {
  const bar = document.createElement("div");
  bar.className = "activity-debug";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "debug-copy-btn";
  btn.textContent = "Copy research JSON";
  btn.title =
    "Copy a JSON record of every research task this run performed — paste into Claude Code to debug";
  btn.addEventListener("click", async (e) => {
    // Inside the <details> content, so a click here must not toggle it.
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildResearchDebugJson(turn), null, 2));
      btn.textContent = "Copied ✓";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Copy research JSON"; }, 1500);
  });
  bar.appendChild(btn);
  return bar;
}
