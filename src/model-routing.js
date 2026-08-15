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

/** How many describe-helper candidates to carry. The describe FAILS OVER down
 * this list (a production trace showed one loaded vision model missing its
 * connect timeout while others answered instantly), and three attempts is the
 * point where a further one costs more latency than it buys reliability. */
export const MAX_VISION_CANDIDATES = 3;

/**
 * The ranked describe-helper models: every vision model the catalog reports as
 * up, with the ANSWER model first when it is itself a vision model — asking the
 * model that will use the description to produce it keeps one voice, and saves a
 * second provider when it can.
 *
 * A leaf decision like resolveJsonModel, and shared for the same reason: it is
 * now made on two channels (a chat turn resolves it per request, and the MCP
 * street-imagery tool resolves it with no answer model at all, passing ""), and
 * a second copy would drift on exactly the details that are load-bearing — the
 * answer-model-first ordering and the cap.
 *
 * @param {import('./types.js').ModelCatalog | null | undefined} catalog
 * @param {string} answerModel the resolved answer model, or "" when there is none
 * @returns {string[]} ranked candidate ids — empty when nothing can describe
 */
export function resolveVisionModels(catalog, answerModel) {
  const candidates = Array.isArray(catalog) ? catalog.filter((m) => m.vision && m.up).map((m) => m.id) : [];
  const answerIsVision = !!(answerModel && catalog?.find((m) => m.id === answerModel)?.vision);
  const ranked = answerIsVision ? [answerModel, ...candidates.filter((id) => id !== answerModel)] : candidates;
  return ranked.slice(0, MAX_VISION_CANDIDATES);
}
