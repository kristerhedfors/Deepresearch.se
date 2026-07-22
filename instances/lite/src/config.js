// @ts-check
// Instance configuration. Values come from env vars (wrangler [vars]) with
// built-in defaults, so the instance runs with only its secrets set.

// Split model routing (PA-3): the JSON planning phase (triage) always runs on a
// fixed, reliable JSON-mode model; only synthesis runs on the user's chosen
// model. Both here default to Berget's Mistral Small — the parent's DEFAULT_MODEL.
export const DEFAULT_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506";
export const JSON_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506";

/** @param {any} env @returns {string} the synthesis model for this deploy */
export function answerModel(env) {
  return env.BERGET_MODEL || DEFAULT_MODEL;
}

/** @param {any} env @returns {boolean} */
export function searchEnabled(env) {
  return String(env.SEARCH_ENABLED ?? "true") !== "false" && !!env.EXA_API_KEY;
}
