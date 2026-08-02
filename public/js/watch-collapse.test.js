// THE FIVE SLOTS A BUILD NO LONGER DECIDES (feedback #59, owner directive).
//
// The report, verbatim: "Bezel insert, crystal, caseback and crown are
// practically never bought separately from the case. Base everything off the
// available cases online. … Chapter rings are usually not bought separately
// and are integrated with the case."
//
// A sibling change taught the SOURCING TABLE that. The owner then asked for the
// strong version: those five stop being top-level decisions altogether. A build
// takes them from the case; naming one is an OVERRIDE, reachable through an
// explicit secondary affordance and visible as an override once made.
//
// What this suite pins is the boundary the change had to respect. The PICKER
// changed; the ENGINE did not. So:
//
//   * `checkBuild` still never blocks a render (docs §5) — an override that
//     does not fit still draws, with the problem beside it.
//   * every part is still REACHABLE, from the picker and from the catalogue's
//     own option list, so a modder loses nothing but the obligation to decide.
//   * the codec is still FAIL-SOFT. It is no longer byte-compatible with a
//     pre-collapse link and is not meant to be; junk and stale input must
//     still produce a coherent watch rather than a throw or a blank page.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CASES,
  SLOTS,
  PRIMARY_SLOTS,
  CASE_PART_SLOTS,
  DEFAULT_BUILD,
  KEEP_ID,
  caseBuild,
  caseKit,
  checkBuild,
  compatibleOptions,
  decodeBuild,
  encodeBuild,
  isKitOverride,
  kitOverrides,
  normalizeBuild,
  part,
  resolveBuild,
  slotOptions,
  surpriseBuild,
  withCase,
  buildSpec,
} from "./watch-core.js";
import {
  caseSlotSummary,
  caseSlotView,
  caseSlots,
  primarySlots,
  annotateOptions,
} from "./watch-page-core.js";

/** A named part in every collapsed slot — what the default build used to be. */
const NAMED = {
  ...DEFAULT_BUILD,
  insert: "ceramic-black",
  chapterRing: "black-minutes",
  crystal: "dd-sapphire",
  crown: "signed-screw",
  caseback: "solid-engraved",
};

/** @param {number} seed */
function mkRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ---------------------------------------------------------------------------

describe("the picker shows the decisions a buyer makes", () => {
  test("six decisions, five taken from the case, and no slot lost", () => {
    assert.deepEqual(
      PRIMARY_SLOTS.map((s) => s.key),
      ["movement", "case", "finish", "dial", "hands", "strap"],
    );
    assert.deepEqual(CASE_PART_SLOTS, ["insert", "chapterRing", "crystal", "crown", "caseback"]);
    // Every slot is still a slot: the build's shape is unchanged, only who
    // decides it.
    assert.equal(PRIMARY_SLOTS.length + CASE_PART_SLOTS.length, SLOTS.length);
    // The page agrees with the catalogue about the split.
    assert.deepEqual(primarySlots().map((s) => s.key), PRIMARY_SLOTS.map((s) => s.key));
    assert.deepEqual(caseSlots().map((s) => s.key), CASE_PART_SLOTS);
  });

  test("every case answers for all five, and nothing it answers is invented", () => {
    for (const cs of CASES) {
      const from = caseBuild(cs.id);
      const kit = caseKit(cs.id);
      for (const key of CASE_PART_SLOTS) {
        const id = from[key];
        assert.ok(typeof id === "string" && id, `${cs.id}/${key}: no answer`);
        // Either a real catalogue part, or one of the two synthetic answers —
        // "keep what is in the box" and "nothing fitted". Nothing else.
        assert.ok(
          part(key, id) || id === KEEP_ID || id === "none",
          `${cs.id}/${key}: "${id}" is not a part, a keep or a none`,
        );
        // A slot the set does NOT fill can never answer "keep": there is
        // nothing in the box to keep, and saying so would be a claim about a
        // part the listing does not include.
        if (id === KEEP_ID) assert.ok(kit.includes.includes(key), `${cs.id}/${key}: kept what is not shipped`);
      }
      // …and picking that case, and only that case, produces exactly it.
      const build = normalizeBuild({ ...DEFAULT_BUILD, case: cs.id });
      for (const key of CASE_PART_SLOTS) assert.equal(build[key], from[key], `${cs.id}/${key}`);
      assert.deepEqual(kitOverrides(build), [], cs.id);
    }
  });

  test("an unknown case still answers, so a junk build is still a watch", () => {
    for (const id of ["", "gone-from-the-catalogue", "../etc/passwd"]) {
      const from = caseBuild(id);
      for (const key of CASE_PART_SLOTS) assert.ok(from[key], `${id}/${key}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("a modder can still reach every part", () => {
  test("the whole catalogue is offered for each of the five, plus keep and none", () => {
    for (const key of CASE_PART_SLOTS) {
      const rows = annotateOptions(key, DEFAULT_BUILD);
      const ids = new Set(rows.map((r) => r.option.id));
      for (const opt of slotOptions(key)) assert.ok(ids.has(opt.id), `${key}: ${opt.id} is unreachable`);
      assert.ok(ids.has(KEEP_ID), `${key}: no "keep what the case comes with"`);
      // Nothing is filtered out — an option that clashes comes back marked,
      // never missing (the dropdown philosophy #56 established).
      assert.ok(rows.length >= slotOptions(key).length, key);
    }
  });

  test("the catalogue's own option list carries the keep choice too", () => {
    // Not only the page: the chat parser, the MCP tools and
    // /api/watch/catalog all enumerate through `compatibleOptions`, and a
    // choice only the picker can express is a choice half the surfaces lose.
    for (const key of CASE_PART_SLOTS) {
      const ids = compatibleOptions(key, DEFAULT_BUILD).map((r) => r.option.id);
      assert.equal(ids.includes(KEEP_ID), caseKit(DEFAULT_BUILD.case).includes.includes(key), key);
    }
    // A case whose set does not fill a slot offers no keep for it — there is
    // nothing in that box.
    const ro = compatibleOptions("insert", { ...DEFAULT_BUILD, case: "royal-oak" });
    assert.equal(ro.some((r) => r.option.id === KEEP_ID), false);
    assert.ok(ro.length > 1, "and the whole insert catalogue is still offered");
  });

  test("an override is REPORTED as an override, per slot and in one list", () => {
    const swapped = normalizeBuild({ ...DEFAULT_BUILD, insert: "pepsi", crystal: "box-sapphire" });
    assert.deepEqual(kitOverrides(swapped), ["insert", "crystal"]);
    assert.equal(isKitOverride(swapped, "insert"), true);
    assert.equal(isKitOverride(swapped, "caseback"), false);
    // …and a slot the buyer decides is never one, whatever it holds.
    for (const slot of PRIMARY_SLOTS) assert.equal(isKitOverride(swapped, slot.key), false, slot.key);
    assert.deepEqual(buildSpec(swapped).overrides, ["insert", "crystal"]);
  });

  test("the shut disclosure names every swap, in both languages", () => {
    const quiet = caseSlotSummary(DEFAULT_BUILD);
    assert.match(quiet.en, /5 parts come with the case/);
    assert.ok(quiet.sv && quiet.sv !== quiet.en, "the summary must be translated, not echoed");

    const swapped = normalizeBuild({ ...DEFAULT_BUILD, insert: "pepsi", crystal: "box-sapphire" });
    const loud = caseSlotSummary(swapped);
    assert.match(loud.en, /Swapped 2 of 5/);
    assert.match(loud.en, /Pepsi/);
    assert.match(loud.en, /Box sapphire/i);
    assert.match(loud.sv, /Bytt 2 av 5/);
    assert.notEqual(loud.sv, loud.en);
  });

  test("the disclosure's rows carry the fit verdict, so nothing hides in the fold", () => {
    // A crystal that clashes with the insert profile is a WARNING, and it has
    // to reach the shut summary — a fold that swallows a problem is worse than
    // no fold. `problems` is what the summary's ⚠ counts.
    const clash = normalizeBuild({
      ...DEFAULT_BUILD, insert: "ceramic-black", crystal: "dd-sapphire",
      insertProfile: "flat", crystalEdge: "stepped",
    });
    const view = caseSlotView(clash);
    assert.ok(view.problems.length >= 1, "a warning inside the fold was invisible from outside");
    for (const p of view.problems) {
      assert.ok(p.why && p.why.en && p.why.sv && p.why.sv !== p.why.en, `${p.slot}: not bilingual`);
    }
    // The quiet build has nothing to report.
    assert.deepEqual(caseSlotView(DEFAULT_BUILD).problems, []);
  });

  test("every row of the view is bilingual and actually translated", () => {
    const seen = [];
    for (const cs of CASES) {
      const v = caseSlotView({ ...DEFAULT_BUILD, case: cs.id });
      assert.equal(v.rows.length, CASE_PART_SLOTS.length, cs.id);
      for (const r of v.rows) {
        // The slot NAME is the catalogue's and is pinned there; "Chapter ring"
        // is the same word in both languages, which is a real fact about
        // Swedish watch vocabulary rather than a missing translation.
        assert.ok(r.name.en && r.name.sv, r.slot);
        seen.push(r.current);
        if (r.why) seen.push(r.why);
      }
      seen.push(caseSlotSummary({ ...DEFAULT_BUILD, case: cs.id }, v));
    }
    assert.ok(seen.length > 60, "the sweep has to actually cover the catalogue");
    for (const s of seen) {
      assert.ok(s.en && String(s.en).trim(), "an empty English string");
      assert.ok(s.sv && String(s.sv).trim(), `no Swedish for: ${s.en}`);
      assert.notEqual(s.sv, s.en, `untranslated: ${s.en}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the engine did not change", () => {
  test("an override that does not fit still DRAWS, with the problem beside it", () => {
    // docs §5, and the reason the collapse is a picker change rather than an
    // engine change: the tool's point is showing you what a combination looks
    // like, so nothing here may gate.
    const bad = normalizeBuild({ ...DEFAULT_BUILD, case: "62mas", insert: "batman" });
    const { issues } = checkBuild(bad);
    assert.ok(issues.length, "a mismatched insert must still be reported");
    const { parts } = resolveBuild(bad);
    for (const slot of SLOTS) assert.ok(parts[slot.key] && parts[slot.key].name, `${slot.key} unrenderable`);
    assert.equal(parts.insert.id, "batman", "and the render shows what was asked for");
  });

  test("changing the case takes that case's parts, and keeps the buyer's swaps", () => {
    const base = normalizeBuild(DEFAULT_BUILD);
    // Nothing overridden: every collapsed slot follows the new case.
    const tuna = withCase(base, "tuna");
    assert.deepEqual(kitOverrides(tuna), []);
    for (const key of CASE_PART_SLOTS) assert.equal(tuna[key], caseBuild("tuna")[key], key);
    // One overridden: it survives the move, and only it.
    const pepsi = normalizeBuild({ ...base, insert: "pepsi" });
    const moved = withCase(pepsi, "mm300");
    assert.equal(moved.insert, "pepsi", "a deliberate swap must not evaporate on a case change");
    assert.deepEqual(kitOverrides(moved), ["insert"]);
    for (const key of CASE_PART_SLOTS) {
      if (key === "insert") continue;
      assert.equal(moved[key], caseBuild("mm300")[key], key);
    }
    // And a junk case id leaves the build where it was rather than throwing.
    assert.equal(withCase(base, "no-such-case").case, base.case);
  });

  test("surpriseBuild still assembles, and still varies the parts it decides", () => {
    /** @type {Record<string, Set<string>>} */
    const seen = { movement: new Set(), case: new Set(), dial: new Set(), insert: new Set() };
    for (let s = 1; s <= 40; s++) {
      const b = surpriseBuild(mkRand(s));
      assert.equal(checkBuild(b).ok, true, `seed ${s} produced an unassemblable build`);
      for (const key of Object.keys(seen)) seen[key].add(b[key]);
    }
    assert.ok(seen.movement.size > 1, "one movement every time is not a surprise");
    assert.ok(seen.case.size > 3, "one case every time is not a surprise");
    assert.ok(seen.dial.size > 3);
    // And it DOES sometimes override a part the case decides — half the time
    // per slot — so the surprise is not always the plain case set.
    assert.ok(seen.insert.size > 1, "surprise never touched a bundled slot");
  });

  test("the codec is fail-soft on anything, however stale or hostile", () => {
    const codes = [
      "", ";", ";;;;", ":::", "case", "case:", ":skx007", "a".repeat(4000),
      "case:skx007;insert:%%%;crystal:<script>",
      "movement:nh35;case:skx007;finish:brushed;insert:ceramic-black;dial:skx-black;"
        + "chapterRing:black-minutes;hands:skx-dive;crystal:dd-sapphire;crown:signed-screw;"
        + "caseback:solid-engraved;strap:oyster",
      encodeBuild(NAMED),
      encodeBuild({ ...DEFAULT_BUILD, case: "royal-oak" }),
    ];
    for (const code of codes) {
      const b = decodeBuild(code);
      const { parts } = resolveBuild(b);
      for (const slot of SLOTS) assert.ok(parts[slot.key] && parts[slot.key].name, `${slot.key} for "${code.slice(0, 30)}"`);
      assert.equal(checkBuild(b).issues.every((i) => i.en && i.sv), true);
      // Round-tripping is stable even when the input was not: whatever the
      // code became, encoding it again and decoding that gives the same build.
      assert.deepEqual(decodeBuild(encodeBuild(b)), b, `unstable for "${code.slice(0, 30)}"`);
    }
  });

  test("a link carries the decisions and the swaps, and shrinks when there are none", () => {
    const plain = encodeBuild(DEFAULT_BUILD);
    const named = encodeBuild(NAMED);
    assert.ok(named.length > plain.length, "an override has to be in the link");
    for (const key of CASE_PART_SLOTS) assert.ok(!plain.includes(`${key}:`), key);
    // Opening a link on another case is a case change, and the codec says so:
    // the collapsed slots it did not carry come from whatever case it names.
    const onTuna = decodeBuild(plain.replace("case:skx007", "case:tuna"));
    assert.equal(onTuna.case, "tuna");
    for (const key of CASE_PART_SLOTS) assert.equal(onTuna[key], caseBuild("tuna")[key], key);
  });
});
