// @ts-check
// SHARED pure core for the pluggable EXECUTION ENVIRONMENT — the "bring your
// own machine" seam, the sibling of websearch-backends-core.js (bring your own
// search) and ondevice-core.js (bring your own model). Used by BOTH tiers:
//   - Se/cure (DRC): public/cure/drc.js configures it per-user inside the
//     sealed project state; drc-research.js swaps the runner into the shell
//     pass. The call is browser→localhost — the server is in no data path.
//   - Se/rver (DRS): public/js/exec-env.js owns the browser-local config and
//     the Settings section; stream.js swaps the runner into runSandboxPass.
//
// It lives under public/ (like bash-core.js / websearch-backends-core.js)
// because the browser can only import modules the Worker serves, while the
// Worker's bundler can import from any repo path — so both tiers reach the
// SAME single source of truth.
//
// WHY THIS EXISTS. The only execution environment we shipped was the in-browser
// CheerpX Linux VM: private by construction, but emulated x86 (slow), pinned to
// one disk image, and unable to reach the machine the user is actually sitting
// at. The model choice already offers on-device vs. cloud; the execution choice
// should offer the same spread. This core adds ONE alternative shape — an HTTP
// runner the user starts on their own machine, which hands each session an
// ephemeral container/micro-VM — and keeps the browser VM as the default, so
// doing nothing changes nothing.
//
// ---- the wire: DREE/1 -------------------------------------------------------
//
// Any service that speaks these two endpoints is a valid execution environment.
// The reference implementation is public/cure/local-exec/runner.mjs (a single
// dependency-free Node file, `node runner.mjs`), but the contract is the
// standard — a Docker image, a Firecracker pool, a remote build box, or a
// corporate CI runner can all implement it.
//
//   GET  {base}/healthz
//     → 200 {ok:true, protocol:"dree/1", backend:"docker", image:"debian:…",
//            ephemeral:true, version:"1"}
//
//   POST {base}/exec        headers: content-type: application/json
//                                    x-api-key: <key>   (optional)
//     body {command, session?, timeoutMs?, maxStdoutBytes?}
//     → 200 {exitCode:0, stdout:"…", stderr:"…", truncated?:boolean}
//
// `session` groups commands into ONE machine so an agent loop keeps its working
// directory, its installed packages and its files across rounds. Omitting it is
// legal (every command then gets a fresh machine); this core always sends one.
//
// FAIL-SOFT, like every helper phase (invariant 2): an unreachable or
// misconfigured runner never throws into the pipeline. `supported()` goes false
// and the shell pass is simply skipped, or a single command comes back with a
// non-zero exitCode and an explanatory stderr, exactly as the browser VM does.
//
// CORS + mixed content (the browser-direct reality, same as the local search
// agent): the runner must send `Access-Control-Allow-Origin` and answer Chrome's
// private-network preflight. Chrome and Firefox treat `http://localhost` as a
// secure context, so an HTTPS page may call it; Safari does not and blocks it.
// The setup page (/cure/local-exec/) spells this out and offers the workarounds.

/** @typedef {{ exitCode: number, stdout: string, stderr: string, truncated?: boolean }} ExecResult */
/** @typedef {{ supported: () => boolean, boot: (fileProvider?: any, onMessage?: any) => Promise<boolean>, exec: (command: string, opts?: any) => Promise<ExecResult> }} Runner */

/** The protocol name a conforming runner reports from /healthz. */
export const DREE_PROTOCOL = "dree/1";

/** Bound the health probe hard — a hung runner must not stall a send. */
export const HEALTH_TIMEOUT_MS = 4_000;

/**
 * Ceiling for one remote command. Deliberately far above the browser VM's 30 s
 * (public/js/bash-core.js EXEC_TIMEOUT_MS): native execution is orders of
 * magnitude faster per instruction, so a command that runs this long is doing
 * real work (a build, a package install) rather than wedged, and killing it at
 * the emulator's ceiling would waste the whole point of the local runner.
 */
export const REMOTE_EXEC_TIMEOUT_MS = 120_000;
/** Floor for a caller-supplied per-command override (see execTimeoutForBudget). */
export const MIN_REMOTE_EXEC_TIMEOUT_MS = 5_000;

/** The default port the reference runner binds — matches runner.mjs's PORT. */
export const DEFAULT_RUNNER_PORT = 8100;
/** The default base URL the settings UI pre-fills. */
export const DEFAULT_RUNNER_URL = "http://localhost:" + DEFAULT_RUNNER_PORT;

/**
 * The execution environments a user can pick. `browser` is the default and the
 * only one that needs no setup; `local` is the DREE/1 runner on their machine.
 * Kept as data (not a switch) so the settings UI in both tiers renders from one
 * list and a third environment is a row here, not an edit in four files.
 */
export const EXEC_BACKENDS = [
  {
    id: "browser",
    label: "In-browser Linux VM",
    short: "In-browser",
    needsUrl: false,
    /** One line under the picker — what picking this actually means. */
    note: "Boots a real Linux inside this browser (CheerpX). Nothing leaves the device; emulated, so it is slow to start and slow to run.",
  },
  {
    id: "local",
    label: "Local runner — your machine",
    short: "Local runner",
    needsUrl: true,
    note: "Runs commands in a throwaway container on your own machine, at native speed, through a small service you start on localhost.",
  },
];

/** @param {string} id @returns {{id: string, label: string, short: string, needsUrl: boolean, note: string} | null} */
export function execBackend(id) {
  return EXEC_BACKENDS.find((b) => b.id === id) || null;
}

/**
 * Normalize a raw (sealed-state, localStorage or form-derived) execution
 * environment config into the shape the runner factory and both settings UIs
 * use. Mirrors normalizeSearchBackend in drc-page-core.js: an unknown backend
 * falls back to the safe default ("browser" — the tier's original behavior), the
 * base URL loses its trailing slashes, and the key is trimmed.
 * @param {{backend?: string, baseUrl?: string, key?: string}|null|undefined} cfg
 * @returns {{backend: string, baseUrl: string, key: string}}
 */
export function normalizeExecBackend(cfg) {
  cfg = cfg || {};
  const known = EXEC_BACKENDS.some((b) => b.id === cfg.backend);
  return {
    backend: known ? String(cfg.backend) : "browser",
    baseUrl: String(cfg.baseUrl || "").trim().replace(/\/+$/, ""),
    key: String(cfg.key || "").trim(),
  };
}

/**
 * Whether a normalized config actually selects a REMOTE runner — i.e. the user
 * picked one AND gave it an address. A half-configured "local" (no URL) is not
 * an error: it simply means the browser VM still runs, so nothing breaks while
 * someone is mid-way through filling the form in.
 * @param {{backend: string, baseUrl: string}} cfg
 * @returns {boolean}
 */
export function usesLocalRunner(cfg) {
  return !!cfg && cfg.backend === "local" && !!cfg.baseUrl;
}

/**
 * Clamp a caller's per-command ceiling into the remote runner's range. The
 * research-budget scoping stream.js and drc-research.js already do for the
 * browser VM (bash-core's execTimeoutForBudget) produces emulator-scale
 * numbers; a native runner should not be held to them, so the FLOOR applies but
 * the browser ceiling does not.
 * @param {number|undefined} requested
 * @returns {number}
 */
export function remoteExecTimeout(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return REMOTE_EXEC_TIMEOUT_MS;
  return Math.max(MIN_REMOTE_EXEC_TIMEOUT_MS, Math.min(REMOTE_EXEC_TIMEOUT_MS, Math.round(n)));
}

/**
 * Parse a /healthz body into the facts the UI reports. Pure — the fetch shell
 * is probeRunner below. A body that does not name the protocol is still
 * accepted when it says ok, so a minimal third-party implementation isn't
 * locked out for missing one field; `protocol` then reads as unknown.
 * @param {any} data
 * @returns {{ok: boolean, protocol: string, backend: string, image: string, ephemeral: boolean, network: string, version: string}}
 */
export function parseHealth(data) {
  return {
    ok: data?.ok === true,
    protocol: String(data?.protocol || ""),
    backend: String(data?.backend || ""),
    image: String(data?.image || ""),
    ephemeral: data?.ephemeral !== false,
    // "none" (the reference runner's default), "bridge"/"host" when the user
    // deliberately opened it, "" when a third-party runner doesn't say. Shown
    // in the status line: whether the machine running your commands can reach
    // the internet is exactly the kind of fact this project writes down rather
    // than leaves to be assumed.
    network: String(data?.network || ""),
    version: String(data?.version || ""),
  };
}

/**
 * Parse an /exec body into the SAME shape execInSandbox returns, so every
 * consumer (bash-core's loop, the transcript renderer, the deliverables export)
 * is byte-for-byte indifferent to which environment ran the command. A missing
 * or malformed body is a failed command, not a thrown error.
 * @param {any} data
 * @returns {ExecResult}
 */
export function parseExecResponse(data) {
  if (!data || typeof data !== "object") {
    return { exitCode: 1, stdout: "", stderr: "runner returned no result" };
  }
  const code = Number(data.exitCode);
  const out = {
    exitCode: Number.isFinite(code) ? code : 1,
    stdout: typeof data.stdout === "string" ? data.stdout : "",
    stderr: typeof data.stderr === "string" ? data.stderr : "",
  };
  if (data.truncated === true) return { ...out, truncated: true };
  return out;
}

/** A session id groups an agent loop's commands into one machine. */
export function newExecSession() {
  return "dr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/**
 * Probe a runner's /healthz. Never throws: an unreachable, slow, non-2xx or
 * non-JSON runner resolves to `{reachable:false, …}` with a human-readable
 * `error` the settings UI shows verbatim. Used by the "Test connection" button
 * in both tiers AND by the runner's own supported() gate.
 * @param {{baseUrl: string, key: string}} cfg
 * @param {{fetch?: typeof fetch, timeoutMs?: number}} [deps]
 * @returns {Promise<{reachable: boolean, error: string, health: ReturnType<typeof parseHealth>|null}>}
 */
export async function probeRunner(cfg, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const fail = (/** @type {string} */ error) => ({ reachable: false, error, health: null });
  if (!cfg?.baseUrl) return fail("No runner URL configured.");
  if (typeof doFetch !== "function") return fail("This browser cannot make the request.");
  let resp;
  try {
    resp = await doFetch(cfg.baseUrl + "/healthz", {
      headers: cfg.key ? { "x-api-key": cfg.key } : {},
      signal: AbortSignal.timeout(deps.timeoutMs || HEALTH_TIMEOUT_MS),
    });
  } catch (err) {
    // The overwhelmingly common causes, in order: the service isn't running,
    // it doesn't send CORS headers, or Safari blocked the http://localhost
    // call as mixed content. A bare "Failed to fetch" tells the user none of
    // that, so name all three — the setup page covers each.
    const msg = String(/** @type {any} */ (err)?.message || err);
    return fail(
      "Could not reach " + cfg.baseUrl + " (" + msg + "). Check that the runner is running, " +
        "that it allows this origin (CORS), and — on Safari — that you opened the site over http:// or used a tunnel.",
    );
  }
  if (!resp.ok) {
    return fail(
      resp.status === 401 || resp.status === 403
        ? "The runner rejected the key (HTTP " + resp.status + ")."
        : "The runner answered HTTP " + resp.status + ".",
    );
  }
  const data = await resp.json().catch(() => null);
  const health = parseHealth(data);
  if (!health.ok) return fail("The runner answered, but not with a DREE/1 health body.");
  return { reachable: true, error: "", health };
}

/**
 * A one-line human summary of a probe — shared by both tiers' status lines so
 * the same runner reads identically on /cure and in the account panel.
 * @param {{reachable: boolean, error: string, health: ReturnType<typeof parseHealth>|null}} probe
 * @returns {string}
 */
export function runnerStatusLine(probe) {
  if (!probe?.reachable || !probe.health) return probe?.error || "Not connected.";
  const h = probe.health;
  const where = h.backend ? " via " + h.backend : "";
  const what = h.image ? " (" + h.image + ")" : "";
  const life = h.ephemeral ? " Each research session gets a throwaway machine." : " Machines are reused between sessions.";
  const net =
    h.network === "none"
      ? " It has no network access."
      : h.network
        ? " It CAN reach the network (" + h.network + ")."
        : "";
  return "Connected" + where + what + "." + life + net;
}

/**
 * Build a Runner over a DREE/1 service — the drop-in replacement for the
 * public/js/sandbox.js trio (`sandboxSupported` / `ensureSandboxBooted` /
 * `execInSandbox`) that stream.js and drc-research.js already inject.
 *
 * `boot()` is the health probe: it is what turns "the user typed a URL" into
 * "there is really a machine there", and it caches the verdict for the life of
 * this runner so an agent loop pays one round-trip, not one per command. It
 * resolves FALSE rather than throwing when the runner is unreachable, so the
 * caller's existing "sandbox unavailable — answering normally" path handles it
 * with no new branch.
 *
 * `supported()` is optimistic BEFORE the first boot (we cannot know without a
 * network call, and returning false would skip the shell pass without ever
 * probing) and honest after it.
 *
 * @param {{backend: string, baseUrl: string, key: string}} cfg normalized
 * @param {{fetch?: typeof fetch, session?: string, onLog?: (event: string, fields: any) => void}} [deps]
 * @returns {Runner}
 */
export function makeLocalRunner(cfg, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const session = deps.session || newExecSession();
  const log = (/** @type {string} */ event, /** @type {any} */ fields) => {
    try {
      deps.onLog?.(event, fields);
    } catch {
      /* logging is decoration — never let it break a command */
    }
  };
  /** @type {boolean|null} null = not probed yet */
  let healthy = null;

  return {
    supported: () => !!cfg.baseUrl && healthy !== false,
    boot: async () => {
      if (healthy !== null) return healthy;
      const probe = await probeRunner(cfg, { fetch: doFetch });
      healthy = probe.reachable;
      log(healthy ? "exec.runner_ready" : "exec.runner_unreachable", {
        backend: probe.health?.backend || "",
        error: probe.error.slice(0, 200),
      });
      return healthy;
    },
    exec: async (command, opts = {}) => {
      const timeoutMs = remoteExecTimeout(opts?.timeoutMs);
      /** @type {Record<string, string>} */
      const headers = { "content-type": "application/json" };
      if (cfg.key) headers["x-api-key"] = cfg.key;
      let resp;
      try {
        resp = await doFetch(cfg.baseUrl + "/exec", {
          method: "POST",
          headers,
          body: JSON.stringify({
            command: String(command),
            session,
            timeoutMs,
            maxStdoutBytes: Number(opts?.maxStdoutBytes) > 0 ? Math.round(Number(opts.maxStdoutBytes)) : undefined,
          }),
          // Give the transport a little more room than the command itself, so a
          // runner that honours the ceiling gets to report its own timeout (with
          // whatever output the command produced) instead of us aborting blind.
          signal: AbortSignal.timeout(timeoutMs + 5_000),
        });
      } catch (err) {
        // One failed command must not condemn the runner: a single long
        // command hitting the transport ceiling is not the same as the service
        // being gone, and marking it unhealthy here would silently drop the
        // rest of the loop. The next boot() (next send) re-probes anyway.
        const msg = String(/** @type {any} */ (err)?.message || err);
        log("exec.runner_request_failed", { error: msg.slice(0, 200) });
        return { exitCode: 124, stdout: "", stderr: "local runner unreachable: " + msg };
      }
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        log("exec.runner_error", { status: resp.status });
        return { exitCode: 1, stdout: "", stderr: "runner error HTTP " + resp.status + " " + detail.slice(0, 200) };
      }
      const data = await resp.json().catch(() => null);
      return parseExecResponse(data);
    },
  };
}

/**
 * The single decision point both tiers call: given the user's config and the
 * tier's own browser-VM bridge, return the Runner the shell pass should use.
 * Returns the browser bridge UNCHANGED whenever the user has not fully
 * configured a local runner — so the default path keeps its exact prior
 * behavior, mounts and all, and this seam can never be the cause of a sandbox
 * regression for the 99% who never open the setting.
 *
 * @param {{backend?: string, baseUrl?: string, key?: string}|null|undefined} rawCfg
 * @param {Runner} browserRunner the tier's sandbox.js trio
 * @param {{fetch?: typeof fetch, session?: string, onLog?: (event: string, fields: any) => void}} [deps]
 * @returns {Runner}
 */
export function selectRunner(rawCfg, browserRunner, deps = {}) {
  const cfg = normalizeExecBackend(rawCfg);
  if (!usesLocalRunner(cfg)) return browserRunner;
  return makeLocalRunner(cfg, deps);
}
