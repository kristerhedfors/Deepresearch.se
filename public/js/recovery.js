// @ts-check
// Answer recovery — the polling client for the server's parked answers,
// extracted from stream.js.
//
// The server parks every finished answer in a short-lived cache
// (src/answers.js) keyed by x-request-id: if our stream dies, we poll the
// completed answer back instead of asking the user to resend; if it
// arrives intact, we ack so the server purges its copy immediately.
//
// This module is the transport half only — the poll loop with its rolling
// deadlines, the live "Still researching…" ticker, and the ack. What
// happens to a recovered answer (rendering it, appending it to history,
// persisting, arming the resume-across-relaunch pointer) stays with the
// conversation state in stream.js.

import { finishGenericStep, startGenericStep, updateGenericStep } from "./activity.js";

// Abort-aware sleep: a Stop press mid-wait resolves immediately instead of
// letting the button appear dead for up to a poll interval.
/**
 * @param {number} ms
 * @param {AbortSignal | null | undefined} signal
 * @returns {Promise<void>}
 */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });

/** @param {string} requestId */
export function ackAnswer(requestId) {
  if (!requestId) return;
  fetch("/api/chat/answer?id=" + encodeURIComponent(requestId), { method: "DELETE" }).catch(() => {});
}

// The pipeline may still be researching when our connection dies (it runs
// to completion server-side), so keep polling until well past the time
// budget. Repeated 404s mean recovery isn't available (no DB, or expired).
// `isCurrent` going false ends the poll early if the user starts a new
// chat meanwhile.
// Polls the server-parked answer. Returns { data, reason } where reason is:
//   "done"    — data holds the recovered answer
//   "lost"    — the server confirmed the run died (stale heartbeat)
//   "gone"    — no recovery row (no DB, or already expired/purged)
//   "empty"   — the run finished but produced nothing
//   "timeout" — still running when the deadline passed
//   "aborted" — a new chat/load ended the poll
//   "stopped" — the user pressed Stop (signal aborted) — the wait ends NOW,
//               the composer/buttons come back, and the server finishes (and
//               parks) its answer unobserved
// Once the server confirms the run is still going, the step shows a live
// elapsed counter so a long research run reads as progress, not a frozen
// app.
//
// Deadlines: the initial budget-derived deadline only governs the wait for a
// FIRST sign of life. Every poll that confirms the run is STILL GOING (the
// server heartbeats its recovery row every 15s precisely so this is
// answerable) extends the deadline by a rolling window — a production run
// (2026-07-08, ref 614e6f19: a 20s budget that legitimately took 251s after
// synthesis stalls/retries on a loaded Mistral Medium) finished COMPLETE on
// the server, but the fixed budget+120s deadline had abandoned the poll at
// 140s, stranding the user with nothing while a finished answer sat in the
// cache. A dead run can't string us along: its heartbeat goes stale and the
// server answers "lost" within ~45s. The hard cap matches the server's
// 15-minute answer TTL — past that there is nothing left to recover.
const RECOVERY_RUNNING_EXTENSION_MS = 90_000;
const RECOVERY_HARD_CAP_MS = 15 * 60 * 1000;
//
// `startLabel` null → SILENT recovery: poll WITHOUT adding any banner. This
// was originally the DEFAULT for in-session drops ("keep the banners already
// on screen — the honest view"), but that design failed in production
// (2026-07-08, request a77001ac): the surviving banner was a single spinning
// "Checking Google Maps…" step that never advances (step_done events aren't
// replayed to a dead stream), so a 203s server run read as STUCK FOREVER.
// In-session drops now settle the dead spinners and show this step's live
// elapsed counter too — the counter is driven by its own 1-second ticker,
// decoupled from the (slower, latency-variable) network poll so it ticks
// evenly instead of lurching by the poll interval.
/**
 * @param {any} turn  the assistant turn the recovery step renders into
 * @param {string} requestId
 * @param {number | null | undefined} budgetS
 * @param {() => boolean} isCurrent  false once another conversation owns the screen
 * @param {string | null} [startLabel]
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<{data: any, reason: string}>}
 */
export async function recoverAnswer(turn, requestId, budgetS, isCurrent, startLabel = null, signal = null) {
  if (!requestId) return { data: null, reason: "gone" };
  const showStep = !!startLabel;
  if (showStep) startGenericStep(turn, "recover", startLabel);
  const startedAt = Date.now();
  const hardCap = startedAt + RECOVERY_HARD_CAP_MS;
  let deadline = startedAt + ((budgetS || 60) + 120) * 1000;
  let misses = 0;
  let reason = "timeout";
  let running = false; // flips true once the server confirms it's still researching

  const ticker = showStep
    ? setInterval(() => {
        if (running) {
          updateGenericStep(turn, "recover", `Still researching on the server… (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        }
      }, 1000)
    : null;

  try {
    // Poll immediately first: on a boot resume the server usually finished
    // while we were away, so the answer is already parked and the very first
    // poll returns it — no wait. Only if it's still running do we sleep/re-poll.
    while (Date.now() < deadline && isCurrent() && !signal?.aborted) {
      try {
        const res = await fetch("/api/chat/answer?id=" + encodeURIComponent(requestId));
        if (res.status === 404) {
          if (++misses >= 3) { reason = "gone"; break; }
        } else if (res.ok) {
          const data = await res.json();
          if (data.status === "done") {
            if (!data.text) { reason = "empty"; break; }
            if (showStep) finishGenericStep(turn, { id: "recover", label: "Answer recovered after connection loss" });
            return { data, reason: "done" };
          }
          if (data.status === "lost") { reason = "lost"; break; } // server run died
          misses = 0; // still researching
          running = true;
          // Confirmed alive: keep waiting past the budget-derived deadline
          // (rolling window, hard-capped) — see the constants above.
          deadline = Math.min(hardCap, Math.max(deadline, Date.now() + RECOVERY_RUNNING_EXTENSION_MS));
        }
      } catch {
        // still offline — keep trying until the deadline
      }
      await sleep(4000, signal);
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
  if (!isCurrent()) reason = "aborted";
  else if (signal?.aborted) reason = "stopped";
  if (showStep) {
    finishGenericStep(turn, {
      id: "recover",
      label:
        reason === "lost"
          ? "Research was interrupted on the server"
          : reason === "stopped"
            ? "Stopped waiting — the research continues on the server"
            : "Could not recover the answer",
    });
  }
  return { data: null, reason };
}
