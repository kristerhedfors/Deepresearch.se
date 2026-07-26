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
  models: "models",
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
      ...(Number.isInteger(e.xp) && e.xp > 0 ? { xp: e.xp } : {}),
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

// ---- the #XP tag -------------------------------------------------------------
//
// A starter's public identity (feedback #37, 2026-07-26). The try-it list
// already solved this problem for use cases: a composed prompt opens with
// `#UC-34` (testpoints-core.js tagStarterPrompt), so a "feedback …" note sent
// later in that conversation is tied to the exact use case by the first
// message. Starters needed the same handle — a reviewer working an evaluation
// batch was reporting on "this sentence", and matching a sentence back to a
// registry entry by hand is exactly the kind of work an identifier removes.
//
// Two rules make the tag safe to put in front of a real question:
//
//   1. It is added ONLY in evaluation mode (starters.js). The visitor strip
//      stays untagged — a visitor's pick signal never leaves their browser,
//      and an identifier prefixed onto their first message would be that byte
//      on the wire.
//   2. The pipeline STRIPS it before any model call (src/pipeline.js), so the
//      agent answers the starter's text, not the starter's text plus a code.
//      A tag left in place would reach triage and the search queries, and the
//      thing being evaluated would no longer be the starter.

/**
 * The canonical display tag for a starter's xp number: `#XP-07`. Padded to two
 * digits (the form the numbering was requested in) and left unpadded above 99.
 * DISPLAY only — the functional identifier stays the bare integer.
 * @param {number|string} xp
 * @returns {string}
 */
export function starterTag(xp) {
  const n = Number(xp);
  if (!Number.isInteger(n) || n <= 0) return "";
  return `#XP-${String(n).padStart(2, "0")}`;
}

// The ref grammar, matched at the START of a message: "#XP-07", "#XP07",
// "XP-7", "XP 07", "xp07". Language-neutral (a generated identifier), and
// deliberately NOT matching a bare "#7" — that form already belongs to the
// use-case grammar in testpoints-core.js and the two must not collide.
const STARTER_REF_RE = /^\s*#?\s*xp[\s\-–—]?0*(\d{1,6})\b[\s:,.\-–—]*/i;

/**
 * Read a starter reference off the front of a message.
 * @param {unknown} text
 * @returns {{ xp: number, tag: string } | null}
 */
export function parseStarterRef(text) {
  if (typeof text !== "string" || !text) return null;
  const m = text.match(STARTER_REF_RE);
  if (!m) return null;
  const xp = Number(m[1]);
  return Number.isInteger(xp) && xp > 0 ? { xp, tag: starterTag(xp) } : null;
}

/**
 * The message without its leading starter tag — what every model call sees.
 * A message that carries no tag comes back unchanged (same string), so callers
 * can strip unconditionally.
 * @param {unknown} text
 * @returns {string}
 */
export function stripStarterRef(text) {
  if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
  const m = text.match(STARTER_REF_RE);
  return m ? text.slice(m[0].length) : text;
}

/**
 * Prepend a starter's tag to its text, once. An untagged number (0, missing)
 * leaves the text alone rather than composing a meaningless `#XP-` prefix.
 * @param {number|string} xp
 * @param {string} text
 * @returns {string}
 */
export function tagStarterText(xp, text) {
  const tag = starterTag(xp);
  const body = typeof text === "string" ? text : "";
  if (!tag) return body;
  const ref = parseStarterRef(body);
  if (ref && ref.xp === Number(xp)) return body; // already tagged
  return body ? `${tag} ${body}` : tag;
}

/**
 * The starter tag on a conversation's FIRST user message, or null. Only the
 * first turn is consulted: a starter is only ever an opening message, so a tag
 * typed mid-conversation is a person talking about a starter, not sending one.
 *
 * Messages are the OpenAI-style shape both tiers use — content is a string or
 * an array of parts. Kept here rather than in src/conversation.js so the
 * browser-side pipeline (Se/cure, which has no server in its data path) and
 * the Worker strip tags by the same code; conversation.js re-exports it.
 * @param {Array<any>} messages
 * @returns {{ xp: number, tag: string } | null}
 */
export function starterRefOf(messages) {
  const first = (Array.isArray(messages) ? messages : []).find((m) => m?.role === "user");
  if (!first) return null;
  return parseStarterRef(firstText(first.content));
}

/** The first text of a message's content, whichever shape it is in.
 * @param {any} content @returns {string} */
function firstText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const part = content.find((p) => p?.type === "text" && typeof p.text === "string");
    return part ? part.text : "";
  }
  return "";
}

/**
 * The conversation with any leading starter tag removed from every user
 * message — what every model call gets. Non-mutating, and returns the SAME
 * array reference when nothing carried a tag, so callers strip unconditionally.
 *
 * Every user turn is swept, not just the first: a reopened conversation
 * replays its whole history, and a tag left in an earlier turn would still
 * reach the phases that format the conversation into a prompt.
 * @param {Array<any>} messages
 * @returns {Array<any>}
 */
export function withoutStarterTags(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (m?.role !== "user") return m;
    if (typeof m.content === "string") {
      const stripped = stripStarterRef(m.content);
      if (stripped === m.content) return m;
      changed = true;
      return { ...m, content: stripped };
    }
    if (Array.isArray(m.content)) {
      const idx = m.content.findIndex((p) => p?.type === "text" && typeof p.text === "string");
      if (idx < 0) return m;
      const stripped = stripStarterRef(m.content[idx].text);
      if (stripped === m.content[idx].text) return m;
      changed = true;
      return { ...m, content: m.content.map((p, i) => (i === idx ? { ...p, text: stripped } : p)) };
    }
    return m;
  });
  return changed ? out : messages;
}

/**
 * Resolve an xp number back to the starter it names — the lookup a reader of a
 * feedback entry (or `scripts/starters --xp 7`) performs. Searches the queues
 * and the candidate pool, which share one number space.
 * @param {any} reg
 * @param {number|string} xp
 * @param {{candidates?:Array<any>}} [opts]
 * @returns {any|null} the entry plus `agent` and `band`, or null
 */
export function starterByXp(reg, xp, opts = {}) {
  const n = Number(xp);
  if (!Number.isInteger(n) || n <= 0) return null;
  return evalPool(reg, { candidates: opts.candidates }).find((e) => e.xp === n) || null;
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

/**
 * True when this starter is known GOOD — an eval run scored it at or above the
 * shortlist floor. Only these fill an exploit slot.
 *
 * Note the floor, not merely "has a rank". A starter the battery scored 2.10
 * carries a rank too, and treating that as proven would promote a known-bad
 * opener into the two slots reserved for the first impression — the exact
 * opposite of what they are for. A sub-floor rank means "we tested this and it
 * was weak", which is more damning than never having tested it.
 * @param {any} entry
 * @returns {boolean}
 */
export function isProven(entry) {
  return typeof entry?.rank === "number" && entry.rank >= SHORTLIST_FLOOR;
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
 * @param {{candidates?:Array<any>}} [opts]  the trial pool, checked for #XP collisions
 *   only — a candidate is otherwise deliberately unvalidated (that is what makes
 *   it a trial), but it shares the one number space, so a clash here would
 *   follow it into a queue on promotion.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateStarters(reg, agentsRegistry = null, opts = {}) {
  const problems = [];
  const at = (/** @type {string} */ agent, /** @type {string} */ msg) => problems.push(`${agent}: ${msg}`);

  if (!reg || typeof reg !== "object" || !reg.queues || typeof reg.queues !== "object") {
    return { ok: false, problems: ["registry must be an object with a `queues` map"] };
  }

  const ids = agentIds(reg);
  const globalIds = new Set();
  /** xp number → the id that already holds it, registry-wide. @type {Map<number,string>} */
  const globalXp = new Map();

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
      // The #XP number is a starter's public identity — it is what a feedback
      // entry cites. A missing one leaves an evaluation chip with nothing to
      // tag; a shared one points two starters at the same report.
      if (!Number.isInteger(e.xp) || e.xp <= 0) {
        at(agent, `starter "${e.id}" has no \`xp\` number (the #XP tag a reviewer's feedback cites)`);
      } else if (globalXp.has(e.xp)) {
        at(agent, `starter "${e.id}" reuses xp ${e.xp}, already held by "${globalXp.get(e.xp)}"`);
      } else {
        globalXp.set(e.xp, e.id);
      }
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

  for (const c of Array.isArray(opts.candidates) ? opts.candidates : []) {
    const id = typeof c?.id === "string" ? c.id : "(unnamed candidate)";
    if (!Number.isInteger(c?.xp) || c.xp <= 0) {
      problems.push(`candidate "${id}" has no \`xp\` number (evaluation mode tags it like any other starter)`);
    } else if (globalXp.has(c.xp)) {
      problems.push(`candidate "${id}" reuses xp ${c.xp}, already held by "${globalXp.get(c.xp)}"`);
    } else {
      globalXp.set(c.xp, id);
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

// ---- evaluation mode ---------------------------------------------------------
//
// The strip above serves a VISITOR: two proven openers and two explores, drawn
// from whichever agent the current mode runs. Evaluation mode serves a
// REVIEWER instead, and wants the opposite balance — the point is not to make
// a good first impression, it is to find out what we do not know yet.
//
// So when the knob is on, the strip is replaced by a BATCH drawn across every
// agent at once, one chip per band:
//
//   proven    — a starter an eval run scored above the floor. Does it hold?
//   weak      — a starter that scored BELOW the floor. Is it really bad, or
//               was the run wrong? (The first battery scored two outrospection
//               starters 1.35 for a harness bug, so this band is not academic.)
//   untried   — no rank at all. The bulk of the registry lives here.
//   candidate — not in a queue yet: a question we are considering ADDING.
//
// One from each band, every batch, rotating within the band so the reviewer is
// never asked the same thing twice while anything unrated remains. That is the
// "schedule": coverage by construction rather than by remembering to vary it.

/** The four bands an evaluation batch draws one chip from, in slot order. */
export const EVAL_BANDS = ["proven", "weak", "untried", "candidate"];

/**
 * Which band a starter belongs to. `candidate` is not derivable from the entry
 * — it comes from which pool the entry was read out of — so it is passed in.
 * @param {{rank?:number}} entry
 * @returns {"proven"|"weak"|"untried"}
 */
export function bandOf(entry) {
  if (typeof entry?.rank !== "number") return "untried";
  return entry.rank >= SHORTLIST_FLOOR ? "proven" : "weak";
}

/**
 * Every starter in the registry, flattened and tagged with its agent and band
 * — the pool an evaluation batch draws from. Candidates are appended from a
 * separate list and carry `band: "candidate"` plus the agent they are proposed
 * FOR, so a reviewer knows which queue a good verdict would add them to.
 *
 * `platform: "client"` restricts the pool to what can actually run in the
 * Se/cure tier: its own queue, plus candidates proposed for it. Serving an
 * Agent Studio starter there would test nothing except the reviewer's patience.
 *
 * @param {any} reg
 * @param {{platform?:string, candidates?:Array<any>}} [opts]
 * @returns {Array<any>}
 */
export function evalPool(reg, opts = {}) {
  const clientOnly = opts.platform === "client";
  const pool = [];
  for (const agent of agentIds(reg)) {
    if (clientOnly && agent !== "secure") continue;
    for (const e of resolveQueue(reg, agent)) pool.push({ ...e, agent, band: bandOf(e) });
  }
  for (const c of Array.isArray(opts.candidates) ? opts.candidates : []) {
    const id = typeof c?.id === "string" ? c.id.trim() : "";
    const text = typeof c?.text === "string" ? c.text.trim() : "";
    if (!id || !text) continue;
    const agent = typeof c.agent === "string" ? c.agent : "research";
    if (clientOnly && agent !== "secure") continue;
    pool.push({
      id,
      text,
      agent,
      aspect: typeof c.aspect === "string" ? c.aspect : "",
      lang: c.lang === "sv" ? "sv" : "en",
      ...(Number.isInteger(c.xp) && c.xp > 0 ? { xp: c.xp } : {}),
      band: "candidate",
      note: typeof c.note === "string" ? c.note : "",
    });
  }
  return pool;
}

/**
 * One evaluation batch: `count` starters, one per band in EVAL_BANDS order,
 * drawn across every agent.
 *
 * Within a band, entries the reviewer has ALREADY rated go to the back — a
 * batch should spend its four slots on things we do not know yet. When a band
 * is empty (nothing weak, say, because nothing has been scored below the floor
 * yet) its slot is backfilled from the band with the most unrated material
 * left, so the reviewer always gets four chips rather than a short strip that
 * silently means "no data here".
 *
 * Deterministic in (pool, cursor, rated): the same inputs give the same batch,
 * so a reviewer can be handed the exact batch they saw.
 *
 * @param {Array<any>} pool  from evalPool()
 * @param {{cursor?:number, count?:number, rated?:Set<string>|Record<string,any>}} [opts]
 * @returns {Array<any>}
 */
export function selectEvalBatch(pool, opts = {}) {
  const count = Math.max(0, Math.trunc(opts.count ?? SLOT_COUNT));
  const list = Array.isArray(pool) ? pool : [];
  if (!count || !list.length) return [];
  const cursor = Math.trunc(opts.cursor ?? 0) || 0;
  const ratedRaw = opts.rated;
  const rated = ratedRaw instanceof Set
    ? ratedRaw
    : new Set(Object.keys(ratedRaw && typeof ratedRaw === "object" ? ratedRaw : {}));

  const rot = (/** @type {Array<any>} */ arr) => {
    if (!arr.length) return arr;
    const s = ((cursor % arr.length) + arr.length) % arr.length;
    return arr.slice(s).concat(arr.slice(0, s));
  };

  /**
   * Order a set of entries so consecutive cursors genuinely move.
   *
   * A plain rotation is not enough here. The untried band holds most of the
   * registry, so rotating 140 entries by one lands the reader on almost the
   * same place, and the agent-spread pick below then returns the SAME entry
   * batch after batch. Grouping by agent first, rotating the agent ORDER by
   * the cursor, rotating within each agent, and then interleaving gives a
   * batch that moves on both axes at once.
   */
  const interleaveByAgent = (/** @type {Array<any>} */ arr) => {
    if (arr.length < 2) return arr;
    const byAgent = new Map();
    for (const e of arr) {
      if (!byAgent.has(e.agent)) byAgent.set(e.agent, []);
      byAgent.get(e.agent).push(e);
    }
    const agents = [...byAgent.keys()];
    const s = ((cursor % agents.length) + agents.length) % agents.length;
    const lists = agents.slice(s).concat(agents.slice(0, s)).map((a) => rot(byAgent.get(a)));
    const out = [];
    for (let i = 0; out.length < arr.length; i++) {
      for (const l of lists) if (l[i]) out.push(l[i]);
    }
    return out;
  };

  /** A band's entries: unrated first (a batch should spend its slots on what
   * we do not know), each half spread across agents and advanced by cursor. */
  const bandQueue = (/** @type {string} */ band) => {
    const all = list.filter((e) => e.band === band);
    return interleaveByAgent(all.filter((e) => !rated.has(e.id)))
      .concat(interleaveByAgent(all.filter((e) => rated.has(e.id))));
  };

  const queues = new Map(EVAL_BANDS.map((b) => [b, bandQueue(b)]));
  const picked = [];
  const used = new Set();
  const usedAgents = new Set();

  // Spread across agents as well as bands. Without this the untried band —
  // which is most of the registry — hands back whichever agent happens to sit
  // first in registry order, and a reviewer gets four research questions in a
  // batch meant to survey seven agents. Falls back to repeating an agent
  // rather than returning a short batch.
  const takeFrom = (/** @type {string} */ band) => {
    const q = queues.get(band) || [];
    const free = q.filter((x) => !used.has(x.id));
    const e = free.find((x) => !usedAgents.has(x.agent)) || free[0];
    if (!e) return false;
    used.add(e.id);
    usedAgents.add(e.agent);
    picked.push(e);
    return true;
  };

  for (const band of EVAL_BANDS) {
    if (picked.length >= count) break;
    takeFrom(band);
  }

  // Backfill from whichever band still has the most unrated material — an
  // empty band must not shorten the batch.
  while (picked.length < count) {
    const best = EVAL_BANDS
      .map((b) => ({ b, left: (queues.get(b) || []).filter((x) => !used.has(x.id) && !rated.has(x.id)).length }))
      .sort((a, b) => b.left - a.left)[0];
    if (best && best.left > 0 && takeFrom(best.b)) continue;
    // Nothing unrated anywhere: fall back to anything at all, then give up.
    const any = list.find((x) => !used.has(x.id));
    if (!any) break;
    used.add(any.id);
    picked.push(any);
  }

  return picked;
}

/**
 * Record a reviewer's verdict on a starter. Pure — returns a new map.
 * `verdict` is "good" | "bad" | "unclear"; anything else clears the entry, so
 * a mis-tap can be undone by tapping the same button again at the call site.
 * @param {Record<string, {v:string, at?:number, note?:string}>} verdicts
 * @param {string} id
 * @param {string} verdict
 * @param {{at?:number, note?:string}} [meta]
 * @returns {Record<string, {v:string, at?:number, note?:string}>}
 */
export function recordVerdict(verdicts, id, verdict, meta = {}) {
  const next = { ...(verdicts || {}) };
  if (typeof id !== "string" || !id) return next;
  if (verdict !== "good" && verdict !== "bad" && verdict !== "unclear") {
    delete next[id];
    return next;
  }
  next[id] = {
    v: verdict,
    ...(Number.isFinite(meta.at) ? { at: meta.at } : {}),
    ...(typeof meta.note === "string" && meta.note ? { note: meta.note.slice(0, 400) } : {}),
  };
  return next;
}

/**
 * Turn a verdict map into the plain-text report a reviewer hands back (the
 * "Copy report" action). Text rather than a beacon: on Se/cure there is no
 * endpoint this could post to without breaking the tier's promise, and on
 * Se/rver a reviewer pasting their own findings is both simpler and more
 * honest than a silent upload.
 *
 * @param {Array<any>} pool  from evalPool()
 * @param {Record<string, {v:string, note?:string}>} verdicts
 * @returns {string}
 */
export function verdictReport(pool, verdicts) {
  const byId = new Map((Array.isArray(pool) ? pool : []).map((e) => [e.id, e]));
  const rows = Object.entries(verdicts || {});
  if (!rows.length) return "Starter evaluation: nothing rated yet.";
  /** @type {Record<string,string>} */
  const mark = { good: "GOOD", bad: "BAD", unclear: "UNCLEAR" };
  const lines = ["Starter evaluation — human verdicts", ""];
  /** @type {Map<string, Array<{id:string, e:any, v:any}>>} */
  const byAgent = new Map();
  for (const [id, v] of rows) {
    const e = byId.get(id);
    const agent = e?.agent || "(unknown)";
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    (byAgent.get(agent) || []).push({ id, e, v });
  }
  for (const [agent, items] of [...byAgent.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    lines.push(`## ${agent}`);
    for (const { id, e, v } of items.sort((a, b) => a.id.localeCompare(b.id))) {
      // The #XP tag leads each line: it is the identity the chip put in front
      // of the message, so a pasted report and a feedback entry name the
      // starter the same way.
      const tag = starterTag(e?.xp);
      lines.push(`- [${mark[v.v] || v.v}] ${tag ? `${tag} ` : ""}${id} (${e?.band || "?"})`);
      if (e?.text) lines.push(`      ${e.text}`);
      if (v.note) lines.push(`      note: ${v.note}`);
    }
    lines.push("");
  }
  const counts = rows.reduce((/** @type {Record<string,number>} */ a, [, v]) => ({ ...a, [v.v]: (a[v.v] || 0) + 1 }), {});
  lines.push(`Totals: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  return lines.join("\n");
}

/**
 * Where the evaluation actually stands, per agent and per band — the answer to
 * "what have we still not covered". Machine ranks and human verdicts are kept
 * SEPARATE columns rather than blended: they measure different things, and a
 * disagreement between them is a finding, not noise to average away.
 *
 * @param {any} reg
 * @param {{candidates?:Array<any>, verdicts?:Record<string,{v:string}>}} [opts]
 * @returns {Array<{agent:string,total:number,proven:number,weak:number,untried:number,candidates:number,rated:number,good:number,bad:number}>}
 */
export function coverageReport(reg, opts = {}) {
  const pool = evalPool(reg, { candidates: opts.candidates });
  const verdicts = opts.verdicts || {};
  const agents = [...new Set(pool.map((e) => e.agent))];
  return agents.map((agent) => {
    const mine = pool.filter((e) => e.agent === agent);
    const rated = mine.filter((e) => verdicts[e.id]);
    return {
      agent,
      total: mine.filter((e) => e.band !== "candidate").length,
      proven: mine.filter((e) => e.band === "proven").length,
      weak: mine.filter((e) => e.band === "weak").length,
      untried: mine.filter((e) => e.band === "untried").length,
      candidates: mine.filter((e) => e.band === "candidate").length,
      rated: rated.length,
      good: rated.filter((e) => verdicts[e.id].v === "good").length,
      bad: rated.filter((e) => verdicts[e.id].v === "bad").length,
    };
  });
}
