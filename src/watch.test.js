// The watch builder's server façade: the endpoint, not the catalogue.
//
// The catalogue, the compatibility rules and the geometry are the core's own
// suite (public/js/watch-core.test.js), and src/facade-contract.test.js already
// proves the re-exports here ARE the core's functions rather than copies. What
// is left, and what this file covers, is the HTTP surface: the four shapes
// GET /api/watch/catalog answers in, its caching, its 404s, and — the one that
// matters most — that it never reaches the network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { handleWatchCatalog, CASES, SLOTS, DEFAULT_BUILD, encodeBuild } from "./watch.js";

/** @param {string} qs */
const call = (qs) => handleWatchCatalog(new URL(`https://deepresearch.se/api/watch/catalog${qs}`));
/** @param {Response} r */
const body = (r) => r.json();

describe("GET /api/watch/catalog", () => {
  test("the bare call returns the whole pre-indexed catalogue", async () => {
    const res = call("");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    const j = await body(res);
    assert.equal(j.cases.length, CASES.length);
    assert.equal(j.slots.length, SLOTS.length);
    assert.deepEqual(j.movement.handTubes, { hour: 1.5, minute: 0.9, second: 0.2 });
    assert.equal(j.movement.dialDia, 28.5);
    assert.ok(j.parts.dial.length > 0 && j.parts.hands.length > 0);
    assert.ok(j.brands.length > 0);
    assert.ok(j.sources.dlw && j.sources.dlw.url);
    assert.deepEqual(j.defaultBuild, DEFAULT_BUILD);
    // The honesty note travels with the payload, not just with the docs.
    assert.match(j.note, /approx/);
    assert.match(j.note, /never contacts aliexpress\.com/);
  });

  test("every case row carries dimensions, a source and buyable links", async () => {
    const j = await body(call(""));
    for (const c of j.cases) {
      assert.ok(c.dims.dia > 0 && c.dims.l2l > 0, c.id);
      assert.ok(c.src, `${c.id} has no source`);
      assert.ok(c.ali.links.length > 0, `${c.id} has no search links`);
      for (const l of c.ali.links) {
        assert.match(l.url, /^https:\/\/www\.aliexpress\.com\/w\/wholesale-[a-z0-9-]+\.html$/);
      }
    }
  });

  test("?case= narrows to one case and includes its platform", async () => {
    const j = await body(call("?case=skx007"));
    assert.equal(j.case.id, "skx007");
    assert.equal(j.case.dims.dia, 42.5);
    assert.equal(j.platform.id, "skx");
    assert.deepEqual(j.platform.insert, { od: 38, id: 31.8 });
    assert.ok(j.case.blurb.en && j.case.blurb.sv);
  });

  test("?case= with an unknown id 404s and says what exists", async () => {
    const res = call("?case=rolex-daytona");
    assert.equal(res.status, 404);
    const j = await res.json();
    assert.ok(Array.isArray(j.cases) && j.cases.includes("skx007"));
  });

  test("?slot= returns one parts family", async () => {
    const j = await body(call("?slot=dial"));
    assert.equal(j.slot, "dial");
    assert.ok(j.options.some((o) => o.id === "skx-black"));
  });

  test("?slot= with an unknown key 404s and lists the slots", async () => {
    const res = call("?slot=bezel");
    assert.equal(res.status, 404);
    const j = await res.json();
    assert.ok(j.slots.includes("insert"));
  });

  test("?build= answers the whole page's question without the page", async () => {
    const j = await body(call(`?build=${encodeURIComponent(encodeBuild(DEFAULT_BUILD))}`));
    assert.equal(j.build.case, "skx007");
    assert.equal(j.spec.caseDia, 42.5);
    assert.equal(j.fit.ok, true);
    assert.ok(j.sourcing.length >= 8);
    assert.equal(j.code, encodeBuild(DEFAULT_BUILD));
  });

  test("?build= reports an unbuildable combination rather than refusing it", async () => {
    // The endpoint mirrors the page's posture: an impossible build still
    // resolves, with the problems listed beside it.
    const bad = encodeBuild({ ...DEFAULT_BUILD, movement: "nh36", dial: "skx-black" });
    const res = call(`?build=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.fit.ok, false);
    assert.ok(j.fit.issues.some((i) => i.level === "error"));
    assert.ok(j.fit.issues.every((i) => i.en && i.sv));
  });

  test("a junk ?build= degrades to the default rather than erroring", async () => {
    for (const code of ["", "%%%", "case:nope", "a:b;c:d"]) {
      const res = call(`?build=${encodeURIComponent(code)}`);
      assert.equal(res.status, 200);
      const j = await res.json();
      for (const slot of SLOTS) assert.ok(j.build[slot.key], `${code}: ${slot.key} unfilled`);
    }
  });

  test("the endpoint never performs a fetch", async () => {
    // The AliExpress index is a curated SEARCH index, not a scrape: this
    // endpoint builds aliexpress.com URLs as strings and must never call one.
    // If that ever changes, a visitor's build starts leaving the server.
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      throw new Error("the watch catalogue must not make outbound requests");
    };
    try {
      await body(call(""));
      await body(call("?case=62mas"));
      await body(call("?slot=hands"));
      await body(call(`?build=${encodeURIComponent(encodeBuild(DEFAULT_BUILD))}`));
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls, 0);
  });

  test("the response carries no identity, cookie or account field", async () => {
    const res = call("");
    assert.equal(res.headers.get("set-cookie"), null);
    // Keys, not substrings: a source URL ending in "movement-guide" contains
    // "uid" and means nothing. What would matter is a FIELD named for a user.
    const forbidden = /^(email|session|uid|user|identity|account|cookie|token|ip)$/i;
    const walk = (v, path) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      for (const k of Object.keys(v)) {
        assert.ok(!forbidden.test(k), `payload carries a ${k} field at ${path}`);
        walk(v[k], `${path}.${k}`);
      }
    };
    walk(await res.json(), "$");
  });
});

// ===========================================================================
// The 2026-07-30 catalogue pass (feedback #56 and #57). Appended as its own
// block so parallel work on the geometry half merges cleanly.
//
// What it covers is the half of the builder that is DATA: the dial decomposed
// into orthogonal axes, the date and day wheels as separate parts, the
// per-family caseback truth, the optionality of the parts a case often ships
// with, the strap axes, and the two functions the page is built against —
// compatibleOptions() and surpriseBuild(). The rules it asserts are the ones
// the research established; the numbers are the ones with a source.

import {
  SOURCES,
  AXIS_SLOTS,
  ALL_SLOTS,
  TEXT_FIELDS,
  PLATFORMS,
  DIALS,
  DIAL_DESIGNS,
  DIAL_COLOURS,
  DIAL_FINISHES,
  DIAL_CONSTRUCTIONS,
  DIAL_INDEX_STYLES,
  DIAL_CALENDARS,
  DIAL_DIAMETERS,
  DIAL_FEET,
  DIAL_PRINTS,
  DIAL_LUME_OPTIONS,
  DIAL_SPEC,
  DAY_DATE_APERTURE,
  DATE_WHEELS,
  DAY_WHEELS,
  DAY_WHEEL_LANGUAGES,
  INSERTS,
  INSERT_MATERIALS,
  INSERT_PROFILES,
  CRYSTALS,
  CRYSTAL_EDGES,
  CRYSTAL_ARS,
  CHAPTER_RINGS,
  CHAPTER_PRINTINGS,
  CROWNS,
  CROWN_TEXTURES,
  CASEBACKS,
  CASEBACK_ENGRAVINGS,
  CASEBACK_FINISHES,
  STRAPS,
  BRACELET_TYPES,
  RUBBER_TYPES,
  LEATHER_TYPES,
  NATO_PATTERNS,
  NATO_WEAVES,
  NATO_LAYERS,
  STRAP_COLOURS,
  STITCH_COLOURS,
  HARDWARE_FINISHES,
  BUCKLES,
  SHEEN_LEVELS,
  WRIST_HOLDER,
  STRAP_EXIT,
  LUMES,
  CASE_KITS,
  slotOptions,
  noneOption,
  part,
  caseKit,
  displayBackFor,
  defaultsForCase,
  normalizeBuild,
  resolveBuild,
  checkBuild,
  compatibleOptions,
  surpriseBuild,
  buildSpec,
  sourcingFor,
  decodeBuild,
} from "./watch.js";

/** Every table in the catalogue, for the sweeps that must cover all of them. */
const TABLES = {
  DIALS, DIAL_DESIGNS, DIAL_COLOURS, DIAL_FINISHES, DIAL_CONSTRUCTIONS,
  DIAL_INDEX_STYLES, DIAL_CALENDARS, DIAL_DIAMETERS, DIAL_FEET, DIAL_PRINTS,
  DIAL_LUME_OPTIONS, DATE_WHEELS, DAY_WHEELS, DAY_WHEEL_LANGUAGES,
  INSERTS, INSERT_MATERIALS, INSERT_PROFILES,
  CRYSTALS, CRYSTAL_EDGES, CRYSTAL_ARS,
  CHAPTER_RINGS, CHAPTER_PRINTINGS,
  CROWNS, CROWN_TEXTURES,
  CASEBACKS, CASEBACK_ENGRAVINGS, CASEBACK_FINISHES,
  STRAPS, BRACELET_TYPES, RUBBER_TYPES, LEATHER_TYPES,
  NATO_PATTERNS, NATO_WEAVES, NATO_LAYERS,
  STRAP_COLOURS, STITCH_COLOURS, HARDWARE_FINISHES, BUCKLES, SHEEN_LEVELS,
};

/** A build with every axis at its default. */
const BASE = normalizeBuild(DEFAULT_BUILD);

// ---------------------------------------------------------------------------

describe("the catalogue's own honesty rules", () => {
  test("invariant 6: every catalogue entry carries both languages", () => {
    // Swedish at the same breadth as English, mechanically. A half-translated
    // entry is the easiest thing in the world to let through by hand.
    const visit = (obj, path) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) return obj.forEach((v, i) => visit(v, `${path}[${i}]`));
      const keys = Object.keys(obj);
      if (keys.includes("en") || keys.includes("sv")) {
        assert.ok(typeof obj.en === "string" && obj.en.trim(), `${path} has no EN`);
        assert.ok(typeof obj.sv === "string" && obj.sv.trim(), `${path} has no SV`);
        return;
      }
      for (const k of keys) visit(obj[k], `${path}.${k}`);
    };
    for (const [name, table] of Object.entries(TABLES)) {
      assert.ok(table.length > 0, `${name} is empty`);
      for (const row of table) {
        assert.ok(row.id, `${name} row without an id`);
        assert.ok(row.name && row.name.en && row.name.sv, `${name}/${row.id} name`);
        visit(row, `${name}/${row.id}`);
      }
    }
    for (const axis of AXIS_SLOTS) {
      visit(axis.name, `axis/${axis.key}`);
      if (axis.asListed) visit(axis.asListed, `axis/${axis.key}.asListed`);
    }
    for (const field of TEXT_FIELDS) visit(field.name, `text/${field.key}`);
    visit(DAY_DATE_APERTURE.note, "aperture.note");
    visit(WRIST_HOLDER.note, "holder.note");
    visit(STRAP_EXIT.note, "strapExit.note");
    for (const [id, kit] of Object.entries(CASE_KITS)) assert.ok(Array.isArray(kit.includes), id);
  });

  test("invariant 6: every compatibility reason is bilingual and actually translated", () => {
    const seen = new Set();
    let count = 0;
    for (const slot of ALL_SLOTS) {
      for (const row of compatibleOptions(slot.key, BASE)) {
        if (!row.why) continue;
        count++;
        assert.ok(row.why.en && row.why.en.trim(), `${slot.key}/${row.option.id} EN reason`);
        assert.ok(row.why.sv && row.why.sv.trim(), `${slot.key}/${row.option.id} SV reason`);
        assert.notEqual(row.why.en, row.why.sv, `${slot.key}/${row.option.id} reason is untranslated`);
        seen.add(row.why.en);
      }
    }
    assert.ok(count > 20, `only ${count} annotated options — the sweep is not reaching the rules`);
    assert.ok(seen.size >= 5, "the sweep should surface several distinct reasons");
  });

  test("no dimension is invented: every millimetre names a source", () => {
    // The rule the whole file rests on. Anything whose key reads as a
    // measurement has to say where it came from.
    const isMeasurement = (k) => /Mm$|^thickness|^pitch|^taper|^wire|^flutes$|^depth$/.test(k);
    for (const [name, table] of Object.entries(TABLES)) {
      for (const row of table) {
        const measured = Object.keys(row).filter((k) => isMeasurement(k) && row[k] != null);
        if (!measured.length) continue;
        assert.ok(row.src, `${name}/${row.id} quotes ${measured.join(", ")} with no src`);
        assert.ok(SOURCES[row.src], `${name}/${row.id} names unknown source ${row.src}`);
      }
    }
    assert.ok(SOURCES[DIAL_SPEC.src] && DIAL_SPEC.approx === false);
    assert.ok(SOURCES[WRIST_HOLDER.src]);
  });

  test("every source id a table row names actually exists", () => {
    for (const [name, table] of Object.entries(TABLES)) {
      for (const row of table) {
        if (row.src) assert.ok(SOURCES[row.src], `${name}/${row.id} → ${row.src}`);
        for (const also of row.srcAlso || []) assert.ok(SOURCES[also], `${name}/${row.id} → ${also}`);
      }
    }
  });

  test("the machine-generated marketplace \"wiki\" articles are not cited anywhere", () => {
    // They carry outright false claims — one calls the NH36 a Seagull running
    // at 28,800 vph when it is a Seiko Instruments movement at 21,600 — so a
    // src pointing at one quietly poisons the no-invented-millimetres rule
    // that every other number in this file depends on.
    for (const [id, source] of Object.entries(SOURCES)) {
      assert.ok(!/wiki-ssr/.test(source.url), `${id} cites a generated wiki article`);
      for (const host of ["skyrimwrist", "usamodwatch", "rotatewatches"]) {
        assert.ok(!source.url.includes(host), `${id} cites ${host}, flagged as generated content`);
      }
    }
    // And the one claim that used to rest on such a page now RANKS rather than
    // measures, because no manufacturer publishes a figure for Hardlex.
    const hardlex = part("crystal", "domed-hardlex");
    assert.equal(hardlex.approx, true);
    assert.match(hardlex.note.en, /Seiko publishes no hardness number/);
    assert.match(hardlex.note.sv, /publicerar inget hårdhetsvärde/);
    assert.ok(!/HV/.test(hardlex.note.en.replace("HV figures", "")));
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: the dial is a product of axes, not one fixed atom", () => {
  test("every dial declares the nine axes it is a combination of", () => {
    const has = (table, id) => table.some((r) => r.id === id);
    for (const d of DIALS) {
      assert.ok(has(DIAL_DESIGNS, d.design), `${d.id} design ${d.design}`);
      assert.ok(has(DIAL_COLOURS, d.colour), `${d.id} colour ${d.colour}`);
      assert.ok(has(DIAL_FINISHES, d.finishId), `${d.id} finish ${d.finishId}`);
      assert.ok(has(DIAL_CONSTRUCTIONS, d.construction), `${d.id} construction`);
      assert.ok(has(DIAL_INDEX_STYLES, d.indices), `${d.id} indices`);
      assert.ok(has(DIAL_CALENDARS, d.calendar), `${d.id} calendar ${d.calendar}`);
      assert.ok(has(DIAL_DIAMETERS, d.diameter), `${d.id} diameter`);
      assert.ok(has(DIAL_FEET, d.feet), `${d.id} feet`);
      assert.ok(LUMES[d.lume], `${d.id} lume`);
    }
  });

  test("the axes are ORTHOGONAL: a finish crosses designs, a colour crosses finishes", () => {
    // The structural finding the decomposition exists for. "Sunburst" is sold
    // on sub dials, sandwich dials and dress dials alike, so a catalogue that
    // makes "sunburst black sub dial" one atomic option cannot say what the
    // market actually sells.
    const designsWithSunburst = new Set(DIALS.filter((d) => d.finishId === "sunburst").map((d) => d.design));
    assert.ok(designsWithSunburst.size >= 3, "sunburst must appear across several designs");
    const finishesOnBlack = new Set(DIALS.filter((d) => d.colour === "black").map((d) => d.finishId));
    assert.ok(finishesOnBlack.size >= 3, "black must appear in several finishes");
    // Sandwich is CONSTRUCTION, not finish: a vendor sells "sunburst sandwich",
    // so the two have to be able to co-exist on one dial.
    const sandwich = DIALS.find((d) => d.construction === "sandwich");
    assert.ok(sandwich);
    assert.equal(sandwich.finishId, "sunburst");
  });

  test("an axis override changes the dial the renderer is handed", () => {
    const plain = resolveBuild(BASE).parts.dial;
    assert.equal(plain.base, "#0d0f12");
    const recoloured = resolveBuild({ ...BASE, dialColor: "green" }).parts.dial;
    assert.equal(recoloured.base, DIAL_COLOURS.find((c) => c.id === "green").hex);
    // ...and the legacy shading bucket the renderer switches on still resolves.
    const refinished = resolveBuild({ ...BASE, dialFinish: "fume" }).parts.dial;
    assert.equal(refinished.finish, "fume");
    assert.equal(refinished.finishId, "fume");
    const guilloche = resolveBuild({ ...BASE, dialFinish: "guilloche" }).parts.dial;
    assert.equal(guilloche.finish, "textured", "a new finish must still map to a bucket the renderer paints");
  });

  test("the calendar axis rewrites the dial's date and day windows", () => {
    const none = resolveBuild({ ...BASE, dialCalendar: "none" }).parts.dial;
    assert.equal(none.date, null);
    assert.equal(none.day, false);
    const dayDate = resolveBuild({ ...BASE, dialCalendar: "day-date-3" }).parts.dial;
    assert.equal(dayDate.day, true);
    assert.equal(dayDate.date, "3");
    // ...and the compatibility engine sees the rewritten dial, not the listing.
    assert.equal(checkBuild({ ...BASE, movement: "nh36", dialCalendar: "day-date-3" }).ok, true);
    assert.equal(checkBuild({ ...BASE, movement: "nh35", dialCalendar: "day-date-3" }).ok, false);
  });

  test("the surfaces that are physically 3D are marked, and the flat ones are not", () => {
    const relief = (id) => resolveBuild({ ...BASE, dial: id }).parts.dial.relief;
    assert.equal(relief("sandwich-black"), "recessed");
    assert.equal(relief("openheart"), "pierced");
    assert.equal(relief("sunburst-blue"), "flat");
    assert.equal(relief("fume-grey"), "flat");
    assert.equal(DIAL_FINISHES.find((f) => f.id === "sunburst").relief, "flat");
    assert.equal(DIAL_FINISHES.find((f) => f.id === "meteorite").relief, "flat");
    // Anything claimed as relief on inference rather than a source says so.
    for (const f of DIAL_FINISHES) {
      if (f.relief && f.relief !== "flat") assert.ok(f.reliefApprox || f.src, `${f.id} relief unsourced`);
    }
  });

  test("oversize dials are listed but only fit cases built around them", () => {
    const big = DIAL_DIAMETERS.find((d) => d.id === "31-8");
    assert.ok(big.mm > 28.5 && big.approx === true);
    const r = checkBuild({ ...BASE, dialDiameter: "31-8" });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === "error" && i.slots.includes("dial")));
    for (const plat of Object.values(PLATFORMS)) assert.equal(plat.dialDia, 28.5);
  });

  test("dial feet are a real fitment axis, with the drawing's own dimensions", () => {
    const four = DIAL_FEET.find((f) => f.id === "feet4");
    assert.equal(four.feet, 4);
    assert.equal(four.footDiaMm, DIAL_SPEC.footDiaMm);
    assert.equal(four.footLengthMm, DIAL_SPEC.footLengthMm);
    const glue = checkBuild({ ...BASE, dialFeet: "glue" });
    assert.ok(glue.issues.some((i) => i.level === "note" && i.slots.includes("dialFeet")));
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: custom dial text, and sterile as a real choice", () => {
  test("all four text slots are optional and sterile is the default", () => {
    assert.deepEqual(TEXT_FIELDS.filter((f) => f.group === "dialText").map((f) => f.key),
      ["textLogo", "text12", "text6a", "text6b"]);
    assert.equal(BASE.dialPrint, undefined, "the default build carries no print method at all");
    const dial = resolveBuild(BASE).parts.dial;
    assert.equal(dial.printMethod, "sterile");
    assert.deepEqual(dial.text, []);
    assert.equal(dial.customText, null);
    // And sterile is a product in the catalogue, not merely the absence of one.
    assert.ok(DIALS.some((d) => d.design === "sterile-plain"));
  });

  test("setting the text slots puts them on the dial with the chosen method", () => {
    const build = normalizeBuild({
      ...BASE,
      dialPrint: "pad-print",
      textLogo: "NORDVIK",
      text12: "Automatic",
      text6a: "200m",
    });
    const dial = resolveBuild(build).parts.dial;
    assert.equal(dial.printMethod, "pad-print");
    assert.deepEqual(dial.text, ["NORDVIK", "Automatic", "200m"]);
    assert.equal(dial.customText.logo, "NORDVIK");
    assert.equal(dial.customText.method, "pad-print");
    // The vendor-stated limit is surfaced rather than assumed away.
    const issue = checkBuild(build).issues.find((i) => i.slots.includes("dialPrint"));
    assert.ok(issue);
    assert.match(issue.en, /trademark/i);
    assert.match(issue.sv, /varumärke/i);
  });

  test("laser marking is not the same look as pad printing", () => {
    const laser = DIAL_PRINTS.find((p) => p.id === "laser-mark");
    assert.match(laser.note.en, /metallic grey/);
    assert.equal(DIAL_PRINTS.find((p) => p.id === "applied-logo").relief, "raised");
  });

  test("dial text survives a permalink, and cannot break the codec", () => {
    // The codec is `key:value;key:value`, so a colon or semicolon in free text
    // would corrupt every field after it.
    const build = normalizeBuild({ ...BASE, dialPrint: "pad-print", textLogo: "A:B;C DIVER" });
    assert.ok(!build.textLogo.includes(":"));
    assert.ok(!build.textLogo.includes(";"));
    const round = decodeBuild(encodeBuild(build));
    assert.equal(round.textLogo, build.textLogo);
    assert.equal(round.dialPrint, "pad-print");
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: the date wheel is a separate part", () => {
  test("the disc and its text are chosen together, from verified combinations", () => {
    // The finding this rests on: the date disc is not a dial property, it is a
    // part you buy and swap 1:1 onto the movement, listed by disc and text.
    assert.ok(AXIS_SLOTS.some((a) => a.key === "dateWheel"));
    const white = DATE_WHEELS.find((w) => w.id === "white-black");
    const black = DATE_WHEELS.find((w) => w.id === "black-white");
    assert.equal(white.disc, "#f2f4f7");
    assert.equal(white.text, "#15181c");
    assert.equal(black.disc, "#111318");
    assert.equal(black.text, "#f2f5fa");
    // Provenance: the two Seiko part numbers.
    assert.equal(white.seikoPart, "0148 141");
    assert.equal(black.seikoPart, "0148 142");
    for (const w of DATE_WHEELS) {
      assert.match(w.disc, /^#[0-9a-f]{6}$/i, w.id);
      assert.match(w.text, /^#[0-9a-f]{6}$/i, w.id);
    }
  });

  test("a date wheel needs a date movement and a day wheel needs the NH36", () => {
    assert.equal(checkBuild({ ...BASE, movement: "nh70", dialCalendar: "none", dateWheel: "black-white" }).ok, false);
    assert.equal(checkBuild({ ...BASE, dateWheel: "black-white" }).ok, true);
    const dayOnNh35 = checkBuild({ ...BASE, dayWheel: "kanji-black-3" });
    assert.equal(dayOnNh35.ok, false);
    assert.ok(dayOnNh35.issues.some((i) => i.slots.includes("dayWheel") && i.level === "error"));
  });

  test("the day wheel carries language, and only the ones sold as NHxx parts", () => {
    const langs = new Set(DAY_WHEELS.map((w) => w.language));
    assert.deepEqual([...langs].sort(), ["arabic", "en-es", "hanzi", "kanji"]);
    assert.deepEqual(DAY_WHEEL_LANGUAGES.map((l) => l.id).sort(), ["arabic", "en-es", "hanzi", "kanji"]);
    // French, German, Danish and Roman numerals are documented for finished
    // Seiko 5s but were NOT found as purchasable mod discs, so they are absent.
    for (const missing of ["french", "german", "danish", "roman"]) {
      assert.ok(!langs.has(missing), `${missing} is not verified as a purchasable NHxx disc`);
    }
  });

  test("the day wheel is pre-aligned to a crown position and the date wheel is not", () => {
    // The one asymmetry between the two discs, and it constrains the CASE.
    const dayDate = { ...BASE, movement: "nh36", dial: "daydate-black" };
    // The SKX007 has its crown at 4, so a 3 o'clock day wheel reads rotated.
    const mismatched = checkBuild({ ...dayDate, dayWheel: "kanji-black-3" });
    assert.ok(mismatched.issues.some((i) => i.slots.includes("dayWheel") && i.level === "warning"));
    const matched = checkBuild({ ...dayDate, dayWheel: "kanji-black-4" });
    assert.ok(!matched.issues.some((i) => i.slots.includes("dayWheel") && i.level === "warning"));
    // The date wheel has no such constraint — it swaps 1:1.
    for (const w of DATE_WHEELS) assert.equal(w.crownAlign, undefined, w.id);
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: the day-date aperture", () => {
  test("the arrangement is stated ONCE, as sourced fact", () => {
    assert.equal(DAY_DATE_APERTURE.inboard, "day");
    assert.equal(DAY_DATE_APERTURE.resolved, true);
    assert.equal(DAY_DATE_APERTURE.layout, "pillar-box");
    assert.ok(SOURCES[DAY_DATE_APERTURE.src].url.endsWith(".pdf"), "the source is the manufacturer's drawing");
  });

  test("the cut-outs are the manufacturer's own dimensions", () => {
    const dd = DAY_DATE_APERTURE.dayDate;
    const d = DAY_DATE_APERTURE.dateOnly;
    assert.deepEqual([dd.widthMm, dd.heightMm, dd.centreFromDialCentreMm], [7.0, 2.0, 8.45]);
    assert.deepEqual([d.widthMm, d.heightMm, d.centreFromDialCentreMm], [2.9, 2.0, 10.55]);
    assert.equal(dd.approx, false);
    assert.equal(d.approx, false);
    // The geometric proof of day-inboard, asserted rather than described: the
    // two windows share an OUTER edge, so all the extra width goes inboard.
    assert.ok(Math.abs(dd.outerMm - d.outerMm) <= 0.06, "the two windows share an outer edge");
    assert.ok(dd.innerMm < d.innerMm, "the day-date box extends inboard, not outboard");
    // Sanity against the dial itself: the window has to sit inside it.
    assert.ok(dd.outerMm < DIAL_SPEC.diaMm / 2);
    assert.equal(DIAL_SPEC.diaMm, 28.5);
  });

  test("the two cells never overlap and the day cell is the wider one", () => {
    const { dayWidthShare, gapShare, dateWidthShare } = DAY_DATE_APERTURE;
    assert.ok(Math.abs(dayWidthShare + gapShare + dateWidthShare - 1) < 0.02, "the shares must fill the window");
    assert.ok(gapShare > 0, "there must be a visible gap — clipping is the reported bug");
    assert.ok(dayWidthShare > dateWidthShare, "three letters need more room than two digits");
    // Those three are the only figures here that came off a photograph.
    assert.equal(DAY_DATE_APERTURE.sharesApprox, true);
  });

  test("the spec sheet reports the aperture the chosen calendar implies", () => {
    assert.equal(buildSpec({ ...BASE, movement: "nh36", dial: "daydate-black" }).aperture.widthMm, 7.0);
    assert.equal(buildSpec(BASE).aperture.widthMm, 2.9);
    assert.equal(buildSpec({ ...BASE, movement: "nh70", dial: "62mas-cream" }).aperture, null);
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: casebacks", () => {
  test("the exhibition back is the default exactly where one was found listed", () => {
    for (const id of ["skx007", "srp-turtle", "samurai", "tuna", "skx013"]) {
      assert.equal(displayBackFor(id), true, id);
      assert.equal(defaultsForCase(id).caseback, "display", id);
    }
    // ...and NOT where the research found none. Defaulting these to exhibition
    // would be inventing a part nobody sells.
    for (const id of ["willard", "alpinist", "explorer", "field"]) {
      assert.equal(displayBackFor(id), null, id);
      assert.equal(defaultsForCase(id).caseback, "solid-brushed", id);
    }
    const warned = checkBuild({ ...BASE, case: "willard", caseback: "display" });
    assert.ok(warned.issues.some((i) => i.slots.includes("caseback") && i.level === "warning"));
  });

  test("an engraved back is a DECAL on the solid shape, not its own geometry", () => {
    // The likely root cause of "engraved caseback isn't working": it is
    // dimensionally identical to a plain solid back and differs only in relief
    // artwork, so if it has a mesh of its own that is the bug.
    const engraved = resolveBuild({ ...BASE, caseback: "solid-engraved" }).parts.caseback;
    const plain = resolveBuild({ ...BASE, caseback: "solid-brushed" }).parts.caseback;
    assert.equal(engraved.geometry, "solid");
    assert.equal(plain.geometry, "solid");
    assert.equal(engraved.heightDeltaMm, plain.heightDeltaMm);
    assert.equal(engraved.display, false);
    assert.equal(resolveBuild({ ...BASE, caseback: "display" }).parts.caseback.geometry, "display");
    // The artwork is an axis over the solid part, with real listed designs.
    const ids = CASEBACK_ENGRAVINGS.map((e) => e.id);
    for (const design of ["sword", "explorer", "serpent", "skull", "robocop"]) assert.ok(ids.includes(design));
    const custom = resolveBuild({ ...BASE, casebackEngraving: "custom-text", casebackText: "For Elin" }).parts.caseback;
    assert.equal(custom.engravingText, "For Elin");
    assert.equal(custom.geometry, "solid");
  });

  test("a display back adds the one published height delta and nothing else does", () => {
    assert.equal(part("caseback", "display").heightDeltaMm, 0.6);
    assert.equal(part("caseback", "solid-brushed").heightDeltaMm, 0);
    const solid = buildSpec({ ...BASE, caseback: "solid-brushed" });
    const display = buildSpec({ ...BASE, caseback: "display" });
    assert.ok(Math.abs(display.backMm - solid.backMm - 0.6) < 1e-9);
    assert.ok(display.stackMm > solid.stackMm);
  });

  test("the display back's spacer fork is a real error on an NH build", () => {
    // Two SKUs that are not interchangeable: one for the thicker black OEM
    // spacer, one for the thinner grey NH spacer. Every movement here is an NH.
    const wrong = checkBuild({ ...BASE, caseback: "display-oem" });
    assert.equal(wrong.ok, false);
    assert.ok(wrong.issues.some((i) => i.slots.includes("caseback") && i.slots.includes("movement")));
    assert.equal(checkBuild({ ...BASE, caseback: "display" }).ok, true);
    assert.equal(part("caseback", "display").spacerFit, "grey-nh");
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: nothing is mandatory that a case may already ship", () => {
  test("the three optional slots accept \"none\", and part() answers null for it", () => {
    const optional = SLOTS.filter((s) => s.optional).map((s) => s.key);
    assert.deepEqual(optional, ["insert", "chapterRing", "crystal"]);
    for (const key of optional) {
      assert.equal(part(key, "none"), null, `${key}: "none" is not an option object`);
      assert.equal(normalizeBuild({ ...BASE, [key]: "none" })[key], "none", `${key} must keep "none"`);
      assert.ok(noneOption(key).name.en && noneOption(key).name.sv, `${key} none needs a bilingual label`);
      // ...and nothing downstream ever meets a null part.
      const { parts, omitted } = resolveBuild({ ...BASE, [key]: "none" });
      assert.equal(omitted[key], true);
      assert.ok(parts[key] && parts[key].id === "none");
    }
    assert.equal(buildSpec({ ...BASE, crystal: "none" }).omitted.crystal, true);
  });

  test("optionality falls out of what the case ships with, not a special case", () => {
    // The better model: every case carries what is in its box, so a part is
    // free when it is included and priced when it is not.
    assert.deepEqual(caseKit("skx007").includes.slice().sort(),
      ["caseback", "chapterRing", "crown", "crystal", "insert"]);
    assert.deepEqual(caseKit("62mas").includes, [], "a bare body ships gaskets and a click spring");
    // Same case, a dearer crystal: free on a complete kit, priced on a bare body.
    const kitCheap = buildSpec({ ...BASE, case: "skx007", crystal: "domed-hardlex" });
    const kitDear = buildSpec({ ...BASE, case: "skx007", crystal: "top-hat-sapphire" });
    assert.equal(kitDear.priceUsd.high, kitCheap.priceUsd.high, "a crystal the case ships with adds nothing");
    const bareCheap = buildSpec({ ...BASE, case: "62mas", crystal: "domed-hardlex" });
    const bareDear = buildSpec({ ...BASE, case: "62mas", crystal: "top-hat-sapphire" });
    assert.ok(bareDear.priceUsd.high > bareCheap.priceUsd.high, "a separately bought crystal is priced");
    const rows = sourcingFor({ ...BASE, case: "skx007" });
    assert.equal(rows.find((r) => r.slot === "crystal").includedWithCase, true);
    assert.equal(sourcingFor({ ...BASE, case: "62mas" }).find((r) => r.slot === "crystal").includedWithCase, false);
  });

  test("the chapter ring is genuinely MANDATORY on the SKX013 platform", () => {
    // Not a free choice: without it the dial sits too low and the hands do not
    // clear. This is the warning case the whole dropdown pattern exists for.
    assert.equal(PLATFORMS.skx013.chapterRingRequired, true);
    const bad = checkBuild({ ...BASE, case: "skx013", chapterRing: "none" });
    assert.equal(bad.ok, false);
    const issue = bad.issues.find((i) => i.slots.includes("chapterRing"));
    assert.equal(issue.level, "error");
    assert.match(issue.en, /hands will not clear/);
    assert.match(issue.sv, /visarna går inte fria/);
    // Elsewhere it is allowed, with the consequence spelled out.
    const soft = checkBuild({ ...BASE, case: "skx007", chapterRing: "none" });
    assert.equal(soft.ok, true);
    assert.equal(soft.issues.find((i) => i.slots.includes("chapterRing")).level, "warning");
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: crystals and inserts", () => {
  test("a flat crystal is genuinely flat, and the bevel is an option on the rim", () => {
    // The correction the feedback named: every flat sapphire sold for these
    // cases has a planar top face. The only relief is at the rim, and vendors
    // sell both variants as separate SKUs.
    const flat = resolveBuild({ ...BASE, crystal: "flat-sapphire" }).parts.crystal;
    assert.equal(flat.profile, "flat");
    assert.equal(flat.dome, 0, "a flat crystal must not revolve a dome");
    assert.equal(flat.topFacePlanar, true);
    assert.equal(resolveBuild({ ...BASE, crystal: "domed-hardlex" }).parts.crystal.dome, 0);
    const domed = resolveBuild({ ...BASE, crystal: "dd-sapphire" }).parts.crystal;
    assert.ok(domed.dome > 0);
    assert.equal(domed.topFacePlanar, false);
    // The chamfer is a straight cut whose width nobody publishes.
    assert.equal(CRYSTAL_EDGES.find((e) => e.id === "bevel").approx, true);
    assert.equal(CRYSTAL_EDGES.find((e) => e.id === "none").chamferMm, 0);
  });

  test("R1: a crystal cut for one insert profile warns under the other", () => {
    // The #1 real trap: crystal vendors name SKUs after the insert they pair
    // with, because a sloped insert intrudes 0.9 mm further inward.
    const r = checkBuild({ ...BASE, insertProfile: "flat", crystalEdge: "stepped" });
    const issue = r.issues.find((i) => i.slots.includes("crystal") && i.slots.includes("insert"));
    assert.ok(issue, "a stepped crystal over a flat insert must warn");
    assert.match(issue.en, /step or gap/);
    assert.match(issue.sv, /steg eller en glipa/);
    // Matched profiles are silent.
    assert.ok(!checkBuild({ ...BASE, insertProfile: "sloped", crystalEdge: "stepped" }).issues
      .some((i) => i.slots.includes("crystal") && i.slots.includes("insert")));
    // The published mechanism: the difference is entirely the INNER diameter.
    const p = PLATFORMS.skx.insertProfiles;
    assert.equal(p.flat.od, p.sloped.od);
    assert.ok(p.sloped.id < p.flat.id);
    assert.ok(Math.abs((p.flat.id - p.sloped.id) - 0.9) < 1e-9);
  });

  test("insert material carries the thickness, and the disputed one carries its range", () => {
    const alu = INSERT_MATERIALS.find((m) => m.id === "aluminium");
    assert.deepEqual(alu.thicknessRangeMm, [0.7, 1.0]);
    assert.equal(alu.approx, true);
    assert.equal(INSERT_MATERIALS.find((m) => m.id === "ceramic").thicknessMm, 1.0);
    assert.equal(INSERT_MATERIALS.find((m) => m.id === "steel").thicknessMm, 0.9);
    const swapped = resolveBuild({ ...BASE, insertMaterial: "steel" }).parts.insert;
    assert.equal(swapped.material, "steel");
    assert.equal(swapped.thicknessMm, 0.9);
    // A tachymeter insert is NOT offered on these dive platforms — none found.
    for (const i of INSERTS) assert.notEqual(i.scale, "tachymeter");
  });

  test("the SKX013 crystal is 28 mm — not the 28.5 mm that is the DIAL", () => {
    assert.equal(PLATFORMS.skx013.crystalDia, 28);
    assert.equal(PLATFORMS.skx013.dialDia, 28.5);
    assert.match(PLATFORMS.skx013.note.en, /28\.5 mm is the DIAL diameter/);
    assert.equal(PLATFORMS.srp.crystalDia, 32);
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: straps", () => {
  test("bracelet types differ in the two things that actually distinguish them", () => {
    // Links across the width and their cross-section. Rendered as one flat box
    // an Oyster and a Jubilee are identical, which was the reported bug.
    const by = (id) => BRACELET_TYPES.find((b) => b.id === id);
    assert.equal(by("oyster").linksAcross, 3);
    assert.equal(by("oyster").crossSection, "flat");
    assert.equal(by("jubilee").linksAcross, 5);
    assert.equal(by("jubilee").crossSection, "rounded");
    assert.equal(by("president").linksAcross, 3);
    assert.equal(by("president").crossSection, "semi-circular");
    assert.equal(by("beads-of-rice").linksAcross, 7);
    assert.equal(by("engineer-ii").taperMm, 0, "the Engineer II genuinely does not taper");
    // A shorter pitch means more hinges, which is what makes a jubilee drape.
    assert.ok(by("jubilee").pitchMm < by("oyster").pitchMm);
    assert.equal(by("milanese").linksAcross, 0, "mesh is woven wire, not links");
    assert.ok(by("shark-mesh").wireMm > by("milanese").wireMm);
    // Per-link widths are published nowhere, so every ratio says it is a convention.
    for (const b of BRACELET_TYPES) {
      if (!b.widthRatios) continue;
      assert.equal(b.ratiosApprox, true, `${b.id} ratios must be flagged`);
      assert.ok(Math.abs(b.widthRatios.reduce((a, x) => a + x, 0) - 1) < 0.01, b.id);
      assert.equal(b.widthRatios.length, b.linksAcross, b.id);
    }
  });

  test("leather comes in real types, and NONE of them renders as a mirror", () => {
    // The direct fix for "leather shouldn't be shiny like a mirror".
    const scale = SHEEN_LEVELS.map((s) => s.id);
    assert.deepEqual(scale, ["matte", "satin", "shiny", "glossy"]);
    assert.ok(LEATHER_TYPES.length >= 12);
    for (const t of LEATHER_TYPES) {
      assert.ok(scale.includes(t.sheen), `${t.id} sheen ${t.sheen}`);
      if (t.sheen === "glossy") assert.equal(t.id, "patent", "only patent is high-gloss");
      assert.notEqual(t.sheen, "shiny", `${t.id} should not be shiny`);
    }
    // Suede and nubuck have NO specular at all — the firmly sourced part.
    for (const id of ["suede", "nubuck"]) {
      assert.equal(LEATHER_TYPES.find((t) => t.id === id).specular, 0, id);
    }
    const strap = resolveBuild({ ...BASE, strap: "leather", leatherType: "suede" }).parts.strap;
    assert.equal(strap.sheen, "matte");
    assert.equal(strap.specular, 0);
    assert.equal(strap.grain, "nap");
  });

  test("stitch colour is its own axis, with its own pitch", () => {
    assert.ok(STITCH_COLOURS.some((s) => s.id === "none"));
    assert.ok(STITCH_COLOURS.some((s) => s.id === "tonal"));
    const strap = resolveBuild({ ...BASE, strap: "leather", strapStitch: "red" }).parts.strap;
    assert.equal(strap.stitch, "red");
    assert.equal(strap.stitchColor, "#9d2029");
    assert.ok(strap.stitchPitchMm > 1.5 && strap.stitchPitchMm < 2.2);
  });

  test("both Bond NATOs ship, because the popular one is not the real one", () => {
    const grey = NATO_PATTERNS.find((p) => p.id === "bond-grey");
    const original = NATO_PATTERNS.find((p) => p.id === "bond-1964");
    assert.ok(grey && original);
    assert.match(grey.note.en, /NOT the strap worn in Goldfinger/);
    assert.match(original.note.en, /nine stripes/);
    assert.match(original.note.sv, /nio ränder/);
    const strap = resolveBuild({ ...BASE, strap: "nato", natoPattern: "bond-1964" }).parts.strap;
    assert.equal(strap.pattern, "bond-1964");
    assert.ok(Array.isArray(strap.stripes) && strap.stripes.length > 2);
  });

  test("NATO weave and construction change the mesh, not just the label", () => {
    const standard = resolveBuild({ ...BASE, strap: "nato" }).parts.strap;
    assert.equal(standard.thicknessMm, 1.25);
    assert.equal(standard.sheen, "matte");
    assert.equal(standard.rings, 5);
    assert.equal(standard.underFlap, true);
    const seatbelt = resolveBuild({ ...BASE, strap: "nato", natoWeave: "seatbelt", natoLayers: "single-pass" }).parts.strap;
    assert.equal(seatbelt.thicknessMm, 1.4);
    assert.equal(seatbelt.sheen, "satin", "seatbelt is the slightly shiny one");
    assert.equal(seatbelt.rings, 3);
    assert.equal(seatbelt.underFlap, false);
    assert.equal(standard.lengthMm, 290);
    assert.equal(standard.sizingHoles, 13);
  });

  test("a strap axis that belongs to another kind is an error, not a silent no-op", () => {
    const r = checkBuild({ ...BASE, strap: "leather", braceletType: "jubilee" });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.slots.includes("braceletType") && i.slots.includes("strap")));
    assert.equal(checkBuild({ ...BASE, strap: "oyster", braceletType: "president" }).ok, true);
  });

  test("a curved-end rubber strap is moulded for one case profile", () => {
    const wrong = checkBuild({ ...BASE, case: "alpinist", strap: "waffle", rubberType: "curved-end" });
    assert.ok(wrong.issues.some((i) => i.slots.includes("strap") && i.level === "warning"));
    assert.equal(RUBBER_TYPES.find((r) => r.id === "curved-end").caseSpecific, true);
  });

  test("the buckle knows which strap kind it goes on", () => {
    assert.ok(BUCKLES.every((b) => Array.isArray(b.kinds) && b.kinds.length));
    assert.equal(checkBuild({ ...BASE, strap: "leather", buckle: "v-clasp" }).ok, false);
    assert.equal(checkBuild({ ...BASE, strap: "leather", buckle: "butterfly" }).ok, true);
    // The wrist holder and the exit angle the geometry needs, both flagged.
    assert.ok(WRIST_HOLDER.radiusMm >= 25 && WRIST_HOLDER.radiusMm <= 27.5);
    assert.equal(WRIST_HOLDER.material, "suede");
    assert.equal(WRIST_HOLDER.lengthApprox, true);
    assert.ok(STRAP_EXIT.degrees > 20 && STRAP_EXIT.degrees < 40);
    assert.equal(STRAP_EXIT.standoffApprox, true);
  });

  test("strap colours say which kinds they were found listed for", () => {
    for (const c of STRAP_COLOURS) {
      assert.ok(Array.isArray(c.kinds) && c.kinds.length, c.id);
      assert.ok(["very-common", "common", "uncommon", "rare"].includes(c.rarity), c.id);
    }
    assert.ok(STRAP_COLOURS.some((c) => c.id === "teal" && c.kinds.includes("nato")));
    assert.ok(HARDWARE_FINISHES.some((h) => h.id === "pvd-black"));
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56 item 7 + #57: the two functions the page is built on", () => {
  test("compatibleOptions RETURNS incompatible options rather than hiding them", () => {
    // The requested philosophy, stated as a property: a dial that cannot go on
    // the chosen movement still appears, behind a warning symbol, with a reason.
    const onNh36 = compatibleOptions("dial", { ...BASE, movement: "nh36" });
    assert.equal(onNh36.length, slotOptions("dial").length, "nothing may be filtered out");
    const dateOnly = onNh36.find((o) => o.option.id === "skx-black");
    assert.equal(dateOnly.compatible, false);
    assert.ok(dateOnly.why.en && dateOnly.why.sv);
    const dayDate = onNh36.find((o) => o.option.id === "daydate-black");
    assert.equal(dayDate.compatible, true);
    assert.equal(dayDate.why, null);
  });

  test("every slot and every axis answers the same shape", () => {
    for (const slot of ALL_SLOTS) {
      const rows = compatibleOptions(slot.key, BASE);
      const expected = slotOptions(slot.key).length + (slot.optional ? 1 : 0);
      assert.equal(rows.length, expected, slot.key);
      for (const row of rows) {
        assert.ok(row.option && row.option.id, slot.key);
        assert.equal(typeof row.compatible, "boolean", slot.key);
        if (row.why === null) assert.equal(row.level, null, `${slot.key}/${row.option.id}`);
        else assert.ok(["error", "warning"].includes(row.level), `${slot.key}/${row.option.id}`);
        if (row.compatible === false) assert.equal(row.level, "error", `${slot.key}/${row.option.id}`);
      }
      // At least one option in every slot must be choosable, or the UI dead-ends.
      assert.ok(rows.some((r) => r.compatible), `${slot.key} has no compatible option at all`);
    }
    assert.deepEqual(compatibleOptions("no-such-slot", BASE), []);
  });

  test("compatibleOptions is honest about the OPTIONAL none choice", () => {
    const rings = compatibleOptions("chapterRing", { ...BASE, case: "skx013" });
    const none = rings.find((r) => r.option.id === "none");
    assert.ok(none, "an optional slot must offer none");
    assert.equal(none.compatible, false, "on the SKX013 it is not a free choice");
    const onSkx = compatibleOptions("chapterRing", { ...BASE, case: "skx007" }).find((r) => r.option.id === "none");
    assert.equal(onSkx.compatible, true);
    assert.equal(onSkx.level, "warning", "allowed, with the consequence stated");
  });

  test("feedback #57: surpriseBuild never pairs incompatible parts", () => {
    // A deterministic sequence stands in for Math.random so this is a real
    // assertion rather than a lucky one.
    for (let seed = 1; seed <= 60; seed++) {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      const build = surpriseBuild(rand);
      const fit = checkBuild(build);
      assert.equal(
        fit.ok, true,
        `seed ${seed}: ${fit.issues.filter((i) => i.level === "error").map((i) => i.en).join(" | ")}`,
      );
      // ...and it is a complete, decodable build, not a fragment.
      for (const slot of SLOTS) assert.ok(build[slot.key], `seed ${seed}: ${slot.key} unfilled`);
      assert.deepEqual(decodeBuild(encodeBuild(build)), build, `seed ${seed} does not round-trip`);
    }
  });

  test("surpriseBuild is deterministic for a given rand, and actually varies", () => {
    const mk = (seed) => {
      let s = seed;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    };
    assert.deepEqual(surpriseBuild(mk(9)), surpriseBuild(mk(9)));
    const shapes = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => JSON.stringify(surpriseBuild(mk(n)))));
    assert.ok(shapes.size >= 4, "a surprise that always returns the same watch is not one");
    // With no argument it still has to be valid — it just is not repeatable.
    assert.equal(checkBuild(surpriseBuild()).ok, true);
  });
});

// ---------------------------------------------------------------------------

describe("the wire surfaces stay backward compatible", () => {
  test("a permalink from the old eleven-slot catalogue decodes unchanged", () => {
    const legacy = "movement:nh35;case:skx007;finish:brushed;insert:ceramic-black;dial:skx-black;"
      + "chapterRing:black-minutes;hands:skx-dive;crystal:dd-sapphire;crown:signed-screw;"
      + "caseback:solid-engraved;strap:oyster";
    assert.deepEqual(decodeBuild(legacy), BASE);
    // A build that touches none of the new controls encodes to that same string.
    assert.equal(encodeBuild(BASE), legacy);
  });

  test("axis and text keys appear only once they are set", () => {
    assert.deepEqual(Object.keys(BASE), SLOTS.map((s) => s.key));
    const withAxis = normalizeBuild({ ...BASE, dialColor: "green" });
    assert.equal(Object.keys(withAxis).length, SLOTS.length + 1);
    assert.ok(encodeBuild(withAxis).includes("dialColor:green"));
    assert.deepEqual(decodeBuild(encodeBuild(withAxis)), withAxis);
    // An axis set back to its default drops out again, so the codec is stable.
    assert.deepEqual(normalizeBuild({ ...withAxis, dialColor: "as-listed" }), BASE);
    // An unknown axis value degrades to the default rather than sticking.
    assert.deepEqual(normalizeBuild({ ...BASE, dialColor: "chartreuse" }), BASE);
  });

  test("GET /api/watch/catalog still answers the shape it always did", async () => {
    const j = await body(call(""));
    for (const key of ["movement", "movements", "platforms", "cases", "slots", "parts", "brands", "sources", "defaultBuild", "note"]) {
      assert.ok(j[key] !== undefined, `${key} disappeared from the payload`);
    }
    for (const key of ["finish", "insert", "dial", "chapterRing", "hands", "crystal", "crown", "caseback", "strap"]) {
      assert.ok(Array.isArray(j.parts[key]) && j.parts[key].length, `parts.${key}`);
    }
    assert.equal(j.slots.length, 11, "the eleven part slots are the build's shape");
    // The new material is additive and lives beside it.
    assert.ok(Array.isArray(j.axes) && j.axes.length > 10);
    assert.ok(j.axes.every((a) => a.key && a.name.en && a.name.sv && Array.isArray(a.options)));
    assert.ok(Array.isArray(j.textFields) && j.textFields.length === 5);
    assert.equal(j.aperture.inboard, "day");
    assert.equal(j.dialSpec.diaMm, 28.5);
    // Every case row now says what is in its box and whether it has a display back.
    for (const c of j.cases) {
      assert.ok(Array.isArray(c.kit.includes), c.id);
      assert.ok("display" in c.displayBack, c.id);
      assert.ok(c.defaults.caseback, c.id);
    }
  });

  test("?slot= reaches the axes too", async () => {
    const j = await body(call("?slot=dateWheel"));
    assert.equal(j.slot, "dateWheel");
    assert.ok(j.options.some((o) => o.seikoPart === "0148 141"));
  });

  test("none of the new work performs a fetch", async () => {
    // The same pin as the endpoint test above, over the functions the page
    // calls. The research happened once, offline; the shipped module authors
    // its findings as data and never talks to anyone.
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      throw new Error("the watch catalogue must not make outbound requests");
    };
    try {
      for (const slot of ALL_SLOTS) compatibleOptions(slot.key, BASE);
      surpriseBuild(() => 0.42);
      buildSpec(BASE);
      resolveBuild({ ...BASE, dialColor: "green", dateWheel: "roulette", textLogo: "TEST" });
      checkBuild({ ...BASE, case: "skx013", chapterRing: "none" });
      await body(call("?slot=leatherType"));
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls, 0);
  });
});
