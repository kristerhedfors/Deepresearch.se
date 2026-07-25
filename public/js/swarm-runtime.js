// @ts-check
// The SWARM RUNTIME — the browser side of the Orchestrator's `swarm` node kind:
// it spins up N isolated inference workers (ondevice-engine.js
// spawnSwarmMember — one browser worker per member, each with its own model
// instance), walks them through the diverge → critique → converge algorithm in
// swarm-core.js, and hands back one brief plus the live per-member states the
// workflow graph renders.
//
// Dependency-injected on purpose: `spawn` is a parameter, not an import, so the
// whole loop is Node-testable against a fake member (swarm-runtime.test.js)
// while the browser passes the real engine's spawner. The only browser-only
// function here is detectSwarmCapability(), which dynamic-imports the on-device
// glue and is never reached from a test.
//
// FAIL-SOFT (invariant 2) at every level: a member that crashes is one lost
// draft, a round that produces nothing usable ends the swarm early, and a
// swarm that produces nothing at all returns null — the orchestrator then runs
// that node as an ordinary `custom` agent on the answer model. The pool is
// terminated in a finally, so an abandoned or failed swarm never leaves workers
// (or a GPU context) behind.

import { withDeadline } from "./ondevice-core.js";
import {
  SWARM_CRITIQUE_MAX_TOKENS,
  SWARM_DRAFT_MAX_TOKENS,
  SWARM_SYNTH_MAX_TOKENS,
  agreementScore,
  parseCritique,
  planSwarmCapacity,
  ringPeers,
  selectConsensus,
  shouldContinue,
  swarmBrief,
  swarmCritiquePrompt,
  swarmMemberPrompt,
  swarmSynthesisPrompt,
  swarmUpdateEvent,
} from "./swarm-core.js";

/**
 * One member generation's wall-clock ceiling. Generous because it covers the
 * FIRST call's model compile on a phone (the engine's own streamIdleMs is
 * 300 s for the same reason) — but finite, because a swarm of 8 with one hung
 * member must still finish. A member that outlives it is marked failed and the
 * round proceeds without its draft.
 */
export const MEMBER_DEADLINE_MS = 300_000;
/** The whole node's ceiling — below the orchestrator's ORCH_NODE_TIMEOUT_MS. */
export const SWARM_DEADLINE_MS = 900_000;

// ---- the worker pool ----------------------------------------------------------
//
// `concurrency` live workers, reused across rounds so each pays the model
// compile ONCE. Members are not pinned to a worker: generation here is
// stateless (the whole prompt rides in `messages`), so a task queue over the
// pool is strictly better than affinity — a slow member cannot idle a worker
// its peers could be using.

/**
 * @param {(label: string) => { generate: (a: any) => Promise<string>, terminate: () => void }} spawn
 * @param {number} size
 */
export function createSwarmPool(spawn, size) {
  const handles = Array.from({ length: Math.max(1, size) }, (_, i) => spawn(`swarm-${i + 1}`));
  const free = handles.slice();
  /** @type {Array<(h: any) => void>} */
  const waiting = [];
  let dead = false;
  return {
    size: handles.length,
    /** @returns {Promise<any>} */
    acquire() {
      if (dead) return Promise.reject(new Error("The swarm was stopped."));
      const h = free.pop();
      return h ? Promise.resolve(h) : new Promise((resolve) => waiting.push(resolve));
    },
    /** @param {any} h */
    release(h) {
      const next = waiting.shift();
      if (next) next(h);
      else free.push(h);
    },
    terminate() {
      dead = true;
      for (const h of handles) {
        try {
          h.terminate();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

// ---- the node runner ----------------------------------------------------------

/**
 * Run ONE swarm node to completion.
 *
 * @param {{ id: string, task: string, swarmSize?: number, rounds?: number, name?: string }} node the workflow node
 * @param {{
 *   spawn: (label: string) => { generate: (a: any) => Promise<string>, terminate: () => void },
 *   modelId: string,
 *   modelLabel?: string,
 *   userRequest?: string,
 *   upstream?: string,
 *   device?: { hardwareConcurrency?: ?number, deviceMemoryGb?: ?number, modelBytes?: ?number, maxWorkers?: ?number },
 *   emit?: (ev: ReturnType<typeof swarmUpdateEvent>) => void,
 *   signal?: { aborted?: boolean },
 *   deadlineMs?: number,
 * }} opts
 * @returns {Promise<{ text: string, agreement: number, members: number, rounds: number, failed: number, leadIndex: number } | null>}
 */
export async function runSwarmNode(node, opts) {
  const cap = planSwarmCapacity({
    requested: node.swarmSize,
    rounds: node.rounds,
    hardwareConcurrency: opts.device?.hardwareConcurrency ?? null,
    deviceMemoryGb: opts.device?.deviceMemoryGb ?? null,
    modelBytes: opts.device?.modelBytes ?? null,
    maxWorkers: opts.device?.maxWorkers ?? null,
  });
  const pool = createSwarmPool(opts.spawn, cap.concurrency);
  /** @type {string[]} */
  const memberStates = Array.from({ length: cap.members }, () => "pending");
  let round = 1;
  let agreement = 0;
  let phase = "diverge";

  const publish = () =>
    opts.emit?.(
      swarmUpdateEvent(node.id, {
        round,
        rounds: cap.rounds,
        agreement,
        members: memberStates,
        model: opts.modelLabel || opts.modelId,
        phase,
      }),
    );

  /**
   * One member generation on a pooled worker. Never throws: a failure is a
   * marked member and an empty string, which the scorer already ignores.
   * @param {number} index the member whose state this call owns (-1 = none)
   * @param {string} prompt
   * @param {number} maxTokens
   */
  const generate = async (index, prompt, maxTokens) => {
    if (opts.signal?.aborted) return "";
    const handle = await pool.acquire().catch(() => null);
    if (!handle) return "";
    if (index >= 0) {
      memberStates[index] = "loading"; // flips to "running" on the first token
      publish();
    }
    try {
      const text = await withDeadline(
        handle.generate({
          modelId: opts.modelId,
          messages: [{ role: "user", content: prompt }],
          maxTokens,
          onToken: () => {
            if (index >= 0 && memberStates[index] === "loading") {
              memberStates[index] = "running";
              publish();
            }
          },
        }),
        opts.deadlineMs || MEMBER_DEADLINE_MS,
        "This swarm member timed out on this device.",
      );
      if (index >= 0) {
        memberStates[index] = String(text || "").trim() ? "done" : "failed";
        publish();
      }
      return String(text || "");
    } catch {
      if (index >= 0) {
        memberStates[index] = "failed";
        publish();
      }
      return "";
    } finally {
      pool.release(handle);
    }
  };

  try {
    /** @type {string[]} */
    let drafts = [];
    /** @type {ReturnType<typeof selectConsensus>} */
    let consensus = selectConsensus({ drafts: [] });
    let lead = "";
    /** @type {string[]} */
    let dissent = [];
    /** @type {string[]} */
    let keeps = [];

    for (; round <= cap.rounds; round++) {
      // ---- DIVERGE: every member answers the same task, in parallel ----------
      phase = "diverge";
      for (let i = 0; i < cap.members; i++) memberStates[i] = "pending";
      publish();
      drafts = await Promise.all(
        Array.from({ length: cap.members }, (_, i) =>
          generate(
            i,
            swarmMemberPrompt({
              task: node.task,
              index: i,
              members: cap.members,
              userRequest: opts.userRequest,
              upstream: opts.upstream,
              round,
              lead: round > 1 ? lead : "",
              dissent: round > 1 ? dissent : [],
            }),
            SWARM_DRAFT_MAX_TOKENS,
          ),
        ),
      );
      const alive = drafts.filter((d) => d.trim()).length;
      if (!alive) break; // nothing to converge on — the node fails soft below
      agreement = agreementScore(drafts);
      publish();

      // ---- CRITIQUE: the ring — each live draft is reviewed exactly once -----
      /** @type {Array<{verdict: string, flaw: string, keep: string}|null>} */
      const critiques = Array.from({ length: cap.members }, () => null);
      if (alive > 1 && !opts.signal?.aborted) {
        phase = "critique";
        publish();
        await Promise.all(
          ringPeers(cap.members)
            .filter((p) => drafts[p.target]?.trim() && drafts[p.critic]?.trim())
            .map(async (p) => {
              // Critiques do NOT own member state: the member has finished its
              // draft, and flipping its dot back to running would read as a
              // second answer in the graph.
              const text = await generate(
                -1,
                swarmCritiquePrompt({ task: node.task, peerIndex: p.target, draft: drafts[p.target] }),
                SWARM_CRITIQUE_MAX_TOKENS,
              );
              if (text.trim()) critiques[p.target] = parseCritique(text);
            }),
        );
      }

      // ---- CONVERGE: pure code decides, no model in the loop -----------------
      phase = "converge";
      consensus = selectConsensus({ drafts, critiques });
      lead = consensus.lead;
      dissent = consensus.dissent;
      keeps = consensus.keeps;
      agreement = consensus.agreement;
      publish();

      if (opts.signal?.aborted) break;
      if (!shouldContinue({ agreement, disputed: consensus.disputed, round, rounds: cap.rounds })) break;
    }
    const roundsRun = Math.min(round, cap.rounds);
    if (!lead) return null; // every member failed — the orchestrator degrades the node

    // ---- the consolidation pass ---------------------------------------------
    // One more generation, on the lead + what the swarm voted worth keeping. A
    // failure here is not fatal: the lead draft IS a usable answer, so the
    // brief falls back to it rather than losing the whole node's work.
    phase = "synthesis";
    publish();
    let text = lead;
    if (drafts.filter((d) => d.trim()).length > 1 && !opts.signal?.aborted) {
      const synth = await generate(
        -1,
        swarmSynthesisPrompt({
          task: node.task,
          lead,
          keeps,
          dissent,
          agreement,
          userRequest: opts.userRequest,
        }),
        SWARM_SYNTH_MAX_TOKENS,
      );
      if (synth.trim()) text = synth.trim();
    }

    const failed = memberStates.filter((s) => s === "failed").length;
    phase = "done";
    publish();
    return {
      text: swarmBrief({
        text,
        agreement,
        members: cap.members,
        rounds: roundsRun,
        modelLabel: opts.modelLabel || opts.modelId,
        dissent,
        failed,
      }),
      agreement,
      members: cap.members,
      rounds: roundsRun,
      failed,
      leadIndex: consensus.leadIndex,
    };
  } catch {
    return null; // fail-soft: the node degrades server-side
  } finally {
    pool.terminate();
  }
}

/**
 * Run every `swarm` node in a workflow plan, sequentially — two swarms at once
 * would fight over the same GPU and both would crawl. Returns the map the chat
 * request carries as `swarm_results`; nodes that produced nothing are simply
 * absent, and the server runs those as ordinary agents.
 * @param {{ agents: Array<{id: string, kind: string, task: string, swarmSize?: number, rounds?: number, name?: string}> }} plan
 * @param {Omit<Parameters<typeof runSwarmNode>[1], never>} opts
 * @returns {Promise<Record<string, { text: string, agreement: number, members: number, rounds: number, failed: number }>>}
 */
export async function runSwarmNodes(plan, opts) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const agent of (plan?.agents || []).filter((a) => a && a.kind === "swarm")) {
    if (opts.signal?.aborted) break;
    const res = await runSwarmNode(agent, opts);
    if (res) out[agent.id] = { text: res.text, agreement: res.agreement, members: res.members, rounds: res.rounds, failed: res.failed };
  }
  return out;
}

// ---- browser capability -------------------------------------------------------

/**
 * What this device can offer a swarm right now: the on-device knob must be on
 * AND at least one Bonsai build must already be in this browser's OPFS (the
 * consent rule — picking a swarm must never trigger a multi-GB download). The
 * SMALLEST cached model wins: a swarm wants many cheap members, not one big
 * one, and the tiny 1-bit builds are what make N of them fit at all.
 * Browser-only (dynamic imports); returns null when a swarm is not possible.
 * @returns {Promise<{ modelId: string, modelLabel: string, modelBytes: number, maxWorkers: number, hardwareConcurrency: ?number, deviceMemoryGb: ?number } | null>}
 */
export async function detectSwarmCapability() {
  try {
    const drs = await import("./ondevice-drs.js");
    if (!drs.onDeviceEnabled()) return null;
    const cached = await drs.cachedOnDeviceModels();
    if (!cached.length) return null;
    const pick = cached.slice().sort((a, b) => a.cachedBytes - b.cachedBytes)[0];
    const nav = /** @type {any} */ (globalThis.navigator) || {};
    return {
      modelId: pick.id,
      modelLabel: pick.label,
      modelBytes: pick.cachedBytes,
      maxWorkers: 4,
      hardwareConcurrency: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
      deviceMemoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    };
  } catch {
    return null; // no engine, no OPFS, blocked storage — no swarm, no error
  }
}

/**
 * The engine's member spawner, imported lazily so nothing on this path loads
 * the runtime until a swarm actually runs (the bandwidth guarantee).
 * @returns {Promise<(label: string) => { generate: (a: any) => Promise<string>, terminate: () => void }>}
 */
export async function engineSpawner() {
  const eng = await import("./ondevice-engine.js");
  return (label) => eng.spawnSwarmMember(label);
}
