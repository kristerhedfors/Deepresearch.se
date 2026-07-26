// @ts-check
// The Hugging Face model picker's PURE CORE — everything about turning a
// /api/hf/models row into what a card says, with no DOM in sight.
//
// It lives here (and not inside hf-models.js) for the reason every other
// *-core.js in this directory does: the numbers on these cards are the whole
// feature. "Presented with some cost info before starting the model" is only
// worth anything if the cost is right, and a formatter is testable in Node's
// runner while a card renderer is not.
//
// One rule runs through all of it: never invent a number. A model with no
// published price says so; a per-turn estimate is always labelled as an
// estimate and always carries the assumption it was computed from.

/**
 * A browse row as /api/hf/models serves it (src/hf-inference.js HfBrowseItem).
 * @typedef {{
 *   id: string, hfId: string, name: string, owner: string, url: string,
 *   vision: boolean, context: number|null, provider: string|null,
 *   providers: string[], usd_in: number|null, usd_out: number|null,
 *   price_in: number, price_out: number, pricing: string|null,
 *   turn_eur: number|null, tools: boolean, allowed: boolean,
 *   reason: string|null, accepted: boolean,
 * }} HfRow
 */

/**
 * Money, at the precision the number deserves: a research turn on a cheap model
 * costs fractions of a cent, and rounding that to "€0.00" would hide exactly
 * the difference the picker exists to show.
 * @param {number|null|undefined} eur
 * @returns {string}
 */
export function formatEur(eur) {
  if (typeof eur !== "number" || !Number.isFinite(eur)) return "—";
  if (eur === 0) return "€0";
  if (eur < 0.001) return "<€0.001";
  if (eur < 1) return "€" + eur.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return "€" + eur.toFixed(2);
}

/**
 * The per-1M-token rate line, in the provider's own currency (USD) because that
 * is the number the user will recognize from Hugging Face's own pages.
 * @param {HfRow} row
 * @returns {string}
 */
export function rateLine(row) {
  if (row.usd_out === null || row.usd_out === undefined) return "no published price";
  const inp = row.usd_in === null || row.usd_in === undefined ? "?" : `$${row.usd_in}`;
  return `${inp} in / $${row.usd_out} out per 1M tokens`;
}

/**
 * The estimate line. Always says "≈" and always names the turn it assumes, so
 * nobody reads it as a quote.
 * @param {HfRow} row
 * @param {{ prompt: number, completion: number }} [turn]
 * @returns {string}
 */
export function estimateLine(row, turn) {
  if (row.turn_eur === null || row.turn_eur === undefined) return "";
  const t = turn && turn.prompt ? turn : { prompt: 12000, completion: 1200 };
  return `≈ ${formatEur(row.turn_eur)} per research turn (${Math.round(t.prompt / 1000)}k in / ${Math.round(t.completion / 1000)}k out)`;
}

/**
 * The short badges under a card's title. Ordered so the two that change what
 * you can DO with the model (vision, tools) come before the one that changes
 * how much you can feed it.
 * @param {HfRow} row
 * @returns {string[]}
 */
export function badges(row) {
  const out = [];
  if (row.vision) out.push("vision");
  if (row.tools) out.push("tools");
  if (row.context) out.push(`${Math.round(row.context / 1000)}k ctx`);
  if (row.provider) out.push(row.provider);
  return out;
}

/**
 * What the card's primary button says and whether it can be pressed. Three
 * states, and the disabled one always carries the server's own reason —
 * a greyed-out button with no explanation is the thing this avoids.
 * @param {HfRow} row
 * @returns {{ label: string, action: "remove"|"accept", disabled: boolean, title: string }}
 */
export function primaryAction(row) {
  if (row.accepted) {
    return {
      label: "Enabled ✓",
      action: "remove",
      disabled: false,
      title: "Enabled for every chat mode — press to remove it again",
    };
  }
  if (!row.allowed) {
    return {
      label: "Enable",
      action: "accept",
      disabled: true,
      title: row.reason || "Outside your model allowance.",
    };
  }
  return {
    label: "Enable",
    action: "accept",
    disabled: false,
    title: "Add it to your model menu — it becomes selectable in every chat mode",
  };
}

/**
 * The allowance line above the list: what is used, what the ceiling is, and —
 * the part that matters — that this is a STARTING allowance rather than a
 * permanent one.
 * @param {{ max_output_usd: number, max_accepted: number, used: number }|null|undefined} a
 * @returns {string}
 */
export function allowanceLine(a) {
  if (!a) return "";
  const cap = a.max_accepted > 0 ? `${a.used}/${a.max_accepted} models enabled` : `${a.used} models enabled`;
  const price = a.max_output_usd > 0 ? `, up to $${a.max_output_usd}/1M output tokens` : "";
  return `Your model allowance: ${cap}${price}. It starts here and an admin can raise it.`;
}

/**
 * Client-side ranking, so typing in the picker's search box filters instantly
 * instead of waiting on a round trip. Deliberately the SAME shape of lexical
 * scan the server runs (src/hf-inference.js hfRankModels) — the server's
 * ordering is authoritative for what is FETCHED, this only narrows what is
 * already on screen.
 * @param {HfRow[]} rows
 * @param {string} query
 * @returns {HfRow[]}
 */
export function filterRows(rows, query) {
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9.+-]+/).filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter((r) => {
    const hay = (r.hfId + " " + (r.provider || "")).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * The dropdown label an accepted model gets, matching the flag-prefixed style
 * the rest of the catalog uses (provider-region.js does the flags; a hub model
 * is served by whichever provider HF routed it to, so it wears the hub's own
 * mark instead of a country flag).
 * @param {{ name: string, hfId: string }} m
 * @returns {string}
 */
export function acceptedLabel(m) {
  return `🤗 ${m.name || m.hfId}`;
}
