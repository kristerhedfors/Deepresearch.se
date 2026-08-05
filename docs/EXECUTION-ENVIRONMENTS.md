# Execution environments — where the agent's shell commands run

*Shipped 2026-07-26. Status: the seam, the DREE/1 wire, the reference runner
and both tiers' settings surfaces are IMPLEMENTED and unit-tested. Not yet
live-verified against a real container runtime from a browser — see §10.*

*Extended 2026-07-26 (second change): a THIRD environment — an ephemeral
Cloudflare Container this platform starts per research session, Se/rver only —
plus the mount bridge that gives any remote environment the files the browser VM
has always had. Implemented and unit-tested; the container binding ships
DISABLED and the whole environment is therefore invisible until an owner enables
it (§9).*

*Image pushed 2026-07-26 (third change): the container image is built, verified
by a 40-check battery and pushed to the managed registry, and the binding is now
uncommented.*

*LIVE, and now the MAIN environment (2026-07-27, owner directive). The deploy
carried the binding: production reports `available.exec_container: true` and the
container has run for real. `chat_logs` #677 ran eight commands in it, and the
guest reported Debian 13 (Trixie), kernel `6.18.36-cloudflare-firecracker`,
x86_64 AMD EPYC, 7.3 GB disk, 2.1 GB RAM, hostname `cloudchamber`. **On
Se/rver the cloud container is what a user gets unless they choose otherwise**;
the in-browser VM is the fallback where there is no other option: Se/cure,
a deploy without the binding, and anyone who picks it deliberately. The
"nothing has run against a real Cloudflare Container" caveat this document
carried until 2026-07-27 is retired.*

The model choice already spans on-device and cloud. This is the same choice for
execution: **where the shell commands the agent proposes actually run.** Until
now there was exactly one answer — a Linux VM emulated inside the browser tab.
This document specifies the alternatives, the wire between them, and what each
choice exposes.

## 1. The three environments

| | **In-browser Linux VM** (fallback) | **Local runner** | **Cloud container** (Se/rver only — the DEFAULT there) |
|---|---|---|---|
| What it is | Debian under CheerpX, an x86 emulator compiled to WebAssembly | A container/micro-VM on the user's own machine, behind a small HTTP service | An ephemeral Cloudflare Container, one per conversation, driven by a Durable Object |
| Setup | none | one command (§3) | none |
| Speed | emulated: ~25 s cold boot, seconds-to-minutes per CPU-bound command | native | **native; ~1–3 s container cold start** — the reason it is the default |
| Image | one, streamed (`docs/SANDBOX-LOCAL-IMAGE.md`) | any image with `/bin/sh` | ours, built from `container/Dockerfile` |
| Network | none (CheerpX networking is Tailscale-only and unused) | `none` by default, opt-in `bridge`/`host` | none (`enableInternet:false`) |
| Sees the user's files | only what the page mounts (`sandbox-files.js`) | only what the user mounts (`MOUNT=`) | only what the page pushes (§2a) |
| Lifetime | one VM per page, overlay persists in IndexedDB | one throwaway container per research session | one container per conversation; destroyed on new chat, on idle, or by budget (§8) |
| Requires | cross-origin isolation (COEP, SharedArrayBuffer) | nothing but a reachable `localhost` | a signed-in account + the deploy's container binding |
| Server in the data path | no | no | **yes** |

The first two are **browser-direct**. Neither routes a command, its output, or a
file through this site's server, in either tier. That is what makes the local
runner admissible under invariant 4 without a new exception: it is not a third
channel to the server, it is a different endpoint for the same browser-side call.

The third one **is** the server. It runs the commands on this platform, so the
commands, their output and the mounted files pass through it. That is admissible
on **Se/rver**, where the server sits inside the trust boundary (owner directive,
2026-07-24), and inadmissible on **Se/cure**, whose whole posture is that the
server is in no data path. So it is offered on the signed-in tier only, and the
refusal is in code rather than in convention — twice:

- `selectRunner` in `public/js/exec-backends-core.js` requires an explicit
  `tier:"server"`. Se/cure passes `tier:"secure"` (`drc-research.js`
  `pickRunner`), and a caller that says nothing gets the same safe direction: the
  browser VM. `exec-backends-core.test.js` pins it.
- `/api/exec/*` lives behind the identity gate. Se/cure has no identity, so a
  hand-edited sealed state naming the backend cannot reach the endpoint either.

**Which one you get if you never open the setting** (2026-07-27): on **Se/rver**,
the cloud container whenever the deploy carries the binding. It is the fastest
by an order of magnitude, needs no setup, and the server is inside that tier's
trust boundary anyway (owner directive, 2026-07-24; cloud storage on Se/rver is
already implicit for the same reason). Everywhere else — **Se/cure** in every
case, a deploy without the binding, a caller that does not state its tier — the
in-browser VM, which needs nothing and exists everywhere.

One function decides this and nothing else re-decides it:
`defaultExecBackend({tier, container})` in `public/js/exec-backends-core.js`.
An unchosen config normalizes to the sentinel `EXEC_AUTO` (the ABSENCE of a
pick, deliberately not a row in either picker), and `resolveExecBackend` turns
it into a real environment at the point of use. **An explicit pick always
wins**, including an explicit "in-browser Linux VM": distinguishing "chose the
browser" from "never chose" is the whole reason the sentinel exists. The tier
gate applies to the default exactly as it applies to an explicit pick, so the
flip cannot leak the container into Se/cure. Pinned by
`exec-backends-core.test.js`.

The browser VM stays fully supported. It is the only environment that works
with no account, no setup and no server, which is what makes Se/cure's posture
possible at all. Nothing about the environment choice changes conversations,
history, storage or the pipeline.

**Which environment ran is recorded.** `client_diag.xb` (a closed vocabulary —
`browser` | `local` | `cloudflare`, never a URL) rides on every `/api/chat` and
lands in the `chat_logs` meta, so a transcript can be attributed to the machine
that produced it. Before 2026-07-27 the diagnostic recorded whether a sandbox
COULD run and how many commands it ran, but never WHERE — which is how "the
sandbox is the browser VM" went on reading as true here long after it stopped
being the common case.

**And what happened in it.** `client_diag.xd` carries the outcome of the send's
shell pass: `boot` (did the environment come up), `ms` (how long that took),
`cmds` (commands executed), `term` (lines written to the terminal pane), and
`err` (`no-isolation` | `boot-failed` | `error`). Counters and closed
vocabularies only: no command text, no runner URL, no filenames. It is absent
from a send that ran no shell pass, so an ordinary chat's meta is unchanged.

The gap it closes is specific. `xb` says where and `meta.shell` says what;
between them sat the question feedback #43 actually raised (*did any of this
reach the terminal pane*), and nothing in the row could answer it, because every
other sandbox breadcrumb (`client_diag.fs`, the `sblog` event stream) is written
by the browser VM and is therefore silent on exactly the path that had the bug.
`cmds > 0` with `term: 0` is that bug's signature, checkable from a chat log
instead of reproducible only by asking the user to try again.

The readable chat-log view (`?format=text`) also names the environment on the
shell headline now (`TOOLS: bash-lite ran 1 command in the cloud container`)
rather than leaving it inside the `META` one-liner's JSON.

**A remote runner's own breadcrumbs now ship.** `selectRunner` takes an `onLog`
callback and both tiers point it at `sblog`, but every flush of that buffer
lived inside `sandbox.js`'s browser-VM boot and exec paths, so
`exec.runner_ready`, `exec.runner_unreachable`, `exec.runner_mounted` and
friends were being recorded into a 300-entry ring buffer and dying with the tab.
A send that reached a remote environment flushes it (`flushSandboxLog`, exported
for this), so those events land in Workers Logs like the VM's always have.

## 2. DREE/1 — the wire

`DREE` = DeepResearch Execution Environment. Two required endpoints; the client
is `public/js/exec-backends-core.js`.

```
GET  {base}/healthz
  → 200 {ok:true, protocol:"dree/1", backend:"docker",
         image:"debian:stable-slim", ephemeral:true, network:"none", version:"1"}

POST {base}/exec          content-type: application/json
                          x-api-key: <key>        (optional)
  body  {command, session?, timeoutMs?, maxStdoutBytes?}
  → 200 {exitCode:0, stdout:"…", stderr:"…", truncated?:true}
```

Optional, and implemented by the reference runner: `GET /sessions`,
`DELETE /session/<id>`.

Two further OPTIONAL endpoints carry the file MOUNTS (§2a). Each is advertised by
a flag in `/healthz`, so a runner that does not implement them is never asked:

```
POST {base}/mount?session=<id>     content-type: application/x-tar   (mount:true)
  body  a ustar archive, extracted at / in that session's machine
  → 200 {ok:true}

POST {base}/source?session=<id>                                      (source:true)
  the runner seeds /src from the SERVER's own copy of this deploy's source
  snapshot — only the platform container can do this
  → 200 {ok:true, count, bytes, cached}
```

**`session` is the only subtlety.** Commands carrying the same session id must
reach the same machine, because an agent loop is a conversation with a shell:
round 2 does `cd`, round 3 relies on a package round 2 installed, round 4 reads
a file round 3 wrote. A runner that gives every command a fresh machine is still
conforming, but the loop will behave badly on it.

**The response shape is deliberately `execInSandbox`'s.** Every consumer — the
`bash-core.js` loop, the transcript renderer, the deliverables export — is
byte-for-byte indifferent to which environment ran the command.

### 2a. The mount bridge — what a remote environment holds

Until this change, "the sandbox has your files" was the browser VM's property
alone; a local runner got a bare container. Now the layout is the same wherever
commands run:

```
/workspace/                     this send's attachments + the agent's scratch
/workspace/INDEX.txt            the manifest the model reads to discover them
/workspace/outbox/              the deliverables convention (exported to the chat)
/workspace/<project>  ->  /mnt/<project>-<hash>
/mnt/<project>-<hash>/          the active project's files
/src                            this deploy's own source tree (developer mode)
/workspace/source     ->  /src
```

One planner produces it for every environment: `planMounts` in
`public/js/sandbox-files.js` (moved out of `sandbox.js`'s `preparePlan`, which
now calls it) applies the size caps, the name sanitizing and the manifest;
`planRemoteMount` turns that same plan into ONE ustar archive with relative
member paths (`workspace/notes.pdf`, `mnt/trip-notes-ab12cd/plan.md`) plus the
small script that installs the project symlink. `tar -xf - -C /` then lands the
archive exactly where the VM's seed script puts it, and `tar`'s default refusal
of `..` members means a hand-crafted archive cannot walk out of the tree.

**The source tree is the one asymmetry, on purpose.** The snapshot is
~11 MB. The browser VM tars the copy it already fetched; a *local* runner is not
asked for `/src` at all; and the platform container seeds it **server-side**,
reading `public/introspect/source-snapshot.json` through the `ASSETS` binding
inside the Durable Object. So the bytes never cross the browser, and the tree in
the container is by construction the source this Worker is running — the same
guarantee introspection makes. It is stamp-guarded exactly like the VM's seed
(`sourceStamp` over path+size), and the guard reads the stamp from the
CONTAINER rather than from Durable Object memory, so the second send in a
conversation extracts nothing even if the Durable Object was evicted in between.
`sdk/` is part of the snapshot, so `/src/sdk` is the SDK mount:
`node /src/sdk/pair-cli.mjs list` works there as it does in the VM.

Mounting is **not** part of the boot verdict (invariant 2): a runner that is up
but could not take the files still runs commands. Losing the files is a worse
answer; losing the shell is no answer.

**Fail-soft is a requirement of the caller, not the runner** (invariant 2). An
unreachable or misconfigured runner never throws into the pipeline: the probe
fails, the shell pass is skipped, and the answer arrives without a shell.

### CORS and mixed content

The call is browser → `localhost`, so a conforming runner must:

- send `Access-Control-Allow-Origin`, and
- answer Chrome's Private Network Access preflight with
  `Access-Control-Allow-Private-Network: true`.

Chrome, Edge and Firefox treat `http://localhost` as a potentially trustworthy
origin, so an HTTPS page may call it. **Safari does not, and blocks it as mixed
content.** This is the same constraint the local browsing agent lives with
(`docs/` → the **local-web-search** skill); the workarounds are the same:
another browser, or a local HTTPS terminator.

## 3. The reference runner

`public/cure/local-exec/runner.mjs` — one file, no dependencies, Node 18+.

```bash
curl -fsSL https://deepresearch.se/cure/local-exec/runner.mjs -o runner.mjs && node runner.mjs
```

It auto-detects a container runtime in this order, and each session's first
command creates that session's machine:

| Backend | Notes |
|---|---|
| `container` | Apple's native CLI (macOS 26+). Per-container VMs, nothing to install. |
| `docker` | Docker Desktop, colima, Rancher, OrbStack. |
| `podman` | Rootless, daemonless. `brew install podman && podman machine init`. |
| `nerdctl` | containerd's CLI (Rancher Desktop, Lima). |
| `host` | **No container.** Opt-in via `BACKEND=host`; prints a warning banner. |

Configuration is environment variables: `PORT` (8100), `HOST` (127.0.0.1),
`API_KEY`, `ALLOW_ORIGIN`, `IMAGE` (`debian:stable-slim`), `NETWORK` (`none`),
`MEMORY`/`CPUS`/`PIDS`, `MOUNT`, `IDLE_MINUTES` (30). The setup page
`/cure/local-exec/` carries the copy-paste recipes per platform.

It also implements the optional `POST /mount` (and advertises `mount:true`), so
the page's attachments and project files reach a local container too — streamed
straight into `tar`'s stdin, never buffered in the runner. It does NOT implement
`/source`: seeding `/src` from a server-held copy of the site's source is
something only the platform's own container can do.

The runner is a reference, not the interface. A Firecracker or Cloud Hypervisor
pool, a gVisor sandbox, a remote build box over a tunnel, or a CI runner can all
implement §2 and drop straight in.

### Defaults, and why

- **`NETWORK=none`.** An agent loop with an outbound socket is a different risk
  than one without. The browser VM has no network either, so this is also the
  choice that keeps switching environments from silently widening exposure. One
  env var opens it, and the UI then *says* it is open (§6).
- **Binds `127.0.0.1`.** Nothing off the machine can reach it.
- **Ephemeral.** A session's machine is destroyed on idle, on `DELETE`, and on
  Ctrl-C. Nothing survives except what the user mounted.
- **Nothing written to disk.** Commands are printed to the console — for the
  user to watch, not for a log file.

## 4. The seam in the code

The shell pass in both tiers already took an injectable
`{supported, boot, exec}` trio (it was the test seam). That trio is now a named
concept, **Runner**, and the environment choice is one function:

```js
// public/js/exec-backends-core.js
selectRunner(cfg, browserRunner, deps) → Runner
```

`selectRunner` returns `browserRunner` **unchanged** unless the user picked
`local` *and* entered a URL. A half-filled form, an unknown backend id, absent
config, storage that throws — all land on the browser VM. This is the property
that keeps the feature from being able to regress the sandbox, and it is pinned
by unit tests (`public/js/exec-backends-core.test.js`).

| Layer | Se/cure | Se/rver |
|---|---|---|
| Config store | sealed project state `state.execBackend` (`drc-core.js`) | `localStorage` `dr_exec_env` (`exec-env.js`) |
| Settings UI | `public/cure/index.html` + `renderExecBackend()` in `drc.js` | `execEnvSettingsMarkup()` / `wireExecEnvSettings()` |
| Runner choice | `execCfg` → `pickRunner()` in `drc-research.js`, `tier:"secure"` | `selectRunner()` in `stream.js` `runSandboxPass`, `tier:"server"` |
| Environments offered | `execBackendsFor("secure")` → browser, local | `execBackendsFor("server", {container})` → browser, local, and the container when the deploy carries the binding |

The `tiers` field on each registry entry is what those two calls read, and the
`cloudflare` entry lists `["server"]` only. Adding a fourth environment is a row
in `EXEC_BACKENDS` plus (if it is remote) whatever `/healthz` capabilities it
advertises — not an edit in four files.

**Why Se/rver stores this per device and not per account.** A runner lives at
`http://localhost:8100` on *one* machine. An account-wide setting would point
the user's phone at a service that only exists on their laptop, and every send
from the phone would probe a dead address. The same reasoning as the on-device
model knob (`ondevice-drs.js`) — and it has a privacy dividend: the runner's URL
and key never reach the server at all.

### One machine per conversation

A remote environment's `session` id decides how many machines a conversation
burns. Se/rver derives it from `sessionStorage` (`execSessionId()` in
`exec-env.js`), so:

- consecutive sends in a tab reach the SAME container — the agent's working
  directory, the files it wrote, and the `/src` seed all survive from send to
  send, and the stamp guard then makes the re-mount free;
- a new tab is a new machine;
- **"New chat" releases it** (`releaseExecSession()`, called from `newChat()` in
  `app.js`): a `DELETE /api/exec/session` destroys the container immediately
  rather than leaving it to the idle reaper. Best-effort — the reaper is the
  guarantee, this is the courtesy.

### What changes when a local runner is active

- The COEP/isolation gate is skipped — isolation is a requirement of the
  in-browser VM (SharedArrayBuffer), not of execution as such.
- The VM pre-warm is skipped in both tiers: streaming a Debian image into a VM
  that will never run a command is pure waste.
- `resetSandboxIfLacking` and the page's file mounts are skipped — there is no
  VM here to hold mounts. Files reach a local runner through its own `MOUNT`.
- The boot step reads "Connecting to your local runner…", and a failure names
  the runner rather than the browser sandbox.
- The **deliverables/download flow still works.** `collectDeliverables(exec)`
  now takes the environment that ran the loop; the outbox convention and the
  base64-through-exec round-trip are pure `bash-core.js` and have nothing
  CheerpX-specific in them.
- The step label names the environment that is actually starting ("Starting your
  Linux container…" / "Connecting to your local runner…" / "Booting Linux
  sandbox…"), and so does the failure line. "Unavailable" sends someone hunting
  the wrong machine.

- The **terminal pane is mirrored explicitly**, because a remote environment
  cannot fill it by accident; see below.

All of the above is keyed on `remoteRunnerActive()` — *any* non-browser
environment — rather than on the local runner specifically.

### The terminal pane has to be told

The pane behind the chat (the `#termbtn` switch brings it forward) is fed from
*inside* `public/js/sandbox.js`: the VM pushes its boot stages, its raw console
bytes and every command `execInSandbox` runs. The pane is a live view of the
browser VM **by construction**, which is exactly why it silently stopped being a
live view of anything else. A Runner over DREE/1 is a health probe and a fetch;
it narrates nothing.

While the browser VM was the default this was invisible. The 2026-07-27 flip
made the cloud container the default environment on Se/rver, and the pane went
empty on the path most sends now take: commands running, their output writing
the answer, and the terminal reading `[ sandbox terminal idle — no output yet ]`
behind it. That is feedback #43, and `chat_logs` #690 is the receipt:
`client_diag.xb: "cloudflare"`, `ran: 1`, `meta.shell` holding a real `ls /`.

So the mirror is explicit, and it lives with the pane rather than with the
runner: `remoteTerminalMirror(backend)` in `public/js/agent-backdrop.js`, driven
by whichever tier's shell pass knows what `selectRunner` picked — `stream.js`
`maybeRunShellLoop` on Se/rver, the `onStatus` handler in `public/cure/drc.js`
on Se/cure. It writes the same vocabulary the VM writes for itself: a stamped
connect line (`execConnectLog` in `exec-backends-core.js`, named from the
`EXEC_BACKENDS` registry so the pane can never claim the wrong machine), then
`$ cmd` and its raw output, then a closing line saying whether the environment
came up. A connect that fails says so in the pane instead of leaving a blank
field under a lit-up icon. That is what feedback #42 established for the VM's
boot, owed here to the environments that have no boot.

Only the remote path is mirrored. Mirroring the browser VM too would print
every command twice.

Regression cover: `tests/e2e/terminal-remote.spec.js` (run under
`--config=sandbox.pw.config.js`) drives the whole path with the step model, the
runner and `/api/chat` all intercepted, so it is deterministic and free, and
asserts both that a run reaches the pane and that an unreachable runner says so.

## 5. Exposure ledger

The point of writing this down (`docs/WORKSPACES.md`'s discipline, applied to
execution): what each choice hands to whom.

| | Browser VM | Local runner | Local runner, `NETWORK=bridge` | `BACKEND=host` | **Cloud container** |
|---|---|---|---|---|---|
| Commands reach this site's server | no | no | no | no | **yes — it runs them** |
| Commands reach a third party | no | no | no | no | no |
| Mounted files reach this site's server | no | no | no | no | **yes** (they are pushed to it) |
| Command can read the user's files | only mounted ones | only `MOUNT=` | only `MOUNT=` | **everything the user can read** | only what the page pushed |
| Command can reach the internet | no | no | **yes** | **yes** | no |
| Command can reach the user's LAN | no | no | **yes** | **yes** | no |
| Survives the session | overlay in IndexedDB | no | no | temp dir, removed on reap | no — ephemeral disk, destroyed with the container |
| Isolation boundary | WASM sandbox | container/VM | container/VM | **none** | per-instance VM (Cloudflare runs each container in its own VM) |
| Available in Se/cure | yes | yes | yes | yes | **no** |

That last column is what the convenience costs. No setup, native speed and a
machine already next to the pipeline, paid for by putting the commands and the
mounted files through this server. On the signed-in tier that is where the
conversation, its attachments and its project already sit (cloud storage is
implicit on Se/rver), so the container works inside the trust boundary already
drawn there. On Se/cure it would break the only promise that tier makes, which
is why it isn't offered there.

A container is a boundary against a mistaken or misled command; it is not a
guarantee against a determined escape. `BACKEND=host` has no boundary at all and
the runner says so, in the console and on the setup page, every time it starts.

## 6. What the user is told

Both tiers put the choice behind the **ⓘ** on an **Execution environment** row,
directly with the execution-sandbox knob it qualifies. The popover states, in
the user's words: what each option is, that the browser VM is an emulator and
slow, that the local runner is native and gets a throwaway container, that this
browser calls it directly so nothing passes through the server, that the runner
prints every command, that CORS is required, and — on Se/rver — that the setting
is per device. It links to `/cure/local-exec/`.

**Test connection** exists because "Failed to fetch" is not a diagnosis. The
probe reports the runtime and image it found, or names the three real causes:
the service is not running, it does not allow this origin, or Safari blocked the
`http://localhost` call. The status line also states the runner's **network
posture** — whether the machine running your commands can reach the internet is
exactly the kind of fact this project writes down rather than leaves to be
assumed.

The cloud container has nothing to configure, but it keeps the button, because
"is a container available to me right now" has three answers: this
deploy has no container binding, the execution-sandbox knob is still off, or yes
— and the endpoint says which. A runner that answers `ok:false` **with a reason**
has its reason relayed verbatim rather than replaced by a generic line.

Its ⓘ copy states the trade in the user's own words: an ephemeral Linux
container, one per conversation, started in about a second and thrown away when
they are done; the same files and (in developer mode) the same source tree as the
browser VM; no network access; and that the commands, their output and the
mounted files **do pass through this server**, which is why the option exists on
the signed-in tier only and never in DeepResearch.**Se/cure**.

## 7. Files

| Path | Role |
|---|---|
| `public/js/exec-backends-core.js` | The shared pure core: registry, `normalizeExecBackend`, DREE/1 client, `probeRunner`, `makeLocalRunner`, `selectRunner` |
| `public/js/exec-backends-core.test.js` | Its contract, incl. the "browser bridge returned untouched" property |
| `public/js/exec-env.js` | Se/rver's browser-local config + the Settings section |
| `public/cure/local-exec/runner.mjs` | The reference runner |
| `public/cure/local-exec/index.html` | The setup page (`/cure/local-exec`, a reserved slug) |
| `public/js/drc-research.js` | Se/cure's `pickRunner` / `execCfg` threading |
| `public/js/stream.js` | Se/rver's `runSandboxPass` runner selection |
| `public/js/sandbox.js` | `collectDeliverables(exec)` / `exportFile(path, exec)` made runner-agnostic; `preparePlan` now calls the shared `planMounts` |
| `public/js/sandbox-files.js` | `planMounts` (the plan every environment mounts from) + `planRemoteMount` (that plan as one ustar archive + the symlink script) |
| `src/exec-container.js` | The server-side environment: the `/api/exec/*` DREE/1 endpoints, the `ExecSandbox` Durable Object that drives one container per session, and the server-side `/src` seed |
| `src/exec-container.test.js` | Its contract against a fake container: availability, `bash -lc`, the timeout→124 path, output caps, the command budget across an eviction, and the stamp-guarded source mount |
| `container/Dockerfile` | The image (Debian slim + the research toolchain, §7a), built out of band and referenced by URI |
| `scripts/build-exec-image.sh` | `build` → `verify` (46 checks) → `push` for that image; overrides the deploy token with the user token the registry needs (§9) |
| `wrangler.toml` | The container + Durable Object + migration block. Uncommented since 2026-07-26 and pointing at the pushed image; no deploy has carried it yet (§9) |
| `public/js/exec-env.js` | Also: `remoteRunnerActive()`, `execSessionId()`, `releaseExecSession()` |

## 7a. What is in the image

The container starts with `enableInternet:false`. There is no package manager
that can reach anything, no pip index, no curl target — so **whatever is not in
`container/Dockerfile` does not exist at run time**, and an agent that reaches
for a missing tool loses the pass rather than waiting for an install. That is
not a hypothetical: user feedback #60 arrived as a mounted LinkedIn screenshot
where the agent ran `tesseract`, got exit 127, then burned the command timeout
on an `apt-get install` that had nowhere to go.

| Group | Packages | For |
| --- | --- | --- |
| Shell + text | `bash coreutils findutils diffutils grep sed gawk`, `jq bc file less tree`, `ripgrep` | the ordinary Debian commands the agent loop proposes |
| Archives | `tar gzip bzip2 xz-utils zip unzip` | the mount bridge (GNU tar specifically — see §9) and the outbox |
| Languages | `python3 python3-venv`, `nodejs`, `git`, `sqlite3` | scripts, `node /src/sdk/pair-cli.mjs`, local data work |
| **Images, OCR and PDFs** | `tesseract-ocr` + `tesseract-ocr-eng` + `tesseract-ocr-swe`, `poppler-utils`, `python3-pil`, `zbar-tools` | reading an attached screenshot, scan, PDF or barcode without a network |

Both tesseract language packs ship because the product answers in Swedish as
readily as in English and `eng`-only OCR mangles Swedish diacritics — the same
parity rule the deterministic intent gates live under. `poppler-utils` gives
`pdftotext` for a PDF that has a text layer and `pdftoppm`/`pdfimages` for one
that does not; `python3-pil` is Pillow, installed from apt because pip has
nowhere to fetch from; `zbar-tools` reads the QR and barcodes on tickets and
badges.

Two neighbours are deliberately absent, and the reason is cold start rather
than taste: `libimage-exiftool-perl` costs about 25 MB and pulls in a full
perl, and `imagemagick` does work Pillow and `pdftoppm` already cover. Image
size dominates the container cold start, and the cold start is what the user
waits for on their first command, so a tool earns its megabytes.

What that group costs, measured as `docker images` size on Debian 13:

| Added | Size | Running total |
| --- | --- | --- |
| *(the toolchain before this group)* | — | 482 MB |
| `tesseract-ocr` + `eng` + `swe` | +79 MB | 561 MB |
| `poppler-utils`, `python3-pil` | +31 MB | 592 MB |
| `zbar-tools` | +27 MB | **619 MB** |

The last row is the one to know before anyone tries to trim this: `zbarimg`
links MagickWand, so `libmagickcore`/`libmagickwand` arrive as its dependencies
no matter what. Leaving `imagemagick` out drops the CLI (`magick`, `convert`),
not the libraries; dropping `zbar-tools` is what would actually reclaim them.

Changing this table means changing three things in one commit: the Dockerfile
list, the `verify` battery in `scripts/build-exec-image.sh` (which asserts each
binary resolves and that tesseract lists both `eng` and `swe`), and this
section. Then re-run `build` → `verify` → `push`; the tag stays `:1`, so the
next `npx wrangler deploy` picks the new image up.

## 8. The fences on a server-side container

This spends someone else's compute, so the bounds are written down. Per session,
in the Durable Object (`src/exec-container.js`):

| Fence | Value | Why |
|---|---|---|
| Idle destroy | 10 min | An alarm, re-armed on every touch: a container outlives its conversation by at most this. |
| Session lifetime | 1 h | Recycled on the next command after that, so "ephemeral" keeps meaning something for a tab left open all day. |
| Command budget | 400 | Per session, persisted in Durable Object storage so an eviction does not reset it. |
| Per-command timeout | ≤ 120 s | Ours, not the platform's: `container.exec` has no timeout, so a bounded race kills the process and returns exit 124 — the same code the VM and the local runner use. |
| Output per command | ≤ 2 MB (client asks for far less) | Decoded on a byte boundary, with `truncated` set when the cap bit. |
| Mount archive | ≤ 48 MB | Rejected before the body is read. |
| Readiness wait | ≤ 20 s | `start()` does not block until ready and `exec` throws until it is, so readiness is probed with `true` until it works. |

The GLOBAL fence is `max_instances` in `wrangler.toml` (10), and the container
runs with `enableInternet:false` and — via `constraints.jurisdiction = "eu"` —
on EU-jurisdiction infrastructure, matching where the primary LLM provider runs.

## 9. Enabling the cloud container (owner)

It shipped **switched off**, with `wrangler.toml`'s `[[containers]]` +
`durable_objects` + `migrations` block commented out. Two things kept it that
way, and both are now settled:

1. **A binding whose resource does not exist fails EVERY deploy** — the same
   failure class as the round-4 `cpu_ms` rejection and the R2/Vectorize bindings
   (`tests/MODEL-EVAL-FINDINGS.md`). The image had to exist first. It does now
   (below); the Durable Object namespace is created by the `v1` migration on the
   deploy that first carries the binding.
2. **The push needs the right credential** — a user API token, not the
   account-owned deploy token (below). Building needs no special machine.

**The block is uncommented as of 2026-07-26**, so a deploy from `main` carries
the binding. That deploy is the switch: until it happens, production keeps
whatever the last one carried, and `available.exec_container` stays `false`.

`scripts/build-exec-image.sh` does the whole thing:

```bash
./scripts/build-exec-image.sh build    # linux/amd64, attestation + SBOM off
./scripts/build-exec-image.sh verify   # the battery, against the built image
./scripts/build-exec-image.sh push     # wrangler containers push
./scripts/build-exec-image.sh all      # all three (default)
```

Re-run it whenever `container/Dockerfile` changes; the tag stays `:1`, so a
deploy picks up the new image. `wrangler.toml`'s `image` already points at it.

Until then `/api/settings` reports `available.exec_container: false`, the Settings
picker omits the option, and the code is inert — exactly how the Shodan and Maps
knobs behave without their keys.

### The build environment has Docker now

The agent containers this repo is developed in ship a Docker client **and**
`dockerd`; if `/var/run/docker.sock` is missing, `dockerd &` brings it up (the
script does this itself). So the image is built and exercised in-session, and the
old "no container runtime exists here" caveat no longer applies to it.

What `verify` asserts — the contracts `src/exec-container.js` depends on, run
under `--network none` to mirror `enableInternet:false`, with this repo mounted
read-only at `/src`:

| Group | Checked |
| --- | --- |
| Toolchain | all 26 tools in the Dockerfile list resolve on PATH — nothing can be installed at run time |
| Reading images | `python3 -c "import PIL"` works, and `tesseract --list-langs` carries both `eng` and `swe` (§7a) |
| Argv shape | `bash -lc` (`shellArgv`) keeps a usable PATH, the image ENV (`DR_EXEC`), `HOME`, and `/workspace` as cwd through a **login** shell |
| Layout | `/workspace`, `/workspace/outbox`, `/mnt`, `/src` exist |
| Mount bridge | GNU tar identity, plus a real `tar -xf - -C / --no-same-owner` (`mountExtractScript`) and the `-C /src` source mount |
| Seed script | `mountSeedScript`'s `mkdir -p` + `ln -sfn` produce working `/workspace/<project>` and `/workspace/source` |
| SDK claim | `node /src/sdk/pair-cli.mjs list` and `agents` actually run |

Two findings the battery pinned down, both now guarded:

- **The base must stay GNU, not busybox.** Both mount paths pass
  `--no-same-owner`, which busybox tar rejects — so the obvious "shrink the
  image" move would break file mounts. (`tar --help` does not list the flag even
  though GNU tar accepts it, so grep the `--version` banner, not the help text.)
- **Build with `--provenance=false --sbom=false`.** BuildKit otherwise emits an
  attestation manifest and the result becomes a manifest *list*; the managed
  registry wants a single plain manifest.

### The push needs a USER token, not the deploy token

**Pushed 2026-07-26**: `registry.cloudflare.com/<account-id>/deepresearch-exec:1`,
digest `sha256:f0ddd1ed…`, 482 MB, confirmed in `wrangler containers images list`.

**Rebuilt 2026-08-05** with the image/OCR/PDF group (§7a): **619 MB** locally
(`docker images`), up 137 MB. The tag is unchanged, so this needs a `push`
followed by a `wrangler deploy` before production runs it — until both happen,
containers keep booting the 482 MB image and `tesseract` is still exit 127
there.

The environment carries two Cloudflare credentials and only one of them can push
(the full table is in the **deploy** skill):

| Env var | Type | Containers? |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | account-owned | **no** — `wrangler containers …` dies with a bare `✘ Forbidden` |
| `CLOUDFLARE_USER_API_TOKEN` | **user** API token, Workers + Containers edit | yes |

The blocker was the token **type**, not its permissions: adding Cloudchamber
Edit to the account-owned token changed nothing. `wrangler` only reads
`CLOUDFLARE_API_TOKEN`, so the script overrides it inline from
`CLOUDFLARE_USER_API_TOKEN`.

Do not preflight on the Cloudchamber API — it refuses the *working* token too:

| Request | account token | user token |
| --- | --- | --- |
| `GET /user/tokens/verify` | 400 | **200** ← the reliable discriminator |
| `GET /accounts/<id>/cloudchamber/me` | 401 | 403 |
| `POST …/cloudchamber/registries/credentials` | 405 code 10405 | 405 code 10405 |
| `wrangler containers images list` | `✘ Forbidden` | lists the registry |

`wrangler containers images list` is the only honest probe, and is what
`preflight_push` uses.

### The manifest trap

`docker push` publishes an **OCI index with an attestation manifest** instead of
a plain image without warning you, and that is what reached the registry on the
first attempt here: a tag left over from a build made *before* the
`--provenance=false --sbom=false` flags were added still pointed at the index.
Rebuilding with the flags and re-pushing fixed it (`mediaType:
application/vnd.docker.distribution.manifest.v2+json`).

`assert_single_manifest` now blocks the push on it. Check **locally, before
pushing** — after a push, `docker manifest inspect` serves a cached answer and
will show the pre-push shape; `docker buildx imagetools inspect --raw` reads the
registry live.

## 10. Still owed

- **Live verification.** The runner is proven end-to-end in `host` mode
  (sessions isolate, state persists across commands, timeouts return 124,
  truncation flags, exit codes pass through, `DELETE` reaps). Its `podman` and
  Apple `container` backends are still built from each CLI's documented flags
  and have not been run; its `docker` backend now *could* be exercised here
  (§9 — the build environment has a daemon) and has not been yet. Verify all
  three, plus the browser-direct call (CORS + private-network preflight) from a
  live page, before treating this as production-ready.
- ~~**The cloud environment has never run.**~~ Closed 2026-07-27: a deploy
  carried the binding, `available.exec_container` is `true` in production, and
  real sessions have run in it (`chat_logs` #677 — eight commands, guest
  self-reporting Debian 13 on `6.18.36-cloudflare-firecracker`). What remains
  unmeasured is listed under "Owed by the cloud container specifically" below —
  cold-start latency, the `/mount` and `/source` bridges against a live page,
  and the §8 fences against an actual instance.
- **Apple `container` flag set.** It gets a reduced flag list (no
  `--pids-limit`); confirm `--memory`/`--cpus`/`--network` behave as assumed on
  macOS 26.
- ~~**File mounts.**~~ Closed by the mount bridge (§2a): `planRemoteMount` sends
  the same plan the browser VM mounts as one ustar archive to `POST /mount`, and
  the reference runner implements it. What is still unverified is the bridge
  running against a live page rather than a unit test.
- **A Platform-SDK module.** Per the 2026-07-24 directive that feature surfaces
  should be carried by an SDK rather than built bespoke, the execution-environment
  seam owes a `sdk/MANIFEST.json` module (`docs/ARCHITECTURE.md` §15).

### Owed by the cloud container specifically

- **It runs; most of it is still unmeasured.** The deploy landed and real
  sessions have executed in a real container (§10 above), so the toolchain and
  the basic exec path are no longer theoretical — `chat_logs` #677 ran
  `uname`/`df`/`lsb_release` and friends and got a genuine Firecracker guest
  back. Still unverified against a live instance: cold-start latency as a
  number, that a 120 s command is killed cleanly, that the `/src` seed lands its
  782 files, and that the stamp guard skips the second send. Do those before
  calling the environment production-ready, and note that it is now the
  **default** on Se/rver, so a regression here is no longer a minority path —
  it is what most signed-in shell sends hit.
- **Cost per session is unmeasured.** Instance-seconds are billed; the fences in
  §8 bound them but no figure has been observed. Measure before offering it
  widely.
- **`max_instances` is a hard error, not a queue.** A request that would exceed it
  fails to start a container. That currently surfaces as a boot failure ("the
  Linux container couldn't be started"), which is accurate but blunt; a queue or
  a "come back in a moment" would be kinder.
- **No per-account daily budget.** The per-session fences plus `max_instances`
  are the whole cost story today. If the environment is opened to every account,
  a D1-backed daily command counter belongs next to the quota model.
