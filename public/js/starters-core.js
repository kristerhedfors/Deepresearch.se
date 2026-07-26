// @ts-check
// Starter prompts — the PURE core of the cross-agent starter-prompt queue and
// its evaluation system (Node-tested in public/js/starters-core.test.js; the
// server/CLI reach it through the src/starters.js façade, the same convention
// as agent-spec-core.js).
//
// THE PROBLEM. Opening a fresh chat with any of the agents used to show one
// paragraph of prose and an empty box. A newcomer has to guess what the agent
// is for, and the guesses that get typed are the weak ones — "update",
// "current", "build" — one-word openers that produce a clarifying question or
// a thin answer and read as the product being bad (chat_logs #636/#637 on the
// outrospection feed, and the feedback on them at #638, are exactly this).
//
// THE SHAPE. Every agent gets a QUEUE of starters, deeper than the strip is
// wide: SLOT_COUNT (4) chips show at a time, QUEUE_MIN (20) sit behind them.
// Which 4 show is not random and not fixed — selectStarters() splits the strip
// between starters an eval run has PROVEN good (the shortlist) and ones still
// being explored, and rotates the explore half on a cursor so reopening the
// chat exercises the rest of the queue. That rotation is what keeps producing
// the signal the ranking feeds on.
//
// THE EVALUATION. A starter is not judged the way bench-questions.mjs judges a
// model — that asks "was the answer right". A starter is a FIRST message, so
// it is judged on whether it opens well: did the agent exercise the capability
// it exists for (capability), was the answer solid (quality), and would a
// newcomer understand what this agent is for from that one turn
// (firstImpression) — with a hard deadEnd flag when the agent answered a
// starter with a clarifying question or a refusal, which is disqualifying for
// an opener no matter how good the prose. starterScore() folds those into one
// number; a starter only earns a `rank` in the registry once a recorded eval
// run put it there (invariant 5: evidence, not guesswork).
//
// PROVENANCE DISCIPLINE (mirrors tests/bench-questions.mjs). The starters in
// starters-data.js are SYNTHETIC — composed against the aspect taxonomy, never
// lifted from a real user's chat. Live history informed which ASPECTS deserve
// a slot; it never supplied the text. A starter is shown to every visitor, so
// verbatim reuse of logged questions would leak one user's chat into another
// user's screen, and the chat_logs row is not consent for that.
//
// Import-safe in Node and in the browser: no DOM, no storage, no network. The
// callers own persistence (localStorage in both tiers) and rendering.

/** How many starter chips are shown at once when a chat opens. */
export const SLOT_COUNT = 4;

/** The minimum depth of an agent's queue — deliberately deeper than the strip. */
export const QUEUE_MIN = 20;

/**
 * Of the SLOT_COUNT chips, how many are reserved for PROVEN starters (ones an
 * eval run ranked). The rest are explore slots that rotate. Two and two: the
 * newcomer always sees a known-good opener, and the queue still gets exercised
 * so unranked entries can earn a rank.
 */
export const EXPLOIT_SLOTS = 2;

/** The score an unranked starter is treated as having — mid-scale, so a proven
 * weak starter (rank < 3) correctly sorts BELOW something untried. */
export const UNRANKED_SCORE = 3;

/** Rank bounds. A rank is the composite starterScore of a recorded eval run. */
export const RANK_MIN = 1;
export const RANK_MAX = 5;

/** Minimum Swedish entries per queue — invariant 6 (EN/SV parity) applied to
 * the starter strip: a Swedish-speaking newcomer must see openers in Swedish,
 * not an all-English strip with Swedish "later". */
export const MIN_SV = 6;

/** Minimum distinct aspects a queue must span, so 20 starters are 20 different
 * ways in rather than 20 rephrasings of one. */
export const MIN_ASPECTS = 8;

/**
 * Chat mode → the id of the agent that mode runs by default. Mirrors the
 * `defaults` table in sdk/AGENTS.json (and therefore src/chat.js's routing);
 * validateStarters cross-checks it against the registry so the two cannot
 * drift apart silently.
 * @type {Record<string, string>}
 */
export const MODE_AGENTS = {
  normal: "research",
  introspection: "introspection",
  sdk: "agent-builder",
  orchestrator: "orchestrator",
  outrospection: "outrospection",
};

/**
 * The agent whose starter queue a surface should show.
 *
 * The tier decides before the mode does: Se/cure runs the `secure` agent on
 * its own client-side pipeline, so it gets Se/cure's queue (its own privacy
 * posture is half of what its starters are for) rather than Se/rver's
 * `research` queue. Every other mode maps through MODE_AGENTS.
 *
 * @param {string|null|undefined} mode  the chat mode id
 * @param {{ platform?: string }} [opts]  `platform: "client"` for the Se/cure tier
 * @returns {string} an agent id
 */
export function agentForMode(mode, opts = {}) {
  if (opts.platform === "client") return "secure";
  const m = typeof mode === "string" ? mode : "";
  return MODE_AGENTS[m] || MODE_AGENTS.normal;
}

// ---- registry access ---------------------------------------------------------

/**
 * The starter entries for one agent, normalized and de-duplicated by id.
 * Never throws and never returns null: an unknown agent yields [] so a surface
 * that asks for a queue that isn't there renders no strip instead of erroring.
 * @param {any} reg  the starter registry (starters-data.js STARTERS)
 * @param {string} agentId
 * @returns {Array<{id:string,text:string,aspect:string,lang:string,rank?:number,evidence?:string}>}
 */
export function resolveQueue(reg, agentId) {
  const raw = reg && reg.queues && Array.isArray(reg.queues[agentId]) ? reg.queues[agentId] : [];
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    const id = typeof e?.id === "string" ? e.id.trim() : "";
    const text = typeof e?.text === "string" ? e.text.trim() : "";
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      text,
      aspect: typeof e.aspect === "string" ? e.aspect : "",
      lang: e.lang === "sv" ? "sv" : "en",
      ...(typeof e.rank === "number" ? { rank: e.rank } : {}),
      ...(typeof e.evidence === "string" ? { evidence: e.evidence } : {}),
    });
  }
  return out;
}

/** Every agent id the registry carries a queue for, in registry order.
 * @param {any} reg
 * @returns {string[]} */
export function agentIds(reg) {
  return reg && reg.queues ? Object.keys(reg.queues) : [];
}

// ---- selection ---------------------------------------------------------------

/**
 * A starter's current standing: its proven rank if it has one, nudged by how
 * often THIS browser has picked it. The click signal is local-only (both tiers
 * keep it in localStorage and nothing is sent anywhere — Se/cure could not
 * report it even if we wanted it to), so this personalizes the strip without
 * putting a single new byte on the wire.
 *
 * The nudge is deliberately small and capped: a starter someone likes drifts
 * up the strip, but three clicks cannot outrank a starter an eval run scored a
 * full point higher.
 *
 * @param {{id?:string, rank?:number}} entry
 * @param {Record<string, number>} [signal]  id → local pick count
 * @returns {number}
 */
export function starterStanding(entry, signal = {}) {
  const base = typeof entry?.rank === "number" ? entry.rank : UNRANKED_SCORE;
  const picks = Number(signal?.[entry?.id || ""]) || 0;
  const nudge = Math.min(0.6, picks * 0.2);
  return base + nudge;
}

/** True when an eval run has scored this starter (it can fill an exploit slot).
 * @param {any} entry
 * @returns {boolean} */
export function isProven(entry) {
  return typeof entry?.rank === "number" && entry.rank >= RANK_MIN;
}

/**
 * Pick the SLOT_COUNT starters to show.
 *
 * Two exploit slots take the best-standing PROVEN starters — a newcomer's
 * first impression is never left to chance. The remaining slots explore: they
 * walk the unproven entries from `cursor`, wrapping, so each time the chat is
 * opened a different part of the queue gets its turn and eventually earns (or
 * fails to earn) a rank. Within one strip no aspect repeats while an unused
 * aspect is still available, so four chips are four different ways in rather
 * than four rephrasings.
 *
 * Degrades cleanly in both directions: an all-unproven queue (a fresh agent,
 * nothing evaluated yet) fills every slot by rotation, and an all-proven queue
 * fills every slot from the shortlist.
 *
 * Pure and deterministic — same (queue, cursor, signal) always yields the same
 * four, which is what makes it unit-testable and what lets the eval harness
 * reproduce exactly what a user saw.
 *
 * @param {Array<any>} queue
 * @param {{count?:number, cursor?:number, signal?:Record<string,number>, lang?:string}} [opts]
 * @returns {Array<any>}
 */
export function selectStarters(queue, opts = {}) {
  const count = Math.max(0, Math.trunc(opts.count ?? SLOT_COUNT));
  const signal = opts.signal || {};
  let pool = Array.isArray(queue) ? queue.slice() : [];
  if (opts.lang) {
    // Prefer the reader's language, but never let it empty the strip: an agent
    // whose queue has no entry in that language still shows its full pool.
    const inLang = pool.filter((e) => e.lang === opts.lang);
    if (inLang.length >= count) pool = inLang;
  }
  if (!count || !pool.length) return [];

  /** @type {Array<any>} */
  const picked = [];
  const usedIds = new Set();
  const usedAspects = new Set();

  /** Take the first candidate that repeats no already-shown aspect, else any. */
  const take = (/** @type {Array<any>} */ candidates) => {
    const fresh = candidates.find((e) => !usedIds.has(e.id) && !usedAspects.has(e.aspect));
    const chosen = fresh || candidates.find((e) => !usedIds.has(e.id));
    if (!chosen) return false;
    usedIds.add(chosen.id);
    if (chosen.aspect) usedAspects.add(chosen.aspect);
    picked.push(chosen);
    return true;
  };

  // --- exploit: the best proven starters ------------------------------------
  const proven = pool
    .filter(isProven)
    .sort((a, b) => starterStanding(b, signal) - starterStanding(a, signal) || a.id.localeCompare(b.id));
  const exploitTarget = Math.min(EXPLOIT_SLOTS, count, proven.length);
  for (let i = 0; i < exploitTarget; i++) if (!take(proven)) break;

  // --- explore: rotate through what has not been proven yet -----------------
  const unproven = pool.filter((e) => !isProven(e));
  if (unproven.length) {
    const start = ((Math.trunc(opts.cursor ?? 0) % unproven.length) + unproven.length) % unproven.length;
    const rotated = unproven.slice(start).concat(unproven.slice(0, start));
    while (picked.length < count && take(rotated)) { /* fill */ }
  }

  // --- backfill: a queue with too few unproven entries still fills the strip -
  if (picked.length < count) {
    const rest = pool.filter((e) => !usedIds.has(e.id));
    while (picked.length < count && take(rest)) { /* fill */ }
  }

  return picked;
}

/**
 * The cursor to persist after showing `shown`. Advancing by the number of
 * EXPLORE chips (not all four) means every unproven entry gets its turn before
 * any repeats — advancing by four would skip past the exploit-slot entries
 * that were never drawn from the explore pool.
 * @param {number} cursor
 * @param {Array<any>} shown
 * @returns {number}
 */
export function nextCursor(cursor, shown) {
  const explored = (Array.isArray(shown) ? shown : []).filter((e) => !isProven(e)).length;
  const c = Math.trunc(cursor) || 0;
  return c + (explored || SLOT_COUNT);
}

/**
 * Record that a starter was picked. Pure — returns a new map, caps growth so a
 * long-lived browser cannot grow this without bound, and keeps counts small
 * enough that starterStanding's nudge stays a nudge.
 * @param {Record<string, number>} signal
 * @param {string} id
 * @param {number} [max]  how many distinct starters to remember
 * @returns {Record<string, number>}
 */
export function recordStarterUse(signal, id, max = 60) {
  if (typeof id !== "string" || !id) return { ...(signal || {}) };
  const next = { ...(signal || {}) };
  next[id] = Math.min(99, (Number(next[id]) || 0) + 1);
  const keys = Object.keys(next);
  if (keys.length > max) {
    // Drop the least-picked entries first; ties break on id so it stays pure.
    keys
      .sort((a, b) => (next[a] - next[b]) || a.localeCompare(b))
      .slice(0, keys.length - max)
      .forEach((k) => delete next[k]);
  }
  return next;
}

// ---- ranking + shortlist -----------------------------------------------------

/**
 * The best-known-good starters for an agent: the proven entries, best first.
 * This is the SHORTLIST — the answer to "which openers do we actually know
 * give good answers". An agent with nothing evaluated yet returns [], which is
 * the honest answer rather than a guess.
 * @param {any} reg
 * @param {string} agentId
 * @param {number} [n]
 * @returns {Array<any>}
 */
export function shortlistFor(reg, agentId, n = SLOT_COUNT) {
  return resolveQueue(reg, agentId)
    .filter(isProven)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.trunc(n)));
}

/**
 * Fold one evaluated run into the single number a starter is ranked by.
 *
 * The three dimensions are weighted by what a STARTER is for, which is not
 * what a benchmark question is for. `capability` leads: a starter that gets a
 * technically fine answer without the agent ever searching, reading its own
 * source, or building anything has failed as an advertisement for that agent.
 * `firstImpression` is weighted above raw `quality` for the same reason — the
 * strip's job is to show a newcomer what this thing does.
 *
 * `deadEnd` is not a weight but a cap: an opener answered with "which of these
 * did you mean?" or a refusal cannot score above DEAD_END_CAP however well it
 * reads, because the newcomer is back at an empty box either way.
 *
 * @param {{capability?:number, quality?:number, firstImpression?:number, deadEnd?:boolean}} r
 * @returns {number} a score in [RANK_MIN, RANK_MAX]
 */
export function starterScore(r) {
  const dim = (/** @type {unknown} */ v) => Math.min(RANK_MAX, Math.max(RANK_MIN, Number(v) || RANK_MIN));
  const raw =
    dim(r?.capability) * 0.4 +
    dim(r?.firstImpression) * 0.35 +
    dim(r?.quality) * 0.25;
  const capped = r?.deadEnd ? Math.min(raw, DEAD_END_CAP) : raw;
  return Math.round(capped * 100) / 100;
}

/** The ceiling a starter answered with a clarifying question or refusal can reach. */
export const DEAD_END_CAP = 2.5;

/** The score at or above which a starter is worth promoting into the shortlist. */
export const SHORTLIST_FLOOR = 3.8;

/**
 * Merge a harness run's results into a queue, producing the ranked table the
 * CLI prints and the registry's `rank` fields are updated FROM. Does not mutate
 * the queue and does not write anything — promoting a rank into
 * starters-data.js stays a deliberate edit backed by a ledger entry
 * (invariant 5), not something a test run does behind your back.
 *
 * @param {Array<any>} queue
 * @param {Record<string, {capability?:number,quality?:number,firstImpression?:number,deadEnd?:boolean,notes?:string}>} results  id → judged dimensions
 * @returns {Array<any>} every entry, scored where a result exists, best first
 */
export function rankStarters(queue, results) {
  const res = results || {};
  return (Array.isArray(queue) ? queue : [])
    .map((e) => {
      const r = res[e.id];
      if (!r) return { ...e, score: null, shortlisted: false };
      const score = starterScore(r);
      return {
        ...e,
        score,
        deadEnd: !!r.deadEnd,
        notes: typeof r.notes === "string" ? r.notes : "",
        shortlisted: score >= SHORTLIST_FLOOR,
      };
    })
    .sort((a, b) => {
      if (a.score === null && b.score === null) return a.id.localeCompare(b.id);
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score || a.id.localeCompare(b.id);
    });
}

// ---- the judge ---------------------------------------------------------------

/**
 * The prompt that scores ONE starter's run. Pure string assembly — the caller
 * (tests/starter-eval.mjs) runs the model and parses the JSON back.
 *
 * The judge is told what the agent was supposed to DO, and is given the run's
 * observable trace alongside the answer, because "did it exercise its
 * capability" is not a judgement you can make from prose alone — a
 * synthesis-only answer about the pipeline can read beautifully and still mean
 * introspection never retrieved anything.
 *
 * The PHASE TIMELINE matters as much as the counters, and the first battery
 * proved why: the outrospection agent retrieves from the outward feed, not
 * from web search, so a run that had genuinely read 24 feed items showed
 * `searches: 0, sources: 0`. The judge, seeing only counters, called its real
 * citations fabricated and scored a good starter 1.35. Counters describe the
 * research pipeline; the step labels describe whatever the agent actually did,
 * so both go in.
 *
 * @param {{id:string,text:string,aspect:string}} starter
 * @param {{name?:string, tagline?:string, expect?:string}} agent
 * @param {string} answer
 * @param {{rounds?:number, searches?:number, sources?:number, tools?:number, ms?:number, steps?:string[]}} [trace]
 * @returns {string}
 */
export function starterJudgePrompt(starter, agent, answer, trace = {}) {
  const t = [
    `search rounds: ${trace.rounds ?? 0}`,
    `web searches: ${trace.searches ?? 0}`,
    `web sources: ${trace.sources ?? 0}`,
    `tool calls: ${trace.tools ?? 0}`,
    `wall time: ${trace.ms != null ? Math.round(trace.ms / 100) / 10 + "s" : "unknown"}`,
  ].join(", ");
  const steps = Array.isArray(trace.steps) && trace.steps.length
    ? ["", "PHASE TIMELINE (what the agent actually did, in order):", ...trace.steps.map((s) => `- ${s}`)]
    : [];

  return [
    "You are evaluating a STARTER PROMPT — one of a handful of example questions offered to a first-time visitor when they open an AI agent. You are NOT scoring the model; you are scoring whether this question is a good OPENER for this agent.",
    "",
    `AGENT: ${agent?.name || "agent"} — ${agent?.tagline || ""}`,
    agent?.expect ? `WHAT THIS AGENT IS SUPPOSED TO DO ON A GOOD TURN: ${agent.expect}` : "",
    "",
    `STARTER (aspect: ${starter?.aspect || "unspecified"}):`,
    starter?.text || "",
    "",
    `OBSERVED RUN TRACE: ${t}`,
    ...steps,
    "",
    "THE ANSWER IT PRODUCED:",
    answer || "(empty)",
    "",
    "Score three dimensions, each an integer 1-5:",
    "- capability: did the agent actually exercise the capability it exists for? Judge this against the phase timeline and the counters together, NOT against the web-search counters alone — an agent that retrieves from its own source or from a curated feed will legitimately show zero web searches while the timeline shows the retrieval it did do. Only a run whose timeline shows no retrieval at all, from an agent that was supposed to retrieve, scores low here.",
    "- firstImpression: from this single turn, would a newcomer understand what this agent is for and want to ask a second question? Penalise answers that are impressive only to someone who already knows the product.",
    "- quality: is the answer accurate, specific, and properly sourced or grounded? Penalise vagueness, padding, and unsupported claims.",
    "",
    "Also set deadEnd: true if the agent responded with a clarifying question, a refusal, an error, or otherwise handed the visitor back an empty box instead of an answer. A starter that needs a follow-up before it does anything is a bad starter even when the reply is polite and well written.",
    "",
    'Reply with ONLY a JSON object: {"capability":N,"firstImpression":N,"quality":N,"deadEnd":false,"notes":"one sentence on the single thing that most helped or hurt this as an opener"}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Parse a judge reply. Tolerant of fenced blocks and surrounding prose (models
 * add them); returns null rather than throwing when nothing usable came back,
 * so one unparsable judgement drops that starter's result instead of ending a
 * battery that may have taken an hour to get that far.
 * @param {string} text
 * @returns {{capability:number,quality:number,firstImpression:number,deadEnd:boolean,notes:string}|null}
 */
export function parseJudgeReply(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const body = text.replace(/```(?:json)?/gi, " ");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const num = (/** @type {unknown} */ v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(RANK_MAX, Math.max(RANK_MIN, n)) : RANK_MIN;
  };
  return {
    capability: num(obj.capability),
    quality: num(obj.quality),
    firstImpression: num(obj.firstImpression),
    deadEnd: obj.deadEnd === true,
    notes: typeof obj.notes === "string" ? obj.notes.slice(0, 400) : "",
  };
}

// ---- validation --------------------------------------------------------------

/**
 * Structural + editorial validation of the whole registry. Run by
 * starters-core.test.js (so a bad edit fails `npm test`) and by
 * `scripts/starters --validate`.
 *
 * Beyond "is the JSON shaped right" this enforces the things that make the
 * queue worth having: it is deeper than the strip, it is not monolingual
 * (invariant 6), it spans genuinely different aspects, every chat mode's
 * default agent has one, and any `rank` present cites the ledger run that
 * produced it (invariant 5 — no rank without evidence).
 *
 * @param {any} reg
 * @param {any} [agentsRegistry]  sdk/AGENTS.json, when available, to cross-check ids
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateStarters(reg, agentsRegistry = null) {
  const problems = [];
  const at = (/** @type {string} */ agent, /** @type {string} */ msg) => problems.push(`${agent}: ${msg}`);

  if (!reg || typeof reg !== "object" || !reg.queues || typeof reg.queues !== "object") {
    return { ok: false, problems: ["registry must be an object with a `queues` map"] };
  }

  const ids = agentIds(reg);
  const globalIds = new Set();

  for (const agent of ids) {
    const raw = reg.queues[agent];
    if (!Array.isArray(raw)) { at(agent, "queue must be an array"); continue; }

    // Duplicates are dropped by resolveQueue, so compare the raw length against
    // the resolved one to catch a copy-paste that would silently shorten a queue.
    const queue = resolveQueue(reg, agent);
    if (queue.length !== raw.length) {
      at(agent, `${raw.length - queue.length} entr(y|ies) dropped as duplicate or malformed`);
    }
    if (queue.length < QUEUE_MIN) {
      at(agent, `queue has ${queue.length} starters, needs at least ${QUEUE_MIN} (the strip shows ${SLOT_COUNT})`);
    }

    const sv = queue.filter((e) => e.lang === "sv").length;
    if (sv < MIN_SV) {
      at(agent, `only ${sv} Swedish starters, needs at least ${MIN_SV} (invariant 6: EN/SV parity)`);
    }

    const aspects = new Set(queue.map((e) => e.aspect).filter(Boolean));
    if (aspects.size < MIN_ASPECTS) {
      at(agent, `spans ${aspects.size} aspects, needs at least ${MIN_ASPECTS}`);
    }
    if (queue.some((e) => !e.aspect)) at(agent, "every starter needs an `aspect`");

    for (const e of queue) {
      if (globalIds.has(e.id)) at(agent, `starter id "${e.id}" is not unique across the registry`);
      globalIds.add(e.id);
      if (e.text.length < 12) at(agent, `starter "${e.id}" is too short to be a useful opener`);
      if (e.text.length > 220) at(agent, `starter "${e.id}" is too long for a chip`);
      if (e.rank != null) {
        if (e.rank < RANK_MIN || e.rank > RANK_MAX) {
          at(agent, `starter "${e.id}" has rank ${e.rank}, outside ${RANK_MIN}-${RANK_MAX}`);
        }
        if (!e.evidence) {
          at(agent, `starter "${e.id}" carries a rank with no \`evidence\` (invariant 5: a rank cites the eval run that produced it)`);
        }
      }
    }
  }

  // Every chat mode's default agent must have somewhere to draw a strip from.
  for (const [mode, agent] of Object.entries(MODE_AGENTS)) {
    if (!ids.includes(agent)) problems.push(`mode "${mode}" defaults to agent "${agent}", which has no starter queue`);
  }
  if (!ids.includes("secure")) problems.push('the Se/cure tier agent "secure" has no starter queue');

  // Cross-check against the agent registry when the caller supplies it: a
  // starter queue for an agent that no longer exists is dead weight, and a new
  // agent with no queue would silently show an empty strip.
  if (agentsRegistry && Array.isArray(agentsRegistry.agents)) {
    const known = new Set(agentsRegistry.agents.map((/** @type {any} */ a) => a && a.id).filter(Boolean));
    for (const a of ids) if (!known.has(a)) problems.push(`queue for unknown agent "${a}" (not in sdk/AGENTS.json)`);
    for (const a of known) if (!ids.includes(a)) problems.push(`agent "${a}" has no starter queue`);
  }

  return { ok: problems.length === 0, problems };
}

/**
 * A compact report of the whole registry — what the CLI prints for `--report`
 * and what a session reads to see where the evaluation actually stands.
 * @param {any} reg
 * @returns {Array<{agent:string,total:number,proven:number,sv:number,aspects:number,best:number|null}>}
 */
export function registryReport(reg) {
  return agentIds(reg).map((agent) => {
    const q = resolveQueue(reg, agent);
    const proven = q.filter(isProven);
    return {
      agent,
      total: q.length,
      proven: proven.length,
      sv: q.filter((e) => e.lang === "sv").length,
      aspects: new Set(q.map((e) => e.aspect).filter(Boolean)).size,
      best: proven.length ? Math.max(...proven.map((e) => e.rank ?? 0)) : null,
    };
  });
}
