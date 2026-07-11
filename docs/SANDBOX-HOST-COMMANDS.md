# Fast host-JS commands inside the Linux sandbox — research + integration design

*Research date: 2026-07-11. Status: DESIGN (nothing implemented yet).*

*This doc covers two related capabilities that share one host→guest device:
(A) **fast host-JS commands** that bypass the emulator, and (B) **mounting the
files a user drops into chat or a project** so the VM can read them. Read (A)
first — (B) builds on the same `/host` `DataDevice`.*

## The problem

The bash-lite execution sandbox (see the **execution-sandbox** skill) boots a
real Debian inside CheerpX — an x86 emulator compiled to WebAssembly. Emulated
x86 is **orders of magnitude slower than native**: `python3 -c` math, hashing,
sorting a large file, or any CPU-bound guest work burns seconds-to-minutes of
wall clock that the same operation would take milliseconds in the page's own
JavaScript engine. The goal: **commands that look like Linux commands to the
model and the transcript, but execute as host-side JavaScript at native
speed** — with results flowing back into the loop (and, where needed, into the
guest filesystem) as if the guest had run them.

## Research findings

### 1. CheerpX has NO guest→host call mechanism (verified through 1.3.5)

Checked against the live docs (cheerpx.io/docs/reference), the CheerpX 1.0
announcement, npm metadata for `@leaningtech/cheerpx`, the `cheerpx-meta`
issue tracker, and the WebVM repo. There is **no hypercall API, no custom
syscall hook, no callback device, no `CheerpX.CustomDevice`, no virtio
channel** in any version through 1.3.5 (npm latest, 2026-06-12; we pin 1.2.6).
There is no public changelog at all (no GitHub releases on cheerpx-meta, no
changelog page), and no open feature request for guest→JS calls.

`cx.registerCallback(eventName, cb)` exists but is **monitoring only**:
`cpuActivity`, `diskActivity`, `diskLatency`, `processCreated` — state
strings/numbers, no guest payload, no return path.
(https://cheerpx.io/docs/reference/CheerpX.Linux/event%20callbacks)

The complete device API, with the official guest/host read-write matrix
(https://cheerpx.io/docs/guides/File-System-support):

| Device | Guest write | Guest read | Host-side API |
|---|---|---|---|
| `WebDevice.create(path)` | no | yes (reads become same-origin HTTP fetches) | — |
| `IDBDevice.create(dbName)` | yes | yes | `readFileAsBlob(path)`, `reset()` — **the only device the host can read guest-written data from** |
| `DataDevice.create()` | no | yes | `writeFile(filename, contents)` — **the only host→guest write path**; in-memory; no exec bit |
| `HttpBytesDevice.create(url)` | no | yes | — (read-only ext2 image over HTTP ranges) |
| `OverlayDevice.create(base, overlay)` | yes | yes | — (overlay must be an IDBDevice; DataDevice as overlay throws — cheerpx-meta #11) |

`cx.run(fileName, args, {env,cwd,uid,gid})` resolves to `{status}` only — no
per-run stdout callback. Output capture is global via
`setCustomConsole(writeFunc, cols, rows) → sendKeyFn` (what `sandbox.js`
already uses).

**Networking is Tailscale-over-WebSockets only** (`networkInterface:
{authKey, controlUrl, loginUrlCb, …}`). No programmatic packet/socket API. The
packet path physically runs in the page (IP packets over a `MessageChannel`
into a Wasm lwIP + Tailscale stack — Leaning Tech engineering blog, 2022), but
that endpoint is not public API. So the "guest connects to a JS-implemented
TCP server" trick that works on v86/container2wasm is **not available** on
CheerpX without unsupported reverse-engineering.

**The vendor's own answer to this problem** is telling: WebVM's Claude
Computer-Use integration (labs.leaningtech.com/blog/webvm-claude, 2025-03)
drives the guest by injecting keystrokes into the terminal and detecting
completion with a `# End of AI command` sentinel string — i.e. even Leaning
Technologies uses sentinel-framed console I/O, not a hypercall. Their only
roadmap hint is a direct *input-event injection* API, nothing about RPC.

**Documented guest↔host channels on CheerpX, exhaustively:**
1. **Console bytes → JS** via `setCustomConsole` (bidirectional: guest tty
   output arrives in our callback; return path is keystroke injection).
2. **Guest writes a file → host reads it** via `IDBDevice.readFileAsBlob`
   (no streaming; read after process exit).
3. **Host writes a file → guest reads it** via `DataDevice.writeFile`
   (in-memory; change-propagation semantics undocumented).

**Licensing note (flag for the operator):** CheerpX's Community License covers
individuals/FOSS/evaluation with attribution, served from the
`cxrtnc.leaningtech.com` CDN. Commercial team/organization use, self-hosting
the runtime, or redistribution require a paid license
(https://cheerpx.io/docs/licensing). We also stream the public WebVM Debian
disk from `disks.webvm.io`. Worth a check before this feature graduates from
"experimental".

### 2. What other browser-VM projects do (the comparison landscape)

- **v86** is the richest: a documented JS-served 9p filesystem
  (`emulator.create_file`/`read_file`, plus a `handle9p` callback processing
  raw 9p messages — a true hostfs seam), serial-port listeners
  (`serial0_send` / `add_listener("serial0-output-byte")`), and a
  JS-terminated network backend. The canonical "run guest command from JS"
  example (`examples/lang.html`) is: command over serial → prompt-sentinel
  detection → bulk result read via 9p. Community demos monkey-patch
  `fs9p.Read` to make synthetic files whose reads return host-generated bytes
  (issue #530) — Plan-9-style file-as-RPC. None of this transfers to CheerpX
  (closed engine, no 9p host API).
- **progrium/env86** is the strongest prior art for the *agent* pattern: a
  guest daemon on a **second serial port** (`/dev/ttyS1`, keeping ttyS0 as
  console) speaking CBOR RPC with the host page — qemu-guest-agent
  transplanted to the browser. Exposes exec, FS, and TCP-dial-into-guest.
- **qemu-guest-agent** is the convergent design everyone reinvents: a guest
  daemon on a dedicated virtio-serial channel with JSON RPC (`guest-exec`,
  `guest-file-read`, …).
- **container2wasm**: guest sockets already terminate in host JS
  (`c2w-net-proxy` forwards guest HTTP via the Fetch API); host FS via
  WASI `--mapdir` → virtio-9p. No documented guest→JS function calls.
- **WebContainers (StackBlitz)** is the inverse architecture — no emulation,
  every Node syscall IS a host function — but proprietary (production
  commercial use is licensed/usage-billed), Node-only (no x86 Linux), and
  even there you cannot register custom host-implemented commands.
- **JSLinux**: closed; guest-initiated `export_file` download command is the
  closest thing; 9p lineage (jor1k) but no public JS API.
- **Puter's Phoenix shell**: notable inverse prior art — a pure-JS shell where
  "Linux commands" are host JS functions *by construction*, with a v86 VM
  attached as one backend. Philosophically exactly what we want, but it
  replaces the shell rather than augmenting a real guest.

**Cross-cutting takeaway:** on an emulator that exposes no hostfs/serial/NIC
seam (CheerpX), the two workable shapes are (a) **host-side orchestration** —
don't enter the VM at all for host-implemented commands — and (b) a
**sentinel-framed console protocol + file drop-boxes** for guest-initiated
calls. Both are exactly the primitives our sandbox already uses.

## The key architectural observation

**Our loop is already host-orchestrated.** The model never types into the VM;
every command flows through `execInSandbox(cmd)` in `public/js/sandbox.js`
(both tiers — DRS `bash-agent.js` and DRC `drc-research.js` inject it as the
loop's `exec`). The host controls the dispatch point *before* any x86 runs.
So for the primary use case — "the model wants X computed fast" — we don't
need guest→host RPC at all. We need a **host command registry consulted in
`execInSandbox` before the VM**: if the command line is a registered host
command, run it as native JS and return a `{exitCode, stdout, stderr}`
shaped exactly like a guest result. The model, the transcript
(`bash-core.js`), the activity UI, and synthesis all see a normal command —
zero changes downstream.

Bonus: a host-command-only session **never boots the VM** (the boot is the
single most expensive step — CDN + disk streaming + kernel boot), because the
interception happens before `ensureReady`/`ensureSandboxBooted` matters.

Guest-initiated RPC (a stub inside a guest pipeline calling out to JS) is
still valuable for composability (`hostcmd | grep …`), and CheerpX gives us
just enough primitives to build it — but it is phase 2, not the core win.

## Integration design

### Phase 1 — the host command registry (the core win; ship first)

**New module `public/js/host-commands.js`** (pure core Node-tested, same
discipline as `bash-core.js`; it must be added to `index.js`'s
`isPublicAsset` allowlist since the /cure module graph will import it):

```js
// Registry: one declarative entry per command (mirrors search-sources.js /
// games.js — the project's registry seam pattern).
// { name, synopsis, promptNote, run(argv, stdinText) → Promise<{exitCode, stdout, stderr}> }
export const HOST_COMMANDS = [ /* … */ ];

// Dispatch decision — deliberately conservative:
// match ONLY when the whole command line is a single plain invocation of a
// registered name: `name arg1 "arg 2"` — NO pipes, redirects, `;`, `&&`,
// `$(…)`, backticks, or env prefixes. Anything else falls through to the VM
// untouched. (A registered name inside a pipeline is a phase-2 concern.)
export function matchHostCommand(commandLine) → { entry, argv } | null;

// POSIX-ish tokenizer for the matched line (quotes, escapes) — pure.
export function tokenizeCommand(line) → string[] | null;  // null = too shelly
```

**Wiring in `sandbox.js`:** at the top of `execInSandbox`'s `run()` (inside
the existing `execQueue` serialization, before the `vmState` check):

```js
const hc = matchHostCommand(command);
if (hc) return runHostCommand(hc, { writeGuestFile });  // never touches cx
```

`runHostCommand` wraps the entry's `run` with a timeout and clamps output via
`normalizeExecResult` semantics (the caps in `bash-core.js` already bound what
enters the transcript). Errors → `{exitCode: 1, stderr}` — the sandbox's
fail-soft contract holds.

**Loop integration:** none needed. `runShellLoop` calls `exec(command)` and
gets a ShellRun-shaped result; `buildShellTranscript` renders it identically.
The only change is **advertising**: `bashAgentPrompt` (src/prompts.js) and
`drcBashAgentPrompt` (public/js/drc-research.js) gain a generated paragraph —
built from the registry's `promptNote`s so prompt and registry can't drift:

> Fast host commands (run instantly, outside the emulator — always put each
> on its own line, never in a pipeline): `js <code>` …, `sha256 <file>`? …

Note `ensureReady` subtlety: `runShellLoop` boots the VM the first time the
model proposes *any* command. To keep the never-boot benefit, the driver's
`ensureReady` should be skipped for rounds whose commands ALL match
`matchHostCommand` — a small change in `bash-core.js`'s loop (check via an
injected `isHostOnly(commands)` predicate to keep the core pure) or simply
accepted as a later optimization (correctness doesn't depend on it).

**The initial command set** (each entry cites the deep-research use case that
motivates it; grow evidence-driven, per invariant 5):

1. **`js '<code>'`** — run JavaScript, print the completion value /
  console.log output. THE general-purpose one; subsumes the "python3 for
  math" pattern at native speed. Security is the design constraint — see
  below.
2. **`sha256` / `md5sum`-alikes over `/host`-materialized text** — crypto.subtle.
3. **`sortbig`, `uniqcount`, `jsonq '<path-expr>'`** — text/JSON crunching on
   large inputs (the guest's sort/jq on emulated x86 is the slow case that
   motivated this research). Input via quoted heredoc-free args or the
   `/host` exchange below.

**Security: host `js` must NOT run in the page context.** Today, arbitrary
model-proposed code executes inside the VM — fully isolated from cookies,
storage, and our authed APIs. A naive `eval` in the page (or a same-origin
Worker) would hand prompt-injected research content a path to the user's
session (cookies ride on same-origin fetch even from a Worker). Design:
execute in a **sandboxed iframe** (`sandbox="allow-scripts"`, `srcdoc`,
opaque origin) → no cookies, no storage, our `/api/*` unreachable
(cross-origin + CORS-less), communication via `postMessage`, watchdog timeout
that removes the iframe. Native JS speed is preserved (it's the same engine).
Two things to live-verify (per the **live-verify** skill): the iframe under
COEP `require-corp` (srcdoc inherits the embedder's policies — expected fine,
but the COEP saga says verify on real Safari), and `postMessage` throughput
for large outputs.

### Phase 1.5 — the `/host` exchange directory (data into the guest)

> **Superseded by part B's approach — no DataDevice needed.** Part B establishes
> that writing into the real filesystem via base64-through-`exec` (the proven
> aisl mechanism) is simpler and has no mid-session caveat. So a host command's
> output destined for a *later* guest command is just
> a Tier-3 base64 write to `/workspace/out/<n>` (the persistent writable volume
> part B adds) — no DataDevice needed.
> The `DataDevice` sketch below is kept only as the rejected alternative.

~~Add a `DataDevice` mount to `CheerpX.Linux.create` in `sandbox.js`:~~

```js
const hostDevice = await CheerpX.DataDevice.create();
mounts: [ …, { type: "dir", dev: hostDevice, path: "/host" } ]
```

- After every host command, `hostDevice.writeFile("/out/<n>", stdout)` so a
  *subsequent guest* command can consume the result
  (`grep foo /host/out/3`). The transcript's `$ ` header lines tell the model
  which file is which; the prompt paragraph documents the convention.
- Symmetrically, guest→host input for host commands: the guest can't write to
  DataDevice, so bulk guest→host input goes through the existing capture path
  (`execInSandbox("cat file")`) or phase 2's IDB drop-box. Phase 1 keeps host
  commands' inputs to their argv.

Caveat to verify live: DataDevice is read-only-from-guest and has **no exec
bit** (documented), and host-write→guest-visibility propagation semantics are
undocumented — confirmed working in the vendor's I/O guide for boot-time
writes, unverified for mid-session writes. If mid-session writes don't
propagate, fall back to materializing via `cx.run("/bin/sh", ["-c", "base64
-d > /tmp/hostout.N"])` piping through the console (slower, always works).

### Phase 2 — guest stubs for pipeline composability (only if evidence demands)

Makes host commands usable INSIDE guest pipelines (`js '…' | sort | head`).
The qemu-ga/env86 pattern adapted to CheerpX's two primitives:

1. At first boot, create stubs in the overlay FS (DataDevice can't hold
   executables): `cx.run("/bin/sh", ["-c", "printf '%s' '<stub>' >
   /usr/local/bin/js && chmod +x …"])`. Stubs persist across sessions via the
   IDB overlay.
2. The stub writes a sentinel-framed request **to `/dev/console`** (NOT
   stdout, so pipes stay clean): `@@DRHOSTCALL <id> <b64(json{cmd,argv,stdin})>@@`.
   Our `setCustomConsole` `writeFunc` already sees every console byte — extend
   it to detect the frame, decode the request, and dispatch to the same
   registry Phase 1 uses. The stub reads its own stdin first (so `… | js '…'`
   works) and includes it in the payload.
3. The host runs the registered handler and returns the framed response over a
   channel the *stub* can read while blocked. Two options, in preference order:
   - **DataDevice poll (preferred):** host `hostDevice.writeFile("/host/resp/<id>",
     b64(json{exitCode,stdout,stderr}))`; the stub spin-polls `cat
     /host/resp/<id>` with a short `sleep` until it appears, prints stdout to
     its own stdout, echoes stderr to fd 2, and `exit`s the code. Clean streams,
     composes in pipelines. Cost: a poll loop inside emulated x86 (cheap — it's
     `sleep`+`cat`, not CPU-bound) and the undocumented mid-session-write
     propagation risk flagged in Phase 1.5 (verify live; if it fails, use the
     keystroke path below).
   - **Keystroke injection (fallback, the WebVM-Claude path):** host feeds the
     response back through the `send()` keycode fn `setCustomConsole` returns.
     Works without DataDevice but collides with the interactive console and is
     slow/awkward for binary — last resort only.
4. Concurrency: reuse the existing `execQueue` serialization so at most one
   host call is in flight; the `<id>` guards against frame interleaving if that
   ever changes.

Phase 2 is real work (a stub shell script, a console-frame parser layered on
the exec marker protocol, live-verification on Safari) and only pays off when
the model genuinely needs a host command *inside* a guest pipeline. Ship it
only if Phase 1 usage shows that need — do not build it speculatively
(invariant 5).

**Ruled out — network-terminated RPC.** The "guest connects to a
JS-implemented TCP server on a loopback IP" trick that works on v86 and
container2wasm is **not available on CheerpX**: networking is Tailscale-only
and the in-page lwIP/MessageChannel packet endpoint is not public API. Don't
pursue it; it would mean reverse-engineering a closed engine and would break on
any CheerpX update.

---

# (B) Mounting chat & project files into the VM

## The problem

Today the sandbox boots a stock Debian and the guest sees **none** of the files
the user attached to the chat or added to a project. A research task like "count
the error lines in this log" or "run this script I uploaded" can't reach the
file at all — the model can only work from the text we already extracted into
the message. We want the dropped files to appear **as real files inside the
VM** (`cat`, `grep`, `python3 analyze.py data.csv`, `wc -l`), read straight
from the browser's own copy — no upload, no server round-trip.

## The mechanism — REAL device mounts, tiered by size (base64 is only the fallback)

Files can be large, so the base64-through-`exec` write (what
`aisecurityliteracy.dev` uses — `echo <b64> | base64 -d > path` batched at boot,
its `vm-tool-runtime.js`/`terminal-panel.js`) is exactly wrong as the primary
path: it inflates every payload ~33% and streams it byte-by-byte through the
console marker protocol. CheerpX has **real device mounts** that pass bytes
directly; we use those and keep base64 only as a fallback for small
writable/executable files.

All device semantics below are from the CheerpX **File-System-support** and
**input-output** guides + the reference (also mirrored verbatim in the aisl
clone under `docs/cheerpx/`), and cross-checked against WebVM's own source.

### Tier 1 — `DataDevice` (default): direct binary bytes, no base64

`DataDevice.create()` + `writeFile(path, Uint8Array | string)`, mounted
read-only into the guest. Binary is first-class — a `Uint8Array` goes in with
**no base64, no console** (note: `ArrayBuffer`/`Blob` are NOT accepted — wrap in
`new Uint8Array(buf)`):

```js
const dataDev = await CheerpX.DataDevice.create();
cx = await CheerpX.Linux.create({
  mounts: [
    { type: "ext2", path: "/",        dev: overlayDevice },
    …
    { type: "dir",  path: "/mnt/data", dev: dataDev },   // ← input files, read-only
  ],
});
await dataDev.writeFile("/server.log", bytesUint8Array);   // guest: cat /mnt/data/server.log
```

- **Read-only in the guest**, which is exactly right for *input* files (logs,
  CSVs, PDFs, datasets). Guest can `cp /mnt/data/x /workspace/x` if it wants a
  writable copy.
- **In-memory**: the bytes live in the JS heap and are **re-supplied every boot**
  (no size limit is documented, but the whole payload sits in page RAM). So this
  tier is for files that comfortably fit memory — proposal: per-file ≤ ~32 MB,
  total ≤ a configurable budget. Their source of truth is the browser's own file
  store (OPFS), so re-supplying each session is free correctness-wise.
- **This is the default real mount** and replaces base64 for read-only inputs.

### Tier 2 — `WebDevice` + a Service Worker: lazy/streamed, for genuinely huge files

For files too big to hold in memory, `WebDevice.create(path)` mounts a
read-only HTTP-backed dir; a guest read of `/mnt/web/foo` becomes a **same-origin
HTTP GET** at `<page-dir>/<path>/foo`. Because those are ordinary same-origin
fetches, a **Service Worker on our origin can intercept them** and synthesize the
bytes on demand — decrypting from OPFS or proxying/streaming from R2 — so a
hundreds-of-MB file never loads up front and only touched bytes transfer.

```js
const webDev = await CheerpX.WebDevice.create("vmfiles");   // → /<page-dir>/vmfiles/*
cx = await CheerpX.Linux.create({
  mounts: [ …, { type: "dir", path: "/mnt/web", dev: webDev } ],
});
// A service worker intercepts fetches under /<page-dir>/vmfiles/ and serves
// decrypted OPFS bytes (honoring Range for real streaming).
```

Requirements (all confirmable, some undocumented — **verify live**):
- The SW **must be registered/active before `Linux.create`** and must serve
  `Content-Type: application/octet-stream` (CheerpX requirement for binary).
- SW responses must satisfy **COEP `require-corp`** — add
  `Cross-Origin-Resource-Policy: same-origin` (our whole isolation story, part A).
- Directory *listing* needs an `index.list` per dir; the SW synthesizes it.
- **SW-backing a WebDevice is architecturally sound (standard fetch semantics)
  but NOT a documented CheerpX feature** — this tier is the one real unknown and
  must be proven on the target browsers before we rely on it. Range support is
  documented only for `HttpBytesDevice`, but a SW can honor `Range` itself.

This is more infrastructure — we have **no service worker today** — so Tier 2 is
the "big files" upgrade, built only once Tier 1's memory ceiling is a real
limit. (WebVM itself mounts read-only sample docs exactly this way, via a
`WebDevice` at `/home/user/documents`.)

### Tier 3 — base64-into-overlay (`/workspace` or `/root/uploads`): the FALLBACK

Kept for two cases only: (a) no Service Worker AND the file is over the
DataDevice memory budget, and (b) the guest needs the file **writable or
executable** (Tiers 1–2 are read-only) — e.g. the model writes a small script
and `chmod +x`es it. Small files only; the base64/console cost is negligible
there, and it lands in the **persistent overlay** so it survives sessions (see
persistence below). This is the aisl mechanism, demoted to fallback:

```js
// unicode-safe; the ONE writable path. Small files only.
'mkdir -p ' + shellEscape(dir) + ' && echo ' + shellEscape(btoa(…)) + ' | base64 -d > ' + shellEscape(path)
```

### Choosing a tier (deterministic, in `sandbox-files.js`)

```
read-only input, fits memory budget            → Tier 1  DataDevice   (/mnt/data)
read-only input, over budget, SW available      → Tier 2  WebDevice+SW (/mnt/web)
needs writable/executable, OR small, OR no SW    → Tier 3  base64       (/workspace or /root/uploads)
```

## Persistence — preserve the overlay FS across sessions

This is already half-solved and the rest is one extra mount.

**The root overlay already persists.** We boot
`OverlayDevice.create(cloudDisk, IDBDevice("deepresearch-sandbox-vm"))`
(`sandbox.js`) — and CheerpX writes **every guest change to `/` into that
IndexedDB layer**, restored on the next load because the `dbName` is stable
(confirmed: the CheerpX docs and the WebVM 2.0 post both state overlay changes
are "saved in an IndexedDB persisted by the browser"). So anything the guest
writes — including Tier-3 files and its own work — **already survives reboots
today**. Make this deliberate: keep the stable id, and never call
`IDBDevice.reset()` except behind an explicit user "reset sandbox" action.

**Add a dedicated persistent workspace volume.** Mount a *second, independently
named* bare `IDBDevice` at `/workspace` so user/guest data persists **separately
from the base-image block cache**:

```js
const workspace = await CheerpX.IDBDevice.create("dr-sandbox-workspace");
cx = await CheerpX.Linux.create({
  mounts: [
    { type: "ext2", path: "/",          dev: overlayDevice },
    { type: "dir",  path: "/mnt/data",  dev: dataDev },     // Tier 1 inputs (ephemeral)
    { type: "dir",  path: "/workspace", dev: workspace },   // persistent user work
  ],
});
```

Why the split: we can upgrade or `reset()` the (large) Debian base cache
**without wiping the user's files**, and offer "clear my workspace" without
re-streaming Debian. Read-write and persistent across sessions.

**Round-trip export (a real bonus for "preserve").** `IDBDevice` exposes
`readFileAsBlob(path)` on the host side — so files the guest creates under
`/workspace` can be **read back out into JS** and saved to the user's project or
offered as a download. The VM stops being a dead-end: work done inside it comes
back. (There is **no** host-side `writeFile` for `IDBDevice` — only DataDevice
has that — so to *seed* `/workspace` from the host you write to `/mnt/data` and
`cp` once, or let the guest write it.)

## Timing — mounts at create, DataDevice writes before the first command

`DataDevice`/`WebDevice`/`IDBDevice` are all passed in the `mounts` array to
`CheerpX.Linux.create`, so the mount points exist from boot. Tier-1 bytes are
written with `dataDev.writeFile(...)` **inside `bootVM()` right after
`Linux.create`, before `ensureSandboxBooted` resolves** — the VM boots lazily on
the model's first command, so every input file is present before any guest
command runs. Tier-2 needs only the SW active before `create`; Tier-3 fallback
writes are boot-time batched exactly as before.

## Where the bytes come from (and decryption)

The client already has every attached file's bytes — the send path and the
project store both key originals in OPFS (`public/js/opfs.js`), and small chat
docs also carry parsed `.text` inline. The mount assembler pulls, per file, the
cheapest readable form:

| Source | Readable bytes | Notes |
|---|---|---|
| Chat doc, small (`att.text` present) | the already-parsed `text` | no decrypt, no re-parse — fastest |
| Chat doc/image, original | `loadOriginal(fileId)` → decrypt with `decryptBytes` when the OPFS meta row's `enc` is set | RAG-indexed docs rest **plaintext** already (no decrypt) |
| Project file | `loadOriginal(entry.id)` (+ decrypt when `enc`) | indexed docs are plaintext; images optional |

The history key that `decryptBytes` needs is the same in-memory key the app
already holds for the session (`public/js/history-store.js`) — no new secret, no
new prompt. If the key is unavailable or a file won't decrypt, that file is
**skipped** (logged), never mounted as garbage.

## Where files land, and the manifest

- **`/mnt/data/`** — the attachments for THIS message + the active project's
  files, Tier-1 mounted (read-only, direct bytes). The primary input set. Huge
  files that go Tier-2 appear here too, under the same tree, from the guest's
  point of view (the mount just differs).
- **`/workspace/`** — persistent, read-write; where the guest does work and
  where Tier-3 writable files land. Survives sessions.
- **`/mnt/data/INDEX.txt`** — a generated manifest (`filename  type  size  tier`
  per line, plus the sanitized on-disk name when it differs) so the model can
  discover what's available with one `cat`.

Filenames are **sanitized** (basename only, path separators/control chars
stripped) and **de-duplicated** (suffix `-2`, `-3` on collision) — the on-disk
name is always safe regardless of tier. Per-file and total **caps** apply
(proposal: Tier-1 per-file ≤ 32 MB and a total memory budget; anything larger
routes to Tier-2 if a SW is available, else is dropped) — a dropped file is
recorded in the manifest as `[not mounted — over budget, no streaming backend]`
so the omission is legible, never silent.

## Making the model use them (prompt awareness)

Extend `bashAgentPrompt` (`src/prompts.js`) and `drcBashAgentPrompt`
(`public/js/drc-research.js`) with a paragraph, emitted only when files were
actually mounted:

> The user's attached files are mounted **read-only** at `/mnt/data/` (run
> `cat /mnt/data/INDEX.txt` to list them). Use them as inputs
> (`cat`/`grep`/`awk`/`python3 analyze.py /mnt/data/data.csv`). To modify a file
> or write your own, work under `/workspace/` (read-write, and it persists) —
> e.g. `cp /mnt/data/x /workspace/x` first.

Without this the model treats the sandbox as empty and never looks.

## Wiring

- **`public/js/sandbox.js`** — mount the extra devices in `bootVM`
  (`DataDevice` at `/mnt/data`, the persistent `IDBDevice` at `/workspace`, and
  — Tier 2 — a `WebDevice` at `/mnt/web` once the SW exists). Add
  `mountFiles(fileProvider)`: pull the file list, route each by tier
  (`sandbox-files.js`), and for Tier 1 call `dataDev.writeFile(path, bytes)`
  directly (binary `Uint8Array`, no base64) right after `Linux.create`, before
  `ensureSandboxBooted` resolves. Keep the Tier-3 base64 batched-write helper as
  the fallback path only. Also export `exportWorkspaceFile(path)` →
  `workspace.readFileAsBlob(path)` for the round-trip-out.
- **DRS (`public/js/stream.js`)** — in `maybeRunShellLoop`, build the provider
  from the pending attachments (already in scope for the send) + the active
  project (`projects.js`), and pass it into `bootOnce → ensureSandboxBooted`.
- **DRC (`public/js/drc-research.js` / `drc.js`)** — same shape, provider built
  from DRC's own attachment/project store (`drc-store.js`).
- **`public/js/sandbox-files.js`** — NEW pure helper (Node-tested,
  `isPublicAsset`-allowlisted, in the /cure import closure): `sanitizeName`,
  `dedupeNames`, `buildManifest`, `applySizeCap`, `chooseTier(file, {swAvailable,
  memBudget})`, and `buildFallbackWriteScript(files)` (the Tier-3 mkdir+base64
  builder) — the deterministic bits, kept out of the browser-only `sandbox.js`.
- **`public/sw.js`** (Tier 2 only, NEW, deferred) — a Service Worker that
  intercepts fetches under the WebDevice path and serves decrypted OPFS / proxied
  R2 bytes with `application/octet-stream` + `Cross-Origin-Resource-Policy:
  same-origin`, honoring `Range`. We have no SW today; this lands only when
  Tier-1's memory ceiling is a real limit.

## Privacy & fail-soft

- **Nothing leaves the browser.** Tier 1 (`DataDevice`) is in-memory in the page;
  Tier 3 writes to the local overlay; Tier 2's Service Worker reads local OPFS
  (or, if it proxies R2, only the user's OWN already-stored ciphertext over the
  authenticated same-origin path — no third party). The bytes are the user's own
  files, decrypted with the key the session already holds, in a VM that runs in
  the page — consistent with invariant 4.
- Every step is **fail-soft**: no OPFS, no key, a decrypt failure, a device
  `writeFile`/mount error, an over-budget file with no streaming backend, or a SW
  that never activates all skip that file (or that tier) and boot proceeds. A
  boot with zero mountable files is byte-identical to today's empty sandbox.

## Live-verification owed (per the live-verify skill)

- **Tier 1:** a `DataDevice` mounted at `/mnt/data` and populated with
  `writeFile(path, Uint8Array)` right after `Linux.create` is **readable in the
  guest** on real iOS Safari under COEP `require-corp` (`cat /mnt/data/INDEX.txt`
  returns the bytes; a binary PDF survives byte-for-byte). WebVM mounts a
  DataDevice this way, but the `credentialless`/Safari saga is the standing
  warning — verify on the real device.
- **Persistence:** a file written to `/workspace` (dedicated `IDBDevice`) is
  still there after a full reload, and `workspace.readFileAsBlob()` reads it back
  out in JS. Confirm `reset()` of the base overlay cache does NOT wipe
  `/workspace`, and vice-versa.
- **Tier 2 (the real unknown):** that a page **Service Worker actually
  intercepts `WebDevice` reads** on our target browsers (Chrome, Firefox, iOS
  Safari) — SW active before `Linux.create`, response `application/octet-stream`
  + `Cross-Origin-Resource-Policy: same-origin` under `require-corp`, and `Range`
  honored for true streaming. This is architecturally sound but undocumented;
  do NOT build Tier 2 on the assumption without a live probe first.
- **Tier 3 fallback:** base64-through-console throughput for a near-budget small
  file, and that it lands in the persistent overlay.

---

## Recommendation

0. **Build (B) file-mounting FIRST**, as **Tier 1 (`DataDevice`) + persistent
   `/workspace`** — it's independently useful, the most-requested-shaped gap ("I
   attached a file, why can't the sandbox see it?"), and low-risk: `DataDevice`
   and the `IDBDevice` overlay are documented, shipped, and used by WebVM itself.
   That's real direct-byte mounts for large-ish files (no base64) plus the
   overlay persistence the user asked for, in a couple of extra mounts + the pure
   `sandbox-files.js` helper + a prompt paragraph. Keep base64 (Tier 3) only as
   the small-writable-file fallback. Add **Tier 2 (WebDevice + Service Worker)**
   later, and only after a live probe confirms SW-backed WebDevice works on the
   target browsers — it's the one unproven piece and it needs a service worker we
   don't yet have.
1. **Build Phase 1** (host command registry + `sandbox.js` interception +
   generated prompt paragraph + the sandboxed-iframe `js` runner). It is the
   whole performance win — native-speed compute *and* skipping the multi-second
   VM boot entirely for host-only sessions — at low, fail-soft, invariant-safe
   cost. Start the registry with just `js '<code>'`; add crunching commands as
   real research tasks show the need.
2. **Add Phase 1.5** (`/host` DataDevice mount) alongside Phase 1 so a host
   command's output can feed a later guest command; live-verify mid-session
   `writeFile` propagation first.
3. **Defer Phase 2** (guest stubs) until Phase 1 telemetry shows pipeline
   composition is actually wanted.
4. **Do not** attempt a CheerpX guest→host hypercall — none exists through
   1.3.5, there is no feature request, and the engine is closed-source. If one
   ever becomes essential, the only route is asking Leaning Technologies
   directly (Discord), not reverse-engineering.

### Security checklist (the load-bearing constraint)

The `js` command runs model-proposed code, and the model's input includes
web-search content that may be prompt-injected. Today that code is contained by
the CheerpX VM. Moving it host-side MUST preserve equivalent isolation:

- Execute in a **sandboxed iframe** (`sandbox="allow-scripts"` only, `srcdoc`,
  opaque origin) — no cookies, no same-origin storage, our `/api/*`
  unreachable (cross-origin, CORS-less). Never `eval` in the page and never a
  same-origin Worker (same-origin fetch carries the session cookie).
- Per-call **watchdog timeout** that tears down the iframe; clamp output to the
  `bash-core.js` caps.
- No network by default — the sandbox is presented as OFFLINE to the model;
  a host `js` that could `fetch()` would cross the privacy boundary (invariant
  4: outbound requests carry the minimum, never conversation content). Keep
  host commands pure-compute/local unless a specific, reviewed exception is
  added.

### Live-verification owed before this ships (per the live-verify skill)

- Sandboxed-iframe `js` runner under COEP `require-corp` on **real iOS Safari**
  (the `credentialless` saga is the standing warning that Chrome passing proves
  nothing).
- `postMessage` throughput for large `js` outputs vs the 4000-char clamp.
- `DataDevice.writeFile` **mid-session** visibility inside the guest (Phase 1.5)
  — documented only for boot-time writes.
- DRC `/cure` parity: `host-commands.js` must be in the `isPublicAsset`
  allowlist and the /cure module-graph import-closure walk (execution-sandbox
  skill) must stay clean, or the whole public tier goes dark.

## Files this touches (when implemented)

| File | Change | For |
|---|---|---|
| `public/js/sandbox.js` | mount `DataDevice`→`/mnt/data` + persistent `IDBDevice`→`/workspace` (and later `WebDevice`→`/mnt/web`); `mountFiles(fileProvider)` (Tier-1 `dataDev.writeFile` direct bytes, Tier-3 base64 fallback); `exportWorkspaceFile`; intercept in `execInSandbox` before the VM; the sandboxed-iframe `js` runner | A+B |
| `public/js/sandbox-files.js` | NEW — pure `sanitizeName`/`dedupeNames`/`buildManifest`/`applySizeCap`/`chooseTier`/`buildFallbackWriteScript`; Node-tested (`sandbox-files.test.js`) | B |
| `public/sw.js` | NEW (Tier 2, deferred) — Service Worker backing the WebDevice: serves decrypted OPFS / proxied R2 bytes as `application/octet-stream` + CORP, honoring `Range` | B |
| `public/js/host-commands.js` | NEW — registry + `matchHostCommand`/`tokenizeCommand`/`runHostCommand`; pure core Node-tested (`host-commands.test.js`) | A |
| `public/js/stream.js` | DRS: assemble the file provider (attachments + active project) and pass to `bootOnce` | B |
| `public/js/drc-research.js` | DRC: assemble the file provider from `drc-store`; `drcBashAgentPrompt` gains the host-command + mount paragraphs | A+B |
| `src/prompts.js` | `bashAgentPrompt` gains the host-command paragraph and the (conditional) mount paragraph | A+B |
| `src/index.js` | add `host-commands.js` and `sandbox-files.js` to `isPublicAsset` | A+B |
| `public/js/bash-core.js` | (optional) `isHostOnly` predicate so a host-only round skips `ensureReady` and never boots the VM | A |
| docs / execution-sandbox skill | document both capabilities once they ship | A+B |