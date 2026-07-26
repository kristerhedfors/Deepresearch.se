import assert from "node:assert/strict";
import test from "node:test";

import { describeProviders, embedWithProviders, isTerminal, resolveProviders } from "./embed-providers.mjs";

/**
 * A fake provider. `rate` doubles as the per-batch delay so the tests can make
 * one backend genuinely faster than the other and watch the work-stealing.
 */
function fake(id, { batch = 4, workers = 2, rate = 10, delay = 0, fail = null } = {}) {
  const calls = [];
  return {
    id,
    label: id,
    batch,
    workers,
    rate,
    calls,
    available: () => true,
    async call(texts) {
      calls.push(texts.length);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const err = fail?.(calls.length);
      if (err) throw err;
      // Encode which provider produced each vector so order can be checked.
      return texts.map((t) => Float32Array.from([Number(t), id.charCodeAt(0)]));
    },
  };
}

const err = (status, message = "boom") => Object.assign(new Error(message), { status });
const texts = (n) => Array.from({ length: n }, (_, i) => String(i));

test("resolveProviders honours an explicit choice and rejects unknown ones", () => {
  const reg = { a: fake("a", { rate: 5 }), b: fake("b", { rate: 50 }) };
  assert.deepEqual(resolveProviders("a", reg).providers.map((p) => p.id), ["a"]);
  assert.equal(resolveProviders("a", reg).mode, "a");
  assert.throws(() => resolveProviders("nope", reg), /Unknown EMBED_PROVIDER/);
});

test("auto and both order providers fastest first", () => {
  const reg = { slow: fake("slow", { rate: 9 }), fast: fake("fast", { rate: 180 }) };
  assert.deepEqual(resolveProviders("auto", reg).providers.map((p) => p.id), ["fast", "slow"]);
  assert.deepEqual(resolveProviders("both", reg).providers.map((p) => p.id), ["fast", "slow"]);
});

test("resolveProviders refuses an unconfigured provider and an empty registry", () => {
  const off = { ...fake("off"), available: () => false };
  assert.throws(() => resolveProviders("off", { off }), /not configured/);
  assert.throws(() => resolveProviders("auto", { off }), /No embedding provider is configured/);
});

test("output order follows input order regardless of which provider filled it", async () => {
  const a = fake("a", { batch: 3, workers: 2, delay: 5 });
  const b = fake("b", { batch: 7, workers: 2, delay: 1 });
  const { vectors } = await embedWithProviders(texts(40), [a, b], { mode: "both" });
  assert.equal(vectors.length, 40);
  vectors.forEach((v, i) => assert.equal(v[0], i, `slot ${i} holds vector ${v[0]}`));
});

test("both mode actually uses both providers, and the faster one does more", async () => {
  const fast = fake("fast", { batch: 5, workers: 4, delay: 1 });
  const slow = fake("slow", { batch: 5, workers: 1, delay: 40 });
  const { by } = await embedWithProviders(texts(200), [fast, slow], { mode: "both" });
  assert.ok(by.fast > 0 && by.slow > 0, `both should contribute, got ${JSON.stringify(by)}`);
  assert.ok(by.fast > by.slow, `the faster provider should do more work, got ${JSON.stringify(by)}`);
  assert.equal(by.fast + by.slow, 200);
});

test("auto does not start the slow provider while the fast one is healthy", async () => {
  const fast = fake("fast", { batch: 10, workers: 2 });
  const slow = fake("slow", { batch: 10, workers: 2 });
  const { by } = await embedWithProviders(texts(50), [fast, slow], { mode: "auto" });
  assert.equal(by.fast, 50);
  assert.equal(by.slow, undefined, "the fallback must stay idle when the primary works");
  assert.equal(slow.calls.length, 0);
});

test("a terminal failure retires the provider and the other finishes the work", async () => {
  // Primary dies on its second batch — an empty wallet mid-build, the real case.
  const dying = fake("dying", { batch: 10, workers: 1, fail: (n) => (n >= 2 ? err(402, "INSUFFICIENT_WALLET_BALANCE") : null) });
  const rescuer = fake("rescuer", { batch: 10, workers: 2 });
  const logs = [];
  const { vectors, by, retired } = await embedWithProviders(texts(50), [dying, rescuer], { mode: "auto", log: (m) => logs.push(m) });
  assert.equal(vectors.length, 50);
  vectors.forEach((v, i) => assert.equal(v[0], i));
  assert.deepEqual(retired, ["dying"]);
  assert.equal(by.dying, 10, "only the first batch got through before the wallet died");
  assert.equal(by.rescuer, 40);
  assert.ok(logs.some((l) => /retired/.test(l)) && logs.some((l) => /failing over/.test(l)), logs.join(" | "));
});

test("the batch the dying provider was holding is requeued, not lost", async () => {
  // Fails on the FIRST batch, so the requeue path is the only way slot 0 gets filled.
  const dying = fake("dying", { batch: 8, workers: 1, fail: () => err(401, "no key") });
  const rescuer = fake("rescuer", { batch: 8, workers: 1 });
  const { vectors, by } = await embedWithProviders(texts(24), [dying, rescuer], { mode: "auto" });
  assert.equal(by.dying, undefined);
  assert.equal(by.rescuer, 24);
  vectors.forEach((v, i) => assert.equal(v[0], i));
});

test("a transient failure is retried on the same provider rather than retiring it", async () => {
  let seen = 0;
  const flaky = fake("flaky", { batch: 5, workers: 1, fail: () => (++seen === 1 ? err(503, "unavailable") : null) });
  const { vectors, by, retired } = await embedWithProviders(texts(10), [flaky], { mode: "berget" });
  assert.equal(vectors.length, 10);
  assert.equal(by.flaky, 10);
  assert.deepEqual(retired, []);
});

test("when every provider dies the error names the gap instead of returning holes", async () => {
  const a = fake("a", { batch: 5, workers: 1, fail: () => err(402) });
  const b = fake("b", { batch: 5, workers: 1, fail: () => err(402) });
  await assert.rejects(
    () => embedWithProviders(texts(20), [a, b], { mode: "auto" }),
    /Embedding incomplete: .*Providers retired: a, b/,
  );
});

test("over-length input is re-capped and retried, not dropped", async () => {
  let attempt = 0;
  const picky = {
    ...fake("picky", { batch: 2, workers: 1 }),
    async call(t) {
      // Reject until the texts have been shortened.
      if (++attempt <= 2 && t.some((x) => x.length > 30)) throw err(400, "maximum context length is 512 tokens. However, you requested 600 tokens in the input");
      return t.map(() => Float32Array.from([1, 2]));
    },
  };
  const long = ["x".repeat(200), "y".repeat(200)];
  const { vectors } = await embedWithProviders(long, [picky], { mode: "picky" });
  assert.equal(vectors.length, 2);
  assert.ok(attempt > 1, "should have retried after re-capping");
});

test("isTerminal separates a dead key from a busy backend", () => {
  assert.ok(isTerminal(err(402)) && isTerminal(err(401)) && isTerminal(err(403)));
  assert.ok(!isTerminal(err(429)) && !isTerminal(err(500)) && !isTerminal(new Error("network")));
});

test("describeProviders says what a run will actually do", () => {
  const reg = { fast: fake("fast", { rate: 180 }), slow: fake("slow", { rate: 9 }) };
  assert.match(describeProviders("both", reg), /fast.*\+.*slow.*work-stealing/);
  assert.match(describeProviders("auto", reg), /via fast \(batch 4 x 2\), falling over to slow/);
  assert.match(describeProviders("slow", reg), /^embedding via slow \(batch/);
});

test("a much slower provider is declined on a small job and engaged on a big one", async () => {
  // The straggler guard. `slow` is 100x slower per text, like HF against
  // Berget on real passages: its batch latency is worth paying only when the
  // remaining work dwarfs it.
  const fast = () => fake("fast", { batch: 50, workers: 4, rate: 200, delay: 1 });
  const slow = () => fake("slow", { batch: 20, workers: 1, rate: 2, delay: 1 });

  const small = await embedWithProviders(texts(200), [fast(), slow()], { mode: "both" });
  assert.equal(small.by.slow, undefined, `slow should stand down on a small job, got ${JSON.stringify(small.by)}`);
  assert.equal(small.by.fast, 200);

  // Big enough to clear the tail margin: slow's batch is 20/2 = 10s, and the
  // guard wants the fast provider's drain (n/200) to exceed 10x that.
  const big = await embedWithProviders(texts(60000), [fast(), slow()], { mode: "both" });
  assert.ok(big.by.slow > 0, `slow should contribute on a big job, got ${JSON.stringify(big.by)}`);
  assert.ok(big.by.slow < big.by.fast / 10, `slow must stay a minority share, got ${JSON.stringify(big.by)}`);
  assert.equal(big.by.fast + big.by.slow, 60000);
});

test("the guard never strands work when only the slow provider survives", async () => {
  // With the primary retired, the slow one IS the fastest alive and must take
  // everything — otherwise the guard would deadlock the job.
  const dead = fake("dead", { batch: 50, workers: 1, rate: 200, fail: () => err(402) });
  const slow = fake("slow", { batch: 20, workers: 1, rate: 2 });
  const { vectors, by } = await embedWithProviders(texts(100), [dead, slow], { mode: "both" });
  assert.equal(vectors.length, 100);
  assert.equal(by.slow, 100);
  vectors.forEach((v, i) => assert.equal(v[0], i));
});
