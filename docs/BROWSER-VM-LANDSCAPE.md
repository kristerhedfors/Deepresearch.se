# Browser-VM landscape — engines for the sandbox, the SDK-in-VM, and agentic development

*Web research pass, 2026-07-16. Companion to `docs/SANDBOX-LOCAL-IMAGE.md`
(the image pipeline) and the SDK's `vm-toolchain` / `pair-studio` module
skills. This document answers: given OUR conditions, which in-browser
virtual machines / JavaScript-runtime VMs are the appropriate ones, per use
case — including the new requirement that AGENTIC DEVELOPMENT (a real coding
agent such as OpenCode or Claude Code) can happen inside the VM.*

## 0. Our conditions (what a candidate is judged against)

1. **Runs in the page, client-side** — the sandbox is the user's own browser
   (both tiers; on Se/cure the server is in no data path). Cross-origin
   isolation is already served (`COEP: require-corp` — iOS Safari ignores
   `credentialless`), so SharedArrayBuffer engines are fine, but every
   cross-origin subresource needs CORP (the 2026-07-11 incident class).
2. **Real iOS Safari support** — the standing device bar for the sandbox.
   Anything requiring wasm64/memory64 is out for now (Safari does not ship
   it; QEMU's wasm64 notes confirm).
3. **Self-hostable artifacts** — disk images/runtimes served same-origin
   (the `HttpBytesDevice` + R2 Range pipeline), minimal third-party runtime
   dependencies (invariant 5; the `disks.webvm.io` lesson).
4. **The exec-bridge contract** — `/bin/sh -c`, `base64`, marker protocol,
   file mounts, the outbox (bash-core.js) — i.e. a real POSIX userland.
5. **Toolchain for the SDK-in-VM** — `node` + `git` inside the guest
   (`node /src/sdk/pair-cli.mjs …`), plus the research toolchain.
6. **Agentic development in-VM** — run a coding agent against a workspace:
   needs a modern runtime (Node ≥18 / Bun), git, and HTTPS egress to LLM
   APIs.
7. **Licensing sanity** — commercial terms must be knowable; fail-soft if a
   CDN-loaded engine disappears (the CheerpX engine load is already the one
   CDN dependency we tolerate, license question standing).

## 1. The candidates (state as of 2026-07)

### CheerpX (Leaning Technologies) — the incumbent
x86→WASM JIT + Linux syscall emulator; powers WebVM; we pin 1.2.6 from
their CDN. **Still 32-bit i386 only** — 64-bit is roadmap, not shipped
(confirmed against current docs/repo; webvm#165 remains open). Fast (JIT,
not interpretation), proven on iOS Safari under `require-corp` (our own
live baseline), self-hosted ext2 images work via `HttpBytesDevice`.
Networking = Tailscale-over-WebSockets (per-user VPN; heavyweight for our
posture). Licensing: free for personal/open-source; **commercial use
requires a license** (terms page still thin — the standing question).
**Verdict: keep as the sandbox's engine.** The i386 wall is real but does
not block the current sandbox, the SDK toolchain (distro i386 `nodejs`
exists on Debian i386 / Alpine x86 / archlinux32), or host-orchestrated
agents. It does block modern 64-bit-