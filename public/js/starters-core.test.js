// Unit tests for the starter-prompt queue + evaluation core.
//
// Two jobs. The first half tests the LOGIC (selection, rotation, scoring,
// parsing) against hand-built fixtures. The second half runs the real
// validator over the real registry, so a bad edit to starters-data.js — a
// duplicate id, a queue that got shallower than the strip, an all-English
// queue, a rank someone typed in without an eval run behind it — fails
// `npm test` rather than reaching a user's opening screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SLOT_COUNT, QUEUE_MIN, EXPLOIT_SLOTS, UNRANKED_SCORE, DEAD_END_CAP, SHORTLIST_FLOOR,
  MODE_AGENTS, agentForMode, resolveQueue, agentIds, starterStanding, isProven,
  selectStarters, nextCursor, recordStarterUse, shortlistFor, starterScore, rankStarters,
  starterJudgePrompt, parseJudgeReply, validateStarters, registryReport,
} from "./starters-core.js";
import { STARTERS, ASPECTS } from "./starters-data.js";

const AGENTS = JSON.parse(readFileSync(new URL("../../sdk/AGENTS.json", import.meta.url), "utf8"));

/** A queue fixture: `n` entries, every `provenEvery`-th one ranked. */
function fixture(n, { provenEvery = 0, rank = 4 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    text: `starter number ${i} with enough text to pass`,
    aspect: `aspect-${i % 5}`,
    lang: i % 3 === 0 ? "sv" : "en",
    ...(provenEvery && i % provenEvery === 0 ? { rank, evidence: "run-x" } : {}),
  }));
}

// ---- mode → agent -----------------------------------------------------------

test("agentForMode maps every chat mode, and the tier wins over the mode", () => {
  assert.equal(agentForMode("normal"), "research");
  assert.equal(agentForMode("introspection"), "introspection");
  assert.equal(agentForMode("sdk"), "agent-builder");
  assert.equal(agentForMode("orchestrator"), "orchestrator");
  assert.equal(agentForMode("outrospection"), "outrospection");
  // Unknown / missing modes fall back to the normal agent rather than throwing.
  assert.equal(agentForMode("nonsense"), "research");
  assert.equal(agentForMode(null), "research");
  // Se/cure runs its own queue whatever the mode says.
  assert.equal(agentForMode("normal", { platform: "client" }), "secure");
  assert.equal(agentForMode("introspection", { platform: "client" }), "secure");
});

test("MODE_AGENTS mirrors the defaults table in sdk/AGENTS.json", () => {
  // Drift guard: the mode→agent mapping exists in both places (here for the
  // client, and in the registry the server routes on). They must agree.
  for (const d of AGENTS.defaults) {
    assert.equal(MODE_AGENTS[d.mode], d.agent, `mode ${d.mode} disagrees with sdk/AGENTS.json`);
  }
  assert.equal(Object.keys(MODE_AGENTS).length, AGENTS.defaults.length);
});

// ---- queue resolution -------------------------------------------------------

test("resolveQueue normalizes, de-duplicates, and never throws on junk", () => {
  const reg = {
    queues: {
      a: [
        { id: "x", text: "  a perfectly fine starter  ", aspect: "one", lang: "sv" },
        { id: "x", text: "duplicate id, dropped", aspect: "two", lang: "en" },
        { id: "", text: "no id, dropped", aspect: "two", lang: "en" },
        { id: "y", text: "", aspect: "two", lang: "en" },
        { id: "z", text: "another good starter here", aspect: "two", lang: "klingon" },
      ],
    },
  };
  const q = resolveQueue(reg, "a");
  assert.deepEqual(q.map((e) => e.id), ["x", "z"]);
  assert.equal(q[0].text, "a perfectly fine starter");
  assert.equal(q[0].lang, "sv");
  assert.equal(q[1].lang, "en", "an unknown language falls back to en");
  assert.deepEqual(resolveQueue(reg, "missing"), []);
  assert.deepEqual(resolveQueue(null, "a"), []);
  assert.deepEqual(agentIds(reg), ["a"]);
});

// ---- selection --------------------------------------------------------------

test("selectStarters fills the strip and never repeats an id", () => {
  const picked = selectStarters(fixture(20));
  assert.equal(picked.length, SLOT_COUNT);
  assert.equal(new Set(picked.map((e) => e.id)).size, SLOT_COUNT);
});

test("selectStarters spreads aspects across the strip", () => {
  // The fixture has 5 aspects over 20 entries, so 4 distinct ones are always
  // reachable — a strip showing the same aspect twice would be a real bug.
  const picked = selectStarters(fixture(20));
  assert.equal(new Set(picked.map((e) => e.aspect)).size, SLOT_COUNT);
});

test("selectStarters reserves the exploit slots for proven starters", () => {
  const q = fixture(20, { provenEvery: 7, rank: 5 });
  const picked = selectStarters(q);
  assert.equal(picked.filter(isProven).length, EXPLOIT_SLOTS);
  // ...and takes the BEST ones, not just any proven ones.
  const better = fixture(20, { provenEvery: 7, rank: 5 });
  better[0] = { ...better[0], rank: 2, evidence: "run-x" };
  const picked2 = selectStarters(better);
  assert.ok(!picked2.slice(0, EXPLOIT_SLOTS).some((e) => e.id === "s0"), "a weakly-ranked starter should not take an exploit slot over a strong one");
});

test("selectStarters degrades cleanly at both extremes", () => {
  // Nothing proven yet — every slot explores rather than the strip going short.
  assert.equal(selectStarters(fixture(20)).length, SLOT_COUNT);
  // Everything proven — the strip fills entirely from the shortlist.
  const allProven = selectStarters(fixture(20, { provenEvery: 1 }));
  assert.equal(allProven.length, SLOT_COUNT);
  assert.ok(allProven.every(isProven));
  // Queue shorter than the strip: show what there is, do not pad or throw.
  assert.equal(selectStarters(fixture(2)).length, 2);
  assert.deepEqual(selectStarters([]), []);
  assert.deepEqual(selectStarters(null), []);
});

test("the cursor rotates the explore half so the whole queue gets exercised", () => {
  const q = fixture(20);
  const seen = new Set();
  let cursor = 0;
  // Walk enough openings to cover the queue, following the cursor the way a
  // real surface does. Every entry must get a turn — that rotation is what
  // generates the evaluation signal in the first place.
  for (let i = 0; i < 12; i++) {
    const strip = selectStarters(q, { cursor });
    strip.forEach((e) => seen.add(e.id));
    cursor = nextCursor(cursor, strip);
  }
  assert.equal(seen.size, q.length, "every starter should surface within a dozen openings");
});

test("the cursor wraps rather than running off the end", () => {
  const q = fixture(20);
  assert.equal(selectStarters(q, { cursor: 1000 }).length, SLOT_COUNT);
  assert.equal(selectStarters(q, { cursor: -7 }).length, SLOT_COUNT);
});

test("selection is deterministic — the same inputs give the same strip", () => {
  const q = fixture(20, { provenEvery: 5 });
  const a = selectStarters(q, { cursor: 3, signal: { s2: 2 } });
  const b = selectStarters(q, { cursor: 3, signal: { s2: 2 } });
  assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id));
});

test("the language filter prefers the reader's language but never empties the strip", () => {
  const q = fixture(20);
  assert.ok(selectStarters(q, { lang: "sv" }).every((e) => e.lang === "sv"));
  // A queue with too few entries in that language falls back to the full pool
  // rather than showing a one-chip strip.
  const mostlyEnglish = fixture(20).map((e, i) => ({ ...e, lang: i === 0 ? "sv" : "en" }));
  const picked = selectStarters(mostlyEnglish, { lang: "sv" });
  assert.equal(picked.length, SLOT_COUNT);
});

// ---- local click signal ------------------------------------------------------

test("the click signal nudges standing without overturning a proven rank", () => {
  const plain = { id: "a" };
  const ranked = { id: "b", rank: 4 };
  assert.equal(starterStanding(plain), UNRANKED_SCORE);
  assert.ok(starterStanding(plain, { a: 1 }) > starterStanding(plain));
  // Capped: no amount of local clicking lifts an unranked starter a whole
  // point, so one browser's habits cannot outweigh a recorded eval result.
  assert.ok(starterStanding(plain, { a: 99 }) < starterStanding(ranked));
});

test("recordStarterUse is pure, counts, and stays bounded", () => {
  const s0 = {};
  const s1 = recordStarterUse(s0, "a");
  assert.deepEqual(s0, {}, "must not mutate the input");
  assert.equal(s1.a, 1);
  assert.equal(recordStarterUse(s1, "a").a, 2);
  assert.deepEqual(recordStarterUse(s1, ""), s1, "a junk id changes nothing");
  let big = {};
  for (let i = 0; i < 100; i++) big = recordStarterUse(big, `id${i}`);
  assert.ok(Object.keys(big).length <= 60, "the signal map must not grow without bound");
});

// ---- scoring ----------------------------------------------------------------

test("starterScore weights capability and first impression above raw quality", () => {
  const base = { capability: 3, quality: 3, firstImpression: 3 };
  const capable = starterScore({ ...base, capability: 5 });
  const pretty = starterScore({ ...base, quality: 5 });
  assert.ok(capable > pretty, "exercising the agent's capability must matter more than polished prose");
  assert.equal(starterScore({ capability: 5, quality: 5, firstImpression: 5 }), 5);
  assert.equal(starterScore({ capability: 1, quality: 1, firstImpression: 1 }), 1);
});

test("a dead end is capped however well the reply reads", () => {
  const perfect = { capability: 5, quality: 5, firstImpression: 5 };
  assert.equal(starterScore(perfect), 5);
  assert.ok(starterScore({ ...perfect, deadEnd: true }) <= DEAD_END_CAP);
  // ...and below the shortlist floor, so it can never be promoted.
  assert.ok(starterScore({ ...perfect, deadEnd: true }) < SHORTLIST_FLOOR);
});

test("starterScore clamps junk input instead of producing NaN", () => {
  const s = starterScore({ capability: 99, quality: /** @type {any} */ ("x"), firstImpression: -4 });
  assert.ok(Number.isFinite(s) && s >= 1 && s <= 5);
  assert.ok(Number.isFinite(starterScore(/** @type {any} */ (null))));
});

test("rankStarters orders by score, flags the shortlist, and keeps unjudged entries last", () => {
  const q = fixture(4);
  const ranked = rankStarters(q, {
    s0: { capability: 5, quality: 5, firstImpression: 5 },
    s1: { capability: 2, quality: 2, firstImpression: 2 },
    s2: { capability: 5, quality: 5, firstImpression: 5, deadEnd: true },
  });
  assert.equal(ranked[0].id, "s0");
  assert.equal(ranked[0].shortlisted, true);
  assert.equal(ranked.find((e) => e.id === "s2").shortlisted, false, "a dead end is never shortlisted");
  assert.equal(ranked[ranked.length - 1].id, "s3", "an unjudged starter sorts last");
  assert.equal(ranked[ranked.length - 1].score, null);
  assert.equal(q[0].score, undefined, "must not mutate the queue");
});

// ---- the judge --------------------------------------------------------------

test("the judge prompt carries the trace, not just the prose", () => {
  const p = starterJudgePrompt(
    { id: "x", text: "what shipped recently?", aspect: "deep-research" },
    { name: "Outrospection", tagline: "the outward feed", expect: "retrieve from the feed" },
    "an answer",
    { rounds: 2, searches: 6, sources: 18, tools: 0, ms: 12400 },
  );
  assert.match(p, /web searches: 6/);
  assert.match(p, /web sources: 18/);
  assert.match(p, /12\.4s/);
  assert.match(p, /Outrospection/);
  assert.match(p, /retrieve from the feed/);
  assert.match(p, /deadEnd/);
  assert.match(p, /deep-research/);
});

test("the judge prompt carries the phase timeline, and warns off counter-only judging", () => {
  // The regression this guards: run 2026-07-26T07-29-27Z judged outrospection
  // on web-search counters alone, saw 0/0 for an agent that had just read 24
  // feed items, and scored a good starter 1.35 for "fabricated" citations.
  const p = starterJudgePrompt(
    { id: "x", text: "what is in the feed?", aspect: "feed-state" },
    { name: "Outrospection", tagline: "the outward feed" },
    "an answer",
    { searches: 0, sources: 0, steps: ["outrospect: 24 items", "introspect: 6 excerpts"] },
  );
  assert.match(p, /PHASE TIMELINE/);
  assert.match(p, /- outrospect: 24 items/);
  assert.match(p, /- introspect: 6 excerpts/);
  assert.match(p, /NOT against the web-search counters alone/);
  // With no steps the section is omitted entirely rather than left empty.
  const bare = starterJudgePrompt({ id: "x", text: "q", aspect: "a" }, {}, "answer", { searches: 3 });
  assert.doesNotMatch(bare, /PHASE TIMELINE/);
});

test("parseJudgeReply survives fences, prose and clamps out-of-range scores", () => {
  const good = parseJudgeReply('```json\n{"capability":4,"firstImpression":5,"quality":3,"deadEnd":false,"notes":"good"}\n```');
  assert.deepEqual(good, { capability: 4, quality: 3, firstImpression: 5, deadEnd: false, notes: "good" });
  const chatty = parseJudgeReply('Sure! Here is my assessment:\n{"capability":9,"firstImpression":0,"quality":3,"deadEnd":true}\nHope that helps.');
  assert.equal(chatty.capability, 5, "out-of-range scores clamp rather than poisoning the average");
  assert.equal(chatty.firstImpression, 1);
  assert.equal(chatty.deadEnd, true);
  // Unusable replies drop the result instead of ending the battery.
  assert.equal(parseJudgeReply("no json here at all"), null);
  assert.equal(parseJudgeReply("{not valid json}"), null);
  assert.equal(parseJudgeReply(""), null);
  assert.equal(parseJudgeReply(/** @type {any} */ (null)), null);
});

// ---- shortlist ---------------------------------------------------------------

test("shortlistFor returns only proven starters, best first, and [] when nothing is proven", () => {
  const reg = { queues: { a: fixture(10, { provenEvery: 3, rank: 4 }) } };
  reg.queues.a[3] = { ...reg.queues.a[3], rank: 5, evidence: "run-x" };
  const list = shortlistFor(reg, "a");
  assert.ok(list.length > 0);
  assert.ok(list.every(isProven));
  assert.equal(list[0].rank, 5, "best first");
  assert.deepEqual(shortlistFor({ queues: { b: fixture(10) } }, "b"), [], "an unevaluated agent honestly returns nothing");
});

// ---- the real registry -------------------------------------------------------

test("the shipped registry validates against the real agent registry", () => {
  const { ok, problems } = validateStarters(STARTERS, AGENTS);
  assert.ok(ok, `starters-data.js is invalid:\n  ${problems.join("\n  ")}`);
});

test("the validator actually catches the mistakes it exists to catch", () => {
  // A guard that never fires is not a guard. Each of these is a real edit
  // someone could plausibly make to starters-data.js.
  const shallow = { queues: { research: fixture(3) } };
  assert.match(validateStarters(shallow).problems.join(" "), /at least 20/);

  const english = { queues: { research: fixture(20).map((e) => ({ ...e, lang: "en" })) } };
  assert.match(validateStarters(english).problems.join(" "), /Swedish/);

  const oneNote = { queues: { research: fixture(20).map((e) => ({ ...e, aspect: "same" })) } };
  assert.match(validateStarters(oneNote).problems.join(" "), /aspects/);

  const unbacked = { queues: { research: fixture(20).map((e, i) => (i ? e : { ...e, rank: 5 })) } };
  assert.match(validateStarters(unbacked).problems.join(" "), /evidence/);

  const dupes = { queues: { research: fixture(20), secure: fixture(20) } };
  assert.match(validateStarters(dupes).problems.join(" "), /not unique/);

  assert.match(validateStarters({}).problems.join(" "), /queues/);
  assert.match(validateStarters(null).problems.join(" "), /queues/);
});

test("every chat mode and both tiers can draw a full strip from the real registry", () => {
  // The end-to-end promise: open any agent, get four chips. Nothing less.
  for (const mode of Object.keys(MODE_AGENTS)) {
    const q = resolveQueue(STARTERS, agentForMode(mode));
    assert.ok(q.length >= QUEUE_MIN, `${mode} queue is too shallow`);
    assert.equal(selectStarters(q).length, SLOT_COUNT, `${mode} cannot fill the strip`);
    assert.equal(selectStarters(q, { lang: "sv" }).length, SLOT_COUNT, `${mode} cannot fill a Swedish strip`);
  }
  const secure = resolveQueue(STARTERS, agentForMode("normal", { platform: "client" }));
  assert.ok(secure.length >= QUEUE_MIN);
  assert.equal(selectStarters(secure).length, SLOT_COUNT);
});

test("every starter reads like an opener, not a one-word prod", () => {
  // The whole point of the registry: chat_logs #636 ("update") and #637 were
  // one-liners that named no subject and no task, and both produced an
  // empty-handed answer. A starter must carry enough to act on.
  for (const agent of agentIds(STARTERS)) {
    for (const e of resolveQueue(STARTERS, agent)) {
      const words = e.text.split(/\s+/).length;
      assert.ok(words >= 8, `${e.id} is only ${words} words — too thin to act on`);
      assert.match(e.text, /[?.]$/, `${e.id} should read as a complete question or instruction`);
    }
  }
});

test("every aspect used is declared in the agent's ASPECTS vocabulary", () => {
  // Keeps the taxonomy honest: a typo'd aspect would otherwise silently
  // become its own category and weaken the spread guarantee.
  for (const agent of agentIds(STARTERS)) {
    const declared = new Set(ASPECTS[agent] || []);
    for (const e of resolveQueue(STARTERS, agent)) {
      assert.ok(declared.has(e.aspect), `${agent}/${e.id} uses undeclared aspect "${e.aspect}"`);
    }
  }
});

test("registryReport summarises every agent", () => {
  const rows = registryReport(STARTERS);
  assert.equal(rows.length, AGENTS.agents.length);
  assert.ok(rows.every((r) => r.total >= QUEUE_MIN && r.sv >= 6 && r.aspects >= 8));
});
