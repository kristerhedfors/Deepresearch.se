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

> The `/host` `DataDevice` this phase adds is the **same device** part B mounts
> for user files (`/host/files/…` alongside `/host/out/…`). Build the mount once
> (part B's boot-time populate covers the create + mount); this phase only adds
> the mid-session `writeFile("/out/<n>", …)` after each host command.

Add a `DataDevice` mount to `CheerpX.Linux.create` in `sandbox.js`:

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

## The mechanism (documented, shipped — same device as `/host`)

`CheerpX.DataDevice` is the **only documented host→guest write path** (see the
device matrix in part A): `DataDevice.create()` then
`writeFile(path, string | Uint8Array)`, mounted read-only into the guest:

```js
const hostDevice = await CheerpX.DataDevice.create();
cx = await CheerpX.Linux.create({
  mounts: [
    { type: "ext2", dev: overlayDevice, path: "/" },
    …
    { type: "dir", dev: hostDevice, path: "/host" },   // ← the exchange mount
  ],
});
// Populate BEFORE the first command runs (see timing below):
await hostDevice.writeFile("/files/server.log", bytesUint8Array);
await hostDevice.writeFile("/files/INDEX.txt", manifestText);
// guest: cat /host/files/server.log   →   the real bytes
```

The guest can **read** these (`cat`/`grep`/`awk`/`python3`), cannot **write**
them, and there is **no exec bit** (documented) — so `python3 /host/files/x.py`
works (python reads the file) but `/host/files/x.sh` won't run directly; the
model must invoke it through an interpreter. This is the same `hostDevice` part
A mounts for host-command output, so **one `/host` device serves both**:
`/host/files/…` (mounted user files) and `/host/out/…` (host-command results).

**Why this is the right primitive (not IDBDevice/WebDevice/OverlayDevice):**
IDBDevice is for *guest→host* readback and would mean seeding an IndexedDB blob
store; WebDevice serves reads as same-origin HTTP fetches (extra machinery, and
it can't take in-memory bytes); the overlay is the persistent root we already
have. DataDevice takes JS bytes directly and is purpose-built to "expose
JavaScript data in the VM" — exactly this.

## Timing — populate at boot, before the first command

DataDevice's **mid-session** `writeFile` propagation is undocumented (flagged in
part A). We sidestep it entirely: the VM boots **lazily** on the model's first
proposed command (`ensureSandboxBooted`), and the attached files are known at
send time — *before* the loop starts. So we write every file into the
DataDevice **inside `bootVM()`, right after `CheerpX.Linux.create`, before
`ensureSandboxBooted` resolves**. Every file is present before any guest command
runs, so we only ever rely on the documented boot-time-write behavior, never the
uncertain mid-session path.

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

## What gets mounted, and the manifest

- **`/host/files/`** — the attachments for THIS message (what the user just
  dropped): the primary, always-mounted set.
- **`/host/project/`** — the active project's files, when a project is open.
  Capped harder (a project can hold many/large files); prefer the
  extracted-text form for parsable docs to keep the mount small, write originals
  only for small files.
- **`/host/files/INDEX.txt`** — a generated manifest (`filename  type  size`
  per line, plus the sanitized on-disk name when it differs) so the model can
  discover what's available with one `cat` instead of guessing names.

Filenames are **sanitized** (basename only, path separators stripped, control
chars removed) and **de-duplicated** (suffix `-2`, `-3` on collision). Total
mounted bytes are **capped** (proposal: 8 MB for `/host/files`, 8 MB for
`/host/project`, matching the 25 MB per-file input sanity cap with headroom) —
when the cap is hit, the largest files are dropped and the manifest records
`[not mounted — over size cap]` so the omission is legible, never silent
(invariant-style: no silent truncation).

## Making the model use them (prompt awareness)

Extend `bashAgentPrompt` (`src/prompts.js`) and `drcBashAgentPrompt`
(`public/js/drc-research.js`) with a mount paragraph, emitted only when files
are actually mounted:

> The user's attached files are mounted **read-only** at `/host/files/`
> (and any open project's files at `/host/project/`). Run
> `cat /host/files/INDEX.txt` to see them. Read them as inputs
> (`cat`/`grep`/`awk`/`python3 - < …`); you cannot write there and scripts
> aren't executable — run them through an interpreter.

Without this the model treats the sandbox as empty and never looks.

## Wiring

- **`public/js/sandbox.js`** — `ensureSandboxBooted(fileProvider?)` /
  `bootVM(fileProvider)`: create the `hostDevice`, add the `/host` mount, and
  after `CheerpX.Linux.create` `await`-write every file the provider yields
  (fail-soft per file). `fileProvider` is an async `() => Promise<Array<{path,
  bytes, name, type, size}>>` so the two tiers assemble their own file lists
  without `sandbox.js` importing either storage stack.
- **DRS (`public/js/stream.js`)** — in `maybeRunShellLoop`, build the provider
  from the pending attachments (already in scope for the send) + the active
  project (`projects.js`), and pass it into `bootOnce → ensureSandboxBooted`.
- **DRC (`public/js/drc-research.js` / `drc.js`)** — same shape, provider built
  from DRC's own attachment/project store (`drc-store.js`).
- **`public/js/sandbox-files.js`** — NEW pure helper (Node-tested,
  `isPublicAsset`-allowlisted, in the /cure import closure): `sanitizeName`,
  `dedupeNames`, `buildManifest`, `applySizeCap` — the deterministic bits, kept
  out of the browser-only `sandbox.js`.

## Privacy & fail-soft

- **Nothing leaves the browser.** DataDevice is in-memory in the page; the bytes
  are the user's own files, already in their browser, decrypted with the key the
  session already holds, written into a VM that also runs in the page. No new
  network, no third party — consistent with invariant 4 (outbound requests carry
  the minimum; here there are none).
- Every step is **fail-soft**: no OPFS, no key, a decrypt failure, a `writeFile`
  error, or an over-cap file all skip that file and boot proceeds. A boot with
  zero mountable files is byte-identical to today's empty sandbox.

## Live-verification owed (per the live-verify skill)

- A `DataDevice` mount populated at boot is **readable in the guest** on real
  iOS Safari under COEP `require-corp` (`cat /host/files/INDEX.txt` returns the
  bytes) — the `credentialless`/Safari saga is the standing warning.
- `writeFile` **throughput** for a near-cap set (does an 8 MB mount add
  noticeable boot latency?).
- Read-only + no-exec is confirmed fine for our read-only use (scripts via
  interpreter, not `chmod +x`).

## Bytes-into-the-guest, symmetric note

This is the clean, general version of part A's Phase 1.5 (host-command output →
`/host/out/…`): the same device, populated at boot instead of mid-session.
Where part A needed mid-session writes (a host command's result feeding a *later*
guest command), the same live-verify caveat applies; file mounting avoids it by
being boot-time only.

---

## Recommendation

0. **Build (B) file-mounting** — it is independently useful (it needs neither
   the host-command registry nor guest stubs; it's ~one DataDevice mount + a
   boot-time write loop + a prompt paragraph) and is the most-requested-shaped
   gap: "I attached a file, why can't the sandbox see it?". Ship it alongside or
   before Phase 1.
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
| `public/js/sandbox.js` | `/host` DataDevice mount; boot-time file writes (`fileProvider`); intercept in `execInSandbox` before the VM; the sandboxed-iframe `js` runner | A+B |
| `public/js/sandbox-files.js` | NEW — pure `sanitizeName`/`dedupeNames`/`buildManifest`/`applySizeCap`; Node-tested (`sandbox-files.test.js`) | B |
| `public/js/host-commands.js` | NEW — registry + `matchHostCommand`/`tokenizeCommand`/`runHostCommand`; pure core Node-tested (`host-commands.test.js`) | A |
| `public/js/stream.js` | DRS: assemble the file provider (attachments + active project) and pass to `bootOnce` | B |
| `public/js/drc-research.js` | DRC: assemble the file provider from `drc-store`; `drcBashAgentPrompt` gains the host-command + mount paragraphs | A+B |
| `src/prompts.js` | `bashAgentPrompt` gains the host-command paragraph and the (conditional) mount paragraph | A+B |
| `src/index.js` | add `host-commands.js` and `sandbox-files.js` to `isPublicAsset` | A+B |
| `public/js/bash-core.js` | (optional) `isHostOnly` predicate so a host-only round skips `ensureReady` and never boots the VM | A |
| docs / execution-sandbox skill | document both capabilities once they ship | A+B |