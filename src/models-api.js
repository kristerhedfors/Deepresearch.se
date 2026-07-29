// @ts-check
// THE MODEL LIFECYCLE API — explore, evaluate, enable.
//
// Four endpoints under /api/models, all signed-in. `GET /api/models` itself is
// untouched and still serves the answer-model dropdown (src/user-api.js); these
// are its sub-paths, and the split is deliberate — the dropdown wants a short
// list of things you can pick right now, this wants everything there is with
// everything known about it.
//
//   GET  /api/models/catalog?q=…   every model this deployment can reach, from
//                                  every provider, with its lifecycle state,
//                                  its price in both currencies, and its
//                                  verification checklist.
//   POST /api/models/verify        run the established checks against one model
//                                  and record the results. Never a gate — the
//                                  answer is evidence, not permission.
//   POST /api/models/enable        move a discovered model to enabled, which is
//                                  what puts it in every mode's dropdown.
//   POST /api/models/disable       the reverse. The verification record SURVIVES:
//                                  what was learned about a model stays learned.
//
// Privacy (invariant 4): the browse query is matched LOCALLY against catalogs
// this Worker already fetched — no search term is forwarded to any provider.
// Verification sends only the fixed probe strings written in
// src/model-checks.js; no user content, no conversation, no identity.
//
// Fail-soft (invariant 2): an unreachable provider yields fewer rows and a
// spelled-out `note`, not a 502. A user with models already enabled keeps using
// them through any outage.

import { getConfig } from "./config.js";
import { jsonResponse, readJsonBody } from "./http.js";
import {
  applyAllowance,
  buildCatalog,
  modelAllowance,
  rankCatalog,
  TYPICAL_TURN,
} from "./model-catalog.js";
import { MODEL_CHECKS, runChecks } from "./model-checks.js";
import { hfRouterModels } from "./hf-inference.js";
import {
  accountModels,
  acceptedFromBrowseItem,
  acceptModel,
  clearChecks,
  enabledModels,
  hfRefreshNotes,
  recordChecks,
  removeAcceptedModel,
} from "./user-models.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

/** How many rows one browse returns. The sidebar is a scroll list, not a
 * catalog dump — a query that matches everything is a query worth refining. */
const PAGE = 60;

/** @param {Identity} identity */
function needsAccount(identity) {
  return identity?.user
    ? null
    : jsonResponse({ error: "The model lifecycle needs a signed-in account (not break-glass)." }, 403);
}

/**
 * The envelope every response here carries: the allowance, how it is being
 * spent, the turn the price estimates assume, and the full check vocabulary.
 * Shipping the vocabulary on every response means the sidebar can render a
 * checklist for a model it has never seen verified, with the right labels and
 * the right explanations, without a second round trip.
 * @param {import('./model-catalog.js').ModelAllowance} allowance
 * @param {number} enabledCount
 */
function envelope(allowance, enabledCount) {
  return {
    allowance: {
      max_output_usd: allowance.maxOutputUsd,
      max_enabled: allowance.maxEnabled,
      used: enabledCount,
    },
    turn: TYPICAL_TURN,
    checks: MODEL_CHECKS.map((c) => ({ id: c.id, label: c.label, why: c.why })),
  };
}

/**
 * GET /api/models/catalog?q=…
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleModelCatalog(env, log, identity, url) {
  const anon = needsAccount(identity);
  if (anon) return anon;
  const [config, built] = await Promise.all([getConfig(env), buildCatalog(env, log, accountModels(identity))]);
  const allowance = modelAllowance(config);
  applyAllowance(built.rows, allowance);
  const enabled = enabledModels(identity);
  const q = (url.searchParams.get("q") || "").slice(0, 120);
  const ranked = rankCatalog(built.rows, q);
  log.debug("models.catalog", { q, total: built.rows.length, shown: Math.min(ranked.length, PAGE) });
  return jsonResponse({
    ...envelope(allowance, enabled.length),
    models: ranked.slice(0, PAGE),
    total: built.rows.length,
    providers: built.providers,
    query: q,
    note: built.note,
    // Snapshots go stale on purpose (src/user-models.js header); this is where
    // the UI learns which enabled models the live catalog now prices
    // differently, so it can offer a re-enable instead of quietly diverging.
    refresh: hfRefreshNotes(enabled, await hfRouterModels(env, log)),
  });
}

/**
 * POST /api/models/verify — { id, checks?: string[], reset?: boolean }
 *
 * Runs the checks server-side and records the results. This is the "evaluation
 * path in the pipeline" made concrete: the same provider dispatch a real turn
 * uses, the same stream consumer, the same JSON call — so what is measured is
 * what the pipeline would actually get, not a parallel implementation of it.
 *
 * Bounded by construction: checks run sequentially, each with its own timeout,
 * and a request naming no `checks` runs the whole applicable set for that one
 * model. It is billed like any other model call.
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleModelVerify(request, env, log, identity) {
  const anon = needsAccount(identity);
  if (anon) return anon;
  const { body, response } = await readJsonBody(request);
  if (response) return response;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return jsonResponse({ error: "id is required." }, 400);

  const [config, built] = await Promise.all([getConfig(env), buildCatalog(env, log, accountModels(identity))]);
  const allowance = modelAllowance(config);
  applyAllowance(built.rows, allowance);
  const entry = built.rows.find((r) => r.id === id);
  if (!entry) return jsonResponse({ error: "That model is not in the catalog right now." }, 404);
  // Verification RUNS the model, so it needs a model that can actually be run.
  // A discovered model has not been enabled and has no route — the honest
  // answer is "enable it first", not a confusing provider error.
  if (!entry.usable) {
    return jsonResponse(
      { error: "Enable this model before verifying it — the checks run real requests against it." },
      409,
    );
  }
  if (body.reset === true) await clearChecks(env, identity, id);

  const only = Array.isArray(body.checks)
    ? body.checks.filter((/** @type {any} */ c) => typeof c === "string")
    : undefined;
  const started = Date.now();
  const results = await runChecks(env, id, entry, { only, log });
  await recordChecks(env, identity, id, results);
  log.info("models.verified", {
    user_id: identity.id,
    model: id,
    ran: results.length,
    passed: results.filter((r) => r.pass).length,
    ms: Date.now() - started,
  });

  // Re-read so the response carries the row exactly as the sidebar will render
  // it, checklist included, rather than making the client re-derive it.
  const after = await buildCatalog(env, log, accountModels(identity));
  applyAllowance(after.rows, allowance);
  return jsonResponse({
    ...envelope(allowance, enabledModels(identity).length),
    model: after.rows.find((r) => r.id === id) || null,
    results,
  });
}

/**
 * POST /api/models/enable — { id }
 *
 * The promotion. Re-validated against the LIVE catalog rather than against the
 * client's numbers: the row the UI showed is a rendering of this same data, and
 * re-deriving it here is what stops a hand-rolled request from enabling an
 * unpriced (→ unbilled) model or one outside the allowance.
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleModelEnable(request, env, log, identity) {
  const anon = needsAccount(identity);
  if (anon) return anon;
  const { body, response } = await readJsonBody(request);
  if (response) return response;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return jsonResponse({ error: "id is required." }, 400);

  const [config, built] = await Promise.all([getConfig(env), buildCatalog(env, log, accountModels(identity))]);
  const allowance = modelAllowance(config);
  applyAllowance(built.rows, allowance);
  const rowNow = built.rows.find((r) => r.id === id);
  if (!rowNow) return jsonResponse({ error: "That model is not in the catalog right now." }, 404);
  if (rowNow.state === "enabled") {
    return jsonResponse({ ...envelope(allowance, enabledModels(identity).length), model: rowNow });
  }
  if (rowNow.state === "available") {
    // Nothing to do, and saying so is better than pretending: a curated
    // provider's model is already selectable everywhere.
    return jsonResponse(
      { error: `${rowNow.providerLabel} models are available to every mode already — there is nothing to enable.` },
      409,
    );
  }
  if (!rowNow.enableable) {
    return jsonResponse({ error: rowNow.reason || "Outside your model allowance." }, 403);
  }

  const entry = acceptedFromBrowseItem(
    {
      hfId: id.replace(/^hf:/, "").split("@")[0],
      provider: rowNow.servedBy,
      name: rowNow.name,
      price_in: rowNow.price_in,
      price_out: rowNow.price_out,
      usd_in: rowNow.usd_in,
      usd_out: rowNow.usd_out,
      context: rowNow.context,
      vision: rowNow.vision,
    },
    Date.now(),
  );
  if (!entry) {
    return jsonResponse({ error: "That model publishes no usable price, so it can't be enabled." }, 400);
  }
  const list = await acceptModel(env, identity, entry);
  log.info("models.enabled", { user_id: identity.id, model: entry.id, usd_out: entry.usd_out, total: list.length });
  const after = await buildCatalog(env, log, accountModels(identity));
  applyAllowance(after.rows, allowance);
  return jsonResponse({
    ...envelope(allowance, list.length),
    model: after.rows.find((r) => r.id === entry.id) || null,
  });
}

/**
 * POST /api/models/disable — { id }
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleModelDisable(request, env, log, identity) {
  const anon = needsAccount(identity);
  if (anon) return anon;
  const { body, response } = await readJsonBody(request);
  if (response) return response;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return jsonResponse({ error: "id is required." }, 400);
  const list = await removeAcceptedModel(env, identity, id);
  const allowance = modelAllowance(await getConfig(env));
  log.info("models.disabled", { user_id: identity.id, model: id, total: list.length });
  const after = await buildCatalog(env, log, accountModels(identity));
  applyAllowance(after.rows, allowance);
  return jsonResponse({
    ...envelope(allowance, list.length),
    model: after.rows.find((r) => r.id === id) || null,
  });
}
