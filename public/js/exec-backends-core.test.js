// Unit tests for the SHARED execution-environment core (exec-backends-core.js)
// — the seam that lets a DREE/1 runner on the user's own machine stand in for
// the in-browser CheerpX VM. Both tiers import this module directly, so what is
// pinned here is the whole contract: normalization, the fail-soft parsers, the
// probe's error wording, and — above all — that selectRunner returns the
// browser bridge UNCHANGED unless a local runner is fully configured (the
// property that keeps this feature from being able to regress the sandbox).
//
// fetch is injected everywhere, so it runs in `node --test` with no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RUNNER_URL,
  DREE_PROTOCOL,
  EXEC_BACKENDS,
  MIN_REMOTE_EXEC_TIMEOUT_MS,
  REMOTE_EXEC_TIMEOUT_MS,
  execBackend,
  makeLocalRunner,
  newExecSession,
  normalizeExecBackend,
  parseExecResponse,
  parseHealth,
  probeRunner,
  remoteExecTimeout,
  runnerStatusLine,
  selectRunner,
  usesLocalRunner,
} from "./exec-backends-core.js";

/** A fetch stub: hands back a canned response and records the call. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// ---- the registry -----------------------------------------------------------

test("EXEC_BACKENDS lists browser first and marks which need a URL", () => {
  assert.equal(EXEC_BACKENDS[0].id, "browser");
  assert.equal(EXEC_BACKENDS[0].needsUrl, false);
  assert.equal(execBackend("local").needsUrl, true);
  assert.equal(execBackend("nope"), null);
  // Every entry carries the one-line explanation both settings UIs render.
  for (const b of EXEC_BACKENDS) assert.ok(b.label && b.short && b.note);
});

test("the default runner URL is the reference runner's localhost port", () => {
  assert.equal(DEFAULT_RUNNER_URL, "http://localhost:8100");
});

// ---- normalization ----------------------------------------------------------

test("normalizeExecBackend falls back to the browser VM for anything unknown", () => {
  assert.deepEqual(normalizeExecBackend(null), { backend: "browser", baseUrl: "", key: "" });
  assert.equal(normalizeExecBackend({ backend: "wat" }).backend, "browser");
  assert.equal(normalizeExecBackend({ backend: "local" }).backend, "local");
});

test("normalizeExecBackend trims trailing slashes and whitespace", () => {
  const c = normalizeExecBackend({ backend: "local", baseUrl: "  http://localhost:8100//  ", key: " k " });
  assert.equal(c.baseUrl, "http://localhost:8100");
  assert.equal(c.key, "k");
});

test("usesLocalRunner needs BOTH the pick and an address", () => {
  assert.equal(usesLocalRunner(normalizeExecBackend({ backend: "local", baseUrl: "http://x" })), true);
  assert.equal(usesLocalRunner(normalizeExecBackend({ backend: "local" })), false); // half-filled form
  assert.equal(usesLocalRunner(normalizeExecBackend({ backend: "browser", baseUrl: "http://x" })), false);
});

// ---- timeouts ---------------------------------------------------------------

test("remoteExecTimeout clamps into the native range, default when absent", () => {
  assert.equal(remoteExecTimeout(undefined), REMOTE_EXEC_TIMEOUT_MS);
  assert.equal(remoteExecTimeout(0), REMOTE_EXEC_TIMEOUT_MS);
  assert.equal(remoteExecTimeout(-5), REMOTE_EXEC_TIMEOUT_MS);
  assert.equal(remoteExecTimeout(1_000), MIN_REMOTE_EXEC_TIMEOUT_MS); // budget-scoped floor
  assert.equal(remoteExecTimeout(999_999), REMOTE_EXEC_TIMEOUT_MS);
  assert.equal(remoteExecTimeout(20_000), 20_000);
});

// ---- parsers ----------------------------------------------------------------

test("parseHealth reads a conforming body and defaults ephemeral to true", () => {
  const h = parseHealth({ ok: true, protocol: DREE_PROTOCOL, backend: "docker", image: "debian:stable-slim" });
  assert.deepEqual(h, {
    ok: true,
    protocol: "dree/1",
    backend: "docker",
    image: "debian:stable-slim",
    ephemeral: true,
    network: "",
    version: "",
  });
  assert.equal(parseHealth({ ok: true, ephemeral: false }).ephemeral, false);
  assert.equal(parseHealth({ ok: true, network: "none" }).network, "none");
  assert.equal(parseHealth(null).ok, false);
});

test("parseExecResponse mirrors execInSandbox's shape and fails soft", () => {
  assert.deepEqual(parseExecResponse({ exitCode: 0, stdout: "hi", stderr: "" }), {
    exitCode: 0,
    stdout: "hi",
    stderr: "",
  });
  // A malformed body is a FAILED COMMAND, never a throw — the loop keeps going.
  assert.deepEqual(parseExecResponse(null), { exitCode: 1, stdout: "", stderr: "runner returned no result" });
  assert.equal(parseExecResponse({ exitCode: "x" }).exitCode, 1);
  assert.equal(parseExecResponse({ exitCode: 0, truncated: true }).truncated, true);
  assert.equal(parseExecResponse({ exitCode: 0 }).truncated, undefined);
});

test("newExecSession produces distinct ids", () => {
  assert.notEqual(newExecSession(), newExecSession());
});

// ---- the probe --------------------------------------------------------------

test("probeRunner reports a healthy runner", async () => {
  const f = fakeFetch(() => jsonResponse({ ok: true, protocol: DREE_PROTOCOL, backend: "docker", image: "img" }));
  const p = await probeRunner({ baseUrl: "http://localhost:8100", key: "" }, { fetch: f });
  assert.equal(p.reachable, true);
  assert.equal(p.health.backend, "docker");
  assert.match(f.calls[0].url, /\/healthz$/);
});

test("probeRunner sends the key only when there is one", async () => {
  const f = fakeFetch(() => jsonResponse({ ok: true }));
  await probeRunner({ baseUrl: "http://x", key: "secret" }, { fetch: f });
  assert.equal(f.calls[0].init.headers["x-api-key"], "secret");
  const f2 = fakeFetch(() => jsonResponse({ ok: true }));
  await probeRunner({ baseUrl: "http://x", key: "" }, { fetch: f2 });
  assert.equal(f2.calls[0].init.headers["x-api-key"], undefined);
});

test("probeRunner names the three real causes when the fetch throws", async () => {
  const f = fakeFetch(() => {
    throw new Error("Failed to fetch");
  });
  const p = await probeRunner({ baseUrl: "http://localhost:8100", key: "" }, { fetch: f });
  assert.equal(p.reachable, false);
  assert.match(p.error, /running/);
  assert.match(p.error, /CORS/);
  assert.match(p.error, /Safari/);
});

test("probeRunner distinguishes a rejected key from other HTTP errors", async () => {
  const unauth = await probeRunner({ baseUrl: "http://x", key: "" }, { fetch: fakeFetch(() => jsonResponse({}, 401)) });
  assert.match(unauth.error, /rejected the key/);
  const other = await probeRunner({ baseUrl: "http://x", key: "" }, { fetch: fakeFetch(() => jsonResponse({}, 500)) });
  assert.match(other.error, /HTTP 500/);
});

test("probeRunner refuses a body that isn't a DREE health answer", async () => {
  const p = await probeRunner({ baseUrl: "http://x", key: "" }, { fetch: fakeFetch(() => jsonResponse({ hello: 1 })) });
  assert.equal(p.reachable, false);
  assert.match(p.error, /DREE\/1/);
});

test("probeRunner with no URL never touches the network", async () => {
  const f = fakeFetch(() => jsonResponse({ ok: true }));
  const p = await probeRunner({ baseUrl: "", key: "" }, { fetch: f });
  assert.equal(p.reachable, false);
  assert.equal(f.calls.length, 0);
});

test("runnerStatusLine reads the same in both tiers", () => {
  const line = runnerStatusLine({
    reachable: true,
    error: "",
    health: parseHealth({ ok: true, backend: "docker", image: "debian:stable-slim", network: "none" }),
  });
  assert.match(line, /Connected via docker \(debian:stable-slim\)/);
  assert.match(line, /throwaway machine/);
  // The network posture is stated, not left to be assumed — both directions.
  assert.match(line, /no network access/);
  const open = runnerStatusLine({ reachable: true, error: "", health: parseHealth({ ok: true, network: "bridge" }) });
  assert.match(open, /CAN reach the network \(bridge\)/);
  assert.equal(runnerStatusLine({ reachable: false, error: "nope", health: null }), "nope");
});

// ---- the runner -------------------------------------------------------------

test("makeLocalRunner posts a DREE/1 exec and returns the sandbox shape", async () => {
  const f = fakeFetch((url) =>
    url.endsWith("/healthz") ? jsonResponse({ ok: true }) : jsonResponse({ exitCode: 0, stdout: "ok\n", stderr: "" }),
  );
  const r = makeLocalRunner({ backend: "local", baseUrl: "http://localhost:8100", key: "k" }, { fetch: f, session: "s1" });
  assert.equal(await r.boot(), true);
  const res = await r.exec("echo ok", { timeoutMs: 20_000, maxStdoutBytes: 4096 });
  assert.deepEqual(res, { exitCode: 0, stdout: "ok\n", stderr: "" });
  const body = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(body, { command: "echo ok", session: "s1", timeoutMs: 20_000, maxStdoutBytes: 4096 });
  assert.equal(f.calls[1].init.headers["x-api-key"], "k");
});

test("makeLocalRunner boots ONCE — an agent loop pays one probe, not one per command", async () => {
  let health = 0;
  const f = fakeFetch((url) => {
    if (url.endsWith("/healthz")) health++;
    return url.endsWith("/healthz") ? jsonResponse({ ok: true }) : jsonResponse({ exitCode: 0, stdout: "", stderr: "" });
  });
  const r = makeLocalRunner({ backend: "local", baseUrl: "http://x", key: "" }, { fetch: f });
  await r.boot();
  await r.boot();
  await r.boot();
  assert.equal(health, 1);
});

test("makeLocalRunner: an unreachable runner boots false and stops claiming support", async () => {
  const f = fakeFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const r = makeLocalRunner({ backend: "local", baseUrl: "http://x", key: "" }, { fetch: f });
  assert.equal(r.supported(), true); // optimistic before the probe — else we'd never probe
  assert.equal(await r.boot(), false);
  assert.equal(r.supported(), false); // honest after it
});

test("makeLocalRunner: a failed command fails SOFT and does not condemn the runner", async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith("/healthz")) return jsonResponse({ ok: true });
    throw new Error("aborted");
  });
  const r = makeLocalRunner({ backend: "local", baseUrl: "http://x", key: "" }, { fetch: f });
  await r.boot();
  const res = await r.exec("sleep 999");
  assert.equal(res.exitCode, 124);
  assert.match(res.stderr, /unreachable/);
  assert.equal(r.supported(), true); // one bad command ≠ a dead service
});

test("makeLocalRunner surfaces a non-2xx exec as a failed command", async () => {
  const f = fakeFetch((url) => (url.endsWith("/healthz") ? jsonResponse({ ok: true }) : jsonResponse({ e: 1 }, 500)));
  const r = makeLocalRunner({ backend: "local", baseUrl: "http://x", key: "" }, { fetch: f });
  await r.boot();
  const res = await r.exec("ls");
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /HTTP 500/);
});

test("makeLocalRunner keeps one session across commands (state survives the loop)", async () => {
  const f = fakeFetch((url) =>
    url.endsWith("/healthz") ? jsonResponse({ ok: true }) : jsonResponse({ exitCode: 0, stdout: "", stderr: "" }),
  );
  const r = makeLocalRunner({ backend: "local", baseUrl: "http://x", key: "" }, { fetch: f });
  await r.exec("cd /tmp && touch a");
  await r.exec("ls /tmp");
  const [a, b] = f.calls.map((c) => JSON.parse(c.init.body).session);
  assert.equal(a, b);
  assert.ok(a);
});

test("makeLocalRunner omits maxStdoutBytes when the caller doesn't cap", async () => {
  const f = fakeFetch(() => jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));
  const r = makeLocalRunner({ backend: "local", baseUrl: "http://x", key: "" }, { fetch: f });
  await r.exec("cat big");
  assert.equal("maxStdoutBytes" in JSON.parse(f.calls[0].init.body), false);
});

// ---- the decision point -----------------------------------------------------

test("selectRunner returns the browser bridge untouched by default", () => {
  const browser = { supported: () => true, boot: async () => true, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  assert.equal(selectRunner(null, browser), browser);
  assert.equal(selectRunner({ backend: "browser" }, browser), browser);
  // Picked "local" but never entered a URL — still the browser VM, no breakage.
  assert.equal(selectRunner({ backend: "local", baseUrl: "" }, browser), browser);
});

test("selectRunner swaps in the local runner once it is fully configured", () => {
  const browser = { supported: () => true, boot: async () => true, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  const picked = selectRunner({ backend: "local", baseUrl: "http://localhost:8100" }, browser, { fetch: fakeFetch(() => jsonResponse({ ok: true })) });
  assert.notEqual(picked, browser);
  assert.equal(typeof picked.exec, "function");
  assert.equal(typeof picked.boot, "function");
  assert.equal(typeof picked.supported, "function");
});
