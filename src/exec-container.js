// @ts-check
// SERVER-SIDE EXECUTION ENVIRONMENT — an ephemeral Cloudflare Container per
// research session, offered on Se/rver as an alternative to the in-browser
// CheerpX Linux VM. The THIRD execution environment (docs/EXECUTION-ENVIRONMENTS.md):
//
//   browser     the CheerpX VM in the tab            both tiers, the default
//   local       a DREE/1 runner on the user's box    both tiers, browser-direct
//   cloudflare  THIS module                          Se/rver ONLY
//
// WHY IT IS Se/rver ONLY (invariant 4). The other two environments are
// browser-direct: no command, no output and no mounted file passes through this
// server. This one runs the commands ON this platform, so the server is
// unavoidably in the data path — which is admissible on Se/rver, where the
// server is INSIDE the trust boundary (owner directive, 2026-07-24), and is NOT
// admissible on Se/cure, which would need a third standing exception. The tier
// gate is enforced twice: the client core refuses to select this backend for
// Se/cure (exec-backends-core.js selectRunner), and this endpoint only exists
// behind the signed-in identity gate. Se/cure has no identity, so it cannot
// reach it even if a hand-edited sealed state asked for it.
//
// ---- the wire is UNCHANGED --------------------------------------------------
//
// This speaks the same DREE/1 the local runner speaks (public/cure/local-exec/
// runner.mjs), just at a same-origin base (`/api/exec`) with the session cookie
// instead of `http://localhost:8100` with an optional key. So every consumer —
// the bash-core.js agent loop, the transcript renderer, the deliverables export
// — is byte-for-byte indifferent, and "Test connection" works the same way:
//
//   GET    /api/exec/healthz   → the DREE/1 health body (+ mount:true)
//   POST   /api/exec/exec      → {command, session, timeoutMs, maxStdoutBytes}
//   POST   /api/exec/mount     → a ustar archive (application/x-tar), extracted at /
//   POST   /api/exec/source    → seed /src from THIS deploy's source snapshot
//   DELETE /api/exec/session   → destroy this session's container now
//
// `mount` and `source` are DREE/1's two OPTIONAL endpoints, advertised by
// /healthz (`mount:true` / `source:true`). They are what makes this environment
// carry "everything our CheerpX Linux does": /workspace with the session's
// attachments and INDEX.txt, /mnt/<project>-<hash> with the active project (and
// the friendly /workspace/<project> symlink), and — in developer mode — the
// deployed source tree (which includes sdk/) at /src with /workspace/source
// pointing at it.
//
// ---- how the container is driven -------------------------------------------
//
// Cloudflare gives every container instance its own VM, managed by a Durable
// Object, and the DO's raw container API can start processes directly
// (`ctx.container.exec`). So there is NO service inside the image: no port to
// wait for, no HTTP server, no agent — the image is a plain Debian with a
// toolchain and `sleep infinity` as its entrypoint, and each shell command is
// one `bash -lc` process. That is what keeps this dependency-free (invariant 5):
// no @cloudflare/containers, no @cloudflare/sandbox, no build step.
//
// ---- availability ----------------------------------------------------------
//
// The EXEC_SANDBOX binding is OPTIONAL. A binding whose resource does not exist
// yet fails EVERY deploy outright (the same failure class as the round-4 cpu_ms
// incident and the R2/Vectorize bindings — see wrangler.toml and
// tests/MODEL-EVAL-FINDINGS.md), so the container + Durable Object block shipped
// commented out until the image existed. It exists now and the block is
// uncommented (2026-07-26), but no deploy has carried it, so the binding is
// still absent in production. Without it this module reports the environment
// unavailable, /api/settings says so, and the client hides the option — exactly
// how the Shodan and Maps knobs behave without their keys. The DEPLOY is the
// switch; the procedure is in wrangler.toml next to the block and in
// docs/EXECUTION-ENVIRONMENTS.md §9.

import { jsonResponse } from "./http.js";
import { buildTar, planSourceMount } from "../public/js/sandbox-files.js";
import { bashLiteEnabled } from "./settings.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

/** The protocol this endpoint speaks — the same wire as the local runner. */
export const DREE_PROTOCOL = "dree/1";

/** What /healthz reports as its backend, so a transcript names the environment. */
export const CONTAINER_BACKEND = "cloudflare-container";

/** The image the container runs (mirrors container/Dockerfile's base). */
export const CONTAINER_IMAGE = "debian:stable-slim + toolchain";

/**
 * The container's entrypoint. There is no service in the image — commands are
 * separate processes started through the DO's container API — so the entrypoint
 * exists only to keep the instance alive and reapable.
 */
export const CONTAINER_ENTRYPOINT = ["sleep", "infinity"];

/**
 * Per-command ceiling, and the floor a caller may clamp down to. Mirrors
 * exec-backends-core.js's REMOTE_EXEC_TIMEOUT_MS: native execution is orders of
 * magnitude faster than the emulator, so a command running this long is doing
 * real work (a build, an index) rather than wedged.
 */
export const MAX_EXEC_TIMEOUT_MS = 120_000;
export const MIN_EXEC_TIMEOUT_MS = 1_000;

/** Default cap on one command's stdout, in bytes (the client asks for less). */
export const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024;
/** Hard ceiling on what we will decode and return for one command. */
export const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

/** Largest mount archive accepted in one /mount call. */
export const MAX_MOUNT_BYTES = 48 * 1024 * 1024;

/**
 * Bounds on ONE session's container, enforced in the Durable Object. These are
 * the cost fence: a container is destroyed when it goes idle, when it has run
 * its command budget, or when it simply gets old — whichever comes first. The
 * GLOBAL fence is `max_instances` in wrangler.toml.
 */
export const IDLE_DESTROY_MS = 10 * 60 * 1000;
export const MAX_SESSION_MS = 60 * 60 * 1000;
export const MAX_SESSION_COMMANDS = 400;

/** How long we will wait for a just-started container to accept a process. */
export const START_WAIT_MS = 20_000;

// ---- pure helpers (unit-tested in src/exec-container.test.js) ---------------

/**
 * Whether this deploy can offer the server-side container at all — i.e. whether
 * the optional Durable Object binding exists. Absent is the SHIPPED default.
 * @param {Env} env
 * @returns {boolean}
 */
export function execContainerConfigured(env) {
  return !!(env && /** @type {any} */ (env).EXEC_SANDBOX);
}

/**
 * Whether this identity may use it: the deploy must carry the binding AND the
 * execution-sandbox knob must be on for this account — the same gate
 * /api/bash/step applies, because this is the same feature with a different
 * machine underneath.
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function execContainerAvailable(env, identity) {
  return execContainerConfigured(env) && bashLiteEnabled(env, identity);
}

/**
 * A client-supplied session id, restricted to what may safely become part of a
 * Durable Object name. Empty when unusable — the caller then makes one up, so a
 * malformed id costs a fresh container, never an error.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeSession(raw) {
  const s = String(raw == null ? "" : raw).trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(s) ? s : "";
}

/**
 * The Durable Object name for one user's session. The USER half comes from the
 * server-side identity and never from the request body, which is what makes one
 * account unable to reach another's container by guessing a session id.
 * @param {string} userId
 * @param {string} session
 * @returns {string}
 */
export function containerName(userId, session) {
  return String(userId || "anon") + "|" + (sanitizeSession(session) || "default");
}

/** @param {unknown} ms @returns {number} */
export function clampExecTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return MAX_EXEC_TIMEOUT_MS;
  return Math.max(MIN_EXEC_TIMEOUT_MS, Math.min(MAX_EXEC_TIMEOUT_MS, Math.round(n)));
}

/** @param {unknown} n @returns {number} */
export function clampStdoutBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX_STDOUT_BYTES;
  return Math.max(1024, Math.min(MAX_STDOUT_BYTES, Math.round(v)));
}

/**
 * Validate an /exec body. Returns the normalized request or an error string —
 * never throws, and never runs an empty command.
 * @param {any} body
 * @returns {{ok: true, command: string, session: string, timeoutMs: number, maxStdoutBytes: number} | {ok: false, error: string}}
 */
export function parseExecBody(body) {
  const command = typeof body?.command === "string" ? body.command : "";
  if (!command.trim()) return { ok: false, error: "A `command` string is required." };
  if (command.length > 64 * 1024) return { ok: false, error: "That command is too long." };
  return {
    ok: true,
    command,
    session: sanitizeSession(body?.session),
    timeoutMs: clampExecTimeout(body?.timeoutMs),
    maxStdoutBytes: clampStdoutBytes(body?.maxStdoutBytes),
  };
}

/**
 * The argv for one shell command. `container.exec` starts an executable
 * directly — it does not interpret pipes, redirects or expansion — so the shell
 * is explicit, exactly as the CheerpX bridge spawns `/bin/sh -c`.
 * @param {string} command
 * @returns {string[]}
 */
export function shellArgv(command) {
  return ["bash", "-lc", String(command)];
}

/**
 * Decode a captured output buffer, capped. Returns the text plus whether the
 * cap bit it, so the DREE/1 `truncated` flag is honest. Cuts on a byte
 * boundary and lets the decoder drop a split multi-byte character rather than
 * emitting a replacement mid-word.
 * @param {ArrayBuffer|Uint8Array|null|undefined} buf
 * @param {number} maxBytes
 * @returns {{text: string, truncated: boolean}}
 */
export function decodeOutput(buf, maxBytes) {
  if (!buf) return { text: "", truncated: false };
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const cap = Math.max(1, Math.round(maxBytes));
  if (bytes.length <= cap) return { text: new TextDecoder().decode(bytes), truncated: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, cap)), truncated: true };
}

/**
 * The DREE/1 health body. Reported whether or not the binding exists, so a
 * client's "Test connection" gets a diagnosis instead of a bare 503 — an
 * unconfigured deploy answers `ok:false` with a reason.
 * @param {{configured: boolean, instanceType?: string}} opts
 * @returns {Record<string, unknown>}
 */
export function healthBody(opts) {
  if (!opts.configured) {
    return {
      ok: false,
      protocol: DREE_PROTOCOL,
      backend: CONTAINER_BACKEND,
      configured: false,
      error: "This deploy has no container binding, so server-side execution is switched off.",
    };
  }
  return {
    ok: true,
    protocol: DREE_PROTOCOL,
    backend: CONTAINER_BACKEND,
    image: CONTAINER_IMAGE,
    instance_type: opts.instanceType || "",
    // Every session gets its own container and its disk is thrown away with it
    // (Cloudflare container disk is ephemeral by design — a restarted instance
    // gets a fresh disk from the image).
    ephemeral: true,
    // The container starts with enableInternet:false, matching the CheerpX VM,
    // which has no network either. Stated rather than assumed — see the
    // exposure ledger in docs/EXECUTION-ENVIRONMENTS.md §5.
    network: "none",
    mount: true,
    source: true,
    configured: true,
    version: "1",
  };
}

/**
 * The script that installs a mounted tar's symlinks and directories — the
 * remote counterpart of the CheerpX seed script. Idempotent, and every failure
 * is swallowed: a missing symlink degrades the layout, it must not fail a send.
 * @param {{project?: {name: string, hash: string}|null}} plan
 * @returns {string}
 */
export function mountSeedScript(plan) {
  const lines = ["mkdir -p /workspace 2>/dev/null || true"];
  const p = plan?.project;
  if (p && p.name && p.hash) {
    const mount = "/mnt/" + p.name + "-" + p.hash;
    lines.push("mkdir -p " + shellQuote(mount) + " 2>/dev/null || true");
    lines.push("ln -sfn " + shellQuote(mount) + " " + shellQuote("/workspace/" + p.name) + " 2>/dev/null || true");
  }
  return lines.join("\n") + "\n";
}

/**
 * The /src seed script: skip when the container already carries this exact
 * snapshot (the stamp guard, same discipline as the CheerpX seed — a warm
 * container reused across sends must not re-extract 11 MB), else extract the
 * archive arriving on stdin and stamp it LAST so an interrupted extraction
 * re-runs next time.
 * @param {string} stamp
 * @returns {string}
 */
export function sourceSeedScript(stamp) {
  return [
    'if [ "$(cat /src/.dr-stamp 2>/dev/null)" = ' + shellQuote(stamp) + " ]; then",
    "cat > /dev/null",
    'printf "cached"',
    "else",
    "rm -rf /src && mkdir -p /src",
    "tar -xf - -C /src --no-same-owner",
    "printf '%s' " + shellQuote(stamp) + " > /src/.dr-stamp",
    'printf "seeded"',
    "fi",
    "mkdir -p /workspace 2>/dev/null || true",
    "ln -sfn /src /workspace/source 2>/dev/null || true",
  ].join("\n") + "\n";
}

/**
 * The extraction script for a client-pushed mount archive. GNU tar strips a
 * leading `/` and refuses `..` members by default, so a hand-crafted archive
 * cannot escape the tree — and the tree is the caller's own throwaway
 * container either way.
 * @returns {string}
 */
export function mountExtractScript() {
  return "mkdir -p /workspace && tar -xf - -C / --no-same-owner\n";
}

/** Single-quote a path for `bash -lc`. @param {string} s @returns {string} */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build the /src archive for a source snapshot, reusing the SAME plan the
 * CheerpX mount uses (public/js/sandbox-files.js planSourceMount) so both
 * environments apply one path-safety policy, one byte budget and one content
 * stamp. Returns null when the snapshot yields nothing mountable.
 * @param {{files?: Array<{p: string, s?: number, t: string}>}|null} snapshot
 * @returns {{tar: Uint8Array, stamp: string, count: number, bytes: number} | null}
 */
export function planSourceArchive(snapshot) {
  const plan = planSourceMount(snapshot?.files || []);
  if (!plan) return null;
  return { tar: plan.tar, stamp: plan.stamp, count: plan.count, bytes: plan.bytes };
}

/**
 * A one-file tar, used by the tests and by any caller that needs to push a
 * single blob into a container without assembling a plan.
 * @param {string} path @param {Uint8Array} bytes
 */
export function singleFileTar(path, bytes) {
  return buildTar([{ path, bytes }]);
}

// ---- the HTTP surface ------------------------------------------------------

/**
 * `/api/exec/*` — the DREE/1 endpoints, behind the identity gate (src/index.js
 * routeApi). Fail-soft throughout: every failure is a JSON body the client
 * already knows how to read (a non-zero exitCode, or a health body that says
 * `ok:false`), never a thrown error that breaks a send.
 *
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleExecApi(request, env, url, log, identity) {
  const route = url.pathname.replace(/^\/api\/exec\/?/, "").replace(/\/+$/, "");

  // /healthz answers even when unavailable — "Test connection" must be able to
  // report WHY, and the settings UI decides what to show from this body.
  if (route === "healthz") {
    const configured = execContainerConfigured(env);
    const allowed = configured && bashLiteEnabled(env, identity);
    if (!allowed) {
      const body = configured
        ? {
            ok: false,
            protocol: DREE_PROTOCOL,
            backend: CONTAINER_BACKEND,
            configured: true,
            error: "Turn the execution sandbox on in Settings to run commands here.",
          }
        : healthBody({ configured: false });
      return jsonResponse(body, 200);
    }
    return jsonResponse(healthBody({ configured: true, instanceType: instanceTypeOf(env) }), 200);
  }

  if (!execContainerAvailable(env, identity)) {
    return jsonResponse(
      {
        error: execContainerConfigured(env)
          ? "The execution sandbox is not enabled."
          : "Server-side execution is not configured on this deploy.",
        exitCode: 1,
        stdout: "",
        stderr: "server-side execution unavailable",
      },
      execContainerConfigured(env) ? 403 : 503,
    );
  }

  const userId = String(identity?.id || "anon");

  if (route === "exec" && request.method === "POST") {
    /** @type {any} */
    let body = null;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Expected a JSON body." }, 400);
    }
    const parsed = parseExecBody(body);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
    const started = Date.now();
    const resp = await callContainer(env, userId, parsed.session, "/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: parsed.command,
        timeoutMs: parsed.timeoutMs,
        maxStdoutBytes: parsed.maxStdoutBytes,
      }),
    });
    const out = await readJson(resp);
    log.info("exec.container_command", {
      user_id: userId,
      ok: resp.ok,
      exit_code: out?.exitCode ?? null,
      duration_ms: Date.now() - started,
      chars: (out?.stdout?.length || 0) + (out?.stderr?.length || 0),
    });
    return jsonResponse(out ?? execFailure("the container returned no result"), 200);
  }

  // The MOUNT bridge: a ustar archive of this send's attachments, project files
  // and manifest, extracted at / in the session's container. Streamed straight
  // through to the container's stdin — the Worker never buffers it.
  if (route === "mount" && request.method === "POST") {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_MOUNT_BYTES) {
      return jsonResponse({ error: "That mount is too large.", ok: false }, 413);
    }
    if (!request.body) return jsonResponse({ error: "Expected a tar body.", ok: false }, 400);
    const session = sanitizeSession(url.searchParams.get("session"));
    const resp = await callContainer(env, userId, session, "/mount", {
      method: "POST",
      headers: { "content-type": "application/x-tar" },
      body: request.body,
    });
    const out = await readJson(resp);
    log.info("exec.container_mount", { user_id: userId, ok: !!out?.ok, bytes: declared });
    return jsonResponse(out ?? { ok: false, error: "mount failed" }, 200);
  }

  // The SOURCE mount (developer mode): this deploy's own source snapshot,
  // seeded server-side. The snapshot is an ASSET of this deploy, so the tree
  // that lands at /src is by construction the source this Worker is running —
  // the same guarantee introspection makes — and the ~11 MB never crosses the
  // browser. sdk/ is part of the snapshot, so /src/sdk is the SDK mount.
  if (route === "source" && request.method === "POST") {
    const session = sanitizeSession(url.searchParams.get("session"));
    const resp = await callContainer(env, userId, session, "/source", { method: "POST" });
    const out = await readJson(resp);
    log.info("exec.container_source", {
      user_id: userId,
      ok: !!out?.ok,
      files: out?.count ?? null,
      bytes: out?.bytes ?? null,
      cached: !!out?.cached,
    });
    return jsonResponse(out ?? { ok: false, error: "source mount failed" }, 200);
  }

  // Ephemeral by contract: the client asks for the machine to go away when a
  // conversation is done. The idle alarm does it anyway — this is the polite
  // path, and it is what makes "destroyed when you are finished" true rather
  // than eventual.
  if (route === "session" && request.method === "DELETE") {
    const session = sanitizeSession(url.searchParams.get("session"));
    const resp = await callContainer(env, userId, session, "/reset", { method: "POST" });
    const out = await readJson(resp);
    return jsonResponse(out ?? { ok: false }, 200);
  }

  return jsonResponse({ error: "Unknown execution endpoint." }, 404);
}

/**
 * The configured instance type, for the health body's status line.
 * @param {Env} env
 */
function instanceTypeOf(env) {
  return String(/** @type {any} */ (env)?.EXEC_INSTANCE_TYPE || "");
}

/**
 * Route one call into the session's Durable Object. The DO name binds the
 * container to (user, session): a client cannot address another account's
 * machine, because the user half is ours.
 * @param {Env} env @param {string} userId @param {string} session
 * @param {string} path @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function callContainer(env, userId, session, path, init) {
  const ns = /** @type {any} */ (env).EXEC_SANDBOX;
  const id = ns.idFromName(containerName(userId, session));
  const stub = ns.get(id);
  try {
    return await stub.fetch("https://container.invalid" + path, init);
  } catch (err) {
    return jsonResponse(execFailure(String(/** @type {any} */ (err)?.message || err)), 200);
  }
}

/** @param {Response} resp */
async function readJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * A DREE/1-shaped failure: a failed command, never a thrown request.
 * @param {unknown} message
 */
function execFailure(message) {
  return { exitCode: 1, stdout: "", stderr: "container unavailable: " + String(message).slice(0, 300), ok: false };
}

// ---- the Durable Object ----------------------------------------------------
//
// One instance per (user, session) — one container. Written as a PLAIN class
// (the classic Durable Object shape) rather than `extends DurableObject` from
// "cloudflare:workers", so this module stays importable by `node --test` and
// its helpers stay unit-testable without a Workers runtime.

export class ExecSandbox {
  /**
   * @param {any} state the DurableObjectState — `state.container` is this
   *   instance's container (present only because wrangler.toml lists this class
   *   under `[[containers]]`)
   * @param {any} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** Wall-clock when this session's container was first started. */
    this.startedAt = 0;
    /** Commands run in this session — the per-session budget. */
    this.commands = 0;
    // The budget must survive the Durable Object being evicted from memory
    // while its container keeps running, so it is read back from storage before
    // the first request is served. Optional-chained so a test double (or a
    // storage-less environment) simply starts from zero.
    try {
      state?.blockConcurrencyWhile?.(async () => {
        this.commands = Number(await state.storage?.get?.("commands")) || 0;
        this.startedAt = Number(await state.storage?.get?.("startedAt")) || 0;
      });
    } catch {
      /* no storage — the per-session budget then lasts one isolate */
    }
  }

  /** @param {Request} request */
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/exec") return await this.handleExec(request);
      if (path === "/mount") return await this.handleMount(request);
      if (path === "/source") return await this.handleSource();
      if (path === "/reset") return await this.handleReset();
      return jsonResponse({ error: "not found" }, 404);
    } catch (err) {
      // A container that cannot start or has died must read as a FAILED COMMAND
      // to the agent loop, not as an exception — invariant 2, all the way down.
      return jsonResponse(execFailure(String(/** @type {any} */ (err)?.message || err)), 200);
    }
  }

  /** The container binding — absent when the class is not container-enabled. */
  get container() {
    return this.state?.container || null;
  }

  /**
   * Start the container if it isn't running, and don't return until it will
   * accept a process. `start()` does not block until ready, and `exec()` throws
   * while it isn't, so readiness is probed by trying the cheapest possible
   * process until it works or START_WAIT_MS elapses.
   */
  async ensureRunning() {
    const c = this.container;
    if (!c) throw new Error("this Worker has no container binding");
    if (this.startedAt && Date.now() - this.startedAt > MAX_SESSION_MS) {
      // Old enough that "ephemeral" should mean something: recycle it.
      await this.destroy("session lifetime reached");
    }
    if (!c.running) {
      c.start({
        entrypoint: CONTAINER_ENTRYPOINT,
        // No network, matching the in-browser VM. The toolchain is baked into
        // the image precisely so a research shell never needs to reach out.
        enableInternet: false,
        env: { HOME: "/root", TERM: "dumb", DR_EXEC: "cloudflare-container" },
      });
      this.startedAt = Date.now();
      this.commands = 0;
      await this.persist();
    }
    const deadline = Date.now() + START_WAIT_MS;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const probe = await c.exec(["true"], { stdout: "ignore", stderr: "ignore" });
        await probe.exitCode;
        await this.armIdleAlarm();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(250);
      }
    }
    throw new Error("container did not become ready: " + String(/** @type {any} */ (lastErr)?.message || lastErr));
  }

  /**
   * Run one command. Returns the DREE/1 body — including on timeout (exit 124,
   * the same code the CheerpX bridge and the local runner report) and including
   * when the session's command budget is spent.
   * @param {Request} request
   */
  async handleExec(request) {
    /** @type {any} */
    const body = await request.json().catch(() => null);
    const parsed = parseExecBody(body);
    if (!parsed.ok) return jsonResponse({ exitCode: 1, stdout: "", stderr: parsed.error }, 200);
    if (this.commands >= MAX_SESSION_COMMANDS) {
      return jsonResponse(
        { exitCode: 1, stdout: "", stderr: "this session's command budget is spent — start a new chat" },
        200,
      );
    }
    await this.ensureRunning();
    this.commands += 1;
    await this.persist();
    const result = await this.runCommand(parsed.command, parsed.timeoutMs, parsed.maxStdoutBytes);
    await this.armIdleAlarm();
    return jsonResponse(result, 200);
  }

  /**
   * One process, bounded. `container.exec` has no timeout of its own, so the
   * deadline is ours: race the buffered output against a timer, and on expiry
   * SIGKILL the process and give the same (single) output promise a short grace
   * to settle, so a timed-out command still returns whatever it printed.
   * @param {string} command @param {number} timeoutMs @param {number} maxStdoutBytes
   */
  async runCommand(command, timeoutMs, maxStdoutBytes) {
    const c = this.container;
    const proc = await c.exec(shellArgv(command), {
      stdout: "pipe",
      stderr: "pipe",
      cwd: "/workspace",
    });
    const output = proc.output().then(
      (/** @type {any} */ o) => o,
      (/** @type {any} */ err) => ({ err }),
    );
    const bound = deadline(timeoutMs);
    let settled = await Promise.race([output, bound.promise]);
    bound.cancel();
    if (settled === TIMED_OUT) {
      try {
        proc.kill(9);
      } catch {
        /* already gone */
      }
      // A killed process's output promise settles shortly after; give it that
      // grace so a timed-out command still returns what it printed.
      const grace = deadline(2_000);
      settled = await Promise.race([output, grace.promise]);
      grace.cancel();
      const partial = settled === TIMED_OUT ? null : settled;
      const out = decodeOutput(partial?.stdout, maxStdoutBytes);
      const errOut = decodeOutput(partial?.stderr, 8 * 1024);
      return {
        exitCode: 124,
        stdout: out.text,
        stderr: (errOut.text ? errOut.text + "\n" : "") + "command timed out after " + Math.round(timeoutMs / 1000) + "s",
        ...(out.truncated ? { truncated: true } : {}),
      };
    }
    if (settled?.err) {
      return { exitCode: 1, stdout: "", stderr: "command failed to run: " + String(settled.err?.message || settled.err) };
    }
    const out = decodeOutput(settled.stdout, maxStdoutBytes);
    const errOut = decodeOutput(settled.stderr, 64 * 1024);
    const code = Number(settled.exitCode);
    return {
      exitCode: Number.isFinite(code) ? code : 1,
      stdout: out.text,
      stderr: errOut.text,
      ...(out.truncated || errOut.truncated ? { truncated: true } : {}),
    };
  }

  /**
   * Extract a pushed ustar archive at /. The body streams from the browser
   * through the Worker into `tar`'s stdin — nothing is buffered on the way.
   * @param {Request} request
   */
  async handleMount(request) {
    await this.ensureRunning();
    const c = this.container;
    const proc = await c.exec(shellArgv(mountExtractScript()), {
      stdin: request.body || undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const bound = deadline(60_000);
    const res = await Promise.race([proc.output(), bound.promise]);
    bound.cancel();
    if (res === TIMED_OUT) {
      try {
        proc.kill(9);
      } catch {
        /* already gone */
      }
      return jsonResponse({ ok: false, error: "mount timed out" }, 200);
    }
    const code = Number(res.exitCode);
    const stderr = decodeOutput(res.stderr, 4 * 1024).text;
    await this.armIdleAlarm();
    return jsonResponse(code === 0 ? { ok: true } : { ok: false, error: stderr || "tar exited " + code }, 200);
  }

  /**
   * Seed /src (which includes sdk/) from THIS deploy's committed source
   * snapshot, read through the ASSETS binding — so the tree in the container is
   * the source this Worker runs, exactly as introspection promises. Guarded by
   * the content stamp, so a warm container reused across sends pays nothing.
   */
  async handleSource() {
    const assets = /** @type {any} */ (this.env)?.ASSETS;
    if (!assets?.fetch) return jsonResponse({ ok: false, error: "no ASSETS binding" }, 200);
    const resp = await assets.fetch(new Request("https://assets.invalid/introspect/source-snapshot.json"));
    if (!resp?.ok) return jsonResponse({ ok: false, error: "source snapshot unavailable" }, 200);
    const snapshot = await resp.json().catch(() => null);
    const plan = planSourceArchive(snapshot);
    if (!plan) return jsonResponse({ ok: false, error: "source snapshot is empty" }, 200);
    await this.ensureRunning();
    const c = this.container;
    // Ask the CONTAINER what it already carries rather than remembering it here:
    // the Durable Object can be evicted from memory while its container keeps
    // running, and re-streaming 11 MB into a `cat > /dev/null` would be the
    // whole cost of the mount for none of the benefit.
    const current = await this.runCommand("cat /src/.dr-stamp 2>/dev/null", 10_000, 256);
    if (current.stdout.trim() === plan.stamp) {
      await this.armIdleAlarm();
      return jsonResponse({ ok: true, cached: true, count: plan.count, bytes: plan.bytes }, 200);
    }
    const proc = await c.exec(shellArgv(sourceSeedScript(plan.stamp)), {
      stdin: streamOf(plan.tar),
      stdout: "pipe",
      stderr: "pipe",
    });
    const bound = deadline(120_000);
    const res = await Promise.race([proc.output(), bound.promise]);
    bound.cancel();
    if (res === TIMED_OUT) {
      try {
        proc.kill(9);
      } catch {
        /* already gone */
      }
      return jsonResponse({ ok: false, error: "source mount timed out" }, 200);
    }
    const code = Number(res.exitCode);
    if (code !== 0) {
      return jsonResponse({ ok: false, error: decodeOutput(res.stderr, 4 * 1024).text || "tar exited " + code }, 200);
    }
    await this.armIdleAlarm();
    return jsonResponse({ ok: true, cached: false, count: plan.count, bytes: plan.bytes }, 200);
  }

  /** Write the per-session budget through, so an eviction doesn't reset it. */
  async persist() {
    try {
      await this.state.storage?.put?.({ commands: this.commands, startedAt: this.startedAt });
    } catch {
      /* storage-less environment — the budget lasts this isolate */
    }
  }

  /** Destroy this session's container now. */
  async handleReset() {
    await this.destroy("client asked");
    return jsonResponse({ ok: true }, 200);
  }

  /** @param {string} why */
  async destroy(why) {
    const c = this.container;
    this.startedAt = 0;
    this.commands = 0;
    await this.persist();
    if (!c) return;
    try {
      await c.destroy(why);
    } catch {
      /* already gone — nothing to do */
    }
  }

  /**
   * Ephemerality, enforced: every touch pushes the reaping alarm out, so a
   * container outlives its conversation by at most IDLE_DESTROY_MS.
   */
  async armIdleAlarm() {
    try {
      await this.state.storage?.setAlarm?.(Date.now() + IDLE_DESTROY_MS);
    } catch {
      /* an alarm-less environment (or a test double) just skips the reaper */
    }
  }

  /** The reaper. */
  async alarm() {
    await this.destroy("idle");
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A CANCELLABLE deadline. Every bounded wait below races a real promise against
 * one of these and then cancels it — an uncancelled timer keeps the isolate's
 * event loop alive for its full duration, which on a 120 s source-mount bound
 * means every request holding the Durable Object awake long after it answered
 * (and, in `node --test`, a two-minute hang at the end of the suite).
 * @param {number} ms
 * @returns {{promise: Promise<symbol>, cancel: () => void}}
 */
function deadline(ms) {
  /** @type {any} */
  let id = null;
  const promise = new Promise((resolve) => {
    id = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return {
    promise,
    cancel: () => {
      if (id !== null) clearTimeout(id);
      id = null;
    },
  };
}

/** The sentinel a lost race resolves to. */
const TIMED_OUT = Symbol("timed-out");

/**
 * A one-shot ReadableStream over a byte array — how a built tar reaches a
 * process's stdin.
 * @param {Uint8Array} bytes
 */
export function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
