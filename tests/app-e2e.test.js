// Unit tests for the generated-app end-to-end test — everything in
// tests/app-e2e.mjs that is a function of its arguments: the six checks, the
// provider-noise filter, the verdict block, and exerciseApp's promise never to
// throw (exercised against a fake page, so no browser is involved).
//
// This file is run by the ROOT `npm test` (glob `tests/*.test.js`) on a
// checkout where `cd tests && npm install` has never happened, so it must not
// pull in `@playwright/test` directly or transitively — app-e2e.mjs imports
// nothing at all and takes its `page` as an argument, which is exactly what
// makes that possible. Importing the module is therefore part of the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHECK_IDS,
  DEFAULT_PROMPT,
  EXERCISE_DEFAULTS,
  SENTINEL_KEY,
  exerciseApp,
  formatAppVerdict,
  gradeApp,
  isProviderNoise,
} from "./app-e2e.mjs";

const SOURCE = readFileSync(new URL("./app-e2e.mjs", import.meta.url), "utf8");

/** The verdict for one check id, by id rather than by position. */
const check = (result, id) => result.checks.find((c) => c.id === id);
const okOf = (result, id) => check(result, id)?.ok;

/** A clean run: everything the exercise would write down for a well-built app. */
function passing(overrides = {}) {
  return {
    url: "https://deepresearch.se/app/some-slug/",
    loaded: true,
    status: 200,
    title: "Socratic Tutor",
    bodyTextLength: 812,
    htmlLength: 4096,
    origin: "null",
    keyFields: [{ index: 0, tag: "input", id: "keyInput", type: "password", masked: true, everUnmasked: false, filled: true }],
    sentinelTyped: 1,
    reveal: {
      visibleText: false,
      attribute: false,
      attributeWhere: null,
      domText: false,
      domTextWhere: null,
      localStorage: false,
      sessionStorage: false,
      cookie: false,
      url: false,
      storageErrors: [],
    },
    interaction: {
      promptField: { tag: "textarea", id: "input", text: "" },
      sendButton: { tag: "button", id: "send", text: "Send" },
      filled: true,
      clicked: true,
      forced: false,
      error: null,
      threw: [],
    },
    // What the app wrote when send was pressed. A working app answers; #CAP-22
    // printed "Error: could not get a response." here and was certified as
    // working anyway, which is why `app_answered` exists.
    reply: {
      beforeChars: 812,
      afterChars: 1010,
      prompt: DEFAULT_PROMPT,
      added: "Hello! Give me one short sentence about the sea. The sea covers most of the planet and drives its weather.",
      text: "Socratic Tutor … Hello! Give me one short sentence about the sea. The sea covers most of the planet and drives its weather.",
    },
    consoleErrors: [],
    pageErrors: [],
    errors: [],
    network: { failed: [], errorStatuses: [] },
    durationMs: 9000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The sentinel — a safety property, not a detail
// ---------------------------------------------------------------------------

test("the sentinel key is the exact constant the contract names", () => {
  assert.equal(SENTINEL_KEY, "sk-FAKE-CAPTURE-SENTINEL");
});

test("no code path can read a real key out of the environment", () => {
  // The sentinel is typed WHILE RECORDING. A module that could pick up
  // OPENAI_API_KEY from the environment is one deploy away from putting a real
  // key in a video, so the absence of that path is pinned here rather than
  // trusted to review.
  assert.equal(/process\.env/.test(SOURCE), false, "app-e2e.mjs must never read process.env");
  assert.equal(/readFileSync|readFile\(/.test(SOURCE), false, "app-e2e.mjs must not read a key from disk either");
  const sentinelLiterals = SOURCE.match(/sk-[A-Za-z0-9-]+/g) || [];
  assert.deepEqual([...new Set(sentinelLiterals)], ["sk-FAKE-CAPTURE-SENTINEL"]);
});

test("the module pulls in no dependencies at all — the root suite imports it", () => {
  assert.equal(/^import .*from/m.test(SOURCE), false, "app-e2e.mjs must stay import-free (no @playwright/test)");
  assert.equal(/require\(/.test(SOURCE), false);
});

// ---------------------------------------------------------------------------
// gradeApp — the whole point
// ---------------------------------------------------------------------------

test("a clean run passes every check, in the documented order", () => {
  const r = gradeApp(passing());
  assert.equal(r.pass, true, JSON.stringify(r.failures));
  assert.deepEqual(r.checks.map((c) => c.id), CHECK_IDS);
  assert.deepEqual(r.failures, []);
  for (const c of r.checks) assert.ok(c.detail.length > 0, `${c.id} must explain itself even when it passes`);
});

test("app_loads fails when the page never loaded", () => {
  const r = gradeApp(passing({ loaded: false, bodyTextLength: 0, errors: [{ step: "goto", message: "net::ERR_ABORTED" }] }));
  assert.equal(okOf(r, "app_loads"), false);
  assert.equal(r.pass, false);
  assert.match(r.failures.join(" "), /app_loads/);
  assert.match(check(r, "app_loads").detail, /never loaded/);
});

test("app_loads fails on a blank body — a page that renders nothing is not a working app", () => {
  const r = gradeApp(passing({ bodyTextLength: 0 }));
  assert.equal(okOf(r, "app_loads"), false);
  assert.match(check(r, "app_loads").detail, /no text/);
});

test("app_loads fails on an HTTP error status", () => {
  const r = gradeApp(passing({ status: 404, bodyTextLength: 12 }));
  assert.equal(okOf(r, "app_loads"), false);
  assert.match(check(r, "app_loads").detail, /404/);
});

test("app_loads tolerates a missing status (an already-open page)", () => {
  const r = gradeApp(passing({ status: null }));
  assert.equal(okOf(r, "app_loads"), true);
});

test("no_page_errors fails on an uncaught exception of the app's own making", () => {
  const r = gradeApp(passing({ pageErrors: [{ text: "TypeError: t.render is not a function", noise: false }] }));
  assert.equal(okOf(r, "no_page_errors"), false);
  assert.match(r.failures.join(" "), /t\.render is not a function/);
});

test("THE SENTINEL 401 IS NOT A FAILURE — provider and network noise is filtered", () => {
  const r = gradeApp(
    passing({
      consoleErrors: [
        { type: "error", text: "Failed to load resource: the server responded with a status of 401 ()", noise: true },
        { type: "error", text: "POST https://api.openai.com/v1/chat/completions 401 (Unauthorized)", noise: true },
      ],
      pageErrors: [{ text: "Error: 401 Incorrect API key provided", noise: true }],
    }),
  );
  assert.equal(okOf(r, "no_page_errors"), true, JSON.stringify(r.failures));
  assert.equal(r.pass, true);
  assert.match(check(r, "no_page_errors").detail, /3 provider\/network messages ignored/);
});

test("noise is re-judged from the text when the observation did not classify it", () => {
  // An observations file hand-written, or produced by an older exercise, has no
  // `noise` flag — the grade must not become stricter because of that.
  const noisy = gradeApp(passing({ pageErrors: ["TypeError: Failed to fetch"] }));
  assert.equal(okOf(noisy, "no_page_errors"), true);
  const real = gradeApp(passing({ pageErrors: ["ReferenceError: DRKit is not defined"] }));
  assert.equal(okOf(real, "no_page_errors"), false);
});

test("key_field_masked fails on a plain-text key field — the thing under test", () => {
  const r = gradeApp(
    passing({
      keyFields: [{ index: 0, tag: "input", id: "api-key", type: "text", masked: false, everUnmasked: true, filled: true }],
    }),
  );
  assert.equal(okOf(r, "key_field_masked"), false);
  assert.match(r.failures.join(" "), /input#api-key is type="text"/);
  assert.match(r.failures.join(" "), /on camera/);
});

test("key_field_masked fails a field that was plain text only while the key was typed", () => {
  const r = gradeApp(
    passing({
      keyFields: [{ index: 0, tag: "input", id: "k", type: "password", masked: false, everUnmasked: true, filled: true }],
    }),
  );
  assert.equal(okOf(r, "key_field_masked"), false);
  assert.match(check(r, "key_field_masked").detail, /was plain text/);
});

test("NO KEY FIELD AT ALL IS A PASS — not every generated app takes a key", () => {
  const r = gradeApp(
    passing({
      keyFields: [],
      sentinelTyped: 0,
      reveal: { ...passing().reveal },
    }),
  );
  assert.equal(okOf(r, "key_field_masked"), true);
  assert.match(check(r, "key_field_masked").detail, /does not ask for a key/);
  assert.equal(okOf(r, "key_not_revealed"), true);
  assert.match(check(r, "key_not_revealed").detail, /no key was typed/);
  assert.equal(r.pass, true, JSON.stringify(r.failures));
});

test("key_field_masked reports every unmasked field, not just the first", () => {
  const r = gradeApp(
    passing({
      keyFields: [
        { index: 0, tag: "input", id: "a", type: "text", masked: false },
        { index: 1, tag: "input", id: "b", type: "password", masked: true },
        { index: 2, tag: "input", id: "c", type: "text", masked: false },
      ],
    }),
  );
  const detail = check(r, "key_field_masked").detail;
  assert.match(detail, /#a/);
  assert.match(detail, /#c/);
  assert.equal(/#b/.test(detail), false);
});

test("key_not_revealed fails when the key reaches visible text", () => {
  const r = gradeApp(passing({ reveal: { ...passing().reveal, visibleText: true } }));
  assert.equal(okOf(r, "key_not_revealed"), false);
  assert.match(r.failures.join(" "), /visible text/);
});

test("key_not_revealed fails when the key is echoed into an attribute or a hidden node", () => {
  const attr = gradeApp(passing({ reveal: { ...passing().reveal, attribute: true, attributeWhere: "div#status[title]" } }));
  assert.equal(okOf(attr, "key_not_revealed"), false);
  assert.match(attr.failures.join(" "), /div#status\[title\]/);

  const dom = gradeApp(passing({ reveal: { ...passing().reveal, domText: true, domTextWhere: "pre#debug" } }));
  assert.equal(okOf(dom, "key_not_revealed"), false);
  assert.match(dom.failures.join(" "), /pre#debug/);
});

test("key_not_persisted fails per storage, naming where the key went", () => {
  for (const [field, word] of [
    ["localStorage", /localStorage/],
    ["sessionStorage", /sessionStorage/],
    ["cookie", /cookie/],
    ["url", /URL/],
  ]) {
    const r = gradeApp(passing({ reveal: { ...passing().reveal, [field]: true } }));
    assert.equal(okOf(r, "key_not_persisted"), false, field);
    assert.match(r.failures.join(" "), word);
  }
});

test("storage the sandbox refuses to open is the strongest form of 'not persisted'", () => {
  // `/app/<slug>/` is served into an opaque origin, where localStorage throws
  // rather than returning empty. A caught SecurityError must read as a pass.
  const r = gradeApp(
    passing({
      reveal: {
        ...passing().reveal,
        storageErrors: ["localStorage: Failed to read the 'localStorage' property from 'Window': Access is denied"],
      },
    }),
  );
  assert.equal(okOf(r, "key_not_persisted"), true);
  assert.match(check(r, "key_not_persisted").detail, /denies storage access/);
});

test("app_interactive fails when there is nothing to type into", () => {
  const r = gradeApp(passing({ interaction: { ...passing().interaction, promptField: null } }));
  assert.equal(okOf(r, "app_interactive"), false);
  assert.match(r.failures.join(" "), /nothing to type into/);
});

test("app_interactive fails when there is nothing to press", () => {
  const r = gradeApp(passing({ interaction: { ...passing().interaction, sendButton: null } }));
  assert.equal(okOf(r, "app_interactive"), false);
  assert.match(r.failures.join(" "), /nothing to press/);
});

test("app_interactive fails when the control would not take the click", () => {
  const r = gradeApp(
    passing({
      interaction: { ...passing().interaction, clicked: false, error: "pressing button#send failed: element is not visible" },
    }),
  );
  assert.equal(okOf(r, "app_interactive"), false);
  assert.match(r.failures.join(" "), /not visible/);
});

test("app_interactive fails when pressing it threw — but not on the sentinel's 401", () => {
  const threw = gradeApp(
    passing({ interaction: { ...passing().interaction, threw: ["TypeError: cfg.model is undefined"] } }),
  );
  assert.equal(okOf(threw, "app_interactive"), false);
  assert.match(threw.failures.join(" "), /cfg\.model is undefined/);

  // The exercise only records non-noise page errors into `threw`, so a run
  // whose only post-click error was the 401 arrives here with an empty list.
  const fine = gradeApp(
    passing({
      interaction: { ...passing().interaction, threw: [] },
      pageErrors: [{ text: "Error: 401 Unauthorized", noise: true }],
    }),
  );
  assert.equal(okOf(fine, "app_interactive"), true);
  assert.equal(fine.pass, true);
});

test("a forced click still counts as interactive, and says so", () => {
  const r = gradeApp(passing({ interaction: { ...passing().interaction, forced: true } }));
  assert.equal(okOf(r, "app_interactive"), true);
  assert.match(check(r, "app_interactive").detail, /forced/);
});

// ---------------------------------------------------------------------------
// app_answered — the seventh check, and the reason it was added
// ---------------------------------------------------------------------------

test("THE #CAP-22 REGRESSION: a published app that answers with an error FAILS", () => {
  // The stored verdict for #CAP-22 is pass:true with all six of the original
  // checks green — app_interactive included, reading "typed into textarea#input
  // and pressed button#send “Send”". The clip's own final frame shows that same
  // app replying "Error: could not get a response." Pressing a button that
  // leads nowhere used to be a pass; this is the assertion that was missing.
  const r = gradeApp(
    passing({
      reply: { ...passing().reply, added: "Error: could not get a response.", text: "Socratic Tutor\nError: could not get a response." },
    }),
  );
  assert.equal(okOf(r, "app_answered"), false);
  assert.equal(okOf(r, "app_interactive"), true, "the old check still passes — which is exactly the problem it had");
  assert.equal(r.pass, false, "and the capture must not be presented as a good one");
  assert.match(check(r, "app_answered").detail, /answered with an error/);
});

test("THE #CAP-21 REGRESSION: an app that says the key is missing FAILS, in EN and SV", () => {
  // The key field was visibly filled (masked dots) and the app still answered
  // with OpenAI's absent-header 401. Both languages, because half the capture
  // matrix is --lang sv (CLAUDE.md invariant 6).
  const en = "Error: 401 — You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth.";
  const sv = "Fel: 401 — Du angav ingen API-nyckel. Nyckeln måste skickas med i en Authorization-header.";
  for (const said of [en, sv]) {
    const r = gradeApp(passing({ reply: { ...passing().reply, added: said, text: said } }));
    assert.equal(okOf(r, "app_answered"), false, said);
    assert.equal(r.pass, false, said);
  }
});

test("app_answered fails when nothing at all came back", () => {
  // The app echoed the question into its transcript and then did nothing. The
  // page GREW, so a naive length comparison would call that a reply — the
  // prompt is subtracted for exactly this case.
  const r = gradeApp(passing({ reply: { ...passing().reply, added: DEFAULT_PROMPT, text: "Tutor " + DEFAULT_PROMPT } }));
  assert.equal(okOf(r, "app_answered"), false);
  assert.match(check(r, "app_answered").detail, /nothing came back/);
});

test("app_answered passes a short but real answer, and an observations record with no reply in it", () => {
  const short = gradeApp(passing({ reply: { ...passing().reply, added: "The sea is mostly water.", text: "The sea is mostly water." } }));
  assert.equal(okOf(short, "app_answered"), true);
  // A record produced before this check existed, or one whose page text could
  // not be read, must not be failed on a measurement that was never taken.
  const legacy = gradeApp(passing({ reply: null }));
  assert.equal(okOf(legacy, "app_answered"), true);
  assert.match(check(legacy, "app_answered").detail, /no reply was observed/);
});

test("THE SENTINEL'S REJECTION IS STILL NOISE — but a key that was never SENT is not", () => {
  // "Incorrect API key provided" means the key reached the provider and was
  // rejected: the sentinel working as designed, on every single run.
  assert.equal(isProviderNoise("Error: 401 Incorrect API key provided: sk-CAPT***"), true);
  assert.equal(isProviderNoise("POST https://api.openai.com/v1/chat/completions 401 (Unauthorized)"), true);
  // "You didn't provide an API key" means the Authorization header was absent
  // or malformed — the app collected a key and failed to put it on the wire.
  // #CAP-21's verdict recorded "6 provider/network messages ignored" and this
  // was one of them.
  for (const said of [
    "Error: 401 — You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth.",
    "401 https://api.openai.com/v1/chat/completions — you did not provide an api key",
    "Request failed: Authorization header is missing",
  ]) {
    assert.equal(isProviderNoise(said), false, said);
  }
  const r = gradeApp(
    passing({
      pageErrors: [{ text: "Error: 401 — You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth." }],
    }),
  );
  assert.equal(okOf(r, "no_page_errors"), false, "the evidence must reach the verdict instead of being filtered out");
});

test("every check can fail on its own, and each one alone fails the run", () => {
  const broken = {
    app_loads: { loaded: false },
    no_page_errors: { pageErrors: [{ text: "TypeError: boom", noise: false }] },
    key_field_masked: { keyFields: [{ index: 0, tag: "input", id: "k", type: "text", masked: false }] },
    key_not_revealed: { reveal: { ...passing().reveal, visibleText: true } },
    key_not_persisted: { reveal: { ...passing().reveal, localStorage: true } },
    app_interactive: { interaction: { ...passing().interaction, sendButton: null } },
    // Verbatim from #CAP-22's final frame. Every other check is green on this
    // app: it loads, throws nothing, masks its field, and its Send button
    // presses. It just does not work.
    app_answered: {
      reply: { ...passing().reply, added: "Error: could not get a response.", text: "Socratic Tutor Error: could not get a response." },
    },
  };
  for (const id of CHECK_IDS) {
    const r = gradeApp(passing(broken[id]));
    assert.equal(r.pass, false, `${id} alone must fail the run`);
    assert.deepEqual(
      r.checks.filter((c) => !c.ok).map((c) => c.id),
      [id],
      `${id} must fail ALONE — no other check may go red with it`,
    );
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], new RegExp(`^${id}: .+`), "a failure names its check and then explains itself");
  }
});

// ---------------------------------------------------------------------------
// Garbage in
// ---------------------------------------------------------------------------

test("garbage observations degrade to a clear fail rather than a throw", () => {
  for (const junk of [null, undefined, {}, [], "nope", 42, { keyFields: "not an array", reveal: null, interaction: 7 }]) {
    const r = gradeApp(junk);
    assert.equal(r.pass, false, `${JSON.stringify(junk)} must not pass`);
    assert.deepEqual(r.checks.map((c) => c.id), CHECK_IDS, "all six checks are reported whatever came in");
    assert.ok(r.failures.length >= 1);
    assert.ok(
      r.failures.some((f) => f.startsWith("app_loads:")),
      "an observations record with no page in it fails app_loads first",
    );
  }
});

test("a half-written record still grades the parts it has", () => {
  const r = gradeApp({ loaded: true, status: 200, bodyTextLength: 40, keyFields: [{ id: "k", type: "text" }] });
  assert.equal(okOf(r, "app_loads"), true);
  assert.equal(okOf(r, "key_field_masked"), false, "a field with no masked flag is not masked");
  assert.equal(okOf(r, "app_interactive"), false);
});

// ---------------------------------------------------------------------------
// isProviderNoise
// ---------------------------------------------------------------------------

test("isProviderNoise recognises the sentinel's rejection in every shape it arrives in", () => {
  for (const s of [
    "Failed to load resource: the server responded with a status of 401 ()",
    "POST https://api.openai.com/v1/models 401 (Unauthorized)",
    "TypeError: Failed to fetch",
    "net::ERR_CONNECTION_REFUSED",
    "Error: HTTP 403 forbidden",
    "Access to fetch at 'https://api.anthropic.com/v1/messages' has been blocked by CORS policy",
    "Incorrect API key provided: sk-CAPT***",
    "429 rate limit exceeded",
    "AbortError: The operation was aborted",
  ]) {
    assert.equal(isProviderNoise(s), true, s);
  }
});

test("isProviderNoise does not swallow a genuinely broken app", () => {
  for (const s of [
    "TypeError: DRKit.mountModelPicker is not a function",
    "ReferenceError: marked is not defined",
    "Uncaught SyntaxError: Unexpected token '<'",
    "Cannot read properties of null (reading 'appendChild')",
    "",
  ]) {
    assert.equal(isProviderNoise(s), false, s);
  }
});

test("isProviderNoise takes a console-message-shaped object too", () => {
  assert.equal(isProviderNoise({ text: "Failed to load resource" }), true);
  assert.equal(isProviderNoise({ text: "TypeError: x is not a function" }), false);
  assert.equal(isProviderNoise(null), false);
});

// ---------------------------------------------------------------------------
// formatAppVerdict
// ---------------------------------------------------------------------------

test("the verdict block reads as a verdict", () => {
  const r = { ...gradeApp(passing()), url: "https://deepresearch.se/app/some-slug/" };
  const out = formatAppVerdict(r);
  assert.match(out, /^app e2e ✓ PASS {2}7\/7 checks {2}https:\/\/deepresearch\.se\/app\/some-slug\//);
  for (const id of CHECK_IDS) assert.match(out, new RegExp(`✓ ${id}`));
  assert.equal(out.endsWith("\n"), true);
  assert.equal(/not published because/.test(out), false);
});

test("a failing verdict says what to do about it", () => {
  const r = {
    ...gradeApp(passing({ keyFields: [{ index: 0, tag: "input", id: "api-key", type: "text", masked: false }] })),
    slug: "socratic-tutor",
  };
  const out = formatAppVerdict(r);
  assert.match(out, /✗ FAIL {2}6\/7 checks {2}socratic-tutor/);
  assert.match(out, /not published because:/);
  assert.match(out, /- key_field_masked: .*input#api-key/);
});

test("formatAppVerdict survives garbage", () => {
  for (const junk of [null, undefined, {}, { checks: "no" }, { pass: true }]) {
    const out = formatAppVerdict(junk);
    assert.equal(typeof out, "string");
    assert.ok(out.endsWith("\n"));
  }
  assert.match(formatAppVerdict({}), /no checks/);
});

// ---------------------------------------------------------------------------
// exerciseApp — total, verified against fake pages (no browser here)
// ---------------------------------------------------------------------------

/** The timings, all collapsed: a unit test must not sit through 8 s of settling. */
const FAST = { settleMs: 0, afterKeyMs: 0, afterSendMs: 0, timeout: 50, navTimeout: 50 };

/**
 * A stand-in for a Playwright Page. `evaluate` dispatches on the page-side
 * function's NAME, which is how the orchestration can be tested without a
 * browser: the DOM half is exercised live (see the report), the sequencing here.
 */
function fakePage(script = {}) {
  const calls = [];
  const handlers = {};
  return {
    calls,
    /** fire a page event at whatever exerciseApp subscribed to it */
    emit(event, payload) {
      for (const fn of handlers[event] || []) fn(payload);
    },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    off(event, fn) {
      handlers[event] = (handlers[event] || []).filter((f) => f !== fn);
    },
    async goto(url) {
      calls.push(["goto", url]);
      if (script.gotoThrows) throw new Error("net::ERR_NAME_NOT_RESOLVED");
      for (const [event, payload] of script.events || []) {
        for (const fn of handlers[event] || []) fn(payload);
      }
      return { status: () => script.status ?? 200 };
    },
    async waitForLoadState() {},
    async evaluate(fn, args) {
      const name = typeof fn === "function" ? fn.name : String(fn);
      calls.push([name, args]);
      if (script[name] instanceof Error) throw script[name];
      if (typeof script[name] === "function") return script[name](args);
      return script[name] ?? null;
    },
    async fill(selector, value) {
      calls.push(["fill", selector, value]);
      if (script.fillThrows) throw new Error("element is not visible");
    },
    async click(selector) {
      calls.push(["click", selector]);
      if (script.clickThrows) throw new Error("element is not enabled");
    },
  };
}

test("exerciseApp never throws — not on a missing page, not on a dead one", async () => {
  const none = await exerciseApp(null, "https://example.invalid/app/x/", FAST);
  assert.equal(none.loaded, false);
  assert.match(none.errors[0].message, /no usable Playwright page/);
  assert.equal(gradeApp(none).pass, false);

  const dead = await exerciseApp(fakePage({ gotoThrows: true }), "https://example.invalid/app/x/", FAST);
  assert.equal(dead.loaded, false);
  assert.equal(dead.errors.some((e) => e.step === "goto"), true);
  assert.equal(gradeApp(dead).pass, false);

  const hostile = await exerciseApp(fakePage({ pageReadDoc: new Error("Execution context was destroyed") }), "u", FAST);
  assert.equal(hostile.errors.some((e) => e.step === "readDoc"), true);
});

test("exerciseApp types the sentinel into every key field it was shown", async () => {
  const page = fakePage({
    pageReadDoc: { title: "App", readyState: "complete", bodyTextLength: 400, htmlLength: 900, elements: 30, url: "u" },
    pageScanKeyFields: [
      { index: 0, id: "api-key", tag: "input", type: "password", textSecurity: "", matchedBy: "type+name" },
      { index: 1, id: "token", tag: "input", type: "text", textSecurity: "", matchedBy: "name" },
    ],
    pageReadMasking: [
      { index: 0, type: "password", textSecurity: "", valueLength: 40 },
      { index: 1, type: "text", textSecurity: "", valueLength: 40 },
    ],
    pageScanReveal: { origin: "null", storageErrors: [] },
    pageFindInteractive: { prompt: { tag: "textarea", id: "prompt" }, send: { tag: "button", id: "send", text: "Send" } },
  });
  const obs = await exerciseApp(page, "https://x/app/y/", FAST);

  const filled = page.calls.filter((c) => c[0] === "fill");
  assert.equal(filled.filter((c) => c[2] === SENTINEL_KEY).length, 2, "both key fields get the sentinel");
  assert.equal(filled.some((c) => c[2] === DEFAULT_PROMPT), true, "and the prompt goes into the prompt field");
  assert.equal(obs.sentinelTyped, 2);
  assert.equal(obs.interaction.clicked, true);

  const r = gradeApp(obs);
  assert.equal(okOf(r, "key_field_masked"), false, "the plain-text second field is the failure");
  assert.equal(okOf(r, "app_interactive"), true);
  assert.equal(okOf(r, "app_loads"), true);
});

test("exerciseApp remembers a leak seen by EITHER scan", async () => {
  // The status line that echoes the key is written when the provider answers,
  // which is after the first scan and before the second.
  let nth = 0;
  const page = fakePage({
    pageReadDoc: { title: "", readyState: "complete", bodyTextLength: 10, htmlLength: 20, elements: 3, url: "u" },
    pageScanKeyFields: [{ index: 0, id: "k", tag: "input", type: "password", textSecurity: "" }],
    pageReadMasking: [{ index: 0, type: "password", textSecurity: "", valueLength: 40 }],
    pageScanReveal: () => (nth++ === 0 ? { storageErrors: [] } : { visibleText: true, storageErrors: ["cookie: denied"] }),
    pageFindInteractive: { prompt: { tag: "input", id: "q" }, send: { tag: "button", id: "go", text: "Go" } },
  });
  const obs = await exerciseApp(page, "https://x/app/y/", FAST);
  assert.equal(obs.reveal.visibleText, true);
  assert.deepEqual(obs.reveal.storageErrors, ["cookie: denied"]);
  assert.equal(okOf(gradeApp(obs), "key_not_revealed"), false);
});

test("exerciseApp falls back to a forced click, and records the failure when even that misses", async () => {
  const page = fakePage({
    pageReadDoc: { title: "", readyState: "complete", bodyTextLength: 10, htmlLength: 20, elements: 3, url: "u" },
    pageScanKeyFields: [],
    pageScanReveal: { storageErrors: [] },
    pageFindInteractive: { prompt: { tag: "input", id: "q" }, send: { tag: "button", id: "go", text: "Go" } },
    clickThrows: true,
  });
  const obs = await exerciseApp(page, "https://x/app/y/", FAST);
  assert.equal(obs.interaction.clicked, false);
  assert.match(obs.interaction.error, /button#go .*failed: element is not enabled/);
  assert.equal(okOf(gradeApp(obs), "app_interactive"), false);
  assert.equal(okOf(gradeApp(obs), "key_field_masked"), true, "no key field is still a pass");
});

test("a file the BUILD shipped that never loaded FAILS the run — an inert app is a broken app", async () => {
  // The real case (2026-08-11): one published app loads its `<script
  // type="module">` from its own directory, which is fetched in CORS mode and
  // blocked by the opaque-origin sandbox. The page renders, throws nothing, and
  // does nothing — its buttons have no handlers.
  //
  // This started as a report that did not affect the verdict, and that was too
  // weak: the whole point of the gate is to keep a clip of a build that does
  // not work out of the deck, and an app whose own script never loaded is
  // exactly that. It fails.
  const page = fakePage({
    pageReadDoc: { title: "T", readyState: "complete", bodyTextLength: 60, htmlLength: 900, elements: 20, url: "u" },
    pageScanKeyFields: [],
    pageScanReveal: { storageErrors: [] },
    pageFindInteractive: { prompt: { tag: "textarea", id: "input" }, send: { tag: "button", id: "send", text: "Send" } },
    events: [
      ["requestfailed", { url: () => "https://x/app/y/js/app.js", failure: () => ({ errorText: "net::ERR_FAILED" }) }],
      ["requestfailed", { url: () => "https://api.openai.com/v1/models", failure: () => ({ errorText: "net::ERR_FAILED" }) }],
      ["response", { url: () => "https://x/app/y/css/style.css", status: () => 404 }],
    ],
  });
  const obs = await exerciseApp(page, "https://x/app/y/", FAST);

  assert.deepEqual(
    obs.assetFailures.map((a) => a.url),
    ["https://x/app/y/js/app.js", "https://x/app/y/css/style.css"],
    "the provider's own failed request is not the app's file",
  );
  assert.equal(obs.network.failed.length, 2);

  const r = gradeApp(obs);
  assert.equal(okOf(r, "app_loads"), false, "an app whose own files never loaded is not a working app");
  assert.equal(r.pass, false, "and the capture must not be published");
  assert.match(check(r, "app_loads").detail, /2 of its own files did not load/);
  assert.match(check(r, "app_loads").detail, /app\.js net::ERR_FAILED/);
  assert.match(check(r, "app_loads").detail, /inert/);
});

test("app_loads says nothing about assets when every file arrived", () => {
  assert.equal(/own file/.test(check(gradeApp(passing()), "app_loads").detail), false);
  assert.equal(/own file/.test(check(gradeApp(passing({ assetFailures: [] })), "app_loads").detail), false);
});

test("the exercise's documented defaults are the ones it uses", () => {
  assert.equal(EXERCISE_DEFAULTS.timeout > 0, true);
  assert.equal(EXERCISE_DEFAULTS.navTimeout >= EXERCISE_DEFAULTS.timeout, true);
  assert.ok(DEFAULT_PROMPT.length > 0 && DEFAULT_PROMPT.length < 120);
});

test("the sandbox denying storage is the checker's own probe, not the app throwing", () => {
  // /app/<slug>/ is an opaque origin, so reading storage throws a
  // SecurityError — and key_not_persisted's probe is what provokes it.
  // Chromium reports it on the page-error channel too, so without this filter
  // EVERY generated app fails no_page_errors on an error the checker caused.
  // Observed live: two builds whose source contains the string "storage"
  // zero times both failed with exactly this message.
  const denial =
    "SecurityError: Failed to read the 'localStorage' property from 'Window': " +
    "The document is sandboxed and lacks the 'allow-same-origin' flag.";
  assert.equal(isProviderNoise(denial), true);
  assert.equal(
    isProviderNoise("SecurityError: Failed to read the 'sessionStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag."),
    true,
  );
  // A real app error must still count. The filter is about one specific
  // sandbox denial, not about SecurityErrors in general.
  assert.equal(isProviderNoise("TypeError: cannot read properties of null"), false);
  assert.equal(isProviderNoise("SecurityError: The operation is insecure"), false);
  assert.equal(isProviderNoise("ReferenceError: DRKit is not defined"), false);
});
