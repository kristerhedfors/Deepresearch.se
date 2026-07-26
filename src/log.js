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
 *
 * The returned logger also EXPOSES its base fields as `log.fields` (frozen).
 * index.js binds `request_id`, `method` and `path` there, and the logger is
 * the one request-scoped object every deep helper already receives — so a
 * subsystem that needs the request id for a durable record (src/
 * server-errors.js `recordSubsystemFailure`, called from the Orchestrator's
 * fail-soft node guard) can read it without threading a new field through
 * PipelineCtx and every phase in between. Read-only by construction: mutating
 * a logger's identity from a helper would corrupt every later line.
 * @param {import('./types.js').Env} env
 * @param {Record<string, unknown>} [base] fields merged into every entry
 * @returns {import('./types.js').Logger & { fields: Readonly<Record<string, unknown>> }}
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
    fields: Object.freeze({ ...base }),
    debug: (event, fields = {}) => emit("debug", event, fields),
    info: (event, fields = {}) => emit("info", event, fields),
    warn: (event, fields = {}) => emit("warn", event, fields),
    error: (event, fields = {}) => emit("error", event, fields),
  };
}

/**
 * The request id a logger was bound to, or "" when it wasn't (a bare test
 * logger, a background job). Total — never throws on a hand-rolled stub.
 * @param {unknown} log
 * @returns {string}
 */
export function loggerRequestId(log) {
  const v = /** @type {any} */ (log)?.fields?.request_id;
  return typeof v === "string" ? v : "";
}
