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
//
// MEMORY IS THE FAILURE MODE (feedback #26, 2026-07-26 — two Safari tab
// crashes "after some thinking"). N in-browser models is the largest
// allocation this app makes, so this module treats the worker count as a
// budget rather than a parameter:
//   - ONE run at a time. A new send calls stopSwarms() first, so a superseded
//     swarm's workers die instead of decoding alongside their replacements.
//   - ONE pool per run, shared by every swarm node in the plan.
//   - The pool is sized by planSwarmCapacity against the MODEL that is
//     actually cached here, plus live heap pressure where the browser reports
//     it; unknown memory buys a smaller pool, never a bigger one.
//   - An abandoned generation's worker is terminated and replaced, not reused.
//   - pagehide terminates everything.
// And because a renderer OOM cannot be caught at all, a durable breadcrumb is
// written BEFORE the workers spawn; swarmCrashDiag() reads it back on the next
// request so a run that killed the tab is reported instead of forgotten.

import {
  ONDEVICE_CRASH_KEY,
  crashClass,
  crashDiag,
  errorEventDetail,
  heapUsedRatio,
  rejectionDetail,
  runBreadcrumb,
  withDeadline,
} from "./ondevice-core.js";
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
/** How long a member may wait for a free worker before giving up its turn. */
export const ACQUIRE_DEADLINE_MS = 600_000;

// ---- the worker pool ----------------------------------------------------------
//
// `concurrency` live workers, reused across rounds so each pays the model
// compile ONCE. Members are not pinned to a worker: generation here is
// stateless (the whole prompt rides in `messages`), so a task queue over the
// pool is strictly better than affinity — a slow member cannot idle a worker
// its peers could be using.
//
// The pool is ALSO the memory budget: each live handle is a browser worker
// holding its own compiled copy of the weights, so `size` is the number that
// decides whether a tab survives (planSwarmCapacity sizes it). Two rules follow
// and both are enforced here rather than trusted to callers:
//   - a handle is never handed out twice (release is idempotent per task), and
//   - a handle whose generation had to be abandoned is REPLACED, not reused:
//     terminate frees its memory now, and a fresh handle takes its slot.

/**
 * @param {(label: string) => { generate: (a: any) => Promise<string>, terminate: () => void, abort?: () => void }} spawn
 * @param {number} size
 */
export function createSwarmPool(spawn, size) {
  let seq = 0;
  const handles = new Set(Array.from({ length: Math.max(1, size) }, () => spawn(`swarm-${++seq}`)));
  const free = [...handles];
  /** @type {Array<(h: any) => void>} */
  const waiting = [];
  let dead = false;
  /** @param {any} h */
  const hand = (h) => {
    const next = waiting.shift();
    if (next) next(h);
    else free.push(h);
  };
  return {
    size: handles.size,
    /** How many workers this pool is holding right now (the live footprint). */
    get live() {
      return handles.size;
    },
    /**
     * @param {number} [timeoutMs] a bounded wait: a pool that somehow never
     *   frees a worker must not hang the whole send (invariant 2).
     * @returns {Promise<any>}
     */
    acquire(timeoutMs) {
      if (dead) return Promise.reject(new Error("The swarm was stopped."));
      const h = free.pop();
      if (h) return Promise.resolve(h);
      return new Promise((resolve, reject) => {
        const entry = (/** @type {any} */ x) => {
          clearTimeout(timer);
          resolve(x);
        };
        const timer = setTimeout(() => {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error("No swarm worker became free."));
        }, Math.max(1, timeoutMs || ACQUIRE_DEADLINE_MS));
        // A timer must never keep Node's event loop (or a test) alive.
        /** @type {any} */ (timer)?.unref?.();
        waiting.push(entry);
      });
    },
    /** @param {any} h */
    release(h) {
      if (dead || !handles.has(h)) return;
      hand(h);
    },
    /**
     * Retire a handle whose generation was abandoned (deadline, crash) and put
     * a FRESH one in its place. Terminating now is the point: an abandoned
     * generation is still decoding, still holding a KV cache, and on the device
     * that reported this it is what pushes the tab over.
     * @param {any} h
     */
    replace(h) {
      if (dead || !handles.has(h)) return;
      handles.delete(h);
      try {
        h.terminate();
      } catch {
        /* already gone */
      }
      const fresh = spawn(`swarm-${++seq}`);
      handles.add(fresh);
      hand(fresh);
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
      handles.clear();
      free.length = 0;
      // Nothing may keep waiting on a dead pool.
      while (waiting.length) waiting.shift()?.(null);
    },
  };
}

// ---- live runs: one swarm at a time, and never past its send -------------------
//
// The failure this section exists for: a streamed send has no channel back to
// the page, so the swarm runs BEFORE the request — and nothing used to stop it
// when the user hit Stop, asked something else, or navigated. The workers kept
// decoding (up to five minutes per member) while the next send spawned a whole
// second set, so N in-browser models became 2N, then 3N. That is unbounded
// growth of the single most expensive object this app allocates, and on a
// browser with no memory API to warn us it ends as a dead tab.
//
// So: every run is registered, a new run SUPERSEDES the old one, and a
// superseded run sees `aborted` on its next check and unwinds through the same
// finally as a normal finish.

/** @type {Set<{terminate: () => void}>} */
const livePools = new Set();
let runSeq = 0;
let currentRun = 0;

/**
 * Stop every swarm running in this page: terminate the workers now (not at the
 * next GC) and mark live runs superseded. Safe to call at any time — from an
 * abort, a mode switch, a navigation, or before starting a new run.
 * @param {{ keepBreadcrumb?: boolean }} [opts]
 */
export function stopSwarms(opts = {}) {
  currentRun = 0;
  for (const pool of [...livePools]) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
  livePools.clear();
  // A deliberate stop is not a crash: drop the breadcrumb so a reload does not
  // report the user's own Stop as "your last run died".
  if (!opts.keepBreadcrumb) clearBreadcrumb();
}

/** Are any swarm workers alive in this page right now? */
export function swarmRunning() {
  return livePools.size > 0;
}

/**
 * The signal a run checks: aborted when the caller aborts OR when a newer run
 * has superseded this one.
 * @param {number} myRun
 * @param {{ aborted?: boolean }} [external]
 */
function runSignal(myRun, external) {
  return {
    get aborted() {
      return currentRun !== myRun || !!external?.aborted;
    },
  };
}

// ---- the crash breadcrumb + the guards that CAN fire ---------------------------
//
// The user's literal ask ("do you catch these crashes?"). Three layers, because
// no single one can cover a renderer OOM:
//   1. A durable BREADCRUMB written before the workers spawn (ondevice-core.js
//      runBreadcrumb) — the only thing that survives a tab the browser kills
//      outright. Cleared on a clean finish, so anything left behind means the
//      previous run did not reach the end.
//   2. window "error" / "unhandledrejection" for the failures that leave the
//      page alive — a wasm abort, a failed GPU allocation, a worker throw that
//      propagated. These stamp the breadcrumb with a CLASS ("oom"/"crash") and
//      tighten the run: no further rounds, no further members.
//   3. pagehide, which terminates the pool so a navigation cannot leave N model
//      instances decoding in a page nobody is watching.
// Everything reported is counters and classes (invariant 4) — no task text, no
// node ids, no prompts.

/**
 * The storage seam (localStorage in a browser, memory in Node — the test seam).
 * @type {{ getItem: (k: string) => ?string, setItem: (k: string, v: string) => void, removeItem: (k: string) => void }}
 */
let breadcrumbStore = (() => {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    /* storage blocked (Safari private mode) — fall through to memory */
  }
  /** @type {Map<string, string>} */
  const mem = new Map();
  return {
    getItem: (/** @type {string} */ k) => (mem.has(k) ? String(mem.get(k)) : null),
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => void mem.set(k, String(v)),
    removeItem: (/** @type {string} */ k) => void mem.delete(k),
  };
})();

/**
 * Swap the breadcrumb store (tests inject a fake; the browser never calls it).
 * @param {typeof breadcrumbStore} store
 */
export function setBreadcrumbStore(store) {
  breadcrumbStore = store;
}

/** @param {Parameters<typeof runBreadcrumb>[0]} rec */
function writeBreadcrumb(rec) {
  try {
    breadcrumbStore.setItem(ONDEVICE_CRASH_KEY, JSON.stringify(runBreadcrumb(rec)));
  } catch {
    /* storage full or blocked — the breadcrumb is best-effort by design */
  }
}

function clearBreadcrumb() {
  try {
    breadcrumbStore.removeItem(ONDEVICE_CRASH_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * The diagnostics block for a run that never finished — read ONCE (the record
 * is consumed) so the same death is reported on one request, not every one.
 * Returns undefined while a swarm is still live in this page and when the last
 * run ended cleanly. Feed it into /api/chat's existing `client_diag` counters
 * channel; it carries nothing but numbers and a failure class.
 * @param {number} [now]
 */
export function swarmCrashDiag(now = Date.now()) {
  if (swarmRunning()) return undefined;
  try {
    const raw = breadcrumbStore.getItem(ONDEVICE_CRASH_KEY);
    if (!raw) return undefined;
    clearBreadcrumb();
    return crashDiag(JSON.parse(raw), now);
  } catch {
    clearBreadcrumb();
    return undefined;
  }
}

/**
 * Install the page-level guards for the duration of a run. Returns the detach
 * function; the run's `finally` always calls it, so a finished swarm leaves no
 * listeners behind (the leak the guards themselves would otherwise be).
 * @param {(detail: string) => void} onCrash
 */
function installCrashGuards(onCrash) {
  const g = /** @type {any} */ (globalThis);
  if (typeof g.addEventListener !== "function") return () => {};
  const onError = (/** @type {any} */ e) => onCrash(errorEventDetail(e) || "uncaught error");
  const onRejection = (/** @type {any} */ e) => onCrash(rejectionDetail(e?.reason));
  const onHide = () => stopSwarms();
  try {
    g.addEventListener("error", onError);
    g.addEventListener("unhandledrejection", onRejection);
    g.addEventListener("pagehide", onHide);
  } catch {
    return () => {};
  }
  return () => {
    try {
      g.removeEventListener("error", onError);
      g.removeEventListener("unhandledrejection", onRejection);
      g.removeEventListener("pagehide", onHide);
    } catch {
      /* nothing to detach */
    }
  };
}

/** The live JS-heap fill, where the browser reports one (Chrome). @returns {?number} */
function currentHeapRatio() {
  try {
    return heapUsedRatio(/** @type {any} */ (globalThis).performance?.memory);
  } catch {
    return null;
  }
}

// ---- the node runner ----------------------------------------------------------

/**
 * The capacity THIS device will give a node, heap pressure included.
 * @param {{ swarmSize?: number, rounds?: number }} node
 * @param {{ device?: { hardwareConcurrency?: ?number, deviceMemoryGb?: ?number, modelBytes?: ?number, maxWorkers?: ?number }, heapUsedRatio?: ?number }} opts
 */
export function capacityFor(node, opts = {}) {
  return planSwarmCapacity({
    requested: node?.swarmSize,
    rounds: node?.rounds,
    hardwareConcurrency: opts.device?.hardwareConcurrency ?? null,
    deviceMemoryGb: opts.device?.deviceMemoryGb ?? null,
    modelBytes: opts.device?.modelBytes ?? null,
    maxWorkers: opts.device?.maxWorkers ?? null,
    heapUsedRatio: opts.heapUsedRatio ?? currentHeapRatio(),
  });
}

/**
 * Run ONE swarm node to completion.
 *
 * @param {{ id: string, task: string, swarmSize?: number, rounds?: number, name?: string }} node the workflow node
 * @param {{
 *   spawn: (label: string) => { generate: (a: any) => Promise<string>, terminate: () => void, abort?: () => void },
 *   modelId: string,
 *   modelLabel?: string,
 *   userRequest?: string,
 *   upstream?: string,
 *   device?: { hardwareConcurrency?: ?number, deviceMemoryGb?: ?number, modelBytes?: ?number, maxWorkers?: ?number },
 *   emit?: (ev: ReturnType<typeof swarmUpdateEvent>) => void,
 *   signal?: { aborted?: boolean },
 *   deadlineMs?: number,
 *   nodeDeadlineMs?: number,
 *   heapUsedRatio?: ?number,
 *   pool?: ReturnType<typeof createSwarmPool>,
 *   capacity?: ReturnType<typeof planSwarmCapacity>,
 *   onPressure?: (detail: string) => void,
 *   pressureSeen?: () => boolean,
 *   onPhase?: (phase: string, round: number) => void,
 * }} opts
 * @returns {Promise<{ text: string, agreement: number, members: number, rounds: number, failed: number, leadIndex: number } | null>}
 */
export async function runSwarmNode(node, opts) {
  const cap = opts.capacity || capacityFor(node, opts);
  // The pool may be OWNED by the caller (runSwarmNodes reuses one pool for the
  // whole run — spawning a fresh set of model instances per node was the second
  // way this page grew N models into 2N). A pool made here is terminated here.
  const pool = opts.pool || createSwarmPool(opts.spawn, cap.concurrency);
  const ownsPool = !opts.pool;
  livePools.add(pool);
  const startedAt = Date.now();
  const nodeDeadline = opts.nodeDeadlineMs || SWARM_DEADLINE_MS;
  const outOfTime = () => Date.now() - startedAt > nodeDeadline;
  /** @type {string[]} */
  const memberStates = Array.from({ length: cap.members }, () => "pending");
  let round = 1;
  let agreement = 0;
  let phase = "diverge";

  const publish = () => {
    // The durable breadcrumb follows the phase — this is the record that
    // survives a tab the browser kills mid-round (see onPhase in runSwarmNodes).
    opts.onPhase?.(phase, round);
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
  };

  /**
   * One member generation on a pooled worker. Never throws: a failure is a
   * marked member and an empty string, which the scorer already ignores.
   * @param {number} index the member whose state this call owns (-1 = none)
   * @param {string} prompt
   * @param {number} maxTokens
   */
  const generate = async (index, prompt, maxTokens) => {
    if (opts.signal?.aborted || outOfTime()) return "";
    const handle = await pool.acquire(opts.deadlineMs ? opts.deadlineMs * 2 : undefined).catch(() => null);
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
      pool.release(handle);
      return String(text || "");
    } catch (err) {
      if (index >= 0) {
        memberStates[index] = "failed";
        publish();
      }
      const detail = /** @type {{message?: string}} */ (err)?.message || "";
      // A memory failure inside a member is the crash we are hunting: record it
      // and let the run tighten (no further rounds) instead of spending the
      // next allocation on the same wall.
      if (crashClass(detail) === "oom") opts.onPressure?.(detail);
      // A DEADLINE does not stop the worker — it is still decoding, still
      // holding a KV cache — and handing that worker to the next member would
      // run two generations in one instance. Same for a memory failure: the
      // useful response is to free it now, not at some later GC. So abort what
      // we can and retire the worker, with a fresh one taking its slot. Any
      // other failure (a plain generation error) leaves an idle, healthy
      // worker: reuse it rather than paying another model compile.
      const cls = crashClass(detail);
      if (cls === "timeout" || cls === "oom") {
        try {
          handle.abort?.();
        } catch {
          /* nothing to abort */
        }
        pool.replace(handle);
      } else {
        pool.release(handle);
      }
      return "";
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

      if (opts.signal?.aborted || outOfTime()) break;
      // Memory pressure observed during this round (a member's OOM, or the page
      // guards catching a wasm/GPU allocation failure) ends the swarm here: one
      // more round is another full parallel decode, and the device just told us
      // it has nothing left. Fail soft — the round we have is a usable result.
      if (opts.pressureSeen?.()) break;
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
    // A pool this call owns dies with it; a caller-owned pool is the caller's
    // finally. Either way this node stops holding workers the moment it ends —
    // including when it ended by abort, supersession or a thrown failure.
    if (ownsPool) {
      pool.terminate();
      livePools.delete(pool);
    }
  }
}

/**
 * Run every `swarm` node in a workflow plan, sequentially — two swarms at once
 * would fight over the same GPU and both would crawl. Returns the map the chat
 * request carries as `swarm_results`; nodes that produced nothing are simply
 * absent, and the server runs those as ordinary agents.
 *
 * This function owns the RUN: it supersedes any swarm still running from an
 * older send, spawns ONE pool of workers for every node in the plan (rather
 * than a fresh set per node), arms the crash guards and the breadcrumb, and
 * tears all of it down in a finally — on success, on abort, on supersession
 * and on a thrown failure alike.
 *
 * @param {{ agents: Array<{id: string, kind: string, task: string, swarmSize?: number, rounds?: number, name?: string}> }} plan
 * @param {Omit<Parameters<typeof runSwarmNode>[1], never>} opts
 * @returns {Promise<Record<string, { text: string, agreement: number, members: number, rounds: number, failed: number }>>}
 */
export async function runSwarmNodes(plan, opts) {
  /** @type {Record<string, any>} */
  const out = {};
  const nodes = (plan?.agents || []).filter((a) => a && a.kind === "swarm");
  if (!nodes.length || opts.signal?.aborted) return out;

  // A new send supersedes whatever the previous one left running.
  stopSwarms();
  const myRun = ++runSeq;
  currentRun = myRun;
  const signal = runSignal(myRun, opts.signal);

  // ONE pool for the whole run, sized for the widest node this device allows.
  const heap = opts.heapUsedRatio ?? currentHeapRatio();
  const caps = nodes.map((n) => capacityFor(n, { device: opts.device, heapUsedRatio: heap }));
  const size = Math.max(1, ...caps.map((c) => c.concurrency));
  const members = Math.max(0, ...caps.map((c) => c.members));
  const rounds = Math.max(0, ...caps.map((c) => c.rounds));
  const modelMb = Math.round((Number(opts.device?.modelBytes) || 0) / 1e6);

  // THE BREADCRUMB, written before a single worker exists — the allocation
  // after this line is the one that can take the tab with it.
  const crumb = {
    startedAt: Date.now(),
    kind: "swarm",
    nodes: nodes.length,
    members,
    concurrency: size,
    rounds,
    round: 1,
    phase: "spawn",
    modelMb,
    cls: "",
  };
  writeBreadcrumb(crumb);

  let pressure = "";
  const onPressure = (/** @type {string} */ detail) => {
    if (!pressure) pressure = crashClass(detail) || "crash";
    crumb.cls = pressure;
    writeBreadcrumb(crumb);
  };
  const detach = installCrashGuards((detail) => {
    // Only memory-class page errors are treated as swarm pressure: an
    // unrelated script error must not cut a healthy swarm short.
    if (crashClass(detail) === "oom") onPressure(detail);
  });

  // Free the singleton engine's resident model before adding N more instances
  // next to it (no-op unless the composer's on-device route loaded one).
  await releaseHostModel();

  const pool = createSwarmPool(opts.spawn, size);
  livePools.add(pool);
  try {
    for (let i = 0; i < nodes.length; i++) {
      if (signal.aborted) break;
      const res = await runSwarmNode(nodes[i], {
        ...opts,
        signal,
        pool,
        capacity: caps[i],
        onPressure,
        pressureSeen: () => !!pressure,
        onPhase: (phase, round) => {
          if (crumb.phase === phase && crumb.round === round) return; // cheap: only on change
          crumb.phase = phase;
          crumb.round = round;
          writeBreadcrumb(crumb);
        },
      });
      if (res) out[nodes[i].id] = { text: res.text, agreement: res.agreement, members: res.members, rounds: res.rounds, failed: res.failed };
    }
  } finally {
    pool.terminate();
    livePools.delete(pool);
    detach();
    if (currentRun === myRun) currentRun = 0;
    // A run that finished (or was cleanly abandoned) leaves no breadcrumb —
    // unless memory pressure was actually observed, in which case the record
    // stays for the next request's diagnostics to pick up.
    if (pressure) {
      crumb.cls = pressure;
      writeBreadcrumb(crumb);
    } else {
      clearBreadcrumb();
    }
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
 * @returns {Promise<{ modelId: string, modelLabel: string, modelBytes: number, maxWorkers: number, hardwareConcurrency: ?number, deviceMemoryGb: ?number, heapUsedRatio: ?number } | null>}
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
      // Live pressure at the moment of the decision (Chrome only; null
      // elsewhere, which planSwarmCapacity reads as unknown, never as fine).
      heapUsedRatio: currentHeapRatio(),
    };
  } catch {
    return null; // no engine, no OPFS, blocked storage — no swarm, no error
  }
}

/**
 * Free the SINGLETON on-device engine's resident model before a swarm spawns
 * its own instances. The singleton (ondevice-engine.js) keeps whatever model
 * the composer's on-device picks last used compiled and resident for the life
 * of the page; adding N swarm instances on top of it is exactly the compounding
 * this tier cannot afford. Browser-only and fail-soft — the singleton reloads
 * lazily the next time something asks it to generate.
 */
export async function releaseHostModel() {
  try {
    if (typeof window === "undefined") return; // Node: nothing to release
    const eng = await import("./ondevice-engine.js");
    await eng.unloadOnDeviceModel?.();
  } catch {
    /* no engine, or it never loaded a model — nothing to free */
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
