// Unit tests for the research tool runners (src/research-tools-run.js).
//
// Two properties are worth more than the rest here, and both are invisible in a
// passing manual run:
//
//  · **The bookkeeping.** A model-issued search must leave the request in the
//    same state a planned one did — counters src/billing.js prices, the issued-
//    query ledger the writer attests to, and the `search_start`/`search_done`
//    pair every source panel and eval harness reconstructs the registry from. A
//    leg that skips any of them still answers the user and still breaks
//    billing, citations or the trail silently.
//  · **It never throws.** The caller is a tool loop mid-answer, so an exception
//    costs the whole turn. Every failure has to arrive as a sentence.
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  REFUSAL_EXIT,
  execEnvironmentFor,
  runResearchTool,
  sampleQueryFromArgs,
} from "./research-tools-run.js";
import { admitToolCall, newToolBudget } from "./tool-admission.js";
import { ExecSandbox } from "./exec-container.js";
import { SAMPLES_LAYOUT, parseSamples } from "../public/js/aadr-core.js";
import { EXEC_CEILING_MS, STEP_BUDGET_MS } from "../public/js/lypning-core.js";
import { SAMPLES_PATH } from "./aadr.js";
import { fakeLog } from "./test-helpers/env.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

/** The request state slice the runners read and write. */
function researchState(over = {}) {
  return {
    startedAt: Date.now(),
    searchCount: 0,
    cachedSearchCount: 0,
    ranQueries: new Set(),
    sources: [],
    byUrl: new Map(),
    denseTotals: { embedTokens: 0, rerankTokens: 0, embedCalls: 0, rerankCalls: 0 },
    plan: { maxSearches: 8, maxSources: 18, digestCap: 14_000, searchDepth: { numResults: 5, type: "auto", costMultiplier: 1 } },
    ...over,
  };
}

/** A ctx that records every SSE status the runner emits. */
function ctx(state, over = {}) {
  /** @type {any[]} */
  const events = [];
  return { rctx: { state, emit: (/** @type {any} */ e) => events.push(e.status), round: 1, ...over }, events };
}

const exaHit = {
  results: [
    { title: "Vattenfall annual report", url: "https://vattenfall.example/report", highlights: ["2.1 TWh in 2025"] },
    { title: "SVT: elpriset", url: "https://svt.example/el", highlights: ["priserna sjönk"] },
  ],
};

describe("web_search", () => {
  test("registers sources and leaves the request billable", async () => {
    const state = researchState();
    const { rctx } = ctx(state);
    const r = await withFakeFetch([[/api\.exa\.ai\/search/, exaHit]], () =>
      runResearchTool(/** @type {any} */ ({ EXA_API_KEY: "k" }), fakeLog(), "web_search", { queries: ["elpris sverige", "vattenfall 2025"] }, rctx),
    );
    assert.equal(r.isError, false);
    assert.equal(r.found, true);
    // Billing and quota read these; a search that does not increment them is a
    // free search.
    assert.equal(state.searchCount, 2);
    assert.deepEqual([...state.issuedQueries], ["elpris sverige", "vattenfall 2025"]);
    // The registry the writer cites from.
    assert.equal(state.sources.length, 2, "both results registered once, deduped by URL");
    assert.match(r.text, /vattenfall\.example/);
  });

  test("every event carries the provider it came from", async () => {
    // A user report showed hub and web cards rendering identically; `source` and
    // `service` are what tell them apart, and they are also what the eval
    // harnesses reconstruct the registry from.
    const state = researchState();
    const { rctx, events } = ctx(state);
    await withFakeFetch([[/api\.exa\.ai/, exaHit]], () =>
      runResearchTool(/** @type {any} */ ({ EXA_API_KEY: "k" }), fakeLog(), "web_search", { queries: ["q1"] }, rctx),
    );
    assert.deepEqual(events.map((e) => e.type), ["search_start", "search_done"]);
    for (const e of events) {
      assert.equal(e.source, "web");
      assert.equal(e.service, "Web search");
      assert.equal(e.query, "q1");
      assert.equal(e.round, 1);
    }
    assert.equal(events[1].results, 2);
  });

  test("a dead provider degrades to an empty leg, not an error", async () => {
    const state = researchState();
    const { rctx, events } = ctx(state);
    const r = await withFakeFetch([[/api\.exa\.ai/, new Response("boom", { status: 500 })]], () =>
      runResearchTool(/** @type {any} */ ({ EXA_API_KEY: "k" }), fakeLog(), "web_search", { queries: ["q"] }, rctx),
    );
    assert.equal(r.isError, false);
    assert.equal(r.found, false);
    assert.equal(r.sourcesAdded, 0);
    // The card still resolves: a leg that vanishes reads as a leg that never ran.
    assert.equal(events.length, 2);
  });

  test("the request's standing web caveat rides on every item", async () => {
    // feedback #69: an agent whose evidence is a peer-reviewed corpus needs its
    // web leg to arrive visibly labelled as the weaker thing it is. The wave
    // path stamps it in labelWebItems; a model-issued leg must not be the hole
    // in that rule.
    const state = researchState({ webSourceNote: "Web reporting, not peer-reviewed" });
    const { rctx } = ctx(state);
    await withFakeFetch([[/api\.exa\.ai/, exaHit]], () =>
      runResearchTool(/** @type {any} */ ({ EXA_API_KEY: "k" }), fakeLog(), "web_search", { queries: ["q"] }, rctx),
    );
    assert.equal(state.sources[0].highlights[0], "Web reporting, not peer-reviewed");
  });

  test("a model-chosen deep search raises what the request is billed at", async () => {
    // src/billing.js prices EVERY billed search of a request at one tier
    // (plan.searchDepth.costMultiplier). A deep leg that changed only the wire
    // argument would run at Exa's deep price and be billed at the standard one.
    const state = researchState();
    const { rctx } = ctx(state);
    await withFakeFetch([[/api\.exa\.ai/, exaHit]], () =>
      runResearchTool(/** @type {any} */ ({ EXA_API_KEY: "k" }), fakeLog(), "web_search", { queries: ["q"], depth: "deep" }, rctx),
    );
    assert.equal(state.plan.searchDepth.type, "deep");
    assert.ok(state.plan.searchDepth.costMultiplier > 1);
  });
});

describe("read_pages", () => {
  // Long enough to clear src/named-urls.js's minimum extracted length: a page
  // that reduces to a couple of sentences is skipped as a nav shell rather than
  // registered as a source.
  const body = "Supported CUDA versions are 12.1 and 12.4, and the last release was tagged in March. ".repeat(12);
  const html = `<html><head><title>Barracuda</title></head><body><p>${body}</p></body></html>`;
  const page = () => new Response(html, { headers: { "content-type": "text/html" } });

  test("reads a page directly, registers it, and pays for its digest room", async () => {
    const state = researchState();
    const before = state.plan.maxSources;
    const { rctx, events } = ctx(state);
    const r = await withFakeFetch([[/github\.example/, () => page()]], () =>
      runResearchTool(/** @type {any} */ ({}), fakeLog(), "read_pages", { urls: ["https://github.example/repo"] }, rctx),
    );
    assert.equal(r.found, true);
    assert.match(r.text, /CUDA/);
    assert.equal(state.sources.length, 1);
    // Widened together with the registry: a page the model asked for by name
    // must not be pushed out of the digest by results that arrived first
    // (feedback #61).
    assert.equal(state.plan.maxSources, before + 1);
    assert.ok(state.plan.digestCap > 14_000);
    assert.equal(events[0].source, "named-urls");
    assert.equal(events[0].service, "Direct page read");
  });

  test("an unreadable page is absent, and the result says so instead of inventing one", async () => {
    const state = researchState();
    const { rctx } = ctx(state);
    const r = await withFakeFetch([[/./, new Response("nope", { status: 403 })]], () =>
      runResearchTool(/** @type {any} */ ({}), fakeLog(), "read_pages", { urls: ["https://blocked.example/x"] }, rctx),
    );
    assert.equal(r.isError, false, "a page that refuses us is not a tool failure");
    assert.equal(r.found, false);
    assert.match(r.text, /Nothing was invented/);
    assert.equal(state.sources.length, 0);
  });
});

describe("source_search", () => {
  const hubRoutes = [
    [/huggingface\.co\/api\/models/, [{ id: "acme/mistral-7b-gguf", downloads: 400, likes: 9, pipeline_tag: "text-generation" }]],
    [/huggingface\.co\/api\/datasets/, []],
    [/huggingface\.co\/api\/papers/, []],
  ];

  test("one named source, with the same bookkeeping the wave path commits", async () => {
    const state = researchState();
    const before = state.plan.maxSources;
    const { rctx, events } = ctx(state);
    const r = await withFakeFetch(/** @type {any} */ (hubRoutes), () =>
      runResearchTool(/** @type {any} */ ({}), fakeLog(), "source_search", { source: "hf", query: "quantized mistral weights" }, rctx),
    );
    assert.equal(r.found, true);
    assert.equal(state.sources.length, 1);
    assert.equal(state.sources[0].url, "https://huggingface.co/acme/mistral-7b-gguf");
    assert.ok(state.issuedQueries.size, "an aux leg's query is an issued search too");
    // The registry-capacity reserve, once per source.
    assert.ok(state.plan.maxSources > before);
    assert.equal(events[0].source, "hf");
    assert.equal(events[0].service, "Hugging Face Hub");
    assert.equal(events[1].type, "search_done");
    assert.equal(events[1].results, 1);
  });

  test("an empty result is reported as an empty result, not as a failure", async () => {
    // The distinction src/literature-tools.js's RETRIEVAL_NOTE exists for: a
    // model told "the search failed" retries; a model told "the source was
    // asked and had nothing" reports the record as silent, which is the true
    // statement.
    const state = researchState();
    const { rctx, events } = ctx(state);
    const r = await withFakeFetch([[/huggingface\.co/, []]], () =>
      runResearchTool(/** @type {any} */ ({}), fakeLog(), "source_search", { source: "hf", query: "nothing at all" }, rctx),
    );
    assert.equal(r.isError, false);
    assert.equal(r.found, false);
    assert.match(r.text, /empty result, not a failure/);
    assert.equal(events.length, 2, "the card still resolves");
  });

  test("an unknown source is refused in words", async () => {
    const { rctx } = ctx(researchState());
    const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), "source_search", { source: "nope", query: "x" }, rctx);
    assert.equal(r.isError, true);
    assert.match(r.text, /no source called/);
  });
});

// ---- the ancient-sample corpus --------------------------------------------

const FIXTURE = {
  spec: "aadr-samples/1",
  layout: SAMPLES_LAYOUT,
  source: { name: "test corpus" },
  counts: { total: 3, ancient: 3, modern: 0 },
  dict: {
    group: ["Sweden_Gotland_PittedWare", "Russia_EBA_Yamnaya_Samara", "Ignore_Sweden_contam"],
    country: ["Sweden", "Russia"],
    place: ["Gotland, Västerbjers", "Samara Oblast, Lopatino II"],
    pkg: ["2020_TestStudy"],
    pub: ["TestStudy2020"],
  },
  packageDesc: {},
  rows: [
    "GOT01\t0\t0\t0\t57500\t18500\t1\t-2800\t-2738\t-2700\t4200\tU5b2a2\t\t2\t1150000\t1445\t0\t0",
    "SAM01\t1\t1\t1\t53200\t50100\t2\t-2950\t-2900\t-2850\t\t\tR1b1a1a2a\t1\t996000\t532\t0\t0",
    "BAD01\t2\t0\t0\t57500\t18500\t1\t-2800\t-2738\t-2700\t4200\tU5b2a2\t\t2\t900000\t900\t0\t0",
  ].join("\n"),
};
const D = /** @type {any} */ (parseSamples(FIXTURE));

/** An env whose ASSETS binding serves the fixture corpus. */
const samplesEnv = () => ({
  ASSETS: {
    async fetch(/** @type {Request} */ req) {
      return String(req.url).endsWith(SAMPLES_PATH)
        ? new Response(JSON.stringify(FIXTURE), { headers: { "content-type": "application/json" } })
        : new Response("no", { status: 404 });
    },
  },
});

describe("sampleQueryFromArgs — the structured entry point the core lacks", () => {
  test("a place anchors a radius on the corpus's own samples", () => {
    const q = sampleQueryFromArgs(D, { near: "Gotland", radius_km: 100 });
    assert.ok(q.near, "the place resolved");
    assert.equal(q.near?.km, 100);
    assert.equal(q.places, null, "a radius replaces the place filter rather than ANDing with it");
    assert.match(q.notes.join(" "), /no geocoder/);
  });

  test("a lowercase place still resolves", () => {
    // matchEntities requires a capital on a single-word place because it
    // normally reads a sentence full of ordinary words. A structured argument
    // is the place name, so the heuristic must not cost us "gotland".
    assert.ok(sampleQueryFromArgs(D, { near: "gotland" }).near);
  });

  test("a location the corpus cannot anchor is REPORTED, never silently dropped", () => {
    // "no samples near there" and "the place was never resolved" are different
    // findings and only one of them is true.
    const q = sampleQueryFromArgs(D, { near: "Reykjavik", radius_km: 50 });
    assert.equal(q.near, null);
    assert.match(q.notes.join(" "), /could not be anchored/);
  });

  test("a date window is an interval in calendar years, either bound optional", () => {
    const q = sampleQueryFromArgs(D, { from_year: -3000, to_year: -2500 });
    assert.deepEqual([q.when?.from, q.when?.to], [-3000, -2500]);
    // Reversed bounds are read as the window they describe rather than refused.
    const flipped = sampleQueryFromArgs(D, { from_year: -2500, to_year: -3000 });
    assert.deepEqual([flipped.when?.from, flipped.when?.to], [-3000, -2500]);
    assert.equal(sampleQueryFromArgs(D, {}).when, null);
  });

  test("the corpus conventions survive the structured form", () => {
    const q = sampleQueryFromArgs(D, { y_haplogroup: "R1b", mt_haplogroup: "U5", sex: "F", min_coverage: 5 });
    assert.equal(q.haplo.y, "R1b");
    assert.equal(q.haplo.mt, "U5");
    assert.equal(q.sex, 2, "F is genetically female (sex code 2)");
    assert.equal(q.minCoverage, 5);
    assert.equal(q.includeIgnored, false, "Ignore_ rows stay out unless asked for");
    assert.equal(q.ancientOnly, true, "present-day reference individuals stay out");
  });
});

describe("ancient_samples", () => {
  test("answers from the committed corpus with no outbound request at all", async () => {
    const { rctx } = ctx(researchState());
    const r = await withFakeFetch([[/./, () => { throw new Error("the corpus tool must not reach the network"); }]], () =>
      runResearchTool(/** @type {any} */ (samplesEnv()), fakeLog(), "ancient_samples", { near: "Gotland", radius_km: 200 }, rctx),
    );
    assert.equal(r.isError, false);
    assert.equal(r.found, true);
    assert.match(r.text, /GOT01/);
    assert.match(r.text, /Excluded 1 individuals whose population label is prefixed Ignore_/);
  });

  test("a deployment without the artifact says so rather than answering from memory", async () => {
    const { rctx } = ctx(researchState());
    const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), "ancient_samples", {}, rctx);
    assert.equal(r.isError, true);
    assert.match(r.text, /not available on this deployment/);
  });
});

describe("run_python — it runs in the sandbox, or it says it did not", () => {
  test("with no execution environment bound, nothing runs and nothing is guessed", async () => {
    // The browser VM and the local runner are browser-direct: a Worker in the
    // middle of an answer cannot reach either, and there is no Worker-side
    // Python to fall back to.
    const { rctx } = ctx(researchState());
    const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), "run_python", { source: "print(2+2)" }, rctx);
    assert.equal(r.isError, true);
    assert.match(r.text, /No execution environment is bound/);
    assert.match(r.text, /nothing was computed/);
  });

  test("a bound DREE/1 runner wins over anything the server could offer", () => {
    const exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const env = execEnvironmentFor(/** @type {any} */ ({ EXEC_SANDBOX: {} }), fakeLog(), /** @type {any} */ ({ exec, identity: { id: 1, user: {} } }));
    assert.equal(env?.run, exec, "the browser-direct runner keeps the program off this server");
  });

  test("a refusal is a fork: the same program is retried on CPython and both are reported", async () => {
    /** @type {string[]} */
    const commands = [];
    const exec = async (/** @type {string} */ command) => {
      commands.push(command);
      return commands.length === 1
        ? { exitCode: REFUSAL_EXIT, stdout: "", stderr: "drpy-engine:lypning\nlypning: unsupported: module: subprocess\n" }
        : { exitCode: 0, stdout: "drpy-engine:python3\n" && "4\n", stderr: "drpy-engine:python3\n" };
    };
    const { rctx } = ctx(researchState(), { exec, execLabel: "the test runner" });
    const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), "run_python", { source: "import subprocess" }, rctx);
    assert.equal(commands.length, 2);
    assert.match(commands[1], /\[ -x \/usr\/bin\/python3 \]/);
    assert.equal(commands[1].includes("command -v lypning"), false, "the retry is forced onto CPython");
    assert.match(r.text, /lypning refused this program \(module: subprocess\)/);
    assert.match(r.text, /Ran on python3/);
    assert.equal(r.text.includes("drpy-engine:"), false, "the engine marker is stripped before the model reads it");
    assert.equal(r.isError, false);
  });

  test("a program that answers is not retried", async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      return { exitCode: 1, stdout: "", stderr: "drpy-engine:lypning\nTraceback (most recent call last):\nZeroDivisionError\n" };
    };
    const { rctx } = ctx(researchState(), { exec });
    const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), "run_python", { source: "1/0" }, rctx);
    assert.equal(calls, 1, "a traceback is the program's own result, not the engine refusing");
    assert.equal(r.isError, true);
    assert.match(r.text, /ZeroDivisionError/);
  });

  test("an exploding runner becomes a sentence", async () => {
    const { rctx } = ctx(researchState(), { exec: async () => { throw new Error("VM gone"); } });
    const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), "run_python", { source: "print(1)" }, rctx);
    assert.equal(r.isError, true);
    assert.match(r.text, /VM gone/);
  });
});

// ---- run_python over the Se/rver container ---------------------------------
//
// The one server-side environment the loop can reach on its own. Faked at the
// BINDING level — a real ExecSandbox over a container double, the same doubles
// src/exec-container.test.js drives — so the test crosses every seam a
// production call crosses: admission → the runner → execEnvironmentFor →
// handleExecApi → the Durable Object → `bash -lc` → the ladder's marker parse.
// Anything intercepted higher up would let those seams drift apart unnoticed.

/** An identity whose account turned the execution-sandbox knob on/off — what
 * bashLiteEnabled reads (a user row with no stored settings is OFF). */
const knobOn = /** @type {any} */ ({ id: "u1", user: { id: "u1", settings_json: '{"bash_lite_mcp":true}' } });
const knobOff = /** @type {any} */ ({ id: "u1", user: { id: "u1" } });

/**
 * An env whose EXEC_SANDBOX namespace routes into a real ExecSandbox over a
 * container double, recording what crossed the wire: the Durable Object names
 * addressed, the parsed /exec bodies forwarded to the DO, and every argv the
 * container was asked to run.
 * @param {(command: string) => {exitCode?: number, stdout?: string, stderr?: string}} [handler]
 */
function containerEnv(handler) {
  const seen = { names: /** @type {string[]} */ ([]), bodies: /** @type {any[]} */ ([]), argv: /** @type {string[][]} */ ([]) };
  const enc = new TextEncoder();
  const container = {
    running: false,
    start() {
      this.running = true;
    },
    async destroy() {
      this.running = false;
    },
    async exec(/** @type {string[]} */ argv) {
      if (!this.running) throw new Error("container is not running");
      seen.argv.push(argv);
      // The readiness probe (["true"]) succeeds silently; a real command runs
      // through the handler, which plays the sandbox image's part.
      const planned = argv[0] === "true" ? {} : (handler ? handler(String(argv[2] || "")) : {});
      const exitCode = planned.exitCode ?? 0;
      return {
        pid: 1,
        exitCode: Promise.resolve(exitCode),
        kill() {},
        output: () =>
          Promise.resolve({ stdout: enc.encode(planned.stdout ?? ""), stderr: enc.encode(planned.stderr ?? ""), exitCode }),
      };
    },
  };
  const map = new Map();
  const sandbox = new ExecSandbox(
    {
      container,
      storage: {
        async get(/** @type {string} */ k) {
          return map.get(k);
        },
        async put(/** @type {any} */ obj) {
          for (const [k, v] of Object.entries(obj)) map.set(k, v);
        },
        async setAlarm() {},
      },
      blockConcurrencyWhile: (/** @type {any} */ fn) => fn(),
    },
    {},
  );
  const env = /** @type {any} */ ({
    EXEC_SANDBOX: {
      idFromName(/** @type {string} */ name) {
        seen.names.push(name);
        return name;
      },
      get() {
        return {
          fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
            if (new URL(url).pathname === "/exec") seen.bodies.push(JSON.parse(String(init?.body || "null")));
            return sandbox.fetch(new Request(url, init));
          },
        };
      },
    },
  });
  return { env, seen };
}

describe("run_python over the Se/rver container — the real seam, end to end", () => {
  test("an admitted call runs in the container and the model reads its stdout", async () => {
    const { env, seen } = containerEnv(() => ({
      // The image's part: lypning answers, prints the engine marker on stderr
      // and the program's own output on stdout.
      exitCode: 0,
      stdout: "42\n",
      stderr: "drpy-engine:lypning\n",
    }));
    const state = researchState();
    // Admission first — the same gate the loop applies. run_python names no
    // context block and spends nothing, so a toolbox that carries it is enough.
    const admission = admitToolCall(
      "run_python",
      { source: "print(6*7)" },
      { state, budget: newToolBudget(state.plan), plan: state.plan, tools: ["run_python"] },
    );
    assert.equal(admission.ok, true);
    const rctx = /** @type {any} */ ({ state, identity: knobOn, requestId: "dr-req-1", round: 1 });
    const r = await runResearchTool(env, fakeLog(), "run_python", /** @type {any} */ (admission).args, rctx);

    // The wire: the Durable Object is addressed as (user, session) — the user
    // half from the server-side identity, the session from the request id — so
    // the loop's commands land in THIS conversation's container.
    assert.deepEqual(seen.names, ["u1|dr-req-1"]);
    // The command the container ran is the ladder's shell program: builtin
    // [ -x … ] probes on absolute paths (a `command -v` PATH walk once consumed
    // the whole exec ceiling and destroyed the VM), through an explicit shell.
    const body = seen.bodies[0];
    assert.match(body.command, /\[ -x \/usr\/local\/bin\/lypning \]/);
    assert.equal(body.command.includes("command -v"), false);
    assert.match(body.command, /print\(6\*7\)/);
    assert.deepEqual(seen.argv[0], ["true"], "readiness is probed with the cheapest process");
    assert.deepEqual(seen.argv[1].slice(0, 2), ["bash", "-lc"]);
    // The budget stays inside the VM ceiling twice over: the transport timeout
    // and the in-command `timeout` both carry the step budget, which pythonCommand
    // caps below EXEC_CEILING_MS — a command that crosses that ceiling does not
    // fail, it destroys the VM.
    assert.equal(body.timeoutMs, STEP_BUDGET_MS);
    assert.ok(body.timeoutMs < EXEC_CEILING_MS);
    assert.match(body.command, new RegExp(`timeout ${Math.round(STEP_BUDGET_MS / 1000)} `));

    // The result the model reads: the marker was parsed into "which engine
    // answered", stripped from the streams, and the program's stdout is there.
    assert.equal(r.isError, false);
    assert.match(r.text, /Ran on lypning in an ephemeral cloud container/);
    assert.match(r.text, /STDOUT:\n42/);
    assert.equal(r.text.includes("drpy-engine:"), false, "the marker is bookkeeping, not output");
  });

  test("a refusal in the container forks onto CPython, same as everywhere", async () => {
    let calls = 0;
    const { env, seen } = containerEnv((command) => {
      calls++;
      return calls === 1
        ? { exitCode: REFUSAL_EXIT, stdout: "", stderr: "drpy-engine:lypning\nlypning: unsupported: module: statistics\n" }
        : { exitCode: 0, stdout: "3.5\n", stderr: "drpy-engine:python3\n" };
    });
    const rctx = /** @type {any} */ ({ state: researchState(), identity: knobOn, requestId: "dr-req-2" });
    const r = await runResearchTool(env, fakeLog(), "run_python", { source: "import statistics" }, rctx);
    assert.equal(seen.bodies.length, 2, "the same program went back once, pinned to CPython");
    assert.match(seen.bodies[1].command, /\[ -x \/usr\/bin\/python3 \]/);
    assert.match(r.text, /lypning refused this program \(module: statistics\)/);
    assert.match(r.text, /Ran on python3 in an ephemeral cloud container/);
    assert.equal(r.isError, false);
  });

  test("the knob-off account gets the honest sentence and the container is never addressed", async () => {
    // The account-level consent execContainerAvailable enforces: the binding is
    // there, but this account has not turned the execution sandbox on — so a
    // directly-issued call (a model repeating a tool from an earlier
    // conversation) answers in words instead of computing (invariant 2).
    const { env, seen } = containerEnv();
    const rctx = /** @type {any} */ ({ state: researchState(), identity: knobOff, requestId: "dr-req-3" });
    const r = await runResearchTool(env, fakeLog(), "run_python", { source: "print(1)" }, rctx);
    assert.equal(r.isError, true);
    assert.match(r.text, /No execution environment is bound/);
    assert.equal(seen.names.length, 0, "no Durable Object was ever resolved");
  });
});

// The pure ladder mechanics — the command shape, the refusal contract, the
// fall-onward logic — are tested where they now live:
// public/js/lypning-exec-core.test.js. This file keeps the INTEGRATION level:
// run_python reached through the tool dispatch, the environment ladder, and
// the never-throws contract around it.

describe("the never-throws contract", () => {
  test("an unknown tool is a sentence", async () => {
    const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), "rm_minus_rf", {}, /** @type {any} */ ({ state: researchState() }));
    assert.equal(r.isError, true);
    assert.match(r.text, /no tool called/);
  });

  test("a broken request state degrades to a sentence instead of losing the answer", async () => {
    // A state with no registry is a bug somewhere upstream. The tool loop is
    // mid-answer, so it must still get something it can read.
    const r = await withFakeFetch([[/api\.exa\.ai/, exaHit]], () =>
      runResearchTool(/** @type {any} */ ({ EXA_API_KEY: "k" }), fakeLog(), "web_search", { queries: ["q"] }, /** @type {any} */ ({ state: {} })),
    );
    assert.equal(r.isError, true);
    assert.match(r.text, /failed to run/);
  });

  test("every tool answers something for empty arguments", async () => {
    for (const name of ["web_search", "read_pages", "source_search", "ancient_samples", "run_python"]) {
      const { rctx } = ctx(researchState());
      const r = await runResearchTool(/** @type {any} */ ({}), fakeLog(), name, {}, rctx);
      assert.equal(typeof r.text, "string", name);
      assert.ok(r.text.length > 20, name);
    }
  });
});

test("results carry the REGISTRY's citation number, not this call's position", async () => {
  // The brief tells the loop these ordinals ARE the [n] it cites, and the
  // registry numbers in arrival order across the whole request. Numbering each
  // call 1..n from scratch meant the second search's "1." was really [3] — and
  // because the loop's working conclusion reaches the writer verbatim, a
  // conclusion written from those ordinals names other people's sources in the
  // finished answer.
  const state = researchState();
  const { rctx } = ctx(state);
  const env = /** @type {any} */ ({ EXA_API_KEY: "k" });
  await withFakeFetch([[/api\.exa\.ai\/search/, exaHit]], () =>
    runResearchTool(env, fakeLog(), "web_search", { queries: ["first angle"] }, rctx),
  );
  const second = await withFakeFetch(
    [[/api\.exa\.ai\/search/, { results: [
      { title: "Later paper", url: "https://later.example/1", highlights: ["a finding"] },
    ] }]],
    () => runResearchTool(env, fakeLog(), "web_search", { queries: ["second angle"] }, rctx),
  );
  // The registry held two after the first call, so the next one is [3].
  assert.equal(state.sources.length, 3);
  assert.equal(state.sources[2].title, "Later paper");
  assert.match(second.text, /\[3\] Later paper/);
  assert.ok(!/\[1\] Later paper/.test(second.text), "the second call restarted its numbering");
});
