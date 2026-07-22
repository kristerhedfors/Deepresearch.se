// @ts-check
// Structured JSON logger — one object per line (baseplate-worker step 4).
//
// PRIVACY RULES (enforced by convention at every call site, so they live here
// where the call sites are written):
//   - NEVER log conversation content, user messages, attachment names, or the
//     resolved answer text. Log shapes and counts (message count, char totals,
//     model id, phase, duration), never payloads.
//   - NEVER log secrets: API tokens, the session cookie, the SESSION_SECRET.
//   - Outbound-to-third-party log lines carry the minimum (a query length, a
//     host, a status) — never who asked or what the conversation was about.
// These mirror PA-4 (the privacy split) from the DistillSDK constitution.

const LEVELS = /** @type {const} */ ({ debug: 10, info: 20, warn: 30, error: 40 });

/**
 * @param {{ LOG_LEVEL?: string }} env
 * @param {Record<string, unknown>} [base] fields stamped on every line
 */
export function createLogger(env, base = {}) {
  const threshold = LEVELS[/** @type {keyof typeof LEVELS} */ (env.LOG_LEVEL)] || LEVELS.info;
  /**
   * @param {keyof typeof LEVELS} level
   * @param {string} event
   * @param {Record<string, unknown>} [fields]
   */
  function emit(level, event, fields = {}) {
    if (LEVELS[level] < threshold) return;
    const line = { time: new Date().toISOString(), level, event, ...base, ...fields };
    // console.log is the Workers structured-log sink.
    console.log(JSON.stringify(line));
  }
  return {
    /** @param {string} e @param {Record<string,unknown>} [f] */ debug: (e, f) => emit("debug", e, f),
    /** @param {string} e @param {Record<string,unknown>} [f] */ info: (e, f) => emit("info", e, f),
    /** @param {string} e @param {Record<string,unknown>} [f] */ warn: (e, f) => emit("warn", e, f),
    /** @param {string} e @param {Record<string,unknown>} [f] */ error: (e, f) => emit("error", e, f),
  };
}

/** @typedef {ReturnType<typeof createLogger>} Logger */
