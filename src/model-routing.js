// @ts-check
// Split-model routing — the one shared decision behind the "JSON planning
// phases always run on the fixed reliable model" invariant. A leaf module so
// both request handlers (src/chat.js and src/mcp.js) share ONE implementation
// instead of the verbatim copy they used to each carry; it imports nothing, so
// neither handler graph is pulled into the other.

/**
 * Which model runs the JSON planning phases (triage / gap check / validation).
 * The reliable DEFAULT_MODEL, unless the answer model already IS it, or the
 * catalog explicitly reports it down (fall back to the user's model), or the
 * catalog is unreachable / this deployment doesn't offer it (stay optimistic).
 * @param {import('./types.js').ModelCatalog | null | undefined} catalog
 * @param {string} userModel the resolved answer model
 * @param {string} defaultModel the fixed reliable JSON-phase model
 * @returns {string}
 */
export function resolveJsonModel(catalog, userModel, defaultModel) {
  if (userModel === defaultModel) return defaultModel; // already the reliable JSON model
  if (!Array.isArray(catalog)) return defaultModel; // unreachable → optimistic (fail-soft)
  const entry = catalog.find((m) => m.id === defaultModel);
  if (!entry) return userModel; // this deployment doesn't offer it — don't route to a missing model
  return entry.up === false ? userModel : defaultModel;
}
