// The sourcing table as ORDERS, and the option that makes it possible to say
// "keep what the case comes with" (feedback #59).
//
// > "Bezel insert, crystal, caseback and crown are practically never bought
// > separately from the case. … Chapter rings are usually not bought
// > separately and are integrated with the case."
//
// A sibling change taught the catalogue that (`watch-kits.test.js` covers the
// model). Two things were still missing and are what this file pins:
//
//   1. The PRESENTATION. `sourcingFor` carried `orderWith`, `bundle`,
//      `separateOrder` and `bundlePriceUsd` and the page ignored every one of
//      them, so the table still drew each part as an equal priced row — the
//      exact thing the report complained about. `sourcingView` shapes the rows
//      into parcels and `orderSummary` counts them out loud.
//   2. "KEEP WHAT THE CASE COMES WITH" as a choice distinct from "not fitted".
//      Getting those two confused in EITHER direction is the failure mode, so
//      the compatibility assertions below run both ways round: a missing
//      chapter ring must still raise the floating-dial problem, and a kept one
//      must not.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUILD,
  KEEP_ID,
  KIT_SLOTS,
  buildSpec,
  canKeepStock,
  caseKit,
  checkBuild,
  decodeBuild,
  encodeBuild,
  keepOption,
  kitBuy,
  normalizeBuild,
  part,
  resolveBuild,
  slotCanKeep,
  sourcingFor,
  CASES,
} from "./watch-core.js";
import {
  KEEP_ID as PAGE_KEEP_ID,
  SWAP_SUFFIX,
  annotateOptions,
  bandLabel,
  orderSummary,
  sourcingView,
} from "./watch-page-core.js";

const BASE = normalizeBuild(DEFAULT_BUILD);
/** Every slot of a build set to "keep the one in the box". */
const KEPT = normalizeBuild({
  ...DEFAULT_BUILD,
  insert: KEEP_ID,
  chapterRing: KEEP_ID,
  crystal: KEEP_ID,
  crown: KEEP_ID,
  caseback: KEEP_ID,
});

/** @param {any} build @param {string} slot */
function ringIssue(build, slot) {
  return checkBuild(build).issues.find(
    (i) => Array.isArray(i.slots) && i.slots.includes(slot) && i.level !== "note",
  ) || null;
}

// ---------------------------------------------------------------------------

describe('"keep what the case comes with" is not "not fitted"', () => {
  test("the two are different ids with different meanings all the way down", () => {
    assert.equal(KEEP_ID, "stock");
    assert.equal(PAGE_KEEP_ID, KEEP_ID, "the page and the catalogue must agree on the id");
    assert.notEqual(KEEP_ID, "none");
    // Neither is a catalogue part: both are decisions about the ORDER.
    for (const slot of KIT_SLOTS) assert.equal(part(slot, KEEP_ID), null, slot);
    // Exactly the slots a case set can fill, and nothing else.
    for (const slot of KIT_SLOTS) assert.equal(slotCanKeep(slot), true, slot);
    for (const slot of ["dial", "hands", "strap", "movement", "case", "finish"]) {
      assert.equal(slotCanKeep(slot), false, slot);
      assert.equal(keepOption(slot), null, slot);
    }
  });

  test("a KEPT part is fitted; an OMITTED one is absent, and resolveBuild says which", () => {
    const kept = resolveBuild(KEPT);
    for (const slot of KIT_SLOTS) {
      assert.equal(kept.kept[slot], true, `${slot}: not reported kept`);
      assert.equal(kept.omitted[slot], undefined, `${slot}: a kept part must NEVER be omitted`);
      assert.ok(kept.parts[slot] && kept.parts[slot].name, `${slot}: no part to render`);
      assert.ok(kept.parts[slot].name.en && kept.parts[slot].name.sv, `${slot}: not bilingual`);
    }
    // The same three slots that could already be left out still can be, and
    // that still means absent.
    const gone = resolveBuild({ ...DEFAULT_BUILD, insert: "none", chapterRing: "none", crystal: "none" });
    for (const slot of ["insert", "chapterRing", "crystal"]) {
      assert.equal(gone.omitted[slot], true, `${slot}: "none" stopped meaning absent`);
      assert.equal(gone.kept[slot], undefined, `${slot}: "none" must not read as kept`);
    }
  });

  test("the crown is the one kept part the catalogue can actually name", () => {
    // Every case entry records whether the crown it is sold with is signed, so
    // this is a derivation rather than a guess. Everything else stands in
    // unmarked rather than inventing a SKU nobody publishes.
    const kept = resolveBuild({ ...DEFAULT_BUILD, crown: KEEP_ID });
    assert.equal(kept.parts.crown.id, "signed-screw", "the SKX007 is sold with a signed crown");
    const plain = resolveBuild({ ...DEFAULT_BUILD, case: "62mas", crown: KEEP_ID });
    assert.equal(plain.parts.crown.id, "plain-screw", "the 62MAS is not");
    for (const slot of ["insert", "chapterRing", "crystal", "caseback"]) {
      assert.equal(resolveBuild(KEPT).parts[slot].id, KEEP_ID, `${slot}: a SKU was invented`);
    }
  });
});

// ---------------------------------------------------------------------------
// THE FAILURE MODE, BOTH WAYS ROUND. This is the part of the change that could
// quietly do harm: a "keep it" that suppresses a real fitment problem, or a
// "none" that stops raising one.

describe("the compatibility warnings still fire, in both directions", () => {
  test('"no chapter ring fitted" still warns that the dial floats', () => {
    const soft = ringIssue({ ...DEFAULT_BUILD, chapterRing: "none" }, "chapterRing");
    assert.ok(soft, "the floating-dial warning vanished");
    assert.equal(soft.level, "warning");
    assert.match(soft.en, /dial floats up off the movement/);
    assert.match(soft.sv, /lyfter urtavlan från urverket/);
  });

  test('"keep the case\'s own chapter ring" does NOT — it is a fitted ring', () => {
    const kept = ringIssue({ ...DEFAULT_BUILD, chapterRing: KEEP_ID }, "chapterRing");
    assert.equal(kept, null, "keeping the ring in the box was read as leaving it out");
    // And the build is otherwise unchanged: nothing else started or stopped.
    const before = checkBuild(DEFAULT_BUILD).issues.length;
    const after = checkBuild({ ...DEFAULT_BUILD, chapterRing: KEEP_ID }).issues.length;
    assert.ok(after <= before, "keeping a part cannot ADD a problem");
  });

  test("the SKX013's mandatory ring is still an ERROR when it is left out", () => {
    // The strongest version of the same distinction: on this platform a
    // missing ring is not a warning, it is a build that cannot be assembled.
    const bad = ringIssue({ ...DEFAULT_BUILD, case: "skx013", chapterRing: "none" }, "chapterRing");
    assert.ok(bad);
    assert.equal(bad.level, "error");
    assert.match(bad.en, /hands will not clear/);
    assert.equal(checkBuild({ ...DEFAULT_BUILD, case: "skx013", chapterRing: "none" }).ok, false);
    // …and keeping the one the case ships satisfies it, because it IS a ring.
    const ok = { ...DEFAULT_BUILD, case: "skx013", chapterRing: KEEP_ID };
    assert.equal(ringIssue(ok, "chapterRing"), null);
    assert.equal(checkBuild(ok).issues.some((i) => i.level === "error"), false);
  });

  test("a left-out slot is not DESCRIBED as one the case fills", () => {
    // Before the keep option existed, "none" had to cover both readings, so the
    // note said "Comes with the case: the case set ships one". Next to a "not
    // fitted" row that sentence is the exact confusion being fixed.
    const gone = kitBuy({ ...DEFAULT_BUILD, chapterRing: "none" }, "chapterRing");
    const kept = kitBuy({ ...DEFAULT_BUILD, chapterRing: KEEP_ID }, "chapterRing");
    assert.match(gone.note.en, /Left out/);
    assert.match(gone.note.en, /not the same as keeping/);
    assert.match(gone.note.sv, /Utelämnad/);
    assert.match(kept.note.en, /^Kept:/);
    assert.match(kept.note.sv, /^Behålls:/);
    assert.notEqual(gone.note.en, kept.note.en);
    // …and both still cost nothing and order nothing.
    for (const b of [gone, kept]) {
      assert.deepEqual(b.priceUsd, [0, 0]);
      assert.equal(b.separateOrder, false);
    }
  });

  test("keeping a part never suppresses a problem that belongs to another slot", () => {
    // A dated movement under a no-date dial is nothing to do with the case set,
    // and must survive every slot being kept.
    const clash = { ...KEPT, movement: "nh35", dial: "sterile-nodate" };
    const before = checkBuild({ ...BASE, movement: "nh35", dial: "sterile-nodate" })
      .issues.filter((i) => i.level === "error").length;
    const after = checkBuild(clash).issues.filter((i) => i.level === "error").length;
    assert.equal(after, before, "keeping the ring parts hid a movement/dial error");
  });

  test("keeping the crown drops the crown-interchange note, because nothing is bought", () => {
    // R9 warns that SKX007 and SRPD crowns do not interchange — a warning about
    // BUYING the wrong one. A crown that came off this case fits it.
    const named = checkBuild({ ...DEFAULT_BUILD, crown: "fluted" })
      .issues.find((i) => i.slot === "crown" && /do not interchange/.test(i.en));
    assert.ok(named, "the note stopped firing for a named crown");
    const kept = checkBuild({ ...DEFAULT_BUILD, crown: KEEP_ID })
      .issues.find((i) => i.slot === "crown" && /do not interchange/.test(i.en));
    assert.equal(kept, undefined, "a kept crown cannot be the wrong crown");
  });
});

// ---------------------------------------------------------------------------

describe("the option is offered where there is something to keep", () => {
  test("every bundled slot of a case that ships one offers it, first", () => {
    for (const slot of caseKit("skx007").includes) {
      const rows = annotateOptions(slot, DEFAULT_BUILD);
      assert.equal(rows[0].option.id, KEEP_ID, `${slot}: "keep it" is not the head option`);
      assert.equal(rows[0].compatible, true, `${slot}: keeping a fitted part cannot clash`);
      assert.ok(rows[0].option.name.en && rows[0].option.name.sv, `${slot}: not bilingual`);
      assert.notEqual(rows[0].option.name.sv, rows[0].option.name.en, `${slot}: untranslated`);
      assert.ok(rows[0].option.blurb.en && rows[0].option.blurb.sv, `${slot}: no blurb`);
      assert.notEqual(rows[0].option.blurb.sv, rows[0].option.blurb.en, `${slot}: untranslated blurb`);
    }
  });

  test("a case with no rotating bezel offers no insert to keep", () => {
    // Derived, not allow-listed: there is no insert in the box because there is
    // nothing to hold one.
    const alpinist = CASES.find((c) => c.id === "alpinist");
    assert.ok(alpinist && alpinist.bezel !== "dive120", "the fixture case changed");
    assert.equal(caseKit("alpinist").includes.includes("insert"), false);
    assert.equal(canKeepStock({ ...DEFAULT_BUILD, case: "alpinist" }, "insert"), false);
    const rows = annotateOptions("insert", { ...DEFAULT_BUILD, case: "alpinist" });
    assert.equal(rows.some((r) => r.option.id === KEEP_ID), false, "offered a keep with nothing to keep");
  });

  test("every case in the catalogue offers it for every slot its set fills", () => {
    for (const cs of CASES) {
      const build = { ...DEFAULT_BUILD, case: cs.id };
      for (const slot of KIT_SLOTS) {
        const inKit = caseKit(cs.id).includes.includes(slot);
        assert.equal(canKeepStock(build, slot), inKit, `${cs.id}/${slot}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("the PROMOTION: an uncertain maybe becomes a certain zero", () => {
  test("the case back could only ever be a maybe; kept, it is settled", () => {
    // No listing says which back is in a case set, so naming one prices as
    // "nothing … its listed high" and stays flagged approximate. That was the
    // only answer available before the choice existed.
    const named = kitBuy(DEFAULT_BUILD, "caseback");
    assert.equal(named.status, "replaces");
    assert.equal(named.certain, false);
    assert.equal(named.approx, true);
    assert.equal(named.priceUsd[0], 0);
    assert.ok(named.priceUsd[1] > 0, "the band must carry BOTH ends");

    const kept = kitBuy({ ...DEFAULT_BUILD, caseback: KEEP_ID }, "caseback");
    assert.equal(kept.status, "included");
    assert.equal(kept.kept, true);
    assert.equal(kept.certain, true, "the promotion did not happen");
    assert.equal(kept.approx, false);
    assert.equal(kept.separateOrder, false);
    assert.deepEqual(kept.priceUsd, [0, 0]);
  });

  test("a named part on a bundled slot keeps BOTH ends of its band", () => {
    // The uncertainty is real and docs §2 forbids collapsing it to one number
    // to tidy the UI up. Keeping the set's own costs nothing; fitting the named
    // one costs what it is listed at; the row says both.
    for (const slot of ["crystal", "insert", "chapterRing", "caseback"]) {
      const buy = kitBuy(DEFAULT_BUILD, slot);
      if (buy.status !== "replaces" || buy.certain) continue;
      assert.equal(buy.priceUsd[0], 0, slot);
      assert.ok(buy.priceUsd[1] > buy.priceUsd[0], `${slot}: the high end was thrown away`);
    }
  });

  test("keeping everything is the cheapest honest build, and it is certain", () => {
    const kept = buildSpec(KEPT);
    const named = buildSpec(DEFAULT_BUILD);
    assert.equal(kept.priceUsd.low, named.priceUsd.low, "keeping was already the floor");
    assert.ok(kept.priceUsd.high < named.priceUsd.high, "and it removes the swap ceiling");
    for (const slot of KIT_SLOTS) assert.equal(kitBuy(KEPT, slot).certain, true, slot);
  });

  test("every note this adds is bilingual and actually translated", () => {
    const seen = [];
    for (const cs of CASES) {
      for (const slot of caseKit(cs.id).includes) {
        const buy = kitBuy({ ...DEFAULT_BUILD, case: cs.id, [slot]: KEEP_ID }, slot);
        assert.ok(buy.note, `${cs.id}/${slot}: kept with nothing said`);
        seen.push(buy.note);
      }
      seen.push(orderSummary({ ...DEFAULT_BUILD, case: cs.id }));
      const opt = keepOption("crown");
      seen.push(opt.name, opt.blurb);
    }
    assert.ok(seen.length > 50, "the sweep has to actually cover the catalogue");
    for (const s of seen) {
      assert.ok(s.en && s.en.trim(), "an empty English string");
      assert.ok(s.sv && s.sv.trim(), `no Swedish for: ${s.en}`);
      assert.notEqual(s.sv, s.en, `untranslated: ${s.en}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the sourcing table reads as parcels, not as parts", () => {
  test("a stock SKX007 is four orders, and the count names them", () => {
    const view = sourcingView(DEFAULT_BUILD);
    assert.equal(view.parcels, 4);
    assert.deepEqual(view.orderSlots, ["case", "dial", "hands", "strap"]);
    // Five parts arrive inside the first of those four.
    assert.equal(view.bundled.length, 5);
    assert.deepEqual(
      view.bundled.map((b) => b.slot).sort(),
      ["caseback", "chapterRing", "crown", "crystal", "insert"],
    );
    for (const b of view.bundled) assert.equal(b.row ? b.row.orderWith : "case", "case", b.slot);
    const s = orderSummary(DEFAULT_BUILD, view);
    assert.match(s.en, /4 separate orders/);
    assert.match(s.en, /the case set, which brings 5 more parts with it/);
    assert.match(s.en, /dial, hands and strap/);
    assert.match(s.sv, /4 separata beställningar/);
    assert.match(s.sv, /urtavla, visare och band/);
  });

  test("the case row carries the one sentence that says what arrives with it", () => {
    const view = sourcingView(DEFAULT_BUILD);
    assert.ok(view.caseRow, "no case row");
    assert.ok(view.kitSummary && view.kitSummary.en && view.kitSummary.sv);
    assert.match(view.kitSummary.en, /one order, not 6/);
    assert.notEqual(view.kitSummary.sv, view.kitSummary.en);
  });

  test("a real swap the catalogue can price IS a parcel of its own", () => {
    // The 62MAS is sold with an unsigned crown; naming the signed one is a
    // genuine extra order and must be counted as one.
    const build = { ...DEFAULT_BUILD, case: "62mas", crown: "signed-screw" };
    const view = sourcingView(build);
    assert.equal(kitBuy(build, "crown").certain, true);
    assert.ok(view.orderSlots.includes("crown"), "a certain swap vanished from the order list");
    assert.equal(view.parcels, 5);
    // Keeping it instead takes the parcel away again.
    const kept = sourcingView({ ...build, crown: KEEP_ID });
    assert.equal(kept.parcels, 4);
    assert.equal(kept.orderSlots.includes("crown"), false);
  });

  test("an integrated chapter ring is marked as part of the case, not as a purchase", () => {
    // Feedback #59's second sentence, taken literally: on a case-specific
    // family the ring is machined in.
    const view = sourcingView({ ...DEFAULT_BUILD, case: "62mas" });
    const ring = view.bundled.find((b) => b.slot === "chapterRing");
    assert.ok(ring);
    assert.equal(ring.integrated, true);
    assert.equal(ring.row ? ring.row.separateOrder : false, false);
    assert.equal(view.orderSlots.includes("chapterRing"), false);
    // …and it is NOT integrated on a shared platform, where it is a loose ring
    // in the same box.
    const skx = sourcingView(DEFAULT_BUILD).bundled.find((b) => b.slot === "chapterRing");
    assert.equal(skx.integrated, false);
  });

  test("a bundled slot with no price still gets a line, because that IS the point", () => {
    // A kept crystal has no `ali` block to hang a row on, so `sourcingFor`
    // skips it. Dropping it from the table for want of a price would hide the
    // one fact the reader came for.
    const kept = { ...DEFAULT_BUILD, crystal: KEEP_ID };
    assert.equal(sourcingFor(kept).some((r) => r.slot === "crystal"), false);
    const line = sourcingView(kept).bundled.find((b) => b.slot === "crystal");
    assert.ok(line, "the kept crystal disappeared from the table");
    assert.equal(line.kept, true);
    assert.deepEqual(line.priceUsd, [0, 0]);
    assert.ok(line.name.en && line.name.sv);
    assert.ok(line.note && line.note.en && line.note.sv);
  });

  test("the table never prices a part that was LEFT OUT as included", () => {
    // Both cost nothing, and that is exactly why they have to be told apart on
    // the page: "included" next to a chapter ring nobody is shipping is the
    // same confusion the whole change exists to end.
    const gone = sourcingView({ ...DEFAULT_BUILD, chapterRing: "none" }).bundled
      .find((b) => b.slot === "chapterRing");
    const kept = sourcingView({ ...DEFAULT_BUILD, chapterRing: KEEP_ID }).bundled
      .find((b) => b.slot === "chapterRing");
    assert.equal(gone.omitted, true);
    assert.equal(gone.kept, false);
    assert.equal(kept.omitted, false);
    assert.equal(kept.kept, true);
    // Neither is a parcel, and neither costs anything.
    for (const b of [gone, kept]) assert.deepEqual(b.priceUsd, [0, 0]);
    assert.equal(sourcingView({ ...DEFAULT_BUILD, chapterRing: "none" }).parcels, 4);
  });

  test("every row across the catalogue is either nested under the case or an order", () => {
    for (const cs of CASES) {
      const build = { ...DEFAULT_BUILD, case: cs.id };
      const view = sourcingView(build);
      const nested = new Set(view.bundled.map((b) => b.slot));
      for (const row of sourcingFor(build)) {
        if (row.slot === "case") continue;
        const isNested = nested.has(row.slot);
        const isOrder = view.orderSlots.includes(row.slot) || view.loose.includes(row);
        assert.ok(isNested || isOrder, `${cs.id}/${row.slot} fell out of the table`);
        if (isNested) assert.equal(row.orderWith, "case", `${cs.id}/${row.slot}`);
      }
      assert.ok(view.parcels >= 1, cs.id);
      assert.equal(view.parcels, view.orderSlots.length, cs.id);
    }
  });
});

// ---------------------------------------------------------------------------

describe("prices are written the way the rest of the page writes them", () => {
  test("a band that starts at nothing stays a BAND and says why", () => {
    assert.equal(bandLabel([0, 45], { approx: true, swap: true }), "≈ USD 0–45 (if you swap it)");
    assert.equal(bandLabel([0, 45], { approx: true, swap: true, lang: "sv" }), "≈ USD 0–45 (om du byter ut den)");
    // Never collapsed to one number: the range IS the honesty (docs §2).
    assert.match(bandLabel([0, 30], { swap: true }), /0–30/);
  });

  test("the swap tail is bilingual and is the one the page renders separately", () => {
    // The page draws it as its own element so a 390 px layout can drop the
    // words and keep the number, so both have to come from one string.
    assert.ok(SWAP_SUFFIX.en && SWAP_SUFFIX.sv);
    assert.notEqual(SWAP_SUFFIX.sv, SWAP_SUFFIX.en);
    assert.ok(bandLabel([0, 45], { swap: true }).endsWith(SWAP_SUFFIX.en));
    assert.ok(bandLabel([0, 45], { swap: true, lang: "sv" }).endsWith(SWAP_SUFFIX.sv));
    // A band that does not start at nothing is a real price, not a maybe.
    assert.equal(bandLabel([5, 20], { swap: true }), "USD 5–20");
  });

  test("`approx` carries the site's leading ≈, and a certain price does not", () => {
    assert.equal(bandLabel([5, 20], {}), "USD 5–20");
    assert.equal(bandLabel([5, 20], { approx: true }), "≈ USD 5–20");
    assert.equal(bandLabel([0, 0], {}), "included");
    assert.equal(bandLabel([0, 0], { lang: "sv" }), "ingår");
    assert.equal(bandLabel(null, {}), "");
  });

  test("the table prices the BUNDLE, not the part", () => {
    // The listed band and the band the row contributes are different numbers on
    // a bundled slot, and the table has to show the second.
    const row = sourcingFor(DEFAULT_BUILD).find((r) => r.slot === "crystal");
    assert.ok(row.priceUsd[0] > 0, "the crystal has a real listed floor");
    assert.equal(row.bundlePriceUsd[0], 0, "…which is not what it adds to this build");
    assert.equal(row.bundlePriceUsd[1], row.priceUsd[1]);
    assert.equal(row.bundleApprox, true);
    assert.ok(row.bundleNote && row.bundleNote.en && row.bundleNote.sv);
  });
});

// ---------------------------------------------------------------------------

describe("nothing that already worked moved", () => {
  test("an old eleven-slot permalink decodes to exactly the watch it always did", () => {
    // Minted from the shipped codec before "keep it" existed. Adding a head
    // option must not shift what an existing code means.
    const old =
      "movement:nh35;case:skx007;finish:brushed;insert:ceramic-black;dial:skx-black;" +
      "chapterRing:black-minutes;hands:skx-dive;crystal:dd-sapphire;crown:signed-screw;" +
      "caseback:solid-engraved;strap:oyster";
    const decoded = decodeBuild(old);
    assert.deepEqual(decoded, BASE);
    assert.equal(encodeBuild(decoded), old, "and it re-encodes byte for byte");
    for (const slot of KIT_SLOTS) {
      assert.notEqual(decoded[slot], KEEP_ID, `${slot}: an old link acquired a keep it never had`);
    }
    // A code that says "none" still says "none", not "keep".
    const bare = decodeBuild(old.replace("chapterRing:black-minutes", "chapterRing:none"));
    assert.equal(bare.chapterRing, "none");
    assert.equal(resolveBuild(bare).omitted.chapterRing, true);
  });

  test("a kept slot survives the permalink, and survives a change of case", () => {
    const code = encodeBuild(KEPT);
    assert.deepEqual(decodeBuild(code), KEPT);
    for (const slot of KIT_SLOTS) assert.match(code, new RegExp(`${slot}:${KEEP_ID}`));
    // Opening the same link on a case whose set does not fill a slot must not
    // silently rewrite the build — the picker decides what to OFFER, the codec
    // only carries what was said.
    const moved = normalizeBuild({ ...KEPT, case: "alpinist" });
    assert.equal(moved.insert, KEEP_ID);
    assert.equal(canKeepStock(moved, "insert"), false);
    assert.equal(checkBuild(moved).issues.some((i) => i.level === "error"), false, "and it still builds");
    assert.ok(sourcingView(moved).parcels >= 1);
  });

  test("junk in the keep position degrades to the default, as every unknown id does", () => {
    const junk = normalizeBuild({ ...DEFAULT_BUILD, crown: "stocked", caseback: "stok" });
    assert.equal(junk.crown, DEFAULT_BUILD.crown);
    assert.equal(junk.caseback, DEFAULT_BUILD.caseback);
    // And "stock" on a slot with no box to come out of is not a valid id either.
    assert.equal(normalizeBuild({ ...DEFAULT_BUILD, dial: KEEP_ID }).dial, DEFAULT_BUILD.dial);
  });

  test("the render never has to check for a missing part", () => {
    for (const cs of CASES) {
      const build = normalizeBuild({
        ...DEFAULT_BUILD,
        case: cs.id,
        ...Object.fromEntries(KIT_SLOTS.map((k) => [k, KEEP_ID])),
      });
      const { parts } = resolveBuild(build);
      for (const slot of KIT_SLOTS) {
        assert.ok(parts[slot], `${cs.id}/${slot}: null part`);
        assert.ok(parts[slot].name, `${cs.id}/${slot}: unnamed part`);
      }
      // The geometry fields the renderer reads without checking.
      assert.equal(typeof parts.crystal.dome, "number", cs.id);
      assert.equal(typeof parts.caseback.display, "boolean", cs.id);
      assert.ok(parts.chapterRing.base, cs.id);
      assert.ok(parts.insert.scale, cs.id);
    }
  });
});
