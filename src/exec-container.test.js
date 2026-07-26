// Unit tests for the SERVER-SIDE execution environment (src/exec-container.js):
// the ephemeral Cloudflare Container per research session that Se/rver offers as
// an alternative to the in-browser CheerpX VM.
//
// Three things are worth pinning here, and they are the three that would hurt:
//
//   1. AVAILABILITY. The container binding is optional and absent by default, so
//      every path must degrade to "unavailable" rather than throw — and /healthz
//      must still answer, because that is what the settings UI reads to explain
//      itself.
//   2. THE CONTAINER CONTRACT. Commands go through `bash -lc`, the per-command
//      deadline is ours (the container API has no timeout), a timed-out command
//      comes back as exit 124 with whatever it printed, and output is capped.
//      All of it is exercised against a FAKE container that behaves like the
//      documented one (exec throws until running, output() may be read once).
//   3. THE MOUNTS. /src is seeded from the deploy's OWN snapshot through ASSETS,
//      guarded by the content stamp so a warm container pays nothing on a
//      second send.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTAINER_ENTRYPOINT,
  DEFAULT_MAX_STDOUT_BYTES,
  ExecSandbox,
  MAX_EXEC_TIMEOUT_MS,
  MAX_SESSION_COMMANDS,
  MAX_STDOUT_BYTES,
  MIN_EXEC_TIMEOUT_MS,
  clampExecTimeout,
  clampStdoutBytes,
  containerName,
  decodeOutput,
  execContainerAvailable,
  execContainerConfigured,
  handleExecApi,
  healthBody,
  mountSeedScript,
  parseExecBody,
  planSourceArchive,
  sanitizeSession,
  shellArgv,
  sourceSeedScript,
} from "./exec-container.js";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const user = /** @type {any} */ ({ id: "u1", user: { id: "u1" }, role: "user" });
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- pure helpers ----------------------------------------------------------

test("availability follows the OPTIONAL binding, then the sandbox knob", () => {
  assert.equal(execContainerConfigured(/** @type {any} */ ({})), false);
  assert.equal(execContainerConfigured(/** @type {any} */ ({ EXEC_SANDBOX: {} })), true);
  // No binding: unavailable however enabled the account is.
  assert.equal(execContainerAvailable(/** @type {any} */ ({}), user), false);
  // Binding present and the account has a row → the sandbox knob decides, and
  // bashLiteEnabled treats a user row with no stored settings as off.
  const env = /** @type {any} */ ({ EXEC_SANDBOX: {} });
  assert.equal(execContainerAvailable(env, /** @type {any} */ ({ id: "u", user: { id: "u", settings_json: '{"bash_lite_mcp":true}' } })), true);
  assert.equal(execContainerAvailable(env, /** @type {any} */ ({ id: "u", user: { id: "u" } })), false);
});

test("a session id may not shape the Durable Object name freely", () => {
  assert.equal(sanitizeSession("dr-abc_1.2"), "dr-abc_1.2");
  assert.equal(sanitizeSession("../../etc"), "");
  assert.equal(sanitizeSession("has space"), "");
  assert.equal(sanitizeSession("x".repeat(65)), "");
  assert.equal(sanitizeSession(null), "");
  // The USER half always comes from the server-side identity, so a bad session
  // id costs a fresh container and can never address someone else's.
  assert.equal(containerName("u1", "s1"), "u1|s1");
  assert.equal(containerName("u1", "../u2"), "u1|default");
  assert.equal(containerName("", ""), "anon|default");
});

test("timeouts and output caps are clamped into range", () => {
  assert.equal(clampExecTimeout(undefined), MAX_EXEC_TIMEOUT_MS);
  assert.equal(clampExecTimeout(0), MAX_EXEC_TIMEOUT_MS);
  assert.equal(clampExecTimeout(-5), MAX_EXEC_TIMEOUT_MS);
  assert.equal(clampExecTimeout(10 * 60_000), MAX_EXEC_TIMEOUT_MS);
  assert.equal(clampExecTimeout(10), MIN_EXEC_TIMEOUT_MS);
  assert.equal(clampExecTimeout(30_000), 30_000);
  assert.equal(clampStdoutBytes(undefined), DEFAULT_MAX_STDOUT_BYTES);
  assert.equal(clampStdoutBytes(1), 1024);
  assert.equal(clampStdoutBytes(1 << 30), MAX_STDOUT_BYTES);
});

test("an /exec body is validated, never trusted", () => {
  assert.equal(parseExecBody(null).ok, false);
  assert.equal(parseExecBody({ command: "   " }).ok, false);
  assert.equal(parseExecBody({ command: "x".repeat(70_000) }).ok, false);
  const ok = parseExecBody({ command: "ls /workspace", session: "s1", timeoutMs: 5_000, maxStdoutBytes: 2048 });
  assert.deepEqual(ok, { ok: true, command: "ls /workspace", session: "s1", timeoutMs: 5_000, maxStdoutBytes: 2048 });
});

test("commands run through an explicit shell — container.exec does not parse one", () => {
  // `container.exec` starts an executable directly: no pipes, no redirects, no
  // expansion. A research command is full of all three, so the shell is argv.
  assert.deepEqual(shellArgv("grep -r foo /src | head -5"), ["bash", "-lc", "grep -r foo /src | head -5"]);
});

test("output decoding caps on a byte boundary and says so", () => {
  const small = decodeOutput(enc.encode("hello"), 1024);
  assert.deepEqual(small, { text: "hello", truncated: false });
  const big = decodeOutput(enc.encode("abcdefghij"), 4);
  assert.deepEqual(big, { text: "abcd", truncated: true });
  assert.deepEqual(decodeOutput(null, 10), { text: "", truncated: false });
});

test("the health body names the environment, its ephemerality and its network", () => {
  const off = healthBody({ configured: false });
  assert.equal(off.ok, false);
  assert.equal(off.configured, false);
  assert.match(String(off.error), /container binding/);
  const on = healthBody({ configured: true, instanceType: "standard-1" });
  assert.equal(on.ok, true);
  assert.equal(on.protocol, "dree/1");
  assert.equal(on.ephemeral, true);
  // The container starts with enableInternet:false — the same "no network" the
  // browser VM has. The client's status line reads this field verbatim.
  assert.equal(on.network, "none");
  // Both optional DREE/1 capabilities: this environment takes a pushed tar AND
  // can seed /src itself.
  assert.equal(on.mount, true);
  assert.equal(on.source, true);
});

test("the mount seed script installs the project symlink and nothing else", () => {
  assert.equal(mountSeedScript({ project: null }).trim(), "mkdir -p /workspace 2>/dev/null || true");
  const withProj = mountSeedScript({ project: { name: "notes", hash: "abc123" } });
  assert.match(withProj, /mkdir -p '\/mnt\/notes-abc123'/);
  assert.match(withProj, /ln -sfn '\/mnt\/notes-abc123' '\/workspace\/notes'/);
});

test("the source seed script is stamp-guarded and stamps LAST", () => {
  const script = sourceSeedScript("cafe-42");
  // Skip the whole extraction when the container already carries this snapshot.
  assert.match(script, /\[ "\$\(cat \/src\/\.dr-stamp 2>\/dev\/null\)" = 'cafe-42' \]/);
  // Drain stdin on the cached path, or the writer breaks.
  assert.match(script, /cat > \/dev\/null/);
  // The stamp is written after a successful extraction, never before.
  assert.ok(script.indexOf("tar -xf - -C /src") < script.indexOf("> /src/.dr-stamp"));
  assert.match(script, /ln -sfn \/src \/workspace\/source/);
});

test("the /src archive reuses the browser VM's plan — one content policy", () => {
  const plan = planSourceArchive({
    files: [
      { p: "src/pipeline.js", t: "// phases" },
      { p: "sdk/pair-cli.mjs", t: "// cli" },
      { p: "../escape", t: "nope" },
    ],
  });
  assert.ok(plan);
  // The traversal path is dropped by the shared planner, not by this module.
  assert.equal(plan.count, 2);
  const text = dec.decode(plan.tar);
  assert.match(text, /src\/pipeline\.js/);
  // sdk/ is part of the snapshot, which is what makes "the SDK is mounted" true
  // without a second mount.
  assert.match(text, /sdk\/pair-cli\.mjs/);
  assert.doesNotMatch(text, /escape/);
  assert.equal(planSourceArchive({ files: [] }), null);
  assert.equal(planSourceArchive(null), null);
});

// ---- the HTTP surface ------------------------------------------------------

test("healthz answers on an unconfigured deploy instead of failing", async () => {
  const url = new URL("https://x.test/api/exec/healthz");
  const resp = await handleExecApi(new Request(url), /** @type {any} */ ({}), url, noopLog, user);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, false);
  assert.equal(body.configured, false);
});

test("healthz distinguishes 'no binding' from 'the knob is off'", async () => {
  const url = new URL("https://x.test/api/exec/healthz");
  const env = /** @type {any} */ ({ EXEC_SANDBOX: {} });
  const body = await (await handleExecApi(new Request(url), env, url, noopLog, user)).json();
  assert.equal(body.configured, true);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /execution sandbox on/i);
});

test("every other endpoint refuses cleanly when unavailable", async () => {
  const url = new URL("https://x.test/api/exec/exec");
  const req = new Request(url, { method: "POST", body: JSON.stringify({ command: "ls" }) });
  const resp = await handleExecApi(req, /** @type {any} */ ({}), url, noopLog, user);
  assert.equal(resp.status, 503);
  const body = await resp.json();
  // Shaped like a FAILED COMMAND, so the agent loop's existing path handles it.
  assert.equal(body.exitCode, 1);
  assert.match(body.stderr, /unavailable/);
});

// ---- the Durable Object against a fake container ---------------------------

/**
 * A container double that behaves like the documented one: `exec` throws while
 * the container isn't running, `output()` may only be read once, and a killed
 * process resolves rather than rejecting.
 * @param {{startDelayCalls?: number, handler?: (argv: string[], opts: any) => any}} [opts]
 */
function fakeContainer(opts = {}) {
  let notReady = opts.startDelayCalls || 0;
  const calls = [];
  return {
    running: false,
    started: null,
    destroyed: null,
    calls,
    start(args) {
      this.started = args;
      this.running = true;
    },
    async destroy(why) {
      this.destroyed = why;
      this.running = false;
    },
    async exec(argv, execOpts = {}) {
      if (!this.running) throw new Error("container is not running");
      if (notReady > 0) {
        notReady -= 1;
        throw new Error("not ready yet");
      }
      calls.push({ argv, opts: execOpts });
      const planned = (opts.handler && opts.handler(argv, execOpts)) || {};
      const exitCode = planned.exitCode ?? 0;
      let read = false;
      return {
        pid: 1,
        exitCode: Promise.resolve(exitCode),
        kill() {
          planned.killed = true;
        },
        output() {
          if (read) throw new TypeError("output() read twice");
          read = true;
          if (planned.hang) return new Promise(() => {});
          return Promise.resolve({
            stdout: enc.encode(planned.stdout ?? ""),
            stderr: enc.encode(planned.stderr ?? ""),
            exitCode,
          });
        },
      };
    },
  };
}

/** A DurableObjectState double: the container, plus a KV-ish storage. */
function fakeState(container) {
  const map = new Map();
  return {
    container,
    storage: {
      async get(k) {
        return map.get(k);
      },
      async put(obj) {
        for (const [k, v] of Object.entries(obj)) map.set(k, v);
      },
      async setAlarm(when) {
        map.set("__alarm", when);
      },
    },
    blockConcurrencyWhile: (fn) => fn(),
    _map: map,
  };
}

const doReq = (path, body) =>
  new Request("https://container.invalid" + path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("the first command starts the container and waits for readiness", async () => {
  const container = fakeContainer({ startDelayCalls: 2, handler: () => ({ stdout: "Linux\n" }) });
  const sandbox = new ExecSandbox(fakeState(container), {});
  const resp = await sandbox.fetch(doReq("/exec", { command: "uname -s" }));
  const body = await resp.json();
  assert.deepEqual(body, { exitCode: 0, stdout: "Linux\n", stderr: "" });
  // Started with the sleeping entrypoint and NO internet — the same posture as
  // the browser VM.
  assert.deepEqual(container.started.entrypoint, CONTAINER_ENTRYPOINT);
  assert.equal(container.started.enableInternet, false);
  // The readiness probe is the cheapest possible process, then the real command.
  assert.deepEqual(container.calls[0].argv, ["true"]);
  assert.deepEqual(container.calls[1].argv, ["bash", "-lc", "uname -s"]);
  assert.equal(container.calls[1].opts.cwd, "/workspace");
});

test("a container that never becomes ready fails the command, not the request", async () => {
  const container = fakeContainer({ startDelayCalls: Number.MAX_SAFE_INTEGER });
  const sandbox = new ExecSandbox(fakeState(container), {});
  // Shrink the wait so the test doesn't sit through the real 20 s ceiling.
  const resp = await withShortWaits(() => sandbox.fetch(doReq("/exec", { command: "ls" })));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.exitCode, 1);
  assert.match(body.stderr, /container unavailable/);
});

test("a hung command is killed and reported as exit 124", async () => {
  const container = fakeContainer({ handler: (argv) => (argv[2] === "sleep 999" ? { hang: true } : {}) });
  const sandbox = new ExecSandbox(fakeState(container), {});
  const resp = await sandbox.fetch(doReq("/exec", { command: "sleep 999", timeoutMs: 1_000 }));
  const body = await resp.json();
  // 124 is the vocabulary the browser VM and the local runner already use, so
  // the agent loop needs no new branch.
  assert.equal(body.exitCode, 124);
  assert.match(body.stderr, /timed out after 1s/);
});

test("stdout is capped at what the caller asked for", async () => {
  const container = fakeContainer({ handler: () => ({ stdout: "x".repeat(5_000) }) });
  const sandbox = new ExecSandbox(fakeState(container), {});
  const body = await (await sandbox.fetch(doReq("/exec", { command: "cat big", maxStdoutBytes: 2048 }))).json();
  assert.equal(body.stdout.length, 2048);
  assert.equal(body.truncated, true);
});

test("the per-session command budget is enforced and survives eviction", async () => {
  const container = fakeContainer();
  const state = fakeState(container);
  const sandbox = new ExecSandbox(state, {});
  await sandbox.fetch(doReq("/exec", { command: "ls" }));
  assert.equal(await state.storage.get("commands"), 1);
  // A fresh Durable Object over the same storage (what an eviction looks like)
  // must resume the count rather than restart it.
  await state.storage.put({ commands: MAX_SESSION_COMMANDS });
  const revived = new ExecSandbox(state, {});
  const body = await (await revived.fetch(doReq("/exec", { command: "ls" }))).json();
  assert.equal(body.exitCode, 1);
  assert.match(body.stderr, /command budget/);
});

test("mounting extracts the pushed archive at / and arms the reaper", async () => {
  const container = fakeContainer();
  const state = fakeState(container);
  const sandbox = new ExecSandbox(state, {});
  const resp = await sandbox.fetch(
    new Request("https://container.invalid/mount", { method: "POST", body: "tar-bytes" }),
  );
  assert.deepEqual(await resp.json(), { ok: true });
  const tarCall = container.calls.find((c) => String(c.argv[2] || "").includes("tar -xf"));
  assert.ok(tarCall, "the archive is extracted with a single tar");
  assert.match(tarCall.argv[2], /-C \/ --no-same-owner/);
  assert.ok(tarCall.opts.stdin, "the request body is piped into tar's stdin");
  assert.ok(Number(state._map.get("__alarm")) > Date.now());
});

test("/src is seeded from THIS deploy's snapshot, and skipped when already current", async () => {
  const snapshot = { files: [{ p: "src/pipeline.js", t: "// phases" }, { p: "sdk/MANIFEST.json", t: "{}" }] };
  const plan = planSourceArchive(snapshot);
  assert.ok(plan);
  let stampOnDisk = "";
  const container = fakeContainer({
    handler: (argv) => {
      const script = String(argv[2] || "");
      if (script.startsWith("cat /src/.dr-stamp")) return { stdout: stampOnDisk };
      if (script.includes("tar -xf - -C /src")) {
        stampOnDisk = plan.stamp;
        return { stdout: "seeded" };
      }
      return {};
    },
  });
  const env = {
    ASSETS: {
      async fetch(req) {
        assert.match(new URL(req.url).pathname, /\/introspect\/source-snapshot\.json$/);
        return new Response(JSON.stringify(snapshot), { headers: { "content-type": "application/json" } });
      },
    },
  };
  const sandbox = new ExecSandbox(fakeState(container), env);
  const first = await (await sandbox.fetch(doReq("/source"))).json();
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.count, 2);
  // Second send in the same conversation: the stamp matches, so nothing is
  // extracted and the 11 MB archive is never streamed again.
  const second = await (await sandbox.fetch(doReq("/source"))).json();
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(container.calls.filter((c) => String(c.argv[2] || "").includes("tar -xf - -C /src")).length, 1);
});

test("a missing ASSETS binding fails the source mount softly", async () => {
  const sandbox = new ExecSandbox(fakeState(fakeContainer()), {});
  const body = await (await sandbox.fetch(doReq("/source"))).json();
  assert.equal(body.ok, false);
  assert.match(body.error, /ASSETS/);
});

test("reset destroys the session's container", async () => {
  const container = fakeContainer();
  const sandbox = new ExecSandbox(fakeState(container), {});
  await sandbox.fetch(doReq("/exec", { command: "ls" }));
  assert.equal(container.running, true);
  const body = await (await sandbox.fetch(doReq("/reset"))).json();
  assert.equal(body.ok, true);
  assert.equal(container.running, false);
  assert.match(String(container.destroyed), /client asked/);
});

test("the idle alarm destroys the container", async () => {
  const container = fakeContainer();
  const sandbox = new ExecSandbox(fakeState(container), {});
  await sandbox.fetch(doReq("/exec", { command: "ls" }));
  await sandbox.alarm();
  assert.equal(container.running, false);
  assert.match(String(container.destroyed), /idle/);
});

/**
 * Run `fn` with the module's readiness wait effectively disabled. The retry loop
 * is bounded by wall clock, so the honest way to test the give-up path is to
 * make the clock move — not to weaken the code under test.
 * @param {() => Promise<any>} fn
 */
async function withShortWaits(fn) {
  const realNow = Date.now;
  let t = realNow();
  // Each readiness attempt sleeps 250 ms; jump the clock 5 s per call so the
  // 20 s ceiling is reached in a handful of iterations.
  Date.now = () => {
    t += 5_000;
    return t;
  };
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}
