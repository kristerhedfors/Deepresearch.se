import test from "node:test";
import assert from "node:assert/strict";
import {
  WATCH_SLOT_KEYS,
  builderLink,
  changeSummary,
  commandFor,
  commandVocabulary,
  isContinuationFragment,
  isWatchTalk,
  parseWatchCommand,
  randomBuild,
  specLine,
  suggestCommands,
  watchPromptBlock,
  watchThread,
} from "./watch-chat-core.js";
import { DEFAULT_BUILD, SLOTS, checkBuild, decodeBuild, normalizeBuild, slotOptions } from "./watch-core.js";

const DEFAULTS = normalizeBuild(DEFAULT_BUILD);

/** Apply one command to the default build and return the ids that moved. */
function changed(text, build = DEFAULTS) {
  const r = parseWatchCommand(text, build);
  return r.changes.map((c) => `${c.slot}:${c.to.id}`).sort();
}

// ---------------------------------------------------------------------------
// The reported case, verbatim. Feedback #52, 2026-07-30, is why this module
// exists: "i want the watch builder to be inline so I get the watch animation
// here and suggestions on what one can change through text commands … every new
// reply contains a new watch animation with text on what changed."

test("feedback #52: the ask opens a thread, and each command carries the build forward", () => {
  // Turn 1: the same ask feedback #49 wired to the builder now opens a build.
  const opened = watchThread(["Seiko watch demo"]);
  assert.equal(opened.active, true);
  assert.equal(opened.opened, true);
  assert.equal(opened.lang, "en");
  assert.deepEqual(opened.build, DEFAULTS);
  assert.equal(opened.changes.length, 0);

  // Turn 2: a bare command — no demo ask in it at all — changes the build.
  const two = watchThread(["Seiko watch demo", "pepsi bezel"]);
  assert.equal(two.active, true);
  assert.equal(two.opened, false);
  assert.equal(two.build.insert, "pepsi");
  assert.deepEqual(two.changes.map((c) => c.slot), ["insert"]);

  // Turn 3: the change ACCUMULATES — turn 2's insert survives, and only what
  // turn 3 touched is reported as changed.
  const three = watchThread(["Seiko watch demo", "pepsi bezel", "snowflake hands and a jubilee bracelet"]);
  assert.equal(three.build.insert, "pepsi");
  assert.equal(three.build.hands, "snowflake");
  assert.equal(three.build.strap, "jubilee");
  assert.deepEqual(three.changes.map((c) => c.slot).sort(), ["hands", "strap"]);
  assert.equal(three.turn, 3);
});

test("feedback #52: every turn's what-changed text names the parts that moved", () => {
  const state = watchThread(["Seiko watch demo", "make the dial sunburst blue"]);
  const summary = changeSummary(state.changes, "en", state);
  assert.equal(summary, "Dial → Sunburst blue");
  // Swedish is the same sentence from the same data — not a second code path.
  const sv = watchThread(["visa mig klockbyggaren", "byt urtavla till Solstråleblå"]);
  assert.equal(changeSummary(sv.changes, "sv", sv), "Urtavla → Solstråleblå");
});

// ---------------------------------------------------------------------------
// Feedback #55, 2026-07-30: "I see no watch animation. Whenever there is talk
// about building, creating, designing watches I want the default to be to
// create a watch in every response and take user input for the next animation
// in the next response in the convo."

test("feedback #55: the reported conversation keeps a watch on EVERY turn", () => {
  // The logged session, verbatim: an opening ask, the assistant asking whether
  // "fancy" meant features or looks, and the user answering with one word. That
  // one-word answer is the turn the report was written about.
  const opening = ["Build me a fancy seiko watch"];
  assert.equal(watchThread(opening).active, true, "the ask has to open a thread at all");
  assert.equal(watchThread(opening).opened, true);

  const answered = watchThread([...opening, "Features"]);
  assert.equal(answered.active, true, "a clarifying answer must not close the thread");
  assert.equal(answered.recognized, false, "…but it changed nothing, and says so");
  assert.deepEqual(answered.build, DEFAULTS);

  // And the NEXT instruction lands on the build that is already on screen.
  const next = watchThread([...opening, "Features", "make the dial sunburst blue"]);
  assert.equal(next.active, true);
  assert.equal(next.build.dial, "sunburst-blue");
  assert.deepEqual(next.changes.map((c) => c.slot), ["dial"]);
});

test("feedback #55: the same sequence in Swedish", () => {
  const opening = ["Bygg mig en fin seiko-klocka"];
  assert.equal(watchThread(opening).active, true);
  assert.equal(watchThread(opening).lang, "sv");
  const answered = watchThread([...opening, "Funktioner"]);
  assert.equal(answered.active, true);
  const next = watchThread([...opening, "Funktioner", "gör urtavlan svart"]);
  assert.equal(next.build.dial, "skx-black");
  assert.equal(next.lang, "sv");
});

test("the continuation grace is ONE turn, and real watch talk hands it back", () => {
  // A bare fragment buys the thread a turn; a second non-watch turn closes it,
  // so a conversation that drifted away does not keep a watch bolted on.
  assert.equal(watchThread(["Seiko watch demo", "Features"]).active, true);
  assert.equal(watchThread(["Seiko watch demo", "Features", "the blue one"]).active, false);
  // A watch command in between resets the grace, so the next fragment is free
  // again — which is what a real build session looks like.
  assert.equal(
    watchThread(["Seiko watch demo", "Features", "pepsi bezel", "Features"]).active,
    true,
  );
});

test("isContinuationFragment: an answer, never a new question", () => {
  for (const q of ["Features", "funktioner", "the blue one", "både och", "yes", "ja tack", "no"]) {
    assert.equal(isContinuationFragment(q), true, q);
  }
  for (const q of [
    "what is the capital of France?",           // a question mark and an opener
    "vad är huvudstaden i Frankrike?",
    "compare Claude and GPT pricing",           // an imperative opener
    "jämför Claude och GPT",
    "tell me about the war in Ukraine",
    "berätta om kriget i Ukraina",
    "show me a rocket launch from space",       // another surface's ask
    "the launch cadence of the three providers", // too long to be an answer
    "",
  ]) {
    assert.equal(isContinuationFragment(q), false, q);
  }
});

// ---------------------------------------------------------------------------
// The thread's boundaries. Opening matters; CLOSING matters as much, because an
// unrelated question must not be answered with a watch bolted onto it.

test("the thread closes on an unrelated question and stays closed", () => {
  const after = watchThread(["Seiko watch demo", "pepsi bezel", "what is the capital of France?"]);
  assert.equal(after.active, false);
  // ...and a later command does NOT silently reopen it.
  const later = watchThread(["Seiko watch demo", "what is the capital of France?", "jubilee bracelet"]);
  assert.equal(later.active, false);
  // Only another explicit ask does.
  const reopened = watchThread(["Seiko watch demo", "what is the capital of France?", "show me the watch builder"]);
  assert.equal(reopened.active, true);
  assert.equal(reopened.opened, true);
});

test("a watch-adjacent follow-up that changes nothing keeps the render up", () => {
  const state = watchThread(["Seiko watch demo", "what does lug-to-lug mean on this case?"]);
  assert.equal(state.active, true);
  assert.equal(state.recognized, false);
  assert.deepEqual(state.build, DEFAULTS);
  assert.equal(changeSummary(state.changes, "en", state), "Nothing changed — the build is as it was.");
});

test("watchThread is pure and never throws on junk", () => {
  for (const junk of [null, undefined, 42, {}, "", [null, 7, {}], [["nested"]]]) {
    const state = watchThread(junk);
    assert.equal(state.active, false);
    assert.equal(typeof state.build, "object");
  }
});

// ---------------------------------------------------------------------------
// The parser. EN + SV parity is invariant 6 — every case below is asserted in
// both languages, not "English now, Swedish later".

test("commands set the slot they name, in English and Swedish", () => {
  const pairs = [
    ["pepsi bezel", "pepsi-lünett", "insert:pepsi"],
    ["make the dial sunburst blue", "gör urtavlan solstråleblå", "dial:sunburst-blue"],
    ["fit snowflake hands", "sätt på snöflingsvisare", "hands:snowflake"],
    ["put it on a jubilee bracelet", "sätt den på ett jubilee-band", "strap:jubilee"],
    ["use a mini turtle case", "använd ett mini turtle-boett", "case:mini-turtle"],
    ["make the finish PVD black", "gör ytbehandlingen PVD svart", "finish:pvd-black"],
    // The SKX007 is LISTED with an exhibition back, so since the collapse it
    // is already the case's own — asking for a solid one is the change.
    ["fit a solid brushed case back", "sätt på en borstad hel boettbotten", "caseback:solid-brushed"],
    ["switch to the NH36 movement", "byt till NH36-urverket", "movement:nh36"],
    ["fit a flat sapphire crystal", "sätt på ett plant safirglas", "crystal:flat-sapphire"],
    ["fit a fluted crown", "sätt på en räfflad krona", "crown:fluted"],
    ["use a white minute track chapter ring", "använd en vit minutskala som chapter ring", "chapterRing:white-minutes"],
  ];
  for (const [en, sv, want] of pairs) {
    assert.deepEqual(changed(en), [want], `EN: ${en}`);
    assert.deepEqual(changed(sv), [want], `SV: ${sv}`);
  }
});

test("one message can move several slots at once", () => {
  assert.deepEqual(
    changed("salmon dial on a leather strap with a fluted crown"),
    ["crown:fluted", "dial:salmon", "strap:leather"],
  );
  assert.deepEqual(
    changed("laxrosa urtavla på ett läderband med en räfflad krona"),
    ["crown:fluted", "dial:salmon", "strap:leather"],
  );
});

test("an ambiguous colour goes to the slot it sits NEXT to", () => {
  // "black", "blue" and "green" all exist in several slots. Both colours here
  // sit inside the dial's proximity window, so only the distance to the slot
  // word decides — the bug this test pins is the dial being set to green.
  assert.deepEqual(changed("blue dial and green bezel"), ["dial:sunburst-blue", "insert:green"]);
  assert.deepEqual(changed("blå urtavla och grön lünett"), ["dial:sunburst-blue", "insert:green"]);
  // A bare colour with no slot word anywhere changes nothing at all.
  assert.deepEqual(changed("green"), []);
  assert.deepEqual(changed("grönt"), []);
});

test("the longest matching name wins, so a more specific part beats its family", () => {
  assert.deepEqual(changed("turtle case"), ["case:turtle-skx"]);
  assert.deepEqual(changed("mini turtle case"), ["case:mini-turtle"]);
  assert.deepEqual(changed("srp turtle case"), ["case:srp-turtle"]);
  assert.deepEqual(changed("sub case"), ["case:sub"]);
  assert.deepEqual(changed("slim sub case"), ["case:sub-slim"]);
  // "signed" is a substring of "unsigned" — the shorter one must not win.
  const fromSigned = parseWatchCommand("unsigned crown", DEFAULTS);
  assert.equal(fromSigned.build.crown, "plain-screw");
});

test("view commands are display-only and never touch the build", () => {
  for (const [en, sv, key] of [
    ["lights out", "släck lamporna", "lume"],
    ["show it from above", "visa den ovanifrån", "top"],
  ]) {
    for (const [lang, text] of [["EN", en], ["SV", sv]]) {
      const r = parseWatchCommand(text, DEFAULTS);
      assert.equal(r.view[key], true, `${lang}: ${text}`);
      assert.deepEqual(r.changes, [], `${lang}: ${text} must not change the build`);
      assert.equal(r.touched, true, `${lang}: ${text} is still a recognized command`);
    }
  }
  assert.equal(parseWatchCommand("lights on", DEFAULTS).view.lume, false);
  assert.equal(parseWatchCommand("tänd lamporna", DEFAULTS).view.lume, false);
});

test("reset and reroll are whole-build commands", () => {
  const modified = { ...DEFAULTS, dial: "salmon", strap: "nato", insert: "pepsi" };
  for (const text of ["reset the build", "återställ bygget", "start over", "börja om"]) {
    const r = parseWatchCommand(text, modified);
    assert.equal(r.reset, true, text);
    assert.deepEqual(r.build, DEFAULTS, text);
  }
  for (const text of ["surprise me", "överraska mig", "randomize", "slumpa"]) {
    const r = parseWatchCommand(text, DEFAULTS);
    assert.equal(r.randomized, true, text);
    assert.equal(Object.keys(r.build).length, SLOTS.length, text);
  }
});

test("a reroll is DETERMINISTIC, so a reloaded conversation rebuilds the same watch", () => {
  // The whole state is derived from the messages — nothing is stored — so
  // Math.random() would give a reader a different watch than the one the answer
  // describes. Same seed, same build; different seeds, different builds.
  assert.deepEqual(randomBuild(7), randomBuild(7));
  const a = watchThread(["Seiko watch demo", "surprise me"]);
  const b = watchThread(["Seiko watch demo", "surprise me"]);
  assert.deepEqual(a.build, b.build);
  const seeds = new Set([1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(randomBuild(s))));
  assert.ok(seeds.size >= 4, "a reroll has to actually vary");
});

test("a rerolled build is assemblable", () => {
  // A demo that rerolls into "these hands cannot go on this movement" is a bad
  // demo, so randomBuild repairs the slots the compatibility engine rejects.
  for (let seed = 1; seed <= 40; seed++) {
    const fit = checkBuild(randomBuild(seed));
    assert.equal(fit.ok, true, `seed ${seed}: ${fit.issues.filter((i) => i.level === "error").map((i) => i.en).join(" | ")}`);
  }
});

test("parseWatchCommand is pure and never throws on junk", () => {
  for (const junk of [null, undefined, 42, {}, [], "", "   ", "\n\n"]) {
    const r = parseWatchCommand(junk, junk);
    assert.deepEqual(r.build, DEFAULTS, String(junk));
    assert.deepEqual(r.changes, []);
    assert.equal(r.touched, false);
  }
});

test("isWatchTalk stays quiet on ordinary research questions", () => {
  for (const q of [
    "what is the capital of France?",
    "vad hände i Ukraina 2026?",
    "compare Claude and GPT pricing",
    "hur fungerar en transformer?",
    "best budget laptops 2026",
    "show me a rocket launch from space",
  ]) {
    assert.equal(isWatchTalk(q), false, q);
  }
  for (const q of ["pepsi bezel", "svart urtavla", "lights out", "släck lamporna", "surprise me", "jubilee"]) {
    assert.equal(isWatchTalk(q), true, q);
  }
});

// ---------------------------------------------------------------------------
// The suggestions. The property that makes them trustworthy is that they are
// commands this same parser accepts — asserted over the WHOLE catalogue, both
// languages, rather than spot-checked.

test("every catalogue part has a command that round-trips through the parser", () => {
  for (const slot of SLOTS) {
    const options = slotOptions(slot.key);
    for (const option of options) {
      for (const lang of ["en", "sv"]) {
        const command = commandFor(slot.key, option, lang);
        assert.ok(command, `${slot.key}/${option.id}/${lang}: no command`);
        // Start from a DIFFERENT part in this slot, twice, so the assertion is
        // about the parse and not about the build already matching.
        for (const other of [options[0], options[options.length - 1]].filter((o) => o.id !== option.id)) {
          const base = normalizeBuild({ ...DEFAULT_BUILD, [slot.key]: other.id });
          const result = parseWatchCommand(command, base);
          assert.equal(
            result.build[slot.key], option.id,
            `${lang} "${command}" set ${slot.key} to ${result.build[slot.key]}, wanted ${option.id}`,
          );
        }
      }
    }
  }
});

test("suggestions are valid commands, actually change something, and rotate", () => {
  const build = normalizeBuild(DEFAULT_BUILD);
  for (const lang of ["en", "sv"]) {
    const first = suggestCommands(build, lang, 0);
    assert.equal(first.length, 4);
    // The first three are build commands; the fourth is a view/reroll command.
    for (const command of first.slice(0, 3)) {
      const r = parseWatchCommand(command, build);
      assert.equal(r.changes.length >= 1, true, `${lang}: "${command}" changed nothing`);
    }
    assert.equal(parseWatchCommand(first[3], build).touched, true, `${lang}: view suggestion not recognized`);
    // Consecutive turns must not offer the same three things — the ask was for
    // a NEW animation and new suggestions each reply.
    assert.notDeepEqual(suggestCommands(build, lang, 1), first);
  }
});

test("a suggestion never talks the user into a build that cannot be assembled", () => {
  // Every offer is checked against the compatibility engine first, so following
  // any of them cannot introduce a new error.
  for (const seed of [1, 2, 3, 4, 5]) {
    const build = randomBuild(seed);
    const before = checkBuild(build).issues.filter((i) => i.level === "error").length;
    for (const command of suggestCommands(build, "en", seed).slice(0, 3)) {
      const after = checkBuild(parseWatchCommand(command, build).build).issues.filter((i) => i.level === "error").length;
      assert.ok(after <= before, `seed ${seed}: "${command}" introduced an error`);
    }
  }
});

// ---------------------------------------------------------------------------
// The prompt input and the caption line.

test("watchPromptBlock carries the build, the delta and the fit verdict", () => {
  const state = watchThread(["Seiko watch demo", "pepsi bezel and a 62MAS case"]);
  const block = watchPromptBlock(state);
  assert.match(block, /INLINE WATCH BUILDER/);
  assert.match(block, /ALREADY displayed/);
  // The FROM side is the case's own insert, not a part the build ever named:
  // since the collapse the bezel insert comes with the case (feedback #59).
  assert.match(block, /Bezel insert: Keep the case's own bezel insert → Pepsi/);
  assert.match(block, /The case decides the bezel insert, chapter ring, crystal, crown and case back/);
  assert.match(block, /62MAS vintage diver/);
  assert.match(block, /Dimensions —/);
  assert.match(block, /Fit check —/);
  assert.match(block, /NEVER say you cannot show, render, build or animate a watch/);
  // Inactive threads contribute nothing at all: the prompt must be
  // byte-identical to a run without the feature.
  assert.equal(watchPromptBlock(watchThread(["what is the capital of France?"])), "");
  assert.equal(watchPromptBlock(null), "");
});

test("watchPromptBlock reports an unassemblable build as an error to relay", () => {
  // An NH34 GMT movement with a three-hand set is the compatibility engine's
  // clearest error, and the answer has to say so rather than quietly render it.
  const state = watchThread(["Seiko watch demo", "switch to the NH34 movement"]);
  const block = watchPromptBlock(state);
  assert.match(block, /error\/hands/);
  assert.match(block, /fourth \(24-hour\) hand/);
});

// ---------------------------------------------------------------------------
// The app door (feedback #56: "building through the chatbot interface is
// unavoidably clunky and the wrong approach — send user to the app
// immediately"). The link the card LEADS with has to open the build the
// conversation actually reached, or the trip costs the user their work.

test("builderLink carries the current build into the standalone app", () => {
  const state = watchThread(["Seiko watch demo", "pepsi bezel and a 62MAS case"]);
  const url = builderLink(state.build);
  assert.match(url, /^\/watch\/#/);
  // The hash is the permalink code /watch/ writes into its own address bar, so
  // decoding it there rebuilds this exact watch.
  const code = decodeURIComponent(url.slice("/watch/#".length));
  assert.deepEqual(decodeBuild(code), state.build);
  // An already-encoded code is accepted as-is (the embed has one on the state).
  assert.equal(builderLink(state.code), url);
  // Junk degrades to the plain page rather than to a broken link.
  for (const junk of [null, undefined, "", 42, {}]) {
    assert.match(builderLink(/** @type {any} */ (junk)), /^\/watch\/(#|$)/, String(junk));
  }
});

test("watchPromptBlock tells the answer the app door exists, without a URL in it", () => {
  const state = watchThread(["Build me a fancy seiko watch", "pepsi bezel"]);
  const block = watchPromptBlock(state);
  assert.match(block, /Full builder —/);
  assert.match(block, /Open the full builder/);
  // The permalink is a long opaque code, and a model told a URL prints the URL.
  // The card carries the link; the prompt only says the button is there.
  assert.ok(!block.includes("/watch/#"), "the prompt must not hand the model a URL to paste");
});

test("specLine reports real millimetres in both languages", () => {
  const en = specLine(DEFAULTS, "en");
  assert.match(en, /42\.5 mm × 46 mm lug-to-lug/);
  assert.match(en, /13\.25 mm thick/);
  assert.match(en, /200 m WR/);
  assert.match(en, /USD \d+–\d+/);
  const sv = specLine(DEFAULTS, "sv");
  assert.match(sv, /horn-till-horn/);
  assert.match(sv, /200 m vattentät/);
});

// ---------------------------------------------------------------------------
// The vocabulary, as data.

test("commandVocabulary covers every slot and every option, bilingually", () => {
  const vocab = commandVocabulary();
  assert.deepEqual(vocab.map((v) => v.slot), WATCH_SLOT_KEYS);
  assert.deepEqual(WATCH_SLOT_KEYS, SLOTS.map((s) => s.key));
  for (const row of vocab) {
    assert.ok(row.name.en && row.name.sv, `${row.slot}: bilingual slot name`);
    assert.ok(row.words.length >= 2, `${row.slot}: needs slot words in both languages`);
    assert.equal(row.options.length, slotOptions(row.slot).length, row.slot);
    for (const option of row.options) {
      assert.ok(option.terms.length >= 1, `${row.slot}/${option.id}: no terms`);
      assert.ok(option.name.en && option.name.sv, `${row.slot}/${option.id}: bilingual name`);
    }
  }
});
