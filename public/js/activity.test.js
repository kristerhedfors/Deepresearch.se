import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildResearchDebugJson,
  formatStatsLine,
  sanitizeResearchEvent,
  searchServiceName,
  shellRunOutputText,
  zoomToFov,
} from "./activity-core.js";

// A turn whose researchLog mirrors what stream.js's recordResearchEvent
// accumulates from the SSE status events, including the geocode and Shodan
// service-lookup steps that name which external source was contacted.
function sampleTurn() {
  return {
    question: "Who runs example.com and where was this photo taken?",
    model: "mistralai/Mistral-Small",
    text: "The answer body.",
    doneStats: {
      type: "done",
      model: "mistralai/Mistral-Small",
      rounds: 2,
      searches: 3,
      duration_ms: 6400,
      prompt_tokens: 1200,
      completion_tokens: 90,
    },
    researchLog: [
      { t: 10, type: "step_start", id: "geocode", label: "Resolving photo location (OpenStreetMap)…" },
      { t: 900, type: "step_done", id: "geocode", label: "Resolved 1 photo location via OpenStreetMap Nominatim", details: ["photo.jpg: near Stockholm, Sweden"] },
      { t: 950, type: "step_start", id: "shodan", label: "Querying Shodan…" },
      { t: 1800, type: "step_done", id: "shodan", label: "Shodan: 1 host found", details: ["93.184.216.34 — 2 ports"] },
      { t: 1850, type: "step_start", id: "plan", label: "Analyzing request…" },
      { t: 2200, type: "step_done", id: "plan", label: "Planned 2 search angles", details: ["who owns example.com", "example.com hosting"] },
      { t: 2300, type: "search_start", round: 1, query: "who owns example.com" },
      { t: 3100, type: "search_done", round: 1, query: "who owns example.com", results: 2, duration_ms: 800, sources: [
        { title: "IANA — example.com", url: "https://iana.org/domains/example" },
        { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Example.com" },
      ] },
      { t: 3200, type: "search_done", round: 1, query: "example.com hosting", results: 1, duration_ms: 640, sources: [
        { title: "IANA — example.com", url: "https://iana.org/domains/example" }, // dup url
      ] },
    ],
  };
}

test("buildResearchDebugJson captures question, model and final stats", () => {
  const out = buildResearchDebugJson(sampleTurn());
  assert.equal(out.question, "Who runs example.com and where was this photo taken?");
  assert.equal(out.model, "mistralai/Mistral-Small");
  assert.deepEqual(out.stats, {
    model: "mistralai/Mistral-Small",
    rounds: 2,
    searches: 3,
    duration_ms: 6400,
    prompt_tokens: 1200,
    completion_tokens: 90,
  });
  assert.equal(out.answerChars, "The answer body.".length);
});

test("buildResearchDebugJson includes the full resulting generation", () => {
  const turn = sampleTurn();
  turn.text = "The full answer, with [1] citations and a Sources list.";
  const out = buildResearchDebugJson(turn);
  assert.equal(out.answer, "The full answer, with [1] citations and a Sources list.");
  assert.equal(out.answerChars, turn.text.length);
  assert.equal(out.errored, false);
  assert.deepEqual(out.errors, []);
});

test("buildResearchDebugJson surfaces every error (server and client) and the errored flag", () => {
  const turn = sampleTurn();
  turn.errored = true;
  turn.text = "partial answer\n\n[Network error: connection lost (ref a1b2c3d4)]";
  turn.researchLog.push({ t: 4000, event: "error", error: "Worker error: Berget returned an empty response" });
  turn.researchLog.push({ t: 9000, event: "error", error: "Network error: connection lost (ref a1b2c3d4)" });
  const out = buildResearchDebugJson(turn);
  assert.equal(out.errored, true);
  assert.deepEqual(out.errors, [
    "Worker error: Berget returned an empty response",
    "Network error: connection lost (ref a1b2c3d4)",
  ]);
  // The generation (including the appended error marker) rides along too.
  assert.ok(out.answer.includes("[Network error: connection lost (ref a1b2c3d4)]"));
});

test("buildResearchDebugJson projects the completed steps, naming each service", () => {
  const out = buildResearchDebugJson(sampleTurn());
  const ids = out.steps.map((s) => s.id);
  assert.deepEqual(ids, ["geocode", "shodan", "plan"]);
  const geocode = out.steps.find((s) => s.id === "geocode");
  assert.match(geocode.label, /OpenStreetMap Nominatim/);
  assert.deepEqual(geocode.details, ["photo.jpg: near Stockholm, Sweden"]);
  assert.ok(out.steps.some((s) => s.id === "shodan" && /Shodan/.test(s.label)));
});

test("buildResearchDebugJson lists searches with queries, timings and results", () => {
  const out = buildResearchDebugJson(sampleTurn());
  assert.equal(out.searches.length, 2);
  assert.deepEqual(out.searches[0], {
    round: 1,
    query: "who owns example.com",
    // Provider identity (2026-07-08): events without source/service (older
    // stored turns) project as plain web searches.
    source: "web",
    service: "Web search",
    results: 2,
    duration_ms: 800,
    sources: [
      { title: "IANA — example.com", url: "https://iana.org/domains/example" },
      { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Example.com" },
    ],
  });
});

test("buildResearchDebugJson dedups sources by URL across rounds", () => {
  const out = buildResearchDebugJson(sampleTurn());
  const urls = out.sources.map((s) => s.url);
  assert.deepEqual(urls, [
    "https://iana.org/domains/example",
    "https://en.wikipedia.org/wiki/Example.com",
  ]);
});

test("buildResearchDebugJson keeps the full ordered timeline", () => {
  const out = buildResearchDebugJson(sampleTurn());
  assert.equal(out.timeline.length, 9);
  assert.equal(out.timeline[0].id, "geocode");
  assert.equal(out.timeline[0].type, "step_start");
  // Timestamps are monotonic relative offsets.
  const ts = out.timeline.map((e) => e.t);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test("buildResearchDebugJson is safe on an empty turn", () => {
  const out = buildResearchDebugJson({});
  assert.deepEqual(out, {
    question: "",
    model: "",
    stats: null,
    steps: [],
    searches: [],
    sources: [],
    answer: "",
    answerChars: 0,
    errored: false,
    errors: [],
    timeline: [],
  });
  // JSON-serializable (the whole point — it gets copied to the clipboard).
  assert.doesNotThrow(() => JSON.stringify(out));
});

// ---- sanitizeResearchEvent --------------------------------------------------

test("sanitizeResearchEvent compacts streetview_frames (drops the data URLs, keeps count + directions)", () => {
  const out = sanitizeResearchEvent({
    type: "streetview_frames",
    query: "Maskinistvägen 11",
    frames: [
      { dir: "north", url: "data:image/jpeg;base64," + "A".repeat(100_000) },
      { dir: "east", url: "data:image/jpeg;base64," + "B".repeat(100_000) },
    ],
  });
  assert.deepEqual(out, { type: "streetview_frames", query: "Maskinistvägen 11", frames: 2, directions: ["north", "east"] });
  // The whole point: the compacted record must be tiny.
  assert.ok(JSON.stringify(out).length < 200);
});

test("sanitizeResearchEvent compacts quiz events (question count + title, never the question set)", () => {
  const out = sanitizeResearchEvent({
    type: "quiz",
    quiz: {
      title: "Nordic capitals",
      intro: "Ready?",
      questions: Array.from({ length: 5 }, () => ({
        question: "q".repeat(200),
        alternatives: ["a", "b", "c"],
        correct: 0,
        explanation: "e".repeat(200),
      })),
    },
  });
  assert.deepEqual(out, { type: "quiz", title: "Nordic capitals", questions: 5 });
});

test("sanitizeResearchEvent passes every other event through unchanged", () => {
  const done = { type: "search_done", round: 1, query: "q", results: 2, duration_ms: 5, sources: [] };
  assert.equal(sanitizeResearchEvent(done), done); // same reference — untouched
  const embed = { type: "streetview_embed", lat: 59.4, lng: 17.9 };
  assert.equal(sanitizeResearchEvent(embed), embed);
});

test("zoomToFov maps SDK zoom to the Static API's fov range (10-120)", () => {
  assert.equal(zoomToFov(0), 120); // 180/1 = 180, clamped to 120
  assert.equal(zoomToFov(1), 90); // 180/2
  assert.equal(zoomToFov(2), 45); // 180/4
  assert.equal(zoomToFov(5), 10); // 180/32 ≈ 5.6, clamped up to 10
  assert.equal(zoomToFov(undefined), 90); // non-finite defaults to zoom 1
  assert.equal(zoomToFov("x"), 90);
});

// ---- shellRunOutputText (the expanded sandbox command's output body) --------

test("shellRunOutputText returns stdout alone when there's no stderr", () => {
  assert.equal(shellRunOutputText({ stdout: "bin\nboot\n", stderr: "" }), "bin\nboot");
});

test("shellRunOutputText returns stderr alone when there's no stdout", () => {
  assert.equal(shellRunOutputText({ stdout: "", stderr: "No such file\n" }), "No such file");
});

test("shellRunOutputText labels both streams when both are present", () => {
  assert.equal(
    shellRunOutputText({ stdout: "ok\n", stderr: "warn\n" }),
    "stdout:\nok\n\nstderr:\nwarn",
  );
});

test("shellRunOutputText reports no output explicitly, and is safe on junk", () => {
  assert.equal(shellRunOutputText({ stdout: "", stderr: "" }), "(no output)");
  assert.equal(shellRunOutputText(null), "(no output)");
  assert.equal(shellRunOutputText({}), "(no output)");
});

test("searchServiceName prefers the event's service, falling back to web wording", () => {
  assert.equal(searchServiceName({ service: "Hugging Face Hub" }), "Hugging Face Hub");
  assert.equal(searchServiceName({}), "Web search");
  assert.equal(searchServiceName(null), "Web search");
});

test("formatStatsLine builds the footer, omitting absent parts and pluralizing", () => {
  assert.equal(
    formatStatsLine({ model: "mistralai/Mistral-Small", duration_ms: 3400, prompt_tokens: 10, completion_tokens: 5, searches: 2 }),
    "Mistral-Small · 3.4 s · 15 tokens · 2 searches",
  );
  assert.equal(formatStatsLine({ searches: 1 }), "1 search");
  assert.equal(formatStatsLine({}), "");
});
