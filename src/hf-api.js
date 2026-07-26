// @ts-check
// The Hugging Face MODEL SURFACE — browse the open router catalog with prices,
// and accept a model into this account's own menu.
//
// Three endpoints, all signed-in, all under /api/hf:
//
//   GET    /api/hf/models?q=…   browse: ranked catalog rows, each carrying its
//                               cost in USD and EUR, an illustrative per-turn
//                               estimate, and whether the account's allowance
//                               covers it — the "cost info before starting the
//                               model" the agent shows you.
//   POST   /api/hf/models       accept: { hfId, provider? } → snapshot its
//                               price and put it in the account's menu, which
//                               is what makes it selectable in EVERY agent mode
//                               (src/user-models.js, src/providers.js).
//   DELETE /api/hf/models?id=…  un-accept.
//
// Privacy (invariant 4): the browse query is matched LOCALLY against a catalog
// this Worker already fetched — no search term is forwarded to Hugging Face,
// and the only thing that ever crosses to router.huggingface.co from here is
// the unauthenticated catalog GET. The account's accepted list rests in its own
// D1 row and is never sent anywhere.
//
// Fail-soft (invariant 2): an unreachable router yields an empty catalog and a
// spelled-out `note`, not a 502 — a user with models already accepted keeps
// using them.

import { getConfig } from "./config.js";
import { jsonResponse } from "./http.js";
import {
  hfAllowance,
  hfBrowseItem,
  hfInferenceConfigured,
  hfRankModels,
  hfRouterModels,
  TYPICAL_TURN,
} from "./hf-inference.js";
import {
  acceptedFromBrowseItem,
  acceptedModels,
  acceptModel,
  hfRefreshNotes,
  removeAcceptedModel,
} from "./user-models.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

/** How many rows one browse returns. The picker is a scroll list, not a
 * catalog dump — a query that matches everything is a query worth refining. */
const PAGE = 40;

/** @param {Env} env */
function notConfigured(env) {
  return hfInferenceConfigured(env)
    ? null
    : jsonResponse(
      {
        error:
          "Hugging Face inference is not configured on this server (HUGGINGFACE_API_TOKEN missing).",
      },
      503,
    );
}

/** @param {Identity} identity */
function needsAccount(identity) {
  return identity?.user
    ? null
    : jsonResponse({ error: "Enabling models needs a signed-in account (not break-glass)." }, 403);
}

/**
 * The shared body of every response here: the account's accepted models, its
 * allowance, and how the illustrative per-turn estimate was computed. The
 * client renders all three, so shipping them on every response means the picker
 * never has to hold stale allowance state.
 * @param {import('./user-models.js').AcceptedModel[] } accepted
 * @param {import('./hf-inference.js').HfAllowance} allowance
 */
function envelope(accepted, allowance) {
  return {
    accepted,
    allowance: {
      max_output_usd: allowance.maxOutputUsd,
      max_accepted: allowance.maxAccepted,
      used: accepted.length,
    },
    turn: TYPICAL_TURN,
  };
}

// GET /api/hf/models?q=…
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleHfModelsList(env, log, identity, url) {
  const unavailable = notConfigured(env);
  if (unavailable) return unavailable;
  const [config, catalog] = await Promise.all([getConfig(env), hfRouterModels(env, log)]);
  const allowance = hfAllowance(config);
  const accepted = acceptedModels(identity);
  const acceptedIds = new Set(accepted.map((m) => m.hfId));
  const q = (url.searchParams.get("q") || "").slice(0, 120);
  const ranked = hfRankModels(catalog, q).slice(0, PAGE);
  const models = ranked.map((m) =>
    hfBrowseItem(m, { allowance, acceptedIds, acceptedCount: accepted.length }));
  log.debug("hf.browse", { q, total: catalog.length, shown: models.length });
  return jsonResponse({
    ...envelope(accepted, allowance),
    models,
    total: catalog.length,
    query: q,
    // Snapshots go stale on purpose (src/user-models.js header); this is where
    // the UI learns which accepted models the live catalog now prices
    // differently, so it can offer a re-accept instead of quietly diverging.
    refresh: hfRefreshNotes(accepted, catalog),
    note: catalog.length
      ? null
      : "The Hugging Face router catalog is unreachable right now. Models you already enabled still work.",
  });
}

// POST /api/hf/models — accept { hfId, provider? }
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleHfModelAccept(request, env, log, identity) {
  const unavailable = notConfigured(env);
  if (unavailable) return unavailable;
  const anon = needsAccount(identity);
  if (anon) return anon;
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const hfId = typeof body?.hfId === "string" ? body.hfId : "";
  if (!hfId) return jsonResponse({ error: "hfId is required." }, 400);

  const [config, catalog] = await Promise.all([getConfig(env), hfRouterModels(env, log)]);
  const allowance = hfAllowance(config);
  const accepted = acceptedModels(identity);
  // Acceptance is validated against the LIVE catalog, never against the
  // client's numbers: the browse row the UI showed is a rendering of this same
  // data, and re-deriving it here is what stops a hand-rolled request from
  // enabling an unpriced (→ unbilled) model or one outside the allowance.
  const model = catalog.find((m) => m.hfId === hfId);
  if (!model) {
    return jsonResponse(
      { error: "That model is not in the Hugging Face router catalog right now." },
      404,
    );
  }
  // A user may pin one of the model's live serving providers; anything else
  // prices against the cheapest live one. Either way the ROW is what the
  // allowance is checked against, so pinning an expensive provider on a cheap
  // model is caught here rather than at billing time.
  const wanted = typeof body.provider === "string" ? body.provider : null;
  const serving = wanted ? model.servings.find((s) => s.live && s.provider === wanted) : null;
  if (wanted && !serving) {
    return jsonResponse({ error: `No live "${wanted}" provider for that model.` }, 400);
  }
  const item = hfBrowseItem(model, {
    allowance,
    acceptedIds: new Set(accepted.map((m) => m.hfId)),
    acceptedCount: accepted.length,
    serving,
  });
  if (!item.allowed) {
    return jsonResponse({ error: item.reason || "Outside your model allowance." }, 403);
  }
  const entry = acceptedFromBrowseItem(item, Date.now());
  if (!entry) {
    return jsonResponse({ error: "That model publishes no usable price, so it can't be enabled." }, 400);
  }
  const list = await acceptModel(env, identity, entry);
  log.info("hf.model_accepted", {
    user_id: identity.id,
    model: entry.id,
    usd_out: entry.usd_out,
    total: list.length,
  });
  return jsonResponse({ ...envelope(list, allowance), model: entry });
}

// DELETE /api/hf/models?id=…
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleHfModelRemove(env, log, identity, url) {
  const anon = needsAccount(identity);
  if (anon) return anon;
  const id = url.searchParams.get("id") || "";
  if (!id) return jsonResponse({ error: "id is required." }, 400);
  const list = await removeAcceptedModel(env, identity, id);
  const allowance = hfAllowance(await getConfig(env));
  log.info("hf.model_removed", { user_id: identity.id, model: id, total: list.length });
  return jsonResponse(envelope(list, allowance));
}
