// @ts-check
// Pure, import-free helpers behind the research-activity UI (activity.js) —
// the DOM-free logic pulled out so it's directly unit-testable without loading
// settings.js / imagedeck.js (the pattern sse.js and message-content.js follow).
// activity.js imports these back and re-exports the ones other modules use, so
// its public surface is unchanged.

// Convert the Street View SDK's zoom to the Static API's fov so a captured
// frame matches what's on screen (zoom 0 ≈ 180° wide, zoom 1 ≈ 90°, each level
// halves it; Static accepts 10-120).
/** @param {number|string} zoom */
export function zoomToFov(zoom) {
  const z = Number.isFinite(Number(zoom)) ? Number(zoom) : 1;
  return Math.round(Math.min(120, Math.max(10, 180 / Math.pow(2, z))));
}

// Compacts a status event before it enters the per-turn research log (the
// "Copy research JSON" source): `streetview_frames` carries whole JPEG data
// URLs — hundreds of KB that would bloat the export — so only the frame count
// and directions are recorded, and `quiz` carries the full question set —
// several KB already persisted in the conversation's embeds registry — so
// only its title and question count are. Everything else passes through
// unchanged.
/** @param {any} s @returns {any} */
export function sanitizeResearchEvent(s) {
  if (s?.type === "streetview_frames") {
    const frames = Array.isArray(s.frames) ? s.frames : [];
    return {
      type: s.type,
      query: s.query,
      frames: frames.length,
      directions: frames.map((/** @type {any} */ f) => f?.dir || f?.label || ""),
    };
  }
  if (s?.type === "quiz") {
    return {
      type: s.type,
      title: s.quiz?.title || "",
      questions: Array.isArray(s.quiz?.questions) ? s.quiz.questions.length : 0,
    };
  }
  if (s?.type === "workflow") {
    // The plan graph carries every agent's full task text — compact it to the
    // team's shape; the agent names keep the log readable.
    return {
      type: s.type,
      title: s.title || "",
      agents: (Array.isArray(s.agents) ? s.agents : []).map(
        (/** @type {any} */ a) => `${a?.name || a?.id} (${a?.kind})`,
      ),
      waves: Array.isArray(s.waves) ? s.waves.length : 0,
    };
  }
  return s;
}

// Which provider ran a search must always be visible on the card (a user
// report showed Hugging Face Hub and web searches rendering identically as
// "Searched ..."): the events carry `source` (slug) + `service` (display
// name) since 2026-07-08; absent fields (older stored events) fall back to
// the web wording.
/** @param {{service?: string}|null|undefined} info */
export function searchServiceName(info) {
  return (info && info.service) || "Web search";
}

// ---- bash-lite sandbox step -------------------------------------------------

// The output body shown when a sandbox command row is expanded: stdout and/or
// stderr (labeled only when BOTH are present), trailing whitespace trimmed, or
// "(no output)" when the command printed nothing. The exit code is rendered
// separately (as a badge), so it isn't part of this text. Pure; never throws.
/** @param {any} run */
export function shellRunOutputText(run) {
  const r = run && typeof run === "object" ? run : {};
  const out = typeof r.stdout === "string" ? r.stdout.replace(/\s+$/, "") : "";
  const err = typeof r.stderr === "string" ? r.stderr.replace(/\s+$/, "") : "";
  if (out && err) return "stdout:\n" + out + "\n\nstderr:\n" + err;
  if (out) return out;
  if (err) return err;
  return "(no output)";
}

// The stats footer text from the `done` event (model, duration, tokens,
// searches). Pure string builder; renderStats writes it into the DOM.
/** @param {any} s */
export function formatStatsLine(s) {
  const parts = [];
  if (s.model) parts.push(String(s.model).split("/").pop());
  if (s.duration_ms != null) parts.push((s.duration_ms / 1000).toFixed(1) + " s");
  const tokens = (s.prompt_tokens || 0) + (s.completion_tokens || 0);
  if (tokens) parts.push(tokens.toLocaleString() + " tokens");
  if (s.searches) parts.push(s.searches + (s.searches === 1 ? " search" : " searches"));
  return parts.join(" · ");
}

/**
 * One entry in a turn's researchLog: a sanitized SSE status event, or a
 * client-recorded marker ({event: "error"|"stopped"|"stream_dropped", …}),
 * stamped with `t` = ms since the turn started. Written by stream.js's
 * recordResearchEvent and turns.js's setError; read only here.
 * @typedef {object} ResearchLogEntry
 * @property {number} t        ms since the turn started
 * @property {string} [type]   SSE status type (search_done, step_done, done, …)
 * @property {string} [event]  client-side marker (error, stopped, stream_dropped)
 */

/**
 * Structured, JSON-serializable record of a turn's whole research process —
 * the source for the "Copy research JSON" button. Pure (reads only plain turn
 * fields, no DOM). `timeline` is the raw ordered event log (ResearchLogEntry[]);
 * `steps`/`searches`/`sources` are convenience projections of it.
 * @param {{researchLog?: any[], doneStats?: any, text?: string, question?: string,
 *   model?: string, errored?: boolean}} turn  the turn object (turns.js addAssistantTurn)
 * @returns {object} the debug record ({question, model, stats, steps,
 *   searches, sources, answer, answerChars, errored, errors, timeline})
 */
export function buildResearchDebugJson(turn) {
  const log = Array.isArray(turn.researchLog) ? turn.researchLog : [];
  const searches = log
    .filter((/** @type {any} */ e) => e.type === "search_done")
    .map((/** @type {any} */ e) => ({
      round: e.round,
      query: e.query,
      source: e.source || "web",
      service: e.service || "Web search",
      results: e.results,
      duration_ms: e.duration_ms,
      sources: (e.sources || []).map((/** @type {any} */ s) => ({ title: s.title, url: s.url })),
    }));
  const steps = log
    .filter((/** @type {any} */ e) => e.type === "step_done")
    .map((/** @type {any} */ e) => ({
      id: e.id,
      label: e.label,
      details: Array.isArray(e.details) ? e.details : [],
    }));
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
  const errors = log
    .filter((/** @type {any} */ e) => e.event === "error")
    .map((/** @type {any} */ e) => e.error);
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

