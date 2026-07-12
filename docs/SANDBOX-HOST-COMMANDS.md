# Fast host-JS commands inside the Linux sandbox — research + integration design

*Research date: 2026-07-11. Status: part (A) host-commands = DESIGN;
part (B) file-mounting = **Tier 1 + persistence IMPLEMENTED for DRS**
(2026-07-11) — `sandbox-files.js` + `sandbox.js` mounts/seed +
`stream.js` provider; Tier 2 (WebDevice+SW) and DRC wiring still pending.
Live browser verification still owed (see the checklist).*

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

## Layout — where files live inside the VM

Two distinct file sets. Session files live in a folder; the project is its own
**mount** (under `/mnt`, so it's obvious it's a mounted volume), reached from the
session by a friendly symlink:

```
/workspace/                              ← THIS chat session's files (attachments) + guest scratch. RW, persistent.
/workspace/INDEX.txt                     ← generated manifest of what's mounted
/workspace/<projname>  ->  /mnt/<projname>-<hash>   ← friendly symlink (NO hash) to the project mount
/mnt/<projname>-<hash>/                  ← the ACTIVE project, its OWN mounted persistent volume. RW.
```

- **Session files** (the chat's own attachments) live directly in `/workspace`.
- **The project** is a **mount at `/mnt/<projname>-<hash>`** — its own persistent
  volume. `<projname>` is the sanitized project name; `<hash>` is a short stable
  hash of the project id, so the path is unique (two projects sharing a name
  don't collide), stable across sessions (same project → same mount), and
  visibly a mount. The real project id is also in
  `/mnt/<projname>-<hash>/.projectid` and the manifest.
- The session reaches it at the clean path **`/workspace/<projname>`** (no hash)
  via a symlink (`ln -sfn /mnt/<projname>-<hash> /workspace/<projname>`), so the
  model refers to the project by its plain name.

Both `/workspace` and the project mount are **persistent** (see Persistence
below), so project files — and any work the guest does — survive across sessions.

## The mechanism — REAL device mounts, tiered ingest (base64 is only the fallback)

Two layers, kept separate:

1. **Where files LIVE** — `/workspace` (session) and the project mount
   `/mnt/<projname>-<hash>` are **persistent read-write `IDBDevice` volumes**
   (below). This is what the model reads and writes.
2. **How host bytes GET there** — `IDBDevice` has **no host-side `writeFile`**
   (only `DataDevice` does), so host bytes transit an **ingest mount** and are
   `cp`'d into the persistent tree at boot. The ingest mount is chosen by size:
   `DataDevice` (direct bytes, default), `WebDevice`+SW (huge/lazy), or base64
   (small fallback). Files can be large, so the base64-through-`exec` write (what
   `aisecurityliteracy.dev` uses) is only the fallback — it inflates payloads
   ~33% and streams byte-by-byte through the console.

All device semantics below are from the CheerpX **File-System-support** and
**input-output** guides + the reference (also mirrored verbatim in the aisl
clone under `docs/cheerpx/`), and cross-checked against WebVM's own source.

Ingest uses two `DataDevice` scratch mounts the model never touches directly —
`/mnt/in-s` (session files) and `/mnt/in-p` (project files) — plus a third,
`/mnt/in-src`, for the developer-mode source tree that mounts at `/src`. At boot
a small seed script `cp`s `/mnt/in-s` into `/workspace` (every boot, `cp -a`) and
`/mnt/in-p` into the project mount `/mnt/<projname>-<hash>` (add/update-only,
`cp -an`, so the guest's own edits aren't clobbered), then makes the
`/workspace/<projname>` symlink. Ingest bytes never go through base64 unless they
must (Tier 3).

### Tier 1 — `DataDevice` ingest (default): direct binary bytes, no base64

`DataDevice.create()` + `writeFile(path, Uint8Array | string)`, one device per
ingest mount (`/mnt/in-s`, `/mnt/in-p`). Binary is first-class — a `Uint8Array`
goes in with **no base64, no console** (note: `ArrayBuffer`/`Blob` are NOT
accepted — wrap in `new Uint8Array(buf)`):

```js
const inSession = await CheerpX.DataDevice.create();
const inProject = await CheerpX.DataDevice.create();
cx = await CheerpX.Linux.create({
  mounts: [
    { type: "ext2", path: "/",                         dev: overlayDevice },
    { type: "dir",  path: "/workspace",                dev: workspaceIdb },  // persistent RW
    { type: "dir",  path: `/mnt/${projName}-${hash}`,  dev: projectIdb },    // persistent RW, the project mount
    { type: "dir",  path: "/mnt/in-s",                 dev: inSession },     // session ingest, read-only
    { type: "dir",  path: "/mnt/in-p",                 dev: inProject },     // project ingest, read-only
    …
  ],
});
await inSession.writeFile("/server.log", bytesUint8Array);   // → cp'd to /workspace/server.log
await inProject.writeFile("/notes.md",   bytesUint8Array);   // → cp'd to /mnt/<projname>-<hash>/notes.md
```

- **In-memory**: bytes live in the JS heap, **re-supplied every boot** (no
  documented size limit, but the payload sits in page RAM). For files that fit
  memory — proposal: per-file ≤ ~32 MB, total ≤ a configurable budget. Their
  source of truth is the browser's own store, so re-supplying each session is
  free correctness-wise; the persistent COPY in `/workspace` / the project mount
  is what the guest edits.
- **This is the default ingest** and replaces base64 for the common case.

### Tier 2 — `WebDevice` + a Service Worker ingest: lazy/streamed, for genuinely huge files

For files too big to hold in memory, mount `WebDevice.create(path)` at
`/mnt/in-web`; a guest read there becomes a **same-origin HTTP GET** at
`<page-dir>/<path>/…`. Because those are ordinary same-origin fetches, a
**Service Worker on our origin can intercept them** and synthesize the bytes on
demand — decrypting from OPFS or proxying/streaming from R2 — so a
hundreds-of-MB file never loads up front and only touched bytes transfer. Then
`cp`/symlink into the tree (for a truly huge file, prefer symlinking
`/workspace/big.bin -> /mnt/in-web/big.bin` so it stays lazy rather than copying
it into IDB).

Requirements (some undocumented — **verify live**):
- SW **active before `Linux.create`**, responses `Content-Type:
  application/octet-stream` + `Cross-Origin-Resource-Policy: same-origin` (COEP
  `require-corp`), directory listing via a synthesized `index.list`, `Range`
  honored for real streaming.
- **SW-backing a WebDevice is architecturally sound but NOT documented** — the
  one real unknown; prove it on the target browsers before relying on it. We have
  **no service worker today**, so Tier 2 is the "big files" upgrade built only
  once Tier 1's memory ceiling bites. (WebVM mounts read-only docs via a
  `WebDevice` at `/home/user/documents`.)

#### Tier 2 roadmap — what it buys, and when it's worth building

Tier 2 buys exactly one thing Tier 1 fundamentally cannot do: **files bigger
than the page can hold in memory, read lazily.** Everything else follows.

**What you gain over Tier 1 (DataDevice):**

| | Tier 1 (DataDevice) | Tier 2 (WebDevice + SW) |
|---|---|---|
| Where bytes live | whole payload in the JS heap + the cp'd copy | nothing in memory until read |
| Size ceiling | ~page RAM (we cap 32 MB/file, 64 MB total) | bounded by the SOURCE (OPFS/R2), not RAM |
| Read cost | every byte loaded + written at boot, used or not | only the touched bytes transfer, on demand |
| Boot latency | pays for all files up front before ready | mounts instantly; I/O deferred to first read |

Concretely it enables: large inputs (a 500 MB log / dataset / sqlite), **partial
reads** (`head -c 1M big.csv`, `tail`, seeking, a short-circuiting `grep` — only
the read range moves), fast boot with many/large project files (unread files
cost nothing), and streaming a file straight from **R2** without downloading it
whole first.

**What it does NOT add** (so it isn't over-valued): still **read-only** (writing
/executing stays the base64→overlay fallback's job); **not persistence** (that's
the IDBDevice volumes, orthogonal to tier); and **no benefit for small files** —
anything under the Tier-1 budget is simpler and just as fast on DataDevice.

**The real wrinkle — encryption undercuts the laziness for OUR files.** OPFS
originals rest as whole-blob AES-GCM, which is **not seekable**: a SW answering a
`Range` would have to decrypt the *entire* file anyway, losing the lazy win —
unless big files are re-stored in seekable, chunk-encrypted form. So Tier 2's
payoff is cleanest for **plaintext** sources (RAG-indexed docs rest readable) or
**R2-proxied** content, and weakest for encrypted originals. **First target when
we build it: large plaintext files, not encrypted originals.**

**Costs / prerequisites** (why it's deferred): a **Service Worker we don't have**
(registration + lifecycle; must be active before `Linux.create`); the
**undocumented** SW-intercepts-WebDevice behavior proven live on Chrome/Firefox/
iOS Safari; COEP `require-corp` compliance (CORP + `octet-stream` on SW
responses); `Range` handling in the SW; and a synthesized `index.list` for
directory listing.

**Build trigger:** only once real usage hits the Tier-1 memory ceiling
(attachments/project files in the tens-to-hundreds of MB). Until then Tier 1
covers the common case; do not build Tier 2 speculatively (invariant 5).

### Tier 3 — base64-through-`exec`: the small-file FALLBACK

Kept only for: no Service Worker AND over the DataDevice budget, or a tiny file
where it's simplest. Writes straight into the persistent tree (`/workspace/…` or
`/mnt/<projname>-<hash>/…`) — no ingest+cp needed. The aisl mechanism, demoted:

```js
'mkdir -p ' + shellEscape(dir) + ' && echo ' + shellEscape(btoa(…)) + ' | base64 -d > ' + shellEscape(path)
```

### Choosing a tier (deterministic, in `sandbox-files.js`)

```
fits memory budget                       → Tier 1  DataDevice ingest → cp into tree   (default)
over budget, SW available                 → Tier 2  WebDevice+SW ingest → cp/symlink
over budget, no SW  (or tiny convenience)  → Tier 3  base64 straight into the tree
```

Everything lands in `/workspace` or the project mount `/mnt/<projname>-<hash>`
regardless of tier — the tier is only *how the bytes arrive*, never where they
live.

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

**One persistent volume per file set, each a separately named bare `IDBDevice`**:
`/workspace` (session) and the project mount `/mnt/<projname>-<hash>`, so session
and project data persist **independently of the base-image block cache and of
each other**:

```js
const workspaceIdb = await CheerpX.IDBDevice.create("dr-sandbox-workspace");
const projectIdb   = await CheerpX.IDBDevice.create(`dr-proj-${hash}`);  // stable per-project db name
// … mounted at /workspace and /mnt/<projname>-<hash> (see the Tier-1 snippet).
```

`<hash>` is derived from the project id (stable), so the SAME project reuses the
SAME IndexedDB across sessions and its files persist; a different project is a
different db + mount. Why separate: we can `reset()` the (large) Debian base
cache **without wiping user files**, offer "clear session"
(`workspaceIdb.reset()`) distinctly from "clear this project"
(`projectIdb.reset()`), and re-stream Debian without touching either. (Only the
active project is mounted per session; other projects rest untouched in their own
dbs until opened.)

**Boot seed + symlink** (the one script, after `Linux.create`, before ready):

```sh
mkdir -p /workspace "/mnt/<projname>-<hash>"
cp -a  /mnt/in-s/.  /workspace/               2>/dev/null || true   # session ingest → /workspace (refresh)
cp -an /mnt/in-p/.  "/mnt/<projname>-<hash>/" 2>/dev/null || true   # project ingest → project mount (add/update-only)
printf '%s' "<projectId>" > "/mnt/<projname>-<hash>/.projectid"
ln -sfn "/mnt/<projname>-<hash>" "/workspace/<projname>"                  # friendly no-hash symlink
```

Seed policy (a decision, defaulted): **session** files are refreshed every boot
(the chat's current attachments are the truth). **Project** files are synced
add/update-only (`cp -an`) — new/changed files copied in, guest-created files in
the project mount left intact — so work done in the VM isn't clobbered by a
re-seed.

**Round-trip export (a real bonus for "preserve").** `IDBDevice.readFileAsBlob(path)`
reads guest-created files back into JS — so a report the model writes to
`/workspace`, or a file it adds under the project mount, can be **pulled back
out** and saved to the user's project or offered as a download. The VM stops
being a dead-end. (There is **no** host-side `IDBDevice.writeFile` — only
`DataDevice` has it — which is exactly why host bytes ingest through `/mnt/in`
and are `cp`'d in.)

## Timing — mounts at create, ingest + seed before the first command

All devices are passed in the `mounts` array to `CheerpX.Linux.create`, so mount
points exist from boot. **Inside `bootVM()`, right after `Linux.create` and
before `ensureSandboxBooted` resolves**: `inDev.writeFile(...)` the Tier-1 bytes,
then run the seed+symlink script above. The VM boots lazily on the model's first
command, so `/workspace`, the project mount `/mnt/<projname>-<hash>`, and the
`/workspace/<projname>` symlink are all populated before any guest command runs.
Tier-2 needs the SW active before `create`; Tier-3 writes straight into the tree
in the same boot step.

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

Per the Layout section: **`/workspace/`** (session files + guest scratch, RW,
persistent), the project mount **`/mnt/<projname>-<hash>/`** (RW, persistent), and
the **`/workspace/<projname>`** symlink to it. The manifest lives at
**`/workspace/INDEX.txt`** (`scope  filename  type  size  tier` per line, scope ∈
`session|project`, plus the sanitized on-disk name when it differs) so the model
discovers everything — session AND project — with one `cat`.

Filenames are **sanitized** (basename only, path separators/control chars
stripped) and **de-duplicated** within each folder (suffix `-2`, `-3` on
collision). `<projname>` is sanitized for the path; `<hash>` (from the project
id) makes the mount unique and stable. Per-file and total **caps** apply
(proposal: Tier-1 per-file ≤ 32 MB and a total memory budget; larger routes to
Tier-2 if a SW is available, else is dropped) — a dropped file is recorded in the
manifest as `[not mounted — over budget, no streaming backend]` so the omission
is legible, never silent.

## Making the model use them (prompt awareness)

Extend `bashAgentPrompt` (`src/prompts.js`) and `drcBashAgentPrompt`
(`public/js/drc-research.js`) with a paragraph, emitted only when files were
actually mounted:

> This chat's attached files are in `/workspace/` and the current project's
> files in `/workspace/<projname>/` (a symlink to its mount under `/mnt/`). Run
> `cat /workspace/INDEX.txt` to list everything. All of it is read-write and
> persists across sessions — read files as inputs
> (`cat`/`grep`/`awk`/`python3 analyze.py /workspace/data.csv`), and write your
> own results there too.

Without this the model treats the sandbox as empty and never looks.

## Wiring

- **`public/js/sandbox.js`** — in `bootVM`, mount the session volume
  (`IDBDevice("dr-sandbox-workspace")`→`/workspace`), the active project's volume
  (`IDBDevice(\`dr-proj-${hash}\`)`→`/mnt/<projname>-<hash>`), and the ingest
  `DataDevice`→`/mnt/in` (and — Tier 2 — a `WebDevice`→`/mnt/in-web` once the SW
  exists). Add `mountFiles(fileProvider)`: pull the file list (each item tagged
  `scope: "session"|"project"`; provider also yields the sanitized
  `projName`/`projId`/`hash`), route each by tier (`sandbox-files.js`),
  `inDev.writeFile("/session/…" | "/project/…", bytes)` for Tier 1 (binary
  `Uint8Array`, no base64), then run the seed+symlink script — all right after
  `Linux.create`, before `ensureSandboxBooted` resolves. Tier-3 base64 writes
  straight into the tree. Also export `exportFile(path)` →
  `(path.startsWith("/mnt/") ? projectIdb : workspaceIdb).readFileAsBlob(path)`
  for the round-trip-out.
- **DRS (`public/js/stream.js`)** — in `maybeRunShellLoop`, build the provider
  from the pending attachments (scope `session`) + the active project's files
  (scope `project`, `projects.js`), and pass it into `bootOnce →
  ensureSandboxBooted`.
- **DRC (`public/js/drc-research.js` / `drc.js`)** — same shape, provider built
  from DRC's own attachment/project store (`drc-store.js`).
- **`public/js/sandbox-files.js`** — NEW pure helper (Node-tested,
  `isPublicAsset`-allowlisted, in the /cure import closure): `sanitizeName`,
  `sanitizeProjName`, `dedupeNames`, `buildManifest`, `applySizeCap`,
  `chooseTier(file, {swAvailable, memBudget})`, `projHash(projId)` (the stable
  short hash), `buildSeedScript({projName, projId, hash})` (the mkdir + `cp -a`/
  `cp -an` + `ln -sfn` builder), and `buildFallbackWriteScript(files)` (Tier-3) —
  the deterministic bits, kept out of the browser-only `sandbox.js`.
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

- **Tier 1 + seed:** a `DataDevice`→`/mnt/in` populated with `writeFile(path,
  Uint8Array)` then `cp`'d into `/workspace` and the project mount
  `/mnt/<projname>-<hash>` is **readable in the guest** on real iOS Safari under
  COEP `require-corp` (`cat /workspace/INDEX.txt`; a binary PDF survives
  byte-for-byte), and `/workspace/<projname>` resolves through the symlink to the
  project mount. WebVM mounts a DataDevice this way, but the
  `credentialless`/Safari saga is the standing warning — verify on the real device.
- **Persistence:** a file written to `/workspace` and one under
  `/mnt/<projname>-<hash>` are both still there after a full reload (the project's
  `dr-proj-<hash>` db reused), and `readFileAsBlob()` reads them back out. Confirm
  `reset()` of the base overlay cache does NOT wipe either volume, that session
  and project dbs are independent, and that the cross-mount symlink
  (`/workspace/<projname>` → `/mnt/…`) resolves after a reboot.
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
| `public/js/sandbox.js` | mount persistent `IDBDevice`→`/workspace` + per-project `IDBDevice`→`/mnt/<projname>-<hash>` + ingest `DataDevice`s→`/mnt/in-s` (session) & `/mnt/in-p` (project) & `/mnt/in-src` (dev-mode source→`/src`) (and later `WebDevice`→`/mnt/in-web`); `mountFiles(fileProvider)` (Tier-1 `inDev.writeFile` direct bytes → seed `cp`/`ln -sfn`, Tier-3 base64 fallback); `exportFile`; intercept in `execInSandbox` before the VM; the sandboxed-iframe `js` runner | A+B |
| `public/js/sandbox-files.js` | NEW — pure `sanitizeName`/`sanitizeProjName`/`projHash`/`dedupeNames`/`buildManifest`/`applySizeCap`/`chooseTier`/`buildSeedScript`/`buildFallbackWriteScript`; Node-tested (`sandbox-files.test.js`) | B |
| `public/sw.js` | NEW (Tier 2, deferred) — Service Worker backing the WebDevice: serves decrypted OPFS / proxied R2 bytes as `application/octet-stream` + CORP, honoring `Range` | B |
| `public/js/host-commands.js` | NEW — registry + `matchHostCommand`/`tokenizeCommand`/`runHostCommand`; pure core Node-tested (`host-commands.test.js`) | A |
| `public/js/stream.js` | DRS: assemble the file provider (attachments + active project) and pass to `bootOnce` | B |
| `public/js/drc-research.js` | DRC: assemble the file provider from `drc-store`; `drcBashAgentPrompt` gains the host-command + mount paragraphs | A+B |
| `src/prompts.js` | `bashAgentPrompt` gains the host-command paragraph and the (conditional) mount paragraph | A+B |
| `src/index.js` | add `host-commands.js` and `sandbox-files.js` to `isPublicAsset` | A+B |
| `public/js/bash-core.js` | (optional) `isHostOnly` predicate so a host-only round skips `ensureReady` and never boots the VM | A |
| docs / execution-sandbox skill | document both capabilities once they ship | A+B |