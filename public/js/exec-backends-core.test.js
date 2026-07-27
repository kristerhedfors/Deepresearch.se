// Unit tests for the SHARED execution-environment core (exec-backends-core.js)
// — the seam that lets a DREE/1 runner on the user's own machine stand in for
// the in-browser CheerpX VM. Both tiers import this module directly, so what is
// pinned here is the whole contract: normalization, the fail-soft parsers, the
// probe's error wording, and — above all — that selectRunner returns the
// browser bridge UNCHANGED unless a local runner is fully configured (the
// property that keeps this feature from being able to regress the sandbox).
//
// fetch is injected everywhere, so it runs in `node --test` with no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RUNNER_URL,
  DREE_PROTOCOL,
  EXEC_AUTO,
  EXEC_BACKENDS,
  defaultExecBackend,
  resolveExecBackend,
  MIN_REMOTE_EXEC_TIMEOUT_MS,
  REMOTE_EXEC_TIMEOUT_MS,
  execBackend,
  execConnectLog,
  makeLocalRunner,
  newExecSession,
  normalizeExecBackend,
  parseExecResponse,
  parseHealth,
  probeRunner,
  remoteExecTimeout,
  runnerStatusLine,
  SERVER_EXEC_BASE,
  execBackendsFor,
  makeContainerRunner,
  selectRunner,
  usesLocalRunner,
  usesRemoteRunner,
  usesServerContainer,
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

test("normalizeExecBackend falls back to EXEC_AUTO — 'no pick yet' — for anything unknown", () => {
  assert.deepEqual(normalizeExecBackend(null), { backend: EXEC_AUTO, baseUrl: "", key: "" });
  assert.equal(normalizeExecBackend({ backend: "wat" }).backend, EXEC_AUTO);
  assert.equal(normalizeExecBackend({ backend: "local" }).backend, "local");
  // An explicit pick is never rewritten — including an explicit browser VM,
  // which is what makes "chose the browser" distinguishable from "never chose".
  assert.equal(normalizeExecBackend({ backend: "browser" }).backend, "browser");
  assert.equal(normalizeExecBackend({ backend: EXEC_AUTO }).backend, EXEC_AUTO);
});

// 2026-07-27 owner directive: the server-side Cloudflare container is the MAIN
// execution environment — live, native-speed, proven in production (chat_logs
// #677 ran eight commands in a Firecracker microVM). An untouched setting on
// Se/rver therefore resolves to it, while Se/cure is unchanged.
describe("the resolved default environment", () => {
  test("an untouched setting is the cloud container on Se/rver, the browser VM everywhere else", () => {
    const auto = normalizeExecBackend(null);
    assert.equal(resolveExecBackend(auto, { tier: "server", container: true }).backend, "cloudflare");
    // No binding on this deploy → the environment does not exist to default to.
    assert.equal(resolveExecBackend(auto, { tier: "server", container: false }).backend, "browser");
    // Se/cure never reaches the container: the tier gate is what forbids it,
    // and it applies to the DEFAULT exactly as it applies to an explicit pick.
    assert.equal(resolveExecBackend(auto, { tier: "secure", container: true }).backend, "browser");
    // A caller that does not state its tier lands on the safe side.
    assert.equal(resolveExecBackend(auto, { container: true }).backend, "browser");
  });

  test("an explicit pick always wins over the default", () => {
    const opts = { tier: "server", container: true };
    assert.equal(resolveExecBackend({ backend: "browser" }, opts).backend, "browser");
    assert.equal(resolveExecBackend({ backend: "local", baseUrl: "http://x" }, opts).backend, "local");
  });

  test("selectRunner routes an untouched Se/rver setting to the container, Se/cure to the browser", () => {
    const browser = { boot: async () => true, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), reset: () => {} };
    // The flip: no config at all, Se/rver, container available → NOT the browser bridge.
    assert.notEqual(selectRunner(null, browser, { tier: "server", container: true }), browser);
    // Every other combination still hands back the browser bridge UNCHANGED —
    // the "default path stays byte-identical" rule, now scoped to the tiers and
    // deploys that genuinely have no other environment.
    assert.equal(selectRunner(null, browser, { tier: "server", container: false }), browser);
    assert.equal(selectRunner(null, browser, { tier: "secure", container: true }), browser);
    assert.equal(selectRunner(null, browser, {}), browser);
    assert.equal(selectRunner({ backend: "browser" }, browser, { tier: "server", container: true }), browser);
  });

  test("usesServerContainer and usesRemoteRunner agree with the resolver", () => {
    assert.equal(usesServerContainer(normalizeExecBackend(null), "server", { container: true }), true);
    assert.equal(usesServerContainer(normalizeExecBackend(null), "server", { container: false }), false);
    assert.equal(usesServerContainer(normalizeExecBackend(null), "secure", { container: true }), false);
    assert.equal(usesRemoteRunner(normalizeExecBackend(null), "server", { container: true }), true);
    assert.equal(usesRemoteRunner(normalizeExecBackend(null), "secure", { container: true }), false);
  });

  test("defaultExecBackend is the one place the direction is decided", () => {
    assert.equal(defaultExecBackend({ tier: "server", container: true }), "cloudflare");
    assert.equal(defaultExecBackend({ tier: "server" }), "browser");
    assert.equal(defaultExecBackend({ tier: "secure", container: true }), "browser");
    assert.equal(defaultExecBackend(), "browser");
  });

  // EXEC_AUTO is the ABSENCE of a pick, not a place — so it must never appear
  // as a row a user could select in either tier's picker.
  test("EXEC_AUTO is never offered as a pickable environment", () => {
    for (const tier of ["secure", "server"]) {
      const ids = execBackendsFor(tier, { container: true }).map((b) => b.id);
      assert.ok(!ids.includes(EXEC_AUTO), tier);
    }
  });
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
    // The optional capabilities are absent unless advertised, so an older
    // runner is simply never asked to mount anything.
    mount: false,
    source: false,
    version: "",
  });
  assert.equal(parseHealth({ ok: true, ephemeral: false }).ephemeral, false);
  assert.equal(parseHealth({ ok: true, network: "none" }).network, "none");
  assert.equal(parseHealth({ ok: true, mount: true, source: true }).mount, true);
  assert.equal(parseHealth({ ok: true, mount: true, source: true }).source, true);
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

// ---- the THIRD environment: this platform's own container --------------------
//
// The server-side container (src/exec-container.js) is the same DREE/1 client
// pointed at `/api/exec`. What needs pinning is not the transport — that is the
// tests above — but the two things that would be dangerous or expensive to get
// wrong: the TIER GATE (Se/cure must never select it) and the MOUNT bridge (the
// 11 MB source tree must not be pushed up from the browser).

test("the container backend is Se/rver only, and says so in the registry", () => {
  const cf = execBackend("cloudflare");
  assert.ok(cf);
  assert.deepEqual(cf.tiers, ["server"]);
  assert.equal(cf.needsUrl, false);
  // The two browser-direct environments stay available to both tiers.
  assert.deepEqual(execBackend("browser").tiers, ["secure", "server"]);
  assert.deepEqual(execBackend("local").tiers, ["secure", "server"]);
});

test("execBackendsFor hides what a tier may not use, and what the deploy lacks", () => {
  // Se/cure: never the container, whatever the server reports.
  assert.deepEqual(execBackendsFor("secure", { container: true }).map((b) => b.id), ["browser", "local"]);
  // Se/rver without the binding: the option is simply absent.
  assert.deepEqual(execBackendsFor("server", {}).map((b) => b.id), ["browser", "local"]);
  assert.deepEqual(execBackendsFor("server", { container: true }).map((b) => b.id), ["browser", "local", "cloudflare"]);
});

test("Se/cure cannot select the server-side container — invariant 4, in code", () => {
  const browser = { supported: () => true, boot: async () => true, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  const cfg = { backend: "cloudflare" };
  // A hand-edited sealed state (or one carried in from a shared workspace)
  // naming the container backend lands on the browser VM instead of putting
  // Se/cure's commands on the wire.
  assert.equal(selectRunner(cfg, browser, { tier: "secure" }), browser);
  // A caller that doesn't state a tier gets the same safe direction.
  assert.equal(selectRunner(cfg, browser), browser);
  assert.equal(usesServerContainer(cfg, "secure"), false);
  assert.equal(usesServerContainer(cfg, "server"), true);
  assert.equal(usesRemoteRunner(cfg, "secure"), false);
  assert.equal(usesRemoteRunner(cfg, "server"), true);
  assert.equal(usesRemoteRunner({ backend: "local", baseUrl: "http://x" }, "secure"), true);
  assert.equal(usesRemoteRunner({ backend: "browser" }, "server"), false);
});

test("Se/rver selects the container without a URL, and calls this site", async () => {
  const browser = { supported: () => true, boot: async () => true, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  const f = fakeFetch((url) =>
    String(url).endsWith("/healthz")
      ? jsonResponse({ ok: true, protocol: DREE_PROTOCOL, backend: "cloudflare-container", network: "none" })
      : jsonResponse({ exitCode: 0, stdout: "ok", stderr: "" }),
  );
  const runner = selectRunner({ backend: "cloudflare" }, browser, { fetch: f, session: "s1", tier: "server" });
  assert.notEqual(runner, browser);
  assert.equal(await runner.boot(), true);
  await runner.exec("uname -s");
  assert.equal(f.calls[0].url, SERVER_EXEC_BASE + "/healthz");
  assert.equal(f.calls[1].url, SERVER_EXEC_BASE + "/exec");
  assert.equal(JSON.parse(f.calls[1].init.body).session, "s1");
});

test("boot pushes the send's files as ONE tar, then installs the symlink", async () => {
  const bytes = new TextEncoder().encode("hello");
  const provider = async () => ({
    session: [{ name: "notes.txt", type: "text/plain", bytes }],
    project: { name: "Trip Notes", id: "p1", files: [{ name: "plan.md", type: "text/markdown", bytes }] },
    source: null,
  });
  const f = fakeFetch((url) =>
    String(url).includes("/healthz")
      ? jsonResponse({ ok: true, protocol: DREE_PROTOCOL, backend: "cloudflare-container", mount: true, source: true })
      : String(url).includes("/mount")
        ? jsonResponse({ ok: true })
        : jsonResponse({ exitCode: 0, stdout: "", stderr: "" }),
  );
  const runner = makeContainerRunner({ fetch: f, session: "s2" });
  const steps = [];
  assert.equal(await runner.boot(provider, (m) => steps.push(m)), true);
  const mount = f.calls.find((c) => String(c.url).includes("/mount"));
  assert.ok(mount, "the files are pushed to the mount endpoint");
  assert.match(String(mount.url), /session=s2/);
  assert.equal(mount.init.headers["content-type"], "application/x-tar");
  // ONE archive carries the manifest, the session file and the project file.
  const tar = new TextDecoder().decode(mount.init.body);
  assert.match(tar, /workspace\/INDEX\.txt/);
  assert.match(tar, /workspace\/notes\.txt/);
  assert.match(tar, /mnt\/trip-notes-/);
  // …followed by the seed script that makes /workspace/<project> point at it.
  const seed = f.calls.find((c) => String(c.url).endsWith("/exec"));
  assert.match(JSON.parse(seed.init.body).command, /ln -sfn '\/mnt\/trip-notes-/);
  assert.ok(steps.some((s) => /Mounting your files/.test(s)));
});

test("the source tree is requested from the SERVER, never pushed from here", async () => {
  // What stream.js actually hands a container runner in developer mode: a
  // MARKER, not the snapshot. The page never fetches multiple MB so it can ask
  // the server to read its own asset.
  const provider = async () => ({ session: [], project: null, source: { server: true } });
  const f = fakeFetch((url) =>
    String(url).includes("/healthz")
      ? jsonResponse({ ok: true, protocol: DREE_PROTOCOL, backend: "cloudflare-container", mount: true, source: true })
      : String(url).includes("/source")
        ? jsonResponse({ ok: true, count: 40, bytes: 1234, cached: false })
        : jsonResponse({ exitCode: 0, stdout: "", stderr: "" }),
  );
  const runner = makeContainerRunner({ fetch: f, session: "s3" });
  await runner.boot(provider, () => {});
  assert.ok(f.calls.some((c) => String(c.url).includes("/source?session=s3")));
  // No tar push at all: with only the source to mount there is nothing of the
  // USER's to send, and the snapshot is the server's own asset.
  assert.equal(f.calls.some((c) => String(c.url).includes("/mount")), false);
});

test("a runner that doesn't advertise mounting is never asked to mount", async () => {
  const provider = async () => ({ session: [{ name: "a.txt", type: "text/plain", bytes: new Uint8Array([1]) }] });
  const f = fakeFetch((url) =>
    String(url).includes("/healthz")
      ? jsonResponse({ ok: true, protocol: DREE_PROTOCOL, backend: "docker" }) // no mount/source flags
      : jsonResponse({ exitCode: 0, stdout: "", stderr: "" }),
  );
  const runner = makeLocalRunner({ backend: "local", baseUrl: "http://x", key: "" }, { fetch: f });
  await runner.boot(provider, () => {});
  assert.equal(f.calls.length, 1); // the probe, and nothing else
});

test("a failed mount loses the FILES, never the shell", async () => {
  const provider = async () => ({ session: [{ name: "a.txt", type: "text/plain", bytes: new Uint8Array([1]) }] });
  const f = fakeFetch((url) => {
    if (String(url).includes("/healthz")) {
      return jsonResponse({ ok: true, protocol: DREE_PROTOCOL, backend: "cloudflare-container", mount: true });
    }
    if (String(url).includes("/mount")) throw new Error("network went away");
    return jsonResponse({ exitCode: 0, stdout: "", stderr: "" });
  });
  const runner = makeContainerRunner({ fetch: f, session: "s4" });
  // Booted anyway (invariant 2), and the command still runs.
  assert.equal(await runner.boot(provider, () => {}), true);
  assert.equal((await runner.exec("ls")).exitCode, 0);
});

test("mounting happens once per runner, not once per round", async () => {
  const provider = async () => ({ session: [{ name: "a.txt", type: "text/plain", bytes: new Uint8Array([1]) }] });
  const f = fakeFetch((url) =>
    String(url).includes("/healthz")
      ? jsonResponse({ ok: true, protocol: DREE_PROTOCOL, backend: "cloudflare-container", mount: true })
      : String(url).includes("/mount")
        ? jsonResponse({ ok: true })
        : jsonResponse({ exitCode: 0, stdout: "", stderr: "" }),
  );
  const runner = makeContainerRunner({ fetch: f, session: "s5" });
  await runner.boot(provider, () => {});
  await runner.boot(provider, () => {}); // bash-core calls ensureReady per round
  assert.equal(f.calls.filter((c) => String(c.url).includes("/mount")).length, 1);
  assert.equal(f.calls.filter((c) => String(c.url).includes("/healthz")).length, 1);
});

test("a health body that diagnoses itself is relayed verbatim", async () => {
  const f = fakeFetch(() =>
    jsonResponse({ ok: false, protocol: DREE_PROTOCOL, configured: false, error: "This deploy has no container binding." }),
  );
  const probe = await probeRunner({ baseUrl: SERVER_EXEC_BASE, key: "" }, { fetch: f });
  assert.equal(probe.reachable, false);
  // The settings UI shows this line as-is, so a real explanation must survive.
  assert.equal(probe.error, "This deploy has no container binding.");
});

// ---- execConnectLog: the terminal pane's connect vocabulary ------------------
// A remote environment narrates nothing (boot is a probe, exec is a fetch), so
// the pane behind the chat stayed empty on every send whose commands ran there
// — feedback #43, once the cloud container became Se/rver's default. These are
// the lines the browser VM would have written for itself.

test("execConnectLog names the environment from the registry", () => {
  const c = execConnectLog("cloudflare");
  assert.match(c.open, /connecting to the cloud container/);
  assert.match(c.ready, /commands run in the cloud container/);
  assert.match(c.failed, /could not reach the cloud container/);

  const l = execConnectLog("local");
  assert.match(l.open, /connecting to the local runner/);
  assert.match(l.ready, /commands run in the local runner/);
});

test("execConnectLog says a shell was lost, not just that something failed", () => {
  // The empty-pane failure mode is the one feedback #42 and #43 both landed on:
  // a lit-up terminal icon over a blank pane. The failed line has to say, in the
  // pane itself, that there is no shell behind this answer.
  assert.match(execConnectLog("cloudflare").failed, /answering without a shell/);
});

test("execConnectLog degrades rather than throwing on an unknown backend", () => {
  for (const bad of ["", null, undefined, "made-up", 7]) {
    const c = execConnectLog(/** @type {any} */ (bad));
    assert.match(c.open, /remote runner/);
    assert.equal(typeof c.ready, "string");
    assert.equal(typeof c.failed, "string");
  }
});
