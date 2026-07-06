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

// Stats footer from the `done` event (model, duration, tokens, CO2).
export function renderStats(turn, s) {
  turn.searchCount = s.searches || 0;
  const parts = [];
  if (s.model) parts.push(String(s.model).split("/").pop());
  if (s.duration_ms != null) parts.push((s.duration_ms / 1000).toFixed(1) + " s");
  const tokens = (s.prompt_tokens || 0) + (s.completion_tokens || 0);
  if (tokens) parts.push(tokens.toLocaleString() + " tokens");
  if (s.searches) parts.push(s.searches + (s.searches === 1 ? " search" : " searches"));
  if (s.co2_grams) parts.push((s.co2_grams * 1000).toFixed(1) + " mg CO₂");
  turn.stats.textContent = parts.join(" · ");
}

// Collapse the live activity bars into one expandable summary once the
// answer is complete. Leaves a lone bar (e.g. a direct reply) as-is. The
// .done class keeps the summary bar visible when re-expanded, so the group
// can always be folded back to a single bar.
export function collapseActivity(turn) {
  const steps = turn.activity.querySelectorAll(":scope > .step");
  if (steps.length <= 1) return;
  const searches = turn.searchCount;
  turn.activityLabel.textContent = searches
    ? `Research process · ${steps.length} steps · ${searches} search${searches === 1 ? "" : "es"}`
    : `Research process · ${steps.length} steps`;
  turn.activityWrap.classList.add("done");
  turn.activityWrap.open = false;
}
