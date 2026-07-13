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
} from "./sandbox-files.js";
import { feedCommand, feedResult } from "./agent-backdrop.js";
import { createBootMessageRotator, formatBootProgress } from "./boot-messages.js";

const XTERM_CDN = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0";
const XTERM_FIT_CDN = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0";
const CHEERPX_CDN = "https://cxrtnc.leaningtech.com/1.2.6/cx.esm.js";
// The public WebVM Debian disk (streamed over WebSocket, cached in IndexedDB).
const DISK_URL = "wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2";
const IDB_CACHE_ID = "deepresearch-sandbox-vm";
// The persistent session workspace volume (its own IndexedDB, independent of
// the base-image block cache above) — mounted at /workspace. Per-project
// volumes are dr-proj-<hash>, created on demand.
const WORKSPACE_DB = "dr-sandbox-workspace";

/** @type {'off'|'booting'|'ready'|'error'} */
let vmState = "off";
let cx = null;
let term = null;
let fitAddon = null;
let cxReadFunc = null;
/** @type {Promise<boolean> | null} */
let bootPromise = null;
// Whether the CURRENT boot mounted no user files (bare VM) — set in bootVM once
// the plan is known. A bare boot is the only kind a pre-warm produces (it runs
// before a message exists, so it can't know the files/project/source to mount);
// resetSandboxIfBare() uses it to discard a pre-warm when a real send needs
// mounts a bare VM can't carry (mounts are fixed at Linux.create).
let _bootBare = false;
let execQueue = Promise.resolve();
let panel = null;
let statusEl = null;
// Persistent IDBDevice handles kept so exportFile() can read guest-written
// files back out (readFileAsBlob). Set during boot when a file provider is
// supplied; null otherwise.
let workspaceDev = null;
let projectDev = null;
// The boot-quip ticker (see boot-messages.js): a setInterval that rotates an
// entertaining "still booting a whole Linux" line onto the caller's
// notification surface while the slow first boot runs. Module-level so both the
// success path and the error handler can stop it.
let bootQuipTimer = null;

/** Start rotating boot quips through `onBootMessage` (no-op without one). */
function startBootQuips(onBootMessage) {
  stopBootQuips();
  if (typeof onBootMessage !== "function") return;
  const rotator = createBootMessageRotator();
  // Tick every second so the elapsed counter visibly moves (a frozen label is
  // what reads as "hung" on iOS). Each tick shows the live progress line
  // (stage + bar + N/6 + seconds) with a quip trailing, swapped every ~3s so it
  // still entertains without churning.
  let quip = rotator.next();
  let n = 0;
  const tick = () => {
    try {
      if (n > 0 && n % 3 === 0) quip = rotator.next();
      n += 1;
      const elapsed = _bootT0 ? Date.now() - _bootT0 : 0;
      onBootMessage(`${formatBootProgress(_bootStage, elapsed)} — ${quip}`);
    } catch { /* decoration — never break the boot */ }
  };
  tick(); // paint immediately, don't wait a full second
  bootQuipTimer = setInterval(tick, 1000);
}

/** Stop the boot-quip ticker (idempotent). */
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

function writeData(buf, vt) {
  if (vt !== 1) return;
  if (term) term.write(new Uint8Array(buf));
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
  if (bootPromise) return bootPromise;
  bootPromise = bootVM(fileProvider, onBootMessage).catch((err) => {
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
 */
export function resetSandbox() {
  try { stopBootWatchdog(); } catch { /* ignore */ }
  try { stopBootQuips(); } catch { /* ignore */ }
  vmState = "off";
  bootPromise = null;
  cx = null;
  _bootBare = false;
  try { if (typeof window !== "undefined") /** @type {any} */ (window).__DR_SANDBOX = null; } catch { /* ignore */ }
  sblog("info", "sandbox.reset", {});
  flushSandboxLog();
}

/**
 * If the current (or in-flight) boot is a BARE pre-warm, discard it so the
 * caller can re-boot with a file-mounting provider. Awaits any in-flight boot
 * to settle FIRST — resetting mid-boot would race the running bootVM against a
 * fresh one. A no-op when idle, or when the live VM already mounted files (a
 * real boot, not a pre-warm). Never throws.
 */
export async function resetSandboxIfBare() {
  if (vmState === "off") return;
  try { if (bootPromise) await bootPromise; } catch { /* settle regardless */ }
  if (_bootBare) resetSandbox();
}

/**
 * @param {(() => Promise<any>) | null} [fileProvider]
 * @param {((msg: string) => void) | null} [onBootMessage]
 */
async function bootVM(fileProvider = null, onBootMessage = null) {
  const t0 = Date.now();
  _bootT0 = t0;
  _bootStage = "boot_start";
  const coi = typeof window !== "undefined" && window.crossOriginIsolated === true;
  const sab = typeof SharedArrayBuffer !== "undefined";
  sblog("info", "sandbox.boot_start", { coi, sab, provider: !!fileProvider, debug: _sbDebug });
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
  startBootQuips(onBootMessage);
  // Arm the stall watchdog now — everything after this point is an await that
  // can hang (CDN scripts, disk fetch, Linux.create). If any never resolves, the
  // watchdog still names the stuck stage and flushes it.
  startBootWatchdog();

  await Promise.all([
    // The xterm stylesheet is purely cosmetic terminal styling — exec needs
    // none of it, so a failed/blocked CSS load must NOT abort the boot (it did:
    // a transient CDN miss on xterm.css took the whole sandbox down with
    // "Sandbox unavailable"). The two SCRIPTS are load-bearing (they define the
    // Terminal/FitAddon globals), so those stay fatal.
    loadCSS(XTERM_CDN + "/css/xterm.css").catch((e) => console.warn("[sandbox] xterm css skipped:", e?.message || e)),
    loadScript(XTERM_CDN + "/lib/xterm.js"),
    loadScript(XTERM_FIT_CDN + "/lib/addon-fit.js"),
  ]);

  const container = panel.querySelector("#dr-sandbox-term");
  // @ts-ignore — Terminal/FitAddon are attached to window by the CDN scripts.
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
  const blockDevice = await CheerpX.CloudDevice.create(DISK_URL);
  const blockCache = await CheerpX.IDBDevice.create(IDB_CACHE_ID);
  const overlayDevice = await CheerpX.OverlayDevice.create(blockDevice, blockCache);

  const mounts = [
    { type: "ext2", dev: overlayDevice, path: "/" },
    { type: "devs", path: "/dev" },
    { type: "devpts", path: "/dev/pts" },
    { type: "proc", path: "/proc" },
    { type: "sys", path: "/sys" },
  ];

  // File mounting (design part B). When a provider is supplied: mount the
  // persistent /workspace volume, the two flat ingest DataDevices, and — if a
  // project is active — its own persistent volume at /mnt/<projname>-<hash>.
  // All fail-soft: any error here leaves the sandbox booting as a bare VM.
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
      const wsDev = await CheerpX.IDBDevice.create(WORKSPACE_DB);
      extra.push({ type: "dir", dev: wsDev, path: "/workspace" });
      const inSession = await CheerpX.DataDevice.create();
      extra.push({ type: "dir", dev: inSession, path: "/mnt/in-s" });
      let inProject = null;
      let projMount = "";
      let projDev = null;
      if (plan && plan.project) {
        projMount = `/mnt/${plan.project.name}-${plan.project.hash}`;
        projDev = await CheerpX.IDBDevice.create("dr-proj-" + plan.project.hash);
        extra.push({ type: "dir", dev: projDev, path: projMount });
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
      workspaceDev = wsDev;
      projectDev = projDev;
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

  // Record whether this boot is bare (no user files/project/source mounted) —
  // a pre-warm always is. See _bootBare / resetSandboxIfBare.
  _bootBare = !fileMount || !!(
    fileMount.plan &&
    fileMount.plan.session.length === 0 &&
    !fileMount.plan.project &&
    !fileMount.plan.source
  );

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
  if (fileMount) {
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

  // Interactive login shell in a loop (re-spawns if the user types exit).
  (async () => {
    while (vmState === "ready") {
      try {
        await cx.run("/bin/bash", ["--login"], {
          env: ["HOME=/root", "TERM=xterm-256color", "USER=root", "SHELL=/bin/bash", "LANG=en_US.UTF-8"],
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
  // The introspection source snapshot: flat pre-bundled files (f0, f1, …)
  // plus its own tree-building seed script, written INTO the device so the
  // (hundreds-of-lines) script never rides in argv.
  if (plan.source && inSource) {
    for (const e of plan.source.entries) {
      await inSource.writeFile("/" + e.flat, e.bytes);
    }
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
  const r = await cx.run("/bin/sh", ["-c", full], {
    env: ["HOME=/root", "TERM=dumb", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    cwd: "/root",
    uid: 0,
    gid: 0,
  });
  sblog("info", "sandbox.fs.seed", {
    exit: r && Number.isFinite(r.status) ? r.status : null,
    project_mount: plan.project ? `/mnt/${plan.project.name}-${plan.project.hash}` : null,
    source_files: plan.source ? plan.source.count : 0,
  });
}

// Read a guest-written file back out into JS (the round-trip export): files
// under /workspace come from the session volume, files under a project mount
// from the project volume. Returns the Blob, or null if unavailable.
/**
 * @param {string} path an absolute guest path under /workspace or /mnt/<proj>
 * @returns {Promise<Blob | null>}
 */
export async function exportFile(path) {
  const p = String(path || "");
  try {
    let blob = null;
    if (p.startsWith("/workspace/") && workspaceDev) {
      blob = await workspaceDev.readFileAsBlob(p.slice("/workspace".length));
    } else if (p.startsWith("/mnt/") && projectDev) {
      // strip the mount prefix: /mnt/<name>-<hash>/rest → /rest
      const rest = p.replace(/^\/mnt\/[^/]+/, "");
      blob = await projectDev.readFileAsBlob(rest || "/");
    }
    sblog("debug", "sandbox.fs.export", { path: p.slice(0, 120), bytes: blob ? blob.size : 0, ok: !!blob });
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

// ---- exec bridge (marker protocol) -----------------------------------------

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
    if (vmState !== "ready" || !cx) return { exitCode: 1, stdout: "", stderr: "sandbox not ready" };
    // Surface the command on the faint page-background activity layer (never
    // throws — it's decoration). "shell" is the default single-agent channel;
    // multiple agents each pass their own id and the layer clips between them.
    feedCommand("shell", command);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const marker = "###EXEC" + id + ":";
    const of = "/tmp/_o" + id;
    const ef = "/tmp/_e" + id;
    // Redirect stdout AND stderr to files, capture $? IMMEDIATELY (before any
    // pipe), THEN base64 the files. The prior form piped stdout into base64
    // and read $? after the pipe, so RC was base64's exit (always 0) — the
    // command's real exit code was lost. /bin/sh here is dash (no PIPESTATUS),
    // so the temp-file form is the correct way to preserve it. The
    // marker+base64 envelope is unchanged (base64 emits no ':' or '#').
    const wrapped =
      "( " + command + " ) >" + of + " 2>" + ef + "; RC=$?; " +
      "O=$(base64 -w0 " + of + " 2>/dev/null); E=$(base64 -w0 " + ef + " 2>/dev/null); " +
      "rm -f " + of + " " + ef + "; " +
      'printf "' + marker + '%s:%s:%d###\\n" "$O" "$E" "$RC"';
    const env = {
      env: ["HOME=/root", "TERM=dumb", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      cwd: "/root",
      uid: 0,
      gid: 0,
    };
    const chunks = [];
    cx.setCustomConsole((buf) => chunks.push(new Uint8Array(buf)), 1024, 24);
    try {
      await cx.run("/bin/sh", ["-c", wrapped], env);
    } finally {
      if (term) cxReadFunc = cx.setCustomConsole(writeData, term.cols, term.rows);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const combined = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { combined.set(c, off); off += c.length; }
    const raw = new TextDecoder().decode(combined);
    const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^:]*):([^:]*):(-?\\d+)###");
    const m = raw.match(re);
    if (!m) return { exitCode: 1, stdout: "", stderr: "exec: marker not found" };
    let stdout = "";
    let stderr = "";
    try { stdout = m[1] ? atob(m[1]) : ""; } catch {}
    try { stderr = m[2] ? atob(m[2]) : ""; } catch {}
    const result = { exitCode: parseInt(m[3], 10), stdout, stderr };
    feedResult("shell", result); // mirror the raw output to the background layer
    return result;
  };
  const next = execQueue.then(run, run);
  execQueue = next.then(() => {}, () => {});
  return next;
}
