// @ts-check
// Shared `env`, `Logger` and `Identity` factories for the unit suite.
//
// Every request handler in `src/` takes `(request, env, log, identity)`. Those
// four arguments are the only thing standing between the suite and the ~2 500
// lines of request-layer code no test loads today: none of it needs a DOM, a
// browser, a network, or a credential — only a plausible `env`.
//
// The factories below default to the "signed-in user on a fully configured
// deployment" case, because that is the path most handlers are written for,
// and take overrides for the rest. Bindings a handler does not touch are
// simply absent, which is faithful: invariant 2's fail-soft contract is
// largely about optional bindings being missing.

import { fakeD1 } from "./d1.js";

/**
 * A logger that records instead of printing, so a test can assert on what was
 * logged — including the negative that invariant 4 cares about ("secrets never
 * appear in any log").
 *
 * @returns {any} a Logger with `.lines` and helpers attached
 */
export function fakeLog() {
  /** @type {Array<{level: string, args: unknown[]}>} */
  const lines = [];
  /** @param {string} level */
  const at =
    (level) =>
    (/** @type {unknown[]} */ ...args) => {
      lines.push({ level, args });
    };
  const log = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  const flatten = () =>
    lines.map((l) => l.args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")).join("\n");
  return Object.assign(log, {
    lines,
    /** Everything logged, flattened to one searchable string. */
    text: flatten,
    /** @param {string} level */
    at: (level) => lines.filter((l) => l.level === level),
    /**
     * Assert none of these strings was ever logged.
     * @param {string[]} forbidden
     * @param {(msg: string) => never | void} [fail]
     */
    assertNoneLogged(forbidden, fail) {
      const all = flatten();
      for (const needle of forbidden) {
        if (!needle) continue;
        if (all.includes(needle)) {
          const msg = `log line carried forbidden value ${JSON.stringify(needle)}`;
          if (fail) return fail(msg);
          throw new Error(msg);
        }
      }
      return true;
    },
    reset() {
      lines.length = 0;
    },
  });
}

/** @param {unknown} v */
function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * A static-assets binding backed by an in-memory path→body map. Handlers that
 * read shipped artifacts (introspection snapshots, the docs corpus) go through
 * `env.ASSETS.fetch`.
 *
 * @param {Record<string,string>} [files] path (with leading slash) → body
 * @returns {any}
 */
export function fakeAssets(files = {}) {
  return {
    /** @param {any} input */
    async fetch(input) {
      const url = new URL(typeof input === "string" ? input : input.url, "https://example.test");
      const body = files[url.pathname];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200 });
    },
  };
}

/**
 * An R2-shaped bucket backed by a Map.
 * @returns {any}
 */
export function fakeR2() {
  /** @type {Map<string, {body: string, meta: any}>} */
  const objects = new Map();
  return {
    objects,
    /** @param {string} key */
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        key,
        customMetadata: o.meta,
        text: async () => o.body,
        json: async () => JSON.parse(o.body),
        arrayBuffer: async () => new TextEncoder().encode(o.body).buffer,
      };
    },
    /**
     * @param {string} key
     * @param {any} value
     * @param {any} [opts]
     */
    async put(key, value, opts) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, meta: opts?.customMetadata });
      return { key };
    },
    /** @param {string} key */
    async delete(key) {
      objects.delete(key);
    },
    /** @param {any} [opts] */
    async list(opts) {
      const prefix = opts?.prefix || "";
      return {
        objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

/**
 * Build an `Env` for a handler under test.
 *
 * Defaults give a configured deployment: a D1 fake, a static-assets stub, and
 * the secrets whose ABSENCE would short-circuit most handlers with a 500
 * before reaching the logic under test. Pass `{ DB: null }` (or any binding as
 * `null`) to delete it and exercise the degraded path.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {any} an Env-shaped object; `.DB` is a `fakeD1` unless overridden
 */
export function fakeEnv(overrides = {}) {
  const env = {
    ASSETS: fakeAssets(),
    DB: fakeD1(),
    BERGET_API_TOKEN: "test-berget-token",
    BERGET_URL: "https://berget.test/v1",
    SESSION_SECRET: "test-session-secret",
    HISTORY_KEY_SECRET: "test-history-key-secret",
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) if (v === null) delete (/** @type {any} */ (env))[k];
  return env;
}

/**
 * Build an `Identity`. Defaults to an approved non-admin user, which is the
 * case most handlers branch on.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {any}
 */
export function fakeIdentity(overrides = {}) {
  const id = overrides.id || "user-1";
  return {
    id,
    role: "user",
    email: `${id}@example.test`,
    name: "Test User",
    user: { id, email: `${id}@example.test`, approved: 1, role: "user" },
    ...overrides,
  };
}

/**
 * An admin identity — the branch that bypasses quota blocks.
 * @param {Record<string, any>} [overrides]
 */
export function fakeAdmin(overrides = {}) {
  return fakeIdentity({ id: "admin-1", role: "admin", name: "Admin", ...overrides });
}

/**
 * A minimal `ExecutionContext`, recording what was handed to `waitUntil` so a
 * test can await the background work a handler defers.
 * @returns {any}
 */
export function fakeCtx() {
  /** @type {Promise<unknown>[]} */
  const deferred = [];
  return {
    deferred,
    /** @param {Promise<unknown>} p */
    waitUntil(p) {
      deferred.push(Promise.resolve(p).catch(() => {}));
    },
    passThroughOnException() {},
    /** Await every deferred task — background writes land before assertions. */
    settle: () => Promise.all(deferred),
  };
}

/**
 * Build a JSON `Request` for a handler under test.
 *
 * @param {string} url
 * @param {unknown} [body] omit for GET
 * @param {RequestInit} [init]
 * @returns {Request}
 */
export function jsonRequest(url, body, init = {}) {
  const method = init.method || (body === undefined ? "GET" : "POST");
  return new Request(url, {
    ...init,
    method,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
