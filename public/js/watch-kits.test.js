// Feedback #59: THE PARTS THAT COME WITH THE CASE.
//
// The report, verbatim: "Bezel insert, crystal, caseback and crown are
// practically never bought separately from the case. Chapter rings are usually
// not bought separately and are integrated with the case. Base everything off
// the available cases online."
//
// This suite pins the DECISION rather than the plumbing. The decision is that
// a mod case is sold as a SET, so the ring of parts around it comes with it on
// one order, and only a part you deliberately name instead of the set's own is
// a purchase of its own. Two things it deliberately does NOT do: it does not
// turn bundling into a gate (an impossible build still draws — docs §5), and
// it does not invent which insert or which crystal a seller drops in the box,
// because nobody publishes that. Where the answer is unknown the price band
// carries a range instead of a made-up split (docs §2).
//
// The catalogue-wide integrity checks live in watch-core.test.js and
// src/watch.test.js; what is here is what feedback #59 changed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CASES,
  PLATFORMS,
  SLOTS,
  SOURCES,
  DEFAULT_BUILD,
  CASE_KITS,
  CASE_KIT_DEFAULT,
  KIT_SLOTS,
  KIT_TIERS,
  caseKit,
  stockPartFor,
  kitBuy,
  kitSummary,
  defaultsForCase,
  normalizeBuild,
  part,
  buildSpec,
  priceBand,
  sourcingFor,
  checkBuild,
  compatibleOptions,
  surpriseBuild,
  encodeBuild,
  decodeBuild,
} from "./watch-core.js";

// Nothing in this feature may reach the network — the same stub src/watch.test.js
// uses, so a fetch smuggled into the sourcing path fails here too.
globalThis.fetch = () => {
  throw new Error("the watch builder must never call out");
};

const BASE = { ...DEFAULT_BUILD };

/**
 * The build a reader gets by picking a case and keeping everything it ships:
 * the three optional slots say "the one the case comes with", and the crown
 * and case back — which have no such option — sit at the case's own default.
 */
function stockBuild(caseId) {
  return normalizeBuild({
    ...BASE,
    case: caseId,
    ...defaultsForCase(caseId),
    insert: "none",
    chapterRing: "none",
    crystal: "none",
  });
}

/** @param {number} seed */
function mkRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ---------------------------------------------------------------------------

describe("feedback #59: a case is sold as a set, not as a bare body", () => {
  test("every case in the catalogue ships a set, and its contents follow the case", () => {
    for (const cs of CASES) {
      const kit = caseKit(cs.id);
      assert.ok(kit.includes.length, `${cs.id}: a case that ships nothing is not a case`);
      for (const key of kit.includes) {
        assert.ok(KIT_SLOTS.includes(key), `${cs.id}: ${key} is not a kit slot`);
        assert.ok(SLOTS.some((s) => s.key === key), `${cs.id}: ${key} is not a slot at all`);
      }
      assert.ok(KIT_TIERS[kit.tier], `${cs.id}: tier "${kit.tier}" has no bilingual label`);
      // Crystal, case back and crown are what make a case a case, so the
      // DERIVATION always includes all three. An explicit per-family override
      // may narrow that — Lucius sells the Explorer II's crown separately —
      // but only against a listing: a narrowing with no `src` is a guess
      // wearing a fact's clothes, which is the one thing this table may not do.
      const narrowed = ["crystal", "caseback", "crown"].filter((k) => !kit.includes.includes(k));
      if (narrowed.length) {
        assert.ok(
          CASE_KITS[cs.id],
          `${cs.id}: only an explicit override may leave out ${narrowed.join(", ")}`,
        );
        assert.ok(
          CASE_KITS[cs.id].src && SOURCES[CASE_KITS[cs.id].src],
          `${cs.id}: leaving out ${narrowed.join(", ")} needs a resolvable source`,
        );
      }
    }
  });

  test("what a set contains is DERIVED from the case, not written out by hand", () => {
    for (const cs of CASES) {
      if (CASE_KITS[cs.id]) continue; // an established listing wins; checked below
      const kit = caseKit(cs.id);
      const plat = PLATFORMS[cs.platform] || PLATFORMS.native;
      assert.equal(
        kit.includes.includes("insert"), cs.bezel === "dive120",
        `${cs.id}: an insert comes with the case exactly when there is a rotating bezel to put it in`,
      );
      // A chapter ring is never a separate purchase: on the shared platforms
      // the set supplies the loose ring, and on a case-specific family it is
      // machined into the case, which is what `integrated` records.
      assert.ok(kit.includes.includes("chapterRing"), `${cs.id}: the ring comes with the case either way`);
      assert.deepEqual(
        kit.integrated, plat.chapterRing ? [] : ["chapterRing"],
        `${cs.id}: whether the ring is loose in the box or part of the case`,
      );
      assert.equal(kit.tier, "case-set");
      // A market convention read off listings is not a published bill of
      // materials, and the flag says so.
      assert.equal(kit.approx, true, `${cs.id}: a derived kit must admit it is approximate`);
      assert.ok(kit.src, `${cs.id}: a derived kit still names where the case came from`);
    }
    // Two worked examples in both directions.
    assert.ok(!caseKit("alpinist").includes.includes("insert"), "no rotating bezel, no insert");
    assert.deepEqual(caseKit("62mas").integrated, ["chapterRing"], "a case-specific family machines it in");
    assert.deepEqual(caseKit("field").integrated, [], "an SKX-platform case supplies a loose ring");
    assert.ok(caseKit("sub").includes.includes("insert"));
  });

  test("the established per-family rows still win over the derivation", () => {
    for (const [id, row] of Object.entries(CASE_KITS)) {
      assert.equal(caseKit(id), row, `${id}: the override table is the answer where it has one`);
    }
  });

  test("a case id the catalogue does not know claims nothing", () => {
    // Fail-soft, like the permalink decoder: a stale or junk id must not make
    // the tool assert that some unknown case ships a crystal.
    assert.equal(caseKit("no-such-case"), CASE_KIT_DEFAULT);
    assert.deepEqual(CASE_KIT_DEFAULT.includes, []);
    assert.equal(kitSummary("no-such-case"), null);
    assert.equal(stockPartFor("no-such-case", "crown"), null);
  });
});

describe("feedback #59: which part is in the box, where that is knowable", () => {
  test("the crown is the one stock part the catalogue can name, and it is derived", () => {
    for (const cs of CASES) {
      const crown = stockPartFor(cs.id, "crown");
      if (!caseKit(cs.id).includes.includes("crown")) {
        // A set that does not ship a crown has no stock crown to name. That is
        // the honest answer, not a hole: the buyer orders one.
        assert.equal(crown, null, `${cs.id}: no crown in the set, so none may be claimed`);
      } else {
        assert.equal(
          crown, cs.crown.signed ? "signed-screw" : "plain-screw",
          `${cs.id}: the stock crown follows the case's own recorded signed flag`,
        );
        assert.ok(part("crown", crown), `${cs.id}: ${crown} must be a real catalogue crown`);
      }
      // Everything else the set includes: unrecorded rather than guessed.
      for (const key of ["insert", "crystal", "caseback", "chapterRing"]) {
        assert.equal(
          stockPartFor(cs.id, key), null,
          `${cs.id}: no source says which ${key} a seller puts in the box, so none may be claimed`,
        );
      }
    }
  });

  test("picking a case carries the crown it is sold with", () => {
    for (const cs of CASES) {
      const stock = stockPartFor(cs.id, "crown");
      // A set with no crown contributes no default: `defaultsForCase` omits
      // the key rather than carrying null, because spreading null would blank
      // the slot instead of leaving the build's own crown alone.
      assert.equal(defaultsForCase(cs.id).crown ?? null, stock, cs.id);
      const buy = kitBuy({ ...BASE, case: cs.id, ...defaultsForCase(cs.id) }, "crown");
      if (!stock) {
        // Lucius sells the Explorer II's crown separately, so it really is a
        // parcel — the table must say so rather than quietly bundling it.
        assert.equal(buy.status, "separate", cs.id);
        assert.equal(buy.separateOrder, true, cs.id);
        continue;
      }
      // ...and where the set does carry it, keeping it is not a purchase.
      assert.equal(buy.status, "included", cs.id);
      assert.equal(buy.separateOrder, false, cs.id);
      assert.deepEqual(buy.priceUsd, [0, 0], cs.id);
    }
  });

  test("naming a different crown IS a separate buy, and says so with certainty", () => {
    const swapped = { ...stockBuild("skx007"), crown: "onion" };
    const buy = kitBuy(swapped, "crown");
    assert.equal(buy.status, "replaces");
    assert.equal(buy.certain, true, "the set's own crown is known, so this is a real swap");
    assert.equal(buy.separateOrder, true);
    assert.deepEqual(buy.priceUsd, part("crown", "onion").ali.priceUsd, "a known swap is priced in full");
    assert.equal(buy.approx, false);
    const row = sourcingFor(swapped).find((r) => r.slot === "crown");
    assert.equal(row.separateOrder, true);
    assert.equal(row.bundle, "replaces");
  });

  test("where the set's own part is unrecorded, the band carries the range rather than a guess", () => {
    const build = { ...stockBuild("skx007"), crystal: "top-hat-sapphire" };
    const buy = kitBuy(build, "crystal");
    assert.equal(buy.status, "replaces");
    assert.equal(buy.certain, false, "nobody publishes which crystal an SKX case set ships");
    assert.equal(buy.approx, true, "an unknown split is flagged approximate, not invented");
    const band = part("crystal", "top-hat-sapphire").ali.priceUsd;
    assert.deepEqual(
      buy.priceUsd, [0, band[1]],
      "keeping the set's own costs nothing; fitting this one costs what it is listed at",
    );
    // Both ends have to be visible in the words as well as the numbers.
    assert.match(buy.note.en, /no listing says which one/);
    assert.match(buy.note.sv, /ingen annons anger vilken/);
  });
});

describe("feedback #59: the sourcing table tells the truth about orders", () => {
  test("a stock build is ONE order for the case, not six", () => {
    for (const cs of CASES) {
      const build = stockBuild(cs.id);
      const rows = sourcingFor(build);
      const orders = rows.filter((r) => r.separateOrder).map((r) => r.slot);
      for (const key of caseKit(cs.id).includes) {
        assert.ok(
          !orders.includes(key),
          `${cs.id}: ${key} comes with the case and must not be listed as its own order`,
        );
      }
      assert.ok(orders.includes("case"), `${cs.id}: the case itself is the order`);
      // What is left is the parts this case's set does not contain. For almost
      // every family that is exactly the case, dial, hands and strap. A part
      // kit adds back whatever its listing leaves out (the Explorer II's crown
      // and chapter ring), and an integrated bracelet takes the strap away —
      // both are the table telling the truth rather than an exception to it.
      const kit = caseKit(cs.id);
      const expected = ["case", "dial", "hands", "chapterRing", "crystal", "caseback", "crown", "insert", "strap"]
        .filter((k) => k === "case" || k === "dial" || k === "hands"
          ? true
          : !kit.includes.includes(k) && stockBuild(cs.id)[k] && stockBuild(cs.id)[k] !== "none");
      assert.deepEqual(orders.slice().sort(), expected.slice().sort(), cs.id);
    }
  });

  test("every bundled row is filed under the case and says why", () => {
    const rows = sourcingFor(BASE);
    const kit = caseKit(BASE.case);
    for (const row of rows) {
      if (!kit.includes.includes(row.slot)) {
        assert.equal(row.includedWithCase, false, `${row.slot} is not in the set`);
        assert.equal(row.bundle, "separate");
        assert.equal(row.orderWith, null);
        assert.equal(row.bundleNote, null);
        continue;
      }
      assert.equal(row.includedWithCase, true, row.slot);
      assert.equal(row.orderWith, "case", row.slot);
      assert.ok(row.bundleNote && row.bundleNote.en && row.bundleNote.sv, `${row.slot} needs a reason`);
    }
    // The case's own row carries what the listing includes, so a table can
    // nest the rest under it.
    const caseRow = rows.find((r) => r.slot === "case");
    assert.deepEqual(caseRow.kit, kit);
    assert.ok(caseRow.kitSummary.en.includes("case kit") || caseRow.kitSummary.en.includes("case set"));
    assert.match(caseRow.kitSummary.sv, /boettsats/);
  });

  test("a part no case ships keeps its own order and its full price", () => {
    for (const slot of ["dial", "hands", "strap"]) {
      const row = sourcingFor(BASE).find((r) => r.slot === slot);
      assert.equal(row.includedWithCase, false, slot);
      assert.equal(row.separateOrder, true, slot);
      assert.deepEqual(row.bundlePriceUsd, row.priceUsd, `${slot} is priced at its listing`);
    }
  });
});

describe("feedback #59: the price band cannot double-count the case", () => {
  test("keeping what the case ships never raises the floor of the band", () => {
    for (const cs of CASES) {
      const stock = stockBuild(cs.id);
      const dear = normalizeBuild({ ...stock, crystal: "top-hat-sapphire", caseback: "display-slim" });
      const a = priceBand(stock);
      const b = priceBand(dear);
      assert.equal(a.low, b.low, `${cs.id}: naming a part the case already ships cannot raise the floor`);
      assert.ok(b.high >= a.high, `${cs.id}: but swapping it in can raise the ceiling`);
      assert.ok(a.low <= a.high, `${cs.id}: a band runs upwards`);
    }
  });

  test("the stock band is the case plus the parts no case ships", () => {
    const stock = stockBuild("skx007");
    const band = priceBand(stock);
    const expect = ["case", "dial", "hands", "strap"]
      .map((k) => part(k, stock[k]).ali.priceUsd)
      .reduce((acc, b) => [acc[0] + b[0], acc[1] + b[1]], [18, 45]); // the movement's own band
    assert.equal(band.low, expect[0], "nothing bundled is added to the floor");
    // The one thing above the floor is the case back, because picking a case
    // hands you the exhibition back where one is listed (an older directive)
    // and no source says the set ships that rather than a solid one. So its
    // ceiling is carried and its floor is not — the range, not a guess.
    const backHigh = part("caseback", stock.caseback).ali.priceUsd[1];
    assert.equal(band.high, expect[1] + backHigh);
  });

  test("a certain swap moves both ends; an uncertain one moves only the ceiling", () => {
    const stock = stockBuild("skx007");
    const base = priceBand(stock);
    const crown = part("crown", "onion").ali.priceUsd;
    const swapped = priceBand(normalizeBuild({ ...stock, crown: "onion" }));
    assert.equal(swapped.low, base.low + crown[0], "a known replacement is a real order");
    assert.equal(swapped.high, base.high + crown[1]);
    const glass = part("crystal", "box-sapphire").ali.priceUsd;
    const guessed = priceBand(normalizeBuild({ ...stock, crystal: "box-sapphire" }));
    assert.equal(guessed.low, base.low, "it may be the one already in the box");
    assert.equal(guessed.high, base.high + glass[1], "or it may not, and then it costs this");
  });

  test("buildSpec carries the kit, its summary and the per-slot verdict", () => {
    const spec = buildSpec(BASE);
    assert.deepEqual(spec.kit, caseKit(BASE.case));
    assert.deepEqual(spec.included, caseKit(BASE.case).includes, "the old field keeps its meaning");
    assert.ok(spec.kitSummary.en && spec.kitSummary.sv);
    for (const key of KIT_SLOTS) {
      assert.ok(["separate", "included", "replaces"].includes(spec.bundled[key]), key);
    }
    assert.equal(spec.bundled.crown, "included", "the default build keeps the SKX007's own signed crown");
    assert.equal(spec.bundled.crystal, "replaces", "and names a double-domed sapphire over whatever ships");
  });
});

describe("feedback #59: bundling is a note, never a gate", () => {
  test("the kit issue is a note, and it never turns an assemblable build into an error", () => {
    for (const cs of CASES) {
      const build = normalizeBuild({ ...BASE, case: cs.id });
      const { ok, issues } = checkBuild(build);
      const mine = issues.filter((i) => /case set|boettsats|sold with|säljs med/.test(i.en + i.sv));
      for (const i of mine) {
        assert.equal(i.level, "note", `${cs.id}: bundling may only ever be a note`);
      }
      // Whatever else the combination does, the kit logic contributed no error.
      const errors = issues.filter((i) => i.level === "error");
      for (const e of errors) {
        assert.ok(!/case set|boettsats/.test(e.en), `${cs.id}: ${e.en}`);
      }
      assert.equal(ok, !errors.length, cs.id);
    }
  });

  test("the note fires when parts replace what is in the box, and not otherwise", () => {
    const stock = stockBuild("skx007");
    const quiet = checkBuild(stock).issues.filter((i) => /case set/.test(i.en));
    assert.equal(quiet.length, 0, "keeping the set's own parts is not worth saying");
    const loud = checkBuild(BASE).issues.filter((i) => /case set/.test(i.en));
    assert.equal(loud.length, 1, "naming three of them is");
    assert.equal(loud[0].level, "note");
    assert.deepEqual(loud[0].slots, ["case"], "a sourcing note must not shadow a fitment issue on a slot");
    assert.match(loud[0].en, /replace what is in the box/);
    assert.match(loud[0].sv, /ersätter det som ligger i lådan/);
  });

  test("every string this feature adds is bilingual and actually translated", () => {
    const seen = [];
    for (const cs of CASES) {
      const summary = kitSummary(cs.id);
      assert.ok(summary && summary.en && summary.sv, cs.id);
      seen.push(summary);
      for (const key of caseKit(cs.id).includes) {
        // Both sides of the fork: the part left as the case ships it, and a
        // named one that would replace it.
        for (const build of [stockBuild(cs.id), normalizeBuild({ ...BASE, case: cs.id })]) {
          const buy = kitBuy(build, key);
          if (!buy.note) continue;
          seen.push(buy.note);
        }
      }
      for (const i of checkBuild(normalizeBuild({ ...BASE, case: cs.id })).issues) seen.push(i);
    }
    assert.ok(seen.length > 50, "the sweep has to actually cover the catalogue");
    for (const s of seen) {
      assert.ok(s.en && s.en.trim(), "an empty English string");
      assert.ok(s.sv && s.sv.trim(), `no Swedish for: ${s.en}`);
      assert.notEqual(s.sv, s.en, `untranslated: ${s.en}`);
    }
  });
});

describe("feedback #59: nothing downstream of the change moved", () => {
  test("an old eleven-slot permalink still resolves to the watch it always did", () => {
    // Minted before feedback #59, by hand from the shipped codec's own output.
    const old =
      "movement:nh35;case:skx007;finish:brushed;insert:ceramic-black;dial:skx-black;" +
      "chapterRing:black-minutes;hands:skx-dive;crystal:dd-sapphire;crown:signed-screw;" +
      "caseback:solid-engraved;strap:oyster";
    const decoded = decodeBuild(old);
    assert.deepEqual(decoded, normalizeBuild(DEFAULT_BUILD));
    assert.equal(encodeBuild(decoded), old, "and it re-encodes byte for byte");
    // It still answers every question the page asks of it.
    assert.equal(checkBuild(decoded).issues.some((i) => i.level === "error"), false);
    assert.ok(buildSpec(decoded).priceUsd.low > 0);
    assert.ok(sourcingFor(decoded).length);
    // A permalink for a family that used to be a "bare body" resolves too, and
    // the kit change cannot have made it unbuildable.
    const bare = decodeBuild(old.replace("case:skx007", "case:62mas"));
    assert.equal(bare.case, "62mas");
    assert.equal(checkBuild(bare).issues.some((i) => i.level === "error"), false);
    assert.ok(priceBand(bare).high > priceBand(bare).low);
    // ...and a junk case in an old link still decodes to something renderable.
    const junk = decodeBuild(old.replace("case:skx007", "case:gone-from-the-catalogue"));
    assert.equal(junk.case, DEFAULT_BUILD.case);
    assert.ok(sourcingFor(junk).length);
  });

  test("compatibleOptions still annotates every slot, and surpriseBuild still assembles", () => {
    for (const slot of SLOTS) {
      const rows = compatibleOptions(slot.key, BASE);
      assert.ok(rows.length, `${slot.key}: no options came back`);
      assert.ok(rows.some((r) => r.compatible), `${slot.key}: nothing is choosable`);
    }
    for (let seed = 1; seed <= 20; seed++) {
      const build = surpriseBuild(mkRand(seed));
      const fit = checkBuild(build);
      assert.equal(fit.ok, true, `seed ${seed}: ${fit.issues.filter((i) => i.level === "error").map((i) => i.en).join(" | ")}`);
      // A surprise is still one order for its case plus the parts no set has.
      const orders = sourcingFor(build).filter((r) => r.separateOrder).map((r) => r.slot);
      for (const key of caseKit(build.case).includes) {
        const buy = kitBuy(build, key);
        if (buy.certain && buy.status === "replaces") continue; // a real swap, correctly its own order
        assert.ok(!orders.includes(key), `seed ${seed}: ${key} came with the case`);
      }
    }
  });
});
