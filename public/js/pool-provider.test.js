// The sharer's provider loop (pool-provider.js): register → poll → run the
// local model → post the result, re-register on 409, error-report a failed
// job without dying, stop cleanly. Transport is a scripted fake fetch — the
// loop's contract, not the broker, is under test here.

import test from "node:test";
import assert from "node:assert/strict";
import { createPoolProvider } from "./pool-provider.js";
import { sanitizePoolRequest } from "./pool-core.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A scripted broker: hands out `jobs`, records calls, then idles. */
function fakeBroker({ jobs = [], reregisterOnce = false } = {}) {
  const calls = [];
  let queue = [...jobs];
  let bounced = false;
  return {
    calls,
    fetchFn: async (path, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path, body });
      if (path === "/api/pool/register") return json({ providerId: "prov-" + calls.length, poolId: "me" });
      if (path === "/api/pool/poll") {
        if (reregisterOnce && !bounced) {
          bounced = true;
          return json({ error: "re-register", reregister: true }, 409);
        }
        return json({ job: queue.shift() || null });
      }
      if (path === "/api/pool/result") return json({ ok: true });
      if (path === "/api/pool/unregister") return json({ ok: true });
      return json({ error: "nope" }, 404);
    },
  };
}

const { request } = sanitizePoolRequest({ model: "llama3", messages: [{ role: "user", content: "hi" }], tools: [1] });

async function until(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("register → poll → runJob gets the PLAIN OpenAI body → result posts back", async () => {
  const broker = fakeBroker({ jobs: [{ job_id: "j1", model: "llama3", request }] });
  const ran = [];
  const p = createPoolProvider({
    fetchFn: broker.fetchFn,
    label: "test rig",
    listModels: async () => ["llama3"],
    runJob: async (body) => {
      ran.push(body);
      return { response: { choices: [{ message: { content: "hej" } }] }, usage: { prompt_tokens: 3, completion_tokens: 2 } };
    },
  });
  assert.equal(await p.start(), true);
  await until(() => broker.calls.some((c) => c.path === "/api/pool/result"));
  await p.stop();

  // The wire marker never reaches the local model; the sanitized fields do.
  assert.equal(ran.length, 1);
  assert.equal("wire" in ran[0], false);
  assert.equal(ran[0].model, "llama3");
  assert.equal(ran[0].stream, false);
  assert.equal("tools" in ran[0], false);

  const reg = broker.calls.find((c) => c.path === "/api/pool/register");
  assert.deepEqual(reg.body.models, ["llama3"]);
  const result = broker.calls.find((c) => c.path === "/api/pool/result");
  assert.equal(result.body.jobId, "j1");
  assert.equal(result.body.response.choices[0].message.content, "hej");
  assert.equal(result.body.usage.completion_tokens, 2);
  assert.equal(p.jobsDone, 1);
  // stop() told the broker.
  assert.ok(broker.calls.some((c) => c.path === "/api/pool/unregister"));
});

test("a failed local run posts an error result and the loop keeps serving", async () => {
  const broker = fakeBroker({
    jobs: [
      { job_id: "bad", model: "m", request },
      { job_id: "good", model: "m", request },
    ],
  });
  let n = 0;
  const p = createPoolProvider({
    fetchFn: broker.fetchFn,
    runJob: async () => {
      if (++n === 1) throw new Error("local server exploded");
      return { response: { ok: true } };
    },
  });
  await p.start();
  await until(() => broker.calls.filter((c) => c.path === "/api/pool/result").length >= 2);
  await p.stop();
  const results = broker.calls.filter((c) => c.path === "/api/pool/result");
  assert.equal(results[0].body.jobId, "bad");
  assert.match(results[0].body.error, /exploded/);
  assert.equal(results[0].body.response, undefined);
  assert.equal(results[1].body.jobId, "good");
  assert.equal(p.jobsDone, 1); // only the successful one counts
});

test("a 409 poll re-registers and carries on", async () => {
  const broker = fakeBroker({ jobs: [{ job_id: "j1", model: "m", request }], reregisterOnce: true });
  const p = createPoolProvider({ fetchFn: broker.fetchFn, runJob: async () => ({ response: {} }) });
  await p.start();
  await until(() => broker.calls.some((c) => c.path === "/api/pool/result"));
  await p.stop();
  assert.equal(broker.calls.filter((c) => c.path === "/api/pool/register").length, 2);
});

test("start() fails soft when register is refused (not signed in)", async () => {
  const statuses = [];
  const p = createPoolProvider({
    fetchFn: async () => json({ error: "who are you" }, 401),
    runJob: async () => ({ response: {} }),
    onStatus: (s) => statuses.push(s),
  });
  assert.equal(await p.start(), false);
  assert.equal(p.active, false);
  assert.equal(statuses.at(-1).state, "error");
});
