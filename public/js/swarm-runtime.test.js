// Node tests for the swarm RUNTIME (swarm-runtime.js): the pool, the
// diverge → critique → converge loop, the live member events, and the
// fail-soft contract — all against a FAKE member, which is the whole point of
// `spawn` being a parameter (the real one is a browser Worker running a 1-bit
// model). Nothing here touches the engine or the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSwarmPool,
  lastRunHint,
  runSwarmNode,
  runSwarmNodes,
  setBreadcrumbStore,
  stopSwarms,
  swarmCrashDiag,
  swarmRunning,
} from "./swarm-runtime.js";

/** A localStorage-shaped fake so the breadcrumb path is testable in Node. */
function fakeStore() {
  const mem = new Map();
  const store = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
    get size() {
      return mem.size;
    },
  };
  setBreadcrumbStore(store);
  return store;
}

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

// ---- the memory contract (feedback #26 — the Safari tab crashes) -------------

test("one pool serves the whole run instead of a fresh set of models per node", async () => {
  const { spawn, live } = fakeSpawner();
  let peak = 0;
  const counting = (label) => {
    const h = spawn(label);
    peak = Math.max(peak, live.size);
    return h;
  };
  const plan = {
    agents: [
      { id: "sw", kind: "swarm", task: "weigh it", swarmSize: 2, rounds: 1 },
      // A plan that slipped two swarm nodes past the planner must still not
      // multiply the workers (normalizeWorkflow downgrades extras; this is the
      // runtime's own bound).
      { id: "sw2", kind: "swarm", task: "weigh it again", swarmSize: 2, rounds: 1 },
    ],
  };
  const out = await runSwarmNodes(plan, { spawn: counting, modelId: "m", device });
  assert.deepEqual(Object.keys(out).sort(), ["sw", "sw2"]);
  assert.equal(peak, 2, "both nodes share the one pool the device was sized for");
  assert.equal(live.size, 0, "and it is gone when the run ends");
});

test("a new run supersedes the previous one — never two swarms of models at once", async () => {
  const { spawn, live } = fakeSpawner();
  let peak = 0;
  const slow = (label) => {
    const h = spawn(label);
    peak = Math.max(peak, live.size);
    return {
      ...h,
      generate: (a) => new Promise((resolve) => setTimeout(() => resolve(h.generate(a)), 30)),
    };
  };
  const plan = { agents: [{ id: "sw", kind: "swarm", task: "t", swarmSize: 2, rounds: 1 }] };
  const first = runSwarmNodes(plan, { spawn: slow, modelId: "m", device });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(swarmRunning(), true);
  const second = await runSwarmNodes(plan, { spawn: slow, modelId: "m", device });
  await first;
  assert.ok(peak <= 2, `the superseded run's workers were terminated, peak ${peak}`);
  assert.equal(live.size, 0);
  assert.equal(swarmRunning(), false);
  assert.ok(second, "the newer run still answers");
});

test("stopSwarms terminates everything a live run is holding", async () => {
  const { spawn, live } = fakeSpawner();
  const hang = (label) => ({ ...spawn(label), generate: () => new Promise(() => {}) });
  const run = runSwarmNodes(
    { agents: [{ id: "sw", kind: "swarm", task: "t", swarmSize: 2, rounds: 1 }] },
    { spawn: hang, modelId: "m", device, deadlineMs: 5000 },
  );
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(live.size > 0);
  stopSwarms();
  assert.equal(live.size, 0, "workers die on the spot, not at the next GC");
  assert.deepEqual(await run, {}, "and the run unwinds fail-soft");
});

test("a timed-out member's worker is replaced, not handed to the next member", async () => {
  const spawned = [];
  let calls = 0;
  const aborts = [];
  const flaky = (label) => {
    const h = {
      label,
      dead: false,
      // Only the first generation hangs; the replacement worker answers.
      generate: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve("latency is the constraint")),
      abort: () => aborts.push(label),
      terminate: () => (h.dead = true),
    };
    spawned.push(h);
    return h;
  };
  const res = await runSwarmNode(
    { id: "sw", task: "t", swarmSize: 2, rounds: 1 },
    { spawn: flaky, modelId: "m", device, deadlineMs: 20 },
  );
  assert.ok(res, "the swarm survived the hung member");
  assert.ok(aborts.length >= 1, "the abandoned generation is aborted, not just forgotten");
  assert.ok(spawned.length > 2, "a fresh worker took the retired one's slot");
  assert.ok(spawned.filter((h) => h.dead).length >= 1, "and the retired one was terminated");
});

test("a run writes a breadcrumb before spawning and clears it on a clean finish", async () => {
  const store = fakeStore();
  const seen = [];
  const { spawn } = fakeSpawner();
  const watching = (label) => {
    seen.push(JSON.parse(store.getItem("dr_ondevice_run") || "null"));
    return spawn(label);
  };
  await runSwarmNodes(
    { agents: [{ id: "sw", kind: "swarm", task: "t", swarmSize: 2, rounds: 1 }] },
    { spawn: watching, modelId: "m", device },
  );
  assert.ok(seen[0], "the breadcrumb exists BEFORE the first worker — the point of it");
  assert.equal(seen[0].phase, "spawn");
  assert.equal(seen[0].members, 2);
  assert.ok(seen[0].conc >= 1);
  assert.equal(store.getItem("dr_ondevice_run"), null, "a clean run leaves nothing behind");
  assert.equal(swarmCrashDiag(), undefined);
});

test("a breadcrumb left by a dead tab becomes counters on the next request", () => {
  const store = fakeStore();
  store.setItem(
    "dr_ondevice_run",
    JSON.stringify({ v: 1, t: Date.now() - 60_000, kind: "swarm", nodes: 1, members: 6, conc: 4, rounds: 2, round: 2, phase: "diverge", mb: 1200, cls: "" }),
  );
  const diag = swarmCrashDiag();
  assert.equal(diag.died, 1);
  assert.equal(diag.phase, "diverge");
  assert.equal(diag.members, 6);
  assert.equal(diag.conc, 4);
  assert.equal(diag.mb, 1200);
  assert.equal(diag.ago, 60);
  // Counters and classes ONLY (invariant 4): nothing here can carry a task,
  // a node id or an answer.
  assert.deepEqual(Object.keys(diag).sort(), ["ago", "cls", "conc", "died", "kind", "mb", "members", "phase", "round"]);
  assert.equal(swarmCrashDiag(), undefined, "read once — one death is reported once");
});

test("a member's memory failure ends the swarm early and is kept for the report", async () => {
  const store = fakeStore();
  let call = 0;
  const oom = () => ({
    async generate() {
      // The first member answers; the second dies of memory, which must stop
      // the run rather than buy another round of allocations.
      if (++call % 2 === 0) throw new Error("Cannot enlarge memory arrays");
      return "latency is the constraint";
    },
    terminate() {},
  });
  await runSwarmNodes(
    { agents: [{ id: "sw", kind: "swarm", task: "t", swarmSize: 2, rounds: 3 }] },
    { spawn: oom, modelId: "m", device },
  );
  const diag = swarmCrashDiag();
  assert.ok(diag, "the pressure survives the run for the next request's diagnostics");
  assert.equal(diag.cls, "oom");
  assert.equal(diag.died, 0, "the run finished — this device is at its limit, not dead");
});

test("a retry does not erase the crash it may be repeating", async () => {
  const store = fakeStore();
  // A previous page died mid-swarm and nothing has reported it yet.
  store.setItem(
    "dr_ondevice_run",
    JSON.stringify({ v: 1, t: Date.now() - 5000, kind: "swarm", nodes: 1, members: 4, conc: 4, rounds: 2, round: 1, phase: "diverge", mb: 300, cls: "" }),
  );
  assert.ok(lastRunHint(), "the device's own verdict is readable without consuming it");
  const { spawn } = fakeSpawner();
  await runSwarmNodes(
    { agents: [{ id: "sw", kind: "swarm", task: "t", swarmSize: 2, rounds: 1 }] },
    { spawn, modelId: "m", device },
  );
  const diag = swarmCrashDiag();
  assert.ok(diag, "the older death still gets reported after a clean retry");
  assert.equal(diag.died, 1);
  assert.equal(diag.phase, "diverge");
  assert.equal(swarmCrashDiag(), undefined);
});
