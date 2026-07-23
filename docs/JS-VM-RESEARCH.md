# In-browser execution engines for the agent-pair sandbox — research & decision

*Research date: 2026-07-16. Lens: we must **build our own execution
environments from scratch** — for the part we control, which is the IMAGE
(our own rootfs recipe / Dockerfile, our tools, self-hosted). The ENGINE is
**CheerpX** (owner decision, 2026-07-16): proprietary and CDN-loaded, the one
part we do not build ourselves, accepted. The alternatives surveyed below are
inspiration + a fallback ladder behind a thin engine interface, not a switch
we are throwing. The governing image requirement is **small + fast-loading +
no mid-command stalls fetching hundreds of MB.***

## Why this research

The pair's sandbox (the `execution-sandbox` module) and the SDK's
`vm-toolchain`/`pair-studio` modules need a JavaScript/WASM virtual machine
that can:

1. Run a **real Linux userland** (not a reimplemented Node API) so arbitrary
   tools — `git`, `python3`, `jq`, and crucially an **agentic coding CLI**
   (OpenCode / aider / similar) — run as ordinary binaries.
2. Boot from an **image we build ourselves** from a Dockerfile/rootfs recipe,
   so we add exactly the tools we need and pin them.
3. Run **client-side in both tiers**, self-hosted (engine + image from our own
   origin), under cross-origin isolation, including on **iOS Safari**.
4. Fail soft, mount host files, export deliverables, and ideally snapshot.

The owner directive (2026-07-16) makes **source control of the engine and the
image the deciding criterion**. Everything below is evaluated against it.

## The landscape (2026-07)

### Engines whose source we control — the candidates we can actually build

| Engine | License | Source-buildable | Guest arch | Real Linux userland | Custom images from our Dockerfiles | iOS Safari | Notes |
|---|---|---|---|---|---|---|---|
| **v86** (`copy/v86`) | **BSD-2-Clause** | **Yes** — Rust→`wasm32` JIT + `make` + Closure | **x86 32-bit only** (no 64-bit kernels) | Yes (Alpine works well) | Yes — `tools/docker` + Buildroot recipes; separate images repo | Yes (well-tested WASM path) | Small, auditable, fully FOSS; snapshot save/restore; NE2000 net via a WebSocket↔TCP relay. **The lean, fully-controlled x86-32 path.** |
| **container2wasm / `c2w`** (`container2wasm/container2wasm`, NTT) | **Apache-2.0** | **Yes** — converter is ours; wraps our OCI image | **x86_64** or **riscv64** (Bochs / TinyEMU / QEMU inside) | Yes — *your* container image verbatim | **Yes, directly** — `docker build …` your Dockerfile, then `c2w img out.wasm` | Yes (Fetch/WebSocket runtime) | **The most on-point answer to "build our own containers exactly as we need."** Emulated CPU ⇒ slower; net via Fetch/WebSocket + gvisor-tap-vsock. |
| **qemu-wasm** (`ktock/qemu-wasm`) | **GPL-2.0** (QEMU) | **Yes** — Emscripten build; WASM TCG backend upstreaming into QEMU (TCI 32-bit in 10.1; 64-bit under review) | **x86_64 / aarch64 / riscv64** | Yes — any QEMU disk/container image we build | In progress; heavier | On the mainline-QEMU track. Broadest arch, real 64-bit; **slowest today** (TCI + selective WASM JIT). The "heavy but future-proof" path. |
| **linux-wasm** (`joelseverin/linux-wasm`) | Open (kernel GPL) | Yes, experimental | Kernel compiled to WASM (NOMMU) | BusyBox+musl only, early | rootfs we build | Chrome crashes reported | Fastest in theory (~200+ MIPS, native-ish, beats jor1k/WebCM emulation); **unstable, no MMU, no raw sockets**. Watch, don't ship. |

### Proprietary / source-closed — inspiration only, rejected as the buildable default

| Engine | Why it's out (under the directive) | What to borrow |
|---|---|---|
| **CheerpX** (Leaning Technologies) — the reference product's current engine | Proprietary; **engine loaded from `cxrtnc.leaningtech.com` CDN, no source, commercial license required for business use**; x86 32-bit only today (64-bit on the roadmap). We cannot build it. | Its robustness bar, the block-device + overlay model, and its Tailscale-over-WebSocket networking design are the reference for our own net path. |
| **WebContainers** (StackBlitz) | Closed; **commercial license required for production**; **no native binaries** (reimplements the Node API on the browser's JS engine) — so an agentic CLI shipped as a native/Bun binary, or any non-JS tool, can't run; no source. | Its DX and instant boot are the UX bar for `pair-studio`; the API-reimplementation trick is a dead end for "run arbitrary tools". |
| **BrowserPod / CheerpOS** (Leaning Technologies) | Proprietary; compiles the real Node binary to WASM but is closed and **priced per compute-hour**; git + broad tooling but not our source. | The "compile the actual server binary" idea and the port-forwarding "Portals" model inform our egress design. |

## Decision (owner directive, 2026-07-16)

**The engine is CheerpX — decided.** The alternatives above are recorded as
inspiration and as a fallback ladder, not a switch we are throwing. CheerpX is
the one part of the stack we do **not** build from source (proprietary, loaded
from `cxrtnc.leaningtech.com`), and that is accepted.

**What we DO build from source is the IMAGE** — which is the whole "build our
own execution environments from scratch" requirement for the part we control:
the disk image is a FOSS distro (Alpine / Debian / archlinux32) assembled by
**our own reproducible recipe** (`scripts/build-sandbox-image.sh`), with
exactly the tools we choose, pinned, and **added to as we go** by editing the
recipe and rebuilding. We host it from our own origin. So: proprietary engine
(accepted), our image (built from scratch, self-hosted).

**The governing image requirement is SMALL + FAST + NO MID-COMMAND STALLS.**
It must load quickly enough to be convenient, and commands must not stall
while the VM fetches hundreds of MB of blocks on demand. That drives three
choices:

1. **Smallest practical image as the default: Alpine i386**, aggressively
   trimmed (docs/man/caches stripped, `resize2fs -M`), target well under
   ~200 MB with the toolchain — ~10× smaller than the current third-party
   Debian. (archlinux32 stays a *selectable* option for anyone who wants Arch
   specifically, but at several hundred MB it is the heavy choice, not the
   speed default — the earlier "smaller Arch" steer yields to the load-fast
   requirement.)
2. **Self-hosted from our own origin** (blob store + a `Range` route), so no
   third-party block server sits in the hot path and blocks stream from our
   edge cache.
3. **Full one-time prefetch into the browser's IndexedDB block cache** — the
   direct answer to "don't stall fetching more data." Because the image is
   small, the whole disk is fetched once (backgrounded after first boot, or
   eager), after which **every command runs against a fully-local disk and
   touches the network zero times.** This is only practical *because* the
   image is small; the two requirements reinforce each other.

The **`ExecEngine` interface** (the `exec-engine` module) is kept as thin,
optional future-proofing. The reference already has the seam (the agent loop
`bash-core.js` is engine-agnostic; only `sandbox.js` knows CheerpX), and
formalizing it costs nothing and keeps the fallback ladder open. It is
**not** a plan to move off CheerpX. The near-term work is entirely: build the
small Alpine image from our recipe, self-host it, and wire full prefetch.

## The two hard parts (design, recorded so we build them right)

### A. Building our own images — the pipeline

- **Author a Dockerfile** with the exact toolchain (base + `bash coreutils
  git python3 jq` + `nodejs`/`bun` + the agent CLI). Pin versions. This is the
  "add tools as we go" surface: change the Dockerfile, rebuild.
- **c2w path:** `docker build -t envimg .` → `c2w envimg out.wasm` → serve the
  bundle from our own static host / blob store with `Range`. x86_64 guest.
- **v86 path:** build an ext2/rootfs via Buildroot or the in-repo
  `tools/docker` recipe, `mkfs.ext2`, self-host the engine + image (no CDN).
  i386 guest (the CheerpX-lineage constraint disappears — we own the engine).
- **qemu-wasm path:** any QEMU disk image (build with the normal `qemu-img` +
  a Dockerfile-derived rootfs), emscripten-built engine.
- **All three are OUR artifacts** — built out of band by a reproducible
  script, uploaded to our origin, never committed (they are build artifacts,
  PA-5), served same-origin (so cross-origin-resource-policy is a non-issue
  under `require-corp`).

### B. Network egress for the in-VM agent (the real constraint)

An agentic CLI inside the VM needs to reach an LLM API, and browsers give a
VM no raw sockets. Two designs, and the pair's privacy model picks between
them per tier:

- **Preferred for the client tier — keep egress OUT of the VM.** The VM does
  NOT make LLM calls. The host page's provider registry does (browser-direct,
  on the user's key / local server, exactly as the pipeline already works).
  The in-VM agent talks to a tiny **local shim** (a loopback endpoint the VM
  reaches over its virtio/NE2000 net bridged to a host `postMessage` channel)
  that forwards prompt→completion through the host. Keys never enter the VM;
  the VM never opens an external connection. This is the cleanest fit for
  "server in no data path" and should be the default.
- **When the VM genuinely needs the internet** (installing packages, cloning a
  repo): a **same-origin WebSocket↔TCP relay** (the CheerpX-Tailscale /
  gvisor-tap-vsock / v86-websocket-proxy pattern). Under PA-4/PA-8 this is a
  **declared, opt-in, minimal, metered** egress — the same discipline as the
  grant bridge, ideally reusing it (a "network" permission on a server token),
  never an open proxy.

Recording this now prevents the tempting-but-wrong shortcut of putting the
user's API key inside the VM and letting it call out directly.

## What this means for the SDK modules

- **`execution-sandbox`** (the reference's live CheerpX sandbox) is the engine
  — kept. CheerpX is i386-only, so images stay i386.
- **`exec-engine`** (class X, layer 5): the near-term substance is the
  **build-our-own-IMAGE-from-scratch pipeline on CheerpX** — the reproducible
  Alpine-i386 recipe, self-hosting from our origin, the small+fast+prefetch
  requirement, and the in-VM agent egress design (host-shim keeps keys/egress
  out of the VM). The thin `ExecEngine` interface + the c2w/v86/qemu fallback
  ladder are recorded as optional future-proofing, not a migration plan.
- **`vm-toolchain`** depends on `exec-engine`: the self-hosted-image plumbing
  already exists; the default becomes the **smallest fast-loading image
  (Alpine i386) with full prefetch** so it loads quickly and commands never
  stall. archlinux32 stays selectable but is the heavier, non-default choice.

## Sources

- CheerpX / WebVM: [cheerpx.io](https://cheerpx.io/), [licensing](https://cheerpx.io/licensing), [CheerpX 1.0 blog](https://labs.leaningtech.com/blog/cx-10), [webvm](https://github.com/leaningtech/webvm), [64-bit issue #165](https://github.com/leaningtech/webvm/issues/165), [networking via Tailscale](https://labs.leaningtech.com/blog/webvm-virtual-machine-with-networking-via-tailscale)
- v86: [github.com/copy/v86](https://github.com/copy/v86), [npm](https://www.npmjs.com/package/v86)
- container2wasm: [github.com/container2wasm/container2wasm](https://github.com/container2wasm/container2wasm), [NTT Labs write-up](https://medium.com/nttlabs/container2wasm-2dd90a18cc9a), [vscode-container-wasm](https://github.com/ktock/vscode-container-wasm)
- qemu-wasm: [github.com/ktock/qemu-wasm](https://github.com/ktock/qemu-wasm), [QEMU WASM TCG backend patches](https://patchew.org/QEMU/cover.1747744132.git.ktokunaga.mail@gmail.com/), [FOSDEM 2025 slides](https://archive.fosdem.org/2025/events/attachments/fosdem-2025-6290-running-qemu-inside-browser/slides/238760/slides_1dDtpcS.pdf)
- linux-wasm (native kernel→wasm): [Phoronix](https://www.phoronix.com/news/Linux-Kernel-WebAssembly), [BigGo coverage](https://biggo.com/news/202511040716_Linux_WebAssembly_Performance_Bugs)
- WebContainers / Bolt: [webcontainers.io](https://webcontainers.io/), [bolt.new](https://github.com/stackblitz/bolt.new), [BrowserPod vs WebContainers](https://browserpod.io/compare/browserpod-vs-webcontainers/)
- OpenCode (the in-VM agent target): [opencode.ai/docs](https://opencode.ai/docs/), [sst/opencode DeepWiki](https://deepwiki.com/sst/opencode)
