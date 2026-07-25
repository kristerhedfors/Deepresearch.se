// @ts-check
// SWARM REASONING — the pure core of the Orchestrator's `swarm` sub-agent kind:
// one task answered by MANY tiny on-device models (the Bonsai family,
// ondevice-core.js) running in parallel browser workers, then reduced to one
// brief by a deterministic consensus pass. Import-free and Node-tested
// (swarm-core.test.js); the browser side that actually spawns the workers is
// swarm-runtime.js, and the node kind that walks it is orchestrator-core.js.
//
// WHY a swarm at all. A 1-bit 1.7B model is not a small version of a frontier
// model — it is a noisy sampler. One draft from it is unreliable; the SPREAD of
// several drafts carries real signal (where they agree is usually where the
// model actually knows something). So the swarm does not "divide the work" the
// way the orchestrator's other kinds do — every member answers the SAME task,
// and the algorithm below turns the disagreement into a ranked answer plus an
// honest confidence number.
//
// INVARIANT 1 HOLDS. No model decides control flow here: the rounds, the peer
// pairing, the scoring and the stop condition are all plain code over plain
// strings. The models only ever produce text. The one place a model reads
// another model's output is the critique round, and its verdict is PARSED into
// data (parseCritique) before anything acts on it.
//
// INVARIANT 4 (the privacy split) is why this kind exists at all: a swarm node
// never leaves the browser. The task text goes to workers on this device, the
// weights already sit in this device's OPFS, and only the FINISHED brief is
// attached to the chat request. On Se/rver that means the swarm's intermediate
// reasoning is never in any server data path; on Se/cure it changes nothing —
// nothing was ever in one.

// ---- bounds ------------------------------------------------------------------
//
// "Any number of browsers" is the ask, and the plan phase may genuinely ask for
// a dozen members. The bound that matters is not the member COUNT (members are
// queued over a worker pool — planSwarmCapacity) but the total decode work:
// every member costs one generation per round plus one critique, at phone
// speed. These caps keep a swarm node inside the orchestrator's per-node
// wall-clock instead of turning one chat turn into a background job.

export const SWARM_MIN_MEMBERS = 2;
export const SWARM_MAX_MEMBERS = 12;
export const SWARM_DEFAULT_MEMBERS = 4;
export const SWARM_MIN_ROUNDS = 1;
export const SWARM_MAX_ROUNDS = 3;
export const SWARM_DEFAULT_ROUNDS = 2;

/** Per-member completion budget — a draft is a paragraph, not an essay. */
export const SWARM_DRAFT_MAX_TOKENS = 320;
/** A critique is three short lines; anything longer is the model rambling. */
export const SWARM_CRITIQUE_MAX_TOKENS = 160;
/** The final consolidation pass gets a little more room than a draft. */
export const SWARM_SYNTH_MAX_TOKENS = 480;

/**
 * Below this mean pairwise agreement the swarm has not converged: the members
 * are describing different things, so one more round (seeded with the current
 * lead and the loudest dissent) is worth its wall-clock. Calibrated on the
 * jaccard scale below, where independent tiny-model drafts of the SAME task
 * typically land around 0.25–0.45 and near-duplicates above 0.6.
 */
export const AGREEMENT_FLOOR = 0.34;

/**
 * How much one peer verdict moves a draft's score, on the same 0…1 scale as
 * centrality (scoreDrafts). Below the spread centrality typically covers, on
 * purpose — see the reasoning there.
 */
export const VOTE_WEIGHT = 0.35;

// ---- member stances ----------------------------------------------------------
//
// Diversity has to be MANUFACTURED. Sampling temperature alone does not spread
// tiny models far enough to make a vote meaningful — run the same prompt eight
// times and you get eight paraphrases of one mistake. Each member therefore
// gets a distinct STANCE: a one-line instruction that changes what the member
// looks for, not what it is allowed to conclude. The list is ordered so that a
// swarm of 2 already spans the widest axis (assert vs. doubt) and each further
// member adds a genuinely different lens; past the list it wraps, and the wrap
// is disambiguated by the member index in the prompt.

export const MEMBER_STANCES = [
  { id: "direct", label: "Direct", instruction: "Answer the task as directly and concretely as you can. Lead with the answer, then the one reason that matters most." },
  { id: "skeptic", label: "Skeptic", instruction: "Answer the task, but assume the obvious answer is wrong. Name what would have to be true for it to hold, and say so plainly if it does not." },
  { id: "concrete", label: "Concrete", instruction: "Answer the task using specifics only: names, numbers, steps, dates. Avoid every general statement you cannot attach a specific to." },
  { id: "structural", label: "Structural", instruction: "Answer the task by breaking it into its parts first, then answering each part in one sentence." },
  { id: "practical", label: "Practical", instruction: "Answer the task from the point of view of someone who has to ACT on the answer today. What do they do, in what order?" },
  { id: "risk", label: "Risk", instruction: "Answer the task by naming what goes wrong: the failure modes, the costs, the cases the obvious answer does not cover." },
];

/**
 * The stance for member `i` (wraps past the list — a swarm larger than the
 * stance list repeats lenses rather than dropping members).
 * @param {number} i
 */
export function memberStance(i) {
  const idx = ((Number(i) || 0) % MEMBER_STANCES.length + MEMBER_STANCES.length) % MEMBER_STANCES.length;
  return MEMBER_STANCES[idx];
}

// ---- capacity planning -------------------------------------------------------

/** @param {number} n @param {number} lo @param {number} hi */
function clamp(n, lo, hi) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Turn "the plan asked for N members" into what THIS device will actually run.
 * The member count is honoured (capped) — the device constraint is expressed as
 * CONCURRENCY instead, so a phone runs a swarm of 8 as four waves of two rather
 * than silently shrinking the team. Every member still gets its own worker with
 * its own model instance; `concurrency` is how many exist at once.
 *
 * Memory is the real ceiling: each live worker holds its own copy of the
 * weights (a 1-bit 1.7B build is ~300 MB on disk and more once compiled), so
 * the pool is sized from navigator.deviceMemory when the browser reports it and
 * kept deliberately small when it does not.
 *
 * @param {{ requested?: number, rounds?: number, hardwareConcurrency?: ?number, deviceMemoryGb?: ?number, modelBytes?: ?number, maxWorkers?: ?number }} opts
 * @returns {{ members: number, concurrency: number, rounds: number, batches: number }}
 */
export function planSwarmCapacity(opts = {}) {
  const members = clamp(opts.requested ?? SWARM_DEFAULT_MEMBERS, SWARM_MIN_MEMBERS, SWARM_MAX_MEMBERS);
  const rounds = clamp(opts.rounds ?? SWARM_DEFAULT_ROUNDS, SWARM_MIN_ROUNDS, SWARM_MAX_ROUNDS);
  // CPU threads are the cheap signal; leave one for the page itself.
  const byCpu = Number.isFinite(opts.hardwareConcurrency) ? Math.floor(Number(opts.hardwareConcurrency) / 2) : 2;
  // Memory is the expensive one. deviceMemory is coarse (0.25…8) and capped at
  // 8 by every browser that ships it, so treat it as a floor, not a budget:
  // half the reported RAM, divided by the model's own footprint.
  const gb = Number.isFinite(opts.deviceMemoryGb) ? Number(opts.deviceMemoryGb) : null;
  const modelGb = Number.isFinite(opts.modelBytes) ? Number(opts.modelBytes) / 1e9 : 0.35;
  const byMem = gb ? Math.floor((gb / 2) / Math.max(0.2, modelGb)) : 2;
  const hardCap = Number.isFinite(opts.maxWorkers) ? clamp(Number(opts.maxWorkers), 1, SWARM_MAX_MEMBERS) : 4;
  const concurrency = Math.min(members, hardCap, Math.max(1, Math.min(byCpu, byMem)));
  return { members, concurrency, rounds, batches: Math.ceil(members / concurrency) };
}

// ---- the prompts (pure string assembly) --------------------------------------

/** @param {unknown} s @param {number} n */
function clip(s, n) {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * One member's DIVERGE prompt: the shared task, this member's stance, and (from
 * round 2 on) the state of the swarm — the current lead answer and the dissent
 * against it. Round 2+ deliberately shows the lead WITHOUT saying it won:
 * telling a tiny model "this is the best answer" collapses the swarm into
 * agreement with it, which is exactly the failure the agreement score exists to
 * detect.
 * @param {{ task: string, index: number, members: number, userRequest?: string,
 *   upstream?: string, lead?: string, dissent?: string[], round?: number }} args
 * @returns {string}
 */
export function swarmMemberPrompt(args) {
  const stance = memberStance(args.index);
  const parts = [
    `You are member ${args.index + 1} of ${args.members} independent reasoners answering the SAME question. Your lens: ${stance.instruction}`,
    `The question:\n${clip(args.task, 1200)}`,
  ];
  if (args.userRequest) parts.push(`It came out of this user request:\n${clip(args.userRequest, 800)}`);
  if (args.upstream) parts.push(`Context you were given:\n${clip(args.upstream, 2000)}`);
  if (args.lead) {
    parts.push(`Another member wrote this. Treat it as a claim to check, not as the answer:\n${clip(args.lead, 1200)}`);
    if (args.dissent?.length) {
      parts.push(`Objections raised against it:\n${args.dissent.slice(0, 4).map((d) => `- ${clip(d, 200)}`).join("\n")}`);
    }
  }
  parts.push(
    "Write 3-6 sentences. No preamble, no headings, no bullet list — just the answer as you see it. " +
      "Write in the language of the question (svara på svenska om frågan är på svenska). " +
      "If you do not know something, say that instead of inventing it.",
  );
  return parts.join("\n\n");
}

/**
 * The CRITIQUE prompt: one member reads exactly ONE peer draft (the ring
 * pairing below) and answers in three fixed lines. Fixed lines because the
 * result is PARSED, not read — a tiny model asked for free-form review returns
 * a fourth paraphrase of the draft, which tells the aggregator nothing.
 * @param {{ task: string, peerIndex: number, draft: string }} args
 * @returns {string}
 */
export function swarmCritiquePrompt(args) {
  return [
    `You are reviewing another reasoner's answer to this question:\n${clip(args.task, 1200)}`,
    `Member ${args.peerIndex + 1} answered:\n${clip(args.draft, 2000)}`,
    `Reply with EXACTLY three lines, nothing else:
VERDICT: support   (if the answer is broadly right) or   VERDICT: dispute   (if it is wrong or misleading)
FLAW: the single biggest problem with it, in one sentence (write "none" if you found none)
KEEP: the single most useful correct fact in it, in one sentence (write "none" if there is none)`,
  ].join("\n\n");
}

/**
 * The CONVERGE prompt: one member consolidates the winning draft plus the
 * facts the swarm voted worth keeping into the brief the orchestrator merges.
 * It is given the dissent too — a swarm that did not converge must say so in
 * its own brief rather than present a coin-flip as a finding.
 * @param {{ task: string, lead: string, keeps?: string[], dissent?: string[], agreement?: number, userRequest?: string }} args
 * @returns {string}
 */
export function swarmSynthesisPrompt(args) {
  const parts = [
    `Several reasoners answered this question independently:\n${clip(args.task, 1200)}`,
    `The answer that survived peer review:\n${clip(args.lead, 2400)}`,
  ];
  if (args.keeps?.length) {
    parts.push(`Points other members marked worth keeping:\n${args.keeps.slice(0, 6).map((k) => `- ${clip(k, 220)}`).join("\n")}`);
  }
  if (args.dissent?.length) {
    parts.push(`Objections that were raised:\n${args.dissent.slice(0, 4).map((d) => `- ${clip(d, 220)}`).join("\n")}`);
  }
  parts.push(
    "Write the consolidated answer in 4-8 sentences: what the group concluded, the points worth keeping, and — if the objections were not resolved — one sentence saying exactly where the group disagreed. " +
      "Write in the language of the question (svara på svenska om frågan är på svenska). No headings, no preamble.",
  );
  return parts.join("\n\n");
}

// ---- critique parsing --------------------------------------------------------

/**
 * Parse a critique reply into data. Never throws and never guesses hard: a
 * reply that does not carry a readable verdict counts as "unclear", which the
 * scorer treats as an abstention rather than as support (a swarm must not be
 * able to vote itself confident by producing unparseable text).
 * @param {unknown} text
 * @returns {{ verdict: "support"|"dispute"|"unclear", flaw: string, keep: string }}
 */
export function parseCritique(text) {
  const s = String(text ?? "");
  const line = (/** @type {string} */ label) => {
    const m = new RegExp(`^\\s*${label}\\s*[:：-]\\s*(.+)$`, "im").exec(s);
    return m ? m[1].trim().replace(/[*_`]+/g, "").slice(0, 300) : "";
  };
  const rawVerdict = line("VERDICT").toLowerCase();
  const verdict = /\b(support|agree|correct|stödjer|instämmer)\b/.test(rawVerdict)
    ? /** @type {const} */ ("support")
    : /\b(dispute|disagree|wrong|incorrect|bestrider|felaktig)\b/.test(rawVerdict)
      ? /** @type {const} */ ("dispute")
      : /** @type {const} */ ("unclear");
  const none = (/** @type {string} */ v) => (/^(none|nothing|n\/a|inget|ingen|inga)\b/i.test(v) ? "" : v);
  return { verdict, flaw: none(line("FLAW")), keep: none(line("KEEP")) };
}

// ---- agreement + scoring (pure) ----------------------------------------------

// Stopwords in BOTH languages (invariant 6's spirit: a Swedish swarm must
// measure agreement as accurately as an English one — an English-only list
// would let Swedish function words dominate the overlap and report near-total
// agreement between two drafts that share nothing but "och den att").
const STOPWORDS = new Set([
  // English
  "the", "and", "that", "this", "with", "for", "are", "but", "not", "you", "your", "from", "have", "has", "was", "were",
  "can", "will", "would", "should", "there", "their", "they", "them", "its", "it's", "into", "than", "then", "when",
  "what", "which", "who", "how", "why", "all", "any", "some", "more", "most", "other", "such", "only", "also", "been",
  "one", "two", "about", "over", "under", "very", "much", "many", "does", "did", "doing", "because", "while",
  // Swedish
  "och", "att", "det", "den", "som", "med", "för", "inte", "har", "hade", "kan", "ska", "skall", "till", "från", "men",
  "eller", "vad", "vilken", "vilket", "vilka", "hur", "varför", "när", "där", "här", "detta", "denna", "dessa", "man",
  "sig", "sin", "sitt", "sina", "vara", "blir", "blev", "också", "bara", "mer", "mest", "andra", "några", "något",
  "alla", "över", "under", "mycket", "eftersom", "genom", "efter", "innan", "utan",
]);

/**
 * Content tokens of a draft: lowercased words of 3+ characters, stopwords
 * dropped, deduplicated. Unicode-aware so "överväg" and "påverkan" survive.
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function contentTokens(text) {
  const out = new Set();
  for (const raw of String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Jaccard overlap of two token sets (0 = disjoint, 1 = identical). @param {Set<string>} a @param {Set<string>} b */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * The swarm's CONVERGENCE number: mean pairwise content overlap across the
 * drafts. This is the confidence the node reports and the value the stop
 * condition reads — high overlap means the members independently landed in the
 * same place, which is the only evidence a swarm of small models can offer.
 * A single draft has nothing to agree with: 0, not 1.
 * @param {string[]} drafts
 * @returns {number} 0…1
 */
export function agreementScore(drafts) {
  const sets = (drafts || []).filter((d) => String(d ?? "").trim()).map(contentTokens);
  if (sets.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      total += jaccard(sets[i], sets[j]);
      pairs++;
    }
  }
  return pairs ? total / pairs : 0;
}

/**
 * The peer-review pairing: a RING (member i reviews member i+1, last reviews
 * the first). n critiques instead of n² — all-pairs review would multiply the
 * decode cost by the member count for a signal the ring already carries, and on
 * a phone that difference is minutes. Every draft is reviewed exactly once and
 * nobody reviews themselves.
 * @param {number} n
 * @returns {Array<{ critic: number, target: number }>}
 */
export function ringPeers(n) {
  const size = Math.max(0, Math.floor(Number(n) || 0));
  if (size < 2) return [];
  return Array.from({ length: size }, (_, i) => ({ critic: i, target: (i + 1) % size }));
}

/**
 * Score every draft. Two independent signals, deliberately combined in code:
 *  - CENTRALITY (the primary term): mean overlap with the OTHER drafts. Blunt
 *    but robust — the draft closest to everything else is the swarm's centre of
 *    mass, which is what self-consistency sampling exploits.
 *  - PEER VOTES (the modifier): the one critique each draft received. Sharp but
 *    noisy — it is one tiny model's opinion, and tiny models cheerfully
 *    "support" a confident irrelevance.
 * The vote is therefore worth VOTE_WEIGHT, deliberately less than the spread
 * centrality covers: a vote breaks ties and nudges the ranking, but a single
 * enthusiastic critique can never promote an outlier over the consensus (the
 * failure this weighting was tuned against — swarm-core.test.js pins both
 * directions). Empty drafts are excluded entirely: a member that produced
 * nothing must never win by having no one disagree with it.
 * @param {string[]} drafts
 * @param {Array<{ verdict: string, flaw?: string, keep?: string }|null|undefined>} critiques indexed by TARGET draft
 * @returns {Array<{ index: number, support: number, dispute: number, centrality: number, score: number, chars: number }>}
 */
export function scoreDrafts(drafts, critiques = []) {
  const list = (drafts || []).map((d) => String(d ?? "").trim());
  const sets = list.map(contentTokens);
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    let centralitySum = 0;
    let peers = 0;
    for (let j = 0; j < list.length; j++) {
      if (i === j || !list[j]) continue;
      centralitySum += jaccard(sets[i], sets[j]);
      peers++;
    }
    const centrality = peers ? centralitySum / peers : 0;
    const verdict = critiques[i]?.verdict;
    const support = verdict === "support" ? 1 : 0;
    const dispute = verdict === "dispute" ? 1 : 0;
    scored.push({
      index: i,
      support,
      dispute,
      centrality,
      score: centrality + VOTE_WEIGHT * (support - dispute),
      chars: list[i].length,
    });
  }
  // Deterministic order: score desc, then the longer draft, then input order —
  // no Math.random anywhere, so a swarm replays identically given the same
  // member outputs (the workflow graph and the brief must agree).
  scored.sort((a, b) => b.score - a.score || b.chars - a.chars || a.index - b.index);
  return scored;
}

/**
 * Reduce one round to its outcome: which draft leads, how far the swarm
 * converged, what the critiques said is worth keeping, and what the dissent
 * was. Pure — this is the whole "converge" step; the optional synthesis pass
 * afterwards only rewrites what this already decided.
 * @param {{ drafts: string[], critiques?: Array<{verdict: string, flaw?: string, keep?: string}|null|undefined> }} round
 * @returns {{ leadIndex: number, lead: string, agreement: number, keeps: string[], dissent: string[],
 *   scores: ReturnType<typeof scoreDrafts>, supported: number, disputed: number }}
 */
export function selectConsensus(round) {
  const drafts = (round?.drafts || []).map((d) => String(d ?? "").trim());
  const critiques = round?.critiques || [];
  const scores = scoreDrafts(drafts, critiques);
  const leadIndex = scores.length ? scores[0].index : -1;
  const keeps = [];
  const dissent = [];
  for (let i = 0; i < critiques.length; i++) {
    const c = critiques[i];
    if (!c) continue;
    if (c.keep) keeps.push(c.keep);
    // A flaw only counts as dissent when the reviewer actually disputed the
    // draft — "supported, but here is a nitpick" is not disagreement.
    if (c.verdict === "dispute" && c.flaw) dissent.push(c.flaw);
  }
  return {
    leadIndex,
    lead: leadIndex >= 0 ? drafts[leadIndex] : "",
    agreement: agreementScore(drafts),
    keeps: [...new Set(keeps)].slice(0, 6),
    dissent: [...new Set(dissent)].slice(0, 4),
    scores,
    supported: scores.filter((s) => s.support).length,
    disputed: scores.filter((s) => s.dispute).length,
  };
}

/**
 * The stop condition. Another round costs a full parallel decode plus a
 * critique pass, so it has to buy something: the swarm keeps going only while
 * it has BOTH rounds left and unresolved disagreement (or an outright disputed
 * lead). Converged early → stop early; that is the common case and the reason
 * `rounds` is a ceiling rather than a count.
 * @param {{ agreement: number, disputed?: number, round: number, rounds: number }} state round is 1-based
 * @returns {boolean}
 */
export function shouldContinue(state) {
  if (!state || state.round >= state.rounds) return false;
  return state.agreement < AGREEMENT_FLOOR || (state.disputed || 0) > 0;
}

// ---- the brief handed back to the orchestrator --------------------------------

/** @param {number} n */
function pct(n) {
  return `${Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * 100)}%`;
}

/**
 * The swarm node's result text — what `mergeAgentResults` folds into the final
 * answer. It leads with PROVENANCE because the merge model must be able to
 * weigh it correctly: this brief came from a dozen phone-sized models, not from
 * the answer model, and a low agreement number is a reason to hedge. Ending
 * with the open disagreement (rather than dropping it) is the same contract as
 * the orchestrator's failed-node notes — the synthesis is told what is thin.
 * @param {{ text: string, agreement: number, members: number, rounds: number, modelLabel?: string,
 *   dissent?: string[], failed?: number }} args
 * @returns {string}
 */
export function swarmBrief(args) {
  const model = args.modelLabel || "on-device model";
  const head =
    `[Local swarm: ${args.members} × ${model} in this browser, ${args.rounds} round${args.rounds === 1 ? "" : "s"}, ` +
    `peer agreement ${pct(args.agreement)}${args.failed ? `, ${args.failed} member${args.failed === 1 ? "" : "s"} failed` : ""}.` +
    (args.agreement < AGREEMENT_FLOOR ? " The members did NOT converge — treat this as a weak signal." : "") +
    "]";
  const body = String(args.text || "").trim();
  const tail = args.dissent?.length
    ? `\n\nUnresolved disagreement:\n${args.dissent.slice(0, 4).map((d) => `- ${d}`).join("\n")}`
    : "";
  return `${head}\n\n${body}${tail}`.trim();
}

// ---- event shapes -------------------------------------------------------------
//
// The swarm's additions to the status vocabulary (sse-protocol skill). They are
// built here so the runtime, the workflow view and the tests agree on one
// shape — and so a future SERVER-side swarm can emit the identical events over
// SSE without the client learning a second dialect. Today they are produced
// locally by swarm-runtime.js and dispatched through the same stream.js branch.
//
//   swarm_update — one swarm node's live state: per-member status + the
//                  round counter + the agreement number so far.

/** Member lifecycle states the graph renders (a subset shaped like NODE_STATES). */
export const MEMBER_STATES = ["pending", "loading", "running", "done", "failed"];

/**
 * @param {string} id the workflow node id this swarm belongs to
 * @param {{ round?: number, rounds?: number, agreement?: number, members?: string[], model?: string, phase?: string }} state
 * @returns {{ type: "swarm_update", id: string, round: number, rounds: number, agreement: number, members: string[], model: string, phase: string }}
 */
export function swarmUpdateEvent(id, state = {}) {
  return {
    type: /** @type {"swarm_update"} */ ("swarm_update"),
    id: String(id || ""),
    round: Number.isFinite(state.round) ? Number(state.round) : 1,
    rounds: Number.isFinite(state.rounds) ? Number(state.rounds) : SWARM_DEFAULT_ROUNDS,
    agreement: Number.isFinite(state.agreement) ? Math.max(0, Math.min(1, Number(state.agreement))) : 0,
    members: (state.members || []).map((m) => (MEMBER_STATES.includes(String(m)) ? String(m) : "pending")).slice(0, SWARM_MAX_MEMBERS),
    model: String(state.model || "").slice(0, 60),
    phase: String(state.phase || "").slice(0, 40),
  };
}
