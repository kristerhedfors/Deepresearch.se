// Unit tests for the ancient-sample enrichment façade (src/aadr.js).
//
// The query semantics live in public/js/aadr-core.test.js. What is pinned here
// is the Worker side: loading the artifact through the ASSETS binding, caching
// it per binding rather than per module, the fail-soft contract (invariant 2 —
// every failure path returns the conversation unchanged and never throws), and
// the fact that a zero-match query still appends a block saying so.
import test from "node:test";
import assert from "node:assert/strict";

import { SAMPLES_PATH, loadSamples, runAncientSampleEnrichment } from "./aadr.js";
import { SAMPLES_LAYOUT } from "../public/js/aadr-core.js";

const FIXTURE = {
  spec: "aadr-samples/1",
  layout: SAMPLES_LAYOUT,
  source: { name: "test corpus" },
  counts: { total: 2, ancient: 2, modern: 0 },
  dict: {
    group: ["Sweden_Gotland_PittedWare"],
    country: ["Sweden"],
    place: ["Gotland, Västerbjers"],
    pkg: ["2020_TestStudy"],
    pub: ["TestStudy2020"],
  },
  packageDesc: {},
  rows: [
    "GOT01\t0\t0\t0\t57500\t18500\t1\t-2800\t-2738\t-2700\t4200\tU5b2a2\t\t2\t1150000\t1445\t0\t0",
    "GOT02\t0\t0\t0\t57500\t18500\t1\t-2600\t-2550\t-2500\t4000\tK1a3a\t\t1\t900000\t320\t0\t0",
  ].join("\n"),
};

/** An ASSETS binding serving `body` (or failing, per `mode`). */
function assetsEnv(mode = "ok", body = FIXTURE) {
  let calls = 0;
  return {
    calls: () => calls,
    env: {
      ASSETS: {
        async fetch() {
          calls++;
          if (mode === "404") return new Response("nope", { status: 404 });
          if (mode === "throw") throw new Error("binding exploded");
          if (mode === "garbage") return new Response("<html>", { headers: { "content-type": "text/html" } });
          return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        },
      },
    },
  };
}

/** Convenience: run the enrichment and hand back what it produced. */
async function run(env, message, state = {}) {
  const steps = [];
  const conversation = [{ role: "user", content: message }];
  const out = await runAncientSampleEnrichment({
    env,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    emit() {},
    step: (id, label) => steps.push(["start", id, label]),
    stepDone: (id, label, details) => steps.push(["done", id, label, details]),
    conversation,
    state,
  });
  return { out, steps, state, conversation };
}

test("loadSamples", async (t) => {
  await t.test("reads the artifact through the ASSETS binding", async () => {
    const a = assetsEnv();
    const d = await loadSamples(a.env);
    assert.ok(d);
    assert.equal(d.n, 2);
    assert.equal(d.id[0], "GOT01");
  });

  await t.test("asks for the path the build script writes", async () => {
    let asked = "";
    const env = { ASSETS: { async fetch(req) {
      asked = new URL(req.url).pathname;
      return new Response(JSON.stringify(FIXTURE));
    } } };
    await loadSamples(env);
    assert.equal(asked, SAMPLES_PATH);
  });

  await t.test("parses once per binding, not once per request", async () => {
    const a = assetsEnv();
    await loadSamples(a.env);
    await loadSamples(a.env);
    await loadSamples(a.env);
    assert.equal(a.calls(), 1);
  });

  await t.test("a different binding is never served another env's corpus", async () => {
    const a = assetsEnv();
    const b = assetsEnv("ok", { ...FIXTURE, rows: "OTHER\t0\t0\t0\t\t\t1\t\t\t\t\t\t\t\t\t\t0\t0" });
    assert.equal((await loadSamples(a.env)).id[0], "GOT01");
    assert.equal((await loadSamples(b.env)).id[0], "OTHER");
  });

  await t.test("returns null — never throws — on every failure", async () => {
    assert.equal(await loadSamples(undefined), null);
    assert.equal(await loadSamples({}), null);
    assert.equal(await loadSamples(assetsEnv("404").env), null);
    assert.equal(await loadSamples(assetsEnv("throw").env), null);
    assert.equal(await loadSamples(assetsEnv("garbage").env), null);
    assert.equal(await loadSamples(assetsEnv("ok", { layout: 999, rows: "x" }).env), null);
  });

  await t.test("does not cache a failure — a transient error must retry", async () => {
    let n = 0;
    const env = { ASSETS: { async fetch() {
      n++;
      return n === 1 ? new Response("", { status: 503 }) : new Response(JSON.stringify(FIXTURE));
    } } };
    assert.equal(await loadSamples(env), null);
    assert.ok(await loadSamples(env), "the isolate is not poisoned by one bad response");
  });
});

test("runAncientSampleEnrichment", async (t) => {
  await t.test("is completely silent on a message that is not a sample query", async () => {
    const a = assetsEnv();
    const { out, steps, conversation } = await run(a.env, "what is the weather in Uppsala");
    assert.equal(out, conversation, "the same conversation object, untouched");
    assert.deepEqual(steps, []);
    assert.equal(a.calls(), 0, "no artifact load for a turn that cannot use it");
  });

  await t.test("is silent on a LITERATURE question in the same field", async () => {
    // The split that keeps the two legs apart: "how does aDNA degrade" belongs
    // to Europe PMC, not to a table of individuals.
    const a = assetsEnv();
    const { steps } = await run(a.env, "how does ancient DNA degrade over time");
    assert.deepEqual(steps, []);
  });

  await t.test("appends the block for a sample query, and reports the step", async () => {
    const { out, steps, conversation } = await run(
      assetsEnv().env,
      "how many ancient individuals from Gotland are in the dataset",
    );
    assert.notEqual(out, conversation);
    const appended = out[out.length - 1].content;
    assert.ok(appended.includes("ANCIENT-SAMPLE DATABASE"), appended.slice(0, 200));
    assert.ok(appended.includes("GOT01"));
    assert.equal(steps[0][0], "start");
    assert.equal(steps[0][1], "aadr");
    assert.equal(steps[1][0], "done");
    assert.ok(steps[1][2].includes("individual"), steps[1][2]);
  });

  await t.test("records the counters a chat_logs reader debugs with", async () => {
    const { state } = await run(
      assetsEnv().env,
      "ancient individuals from Gotland dated 5000-4000 BP",
    );
    assert.equal(typeof state.aadr.matched, "number");
    assert.equal(state.aadr.dated, true);
    assert.equal(state.aadr.haplo, false);
  });

  await t.test("appends a block SAYING nothing matched, rather than nothing", async () => {
    // A zero-result turn with no block is the turn where the answer reaches for
    // remembered sample ids. The block is what stops it.
    const { out } = await run(assetsEnv().env, "ancient individuals with Y-haplogroup Z99 in the dataset");
    const appended = out[out.length - 1].content;
    assert.ok(appended.includes("NO ROWS MATCHED"));
  });

  await t.test("fails soft and VISIBLY when the corpus is unavailable", async () => {
    const { out, steps, conversation } = await run(
      assetsEnv("404").env,
      "how many ancient individuals from Gotland are in the dataset",
    );
    assert.equal(out, conversation, "the conversation passes through unchanged");
    // The step already told the user a lookup started, so silence here would
    // read as a result rather than as an outage.
    assert.equal(steps.length, 2);
    assert.ok(steps[1][2].includes("unavailable"), steps[1][2]);
  });

  await t.test("preserves multipart content when appending", async () => {
    const conversation = [{
      role: "user",
      content: [
        { type: "image", source: {} },
        { type: "text", text: "how many ancient individuals from Gotland are in the dataset" },
      ],
    }];
    const out = await runAncientSampleEnrichment({
      env: assetsEnv().env,
      log: { info() {}, warn() {} },
      emit() {},
      step() {},
      stepDone() {},
      conversation,
      state: {},
    });
    const parts = out[0].content;
    assert.equal(parts[0].type, "image", "the attached photo survives");
    assert.equal(parts.length, 3);
    assert.ok(parts[2].text.includes("ANCIENT-SAMPLE DATABASE"));
  });
});
