// Node tests for the SWARM REASONING core (swarm-core.js): capacity planning,
// the stance spread, prompt assembly, critique parsing, the agreement metric,
// scoring/consensus, the stop condition, the brief, and the event shape. All
// pure — the browser side that spawns the workers is swarm-runtime.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGREEMENT_FLOOR,
  MEMBER_STANCES,
  SWARM_MAX_MEMBERS,
  SWARM_MAX_ROUNDS,
  agreementScore,
  contentTokens,
  jaccard,
  memberStance,
  parseCritique,
  planSwarmCapacity,
  ringPeers,
  scoreDrafts,
  selectConsensus,
  shouldContinue,
  swarmBrief,
  swarmCritiquePrompt,
  swarmMemberPrompt,
  swarmSynthesisPrompt,
  swarmUpdateEvent,
} from "./swarm-core.js";

// ---- capacity ----------------------------------------------------------------

test("planSwarmCapacity honours the member count and expresses the device as concurrency", () => {
  // A phone: few threads, little RAM — 8 members still RUN, four at a time is
  // not the answer; two at a time over four batches is.
  const phone = planSwarmCapacity({ requested: 8, hardwareConcurrency: 4, deviceMemoryGb: 4, modelBytes: 300e6 });
  assert.equal(phone.members, 8, "members are never silently shrunk");
  assert.ok(phone.concurrency >= 1 && phone.concurrency <= 4);
  assert.equal(phone.batches, Math.ceil(8 / phone.concurrency));
  // A workstation gets more in flight for the same team.
  const desktop = planSwarmCapacity({ requested: 8, hardwareConcurrency: 16, deviceMemoryGb: 8, modelBytes: 300e6 });
  assert.ok(desktop.concurrency >= phone.concurrency);
});

test("planSwarmCapacity clamps every input and survives missing device info", () => {
  const huge = planSwarmCapacity({ requested: 999, rounds: 99 });
  assert.equal(huge.members, SWARM_MAX_MEMBERS);
  assert.equal(huge.rounds, SWARM_MAX_ROUNDS);
  const tiny = planSwarmCapacity({ requested: 0, rounds: 0 });
  assert.equal(tiny.members, 2);
  assert.equal(tiny.rounds, 1);
  const unknown = planSwarmCapacity({});
  assert.ok(unknown.concurrency >= 1, "no navigator hints → a conservative pool, never zero");
  assert.equal(planSwarmCapacity({ requested: 6, maxWorkers: 1 }).concurrency, 1);
});

test("the pool shrinks as the MODEL grows, even when the browser hides its RAM", () => {
  // Safari and Firefox ship no navigator.deviceMemory — the browser the tab
  // crashes were reported on (feedback #26). The old sizing fixed the memory
  // bound at two members regardless of model size, so a 1.2 GB build got the
  // same pool as a 300 MB one. Each live member holds its own copy: the bound
  // has to follow the model.
  const tiny = planSwarmCapacity({ requested: 8, hardwareConcurrency: 10, modelBytes: 300e6 });
  const mid = planSwarmCapacity({ requested: 8, hardwareConcurrency: 10, modelBytes: 1.2e9 });
  const huge = planSwarmCapacity({ requested: 8, hardwareConcurrency: 10, modelBytes: 4.2e9 });
  assert.ok(tiny.concurrency >= mid.concurrency, `${tiny.concurrency} >= ${mid.concurrency}`);
  assert.ok(mid.concurrency >= huge.concurrency);
  assert.equal(huge.concurrency, 1, "a multi-gigabyte model runs one member at a time");
  assert.equal(huge.members, 8, "the team is not shrunk — it is queued (invariant 2)");
  assert.equal(huge.batches, 8);
  // Reported memory only ever DIVIDES: a bigger model never buys a bigger pool.
  const known = planSwarmCapacity({ requested: 8, hardwareConcurrency: 10, deviceMemoryGb: 8, modelBytes: 1.2e9 });
  assert.ok(known.perMemberGb > 1.2, "a loaded model costs more than its bytes on disk");
  assert.ok(known.concurrency <= planSwarmCapacity({ requested: 8, hardwareConcurrency: 10, deviceMemoryGb: 8, modelBytes: 300e6 }).concurrency);
});

test("live heap pressure tightens the pool, and an absent measurement never loosens it", () => {
  const base = { requested: 8, hardwareConcurrency: 16, deviceMemoryGb: 8, modelBytes: 300e6 };
  const calm = planSwarmCapacity(base);
  assert.ok(calm.concurrency >= 2);
  assert.ok(planSwarmCapacity({ ...base, heapUsedRatio: 0.75 }).concurrency < calm.concurrency, "tight heap halves it");
  assert.equal(planSwarmCapacity({ ...base, heapUsedRatio: 0.95 }).concurrency, 1, "a nearly full heap runs one");
  assert.equal(planSwarmCapacity({ ...base, heapUsedRatio: null }).concurrency, calm.concurrency, "unknown = unchanged");
  assert.equal(planSwarmCapacity({ ...base, heapUsedRatio: 0.2 }).concurrency, calm.concurrency);
});

// ---- stances -----------------------------------------------------------------

test("members get distinct stances and the list wraps past its length", () => {
  const ids = MEMBER_STANCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate lenses");
  assert.equal(memberStance(0).id, ids[0]);
  assert.equal(memberStance(MEMBER_STANCES.length).id, ids[0], "wraps");
  assert.equal(memberStance(-1).id, ids[ids.length - 1]);
  assert.ok(memberStance(1).instruction.length > 20);
});

// ---- prompts -----------------------------------------------------------------

test("swarmMemberPrompt carries the task, the lens, the position and Swedish parity", () => {
  const p = swarmMemberPrompt({ task: "Vilket ramverk passar bäst?", index: 1, members: 4, userRequest: "hela frågan" });
  assert.ok(p.includes("member 2 of 4"));
  assert.ok(p.includes("Vilket ramverk passar bäst?"));
  assert.ok(p.includes("hela frågan"));
  assert.ok(p.includes("svara på svenska"), "the answer-language rule rides every member prompt");
  assert.ok(!p.includes("Another member wrote this"), "round 1 has no lead to show");
});

test("swarmMemberPrompt shows round 2 the lead as a CLAIM plus the objections", () => {
  const p = swarmMemberPrompt({
    task: "t",
    index: 0,
    members: 3,
    round: 2,
    lead: "The leading draft.",
    dissent: ["It ignores cost."],
  });
  assert.ok(p.includes("Treat it as a claim to check, not as the answer"));
  assert.ok(p.includes("The leading draft."));
  assert.ok(p.includes("It ignores cost."));
});

test("swarmCritiquePrompt asks for exactly the three parsable lines", () => {
  const p = swarmCritiquePrompt({ task: "t", peerIndex: 2, draft: "their answer" });
  assert.ok(p.includes("Member 3 answered"));
  assert.ok(p.includes("VERDICT:"));
  assert.ok(p.includes("FLAW:"));
  assert.ok(p.includes("KEEP:"));
});

test("swarmSynthesisPrompt includes keeps and dissent when there are any", () => {
  const p = swarmSynthesisPrompt({ task: "t", lead: "L", keeps: ["k1"], dissent: ["d1"] });
  assert.ok(p.includes("k1") && p.includes("d1"));
  assert.ok(p.includes("svara på svenska"));
  assert.ok(!swarmSynthesisPrompt({ task: "t", lead: "L" }).includes("Objections that were raised"));
});

// ---- critique parsing ---------------------------------------------------------

test("parseCritique reads the three lines, in either language, in any casing", () => {
  const c = parseCritique("VERDICT: support\nFLAW: it skips the cost angle\nKEEP: the latency numbers are right");
  assert.deepEqual(c, { verdict: "support", flaw: "it skips the cost angle", keep: "the latency numbers are right" });
  assert.equal(parseCritique("verdict: DISPUTE\nflaw: wrong\nkeep: none").verdict, "dispute");
  assert.equal(parseCritique("VERDICT: instämmer\nFLAW: inget\nKEEP: inget").verdict, "support");
  assert.equal(parseCritique("VERDICT: bestrider").verdict, "dispute");
});

test("parseCritique treats unreadable replies as an abstention, and 'none' as empty", () => {
  assert.equal(parseCritique("I think it's pretty good overall!").verdict, "unclear");
  assert.equal(parseCritique(null).verdict, "unclear");
  const c = parseCritique("VERDICT: support\nFLAW: none\nKEEP: N/A");
  assert.equal(c.flaw, "");
  assert.equal(c.keep, "");
});

// ---- agreement ----------------------------------------------------------------

test("contentTokens drops stopwords in BOTH languages and short words", () => {
  assert.ok(!contentTokens("the and that with for").size, "English function words carry no signal");
  assert.ok(!contentTokens("och att det som med för inte").size, "…and neither do Swedish ones");
  assert.deepEqual([...contentTokens("Kostnaden påverkar valet")].sort(), ["kostnaden", "påverkar", "valet"]);
});

// The Swedish-parity guarantee this metric depends on: two Swedish drafts that
// share nothing but function words must score as DISAGREEING, exactly as the
// English pair does. An English-only stopword list scored them near 1.
test("agreement is measured with the same accuracy in Swedish as in English", () => {
  const svDisjoint = agreementScore([
    "Det är att kostnaden blir högre med den lösningen",
    "Det är att prestandan blir sämre med den arkitekturen",
  ]);
  const enDisjoint = agreementScore([
    "It is that the cost will be higher with that solution",
    "It is that the speed will be worse with that architecture",
  ]);
  assert.ok(svDisjoint < 0.35, `Swedish disjoint drafts scored ${svDisjoint}`);
  assert.ok(Math.abs(svDisjoint - enDisjoint) < 0.25, "the two languages land in the same band");
});

test("agreementScore rises with overlap and is 0 for a single draft", () => {
  assert.equal(agreementScore(["only one"]), 0);
  assert.equal(agreementScore([]), 0);
  const same = agreementScore(["latency matters most here", "latency matters most here"]);
  assert.equal(same, 1);
  const partial = agreementScore(["latency matters most here", "latency barely matters, cost dominates"]);
  assert.ok(partial > 0 && partial < same);
  assert.equal(jaccard(contentTokens(""), contentTokens("x")), 0);
});

// ---- pairing + scoring ---------------------------------------------------------

test("ringPeers reviews every draft exactly once and nobody reviews themselves", () => {
  const pairs = ringPeers(4);
  assert.equal(pairs.length, 4);
  assert.deepEqual(pairs.map((p) => p.target).sort(), [0, 1, 2, 3]);
  assert.ok(pairs.every((p) => p.critic !== p.target));
  assert.deepEqual(ringPeers(1), []);
  assert.deepEqual(ringPeers(0), []);
});

test("scoreDrafts combines peer votes with centrality and skips empty drafts", () => {
  const drafts = [
    "cost dominates the decision here", // the consensus position
    "cost dominates the decision here mostly",
    "the mascot should be purple",
    "", // a member that produced nothing
  ];
  const scored = scoreDrafts(drafts, [{ verdict: "support" }, { verdict: "unclear" }, { verdict: "support" }, null]);
  assert.equal(scored.length, 3, "the empty draft cannot win by default");
  assert.equal(scored[0].index, 0, "supported AND central");
  assert.ok(scored.at(-1).index === 2, "the outlier ranks last despite its support vote");
});

test("a single hostile critique cannot promote an outlier over the swarm's centre", () => {
  const drafts = ["latency is the constraint", "latency is the main constraint", "latency is the key constraint", "buy a bigger server"];
  const scored = scoreDrafts(drafts, [{ verdict: "dispute" }, null, null, { verdict: "support" }]);
  assert.notEqual(scored[0].index, 3, "the supported outlier must not lead");
});

test("selectConsensus reports the lead, the agreement, the keeps and only real dissent", () => {
  const c = selectConsensus({
    drafts: ["latency is the constraint here", "latency is the main constraint here", "unrelated musing about colors"],
    critiques: [
      { verdict: "support", flaw: "a nitpick", keep: "the latency framing" },
      { verdict: "support", flaw: "", keep: "the latency framing" },
      { verdict: "dispute", flaw: "it answers a different question", keep: "" },
    ],
  });
  assert.ok(c.lead.includes("latency"));
  assert.deepEqual(c.keeps, ["the latency framing"], "deduplicated");
  assert.deepEqual(c.dissent, ["it answers a different question"], "a supporter's nitpick is not dissent");
  assert.equal(c.supported, 2);
  assert.equal(c.disputed, 1);
  assert.ok(c.agreement > 0);
});

test("selectConsensus survives an all-empty round", () => {
  const c = selectConsensus({ drafts: ["", "  "], critiques: [] });
  assert.equal(c.leadIndex, -1);
  assert.equal(c.lead, "");
  assert.equal(c.agreement, 0);
});

// ---- the stop condition ---------------------------------------------------------

test("shouldContinue: converged swarms stop early, split ones use their rounds", () => {
  assert.equal(shouldContinue({ agreement: 0.8, disputed: 0, round: 1, rounds: 3 }), false, "converged → stop");
  assert.equal(shouldContinue({ agreement: 0.1, disputed: 0, round: 1, rounds: 3 }), true, "no convergence → another round");
  assert.equal(shouldContinue({ agreement: 0.9, disputed: 1, round: 1, rounds: 3 }), true, "a disputed lead is worth a round");
  assert.equal(shouldContinue({ agreement: 0.0, disputed: 2, round: 3, rounds: 3 }), false, "never past the ceiling");
  assert.equal(shouldContinue(null), false);
  assert.ok(AGREEMENT_FLOOR > 0 && AGREEMENT_FLOOR < 1);
});

// ---- the brief ------------------------------------------------------------------

test("swarmBrief leads with provenance and warns when the swarm did not converge", () => {
  const good = swarmBrief({ text: "The answer.", agreement: 0.7, members: 6, rounds: 2, modelLabel: "Bonsai 1.7B" });
  assert.ok(good.startsWith("[Local swarm: 6 × Bonsai 1.7B in this browser, 2 rounds, peer agreement 70%."));
  assert.ok(good.includes("The answer."));
  assert.ok(!good.includes("did NOT converge"));
  const split = swarmBrief({
    text: "The answer.",
    agreement: 0.1,
    members: 4,
    rounds: 3,
    failed: 1,
    dissent: ["cost was never priced"],
  });
  assert.ok(split.includes("did NOT converge"));
  assert.ok(split.includes("1 member failed"));
  assert.ok(split.includes("Unresolved disagreement:"));
  assert.ok(split.includes("cost was never priced"));
});

// ---- the event shape -------------------------------------------------------------

test("swarmUpdateEvent is bounded and normalizes unknown member states", () => {
  const ev = swarmUpdateEvent("s1", {
    round: 2,
    rounds: 3,
    agreement: 1.9,
    members: ["running", "done", "nonsense", "failed"],
    model: "Bonsai 1.7B",
    phase: "critique",
  });
  assert.equal(ev.type, "swarm_update");
  assert.equal(ev.id, "s1");
  assert.equal(ev.agreement, 1, "clamped to 0…1");
  assert.deepEqual(ev.members, ["running", "done", "pending", "failed"]);
  assert.equal(ev.phase, "critique");
  const bare = swarmUpdateEvent("s1");
  assert.equal(bare.round, 1);
  assert.deepEqual(bare.members, []);
});
