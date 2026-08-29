// @ts-check
// The Worker's half of the lypning stats agent.
//
// It is deliberately thin. All of the arithmetic and every sentence that states
// a number lives in public/js/lypning-core.js — the same module the dashboard
// runs in the browser — and this file only loads the committed dataset and
// hands it over. The failure this prevents is specific and it is the one a
// stats agent fails at: the reader is looking at a chart, asks about it, and
// gets an answer computed a second way that quietly disagrees.
//
// Nothing here imports lypning. The dependency is build-time and image-time
// only (CLAUDE.md invariant 5): the Worker reads a JSON file that
// scripts/build-lypning.mjs wrote from a lypning clone, and that is the whole
// of it.

export {
  movement,
  seriesPoints,
  formatValue,
  statsContextBlock,
  answerLocally,
  matchSeries,
  wantsRun,
} from "../public/js/lypning-core.js";

import { statsContextBlock } from "../public/js/lypning-core.js";

/** Where scripts/build-lypning.mjs writes, and where the page reads. */
export const HISTORY_PATH = "/lypning/history.json";

/**
 * The committed history, through the ASSETS binding.
 *
 * Null, never a throw, when it is missing or unreadable — a deployment whose
 * dataset failed to load answers about lypning without the historical half
 * rather than erroring the request (invariant 2). The caller's context block
 * then says the history is unavailable, which is a true sentence; inventing
 * figures to fill it would not be.
 *
 * @param {import('./types.js').Env} env
 * @param {any} log
 * @returns {Promise<any | null>}
 */
export async function loadLypningHistory(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    // The binding routes by path; the host is a placeholder.
    const res = await assets.fetch(new Request("https://assets.internal" + HISTORY_PATH));
    if (!res.ok) {
      log?.warn?.("lypning.history_missing", { status: res.status });
      return null;
    }
    const data = /** @type {any} */ (await res.json());
    if (!data || !Array.isArray(data.commits) || !Array.isArray(data.series)) {
      log?.warn?.("lypning.history_invalid", {});
      return null;
    }
    return data;
  } catch (/** @type {any} */ err) {
    log?.warn?.("lypning.history_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * The context block for a lypning-agent turn.
 *
 * `live` is whatever the page measured in the reader's own VM and sent up with
 * the question; it is absent for a turn that did not come from the dashboard.
 * Either way the block SAYS which it is, because "the reader has no numbers of
 * their own" and "the reader's machine is fast" are different facts and an
 * agent that blurred them would be quoting somebody else's benchmark as the
 * reader's.
 *
 * @param {import('./types.js').Env} env
 * @param {any} log
 * @param {any} [live] the dashboard's live summary, when the turn came from it
 * @returns {Promise<string>}
 */
export async function lypningContextBlock(env, log, live = null) {
  const history = await loadLypningHistory(env, log);
  if (!history) {
    return (
      "LYPNING STATS: the committed history could not be loaded on this deployment, " +
      "so there are no figures to answer from. Say so rather than recalling numbers — " +
      "lypning's own rule is that a remembered corpus size is never quoted as a measurement. " +
      "Point the reader at https://github.com/kristerhedfors/lypning and at /lypning/, " +
      "where the battery measures their own machine."
    );
  }
  return statsContextBlock(history, live);
}
