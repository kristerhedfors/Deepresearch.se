// @ts-check
// The model lifecycle board's PURE CORE — everything about turning a
// /api/models/catalog row into what a card says, with no DOM in sight.
//
// It lives here (and not inside models-panel.js) for the reason every other
// *-core.js in this directory does: the numbers and the verdicts on these cards
// are the whole feature. "See what it costs and what it passed before you rely
// on it" is only worth anything if both are right, and a formatter is testable
// in Node's runner while a card renderer is not.
//
// Two rules run through all of it:
//   · Never invent a number. A model with no published price says so; a
//     per-turn estimate is always labelled as an estimate and always carries the
//     assumption it was computed from.
//   · Never invent a verdict. An untested check is UNTESTED — visually distinct
//     from both a pass and a fail — because "nobody has asked yet" and "we
//     asked and it failed" are different facts and the sidebar must not blur
//     them.

/**
 * A catalog row as /api/models/catalog serves it (src/model-catalog.js CatalogRow).
 * @typedef {{
 *   id: string, name: string, provider: string, providerLabel: string,
 *   state: "discovered"|"available"|"enabled", usable: boolean,
 *   vision: boolean, tools: boolean, context: number|null,
 *   price_in: number, price_out: number, usd_in: number|null, usd_out: number|null,
 *   pricing: string|null, turn_eur: number|null, url: string|null, servedBy: string|null,
 *   up: boolean, enableable: boolean, reason: string|null,
 *   checks: Array<{id:string,label:string,why:string,state:"pass"|"fail"|"untested",note:string,at:number|null,ms:number|null}>,
 *   verification: { pass:number, fail:number, untested:number, total:number, label:string },
 * }} ModelRow
 */

/**
 * Money, at the precision the number deserves: a research turn on a cheap model
 * costs fractions of a cent, and rounding that to "€0.00" would hide exactly
 * the difference the board exists to show.
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
 * The per-1M-token rate line. In the provider's own USD when it publishes one
 * (that is the number you can go and check on their pricing page), otherwise
 * the EUR figure the catalog carries.
 * @param {ModelRow} row
 * @returns {string}
 */
export function rateLine(row) {
  if (row.usd_out !== null && row.usd_out !== undefined) {
    const inp = row.usd_in === null || row.usd_in === undefined ? "?" : `$${row.usd_in}`;
    return `${inp} in / $${row.usd_out} out per 1M tokens`;
  }
  return row.pricing || "no published price";
}

/**
 * The estimate line. Always says "≈" and always names the turn it assumes, so
 * nobody reads it as a quote.
 * @param {ModelRow} row
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
 * how much you can feed it, and the provider identity last.
 * @param {ModelRow} row
 * @returns {string[]}
 */
export function badges(row) {
  const out = [];
  if (row.vision) out.push("vision");
  if (row.tools) out.push("tools");
  if (row.context) out.push(`${Math.round(row.context / 1000)}k ctx`);
  if (row.servedBy) out.push(row.servedBy);
  return out;
}

/** The lifecycle states, in board order — the order the sidebar groups by. */
export const LIFECYCLE = [
  {
    id: "enabled",
    label: "Enabled",
    blurb: "Turned on by you. Selectable in every chat mode.",
  },
  {
    id: "available",
    label: "Available",
    blurb: "Shipped by a configured provider. Already selectable everywhere — nothing to enable.",
  },
  {
    id: "discovered",
    label: "Discovered",
    blurb: "Listed by an open provider catalog. Enable one to put it in your dropdown.",
  },
];

/**
 * Group rows by lifecycle state, in board order, dropping empty groups. The
 * sidebar's whole shape.
 * @param {ModelRow[]} rows
 * @returns {Array<{ id: string, label: string, blurb: string, rows: ModelRow[] }>}
 */
export function groupByState(rows) {
  return LIFECYCLE
    .map((g) => ({ ...g, rows: rows.filter((r) => r.state === g.id) }))
    .filter((g) => g.rows.length);
}

/**
 * The check glyph. Three states, three glyphs — an untested check must never
 * render as a failure, which a two-state checkbox would force it to.
 * @param {string} state
 * @returns {string}
 */
export function checkGlyph(state) {
  return state === "pass" ? "✓" : state === "fail" ? "✕" : "·";
}

/**
 * The tooltip for one checkbox: what the check proves, what happened, and when.
 * @param {{ label: string, why: string, state: string, note: string, at: number|null }} c
 * @returns {string}
 */
export function checkTitle(c) {
  const head = c.state === "untested" ? `${c.label} — not run yet` : `${c.label} — ${c.state === "pass" ? "passed" : "failed"}`;
  const when = c.at ? ` (${new Date(c.at).toISOString().slice(0, 10)})` : "";
  return [head + when, c.note, "", c.why].filter((p) => p !== undefined).join("\n").trim();
}

/**
 * What the card's primary button says and whether it can be pressed.
 *
 * Four states, and the disabled ones always carry the server's own reason —
 * a greyed-out button with no explanation is the thing this avoids.
 * @param {ModelRow} row
 * @returns {{ label: string, action: "enable"|"disable"|"none", disabled: boolean, title: string }}
 */
export function primaryAction(row) {
  if (row.state === "enabled") {
    return {
      label: "Enabled ✓",
      action: "disable",
      disabled: false,
      title: "Enabled for every chat mode — press to turn it off again. Its verification results are kept.",
    };
  }
  if (row.state === "available") {
    return {
      label: "Available",
      action: "none",
      disabled: true,
      title: `${row.providerLabel} ships this model and it is already selectable in every chat mode — there is nothing to enable.`,
    };
  }
  if (!row.enableable) {
    return { label: "Enable", action: "enable", disabled: true, title: row.reason || "Outside your model allowance." };
  }
  return {
    label: "Enable",
    action: "enable",
    disabled: false,
    title: "Add it to your model menu — it becomes selectable in every chat mode",
  };
}

/**
 * Whether the Verify button applies. Verification runs REAL requests, so it
 * needs a model that can actually be routed to — which a discovered model
 * cannot be until it is enabled.
 * @param {ModelRow} row
 * @returns {{ shown: boolean, title: string }}
 */
export function verifyAction(row) {
  if (!row.usable) {
    return { shown: false, title: "Enable this model first — the checks run real requests against it." };
  }
  const n = row.verification.untested;
  return {
    shown: true,
    title: n === row.verification.total
      ? `Run all ${n} checks against this model. Real requests, billed like any other.`
      : `Re-run all ${row.verification.total} checks. ${n ? `${n} have never been run.` : "All have run at least once."}`,
  };
}

/**
 * The allowance line above the board: what is used, what the ceiling is, and —
 * the part that matters — that this is a STARTING allowance rather than a
 * permanent one.
 * @param {{ max_output_usd: number, max_enabled: number, used: number }|null|undefined} a
 * @returns {string}
 */
export function allowanceLine(a) {
  if (!a) return "";
  const cap = a.max_enabled > 0 ? `${a.used}/${a.max_enabled} models enabled` : `${a.used} models enabled`;
  const price = a.max_output_usd > 0 ? `, up to $${a.max_output_usd}/1M output tokens` : "";
  return `Your model allowance: ${cap}${price}. It starts here and an admin can raise it.`;
}

/**
 * The providers line: who this deployment can actually reach, and which of them
 * has an open catalog. Answers "why is nothing from X showing" before it is
 * asked.
 * @param {Array<{ id: string, label: string, open: boolean, configured: boolean, count: number }>} providers
 * @returns {string}
 */
export function providersLine(providers) {
  if (!Array.isArray(providers) || !providers.length) return "";
  const on = providers.filter((p) => p.configured);
  const off = providers.filter((p) => !p.configured);
  const parts = on.map((p) => `${p.label} (${p.count}${p.open ? ", open catalog" : ""})`);
  const tail = off.length ? ` · not configured here: ${off.map((p) => p.label).join(", ")}` : "";
  return parts.length ? `Providers: ${parts.join(", ")}${tail}` : `No provider is configured on this server${tail}`;
}

/**
 * Client-side filtering, so typing in the board's search box narrows instantly
 * instead of waiting on a round trip. Deliberately the SAME shape of lexical
 * scan the server runs (src/model-catalog.js rankCatalog) — the server's
 * ordering is authoritative for what is FETCHED, this only narrows what is
 * already on screen.
 * @param {ModelRow[]} rows
 * @param {string} query
 * @returns {ModelRow[]}
 */
export function filterRows(rows, query) {
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9.+-]+/).filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.id} ${r.name} ${r.providerLabel} ${r.servedBy || ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
