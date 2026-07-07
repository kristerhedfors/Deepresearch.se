import { test } from "node:test";
import assert from "node:assert/strict";

import { buildResearchDebugJson } from "./activity.js";

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

test("buildResearchDebugJson surfaces map figures, deduped by url", () => {
  const turn = {
    question: "where is the Eiffel Tower?",
    researchLog: [
      { t: 10, type: "map", id: "maps", images: [
        { kind: "map", label: "Eiffel Tower", url: "/api/maps/static?lat=48.8584&lon=2.2945" },
        { kind: "streetview", label: "Eiffel Tower", url: "/api/maps/streetview?lat=48.8584&lon=2.2945" },
      ] },
      { t: 20, type: "map", id: "maps", images: [
        { kind: "map", label: "Eiffel Tower", url: "/api/maps/static?lat=48.8584&lon=2.2945" }, // dup
      ] },
    ],
  };
  const out = buildResearchDebugJson(turn);
  assert.equal(out.maps.length, 2);
  assert.deepEqual(out.maps.map((m) => m.kind), ["map", "streetview"]);
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
    maps: [],
    answer: "",
    answerChars: 0,
    errored: false,
    errors: [],
    timeline: [],
  });
  // JSON-serializable (the whole point — it gets copied to the clipboard).
  assert.doesNotThrow(() => JSON.stringify(out));
});
