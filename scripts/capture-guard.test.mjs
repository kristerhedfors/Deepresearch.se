import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FAILURE_SIGNS,
  MIN_ANSWER_CHARS,
  formatRunVerdict,
  gradeRun,
  isConsoleNoise,
  matchFailureText,
  parseSignature,
} from "./capture-guard.mjs";
import { contentSignature } from "../tests/capture.mjs";
import { replyLooksBroken } from "../tests/app-e2e.mjs";

const SOURCE = readFileSync(new URL("./capture-guard.mjs", import.meta.url), "utf8");

/** The verbatim strings the two rejected captures put on screen. */
const CAP_22 = "Error: could not get a response.";
const CAP_21 =
  "Error: 401 — You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY).";

/** A run that went well: a real answer, no error bubble, stats landed. */
function passing(overrides = {}) {
  const answer =
    "Sweden's electricity price fell through 2024 and 2025, mostly because new wind capacity came " +
    "online in SE2 while consumption stayed flat. The four bidding areas still diverge sharply in " +
    "the winter months, and SE4 remains the most expensive.";
  return {
    // Deep Science, the default agent since the general `research` one was
    // retired (2026-08-13) — the guard grades a RUN, so the pair only has to be
    // a real agent and the mode that opens it.
    agent: "scholar",
    mode: "science",
    answerText: answer,
    errorElement: false,
    errorText: "",
    statsPresent: true,
    steps: 6,
    finishedSteps: 6,
    consoleErrors: [],
    lastSignature: contentSignature({ msgs: 2, steps: 6, finished: 6, answerLen: answer.length, step: "Validating", stats: true }),
    timedOut: false,
    driverError: null,
    appE2E: null,
    appText: "",
    ...overrides,
  };
}

/** Every reason id a verdict raised. */
const ids = (v) => v.reasons.map((r) => r.id);

// ---------------------------------------------------------------------------
// The passing case — the one that must not become noisy
// ---------------------------------------------------------------------------

test("a good run passes, with no reasons at all", () => {
  const v = gradeRun(passing());
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
  assert.deepEqual(v.reasons, []);
  assert.equal(v.summary, "");
});

test("ordinary prose is not an error, in either language", () => {
  // The reason the phrases are ERROR-SHAPED rather than merely negative: a gate
  // that fires on a good answer costs a good recording, fires on every run, and
  // gets switched off.
  const prose = [
    "Forskarna kunde inte fastställa exakt när utsläppen började minska, men mätserien pekar mot 2019.",
    "Ett fel i den ursprungliga mätningen förklarar avvikelsen; felmarginalen ligger på omkring 3 procent.",
    "The study could not rule out a confounding factor, and the error bars overlap across all four groups.",
    "Kunde inte-frågan är central i debatten om ansvar.",
  ];
  for (const text of prose) {
    assert.deepEqual(matchFailureText(text), [], text);
    assert.equal(gradeRun(passing({ answerText: text + " ".repeat(0) })).ok, true, text);
  }
});

test("the app kit's SUCCESS line is not read as a missing key", () => {
  // "no API key needed" / "ingen API-nyckel behövs" says the opposite of a
  // failure with nearly the same words — hosted mode working exactly as PR #426
  // intended. Matching it would fail every well-built app.
  for (const said of [
    "Ready — running on mistral-small, no API key needed.",
    "Klar — kör på mistral-small, ingen API-nyckel behövs.",
    "Runs on DeepResearch.se's own model access — you need no API key.",
    "Paste an API key to load the available models.",
    "Klistra in en API-nyckel för att hämta tillgängliga modeller.",
  ]) {
    assert.deepEqual(matchFailureText(said), [], said);
  }
});

// ---------------------------------------------------------------------------
// The two rejected captures, verbatim
// ---------------------------------------------------------------------------

test("#CAP-22: “Error: could not get a response.” fails the run — EN and SV", () => {
  const en = gradeRun(passing({ answerText: CAP_22 }));
  assert.equal(en.ok, false);
  assert.ok(ids(en).some((id) => id.endsWith("no_response_produced")), JSON.stringify(ids(en)));
  assert.match(en.summary, /could not get a response/i);

  const sv = gradeRun(passing({ answerText: "Fel: kunde inte få ett svar från modellen." }));
  assert.equal(sv.ok, false);
  assert.ok(ids(sv).some((id) => id.endsWith("no_response_produced")), JSON.stringify(ids(sv)));
});

test("#CAP-21: the app saying no API key was provided fails the run — EN and SV", () => {
  // The key field was visibly FILLED in that clip's final frame. An app that
  // then reports the key missing is broken, not merely rejected.
  const en = gradeRun(passing({ appText: CAP_21 }));
  assert.equal(en.ok, false);
  assert.ok(ids(en).some((id) => id === "app_text:api_key_missing"), JSON.stringify(ids(en)));

  const sv = gradeRun(passing({ appText: "Fel: 401 — Du angav ingen API-nyckel. Nyckeln måste skickas i en Authorization-header." }));
  assert.equal(sv.ok, false);
  assert.ok(ids(sv).some((id) => id === "app_text:api_key_missing"), JSON.stringify(ids(sv)));
});

test("the two verbatim strings are judged the same way by the app gate's own copy", () => {
  // tests/app-e2e.mjs may not import this module (it is contractually
  // import-free), so its REPLY_ERROR_PATTERNS are a small duplicate. This is
  // what stops the two drifting apart in silence.
  for (const said of [CAP_22, CAP_21, "Fel: kunde inte få ett svar.", "Du angav ingen API-nyckel."]) {
    assert.ok(replyLooksBroken(said), `app-e2e must flag: ${said}`);
    assert.ok(matchFailureText(said).length > 0, `the guard must flag: ${said}`);
  }
  for (const fine of ["Klar — kör på mistral-small, ingen API-nyckel behövs.", "The sea covers most of the planet."]) {
    assert.equal(replyLooksBroken(fine), null, fine);
    assert.deepEqual(matchFailureText(fine), [], fine);
  }
});

// ---------------------------------------------------------------------------
// The product's own error states
// ---------------------------------------------------------------------------

test("an error-styled bubble fails the run whatever it says", () => {
  // `setError` puts `error-text` on the bubble (public/js/turns.js) for every
  // error a turn can hit. That structural signal holds for wording no pattern
  // list has ever seen.
  const v = gradeRun(passing({ errorElement: true, errorText: "En helt ny formulering ingen regex känner till." }));
  assert.equal(v.ok, false);
  assert.ok(ids(v).includes("error_state"));
  assert.match(v.summary, /rendered as an error/);
});

test("setError's own messages are recognised, in both languages", () => {
  for (const [en, sv] of [
    ["No response received.", "Inget svar mottogs."],
    ["Something went wrong.", "Något gick fel."],
    ["Network error: connection lost (ref a1b2c3d4)", "Nätverksfel: anslutningen bröts."],
    ["Worker error: Berget request failed", "Ett fel uppstod i servern."],
  ]) {
    assert.ok(matchFailureText(en).length > 0, en);
    assert.ok(matchFailureText(sv).length > 0, sv);
  }
});

test("a partial answer with setError's message appended still fails", () => {
  // setError APPENDS to whatever streamed: `turn.text + "\n\n[" + message +
  // "]"`. A long, healthy-looking answer with the failure only at the very end
  // is the shape that most easily slips past a reader.
  const v = gradeRun(passing({ answerText: passing().answerText + "\n\n[Network error: connection lost (ref a1b2c3d4)]" }));
  assert.equal(v.ok, false);
  assert.ok(ids(v).some((id) => id.endsWith("network_error")));
});

// ---------------------------------------------------------------------------
// Nothing on screen
// ---------------------------------------------------------------------------

test("an empty answer fails — a blank bubble is not a capture of anything", () => {
  const v = gradeRun(passing({ answerText: "", lastSignature: contentSignature({ msgs: 2, answerLen: 0, stats: true }) }));
  assert.equal(v.ok, false);
  assert.ok(ids(v).includes("empty_answer"));
  assert.match(v.summary, /no assistant answer/);
});

test("a near-empty answer fails too, and says how short it was", () => {
  const v = gradeRun(passing({ answerText: "Hmm." }));
  assert.equal(v.ok, false);
  assert.ok(ids(v).includes("empty_answer"));
  assert.match(v.summary, /4 characters/);
  // The threshold is a documented constant, not a magic number in a branch.
  assert.ok(MIN_ANSWER_CHARS > 4 && MIN_ANSWER_CHARS < 200);
});

test("a missing or unreadable final content signature fails", () => {
  const missing = gradeRun(passing({ lastSignature: null }));
  assert.equal(missing.ok, false);
  assert.ok(ids(missing).includes("no_final_content"));

  const junk = gradeRun(passing({ lastSignature: "not-a-signature" }));
  assert.equal(junk.ok, false);
  assert.ok(ids(junk).includes("no_final_content"));

  // The signature says the last sampled frame had no assistant text on it, even
  // though the DOM read afterwards found some — the frame is what was recorded.
  const blank = gradeRun(passing({ lastSignature: contentSignature({ msgs: 2, steps: 3, finished: 3, answerLen: 0, stats: true }) }));
  assert.equal(blank.ok, false);
  assert.ok(ids(blank).includes("no_final_content"));
});

test("the timeout, the driver's own error and an unfinished turn each fail on their own", () => {
  assert.ok(ids(gradeRun(passing({ timedOut: true }))).includes("timed_out"));
  assert.ok(ids(gradeRun(passing({ driverError: "model “x” is not in the #model dropdown" }))).includes("driver_error"));
  assert.ok(ids(gradeRun(passing({ statsPresent: false }))).includes("turn_unfinished"));
  // A timeout already says the turn never finished; saying it twice is noise.
  assert.equal(ids(gradeRun(passing({ timedOut: true, statsPresent: false }))).includes("turn_unfinished"), false);
});

// ---------------------------------------------------------------------------
// The Agent Studio verdict and the console
// ---------------------------------------------------------------------------

test("a failed app-e2e verdict is carried into the run's verdict", () => {
  const v = gradeRun(passing({ appE2E: { pass: false, failures: ["app_answered: the app answered with an error (error_prefix): Error: could not get a response."] } }));
  assert.equal(v.ok, false);
  assert.ok(ids(v).includes("app_e2e"));
  assert.match(v.summary, /app_answered/);
  // A passing app verdict adds nothing.
  assert.equal(gradeRun(passing({ appE2E: { pass: true, failures: [] } })).ok, true);
});

test("network weather is not a page error, but the app's own exception is", () => {
  for (const noise of [
    "Failed to load resource: the server responded with a status of 404 ()",
    "net::ERR_CONNECTION_REFUSED",
    "Access to fetch at 'https://api.exa.ai/search' has been blocked by CORS policy",
    "SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.",
  ]) {
    assert.equal(isConsoleNoise(noise), true, noise);
  }
  assert.equal(isConsoleNoise("TypeError: renderContent is not a function"), false);
  const v = gradeRun(passing({ consoleErrors: ["Failed to load resource: 404", "TypeError: renderContent is not a function"] }));
  assert.equal(v.ok, false);
  assert.ok(ids(v).includes("page_errors"));
  assert.match(v.summary, /1 uncaught page error/);
});

// ---------------------------------------------------------------------------
// Swedish parity — CLAUDE.md invariant 6
// ---------------------------------------------------------------------------

test("EVERY failure sign exists in both English and Swedish", () => {
  const byId = new Map();
  for (const sign of FAILURE_SIGNS) {
    assert.ok(["en", "sv"].includes(sign.lang), `${sign.id}: lang must be en or sv`);
    assert.ok(sign.re instanceof RegExp, `${sign.id}: needs a regex`);
    assert.ok(String(sign.what || "").length > 0, `${sign.id}: needs a human clause`);
    const langs = byId.get(sign.id) || new Set();
    langs.add(sign.lang);
    byId.set(sign.id, langs);
  }
  assert.ok(byId.size >= 8, "the registry should not have shrunk");
  for (const [id, langs] of byId) {
    assert.deepEqual(
      [...langs].sort(),
      ["en", "sv"],
      `“${id}” must be written in BOTH languages in the SAME change (invariant 6) — never English-only with Swedish later`,
    );
  }
});

test("no Swedish pattern uses \\b, which does not see å, ä or ö", () => {
  // The trap that silently kills bilingual regex gates repo-wide: JS word
  // boundaries treat å/ä/ö as non-word characters, so `\bfel\b` never matches
  // inside "felmeddelande" the way an author expects — and worse, `\bnyckel`
  // behaves differently after an å than after an a.
  for (const sign of FAILURE_SIGNS.filter((s) => s.lang === "sv")) {
    assert.equal(/\\b/.test(sign.re.source), false, `${sign.id} (sv) must not use \\b: ${sign.re.source}`);
  }
});

test("the module is pure — no filesystem, no clock, no network, no browser", () => {
  for (const forbidden of [/require\(/, /node:fs/, /readFileSync/, /\bfetch\(/, /Date\.now/, /new Date\b/, /process\.env/]) {
    assert.equal(forbidden.test(SOURCE), false, `capture-guard.mjs must not use ${forbidden}`);
  }
  assert.equal(/^import /m.test(SOURCE), false, "and it imports nothing at all");
});

// ---------------------------------------------------------------------------
// parseSignature — the timeline contract, read back
// ---------------------------------------------------------------------------

test("a content signature written by the driver reads back field for field", () => {
  const sig = contentSignature({ msgs: 4, steps: 7, finished: 5, answerLen: 1234, step: "Searching the web", stats: true });
  assert.deepEqual(parseSignature(sig), {
    msgs: 4,
    steps: 7,
    finished: 5,
    answerLen: 1234,
    step: "Searching the web",
    stats: true,
  });
  assert.equal(parseSignature("")?.msgs, undefined);
  assert.equal(parseSignature(null), null);
  assert.equal(parseSignature("1|2|3"), null);
});

// ---------------------------------------------------------------------------
// Totality and the printed block
// ---------------------------------------------------------------------------

test("garbage in fails clearly rather than throwing", () => {
  for (const junk of [null, undefined, {}, [], "nope", 42, { answerText: 7, consoleErrors: "no" }]) {
    const v = gradeRun(/** @type {any} */ (junk));
    assert.equal(v.ok, false, JSON.stringify(junk));
    assert.ok(v.reasons.length >= 1);
    assert.ok(v.reasons.every((r) => typeof r.id === "string" && typeof r.detail === "string"));
  }
});

test("the verdict block names every reason and says what to do", () => {
  const v = gradeRun(passing({ answerText: CAP_22 }));
  const out = formatRunVerdict(v, "agent-builder__m__agb-tutor");
  assert.match(out, /✗ FAILED VERIFICATION {2}agent-builder__m__agb-tutor/);
  assert.match(out, /do NOT present this clip as a good capture/);
  for (const r of v.reasons) assert.ok(out.includes(r.id), r.id);
  assert.equal(out.endsWith("\n"), true);

  assert.match(formatRunVerdict(gradeRun(passing()), "x"), /✓ VERIFIED {2}x/);
  for (const junk of [null, undefined, {}, { reasons: "no" }]) {
    assert.equal(typeof formatRunVerdict(/** @type {any} */ (junk)), "string");
  }
});
