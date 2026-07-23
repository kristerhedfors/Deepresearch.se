---
name: exec-engine
description: >-
  Load when building or tuning the sandbox's execution environment: the engine
  is CheerpX (decided), and the work is building OUR OWN small Linux IMAGE from
  scratch (a reproducible Alpine-i386 recipe, tools pinned, added to as we go),
  self-hosting it from our origin, and making it load FAST with NO mid-command
  stalls (full IndexedDB prefetch). Also covers the thin engine-agnostic
  ExecEngine interface + the c2w/v86/qemu fallback ladder kept as optional
  future-proofing, and the in-VM agent's network-egress design. Companion to
  execution-sandbox (the live CheerpX sandbox) and vm-toolchain (the SDK inside
  the VM). Decision matrix: docs/JS-VM-RESEARCH.md.
---

# Exec engine — CheerpX + our own small, fast image

The platform's sandbox runs a **real Linux userland** so arbitrary tools — `git`,
`python3`, `jq`, an agentic coding CLI — run as ordinary binaries. The engine
is **CheerpX** (owner decision, 2026-07-16): proprietary and CDN-loaded, the
one part of the stack we do not build from source, and that is accepted. What
we **do build from scratch** is the IMAGE — a FOSS distro assembled by our own
reproducible recipe, with exactly the tools we choose, added to as we go — and
the governing requirement is that it be **small, load fast, and never stall a
command while fetching hundreds of MB of blocks on demand.** This module owns
that image pipeline; it also keeps a thin engine interface and a fallback
ladder documented, but those are future-proofing, not a migration plan.

## Capability class & tier story

Class **X**. Engine + image run **client-side in both tiers** (the sandbox is
the user's own browser). The server tier only serves bytes — the image is
public, operator-built, same-origin static content carrying no user data, so
PA-4 holds structurally. The one place the server could enter the picture is
**network egress for an in-VM agent**, and the design keeps that out of the
client tier's data path by default (the host-shim, below).

## Contracts

- **PA-2** — engine boot and every operation fail soft: no image → the design
  conversation still happens; a boot wedge is discarded and retried; the chat
  never errors because the VM didn't come up.
- **PA-4** — image fetches carry no conversation/identity; in-VM work stays in
  the browser-local overlay; egress is kept off the VM (host-shim) or is a
  declared, minimal, metered path (relay).
- **PA-5** — the image is **built from source, out of band, by a reproducible
  script**, never committed (a build artifact), served same-origin. Tools are
  added by editing the recipe and rebuilding — evidence-driven, versions
  pinned.
- **PA-7** — the thin `ExecEngine` interface keeps the agent loop
  (`bash-core`) engine-independent and Node-testable against a mock engine;
  CheerpX lives behind it as today's implementation.
- **PA-8/PA-9** — if the VM ever needs the internet, egress rides the grant
  bridge (a metered "network" permission), never an open proxy; keys never
  enter the VM.
- **PA-10** — a new image becomes the default only after booting end-to-end on
  real devices (incl. iOS Safari under `require-corp`); the boot path is
  protected — minimal diffs, live verification.

## The engine + image decision (docs/JS-VM-RESEARCH.md has the full matrix)

- **Engine: CheerpX.** x86 32-bit (i386) only — so the image is i386. Robust,
  fast (x86→WASM JIT), same block-device + overlay + IndexedDB-cache model the
  reference already uses. Not source-buildable; that trade is accepted.
- **Image: our own, smallest-practical, self-hosted.** Default **Alpine
  i386**, aggressively trimmed (strip docs/man/apk+pip caches, `resize2fs -M`),
  target **well under ~200 MB** with the toolchain — ~10× smaller than the
  current third-party Debian. Debian-i386-slim is the glibc compatibility
  option; **archlinux32 stays selectable but is the heavy choice, not the
  speed default** (several hundred MB — it contradicts load-fast unless fully
  prefetched).
- **Fallback ladder (recorded, not adopted):** container2wasm (Apache-2.0,
  build-from-Dockerfile, x86_64), v86 (BSD, tiny, i386, snapshot), qemu-wasm
  (GPL, 64-bit, heavy). Behind the `ExecEngine` interface so a future platform
  *could* pick one; near-term we do not.

## Build plan

1. **Build the small image from our recipe** (`scripts/build-sandbox-image.sh`,
   reproducible, out of band, never run by deploy). Default target Alpine
   i386: `mkfs.ext2` (ext2 — CheerpX mounts root as ext2, not ext4), bootstrap
   the i386 userland (`apk --arch x86`), install the toolchain the exec bridge
   and transcripts need (`bash coreutils grep sed gawk findutils file less
   python3 jq` + whatever tools the current task wants — this is the
   add-tools-as-we-go surface), configure `root` + `/bin/bash --login`, trim
   hard, `resize2fs -M`, verify every binary is `Intel 80386`. Upload to the
   blob store, register the row.
2. **Self-host it, served same-origin with `Range`** (`GET
   /sandbox/img/<id>.ext2`, immutable, content-addressed by id — never mutate,
   publish a new id). Same-origin means no cross-origin/CORP concern under
   `require-corp`, and the block cache is keyed per image so switching is
   clean. (This plumbing already exists in the reference — inert until an image
   is selected.)
3. **Wire full prefetch — the no-stall requirement.** When a small self-hosted
   image is selected, fetch the whole disk once into the browser's IndexedDB
   block cache — backgrounded after first boot (coarse: one `fetch()` of the
   image so the browser/edge cache is warm and CheerpX's block reads hit
   cache) or eager. After that, **every command runs against a fully-local
   disk and issues zero network reads.** Gate it to small self-hosted images;
   never prefetch the multi-GB third-party default. This is the single most
   important lever for "loads quickly, commands don't stall."
4. **Keep the `ExecEngine` seam thin** (future-proofing): the agent loop
   already talks a small vocabulary — boot / exec / writeFiles / readFile /
   snapshot / dispose — and only `sandbox.js` knows CheerpX. Leave it that way;
   don't hard-couple new sandbox features to CheerpX APIs where the loop's
   interface would do. No adapters need writing now.
5. **Egress for an in-VM agent** (if/when the studio runs one): default the
   **host-shim** — the VM makes NO external calls; an in-VM loopback endpoint
   bridges over the net device to a host `postMessage` channel and the host's
   provider registry performs the LLM call on the user's key. Keys never enter
   the VM; the VM opens no external socket. Only for genuine internet needs
   (package install, `git clone`) open a **metered, disclosed, same-origin
   WebSocket↔TCP relay** reusing the grant bridge (a "network" permission).

## Reference implementation map

| Concept | Reference |
|---|---|
| The engine (CheerpX glue, the live foundation) | `public/js/sandbox.js` (CDN pin `cxrtnc.leaningtech.com/1.2.6`) |
| The engine-agnostic agent loop (the thin seam) | `public/js/bash-core.js` (`runShellLoop`, envelope codec) |
| Host↔guest file mounts + outbox | `public/js/sandbox-files.js`, `public/js/sandbox.js` |
| Self-hosted image plumbing (Range streamer, per-image cache, config) | `src/sandbox-image.js`, `src/config.js` (`sandbox` block), `public/js/sandbox.js` (`setSandboxImage`) |
| The reproducible image recipe (Alpine / Debian / archlinux32) | `scripts/build-sandbox-image.sh` |
| Full design + rollout discipline (small image, prefetch, verified-gate) | `docs/SANDBOX-LOCAL-IMAGE.md` |
| The research + decision matrix + fallback ladder | `docs/JS-VM-RESEARCH.md` |
| Egress meter to reuse for a "network" permission | `src/server-token.js`, `src/server-grants.js` |
| The live CheerpX foundation this builds on | `.claude/skills/execution-sandbox/SKILL.md`, `.claude/skills/sandbox-debug/SKILL.md` |

## Acceptance checklist

- [ ] The small Alpine-i386 image builds reproducibly from the recipe; `file`
      on its binaries says `Intel 80386`; the toolchain + any added tools run
      (`which` + a trivial invocation each).
- [ ] Image served **same-origin** with correct `206` `Range` responses and
      immutable cache headers; boots end-to-end on Chrome, Firefox, AND real
      iOS Safari under `require-corp` — only then flip `verified` and select as
      default (PA-10).
- [ ] **Loads fast:** initial boot to a working shell is convenient on a
      normal connection (small image), and **after prefetch a second boot +
      subsequent commands issue ZERO network reads for disk blocks** — no
      mid-command stalls (verified by watching the network panel / `wrangler
      tail`).
- [ ] Adding a tool = editing the recipe + rebuilding + publishing a new id;
      the old id still boots (rollback).
- [ ] The agent loop's tests pass against a mock engine with no CheerpX import
      (the seam stays thin).
- [ ] (If an in-VM agent ships) host-shim egress completes one LLM round-trip
      with the key never entering the VM and the VM opening no external socket.

## Pitfalls

- **Small image + prefetch is the whole answer to "don't stall."** Block-level
  lazy streaming is fundamental to how CheerpX mounts a disk — you cannot turn
  it off, so the win is (a) a tiny image with little to stream and (b)
  prefetching it entirely once. A big image (archlinux32, the third-party
  Debian) will stall commands on cold blocks no matter what; keep the default
  small.
- **archlinux32 is not the speed default.** The earlier "smaller Arch" steer is
  superseded by the load-fast requirement — Arch-family i686 is several hundred
  MB. Offer it selectable; default to Alpine.
- **Never prefetch the multi-GB third-party default** — prefetch is the
  small-self-hosted-image payoff only.
- **ext2, not ext4; i386, not x86_64.** CheerpX mounts root as ext2 and runs
  i386 only; an accidental ext4 or a 64-bit binary silently fails.
- **Same-origin is a feature.** Self-hosting the image removes the
  cross-origin/CORP dance under `require-corp` (the reference's CDN loads are
  the counter-example that has bitten before). Don't move image hosting to a
  CDN.
- **Never mutate an uploaded image** — immutable + content-addressed ids keep
  the year-long edge cache and the block cache coherent; a rollback is
  reselecting the old id.
- **The boot path is protected.** The running CheerpX sandbox is verified and
  load-bearing; change it with minimal diffs and live device verification (the
  execution-sandbox / sandbox-debug skills). The image branch was deliberately
  shaped as one `if` around the base device.
- **Egress is where keys leak if you're careless.** Default to the host-shim;
  never put the user's key inside the VM and let it call out — that breaks the
  client tier's whole promise.
- **The engine trade is settled — don't relitigate it in code.** CheerpX is
  proprietary; that's accepted. Keep the `ExecEngine` seam thin for
  future-proofing, but don't spend effort building c2w/v86/qemu adapters now.
