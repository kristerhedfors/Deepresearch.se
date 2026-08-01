// Unit suite for the NHxx builder page's DOM-free logic.
//
// The page itself (public/watch/watch.js) is verified in a browser — that is
// where this project's rendering bugs live. What is pinned here is everything
// the page DECIDES before it touches an element: what the surprise button is
// allowed to hand the user, which options go behind the warning control, which
// spec rows show before the sheet is expanded, and that every string the page
// invents carries Swedish at the same breadth as English (invariant 6).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  NONE_ID,
  BASIC_SPEC_KEYS,
  TEXT_SLOT_MAXLEN,
  slotDef,
  slotIsOptional,
  slotIsText,
  noneOption,
  optionsForSlot,
  annotateOptions,
  localAnnotate,
  groupOptions,
  surpriseBuild,
  pageSurpriseBuild,
  splitSpecRows,
  sanitizeTextValue,
  axisGroupsFor,
  axisGroupsBySlot,
  axisSummary,
  shortAxisName,
  slotForGroup,
} from "./watch-page-core.js";

import {
  SLOTS,
  AXIS_SLOTS,
  DEFAULT_BUILD,
  MOVEMENTS,
  slotOptions,
  normalizeBuild,
  checkBuild,
  encodeBuild,
  decodeBuild,
} from "./watch-core.js";

/** A deterministic stand-in for Math.random, so a failure is reproducible. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------

describe("surprise me never hands the user a broken build (feedback #57)", () => {
  test("2000 surprise builds all pass checkBuild", () => {
    const rand = seeded(20260730);
    for (let i = 0; i < 2000; i++) {
      const b = surpriseBuild(rand);
      const { ok, issues } = checkBuild(b);
      assert.equal(
        ok,
        true,
        `broken surprise build ${encodeBuild(b)}: ${issues.filter((x) => x.level === "error").map((x) => x.en).join(" | ")}`,
      );
    }
  });

  test("a surprise build is a complete, normalised build", () => {
    const b = surpriseBuild(seeded(7));
    for (const slot of SLOTS) assert.ok(typeof b[slot.key] === "string" && b[slot.key], `${slot.key} missing`);
    assert.deepEqual(b, normalizeBuild(b));
  });

  test("it round-trips through the permalink codec unchanged", () => {
    const rand = seeded(99);
    for (let i = 0; i < 200; i++) {
      const b = surpriseBuild(rand);
      assert.deepEqual(decodeBuild(encodeBuild(b)), b);
    }
  });

  // The next two hold the PAGE's own picker to a quality bar. They deliberately
  // call pageSurpriseBuild rather than surpriseBuild: the public entry point
  // prefers the catalogue's implementation when one exists, and what is being
  // pinned here is the reasoning this file owns.
  test("it actually varies — it is not just returning the default build", () => {
    const rand = seeded(4242);
    const seen = new Set();
    for (let i = 0; i < 300; i++) seen.add(encodeBuild(pageSurpriseBuild(rand)));
    assert.ok(seen.size > 100, `only ${seen.size} distinct builds in 300 draws`);
    assert.ok(!seen.has(encodeBuild(DEFAULT_BUILD)) || seen.size > 1);
  });

  test("the SHIPPED button reaches every movement — validity alone is not a surprise", () => {
    // The catalogue also ships a surpriseBuild. Everything it returns is valid,
    // but measured over 3000 draws it returned the NH35 every time: it judges
    // each slot against a build whose later slots are still at their defaults,
    // so a movement whose default dial clashes is rejected on step one. This
    // pins the entry point the button actually calls, whichever way it routes.
    const rand = seeded(20260731);
    const seen = new Set();
    for (let i = 0; i < 1200; i++) seen.add(surpriseBuild(rand).movement);
    for (const mv of MOVEMENTS) assert.ok(seen.has(mv.id), `the button never offers ${mv.id}`);
  });

  test("it reaches every movement, so the guarantee is not bought by pinning one", () => {
    // The first version of this picker judged each pick against a build whose
    // undecided slots sat at their defaults, and the default dial has a date
    // window — so the two no-date movements were rejected on step one and
    // "surprise me" silently never offered them. That is what this pins.
    const rand = seeded(31337);
    const seen = new Set();
    for (let i = 0; i < 1500; i++) seen.add(pageSurpriseBuild(rand).movement);
    for (const mv of MOVEMENTS) {
      assert.ok(seen.has(mv.id), `surprise me never picked ${mv.id}`);
    }
  });

  test("every case and every dial in the catalogue is reachable", () => {
    const rand = seeded(600613);
    const cases = new Set();
    const dials = new Set();
    for (let i = 0; i < 4000; i++) {
      const b = pageSurpriseBuild(rand);
      cases.add(b.case);
      dials.add(b.dial);
    }
    assert.equal(cases.size, slotOptions("case").length, "some cases are unreachable");
    assert.equal(dials.size, slotOptions("dial").length, "some dials are unreachable");
  });

  test("a degenerate random source still produces a valid build", () => {
    // rand() pinned at one value walks the same greedy path every time; the
    // guarantee has to survive that, not just a well-behaved generator.
    for (const value of [0, 0.5, 0.999999]) {
      const b = surpriseBuild(() => value);
      assert.equal(checkBuild(b).ok, true, `rand()=${value} produced ${encodeBuild(b)}`);
    }
    // And a non-function argument must not throw.
    assert.equal(checkBuild(surpriseBuild(/** @type {any} */ (null))).ok, true);
  });
});

// ---------------------------------------------------------------------------

describe("the compatibility-annotated picker (feedback #56)", () => {
  test("every option is returned, never filtered away", () => {
    for (const slot of SLOTS) {
      const rows = annotateOptions(slot.key, DEFAULT_BUILD);
      const ids = rows.map((r) => r.option.id);
      assert.equal(new Set(ids).size, ids.length, `${slot.key} listed an option twice`);
      for (const opt of optionsForSlot(slot.key)) {
        assert.ok(ids.includes(opt.id), `${slot.key}: ${opt.id} was dropped from the picker`);
      }
    }
  });

  test("every row is well formed: a boolean verdict and a bilingual reason when it clashes", () => {
    for (const slot of SLOTS) {
      for (const mv of MOVEMENTS) {
        for (const row of annotateOptions(slot.key, { ...DEFAULT_BUILD, movement: mv.id })) {
          assert.equal(typeof row.compatible, "boolean", `${slot.key}/${row.option.id}`);
          if (!row.compatible) {
            assert.ok(row.why && row.why.en && row.why.sv, `${slot.key}/${row.option.id} clashes with no reason`);
            assert.notEqual(row.why.en.trim(), "", `${slot.key}/${row.option.id} empty EN reason`);
            assert.notEqual(row.why.sv.trim(), "", `${slot.key}/${row.option.id} empty SV reason`);
          }
        }
      }
    }
  });

  test("the day-date movement puts every non-day dial behind the warning", () => {
    const rows = annotateOptions("dial", { ...DEFAULT_BUILD, movement: "nh36" });
    const { fits, clashes } = groupOptions(rows);
    assert.ok(fits.length >= 1, "the NH36 must have at least one dial that fits");
    assert.ok(clashes.length >= 1, "and dials that do not");
    for (const r of fits) assert.equal(!!r.option.day, true, `${r.option.id} has no day window`);
    for (const r of clashes) assert.equal(!!r.option.day, false, `${r.option.id} does have a day window`);
  });

  test("the GMT movement puts every three-hand set behind the warning", () => {
    const { fits, clashes } = groupOptions(annotateOptions("hands", { ...DEFAULT_BUILD, movement: "nh34" }));
    assert.ok(fits.length >= 1 && clashes.length >= 1);
    for (const r of fits) assert.equal(!!r.option.gmt, true);
    for (const r of clashes) assert.equal(!!r.option.gmt, false);
  });

  test("a compatible option really is compatible: clicking an un-warned chip keeps the build valid", () => {
    // The whole promise of the picker. Start from a build that is already valid
    // (the picker guarantees that), then click every un-warned chip in every
    // slot and assert the build is still valid. Pinned against localAnnotate,
    // which is this file's own reasoning.
    const rand = seeded(515151);
    /** @type {Record<string, Record<string,string>>} */
    const bases = {};
    for (let i = 0; i < 4000 && Object.keys(bases).length < MOVEMENTS.length; i++) {
      const b = pageSurpriseBuild(rand);
      if (!bases[b.movement]) bases[b.movement] = b;
    }
    assert.equal(Object.keys(bases).length, MOVEMENTS.length, "no valid base build for every movement");
    for (const [mvId, base] of Object.entries(bases)) {
      assert.equal(checkBuild(base).ok, true);
      for (const slot of SLOTS) {
        for (const row of groupOptions(localAnnotate(slot.key, base)).fits) {
          if (row.option.id === NONE_ID) continue; // the catalogue's job, not the annotator's
          const trial = normalizeBuild({ ...base, [slot.key]: row.option.id });
          const errs = checkBuild(trial).issues.filter((i) => i.level === "error");
          assert.equal(
            errs.length,
            0,
            `${mvId}/${slot.key}: "${row.option.id}" was offered without a warning but errors: ${errs[0] && errs[0].en}`,
          );
        }
      }
    }
  });

  test("a build already broken elsewhere does not poison unrelated slots", () => {
    // NH34 under the default three-hand set is an error in the HANDS slot. An
    // unrelated slot may still have clashes of its own — what it must never do
    // is inherit THAT sentence, which is what a naive "does checkBuild error?"
    // annotator would do to every option in every slot.
    const broken = { ...DEFAULT_BUILD, movement: "nh34" };
    const handsErr = checkBuild(broken).issues.find((i) => i.level === "error" && i.slot === "hands");
    assert.ok(handsErr, "the fixture no longer produces a hands error");
    for (const key of ["strap", "crown", "caseback", "finish", "case"]) {
      const { fits, clashes } = groupOptions(localAnnotate(key, broken));
      assert.ok(fits.length > 0, `${key} was wholly poisoned by the hands error`);
      for (const r of clashes) {
        assert.notEqual(r.why && r.why.en, handsErr.en, `${key}/${r.option.id} inherited the hands error`);
      }
    }
  });

  test("annotation is total — junk in, a usable list out", () => {
    for (const junk of [null, undefined, {}, { movement: "nope" }, /** @type {any} */ ("x")]) {
      const rows = annotateOptions("dial", junk);
      assert.ok(Array.isArray(rows) && rows.length > 0, String(junk));
    }
    assert.deepEqual(annotateOptions("not-a-slot", DEFAULT_BUILD), []);
    assert.deepEqual(groupOptions(/** @type {any} */ (null)), { fits: [], clashes: [] });
  });
});

// ---------------------------------------------------------------------------

describe("optional slots (feedback #56)", () => {
  test("an optional slot offers 'none' first; a mandatory one offers exactly the catalogue", () => {
    for (const slot of SLOTS) {
      const opts = optionsForSlot(slot.key);
      if (slotIsOptional(slot.key)) {
        assert.equal(opts[0].id, NONE_ID, `${slot.key} is optional but offers no "none"`);
        assert.equal(opts.length, slotOptions(slot.key).length + (slotOptions(slot.key).some((o) => o.id === NONE_ID) ? 0 : 1));
      } else {
        assert.deepEqual(opts, slotOptions(slot.key), `${slot.key} grew an option it should not have`);
      }
    }
  });

  test("choosing 'none' in an optional slot survives normalisation and the permalink", () => {
    // Only meaningful once the catalogue marks slots optional; until then there
    // is nothing to assert and the loop is empty by construction.
    for (const slot of SLOTS) {
      if (!slotIsOptional(slot.key)) continue;
      const build = normalizeBuild({ ...DEFAULT_BUILD, [slot.key]: NONE_ID });
      assert.equal(build[slot.key], NONE_ID, `${slot.key}: "none" was normalised away`);
      assert.deepEqual(decodeBuild(encodeBuild(build)), build, `${slot.key}: "none" did not survive the permalink`);
      // And the picker still has something to draw for every slot while a part
      // is left out — the annotator absorbs a catalogue that trips over a null
      // part rather than handing the page an empty list.
      for (const other of SLOTS) {
        assert.ok(
          annotateOptions(other.key, build).length > 0 || slotIsText(other.key),
          `${other.key} had no options with ${slot.key} left out`,
        );
      }
    }
  });

  test("the page's own 'none' label is bilingual for every slot, known or not", () => {
    for (const key of [...SLOTS.map((s) => s.key), "some-future-slot"]) {
      const opt = noneOption(key);
      assert.equal(opt.id, NONE_ID);
      assert.ok(opt.name.en && opt.name.sv, `${key}: none option is not bilingual`);
      assert.ok(opt.blurb.en && opt.blurb.sv, `${key}: none blurb is not bilingual`);
      assert.notEqual(opt.name.en, opt.name.sv, `${key}: the SV label is the EN one`);
      assert.notEqual(opt.blurb.en, opt.blurb.sv, `${key}: the SV blurb is the EN one`);
    }
  });

  test("slotDef / slotIsOptional / slotIsText never throw on an unknown slot", () => {
    assert.equal(slotDef("nope"), null);
    assert.equal(slotIsOptional("nope"), false);
    assert.equal(slotIsText("nope"), false);
  });
});

// ---------------------------------------------------------------------------

describe("the spec sheet's basic/expanded split (feedback #56)", () => {
  const rows = [
    { key: "dia" }, { key: "l2l" }, { key: "thick" }, { key: "lugW" },
    { key: "dial" }, { key: "crystal" }, { key: "insert" }, { key: "crown" },
    { key: "wr" }, { key: "mvt" }, { key: "bph" }, { key: "reserve" },
    { key: "tubes" }, { key: "stack" }, { key: "price" },
  ];

  test("the basic set is the handful a buyer reads first, in that order", () => {
    const { basic } = splitSpecRows(rows);
    assert.deepEqual(basic.map((r) => r.key), BASIC_SPEC_KEYS);
  });

  test("nothing is lost — every row lands in exactly one of the two groups", () => {
    const { basic, more } = splitSpecRows(rows);
    assert.equal(basic.length + more.length, rows.length);
    const all = new Set([...basic, ...more].map((r) => r.key));
    for (const r of rows) assert.ok(all.has(r.key), `${r.key} vanished`);
    for (const r of more) assert.ok(!BASIC_SPEC_KEYS.includes(r.key));
  });

  test("the split is small enough to be a summary and large enough to be useful", () => {
    assert.ok(BASIC_SPEC_KEYS.length >= 4 && BASIC_SPEC_KEYS.length <= 7);
  });

  test("splitSpecRows is total", () => {
    assert.deepEqual(splitSpecRows(/** @type {any} */ (null)), { basic: [], more: [] });
    assert.deepEqual(splitSpecRows([]), { basic: [], more: [] });
  });
});

// ---------------------------------------------------------------------------

describe("the fine tuning is addressed to its part (feedback #59)", () => {
  test("every group that applies lands under a real part slot", () => {
    // The defect #59 reported was DISCOVERABILITY: dial colour, dial finish,
    // index style and strap colour all shipped, and all of them sat under one
    // "Fine tuning" heading at the foot of the picker, detached from the part
    // they modify. Nothing may be left there that belongs to a part.
    const { bySlot, orphans } = axisGroupsBySlot(DEFAULT_BUILD);
    assert.deepEqual(orphans, [], `unfiled groups: ${orphans.map((g) => g.id).join(", ")}`);
    const keys = new Set(SLOTS.map((s) => s.key));
    for (const key of Object.keys(bySlot)) assert.ok(keys.has(key), `${key} is not a part slot`);
  });

  test("nothing is lost or duplicated on the way from axisGroupsFor", () => {
    for (const mv of MOVEMENTS) {
      const build = normalizeBuild({ ...DEFAULT_BUILD, movement: mv.id });
      const flat = axisGroupsFor(build);
      const { bySlot, orphans } = axisGroupsBySlot(build);
      const placed = [...Object.values(bySlot).flat(), ...orphans];
      assert.equal(placed.length, flat.length, `${mv.id}: group count changed`);
      assert.deepEqual(
        placed.map((g) => g.id).sort(),
        flat.map((g) => g.id).sort(),
        `${mv.id}: a group changed identity`,
      );
    }
  });

  test("the words the reporter went looking for are the ones on the summary", () => {
    // "color, style (sunburst excetera), indices … And strap, I need to be able
    // to choose strap color." Each of those has to be readable with nothing
    // opened, in both languages.
    const { bySlot } = axisGroupsBySlot(DEFAULT_BUILD);
    const textOf = (slotKey, lang) =>
      (bySlot[slotKey] || [])
        .flatMap((g) => axisSummary(g, DEFAULT_BUILD).items.map((i) => i.label[lang]))
        .join(" · ")
        .toLowerCase();

    const dialEn = textOf("dial", "en");
    for (const word of ["colour", "finish", "index style", "lume"]) {
      assert.ok(dialEn.includes(word), `the dial summary never says "${word}": ${dialEn}`);
    }
    const dialSv = textOf("dial", "sv");
    for (const word of ["färg", "finish", "indexstil", "lysmassa"]) {
      assert.ok(dialSv.includes(word), `urtavlans sammanfattning saknar "${word}": ${dialSv}`);
    }
    assert.ok(textOf("strap", "en").includes("colour"), "the strap summary never says colour");
    assert.ok(textOf("strap", "sv").includes("färg"), "bandets sammanfattning saknar färg");
  });

  test("a summary names every variable inside its group, bilingually", () => {
    for (const g of axisGroupsFor(DEFAULT_BUILD)) {
      const { items } = axisSummary(g, DEFAULT_BUILD);
      assert.equal(items.length, g.axes.length + g.texts.length, `${g.id}: a variable went unnamed`);
      for (const item of items) {
        assert.ok(item.label.en.trim(), `${g.id}/${item.key}: empty EN label`);
        assert.ok(item.label.sv.trim(), `${g.id}/${item.key}: empty SV label`);
      }
    }
  });

  test("a variable the user has moved shows its value; an untouched one does not", () => {
    const plain = axisSummary(axisGroupsBySlot(DEFAULT_BUILD).bySlot.dial[0], DEFAULT_BUILD);
    assert.equal(plain.setCount, 0, "an untouched build reports a chosen variable");
    for (const item of plain.items) assert.equal(item.value, null);

    const colour = slotOptions("dialColor").find((o) => o.id !== "as-listed");
    const build = normalizeBuild({ ...DEFAULT_BUILD, dialColor: colour.id });
    assert.equal(build.dialColor, colour.id, "the fixture no longer sets the axis");
    const moved = axisSummary(axisGroupsBySlot(build).bySlot.dial[0], build);
    const row = moved.items.find((i) => i.key === "dialColor");
    assert.ok(row && row.set, "a chosen dial colour is not marked");
    assert.equal(row.value.en, colour.name.en);
    assert.equal(row.value.sv, colour.name.sv);
    assert.equal(moved.setCount, 1);
  });

  test("shortAxisName drops the subject in BOTH languages, never to nothing", () => {
    for (const axis of AXIS_SLOTS) {
      const group = axis.group || "other";
      const short = shortAxisName(axis, group);
      assert.ok(short.en.trim(), `${axis.key}: EN short name is empty`);
      assert.ok(short.sv.trim(), `${axis.key}: SV short name is empty`);
      assert.ok(short.en.length <= axis.name.en.length, `${axis.key}: EN grew`);
      assert.ok(short.sv.length <= axis.name.sv.length, `${axis.key}: SV grew`);
      // Whatever the trim does, the first character is upper case in both.
      assert.equal(short.en[0], short.en[0].toLocaleUpperCase(), `${axis.key}: EN not capitalised`);
      assert.equal(short.sv[0], short.sv[0].toLocaleUpperCase(), `${axis.key}: SV not capitalised`);
    }
    assert.deepEqual(shortAxisName({ key: "dialColor", name: { en: "Dial colour", sv: "Urtavlans färg" } }, "dial"), {
      en: "Colour",
      sv: "Färg",
    });
    // An unknown group leaves the name alone rather than guessing at it.
    assert.deepEqual(shortAxisName({ name: { en: "Dial colour", sv: "Urtavlans färg" } }, "nope"), {
      en: "Dial colour",
      sv: "Urtavlans färg",
    });
  });

  test("placement, summarising and shortening are all total", () => {
    assert.equal(slotForGroup(/** @type {any} */ (null)), null);
    assert.equal(slotForGroup({ id: "not-a-group" }), null);
    assert.equal(slotForGroup({ id: "x", axes: [{ over: "dial" }] }), "dial");
    assert.deepEqual(shortAxisName(/** @type {any} */ (null)), { en: "", sv: "" });
    assert.deepEqual(axisSummary(/** @type {any} */ ({}), null), { items: [], setCount: 0 });
    for (const junk of [null, undefined, {}, { movement: "nope" }]) {
      const { bySlot, orphans } = axisGroupsBySlot(/** @type {any} */ (junk));
      assert.ok(Object.keys(bySlot).length > 0 || orphans.length > 0, String(junk));
    }
  });
});

// ---------------------------------------------------------------------------

describe("free-text slots keep the permalink codec intact", () => {
  test("the codec's separators can never reach a build value", () => {
    // encodeBuild joins `key:value` with `;`, so either character in a typed
    // value would split into nonsense on the way back.
    for (const raw of ["Rolex; Oyster: Perpetual", "a;b", "x:y", ";;;", ":::"]) {
      const clean = sanitizeTextValue(raw);
      assert.ok(!clean.includes(";"), raw);
      assert.ok(!clean.includes(":"), raw);
    }
  });

  test("it trims, collapses whitespace, strips control characters and bounds the length", () => {
    assert.equal(sanitizeTextValue("  My   Brand  "), "My Brand");
    assert.equal(sanitizeTextValue("a\u0000b\u001fc\u007f"), "abc");
    assert.equal(sanitizeTextValue("two\nlines"), "twolines");
    assert.equal(sanitizeTextValue("x".repeat(200)).length, TEXT_SLOT_MAXLEN);
    assert.equal(sanitizeTextValue(null), "");
    assert.equal(sanitizeTextValue(undefined), "");
  });

  test("it leaves ordinary dial text — including Swedish letters — alone", () => {
    assert.equal(sanitizeTextValue("SEIKO"), "SEIKO");
    assert.equal(sanitizeTextValue("Automatisk Ångström"), "Automatisk Ångström");
  });

  test("a sanitised value round-trips through the permalink for any text slot", () => {
    for (const slot of SLOTS) {
      if (!slotIsText(slot.key)) continue;
      const value = sanitizeTextValue("Djupforskning Ångström");
      const build = normalizeBuild({ ...DEFAULT_BUILD, [slot.key]: value });
      assert.deepEqual(decodeBuild(encodeBuild(build)), build, `${slot.key} did not survive the permalink`);
    }
  });
});
