// @ts-check
// Minimal structured logger for Cloudflare Workers.
//
// Emits one JSON object per line, which Workers Logs and `npx wrangler tail`
// index and filter natively. Levels: debug < info < warn < error; the
// threshold comes from the LOG_LEVEL var in wrangler.toml (default "info").
//
// Privacy rules (enforced by convention at every call site):
// - Never log secrets or Authorization headers.
// - Never log chat message content. User-provided text (e.g. search queries)
//   may be logged at debug level only; info-and-above logs carry counts,
//   durations, and statuses instead.

/** @type {Record<string, number>} */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Builds a structured logger bound to a request/environment.
 * @param {import('./types.js').Env} env
 * @param {Record<string, unknown>} [base] fields merged into every entry
 * @returns {import('./types.js').Logger}
 */
export function createLogger(env, base = {}) {
  const name = String(env.LOG_LEVEL || "info").toLowerCase();
  const threshold = LEVELS[name] ?? LEVELS.info;

  /**
   * @param {"debug"|"info"|"warn"|"error"} level
   * @param {string} event
   * @param {Record<string, unknown>} [fields]
   */
  const emit = (level, event, fields) => {
    if (LEVELS[level] < threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...base,
      ...fields,
    };
    (level === "error" ? console.error : console.log)(JSON.stringify(entry));
  };

  return {
    debug: (event, fields = {}) => emit("debug", event, fields),
    info: (event, fields = {}) => emit("info", event, fields),
    warn: (event, fields = {}) => emit("warn", event, fields),
    error: (event, fields = {}) => emit("error", event, fields),
  };
}
