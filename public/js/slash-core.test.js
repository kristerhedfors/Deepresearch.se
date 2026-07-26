// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — see the note in src/pipeline.test.js.)
// The slash-command registry + parser (public/js/slash-core.js): the platform's
// composer command surface, shared by both tiers and every agent.
//
// Three things are pinned here: the PARSE (a command is a leading slash and an
// exact name, nothing else), the EN/SV parity of everything a user reads
// (invariant 6 — the names are deliberately untranslated, the prose is not),
// and the MENU's pure filtering, so the typeahead's behaviour is verified
// without a DOM.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SLASH,
  SLASH_COMMANDS,
  SLASH_COMMAND_NAMES,
  SLASH_EFFECTS,
  moveSlashIndex,
  parseSlashCommand,
  slashArgs,
  slashCommand,
  slashEffect,
  slashMenuItems,
  slashQuery,
  slashSuggestions,
} from "./slash-core.js";

describe("the registry", () => {
  test("ships exactly the two commands the owner asked for, in order", () => {
    // "for starters we will only have /feedback and /help" (2026-07-26).
    // Adding a third is a deliberate act — this assertion is the speed bump.
    assert.deepEqual(SLASH_COMMAND_NAMES, ["feedback", "help"]);
    assert.deepEqual(SLASH_EFFECTS, ["feedback", "help"]);
    assert.equal(SLASH, "/");
  });

  test("names are lowercase single tokens (a command is typed, not composed)", () => {
    for (const c of SLASH_COMMANDS) assert.match(c.name, /^[a-z][a-z0-9-]*$/);
  });

  test("slashCommand looks a name up case-insensitively, and only a real one", () => {
    assert.equal(slashCommand("help")?.effect, "help");
    assert.equal(slashCommand("HELP")?.effect, "help");
    assert.equal(slashCommand(" Feedback ")?.effect, "feedback");
    assert.equal(slashCommand("helper"), null);
    assert.equal(slashCommand(""), null);
    assert.equal(slashCommand(null), null);
  });
});

describe("Swedish language parity (invariant 6)", () => {
  // The NAMES stay untranslated on purpose — "/help" is the token a Swedish
  // user has already typed in every other chat product, and translating it
  // would break that muscle memory silently. Everything the user READS must
  // exist in both languages with the same breadth.
  test("every command carries a label, an argument hint and a description in EN AND SV", () => {
    for (const c of SLASH_COMMANDS) {
      for (const field of ["label", "args", "desc"]) {
        assert.equal(typeof c[field].en, "string", `${c.name}.${field}.en`);
        assert.equal(typeof c[field].sv, "string", `${c.name}.${field}.sv`);
        assert.ok(c[field].en.trim().length, `${c.name}.${field}.en is empty`);
        assert.ok(c[field].sv.trim().length, `${c.name}.${field}.sv is empty`);
      }
    }
  });

  test("the two languages say different things — no English text left in the sv slot", () => {
    for (const c of SLASH_COMMANDS) {
      assert.notEqual(c.desc.en, c.desc.sv, `${c.name}: the sv description is the English one`);
      assert.notEqual(c.args.en, c.args.sv, `${c.name}: the sv argument hint is the English one`);
    }
  });

  test("the SV descriptions are actually Swedish (diacritics or Swedish function words)", () => {
    for (const c of SLASH_COMMANDS) {
      assert.match(
        c.desc.sv,
        /[åäö]|\b(?:och|inte|som|att|från|utifrån|aldrig|alla|något|direkt)\b/i,
        `${c.name}: the sv description reads as English`,
      );
    }
  });

  test("the menu renders in the language it is asked for, and defaults to English", () => {
    const en = slashMenuItems("/", "en");
    const sv = slashMenuItems("/", "sv");
    assert.equal(en.length, sv.length);
    assert.equal(en[0].desc, SLASH_COMMANDS[0].desc.en);
    assert.equal(sv[0].desc, SLASH_COMMANDS[0].desc.sv);
    // The command itself is identical in both — that is the point.
    assert.equal(en[0].title, sv[0].title);
    assert.deepEqual(
      slashMenuItems("/", /** @type {any} */ ("de")),
      en,
      "an unknown language falls back to English, never to nothing",
    );
  });
});

describe("parseSlashCommand — leading slash only, exact name only", () => {
  test("a command with an argument", () => {
    const p = parseSlashCommand("/feedback the map view was cut off on my phone");
    assert.equal(p?.name, "feedback");
    assert.equal(p?.effect, "feedback");
    assert.equal(p?.args, "the map view was cut off on my phone");
  });

  test("a bare command carries no argument", () => {
    assert.equal(parseSlashCommand("/help")?.args, "");
    assert.equal(parseSlashCommand("/feedback")?.args, "");
  });

  test("a colon separator is accepted — people already write the keyword that way", () => {
    assert.equal(parseSlashCommand("/feedback: kartan är avklippt")?.args, "kartan är avklippt");
  });

  test("the name is matched case-insensitively", () => {
    assert.equal(parseSlashCommand("/HELP how do I sign in")?.effect, "help");
    assert.equal(parseSlashCommand("/Feedback yo")?.effect, "feedback");
  });

  test("leading whitespace is tolerated (a pasted or soft-wrapped message)", () => {
    assert.equal(parseSlashCommand("  /help how does the vault work")?.effect, "help");
    assert.equal(parseSlashCommand("\n/feedback broken")?.args, "broken");
  });

  test("the name must be the WHOLE token — a longer word is not a command", () => {
    assert.equal(parseSlashCommand("/helper"), null);
    assert.equal(parseSlashCommand("/helpme now"), null);
    assert.equal(parseSlashCommand("/feedbacks"), null);
  });

  test("an unknown command is ordinary text, never an error", () => {
    assert.equal(parseSlashCommand("/etc/passwd"), null);
    assert.equal(parseSlashCommand("/deploy the worker"), null);
    assert.equal(parseSlashCommand("/"), null);
  });

  test("the slash must OPEN the message — a slash mid-sentence is research", () => {
    assert.equal(parseSlashCommand("what does /help do on this site?"), null);
    assert.equal(parseSlashCommand("compare a/b testing"), null);
    // The single most important non-regression: the bare keyword gate is a
    // different gate and is not a slash command.
    assert.equal(parseSlashCommand("feedback the map is cut off"), null);
  });

  test("junk input is inert", () => {
    for (const v of [null, undefined, 42, {}, [], ""]) assert.equal(parseSlashCommand(v), null);
  });
});

describe("slashEffect / slashArgs", () => {
  test("slashEffect names the effect or nothing at all", () => {
    assert.equal(slashEffect("/feedback broken"), "feedback");
    assert.equal(slashEffect("/help hur fungerar valvet"), "help");
    assert.equal(slashEffect("feedback broken"), null);
    assert.equal(slashEffect("how do I use this?"), null);
  });

  test("slashArgs strips the command token", () => {
    assert.equal(slashArgs("/feedback the map is cut off"), "the map is cut off");
    assert.equal(slashArgs("/help vad är en arbetsyta"), "vad är en arbetsyta");
  });

  test("slashArgs returns the message untouched when there is no command, or no argument", () => {
    assert.equal(slashArgs("feedback the map is cut off"), "feedback the map is cut off");
    // A bare /feedback must not become an empty note — it behaves like the
    // bare keyword always has.
    assert.equal(slashArgs("/feedback"), "/feedback");
  });
});

describe("the typeahead's pure half", () => {
  test("a lone slash at the start opens the whole list", () => {
    assert.equal(slashQuery("/"), "");
    assert.deepEqual(slashSuggestions("/").map((c) => c.name), ["feedback", "help"]);
  });

  test("typing filters by prefix, preserving registry order", () => {
    assert.deepEqual(slashSuggestions("/f").map((c) => c.name), ["feedback"]);
    assert.deepEqual(slashSuggestions("/h").map((c) => c.name), ["help"]);
    assert.deepEqual(slashSuggestions("/he").map((c) => c.name), ["help"]);
    assert.deepEqual(slashSuggestions("/help").map((c) => c.name), ["help"]);
    assert.deepEqual(slashSuggestions("/HE").map((c) => c.name), ["help"]);
  });

  test("a prefix that matches nothing closes the menu rather than showing an empty box", () => {
    assert.deepEqual(slashSuggestions("/zzz"), []);
  });

  test("the menu closes as soon as an ARGUMENT is being typed — Enter must send then", () => {
    assert.equal(slashQuery("/help "), null);
    assert.deepEqual(slashSuggestions("/help how do I sign in"), []);
    assert.deepEqual(slashSuggestions("/feedback broken"), []);
  });

  test("the menu never opens for a slash that is not the first character", () => {
    for (const t of [" /help", "a/", "what does /help do", "x/feedback"]) {
      assert.equal(slashQuery(t), null, t);
      assert.deepEqual(slashSuggestions(t), [], t);
    }
  });

  test("an empty composer shows nothing", () => {
    assert.equal(slashQuery(""), null);
    assert.deepEqual(slashSuggestions(""), []);
    assert.deepEqual(slashSuggestions(null), []);
  });

  test("picking a row inserts the command plus a space, so the argument is typed straight on", () => {
    for (const item of slashMenuItems("/", "en")) {
      assert.equal(item.insert, item.title + " ");
      // …and the inserted text must no longer open the menu, or Enter could
      // never send.
      assert.deepEqual(slashSuggestions(item.insert), []);
    }
  });

  test("the highlight wraps at both ends and survives junk", () => {
    assert.equal(moveSlashIndex(0, 1, 2), 1);
    assert.equal(moveSlashIndex(1, 1, 2), 0);
    assert.equal(moveSlashIndex(0, -1, 2), 1);
    assert.equal(moveSlashIndex(1, -1, 2), 0);
    assert.equal(moveSlashIndex(0, 1, 0), 0, "an empty list has no index to move");
    assert.equal(moveSlashIndex(/** @type {any} */ (NaN), 1, 2), 1);
  });
});
