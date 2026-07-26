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
// Two OPTIONAL endpoints, each advertised by a flag in /healthz, carry the file
// MOUNTS that used to be the browser VM's alone — so a remote environment holds
// what the CheerpX sandbox holds (/workspace with this send's attachments and
// INDEX.txt, /mnt/<project>-<hash>, and /src in developer mode):
//
//   POST {base}/mount       content-type: application/x-tar   (mount:true)
//     body  a ustar archive, extracted at / in the session's machine
//     → 200 {ok:true}
//
//   POST {base}/source      (source:true)
//     the runner seeds /src from the SERVER's copy of the deploy's source
//     snapshot — only the server-side container can do this, which is exactly
//     why it is a separate capability rather than another tar push from here.
//     → 200 {ok:true, count, bytes, cached}
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

import { planMounts, planRemoteMount } from "./sandbox-files.js";

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

/**
 * Bounds on the two mount pushes. The file mount is a few MB over a local or
 * same-origin connection; the source mount is the server unpacking ~11 MB into
 * a container it may have to cold-start first, which is why it gets far more
 * room. Both are hard bounds: a stalled mount must lose the FILES, never the
 * send.
 */
export const MOUNT_TIMEOUT_MS = 60_000;
export const SOURCE_MOUNT_TIMEOUT_MS = 150_000;

/** The default port the reference runner binds — matches runner.mjs's PORT. */
export const DEFAULT_RUNNER_PORT = 8100;
/** The default base URL the settings UI pre-fills. */
export const DEFAULT_RUNNER_URL = "http://localhost:" + DEFAULT_RUNNER_PORT;

/**
 * The same-origin base of the SERVER-SIDE container environment
 * (src/exec-container.js). Not a URL the user types — it is this site.
 */
export const SERVER_EXEC_BASE = "/api/exec";

/**
 * The execution environments a user can pick. `browser` is the default and the
 * only one that needs no setup; `local` is the DREE/1 runner on their machine;
 * `cloudflare` is an ephemeral container this platform starts for the session.
 * Kept as data (not a switch) so the settings UI in both tiers renders from one
 * list and a fourth environment is a row here, not an edit in four files.
 *
 * `tiers` is load-bearing, not decoration. Se/cure's whole posture is that the
 * server is in NO data path (invariant 4), so an environment that runs commands
 * ON the server is admissible for Se/rver ONLY — where the server is inside the
 * trust boundary (owner directive, 2026-07-24). selectRunner enforces it, and
 * exec-backends-core.test.js pins it.
 */
export const EXEC_BACKENDS = [
  {
    id: "browser",
    label: "In-browser Linux VM",
    short: "In-browser",
    needsUrl: false,
    tiers: ["secure", "server"],
    /** One line under the picker — what picking this actually means. */
    note: "Boots a real Linux inside this browser (CheerpX). Nothing leaves the device; emulated, so it is slow to start and slow to run.",
  },
  {
    id: "local",
    label: "Local runner — your machine",
    short: "Local runner",
    needsUrl: true,
    tiers: ["secure", "server"],
    note: "Runs commands in a throwaway container on your own machine, at native speed, through a small service you start on localhost.",
  },
  {
    id: "cloudflare",
    label: "Cloud container — this platform",
    short: "Cloud container",
    needsUrl: false,
    tiers: ["server"],
    note: "Runs commands in an ephemeral Linux container this platform starts for your session, at native speed, with your files and (in developer mode) this site's source tree mounted. The commands and their output pass through this server.",
  },
];

/** The tiers a backend may be offered in — everything, unless it says otherwise. */
const DEFAULT_TIERS = ["secure", "server"];

/** @param {{tiers?: string[]}} b @param {string} [tier] */
function backendInTier(b, tier) {
  if (!tier) return true;
  return (b?.tiers || DEFAULT_TIERS).includes(tier);
}

/** @param {string} id @returns {{id: string, label: string, short: string, needsUrl: boolean, tiers?: string[], note: string} | null} */
export function execBackend(id) {
  return EXEC_BACKENDS.find((b) => b.id === id) || null;
}

/**
 * The environments a given tier may offer, in display order. Both settings UIs
 * render from this rather than from EXEC_BACKENDS directly, so a tier can never
 * show an option it is not allowed to use.
 * @param {string} tier "secure" | "server"
 * @param {{ container?: boolean }} [avail] server-reported availability: the
 *   container environment needs this deploy to actually carry the binding
 */
export function execBackendsFor(tier, avail = {}) {
  return EXEC_BACKENDS.filter(
    (b) => backendInTier(b, tier) && (b.id !== "cloudflare" || avail.container === true),
  );
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
 * Whether a normalized config selects the SERVER-SIDE container — which needs no
 * address (it is this site) but IS tier-gated: asking for it from Se/cure is
 * refused here rather than anywhere further down, so the refusal is one line in
 * one place and testable without a browser.
 * @param {{backend: string}} cfg
 * @param {string} [tier] "secure" | "server"
 * @returns {boolean}
 */
export function usesServerContainer(cfg, tier) {
  if (!cfg || cfg.backend !== "cloudflare") return false;
  // An EXPLICIT tier match, deliberately not backendInTier's "allowed unless it
  // says otherwise": a caller that forgot to state its tier must land on the
  // safe side of this particular question, not the permissive one.
  return (execBackend("cloudflare")?.tiers || []).includes(String(tier || ""));
}

/**
 * Whether this config runs commands somewhere OTHER than the browser VM. The
 * one question the send path asks: it decides whether to skip the COEP gate,
 * the VM pre-warm and the CheerpX mount reset, and which environment collects
 * the deliverables.
 * @param {{backend: string, baseUrl?: string}} cfg
 * @param {string} [tier]
 * @returns {boolean}
 */
export function usesRemoteRunner(cfg, tier) {
  return usesLocalRunner(/** @type {any} */ (cfg)) || usesServerContainer(cfg, tier);
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
 * @returns {{ok: boolean, protocol: string, backend: string, image: string, ephemeral: boolean, network: string, mount: boolean, source: boolean, version: string}}
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
    // The two OPTIONAL capabilities (see the header): whether this runner takes
    // a pushed tar of the send's files, and whether it can seed /src from the
    // server's own copy of the deploy's source. Absent = not offered, so an
    // older runner keeps working and simply mounts nothing.
    mount: data?.mount === true,
    source: data?.source === true,
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
  if (!health.ok) {
    // A runner that answers `ok:false` WITH a reason has diagnosed itself —
    // relay it verbatim (the server-side container uses this to say "no
    // container binding on this deploy" or "turn the sandbox knob on") rather
    // than replacing a real explanation with a generic one.
    const stated = typeof data?.error === "string" ? data.error.trim() : "";
    return fail(stated || "The runner answered, but not with a DREE/1 health body.");
  }
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

  /** @type {ReturnType<typeof parseHealth>|null} */
  let health = null;
  /** Mounting happens once per runner (one research session), like a VM boot. */
  let mounted = false;

  /**
   * Give this send's files to the runner: one tar of /workspace + the project
   * mount, then the tiny script that installs the friendly symlink, then — when
   * the runner can seed it itself — the deploy's source tree at /src.
   *
   * Entirely fail-soft, and deliberately NOT part of the boot verdict: a runner
   * that is up but could not take the files still runs commands, and answering
   * with an unmounted shell beats answering with none (invariant 2). Skipped
   * outright when /healthz doesn't advertise the capability, so a third-party
   * DREE/1 runner sees no unexpected requests.
   * @param {any} fileProvider
   * @param {(msg: string) => void} [onMessage]
   */
  const mountOnce = async (fileProvider, onMessage) => {
    if (mounted) return;
    mounted = true;
    if (!fileProvider || !(health?.mount || health?.source)) return;
    let raw = null;
    try {
      raw = (await fileProvider()) || {};
    } catch {
      return; // a provider that throws mounts nothing — never breaks the send
    }
    // `source:false` — a remote runner that can seed /src does it from the
    // SERVER's copy (see the header), so the ~11 MB snapshot is never tarred up
    // in the browser and pushed across the wire.
    const plan = planMounts(raw, { source: false });
    if (health?.mount && (plan.session.length || plan.project?.files?.length)) {
      const remote = planRemoteMount(plan);
      onMessage?.("Mounting your files…");
      try {
        const resp = await doFetch(cfg.baseUrl + "/mount?session=" + encodeURIComponent(session), {
          method: "POST",
          headers: cfg.key ? { "content-type": "application/x-tar", "x-api-key": cfg.key } : { "content-type": "application/x-tar" },
          // A Uint8Array IS a valid fetch body; the DOM lib types only admit the
          // ArrayBufferView union, hence the cast.
          body: /** @type {any} */ (remote.tar),
          signal: AbortSignal.timeout(MOUNT_TIMEOUT_MS),
        });
        const ok = resp.ok && (await resp.json().catch(() => null))?.ok !== false;
        log(ok ? "exec.runner_mounted" : "exec.runner_mount_failed", {
          files: remote.count,
          bytes: remote.bytes,
          status: resp.status,
        });
        if (ok && remote.script) await runnerExec(remote.script, { timeoutMs: 30_000 });
      } catch (err) {
        log("exec.runner_mount_failed", { error: String(/** @type {any} */ (err)?.message || err).slice(0, 200) });
      }
    }
    if (health?.source && raw.source) {
      // `raw.source` here is usually the light `{server:true}` marker: a runner
      // that can read the snapshot on its own is never handed the bytes.
      onMessage?.("Mounting this site's source tree…");
      try {
        const resp = await doFetch(cfg.baseUrl + "/source?session=" + encodeURIComponent(session), {
          method: "POST",
          signal: AbortSignal.timeout(SOURCE_MOUNT_TIMEOUT_MS),
        });
        const body = resp.ok ? await resp.json().catch(() => null) : null;
        log(body?.ok ? "exec.runner_source_mounted" : "exec.runner_source_failed", {
          files: body?.count ?? null,
          bytes: body?.bytes ?? null,
          cached: !!body?.cached,
          status: resp.status,
        });
      } catch (err) {
        log("exec.runner_source_failed", { error: String(/** @type {any} */ (err)?.message || err).slice(0, 200) });
      }
    }
  };

  /** The /exec call, shared by the Runner's exec and the mount seed script. */
  const runnerExec = async (/** @type {string} */ command, /** @type {any} */ opts = {}) => {
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
      return { exitCode: 124, stdout: "", stderr: runnerLabel(cfg) + " unreachable: " + msg };
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      log("exec.runner_error", { status: resp.status });
      return { exitCode: 1, stdout: "", stderr: "runner error HTTP " + resp.status + " " + detail.slice(0, 200) };
    }
    const data = await resp.json().catch(() => null);
    return parseExecResponse(data);
  };

  return {
    supported: () => !!cfg.baseUrl && healthy !== false,
    boot: async (fileProvider, onMessage) => {
      if (healthy !== null) {
        // A re-boot mid-loop (bash-core calls ensureReady per round) must not
        // re-probe or re-mount — but it must not lose the mount either, so the
        // one-shot mount is attempted here too if the first boot had no
        // provider to work with.
        if (healthy) await mountOnce(fileProvider, onMessage);
        return healthy;
      }
      const probe = await probeRunner(cfg, { fetch: doFetch });
      healthy = probe.reachable;
      health = probe.health;
      log(healthy ? "exec.runner_ready" : "exec.runner_unreachable", {
        backend: probe.health?.backend || "",
        error: probe.error.slice(0, 200),
      });
      if (healthy) await mountOnce(fileProvider, onMessage);
      return healthy;
    },
    exec: runnerExec,
  };
}

/**
 * How this runner is NAMED when something goes wrong. "unavailable" sends
 * someone hunting the wrong machine, so an error says which one it was.
 * @param {{backend: string}} cfg
 */
export function runnerLabel(cfg) {
  return cfg?.backend === "cloudflare" ? "the cloud container" : "local runner";
}

/**
 * The SERVER-SIDE container as a Runner (src/exec-container.js): the same DREE/1
 * client pointed at this site instead of at localhost. No URL and no key — the
 * address is `/api/exec` and the authority is the session cookie — and it is the
 * one environment that can seed /src itself, so a developer-mode send gets the
 * source tree without pushing it up from the browser.
 * @param {{fetch?: typeof fetch, session?: string, onLog?: (event: string, fields: any) => void}} [deps]
 * @returns {Runner}
 */
export function makeContainerRunner(deps = {}) {
  return makeLocalRunner({ backend: "cloudflare", baseUrl: SERVER_EXEC_BASE, key: "" }, deps);
}

/**
 * The single decision point both tiers call: given the user's config and the
 * tier's own browser-VM bridge, return the Runner the shell pass should use.
 * Returns the browser bridge UNCHANGED whenever the user has not fully
 * configured a local runner — so the default path keeps its exact prior
 * behavior, mounts and all, and this seam can never be the cause of a sandbox
 * regression for the 99% who never open the setting.
 *
 * The TIER matters here and nowhere else: `cloudflare` runs the commands on
 * this platform's server, so it is selectable from Se/rver only. A Se/cure
 * caller (`tier:"secure"`, or any caller that doesn't say) asking for it lands
 * on the browser VM — the same safe direction as a half-filled form. That is
 * invariant 4 held as one line of code rather than as prose.
 *
 * @param {{backend?: string, baseUrl?: string, key?: string}|null|undefined} rawCfg
 * @param {Runner} browserRunner the tier's sandbox.js trio
 * @param {{fetch?: typeof fetch, session?: string, tier?: string, onLog?: (event: string, fields: any) => void}} [deps]
 * @returns {Runner}
 */
export function selectRunner(rawCfg, browserRunner, deps = {}) {
  const cfg = normalizeExecBackend(rawCfg);
  if (usesServerContainer(cfg, deps.tier)) return makeContainerRunner(deps);
  if (!usesLocalRunner(cfg)) return browserRunner;
  return makeLocalRunner(cfg, deps);
}
