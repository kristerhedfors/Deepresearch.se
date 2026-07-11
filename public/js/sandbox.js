// The experimental in-browser Linux execution sandbox (the `bash_lite_mcp`
// knob). NOT type-checked (no `// @ts-check`): this is browser/CheerpX glue —
// dynamic CDN imports, xterm globals, WASM VM handles — with no meaningful
// static type surface. The pure, testable logic lives in bash-agent.js.
//
// A JavaScript x86 emulator (CheerpX) boots a small Debian Linux
// ENTIRELY IN THIS BROWSER — the server never runs a shell. This module owns
// the VM lifecycle and exposes two things the rest of the app uses:
//
//   - a floating terminal panel (xterm.js) the user can open to watch (and
//     type into) the live shell, and
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
// testable logic lives in public/js/bash-agent.js instead.

const XTERM_CDN = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0";
const XTERM_FIT_CDN = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0";
const CHEERPX_CDN = "https://cxrtnc.leaningtech.com/1.2.6/cx.esm.js";
// The public WebVM Debian disk (streamed over WebSocket, cached in IndexedDB).
const DISK_URL = "wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2";
const IDB_CACHE_ID = "deepresearch-sandbox-vm";

/** @type {'off'|'booting'|'ready'|'error'} */
let vmState = "off";
let cx = null;
let term = null;
let fitAddon = null;
let cxReadFunc = null;
/** @type {Promise<boolean> | null} */
let bootPromise = null;
let execQueue = Promise.resolve();
let panel = null;
let statusEl = null;

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
 * Shows the terminal panel so the user sees progress and the live shell.
 * @returns {Promise<boolean>}
 */
export function ensureSandboxBooted() {
  if (bootPromise) return bootPromise;
  bootPromise = bootVM().catch((err) => {
    console.error("[sandbox] boot failed", err);
    setStatus("error");
    return false;
  });
  return bootPromise;
}

async function bootVM() {
  if (!sandboxSupported()) {
    setStatus("error");
    return false;
  }
  buildPanel();
  showSandbox();
  setStatus("booting");

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

  setStatus("starting Linux…");
  cx = await CheerpX.Linux.create({
    mounts: [
      { type: "ext2", dev: overlayDevice, path: "/" },
      { type: "devs", path: "/dev" },
      { type: "devpts", path: "/dev/pts" },
      { type: "proc", path: "/proc" },
      { type: "sys", path: "/sys" },
    ],
  });

  cxReadFunc = cx.setCustomConsole(writeData, term.cols, term.rows);
  setStatus("ready");
  vmState = "ready";

  // Expose the bridge for the agent loop and any test harness.
  window.__DR_SANDBOX = { ready: true, exec: execInSandbox };

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
    return { exitCode: parseInt(m[3], 10), stdout, stderr };
  };
  const next = execQueue.then(run, run);
  execQueue = next.then(() => {}, () => {});
  return next;
}
