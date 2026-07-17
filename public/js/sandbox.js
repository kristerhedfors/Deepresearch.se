// The experimental in-browser Linux execution sandbox (the `bash_lite_mcp`
// knob). NOT type-checked (no `// @ts-check`): this is browser/CheerpX glue —
// dynamic CDN imports, xterm globals, WASM VM handles — with no meaningful
// static type surface. The pure, testable logic lives in bash-core.js.
//
// A JavaScript x86 emulator (CheerpX) boots a small Debian Linux
// ENTIRELY IN THIS BROWSER — the server never runs a shell. This module owns
// the VM lifecycle and exposes two things the rest of the app uses:
//
//   - a floating terminal panel (xterm.js) the user can OPT to open to watch
//     (and type into) the live shell — but it NO LONGER pops up on its own when
//     the agent runs commands. Auto-opening covered the screen and broke the
//     prompt-first flow; instead the raw commands + output drift faintly across
//     the page background (public/js/agent-backdrop.js, fed from execInSandbox
//     below), and the panel stays hidden unless the user explicitly opens it.
//   - execInSandbox(cmd) → {exitCode, stdout, stderr}: the programmatic bridge
//     the bash-lite agent loop (public/js/bash-agent.js) drives.
//
// CheerpX needs SharedArrayBuffer, which needs cross-origin isolation
// (COOP+COEP). The Worker serves the DRS app shell with COEP: require-corp
// only when this account's knob is on (src/index.js), so `crossOriginIsolated`
// is the definitive "can this run here" check — sandboxSupported() below.
//
// Ported from the proven terminal integration in aisecurityliteracy.dev
// (the exec marker protocol especially): a stock Debian cloud image, xterm
// wired via setCustomConsole, and a serialized exec queue that captures a
// command's stdout/stderr as base64 between unique markers so it survives the
// shared console. Everything here only ever runs in a browser (DOM, dynamic
// import of the CheerpX ESM) — there is no Node-testable surface, so the pure,
// testable logic lives in public/js/bash-core.js instead.

import {
  applySizeCap,
  buildManifest,
  buildSeedScript,
  planSourceMount,
  projHash,
  sanitizeProjName,
  shellEscape,
} from "./sandbox-files.js";
import { feedCommand, feedResult, feedTerminal, setTerminalInputSink } from "./agent-backdrop.js";
import { createBootMessageRotator, formatBootProgress } from "./boot-messages.js";
import {
  OUTBOX_PATH,
  base64ToBytes,
  concatChunks,
  execEnvelope,
  isExportablePath,
  outboxListCommand,
  parseExecEnvelope,
  parseOutboxListing,
} from "./bash-core.js";

// xterm is VENDORED (2026-07-15, the Forever Agent user-value pass): the
// terminal used to load from cdn.jsdelivr.net at runtime, so a CDN outage
// could break the most regression-prone feature from outside the repo.
// public/vendor/xterm/ holds @xterm/xterm@5.5.0 (lib/xterm.js, css/xterm.css)
// and @xterm/addon-fit@0.10.0 (lib/addon-fit.js), byte-identical to the CDN
// files, pinned by SHA-256:
//   xterm.js     1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495
//   xterm.css    ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6
//   addon-fit.js bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089
// The CheerpX ENGINE stays a CDN dependency for now — self-hosting it is
// gated on Leaning Technology's license terms (an owner decision; see
// docs/FOREVERAGENT-TRAJECTORY.md §5) — as does the streamed Debian disk.
const XTERM_JS = "/vendor/xterm/xterm.js";
const XTERM_CSS = "/vendor/xterm/xterm.css";
const XTERM_FIT_JS = "/vendor/xterm/addon-fit.js";
const CHEERPX_CDN = "https://cxrtnc.leaningtech.com/1.2.6/cx.esm.js";
// The public WebVM Debian disk (streamed over WebSocket, cached in IndexedDB).
const DISK_URL = "wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2";
const IDB_CACHE_ID = "deepresearch-sandbox-vm";
// The persistent session workspace volume (its own IndexedDB, independent of
// the base-image block cache above) — mounted at /workspace. Per-project
// volumes are dr-proj-<hash>, created on demand.
const WORKSPACE_DB = "dr-sandbox-workspace";

// The optional SELF-HOSTED small image (docs/SANDBOX-LOCAL-IMAGE.md), set by the
// app from GET /api/sandbox-image before any boot. Empty = the built-in webvm.io
// CloudDevice default above (so this whole feature is inert until an operator
// uploads AND selects an image). A same-origin path, e.g. /sandbox/img/<id>.ext2.
let _imageUrl = "";
// Reserved for the optional full-prefetch optimization (off by default; the flag
// is plumbed from config so the client can adopt it once verified live).
let _imagePrefetch = false;

/**
 * Point the sandbox at a self-hosted ext2 image (or "" for the built-in default).
 * Must be called BEFORE the VM boots to affect that boot — bootVM reads it at
 * connect-disk time. Idempotent + fail-soft.
 * @param {string} url same-origin image path, or "" for the built-in default
 * @param {boolean} [prefetch]
 */
export function setSandboxImage(url, prefetch = false) {
  _imageUrl = typeof url === "string" ? url : "";
  _imagePrefetch = !!prefetch;
}

/**
 * A per-image IndexedDB block-cache id: switching images must NOT reuse a cache
 * built from a different disk's blocks (block N means different bytes). The
 * built-in default keeps the original fixed id for continuity.
 * @param {string} url
 * @returns {string}
 */
function cacheIdFor(url) {
  if (!url) return IDB_CACHE_ID;
  let h = 0x811c9dc5; // FNV-1a, stable per url
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return "dr-sandbox-vm-" + (h >>> 0).toString(16);
}

/** @type {'off'|'booting'|'ready'|'error'} */
let vmState = "off";
let cx = null;
let term = null;
let fitAddon = null;
let cxReadFunc = null;
/** @type {Promise<boolean> | null} */
let bootPromise = null;
// What the CURRENT boot actually mounted — set in bootVM once the plan is
// known. Mounts are fixed at Linux.create, so a VM can never GAIN a scope
// after boot; resetSandboxIfLacking() compares these against what a send
// needs and discards the VM when it falls short (a bare pre-warm asked to
// carry files, a file-less boot asked to carry the introspection /src source).
let _bootBare = false; // no user files, no project, no source (a plain pre-warm)
let _bootHadFiles = false; // session attachments and/or a project were mounted
let _bootHadSource = false; // the introspection source tree was seeded at /src
// Monotonic boot counter — bumped at the START of every bootVM. Rides on the
// diagnostic events so a "sandbox not ready" exec can be tied to the boot that
// (was supposed to) back it, and a stale-VM reuse becomes visible in the log.
let _bootGen = 0;
let execQueue = Promise.resolve();
let panel = null;
let statusEl = null;
// LEGACY: the old design mounted a bare IDBDevice (WORKSPACE_DB) at /workspace,
// which wedged the VM on read (see the file-mount block in bootVM). /workspace
// now lives in the root overlay, so no per-volume device handle is kept. This
// stays null; resetWorkspaceStorage() still deletes the stale WORKSPACE_DB db so
// a user carrying a corrupt pre-fix volume gets it cleaned up + the space back.
let workspaceDev = null;
// The boot-quip ticker (see boot-messages.js): a setInterval that rotates an
// entertaining "still booting a whole Linux" line onto the caller's
// notification surface while the slow first boot runs. Module-level so both the
// success path and the error handler can stop it.
let bootQuipTimer = null;
// The LIVE progress sink the quip ticker writes to. Held at module scope (not
// captured by startBootQuips) so a caller that JOINS an already-running boot can
// adopt it — the pre-warm (composer focus) starts the boot with a no-op sink, so
// when the real send reuses that in-flight boot, ensureSandboxBooted swaps in
// the send's real sink here and the ticker immediately drives the visible
// activity label. Without this, a pre-warmed boot showed the caller's initial
// "Booting…" string frozen, with no progress bar or quips (the 2026-07-13
// regression: the boot looked hung even while it was making progress).
let _bootOnMessage = null;

/** Start the boot ticker; it writes to the live _bootOnMessage sink each tick. */
function startBootQuips() {
  stopBootQuips();
  const rotator = createBootMessageRotator();
  // Tick every second so the elapsed counter visibly moves (a frozen label is
  // what reads as "hung" on iOS). Each tick shows the live progress line
  // (stage + bar + N/6 + seconds) with a quip trailing, swapped every ~3s so it
  // still entertains without churning. Reads _bootOnMessage LIVE, so a sink
  // adopted mid-boot (a real send joining a pre-warm) takes effect next tick.
  let quip = rotator.next();
  let n = 0;
  const tick = () => {
    try {
      if (typeof _bootOnMessage !== "function") return; // no sink yet — skip
      if (n > 0 && n % 3 === 0) quip = rotator.next();
      n += 1;
      const elapsed = _bootT0 ? Date.now() - _bootT0 : 0;
      _bootOnMessage(`${formatBootProgress(_bootStage, elapsed)} — ${quip}`);
    } catch { /* decoration — never break the boot */ }
  };
  tick(); // paint immediately, don't wait a full second
  bootQuipTimer = setInterval(tick, 1000);
}

/** Stop the boot-quip ticker (idempotent). Does NOT clear _bootOnMessage: the
 * sink is set by ensureSandboxBooted BEFORE bootVM calls startBootQuips (which
 * calls this first to clear any prior timer), so clearing it here nulled the
 * sink before the first tick could ever paint — the whole boot line stayed
 * frozen on the caller's initial "Booting…" string (the 2026-07-13 regression
 * this comment now guards against). The sink is harmless to leave: a warm
 * re-request never ticks, and the next boot overwrites it. resetSandbox clears
 * it on a full teardown. */
function stopBootQuips() {
  if (bootQuipTimer) { clearInterval(bootQuipTimer); bootQuipTimer = null; }
}

// ---- client telemetry (reaches Workers Logs via /api/client-log) -----------
// The sandbox filesystem integration runs entirely in the browser, so its
// boot/mount/seed events are invisible to the server unless we ship them.
// sblog() buffers structured events (and mirrors them to the devtools console);
// flushSandboxLog() beacons the batch to /api/client-log, where the Worker
// re-emits each through the structured logger so it lands in the log URL
// (`wrangler tail` / Workers Logs). Levels are honored end to end: `debug`
// events only surface when the server's LOG_LEVEL=debug. sandboxFsSummary()
// exposes a compact last-mount summary that also rides on every /api/chat
// client_diag (so a mount problem shows in the chat log even without debug).
/** @type {Array<Record<string, any>>} */
let _fsLog = [];
let _fsSummary = null;

// Verbose boot-timeline debugging (see the sandbox-debug skill). OFF by default
// (byte-identical to the old buffered behavior). When ON: every sblog event —
// including the debug-level boot-stage breadcrumbs — is promoted to info so it
// surfaces in Workers Logs even when the server is NOT running LOG_LEVEL=debug,
// AND the buffer is flushed after each event so a boot HANG (an await that never
// resolves, so boot_done/boot_failed never flush) still ships every breadcrumb
// it reached. Toggle: localStorage dr_sandbox_debug="1", the ?sbdebug=1 URL
// param, or window.__DR_SANDBOX_DEBUG(true|false) from the device console.
let _sbDebug = false;
try {
  if (typeof localStorage !== "undefined" && localStorage.getItem("dr_sandbox_debug") === "1") _sbDebug = true;
  if (typeof location !== "undefined" && /[?&]sbdebug=1(&|$)/.test(location.search || "")) _sbDebug = true;
} catch { /* storage/location unavailable */ }

// Boot-stage tracking for the stall watchdog: the last stage entered, the boot
// start time, and the interval handle that heartbeats a stalled boot.
let _bootStage = "";
let _bootT0 = 0;
/** @type {any} */
let _bootWatch = null;
// How long a boot may sit in one stage before the watchdog reports it stalled
// (and keeps reporting, every interval, until the boot resolves). Deliberately
// short relative to a real boot's a-few-seconds so a genuine hang surfaces fast.
const BOOT_STALL_MS = 12000;

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} event dotted name, e.g. "sandbox.fs.mount"
 * @param {Record<string, any>} [fields]
 */
export function sblog(level, event, fields = {}) {
  // Verbose mode promotes debug breadcrumbs to info so they surface without the
  // server running LOG_LEVEL=debug (the boot-stage timeline is otherwise silent
  // in production). Off, this is a no-op — lvl === level.
  const lvl = _sbDebug && level === "debug" ? "info" : level;
  _fsLog.push({ level: lvl, event, ...fields });
  if (_fsLog.length > 300) _fsLog.shift();
  try {
    const fn = /** @type {any} */ (console)[level] || console.log;
    fn.call(console, "[sandbox] " + event, fields);
  } catch { /* console unavailable */ }
  // Verbose mode flushes eagerly: a boot HANG never reaches boot_done/boot_failed
  // (the only buffered-mode flush points), so without this its breadcrumbs would
  // die in the browser. Beacons are fail-soft and coalesce server-side.
  if (_sbDebug) flushSandboxLog();
}

/** The compact last-mount summary folded into /api/chat client_diag. */
export function sandboxFsSummary() {
  return _fsSummary;
}

/** @param {Record<string, any> | null} s */
function setFsSummary(s) {
  _fsSummary = s;
}

// Fire-and-forget: beacon the buffered events to the Worker. Survives page
// teardown (sendBeacon) and never throws. On /cure (no auth) the POST simply
// fails and is swallowed — file mounting is a DRS feature.
function flushSandboxLog() {
  if (!_fsLog.length) return;
  const events = _fsLog.splice(0, _fsLog.length);
  try {
    const ua = (() => { try { return (navigator.userAgent || "").slice(0, 140); } catch { return "" } })();
    const body = JSON.stringify({ scope: "sandbox", ua, events });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/client-log", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/client-log", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    }
  } catch { /* telemetry must never break the sandbox */ }
}

/**
 * Turn verbose sandbox debugging on/off (persists in localStorage). Call with
 * no argument to read the current state. Exposed as window.__DR_SANDBOX_DEBUG so
 * the operator can flip it from a real device's console. See the sandbox-debug
 * skill.
 * @param {boolean} [on]
 * @returns {boolean}
 */
export function sandboxDebug(on) {
  if (on === undefined) return _sbDebug;
  _sbDebug = !!on;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem("dr_sandbox_debug", _sbDebug ? "1" : "0");
  } catch { /* storage unavailable */ }
  // Emit + flush the toggle itself so the log URL shows exactly when it flipped.
  sblog("info", "sandbox.debug_toggle", { on: _sbDebug });
  flushSandboxLog();
  return _sbDebug;
}
if (typeof window !== "undefined") {
  try { /** @type {any} */ (window).__DR_SANDBOX_DEBUG = sandboxDebug; } catch { /* ignore */ }
}

// The stall watchdog: fires on a timer INDEPENDENT of the boot await-chain, so a
// boot that never resolves still ships a signal naming the exact stage it stuck
// on (warn-level → always surfaces, even with verbose mode off) and flushes it —
// the buffered path structurally cannot flush a hang. Re-arms every interval so
// a long hang produces repeated heartbeats, not one lost line. Caveat: a
// synchronous WASM busy-loop would starve the timer; a network/await hang (the
// realistic "booting sandbox" spinner) lets it fire.
function startBootWatchdog() {
  stopBootWatchdog();
  try {
    _bootWatch = setInterval(() => {
      sblog("warn", "sandbox.boot_stalled", { stage: _bootStage, ms: _bootT0 ? Date.now() - _bootT0 : 0 });
      flushSandboxLog();
    }, BOOT_STALL_MS);
  } catch { /* timers unavailable */ }
}
function stopBootWatchdog() {
  try { if (_bootWatch) { clearInterval(_bootWatch); _bootWatch = null; } } catch { /* ignore */ }
}

/** Whether the sandbox CAN run here: cross-origin isolation is present. */
export function sandboxSupported() {
  return typeof window !== "undefined" && window.crossOriginIsolated === true;
}

/** Whether the VM has finished booting and exec is available. */
export function sandboxReady() {
  return vmState === "ready";
}

// ---- DOM: the floating terminal panel --------------------------------------

function loadCSS(url) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.crossOrigin = "anonymous";
    link.onload = resolve;
    link.onerror = () => reject(new Error("Failed to load CSS: " + url));
    document.head.appendChild(link);
  });
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load script: " + url));
    document.head.appendChild(script);
  });
}

function buildPanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "dr-sandbox";
  panel.className = "dr-sandbox hidden";
  panel.innerHTML = `
    <div class="dr-sandbox-bar">
      <span class="dr-sandbox-title">Linux sandbox <span class="exp-badge">Experimental</span></span>
      <span id="dr-sandbox-status" class="dr-sandbox-status">off</span>
      <button type="button" id="dr-sandbox-close" class="dr-sandbox-close" aria-label="Hide sandbox">×</button>
    </div>
    <div id="dr-sandbox-term" class="dr-sandbox-term"></div>`;
  document.body.appendChild(panel);
  statusEl = panel.querySelector("#dr-sandbox-status");
  panel.querySelector("#dr-sandbox-close").addEventListener("click", hideSandbox);
  return panel;
}

function setStatus(s) {
  vmState = s === "ready" || s === "booting" || s === "error" ? s : vmState;
  if (statusEl) statusEl.textContent = s;
  // Boot-timeline breadcrumb: which stage we ENTERED, and how long since boot
  // began. Debug-level so it's silent in production; the stall watchdog reports
  // whichever stage is the last one recorded here. This is the record that
  // turns a "booting sandbox" hang from a mystery into "stuck at connecting
  // disk…".
  _bootStage = s;
  sblog("debug", "sandbox.boot_stage", { stage: s, ms: _bootT0 ? Date.now() - _bootT0 : 0 });
}

export function showSandbox() {
  buildPanel().classList.remove("hidden");
  if (term && fitAddon) requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
}

export function hideSandbox() {
  if (panel) panel.classList.add("hidden");
}

export function toggleSandbox() {
  if (!panel || panel.classList.contains("hidden")) showSandbox();
  else hideSandbox();
}

// ---- terminal I/O ----------------------------------------------------------

// A streaming decoder for the raw console bytes we mirror onto the backdrop —
// {stream:true} so a multi-byte UTF-8 sequence split across two chunks isn't
// mangled. Only stdout (vt===1) is a real terminal stream; exec output never
// reaches here (execInSandbox swaps the console to a private byte collector for
// the duration of a command), so this only ever carries the boot/login banner
// and the interactive shell prompt — exactly the "Linux started" signal.
const _termDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

function writeData(buf, vt) {
  if (vt !== 1) return;
  const bytes = new Uint8Array(buf);
  if (term) term.write(bytes);
  // Mirror the raw stream onto the faint page-background layer (fail-soft —
  // decoration must never break the console).
  try {
    if (_termDecoder) feedTerminal(_termDecoder.decode(bytes, { stream: true }));
  } catch { /* ignore */ }
}

function readData(str) {
  if (!cxReadFunc) return;
  for (let i = 0; i < str.length; i++) cxReadFunc(str.charCodeAt(i));
}

// ---- boot ------------------------------------------------------------------

/**
 * Boot the sandbox once (idempotent). Resolves true when the VM is ready to
 * exec, false if it cannot run (no cross-origin isolation) or boot failed.
 * The terminal panel is BUILT (so exec has a console) but deliberately left
 * hidden — activity surfaces on the faint page-background layer instead; the
 * user can still open the panel by hand (toggleSandbox) if they want the live
 * shell.
 *
 * `fileProvider` (optional) supplies the user's files to mount: an async
 * function resolving to `{ session: [{name,type,bytes}], project: {name, id,
 * files: [{name,type,bytes}]} | null }`. When given, the persistent
 * `/workspace` volume is mounted and the files are seeded into `/workspace` +
 * `/mnt/<projname>-<hash>` before the VM is marked ready. Fully fail-soft — a
 * provider that throws, or any mount/seed error, never blocks the boot.
 *
 * `onBootMessage` (optional) is called with a fresh entertaining quip roughly
 * every couple seconds while the (slow) first boot runs — the caller routes it
 * to whatever notification surface it owns (the DRS activity step, the DRC
 * phase line) so a long boot reads as alive, not frozen. Fully decorative and
 * fail-soft; the boot is idempotent, so it only ticks on the genuine first
 * boot and never for a warm re-request.
 * @param {(() => Promise<any>) | null} [fileProvider]
 * @param {((msg: string) => void) | null} [onBootMessage]
 * @returns {Promise<boolean>}
 */
export function ensureSandboxBooted(fileProvider = null, onBootMessage = null) {
  // Adopt this caller's progress sink even for an ALREADY in-flight boot — a
  // pre-warm starts the boot with a no-op sink, so the real send that reuses it
  // must still get the live progress line + quips (else the activity label
  // sticks on the caller's initial "Booting…" string).
  if (typeof onBootMessage === "function") _bootOnMessage = onBootMessage;
  if (bootPromise) return bootPromise;
  bootPromise = withBootTimeout(bootVM(fileProvider)).catch((err) => {
    stopBootQuips();
    const msg = (/** @type {any} */ (err))?.message || String(err);
    console.error("[sandbox] boot failed", err);
    stopBootWatchdog();
    sblog("error", "sandbox.boot_failed", { error: String(msg).slice(0, 200), stage: _bootStage });
    setFsSummary({ ...(sandboxFsSummary() || {}), err: String(msg).slice(0, 200) });
    flushSandboxLog();
    setStatus("error");
    return false;
  });
  return bootPromise;
}

// A cold Debian boot can legitimately take ~30 s (disk streamed block by
// block), so the timeout is generous — but a boot that NEVER resolves (a disk/
// CDN fetch that hangs, e.g. a privacy browser that blocks the CDN or clears
// the disk cache every session) must not wedge the send forever with no answer.
// Past this ceiling the boot fails soft: resolve false so maybeRunShellLoop
// answers normally, and discard the wedged VM so a later send can retry fresh.
const BOOT_TIMEOUT_MS = 90000;

// Ceiling for the file-seed run inside a boot ("mounting files…"): the seed
// must never consume the whole boot budget — past this the boot proceeds with
// whatever was seeded (see seedFiles). Sized so even a seed racing this limit
// leaves the boot ceiling room for the earlier stages it already passed.
const SEED_TIMEOUT_MS = 45000;

/**
 * Race a boot against BOOT_TIMEOUT_MS. On timeout, log it, tear down the wedged
 * boot, and resolve false (the fail-soft outcome). A real boot rejection still
 * propagates to ensureSandboxBooted's catch. Never rejects on timeout.
 * @param {Promise<boolean>} boot
 * @returns {Promise<boolean>}
 */
function withBootTimeout(boot) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    try {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sblog("warn", "sandbox.boot_timeout", { stage: _bootStage, ms: _bootT0 ? Date.now() - _bootT0 : 0 });
        setFsSummary({ ...(sandboxFsSummary() || {}), err: "boot timed out at " + _bootStage });
        flushSandboxLog();
        try { stopBootQuips(); } catch { /* ignore */ }
        try { stopBootWatchdog(); } catch { /* ignore */ }
        // CheerpX has no abort — discard the wedged instance so a retry re-boots.
        try { resetSandbox("boot_timeout"); } catch { /* ignore */ }
        resolve(false);
      }, BOOT_TIMEOUT_MS);
    } catch { /* timers unavailable — no timeout, just await the boot */ }
    boot.then(
      (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(e); } },
    );
  });
}

/** Whether no VM is booting or booted (a pre-warm may start). */
export function sandboxIdle() {
  return vmState === "off";
}

/**
 * Tear the sandbox back down to idle so the NEXT ensureSandboxBooted re-boots
 * from scratch. State-only + best-effort: the old CheerpX instance (and its
 * parked interactive shell) is abandoned to GC — CheerpX exposes no clean
 * dispose, and a fresh Linux.create makes a new VM. Used to discard a bare
 * pre-warm that a real send needs to replace with a file-mounting boot.
 * @param {string} [reason] why the teardown happened — surfaced in the log so a
 *   later "sandbox not ready" can be traced to the reset that caused it.
 */
export function resetSandbox(reason = "") {
  try { stopBootWatchdog(); } catch { /* ignore */ }
  try { stopBootQuips(); } catch { /* ignore */ }
  _bootOnMessage = null; // full teardown — drop the sink (stopBootQuips no longer does)
  vmState = "off";
  bootPromise = null;
  cx = null;
  _bootBare = false;
  _bootHadFiles = false;
  _bootHadSource = false;
  try { if (typeof window !== "undefined") /** @type {any} */ (window).__DR_SANDBOX = null; } catch { /* ignore */ }
  sblog("info", "sandbox.reset", { reason: String(reason || "").slice(0, 80), gen: _bootGen });
  flushSandboxLog();
}

/**
 * If the current (or in-flight) boot lacks a mount scope the caller's send
 * needs, discard it so the caller can re-boot with the right provider —
 * mounts are fixed at Linux.create, so re-booting is the ONLY way a VM gains
 * one. Awaits any in-flight boot to settle FIRST — resetting mid-boot would
 * race the running bootVM against a fresh one. A no-op when idle, when
 * nothing is needed, or when the live VM already carries what's needed (a
 * dev-mode pre-warm that seeded /src serves a source-wanting send as-is).
 * Never throws.
 * @param {{ files?: boolean, source?: boolean }} [needs]
 */
export async function resetSandboxIfLacking(needs = {}) {
  if (vmState === "off") return;
  if (!needs.files && !needs.source) return;
  try { if (bootPromise) await bootPromise; } catch { /* settle regardless */ }
  if (_bootBare) { resetSandbox("needs_mounts"); return; }
  if (needs.files && !_bootHadFiles) { resetSandbox("needs_files"); return; }
  if (needs.source && !_bootHadSource) resetSandbox("needs_source");
}

/**
 * LEGACY CLEANUP: delete the old bare-IDBDevice /workspace volume
 * (`dr-sandbox-workspace`). That device is no longer mounted — /workspace now
 * lives in the root overlay — but a user who ran the old (broken) code still has
 * a stale, possibly-corrupt `dr-sandbox-workspace` db sitting in IndexedDB.
 * Deleting it reclaims the space and removes a dead artifact; it can no longer
 * affect a boot (nothing reads it). Kept wired to the exec-timeout / torn-down
 * paths as a harmless best-effort sweep. Best-effort and never throws — prefers
 * CheerpX's own IDBDevice.reset(), falls back to deleting the IndexedDB.
 */
async function resetWorkspaceStorage() {
  const dev = workspaceDev;
  workspaceDev = null;
  try {
    if (dev && typeof dev.reset === "function") {
      await dev.reset();
      sblog("warn", "sandbox.workspace_reset", { via: "idbdevice" });
      flushSandboxLog();
      return;
    }
  } catch { /* fall through to deleteDatabase */ }
  try {
    if (typeof indexedDB !== "undefined" && indexedDB.deleteDatabase) {
      await new Promise((resolve) => {
        let done = false;
        const settle = () => { if (!done) { done = true; resolve(undefined); } };
        const req = indexedDB.deleteDatabase(WORKSPACE_DB);
        req.onsuccess = settle;
        req.onerror = settle;
        req.onblocked = settle; // an open handle blocks the delete — give up, don't hang
        setTimeout(settle, 3000); // never wait on IDB forever
      });
      sblog("warn", "sandbox.workspace_reset", { via: "deletedb" });
      flushSandboxLog();
    }
  } catch { /* best-effort — a still-bricked volume just falls back next boot */ }
}

/**
 * The boot progress sink is the module-level _bootOnMessage (set by
 * ensureSandboxBooted), so the ticker can be adopted by a caller that joins an
 * in-flight boot — see startBootQuips.
 * @param {(() => Promise<any>) | null} [fileProvider]
 */
async function bootVM(fileProvider = null) {
  const t0 = Date.now();
  _bootT0 = t0;
  _bootGen += 1;
  const gen = _bootGen;
  _bootStage = "boot_start";
  const coi = typeof window !== "undefined" && window.crossOriginIsolated === true;
  const sab = typeof SharedArrayBuffer !== "undefined";
  sblog("info", "sandbox.boot_start", { coi, sab, provider: !!fileProvider, debug: _sbDebug, gen });
  if (!sandboxSupported()) {
    sblog("warn", "sandbox.boot_unsupported", { coi, sab });
    setFsSummary({ n: 0, b: 0, proj: false, drop: 0, ms: Date.now() - t0, err: "not cross-origin isolated" });
    flushSandboxLog();
    setStatus("error");
    return false;
  }
  // Build the panel (exec needs the xterm console) but do NOT show it — the
  // agent's activity is surfaced faintly on the page background instead of
  // taking over the screen. The user can still open it by hand.
  buildPanel();
  setStatus("booting");
  // Keep the notification bar lively while the disk streams and Linux comes up.
  // The ticker reads the live _bootOnMessage sink (adopted by ensureSandboxBooted),
  // so a real send that joins a pre-warm's boot still lights up the progress line.
  startBootQuips();
  // Arm the stall watchdog now — everything after this point is an await that
  // can hang (CDN scripts, disk fetch, Linux.create). If any never resolves, the
  // watchdog still names the stuck stage and flushes it.
  startBootWatchdog();

  await Promise.all([
    // The xterm stylesheet is purely cosmetic terminal styling — exec needs
    // none of it, so a failed/blocked CSS load must NOT abort the boot (it did:
    // a transient CDN miss on xterm.css took the whole sandbox down with
    // "Sandbox unavailable"). The two SCRIPTS are load-bearing (they define the
    // Terminal/FitAddon globals), so those stay fatal. All three are VENDORED
    // same-origin files now (see the constants above), so this no longer
    // depends on a third-party CDN at all.
    loadCSS(XTERM_CSS).catch((e) => console.warn("[sandbox] xterm css skipped:", e?.message || e)),
    loadScript(XTERM_JS),
    loadScript(XTERM_FIT_JS),
  ]);

  const container = panel.querySelector("#dr-sandbox-term");
  // @ts-ignore — Terminal/FitAddon are attached to window by the vendored scripts.
  term = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: window.innerWidth < 768 ? 12 : 13,
    theme: { background: "#101014", foreground: "#d6d6e6", cursor: "#c0caf5" },
  });
  // @ts-ignore
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  try { fitAddon.fit(); } catch {}
  term.onData(readData);
  container.addEventListener("keydown", (e) => e.stopPropagation());

  setStatus("loading CheerpX…");
  const CheerpX = await import(CHEERPX_CDN);

  setStatus("connecting disk…");
  // Prefer a self-hosted small image (CheerpX HttpBytesDevice, same-origin,
  // Range-streamed from our R2) when one is selected; otherwise the built-in
  // webvm.io CloudDevice default. Fail-soft: if HttpBytesDevice is unavailable
  // (older CheerpX pin) or the image can't open, fall back to the default so a
  // misconfigured image never wedges the boot — the sandbox's fail-soft contract.
  let blockDevice = null;
  let usingLocalImage = false;
  if (_imageUrl && CheerpX.HttpBytesDevice && typeof CheerpX.HttpBytesDevice.create === "function") {
    try {
      const absolute = new URL(_imageUrl, location.href).href;
      blockDevice = await CheerpX.HttpBytesDevice.create(absolute);
      usingLocalImage = true;
      sblog("info", "sandbox.image", { url: _imageUrl, prefetch: _imagePrefetch, via: "HttpBytesDevice" });
    } catch (err) {
      sblog("warn", "sandbox.image_failed", { url: _imageUrl, error: String((/** @type {any} */ (err))?.message || err).slice(0, 200) });
      blockDevice = null;
    }
  }
  if (!blockDevice) blockDevice = await CheerpX.CloudDevice.create(DISK_URL);
  const blockCache = await CheerpX.IDBDevice.create(usingLocalImage ? cacheIdFor(_imageUrl) : IDB_CACHE_ID);
  const overlayDevice = await CheerpX.OverlayDevice.create(blockDevice, blockCache);

  const mounts = [
    { type: "ext2", dev: overlayDevice, path: "/" },
    { type: "devs", path: "/dev" },
    { type: "devpts", path: "/dev/pts" },
    { type: "proc", path: "/proc" },
    { type: "sys", path: "/sys" },
  ];

  // File mounting (design part B). When a provider is supplied, the user's
  // files ingest through in-memory DataDevices (direct binary bytes, no base64)
  // and the boot seed script cp's them into PLAIN DIRECTORIES in the root
  // OVERLAY filesystem — /workspace (session) and the project dir under /mnt.
  // The overlay is a real ext2 fs and already persists across sessions via its
  // own IndexedDB layer (IDB_CACHE_ID), so those directories are persistent RW
  // without any extra device.
  //
  // We deliberately do NOT mount a bare IDBDevice as /workspace (or one per
  // project). CheerpX 1.2.6 WEDGES the VM on the FIRST read of a file from a
  // directly-`type:"dir"`-mounted IDBDevice — the guest read never returns
  // (internally "Cannot read properties of null (reading 'fileData')"), which is
  // exactly why file integrations never worked and reads hung into "sandbox not
  // ready". Proven in an isolated Chromium probe (scratch harness, 2026-07-14):
  // DataDevice ingest → cp into the overlay reads back byte-perfect, while a bare
  // IDBDevice dir mount times out on `cat`. So the ONLY extra devices are the
  // read-only ingest DataDevices; the destinations are overlay directories the
  // seed script creates. This is the mechanism aisecurityliteracy.dev proved.
  /** @type {{ plan: any, inSession: any, inProject: any, inSource: any, projMount: string } | null} */
  let fileMount = null;
  if (fileProvider) {
    try {
      setStatus("preparing files…");
      const plan = await preparePlan(fileProvider);
      // Build the extra mounts in a LOCAL array and only commit them to the
      // real mounts once every device was created — a partial failure must not
      // leave a half-formed mount in the config passed to Linux.create.
      const extra = [];
      const inSession = await CheerpX.DataDevice.create();
      extra.push({ type: "dir", dev: inSession, path: "/mnt/in-s" });
      let inProject = null;
      let projMount = "";
      if (plan && plan.project) {
        // A plain directory in the overlay — created by the seed script's
        // `mkdir -p`, NOT a separate device mount (see the block comment above).
        projMount = `/mnt/${plan.project.name}-${plan.project.hash}`;
        inProject = await CheerpX.DataDevice.create();
        extra.push({ type: "dir", dev: inProject, path: "/mnt/in-p" });
      }
      // Introspection (developer mode): the source snapshot's ingest device.
      // Same Tier-1 DataDevice pattern as the session/project ingests — the
      // pre-bundled files stream in as raw bytes at the device root and the
      // seed script (planSourceMount) recreates the tree at /src.
      let inSource = null;
      if (plan && plan.source) {
        inSource = await CheerpX.DataDevice.create();
        extra.push({ type: "dir", dev: inSource, path: "/mnt/in-src" });
      }
      for (const m of extra) mounts.push(m);
      fileMount = { plan, inSession, inProject, inSource, projMount };
      sblog("info", "sandbox.fs.mount", {
        workspace: "/workspace",
        project: projMount || null,
        ingest: inProject ? "/mnt/in-s,/mnt/in-p" : "/mnt/in-s",
        session_files: plan.session.length,
        project_files: plan.project ? plan.project.files.length : 0,
        source_files: plan.source ? plan.source.count : 0,
        dropped: plan.dropped.length,
        bytes: plan.bytes,
      });
    } catch (err) {
      const msg = (/** @type {any} */ (err))?.message || String(err);
      console.warn("[sandbox] file mount setup failed — booting without files", err);
      sblog("warn", "sandbox.fs.mount_failed", { error: String(msg).slice(0, 200) });
      fileMount = null;
    }
  }

  // Record what this boot actually mounted — resetSandboxIfLacking compares
  // these against a send's needs to decide whether the VM must be re-booted.
  _bootHadFiles = !!(fileMount && fileMount.plan && (fileMount.plan.session.length > 0 || fileMount.plan.project));
  _bootHadSource = !!(fileMount && fileMount.plan && fileMount.plan.source);
  _bootBare = !_bootHadFiles && !_bootHadSource;

  setStatus("starting Linux…");
  cx = await CheerpX.Linux.create({ mounts });

  // Seed the persistent volumes from the ingest devices, then make the symlink.
  if (fileMount) {
    try {
      setStatus("mounting files…");
      await seedFiles(fileMount);
    } catch (err) {
      const msg = (/** @type {any} */ (err))?.message || String(err);
      console.warn("[sandbox] file seed failed — continuing without files", err);
      sblog("warn", "sandbox.fs.seed_failed", { error: String(msg).slice(0, 200) });
    }
  }

  cxReadFunc = cx.setCustomConsole(writeData, term.cols, term.rows);
  // Direct terminal typing (2026-07-16): while the terminal pane is forward, a
  // tap focuses the backdrop's hidden input and its keystrokes land HERE — the
  // same readData path the xterm panel uses, so input reaches the live shell
  // prompt. readData reads the current cxReadFunc on every call, so this stays
  // valid across execInSandbox's temporary console swaps.
  setTerminalInputSink(readData);
  stopBootQuips(); // booted — hand the notification bar back to the real steps
  setStatus("ready");
  vmState = "ready";
  // Boot resolved — silence the stall watchdog before the (forever) shell loop.
  stopBootWatchdog();

  // Expose the bridge for the agent loop and any test harness.
  window.__DR_SANDBOX = { ready: true, exec: execInSandbox };

  // Record the boot summary (also rides on client_diag) and, when files were
  // mounted, a real on-disk verification listing — the definitive "did the
  // files actually land" signal, at debug so heavy testing can see it via the
  // log URL without noising up production. Everything here is best-effort.
  const bootMs = Date.now() - t0;
  const plan = fileMount && fileMount.plan;
  setFsSummary({
    n: plan ? plan.session.length + (plan.project ? plan.project.files.length : 0) : 0,
    b: plan ? plan.bytes : 0,
    proj: !!(plan && plan.project),
    // Introspection source mount (developer mode): file count, 0 when absent.
    src: plan && plan.source ? plan.source.count : 0,
    drop: plan ? plan.dropped.length : 0,
    ms: bootMs,
    err: "",
  });
  sblog("info", "sandbox.boot_done", {
    ms: bootMs,
    files: _fsSummary ? _fsSummary.n : 0,
    bytes: _fsSummary ? _fsSummary.b : 0,
    project: !!(plan && plan.project),
  });
  // The on-disk verification listing is DEBUG-ONLY telemetry (sandbox.fs.verify
  // only surfaces with LOG_LEVEL=debug / the client verbose toggle), so only run
  // it when verbose debugging is actually on. It reads /workspace — a bare,
  // persistent IDBDevice (dr-sandbox-workspace) that is never reset — and the
  // `ls -la /workspace/*/` glob is the documented wedge trigger (a stat over a
  // corrupt persisted volume that never returns; sandbox-debug skill). When it
  // wedged it hit EXEC_TIMEOUT_MS and resetSandbox() tore down the VM FROM
  // INSIDE the boot, yet bootVM returned true — so the model's real command then
  // got "sandbox not ready" (chat_logs #316/#317, iOS PWA, 2026-07-14). Keeping
  // this diagnostic off the normal hot path is the fix; the honest-readiness
  // guard below is the belt-and-suspenders so a torn-down boot can never again
  // report success.
  if (fileMount && _sbDebug) {
    try {
      const v = await execInSandbox(
        "echo '# /workspace'; ls -la /workspace 2>&1; echo '# project'; ls -la /workspace/*/ 2>/dev/null | head -40",
      );
      sblog("debug", "sandbox.fs.verify", { exit: v.exitCode, listing: String(v.stdout || "").slice(0, 1500) });
    } catch (err) {
      sblog("debug", "sandbox.fs.verify_failed", { error: String((/** @type {any} */ (err))?.message || err).slice(0, 200) });
    }
  }
  flushSandboxLog();

  // Honest readiness: if anything between "vmState = ready" above and here tore
  // the VM back down (e.g. a diagnostic exec that wedged and reset the sandbox),
  // do NOT report a successful boot — a stale `true` here is exactly what made
  // ensureSandboxBooted resolve ready while execInSandbox saw a dead VM and
  // returned "sandbox not ready". Report the real state so the caller falls back
  // cleanly (answers normally) instead of running commands against a corpse.
  if (vmState !== "ready" || !cx) {
    sblog("warn", "sandbox.boot_torn_down", { stage: _bootStage, gen, mounted: !!fileMount });
    flushSandboxLog();
    // A file-mounting boot that tore itself down most likely wedged reading or
    // seeding the persistent /workspace volume — wipe it so the next boot isn't
    // bricked by the same corrupt store. Only here (already-failed, files-mounted
    // boot); the bare "ls /" path never mounts /workspace and never reaches this.
    if (fileMount) { try { await resetWorkspaceStorage(); } catch { /* best-effort */ } }
    return false;
  }

  // Interactive login shell in a loop (re-spawns if the user types exit).
  // The image's stock profile runs `mesg n` unconditionally, and under the
  // custom console there is no controlling tty — so every login shell printed
  // "mesg: ttyname failed: No such file or directory" into the terminal (and
  // the mirrored backdrop), once per boot AND per respawn. Guard the mesg
  // line behind a real tty before exec'ing bash. sed is idempotent (the
  // patched line no longer starts with `mesg`) and the root overlay persists,
  // so after the first boot this is a no-op; `;` (not `&&`) so a sed failure
  // can never block the shell itself.
  const loginShell =
    `for f in /root/.profile /etc/profile; do ` +
    `[ -f "$f" ] && sed -i 's/^mesg /tty -s \\&\\& mesg /' "$f" 2>/dev/null; ` +
    `done; exec /bin/bash --login`;
  (async () => {
    while (vmState === "ready") {
      try {
        await cx.run("/bin/sh", ["-c", loginShell], {
          env: ["HOME=/root", "TERM=xterm-256color", "USER=root", "SHELL=/bin/bash", "LANG=en_US.UTF-8", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
          cwd: "/root",
          uid: 0,
          gid: 0,
        });
      } catch {
        break;
      }
    }
  })();

  return true;
}

// ---- file mounting (design part B) -----------------------------------------

// Call the provider and turn its raw {session, project, source} into a mount
// plan: size-capped, sanitized, de-duped kept lists + a manifest + the
// project's sanitized name/hash + the introspection source-mount plan. Pure
// logic lives in sandbox-files.js. Never throws for a bad provider payload —
// returns a session-only (or empty) plan.
/**
 * @param {() => Promise<any>} fileProvider
 * @returns {Promise<{ session: any[], project: any, source: any, manifest: string, dropped: any[], bytes: number }>}
 */
async function preparePlan(fileProvider) {
  const raw = (await fileProvider()) || {};
  const sessionCap = applySizeCap(Array.isArray(raw.session) ? raw.session : []);
  let total = sessionCap.total;
  const dropped = sessionCap.dropped.map((d) => ({ scope: "session", ...d }));
  let project = null;
  if (raw.project && Array.isArray(raw.project.files) && raw.project.files.length) {
    const projCap = applySizeCap(raw.project.files, { startTotal: total });
    total = projCap.total;
    for (const d of projCap.dropped) dropped.push({ scope: "project", ...d });
    project = {
      name: sanitizeProjName(raw.project.name),
      id: String(raw.project.id || ""),
      hash: projHash(raw.project.id),
      files: projCap.kept,
    };
  }
  // Introspection (developer mode): the pre-bundled source snapshot becomes
  // its own flat ingest + /src seed script — budgeted separately (it's a
  // fixed, known artifact, not user data competing for the session budget).
  let source = null;
  if (raw.source && Array.isArray(raw.source.files) && raw.source.files.length) {
    source = planSourceMount(raw.source.files);
    if (source) total += source.bytes;
  }
  const manifest = buildManifest({
    session: sessionCap.kept,
    project: project ? { name: project.name, files: project.files } : null,
    dropped,
    source: source ? { count: source.count, bytes: source.bytes } : null,
  });
  sblog("info", "sandbox.fs.plan", {
    session_files: sessionCap.kept.length,
    project_files: project ? project.files.length : 0,
    project_name: project ? project.name : null,
    source_files: source ? source.count : 0,
    total_bytes: total,
    dropped: dropped.length,
  });
  // Per-dropped-file detail at debug so a "why isn't my file there" can be
  // answered from the log URL without a repro.
  for (const d of dropped) sblog("debug", "sandbox.fs.dropped", { scope: d.scope, name: d.name, reason: d.reason });
  return { session: sessionCap.kept, project, source, manifest, dropped, bytes: total };
}

// Write the kept bytes into the flat ingest DataDevices (files at the device
// root — matches the documented DataDevice.writeFile pattern, no nested dirs),
// then run the seed+symlink script to cp them into the persistent volumes.
/**
 * @param {{ plan: any, inSession: any, inProject: any, projMount: string }} fm
 */
async function seedFiles(fm) {
  const { plan, inSession, inProject, inSource } = fm;
  const enc = new TextEncoder();
  // The manifest rides in as a session file so it lands at /workspace/INDEX.txt.
  await inSession.writeFile("/INDEX.txt", enc.encode(plan.manifest));
  for (const f of plan.session) {
    await inSession.writeFile("/" + f.name, f.bytes);
    sblog("debug", "sandbox.fs.write", { scope: "session", name: f.name, size: f.size });
  }
  if (plan.project && inProject) {
    for (const f of plan.project.files) {
      await inProject.writeFile("/" + f.name, f.bytes);
      sblog("debug", "sandbox.fs.write", { scope: "project", name: f.name, size: f.size });
    }
  }
  // The introspection source snapshot: ONE ustar archive (src.tar, extracted
  // with a single spawn — the fast path) plus the flat pre-bundled files
  // (f0, f1, …) with their cp fallback script for a guest without tar. Both
  // scripts are written INTO the device so a hundreds-of-lines script never
  // rides in argv (see sandbox-files.js planSourceMount).
  if (plan.source && inSource) {
    if (plan.source.tar && plan.source.tar.length) {
      await inSource.writeFile("/src.tar", plan.source.tar);
    }
    for (const e of plan.source.entries) {
      await inSource.writeFile("/" + e.flat, e.bytes);
    }
    if (plan.source.seedCp) await inSource.writeFile("/.seedcp", enc.encode(plan.source.seedCp));
    await inSource.writeFile("/.seed", enc.encode(plan.source.seed));
    sblog("debug", "sandbox.fs.write", { scope: "source", name: "/src tree", size: plan.source.bytes });
  }
  const script = buildSeedScript({
    hasProject: !!plan.project,
    projName: plan.project?.name,
    projId: plan.project?.id,
    hash: plan.project?.hash,
  });
  const full = plan.source && inSource ? script + "\nsh /mnt/in-src/.seed 2>/dev/null || true" : script;
  // The seed run is time-bounded like execInSandbox: a slow guest (cold
  // binaries on a phone) must degrade to a partially seeded — but LIVE —
  // sandbox, never eat the whole 90s boot ceiling and kill the boot
  // ("boot timed out at mounting files…", chat_logs #515). On timeout the
  // run is abandoned (it may still finish in the background) and boot
  // proceeds; worst case some files are missing until the next boot.
  let seedTimedOut = false;
  const r = await Promise.race([
    cx.run("/bin/sh", ["-c", full], {
      env: ["HOME=/root", "TERM=dumb", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      cwd: "/root",
      uid: 0,
      gid: 0,
    }),
    new Promise((resolve) => setTimeout(() => { seedTimedOut = true; resolve(null); }, SEED_TIMEOUT_MS)),
  ]);
  if (seedTimedOut) {
    sblog("warn", "sandbox.fs.seed_timeout", { ms: SEED_TIMEOUT_MS, source_files: plan.source ? plan.source.count : 0 });
  }
  sblog("info", "sandbox.fs.seed", {
    exit: r && Number.isFinite(r.status) ? r.status : null,
    timed_out: seedTimedOut,
    project_mount: plan.project ? `/mnt/${plan.project.name}-${plan.project.hash}` : null,
    source_files: plan.source ? plan.source.count : 0,
  });
}

// Read a guest-written file back out into JS (the round-trip export). Now that
// /workspace and the project dir live in the root OVERLAY (no per-volume
// IDBDevice to readFileAsBlob from), the file is base64'd out through the exec
// bridge — the same proven capture path every command uses. Returns the Blob,
// or null if unavailable.
/**
 * @param {string} path an absolute guest path under /workspace or /mnt/<proj>
 * @returns {Promise<Blob | null>}
 */
export async function exportFile(path) {
  const p = String(path || "");
  // Only round-trip files out of the mount tree — never arbitrary guest paths
  // (the policy predicate lives in bash-core.js next to OUTBOX_PATH).
  if (!isExportablePath(p)) {
    sblog("debug", "sandbox.fs.export", { path: p.slice(0, 120), bytes: 0, ok: false, skip: "path" });
    return null;
  }
  try {
    const r = await execInSandbox("base64 -w0 " + shellEscape(p));
    if (r.exitCode !== 0 || !r.stdout) {
      sblog("debug", "sandbox.fs.export", { path: p.slice(0, 120), bytes: 0, ok: false, rc: r.exitCode });
      flushSandboxLog();
      return null;
    }
    const blob = new Blob([base64ToBytes(r.stdout)]);
    sblog("debug", "sandbox.fs.export", { path: p.slice(0, 120), bytes: blob.size, ok: true });
    flushSandboxLog();
    return blob;
  } catch (err) {
    const msg = (/** @type {any} */ (err))?.message || String(err);
    console.warn("[sandbox] exportFile failed", err);
    sblog("warn", "sandbox.fs.export_failed", { path: p.slice(0, 120), error: String(msg).slice(0, 200) });
    flushSandboxLog();
  }
  return null;
}

// Collect the OUTBOX deliverables — the download flow's host side. The agent
// copies finished artifacts into /workspace/outbox (the bash-core convention,
// taught by bashAgentPrompt); after the loop this lists the folder (one exec)
// and round-trips each file out via exportFile (base64-through-exec — the one
// documented host-read route). Bounded by the bash-core caps, entirely
// fail-soft (any problem → fewer/no deliverables, never a broken reply).
/**
 * @returns {Promise<Array<{ name: string, size: number, blob: Blob }>>}
 */
export async function collectDeliverables() {
  try {
    if (vmState !== "ready" || !cx) return [];
    const listing = await execInSandbox(outboxListCommand());
    if (listing.exitCode !== 0) {
      sblog("debug", "sandbox.fs.deliver", { n: 0, rc: listing.exitCode, ok: false });
      return [];
    }
    const { files, dropped } = parseOutboxListing(listing.stdout);
    /** @type {Array<{ name: string, size: number, blob: Blob }>} */
    const out = [];
    let bytes = 0;
    for (const f of files) {
      const blob = await exportFile(OUTBOX_PATH + "/" + f.name);
      if (blob && blob.size) {
        out.push({ name: f.name, size: blob.size, blob });
        bytes += blob.size;
      }
    }
    if (out.length || dropped) {
      sblog("info", "sandbox.fs.deliver", { n: out.length, bytes, dropped });
      flushSandboxLog();
    }
    return out;
  } catch (err) {
    console.warn("[sandbox] collectDeliverables failed", err);
    sblog("warn", "sandbox.fs.deliver_failed", { error: String((/** @type {any} */ (err))?.message || err).slice(0, 200) });
    flushSandboxLog();
    return [];
  }
}

// ---- exec bridge (marker protocol) -----------------------------------------

// A single guest command that outlives this ceiling is treated as WEDGED. The
// VM is offline (no network egress) so real commands are local and fast; a
// command that never returns is a mount/device read that blocks forever (seen
// on privacy browsers / flaky links, e.g. a `cat` on a file whose backing
// device stalls) — and CheerpX offers no way to kill a running process. Without
// this ceiling that wedge is fatal: cx.run never resolves, so execInSandbox
// never resolves, so runShellLoop's `await exec(command)` never returns and the
// whole request hangs with no answer and nothing logged (the "stuck at
// $ cat …" symptom). Kept well under a typical request budget so a hung command
// fails soft with room left for synthesis. Mirrors the boot's withBootTimeout.
const EXEC_TIMEOUT_MS = 30000;

// Run one command and capture {exitCode, stdout, stderr}. Serialized through
// execQueue so concurrent calls don't stomp the shared custom console. Uses a
// unique marker + base64 so the captured output survives any stray banner the
// interactive shell emits. Ported from the aisl terminal integration.
/**
 * @param {string} command
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export function execInSandbox(command) {
  const run = async () => {
    if (vmState !== "ready" || !cx) {
      // The VM isn't live when a command tries to run. This should no longer
      // happen on the happy path (bootVM now reports honest readiness), so log
      // the exact state if it ever recurs: which boot generation, whether a boot
      // is still tracked, and the last stage — enough to tell a stale-VM reuse
      // from a mid-flight teardown without device access.
      sblog("warn", "sandbox.exec_not_ready", {
        vmState,
        hasCx: !!cx,
        bootTracked: !!bootPromise,
        bootBare: _bootBare,
        stage: _bootStage,
        gen: _bootGen,
        cmd: String(command).slice(0, 80),
      });
      flushSandboxLog();
      return { exitCode: 1, stdout: "", stderr: "sandbox not ready" };
    }
    // Surface the command on the faint page-background activity layer (never
    // throws — it's decoration). "shell" is the default single-agent channel;
    // multiple agents each pass their own id and the layer clips between them.
    feedCommand("shell", command);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // The marker+base64 envelope (incl. the RC-before-any-pipe fix) is the
    // pure codec in bash-core.js — this side only owns the VM/console plumbing.
    const { marker, wrapped } = execEnvelope(command, id);
    const env = {
      env: ["HOME=/root", "TERM=dumb", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      cwd: "/root",
      uid: 0,
      gid: 0,
    };
    const chunks = [];
    cx.setCustomConsole((buf) => chunks.push(new Uint8Array(buf)), 1024, 24);
    // Race the command against EXEC_TIMEOUT_MS. On timeout tear the (wedged,
    // single-threaded) VM down so the next exec can't run on a corrupt state,
    // and return a fail-soft result so runShellLoop ends and synthesis still
    // runs with the transcript gathered so far — never leave the request hung.
    let timedOut = false;
    const running = (async () => {
      try {
        await cx.run("/bin/sh", ["-c", wrapped], env);
      } finally {
        // Restore the interactive console only if we didn't time out (a timeout
        // resets cx to null); guard on cx so the abandoned promise can't throw.
        if (!timedOut && term && cx) cxReadFunc = cx.setCustomConsole(writeData, term.cols, term.rows);
      }
    })();
    const outcome = await Promise.race([
      running.then(() => "ok", () => "ok"),
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve("timeout"); }, EXEC_TIMEOUT_MS)),
    ]);
    if (outcome === "timeout") {
      sblog("warn", "sandbox.exec_timeout", { ms: EXEC_TIMEOUT_MS, command: String(command).slice(0, 120) });
      flushSandboxLog();
      // A command that wedged reading /workspace is the corrupt-persistent-volume
      // signature (a stat over inconsistent ext2-in-IndexedDB metadata that never
      // returns). Wipe that fixed-name IDB volume so it doesn't re-brick the next
      // boot — targeted to /workspace-touching commands so an unrelated slow
      // command never nukes a healthy volume. Fires before resetSandbox (which
      // leaves workspaceDev set for resetWorkspaceStorage to read).
      if (/\/workspace/.test(String(command))) {
        try { resetWorkspaceStorage(); } catch { /* best-effort */ }
      }
      // CheerpX has no abort — discard the wedged instance so a later send re-boots.
      try { resetSandbox("exec_timeout"); } catch { /* ignore */ }
      const timeoutRes = { exitCode: 124, stdout: "", stderr: `command timed out after ${Math.round(EXEC_TIMEOUT_MS / 1000)}s` };
      try { feedResult("shell", timeoutRes); } catch { /* decoration */ }
      return timeoutRes;
    }
    const raw = new TextDecoder().decode(concatChunks(chunks));
    const result = parseExecEnvelope(raw, marker);
    if (!result) return { exitCode: 1, stdout: "", stderr: "exec: marker not found" };
    feedResult("shell", result); // mirror the raw output to the background layer
    return result;
  };
  const next = execQueue.then(run, run);
  execQueue = next.then(() => {}, () => {});
  return next;
}
