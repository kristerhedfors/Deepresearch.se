# Execution environments — where the agent's shell commands run

*Shipped 2026-07-26. Status: the seam, the DREE/1 wire, the reference runner
and both tiers' settings surfaces are IMPLEMENTED and unit-tested. Not yet
live-verified against a real container runtime from a browser — see §8.*

The model choice already spans on-device and cloud. This is the same choice for
execution: **where the shell commands the agent proposes actually run.** Until
now there was exactly one answer — a Linux VM emulated inside the browser tab.
This document specifies the alternative, the wire between them, and what each
choice exposes.

## 1. The two environments

| | **In-browser Linux VM** (default) | **Local runner** |
|---|---|---|
| What it is | Debian under CheerpX, an x86 emulator compiled to WebAssembly | A container/micro-VM on the user's own machine, behind a small HTTP service |
| Setup | none | one command (§3) |
| Speed | emulated: ~25 s cold boot, seconds-to-minutes per CPU-bound command | native |
| Image | one, streamed (`docs/SANDBOX-LOCAL-IMAGE.md`) | any image with `/bin/sh` |
| Network | none (CheerpX networking is Tailscale-only and unused) | `none` by default, opt-in `bridge`/`host` |
| Sees the user's files | only what the page mounts (`sandbox-files.js`) | only what the user mounts (`MOUNT=`) |
| Lifetime | one VM per page, overlay persists in IndexedDB | one throwaway container per research session |
| Requires | cross-origin isolation (COEP, SharedArrayBuffer) | nothing but a reachable `localhost` |

Both are **browser-direct**. Neither routes a command, its output, or a file
through this site's server, in either tier. That is what makes the local runner
admissible under invariant 4 without a new exception: it is not a third channel
to the server, it is a different endpoint for the same browser-side call.

The browser VM stays the default and stays supported. Nothing about the
environment choice changes conversations, history, storage or the pipeline.

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

**`session` is the only subtlety.** Commands carrying the same session id must
reach the same machine, because an agent loop is a conversation with a shell:
round 2 does `cd`, round 3 relies on a package round 2 installed, round 4 reads
a file round 3 wrote. A runner that gives every command a fresh machine is still
conforming, but the loop will behave badly on it.

**The response shape is deliberately `execInSandbox`'s.** Every consumer — the
`bash-core.js` loop, the transcript renderer, the deliverables export — is
byte-for-byte indifferent to which environment ran the command.

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
| Runner choice | `execCfg` → `pickRunner()` in `drc-research.js` | `selectRunner()` in `stream.js` `runSandboxPass` |

**Why Se/rver stores this per device and not per account.** A runner lives at
`http://localhost:8100` on *one* machine. An account-wide setting would point
the user's phone at a service that only exists on their laptop, and every send
from the phone would probe a dead address. The same reasoning as the on-device
model knob (`ondevice-drs.js`) — and it has a privacy dividend: the runner's URL
and key never reach the server at all.

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

## 5. Exposure ledger

The point of writing this down (`docs/WORKSPACES.md`'s discipline, applied to
execution): what each choice hands to whom.

| | Browser VM | Local runner | Local runner, `NETWORK=bridge` | `BACKEND=host` |
|---|---|---|---|---|
| Commands reach this site's server | no | no | no | no |
| Commands reach a third party | no | no | no | no |
| Command can read the user's files | only mounted ones | only `MOUNT=` | only `MOUNT=` | **everything the user can read** |
| Command can reach the internet | no | no | **yes** | **yes** |
| Command can reach the user's LAN | no | no | **yes** | **yes** |
| Survives the session | overlay in IndexedDB | no | no | temp dir, removed on reap |
| Isolation boundary | WASM sandbox | container/VM | container/VM | **none** |

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
| `public/js/sandbox.js` | `collectDeliverables(exec)` / `exportFile(path, exec)` made runner-agnostic |

## 8. Still owed

- **Live verification.** The runner is proven end-to-end in `host` mode
  (sessions isolate, state persists across commands, timeouts return 124,
  truncation flags, exit codes pass through, `DELETE` reaps). The container
  backends are built from each CLI's documented flags but have not been run
  here — no container runtime exists in the build environment. Verify
  `docker`, `podman` and Apple `container` on a real machine, and verify the
  browser-direct call (CORS + private-network preflight) from a live page,
  before treating this as production-ready.
- **Apple `container` flag set.** It gets a reduced flag list (no
  `--pids-limit`); confirm `--memory`/`--cpus`/`--network` behave as assumed on
  macOS 26.
- **File mounts.** A Se/rver send with attachments or a project mounts them into
  the browser VM; with a local runner those attachments are simply not there.
  Bridging that (push attachments through `/exec` into `/workspace`) is the
  obvious next step and is not implemented.
- **A Platform-SDK module.** Per the 2026-07-24 directive that feature surfaces
  should be carried by an SDK rather than built bespoke, the execution-environment
  seam owes a `sdk/MANIFEST.json` module (`docs/ARCHITECTURE.md` §15).
