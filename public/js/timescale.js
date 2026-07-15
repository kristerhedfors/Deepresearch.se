// @ts-check
// Research time-target scale (pure functions). The slider position (0-100)
// maps quadratically to 15s–10min so the low end has fine granularity while
// the top still reaches 10 minutes. Mirrored by the server's clamp in
// src/budget.js.

export const BUDGET_MIN_S = 15;
export const BUDGET_MAX_S = 600;

/**
 * @param {number} p slider position, 0-100
 * @returns {number} target seconds, clamped to [BUDGET_MIN_S, BUDGET_MAX_S]
 */
export function posToSeconds(p) {
  const raw = BUDGET_MIN_S + (BUDGET_MAX_S - BUDGET_MIN_S) * Math.pow(p / 100, 2);
  const step = raw < 60 ? 5 : raw < 180 ? 15 : 30; // human-friendly increments
  return Math.min(BUDGET_MAX_S, Math.max(BUDGET_MIN_S, Math.round(raw / step) * step));
}

/**
 * @param {number} s target seconds
 * @returns {number} slider position, 0-100 (inverse of posToSeconds' curve)
 */
export function secondsToPos(s) {
  return Math.round(100 * Math.sqrt((s - BUDGET_MIN_S) / (BUDGET_MAX_S - BUDGET_MIN_S)));
}

/**
 * @param {number} s seconds
 * @returns {string} human label ("45 s", "2 m", "2 m 30 s")
 */
export function fmtBudget(s) {
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60), r = s % 60;
  return r ? m + " m " + r + " s" : m + " m";
}

// Report-comprehensiveness tier for a budget — MIRRORS src/budget.js's
// reportTierFor boundaries (the slider buys OUTPUT depth, not just research
// depth: the server scales the answer's structure/length with this tier, so
// the readout names what the setting DELIVERS, not only how long it runs).
// `label` is the compact word under the time readout; `desc` the tooltip.
/**
 * @param {number} s target seconds
 * @returns {{ id: "brief"|"standard"|"extended"|"full", label: string, desc: string }}
 */
export function budgetTier(s) {
  if (s >= 420) return { id: "full", label: "Full report", desc: "Maximum research and a full research report: executive summary, thematic sections, tables, limitations" };
  if (s >= 180) return { id: "extended", label: "Report", desc: "Extended research and a structured report with sections and limitations" };
  if (s >= 60) return { id: "standard", label: "Answer", desc: "A focused answer: conclusion plus key findings with citations" };
  return { id: "brief", label: "Brief", desc: "A quick compact brief: direct answer plus a few cited key facts" };
}
