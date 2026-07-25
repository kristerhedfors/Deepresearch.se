// Node tests for the swarm RUNTIME (swarm-runtime.js): the pool, the
// diverge → critique → converge loop, the live member events, and the
// fail-soft contract — all against a FAKE member, which is the whole point of
// `spawn` being a parameter (the real one is a browser Worker running a 1-bit
// model). Nothing here touches the engine or the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSwarmPool, runSwarmNode, runSwarmNodes } from "./swarm-runtime.js";

/**
 * A fake member: answers draft prompts from `answers` (by call order),
 * critiques with a fixed verdict, and consolidates by echoing. `log` records
 * every prompt so a test can assert what the loop actually asked for.
 */
function fakeSpawner(opts = {}) {
  const log = [];
  const live = new Set();
  let draftCall = 0;
  const spawn = (label) => {
    live.add(label);
    return {
      async generate({ messages, onToken }) {
        const prompt = messages[0].content;
        log.push(prompt);
        onToken?.("x"); // the first token flips a member loading → running
        if (/Reply with EXACTLY three lines/.test(prompt)) return opts.critique ?? "VERDICT: support\nFLAW: none\nKEEP: the framing";
        if (/Several reasoners answered/.test(prompt)) return opts.synthesis ?? "CONSOLIDATED";
        const answers = opts.answers || ["latency is the constraint", "latency is the real constraint"];
        return answers[draftCall++ % answers.length];
      },
      terminate() {
        live.delete(label);
      },
    };
  };
  return { spawn, log, live };
}

const node = { id: "sw", name: "Swarm", task: "What matters most here?", swarmSize: 4, rounds: 1 };
const device = { hardwareConcurrency: 8, deviceMemoryGb: 8, modelBytes: 300e6, maxWorkers: 2 };

test("the pool hands out its workers and queues the rest", async () => {
  const { spawn, live } = fakeSpawner();
  const pool = createSwarmPool(spawn, 2);
  assert.equal(pool.size, 2);
  assert.equal(live.size, 2, "workers are spawned up front and reused across rounds");
  const a = await pool.acquire();
  const b = await pool.acquire();
  let third = null;
  pool.acquire().then((h) => (third = h));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(third, null, "no free worker → the caller waits");
  pool.release(a);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(third, "released worker goes straight to the waiter");
  pool.release(b);
  pool.terminate();
  assert.equal(live.size, 0, "terminate leaves nothing behind");
});

test("a swarm run drafts, critiques, converges and returns a provenance-led brief", async () => {
  const { spawn, log, live } = fakeSpawner();
  const events = [];
  const res = await runSwarmNode(node, {
    spawn,
    modelId: "bonsai-1_7b-1bit",
    modelLabel: "Bonsai 1.7B",
    userRequest: "the original ask",
    device,
    emit: (ev) => events.push(ev),
  });
  assert.ok(res);
  assert.equal(res.members, 4);
  assert.equal(res.failed, 0);
  assert.ok(res.text.startsWith("[Local swarm: 4 × Bonsai 1.7B in this browser"));
  assert.ok(res.text.includes("CONSOLIDATED"), "the consolidation pass wrote the body");
  assert.ok(res.agreement > 0);
  // 4 drafts + 4 ring critiques + 1 consolidation.
  assert.equal(log.filter((p) => /member \d of 4/.test(p)).length, 4);
  assert.equal(log.filter((p) => /Reply with EXACTLY three lines/.test(p)).length, 4);
  assert.equal(log.filter((p) => /Several reasoners answered/.test(p)).length, 1);
  assert.ok(log.some((p) => p.includes("the original ask")), "members see the user's real request");
  assert.equal(live.size, 0, "the pool is always terminated");
});

test("the run emits live member states the graph can render", async () => {
  const { spawn } = fakeSpawner();
  const events = [];
  await runSwarmNode(node, { spawn, modelId: "m", device, emit: (ev) => events.push(ev) });
  assert.ok(events.length > 4);
  assert.ok(events.every((e) => e.type === "swarm_update" && e.id === "sw"));
  assert.ok(events.some((e) => e.members.includes("running")), "members report while they decode");
  assert.ok(events.some((e) => e.phase === "critique"));
  const last = events.at(-1);
  assert.equal(last.phase, "done");
  assert.deepEqual(last.members, ["done", "done", "done", "done"]);
  assert.ok(last.agreement > 0);
});

test("a split swarm uses its second round; a converged one stops early", async () => {
  // Identical drafts → agreement 1 → no second round even though rounds: 2.
  const converged = fakeSpawner({ answers: ["same answer about latency"] });
  await runSwarmNode({ ...node, rounds: 2 }, { spawn: converged.spawn, modelId: "m", device });
  assert.equal(converged.log.filter((p) => /member \d of 4/.test(p)).length, 4, "one round only");

  // Disjoint drafts + a dispute → the loop spends its second round, and that
  // round shows the members the current lead.
  const split = fakeSpawner({
    answers: ["latency dominates everything", "colours matter enormously", "governance rules first", "pricing decides outcomes"],
    critique: "VERDICT: dispute\nFLAW: it misses the point\nKEEP: none",
  });
  await runSwarmNode({ ...node, rounds: 2 }, { spawn: split.spawn, modelId: "m", device });
  assert.equal(split.log.filter((p) => /member \d of 4/.test(p)).length, 8, "two rounds");
  assert.ok(split.log.some((p) => p.includes("Treat it as a claim to check")), "round 2 is seeded with the lead");
  assert.ok(split.log.some((p) => p.includes("it misses the point")), "…and with the dissent");
});

test("failing members are lost, not fatal — and an all-dead swarm returns null", async () => {
  let call = 0;
  const halfDead = () => ({
    async generate() {
      // Every other draft dies; critiques and consolidation still work.
      if (++call % 2 === 0) throw new Error("the device ran out of memory");
      return "latency is the constraint";
    },
    terminate() {},
  });
  const res = await runSwarmNode(node, { spawn: halfDead, modelId: "m", device });
  assert.ok(res, "a partial swarm still answers");
  assert.ok(res.failed > 0);
  assert.ok(res.text.includes("member"));

  const allDead = () => ({
    async generate() {
      throw new Error("no WebGPU here");
    },
    terminate() {},
  });
  assert.equal(await runSwarmNode(node, { spawn: allDead, modelId: "m", device }), null);
});

test("a hung member is bounded by the deadline instead of hanging the swarm", async () => {
  const hang = () => ({
    generate: () => new Promise(() => {}), // never settles
    terminate() {},
  });
  const res = await runSwarmNode(node, { spawn: hang, modelId: "m", device, deadlineMs: 20 });
  assert.equal(res, null, "every member timed out → the node degrades server-side");
});

test("runSwarmNodes runs only the swarm nodes, and skips the ones that fail", async () => {
  const { spawn } = fakeSpawner();
  const plan = {
    agents: [
      { id: "res", kind: "deep_research", task: "look it up" },
      { id: "sw", kind: "swarm", task: "weigh it", swarmSize: 2, rounds: 1 },
      { id: "critic", kind: "custom", task: "combine" },
    ],
  };
  const out = await runSwarmNodes(plan, { spawn, modelId: "m", device });
  assert.deepEqual(Object.keys(out), ["sw"]);
  assert.equal(out.sw.members, 2);
  assert.ok(out.sw.text.includes("Local swarm"));

  const dead = () => ({ async generate() { throw new Error("nope"); }, terminate() {} });
  assert.deepEqual(await runSwarmNodes(plan, { spawn: dead, modelId: "m", device }), {});
});

test("an aborted send stops the swarm without leaving workers behind", async () => {
  const { spawn, live } = fakeSpawner();
  const out = await runSwarmNodes(
    { agents: [{ id: "sw", kind: "swarm", task: "t" }] },
    { spawn, modelId: "m", device, signal: { aborted: true } },
  );
  assert.deepEqual(out, {});
  assert.equal(live.size, 0);
});
