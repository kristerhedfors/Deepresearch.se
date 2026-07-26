#!/usr/bin/env node
// DeepResearch — LOCAL EXECUTION RUNNER (single file, no dependencies).
//
// An execution environment that runs on YOUR machine. DeepResearch calls it
// straight from the browser (Settings → Execution environment → Local runner →
// http://localhost:8100), and each research session gets its own throwaway
// container — created on first command, destroyed when the session goes idle.
//
// It is the reference implementation of DREE/1, the wire this site's execution
// seam speaks (public/js/exec-backends-core.js). Anything answering these two
// endpoints can take its place — a Firecracker pool, a corporate CI runner, a
// remote build box.
//
// Get it + run it (Node 18+; macOS, Linux or Windows):
//   curl -fsSL https://deepresearch.se/cure/local-exec/runner.mjs -o runner.mjs && node runner.mjs
//
// Wire shape (public/js/exec-backends-core.js):
//   GET  /healthz  → {ok, protocol:"dree/1", backend, image, ephemeral, network}
//   POST /exec     {command, session?, timeoutMs?, maxStdoutBytes?}
//                  → {exitCode, stdout, stderr, truncated?}
//   POST /mount?session=<id>        → {ok:true}
//                  A ustar archive (application/x-tar) on the request body,
//                  extracted at / in that session's machine — how the page's
//                  attachments, project files and INDEX.txt get in. Optional in
//                  DREE/1, advertised as mount:true.
//   DELETE /session/<id>            → {ok:true}     (drop a machine early)
//   GET  /sessions                  → {sessions:[…]} (what is alive right now)
//
// Container backends, auto-detected in this order (BACKEND env to force one):
//   container   Apple's native container CLI (macOS 26+) — `brew install` free,
//               real per-container VMs, the lightest thing on a Mac.
//   docker      Docker Desktop / colima / Rancher / OrbStack — anywhere.
//   podman      Rootless, daemonless. `brew install podman && podman machine init`.
//   nerdctl     containerd's CLI (Rancher Desktop, Lima).
//   host        NO CONTAINER — commands run directly on this machine as you,
//               in a per-session temp directory. Opt-in only (BACKEND=host):
//               it is not a sandbox and the runner says so at every turn.
//
// Env:
//   PORT=8100  HOST=127.0.0.1  API_KEY=            (optional shared secret)
//   ALLOW_ORIGIN=*                                 (CORS; narrow it if you like)
//   IMAGE=debian:stable-slim                       (any image with /bin/sh)
//   NETWORK=none                                   (none | bridge | host)
//   MEMORY=2g  CPUS=2  PIDS=512                    (per-container limits)
//   IDLE_MINUTES=30                                (reap machines after this)
//   MOUNT=                                         (host dir → /mnt in the box)
//
// PRIVACY / SAFETY POSTURE, stated rather than assumed:
//   - Binds 127.0.0.1 by default: nothing off this machine can reach it.
//   - NETWORK=none by default: the container cannot reach the internet, your
//     LAN, or this runner. Set NETWORK=bridge when you want `apt-get`/`pip`,
//     and know that you are handing an LLM-driven loop an outbound socket.
//   - Ephemeral by default: a session's container is destroyed on idle, on
//     DELETE, and on Ctrl-C. Nothing persists unless you pass MOUNT.
//   - No command, output or session id is written to disk. The console log
//     shows commands so YOU can watch what the agent is doing.
//   - `host` mode has none of the above isolation and prints a warning banner.

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const VERSION = "1";
const PROTOCOL = "dree/1";

const PORT = Number(process.env.PORT || 8100);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || "";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const IMAGE = process.env.IMAGE || "debian:stable-slim";
const NETWORK = (process.env.NETWORK || "none").toLowerCase();
const MEMORY = process.env.MEMORY || "2g";
const CPUS = process.env.CPUS || "2";
const PIDS = process.env.PIDS || "512";
const MOUNT = process.env.MOUNT || "";
const IDLE_MS = Math.max(1, Number(process.env.IDLE_MINUTES) || 30) * 60_000;

// Ceilings the caller cannot exceed, whatever it asks for.
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_COMMAND_CHARS = 100_000;
const MAX_BODY_BYTES = 1 << 20;
// What we keep of a command's output when the caller sets no cap. The browser
// VM's transcript keeps far less; this is a backstop against a runaway `cat`
// filling this process's memory, not a formatting decision.
const HARD_OUTPUT_BYTES = 8 << 20;

// ---- small process helpers --------------------------------------------------

/**
 * Run a program, capture stdout/stderr, never reject. `timeoutMs` kills the
 * process group; `maxBytes` stops accumulating past a cap and reports it.
 */
function run(cmd, args, { timeoutMs = 0, maxBytes = HARD_OUTPUT_BYTES, input = "" } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ exitCode: 127, stdout: "", stderr: String(err?.message || err), truncated: false });
    }
    const out = [];
    const errOut = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timer = null;
    let timedOut = false;

    const collect = (buf, sink, isOut) => {
      const have = isOut ? outBytes : errBytes;
      if (have >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - have;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      if (slice.length < buf.length) truncated = true;
      sink.push(slice);
      if (isOut) outBytes += slice.length;
      else errBytes += slice.length;
    };

    child.stdout.on("data", (b) => collect(b, out, true));
    child.stderr.on("data", (b) => collect(b, errOut, false));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 127, stdout: "", stderr: String(err?.message || err), truncated });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        // A killed process reports no code; 124 is the conventional timeout
        // status (GNU `timeout`), which is also what the browser VM returns —
        // so the agent loop sees one vocabulary across environments.
        exitCode: timedOut ? 124 : code == null ? (signal ? 137 : 1) : code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr:
          Buffer.concat(errOut).toString("utf8") +
          (timedOut ? `\n[runner] command exceeded ${Math.round(timeoutMs / 1000)}s and was killed` : ""),
        truncated,
      });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, timeoutMs);
    }
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Is this CLI on PATH and actually working? */
async function cliWorks(cmd) {
  const probe = cmd === "container" ? ["--version"] : ["version", "--format", "{{.Client.Version}}"];
  const res = await run(cmd, probe, { timeoutMs: 8_000 });
  return res.exitCode === 0;
}

// ---- backend selection ------------------------------------------------------

const CONTAINER_BACKENDS = ["container", "docker", "podman", "nerdctl"];
let BACKEND = (process.env.BACKEND || "").toLowerCase();

async function detectBackend() {
  if (BACKEND === "host") return "host";
  if (BACKEND) {
    if (!CONTAINER_BACKENDS.includes(BACKEND)) {
      console.error(`[runner] BACKEND=${BACKEND} is not one of: ${CONTAINER_BACKENDS.join(", ")}, host`);
      process.exit(1);
    }
    if (!(await cliWorks(BACKEND))) {
      console.error(`[runner] BACKEND=${BACKEND} was requested but '${BACKEND}' is not working on this machine.`);
      process.exit(1);
    }
    return BACKEND;
  }
  for (const c of CONTAINER_BACKENDS) {
    if (await cliWorks(c)) return c;
  }
  return "";
}

/**
 * The `run` arguments for one backend. Apple's `container` accepts the Docker
 * verbs but not the whole resource-flag vocabulary, so it gets the subset it
 * actually supports rather than a flag soup that fails at spawn time.
 */
function createArgs(backend, name) {
  const common = ["run", "--detach", "--rm", "--name", name, "--workdir", "/workspace"];
  const netFlag = ["--network", NETWORK === "bridge" ? "bridge" : NETWORK === "host" ? "host" : "none"];
  const mount = MOUNT ? ["--volume", `${path.resolve(MOUNT)}:/mnt`] : [];
  // `sleep infinity` is not in every minimal image (busybox sleep rejects it),
  // so hold the container open with a portable POSIX loop instead.
  const hold = [IMAGE, "/bin/sh", "-c", "mkdir -p /workspace; while :; do sleep 3600; done"];
  if (backend === "container") {
    // Apple container: no --pids-limit; memory/cpus are named the same.
    return [...common, ...netFlag, "--memory", MEMORY, "--cpus", CPUS, ...mount, ...hold];
  }
  return [
    ...common,
    ...netFlag,
    "--memory",
    MEMORY,
    "--cpus",
    CPUS,
    "--pids-limit",
    PIDS,
    ...mount,
    ...hold,
  ];
}

// ---- sessions ---------------------------------------------------------------
//
// One session id → one machine. Created lazily on the session's first command
// (so a probe or a health check never spins anything up), kept warm for the
// whole agent loop (so `cd`, installed packages and written files survive
// between rounds — the property that makes a shell loop useful), and reaped
// once it has been idle IDLE_MINUTES.

/** @type {Map<string, {id:string, name:string, dir:string, lastUsed:number, starting:Promise<any>|null, ready:boolean}>} */
const sessions = new Map();

const safeName = (id) => "dree-" + String(id).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);

async function ensureSession(backend, id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, name: safeName(id), dir: "", lastUsed: Date.now(), starting: null, ready: false };
    sessions.set(id, s);
  }
  s.lastUsed = Date.now();
  if (s.ready) return s;
  // Concurrent first commands must share ONE creation, not race two machines.
  if (!s.starting) s.starting = startSession(backend, s);
  await s.starting;
  return s;
}

async function startSession(backend, s) {
  if (backend === "host") {
    s.dir = fs.mkdtempSync(path.join(os.tmpdir(), "dree-"));
    s.ready = true;
    console.log(`[runner] session ${s.id} → host directory ${s.dir}`);
    return;
  }
  const t0 = Date.now();
  const res = await run(backend, createArgs(backend, s.name), { timeoutMs: 180_000 });
  if (res.exitCode !== 0) {
    s.starting = null; // let the next command retry rather than wedge the session
    throw new Error(`could not start a container (${backend}): ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
  }
  s.ready = true;
  console.log(`[runner] session ${s.id} → container ${s.name} in ${Date.now() - t0} ms`);
}

async function dropSession(backend, id, why = "idle") {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  if (backend === "host") {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
    } catch {
      /* best effort — a temp dir left behind is not worth an error path */
    }
  } else if (s.ready || s.starting) {
    await run(backend, ["rm", "--force", s.name], { timeoutMs: 30_000 });
  }
  console.log(`[runner] session ${s.id} destroyed (${why})`);
  return true;
}

function startReaper(backend) {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastUsed > IDLE_MS) dropSession(backend, id, "idle").catch(() => {});
    }
  }, 60_000);
  t.unref?.();
}

// ---- exec -------------------------------------------------------------------

async function execCommand(backend, { command, session, timeoutMs, maxStdoutBytes }) {
  const cmd = String(command || "");
  if (!cmd.trim()) return { exitCode: 1, stdout: "", stderr: "empty command" };
  if (cmd.length > MAX_COMMAND_CHARS) return { exitCode: 1, stdout: "", stderr: "command too long" };
  const ms = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.round(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
  const cap = Number(maxStdoutBytes) > 0 ? Math.min(HARD_OUTPUT_BYTES, Math.round(Number(maxStdoutBytes))) : HARD_OUTPUT_BYTES;
  const id = String(session || "default");

  let s;
  try {
    s = await ensureSession(backend, id);
  } catch (err) {
    // A machine that won't start is a failed COMMAND, not a dead runner — the
    // agent loop reads the reason and can adapt (or the user fixes Docker and
    // the next command works).
    return { exitCode: 1, stdout: "", stderr: String(err?.message || err) };
  }
  s.lastUsed = Date.now();

  console.log(`[exec] ${id} $ ${cmd.replace(/\s+/g, " ").slice(0, 160)}`);
  const t0 = Date.now();
  // The command reaches /bin/sh as ARGV, never through a host shell — nothing
  // in it is interpreted by this machine's shell on the way in.
  const res =
    backend === "host"
      ? await runHost(cmd, s.dir, ms, cap)
      : await run(backend, ["exec", "--workdir", "/workspace", s.name, "/bin/sh", "-c", cmd], {
          timeoutMs: ms,
          maxBytes: cap,
        });
  console.log(`[exec] ${id} → exit ${res.exitCode} in ${Date.now() - t0} ms`);
  const out = { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  return res.truncated ? { ...out, truncated: true } : out;
}

// ---- mount ------------------------------------------------------------------
//
// DREE/1's OPTIONAL mount endpoint (advertised as `mount:true` by /healthz): the
// page streams ONE ustar archive of the send's files — this chat's attachments,
// the active project, the INDEX.txt manifest — and it is extracted at / inside
// the session's machine, so a remote environment holds what the in-browser VM
// holds (/workspace/…, /mnt/<project>-<hash>/…).
//
// Member paths in the archive are RELATIVE (`workspace/notes.pdf`), and `tar`
// refuses `..` members by default, so an archive cannot write outside the
// machine's filesystem — and that filesystem is a throwaway container either
// way. Nothing is buffered here: the request body is piped straight into `tar`.
async function mountArchive(backend, id, req) {
  let s;
  try {
    s = await ensureSession(backend, String(id || "default"));
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  s.lastUsed = Date.now();
  const script = "mkdir -p /workspace /workspace/outbox && tar -xf - -C / --no-same-owner";
  const args =
    backend === "host"
      ? null
      : [
          "exec",
          "--interactive",
          "--workdir",
          "/workspace",
          s.name,
          "/bin/sh",
          "-c",
          script,
        ];
  return await new Promise((resolve) => {
    let child;
    try {
      child =
        args === null
          ? // host mode: extract into the session's temp directory instead, so
            // "everything the page mounts" still arrives without a container.
            spawn("/bin/sh", ["-c", "mkdir -p workspace workspace/outbox && tar -xf - --no-same-owner"], {
              cwd: s.dir,
              stdio: ["pipe", "pipe", "pipe"],
            })
          : spawn(backend, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ ok: false, error: String(err?.message || err) });
    }
    const errOut = [];
    child.stderr.on("data", (b) => errOut.push(b));
    child.stdout.resume();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(err?.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(errOut).toString("utf8").trim().slice(0, 500);
      console.log(`[mount] ${s.id} → tar exit ${code}`);
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr || "tar exited " + code });
    });
    req.on("error", () => {
      try {
        child.stdin.destroy();
      } catch {
        /* the close handler reports it */
      }
    });
    req.pipe(child.stdin);
  });
}

function runHost(cmd, dir, timeoutMs, maxBytes) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/c", cmd] : ["-c", cmd];
    let child;
    try {
      child = spawn(shell, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ exitCode: 127, stdout: "", stderr: String(err?.message || err), truncated: false });
    }
    const out = [];
    const errOut = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const take = (b, sink) => {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const slice = b.length > maxBytes - bytes ? b.subarray(0, maxBytes - bytes) : b;
      if (slice.length < b.length) truncated = true;
      sink.push(slice);
      bytes += slice.length;
    };
    child.stdout.on("data", (b) => take(b, out));
    child.stderr.on("data", (b) => take(b, errOut));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout: "", stderr: String(err?.message || err), truncated });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : code == null ? (signal ? 137 : 1) : code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr:
          Buffer.concat(errOut).toString("utf8") +
          (timedOut ? `\n[runner] command exceeded ${Math.round(timeoutMs / 1000)}s and was killed` : ""),
        truncated,
      });
    });
  });
}

// ---- the HTTP server --------------------------------------------------------

const CORS = {
  "access-control-allow-origin": ALLOW_ORIGIN,
  "access-control-allow-headers": "content-type, x-api-key, authorization",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  // Chrome's Private Network Access preflight: a public HTTPS page calling
  // localhost must be answered with this or the browser refuses the request.
  "access-control-allow-private-network": "true",
};

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function authed(req) {
  if (!API_KEY) return true;
  return req.headers["x-api-key"] === API_KEY || req.headers.authorization === "Bearer " + API_KEY;
}

async function main() {
  const backend = await detectBackend();
  if (!backend) {
    console.error("");
    console.error("[runner] No container runtime found.");
    console.error("  Install ONE of these, then run this file again:");
    console.error("    macOS   brew install --cask docker      (or: brew install podman && podman machine init && podman machine start)");
    console.error("    macOS 26+  Apple's built-in `container` CLI needs no install");
    console.error("    Linux   sudo apt install podman         (or docker.io)");
    console.error("    Windows  Docker Desktop, or podman via winget");
    console.error("");
    console.error("  Or, deliberately, run WITHOUT any isolation:  BACKEND=host node runner.mjs");
    console.error("");
    process.exit(1);
  }

  if (backend === "host") {
    console.warn("");
    console.warn("  ⚠  BACKEND=host — commands run DIRECTLY on this machine, as you.");
    console.warn("     There is no container, no isolation and no resource limit. An LLM");
    console.warn("     loop gets your shell, your files and your network. Use a container");
    console.warn("     backend unless you have a specific reason not to.");
    console.warn("");
  } else {
    // Pull the image once, up front, so the FIRST command isn't a silent
    // multi-minute wait inside a research turn.
    console.log(`[runner] backend: ${backend} · image: ${IMAGE} · network: ${NETWORK}`);
    process.stdout.write("[runner] making sure the image is present… ");
    const pull = await run(backend, ["pull", IMAGE], { timeoutMs: 600_000 });
    console.log(pull.exitCode === 0 ? "ok" : "could not pre-pull (the first command will do it): " + pull.stderr.trim().slice(0, 200));
  }

  startReaper(backend);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    // /healthz stays UNAUTHENTICATED on purpose: it reports only what this
    // runner is, never what it has run, and the settings UI's "Test connection"
    // has to be able to tell "wrong key" from "not running".
    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(res, 200, {
        ok: true,
        protocol: PROTOCOL,
        version: VERSION,
        backend,
        image: backend === "host" ? "" : IMAGE,
        ephemeral: true,
        network: backend === "host" ? "host" : NETWORK,
        sessions: sessions.size,
        requiresKey: !!API_KEY,
        // DREE/1's optional capabilities: this runner takes a pushed tar of the
        // send's files (POST /mount). It does NOT seed /src from a server copy
        // of the site's source — only the platform's own container backend can
        // do that — so `source` stays absent and the page skips asking.
        mount: true,
      });
    }
    if (!authed(req)) return send(res, 403, { error: "bad or missing API key" });

    if (req.method === "GET" && url.pathname === "/sessions") {
      return send(res, 200, {
        sessions: [...sessions.values()].map((s) => ({ id: s.id, ready: s.ready, idleMs: Date.now() - s.lastUsed })),
      });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/session/")) {
      const id = decodeURIComponent(url.pathname.slice("/session/".length));
      return send(res, 200, { ok: await dropSession(backend, id, "requested") });
    }
    // The MOUNT bridge (optional in DREE/1): a ustar archive of the send's
    // files, extracted into the session's machine. Streamed, never buffered.
    if (req.method === "POST" && url.pathname === "/mount") {
      const id = url.searchParams.get("session") || "default";
      try {
        return send(res, 200, await mountArchive(backend, id, req));
      } catch (err) {
        return send(res, 200, { ok: false, error: String(err?.message || err) });
      }
    }
    if (req.method === "POST" && url.pathname === "/exec") {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return send(res, 400, { error: String(err?.message || err) });
      }
      try {
        return send(res, 200, await execCommand(backend, body));
      } catch (err) {
        // Anything unforeseen still comes back on the wire as a failed command,
        // so the agent loop never sees a hung request.
        return send(res, 200, { exitCode: 1, stdout: "", stderr: String(err?.message || err) });
      }
    }
    send(res, 404, {
      error: "not found — POST /exec, POST /mount, GET /healthz, GET /sessions, DELETE /session/<id>",
    });
  });

  const shutdown = async () => {
    console.log("\n[runner] cleaning up sessions…");
    await Promise.all([...sessions.keys()].map((id) => dropSession(backend, id, "shutdown").catch(() => {})));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(PORT, HOST, () => {
    const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log("");
    console.log(`Local execution runner listening on http://${shown}:${PORT}  (${backend})`);
    console.log("");
    console.log("Point DeepResearch at it:");
    console.log("  Settings → Execution environment → Local runner — your machine");
    console.log(`  Runner URL: http://localhost:${PORT}` + (API_KEY ? "   (plus your API key)" : ""));
    console.log("");
    console.log(`Try it:  curl -s -X POST http://localhost:${PORT}/exec -H 'content-type: application/json' -d '{"command":"uname -a"}'`);
    console.log("");
    console.log("Every command the assistant runs is printed here. Ctrl-C destroys every machine.");
  });
}

main().catch((err) => {
  console.error("[runner] fatal:", err?.message || err);
  process.exit(1);
});
