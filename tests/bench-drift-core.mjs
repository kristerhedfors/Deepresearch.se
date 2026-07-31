// Per-question and per-source drift attribution — the pure core behind the
// bench gate's report. I/O-free and Node-tested (bench-drift.test.js), so the
// arithmetic that decides "which question moved, and which retrieval leg does
// it touch" is checkable without spending a live battery.
//
// WHY THIS EXISTS. The gate compared battery MEANS and nothing else, and a
// mean hides where a change landed. Six consecutive runs sat ~0.6 below the
// 2026-07-23 baseline; only when the per-question values were read by hand did
// it emerge that `mh_semiconductor_export` had fallen ~1.2 on its own and
// "never once approached its recorded baseline", while the rest of the battery
// moved far less. That is a different investigation from "the pipeline got
// worse" — and it was available in data the gate already collected and threw
// away at print time.
//
// The per-SOURCE rollup exists for the same reason one step out. A retrieval
// corpus (arXiv, PubMed) changes answers only on the questions whose intent
// gate it fires for, so a corpus regression is invisible in a battery mean
// diluted by questions that never touch it. Attributing by source turns "the
// battery fell" into "the questions that reach this leg fell, the others did
// not" — which is the claim a corpus change can actually be judged on.

/** A question is "moved" when its delta exceeds this, in judge points. */
export const MOVE_THRESHOLD = 0.5;

/**
 * Per-question deltas between a baseline and a candidate run.
 *
 * Questions present in only one side are reported with `delta: null` rather
 * than dropped: a battery that gained or lost a question between the two
 * measurements is a fact about the comparison, and silently omitting it is how
 * a shrinking battery reads as a stable one.
 *
 * @param {Record<string, {overall?: {mean?: number, n?: number}}>} baseline perQuestion block
 * @param {Record<string, {overall?: {mean?: number, n?: number}}>} candidate perQuestion block
 * @returns {Array<{qid: string, base: number|null, cand: number|null, delta: number|null, moved: boolean}>}
 *   sorted most-negative delta first, so the biggest faller leads the report
 */
export function perQuestionDrift(baseline, candidate) {
  const qids = [...new Set([...Object.keys(baseline || {}), ...Object.keys(candidate || {})])];
  const rows = qids.map((qid) => {
    const base = num(baseline?.[qid]?.overall?.mean);
    const cand = num(candidate?.[qid]?.overall?.mean);
    const delta = base === null || cand === null ? null : +(cand - base).toFixed(3);
    return { qid, base, cand, delta, moved: delta !== null && Math.abs(delta) >= MOVE_THRESHOLD };
  });
  // Missing-on-one-side rows sort last: they carry no delta to rank by, and
  // burying them under the real movers keeps the head of the report useful.
  return rows.sort((a, b) => {
    if (a.delta === null && b.delta === null) return a.qid.localeCompare(b.qid);
    if (a.delta === null) return 1;
    if (b.delta === null) return -1;
    return a.delta - b.delta;
  });
}

/**
 * Roll per-question deltas up by the retrieval source each question reaches.
 *
 * `sourcesOf` is injected rather than imported so this core stays I/O-free and
 * the test can pin the arithmetic against a fixed mapping — the real caller
 * passes a closure over the live `SEARCH_SOURCES` intent gates.
 *
 * A question that reaches several sources counts toward EACH of them. That is
 * deliberate and it is why `n` is reported per source: these buckets overlap,
 * so a source's mean is "how the questions that can reach this leg moved", not
 * an exclusive attribution. Treating it as exclusive would be the mistake this
 * whole report exists to avoid.
 *
 * The `(none)` bucket — questions no source reaches — is the control group.
 * If it moved as much as the source buckets, the drift is not about retrieval
 * at all, and that is the single most useful thing this table can tell you.
 *
 * @param {Array<{qid: string, delta: number|null}>} rows from perQuestionDrift
 * @param {(qid: string) => string[]} sourcesOf question id → source ids it reaches
 * @returns {Array<{source: string, n: number, mean: number, qids: string[]}>}
 *   sorted most-negative mean first
 */
export function perSourceDrift(rows, sourcesOf) {
  /** @type {Map<string, {deltas: number[], qids: string[]}>} */
  const buckets = new Map();
  for (const row of rows) {
    if (row.delta === null) continue;
    const ids = sourcesOf(row.qid);
    const keys = ids && ids.length ? ids : ["(none)"];
    for (const key of keys) {
      if (!buckets.has(key)) buckets.set(key, { deltas: [], qids: [] });
      const b = /** @type {{deltas: number[], qids: string[]}} */ (buckets.get(key));
      b.deltas.push(row.delta);
      b.qids.push(row.qid);
    }
  }
  return [...buckets.entries()]
    .map(([source, b]) => ({
      source,
      n: b.deltas.length,
      mean: +(b.deltas.reduce((a, x) => a + x, 0) / b.deltas.length).toFixed(3),
      qids: b.qids,
    }))
    .sort((a, b) => a.mean - b.mean || a.source.localeCompare(b.source));
}

/**
 * Which registered sources no question in the bank reaches.
 *
 * A source with zero coverage cannot be measured: the gate will report NEUTRAL
 * on it whatever it does to answers. That is not hypothetical here — Europe PMC
 * sat at zero while PubMed was being ingested as a second hosted corpus, and
 * arXiv arrived through the same blind spot between the 07-23 baseline and the
 * first re-measurement.
 * @param {string[]} sourceIds every registered source id
 * @param {string[][]} perQuestionSources one entry per question: the sources it reaches
 * @returns {string[]} uncovered source ids, sorted
 */
export function uncoveredSources(sourceIds, perQuestionSources) {
  const seen = new Set();
  for (const list of perQuestionSources || []) for (const id of list || []) seen.add(id);
  return (sourceIds || []).filter((id) => !seen.has(id)).sort();
}

/**
 * Render the drift tables for the gate's console output and the ledger paste.
 * @param {ReturnType<typeof perQuestionDrift>} questionRows
 * @param {ReturnType<typeof perSourceDrift>} sourceRows
 * @returns {string}
 */
export function formatDrift(questionRows, sourceRows) {
  const out = [];
  out.push("\n--- per-question drift (most-negative first) ---");
  out.push(`${"question".padEnd(30)}${"base".padStart(7)}${"cand".padStart(7)}${"delta".padStart(8)}`);
  for (const r of questionRows) {
    const mark = r.moved ? "  <-- moved" : "";
    const base = r.base === null ? "  --" : r.base.toFixed(2);
    const cand = r.cand === null ? "  --" : r.cand.toFixed(2);
    const delta = r.delta === null ? "   n/a" : `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)}`;
    out.push(`${r.qid.padEnd(30)}${base.padStart(7)}${cand.padStart(7)}${delta.padStart(8)}${mark}`);
  }
  out.push("\n--- per-source drift (buckets OVERLAP; '(none)' is the control) ---");
  out.push(`${"source".padEnd(14)}${"n".padStart(4)}${"mean delta".padStart(12)}`);
  for (const r of sourceRows) {
    out.push(`${r.source.padEnd(14)}${String(r.n).padStart(4)}${`${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(2)}`.padStart(12)}`);
  }
  return out.join("\n");
}

/** @param {unknown} v @returns {number|null} */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
