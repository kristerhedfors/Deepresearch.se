// @ts-check
// A shared D1 fake for the unit suite.
//
// Before this module the repo carried fifteen hand-rolled `fakeDb` /
// `stubDb` / `mockD1` implementations (~750 lines) of fifteen different
// fidelities: only `quota.test.js` modelled `batch()`, none modelled
// `exec()`, and none could make a query fail. Tests were therefore asserting
// against fifteen different approximations of one binding.
//
// The design deliberately is NOT a SQL engine. Writing one would be a large,
// permanently half-correct dependency, and the hand-rolled fakes show what
// suites actually need:
//
//   1. canned rows back from a query — matched on the SQL, not parsed from it
//   2. a record of every statement that ran, with its bindings
//   3. the ability to make a statement fail
//
// (2) is the capability none of the hand-rolled fakes had, and it is the one
// that lets a test assert a NEGATIVE — that some statement never ran. That is
// exactly the shape of the incognito promise in invariant 4 ("the chat_logs
// row is suppressed"), which had no test precisely because no fake could
// express it.
//
// Matching is by RegExp (or a predicate) against the SQL text, in the order
// handlers were registered, first match wins. Unmatched statements are not an
// error — they record and return empty, so a test only describes the queries
// it cares about.

/**
 * @typedef {object} D1Call
 * @property {string} sql the statement text, whitespace-normalized
 * @property {string} raw the statement text as passed to prepare()
 * @property {unknown[]} bindings the values passed to .bind()
 * @property {"run"|"first"|"all"|"raw"|"none"} method how it was executed
 */

/**
 * @typedef {RegExp | ((sql: string) => boolean)} SqlMatcher
 */

/**
 * @typedef {object} D1Handler
 * @property {SqlMatcher} match
 * @property {unknown} result rows (array), a single row (object), or a
 *   function of the bindings returning either
 */

const norm = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim();

/**
 * @param {SqlMatcher} matcher
 * @param {string} sql
 * @returns {boolean}
 */
function matches(matcher, sql) {
  return typeof matcher === "function" ? matcher(sql) : matcher.test(sql);
}

/**
 * Build a D1Database-shaped fake.
 *
 * @param {object} [options]
 * @param {Array<[SqlMatcher, unknown]>} [options.rows] `[matcher, result]`
 *   pairs. `result` may be an array of rows, a single row object, or a
 *   function `(bindings) => rows`. First matching pair wins.
 * @returns {any} a D1Database-shaped object with `.calls` and assertion
 *   helpers attached. Typed `any` because it is a partial stand-in for the
 *   real binding — callers pass it into `env.DB` positions.
 */
export function fakeD1(options = {}) {
  /** @type {D1Handler[]} */
  const handlers = (options.rows || []).map(([match, result]) => ({ match, result }));
  /** @type {Array<{match: SqlMatcher, error: Error}>} */
  const failures = [];
  /** @type {D1Call[]} */
  const calls = [];

  /**
   * @param {string} sql
   * @param {unknown[]} bindings
   */
  function resolve(sql, bindings) {
    for (const f of failures) if (matches(f.match, sql)) throw f.error;
    for (const h of handlers) {
      if (!matches(h.match, sql)) continue;
      const r = typeof h.result === "function" ? h.result(bindings) : h.result;
      return Array.isArray(r) ? r : r == null ? [] : [r];
    }
    return [];
  }

  /**
   * @param {string} raw
   * @returns {any}
   */
  function prepare(raw) {
    return bound(raw, []);
  }

  /**
   * One prepared statement with its bindings. `bind()` returns a NEW statement
   * rather than mutating this one, which is what the real binding does — and it
   * is load-bearing for the batch-a-rebound-statement pattern (quota.js's
   * recordModelUsage prepares once and binds per row). A mutating fake records
   * N copies of the LAST row's bindings, so a test asserting per-row
   * attribution passes or fails for the wrong reason.
   * @param {string} raw
   * @param {unknown[]} bindings
   * @returns {any}
   */
  function bound(raw, bindings) {
    const sql = norm(raw);
    /** @param {D1Call["method"]} method */
    const record = (method) => {
      const call = { sql, raw, bindings: bindings.slice(), method };
      calls.push(call);
      return call;
    };
    const stmt = {
      /** @param {...unknown} values */
      bind(...values) {
        return bound(raw, values);
      },
      async run() {
        record("run");
        const rows = resolve(sql, bindings);
        return { success: true, results: rows, meta: { changes: rows.length, last_row_id: 0, rows_written: rows.length } };
      },
      /** @param {string} [column] */
      async first(column) {
        record("first");
        const row = resolve(sql, bindings)[0];
        if (row === undefined) return null;
        if (column !== undefined) return /** @type {any} */ (row)?.[column] ?? null;
        return row;
      },
      async all() {
        record("all");
        const rows = resolve(sql, bindings);
        return { success: true, results: rows, meta: { changes: 0, rows_read: rows.length } };
      },
      async raw() {
        record("raw");
        return resolve(sql, bindings).map((r) => Object.values(/** @type {any} */ (r)));
      },
    };
    return stmt;
  }

  const db = {
    prepare,
    /** @param {any[]} statements */
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    /** @param {string} sql */
    async exec(sql) {
      const count = sql.split(";").filter((s) => s.trim()).length;
      calls.push({ sql: norm(sql), raw: sql, bindings: [], method: "none" });
      return { count, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession: () => db,

    // ---- inspection surface (not part of D1) --------------------------------

    /** Every statement that ran, in order. */
    calls,
    /** Normalized SQL text of every statement that ran, in order. */
    statements: () => calls.map((c) => c.sql),
    /**
     * Did any statement matching `matcher` run?
     * @param {SqlMatcher} matcher
     */
    ran: (matcher) => calls.some((c) => matches(matcher, c.sql)),
    /**
     * Every call whose SQL matches — for asserting on bindings.
     * @param {SqlMatcher} matcher
     * @returns {D1Call[]}
     */
    callsMatching: (matcher) => calls.filter((c) => matches(matcher, c.sql)),
    /**
     * Make every statement matching `matcher` throw — the failure mode no
     * hand-rolled fake modelled, and the one invariant 2 (fail soft) is about.
     * @param {SqlMatcher} matcher
     * @param {Error|string} [error]
     */
    failOn(matcher, error = "D1_ERROR: fake failure") {
      failures.push({ match: matcher, error: typeof error === "string" ? new Error(error) : error });
      return db;
    },
    /** Register another `[matcher, result]` row rule after construction. */
    /**
     * @param {SqlMatcher} matcher
     * @param {unknown} result
     */
    onQuery(matcher, result) {
      handlers.push({ match: matcher, result });
      return db;
    },
    /** Forget every recorded call (keeps handlers and failures). */
    reset() {
      calls.length = 0;
      return db;
    },
  };
  return db;
}
