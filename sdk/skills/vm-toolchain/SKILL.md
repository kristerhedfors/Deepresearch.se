---
name: vm-toolchain
description: >-
  Load when making the SDK available INSIDE the pair's in-browser Linux VM or
  from the application interface itself — "the SDK in the sandbox", picking or
  building the prepackaged Linux image (CheerpX engine i386; small Alpine
  Alpine fallback), the self-hosted image pipeline (R2 Range streamer, config
  registry, HttpBytesDevice, per-image caches), the full-prefetch
  "loads-in-its-entirety" mode, running sdk/pair-cli.mjs inside the VM, or the
  in-app skills catalog namespacing (sdk/<name>). Also load for desktop parity
  questions — the same SDK workflow from a VS Code/desktop checkout.
---

# VM toolchain — the SDK inside the prepackaged Linux

Make the pair its own development environment: the complete Agent-Pair SDK —
manifest, all skills, the CLI — available (1) from a **desktop checkout** (VS
Code or any editor/agent harness), (2) **inside the in-browser Linux VM** the
pair already ships, and (3) **from the application interface itself** (the
skills catalog both tiers' answer models can browse and quote). The VM path is
the distinctive one: a prepackaged, self-hosted Linux image that boots in the
user's browser with the SDK mounted, so "develop a pair" becomes something the
pair itself can do, on any device, with nothing installed.

## Capability class & tier story

Class **X**. The VM, the mounted SDK, and the CLI run **client-side in both
tiers** (the sandbox is the user's own browser — see the `execution-sandbox`
module). The server tier's only involvement is serving bytes: the image
streams from the pair's own origin (blob store + a Range-capable route), and
the SDK rides the same committed source snapshot the introspection module
already serves. Both are **public, static, operator-chosen content carrying no
user data** — the client tier fetching them is the same posture as fetching
any static asset, so the server stays out of the data path (PA-4 holds
structurally).

## Contracts

- **PA-2** — the sandbox (and everything this module adds to it) stays
  fail-soft: no image configured → the built-in default boots; image fetch
  fails → fall back; the chat never errors because the VM couldn't come up.
- **PA-4** — the image request and snapshot fetch carry no conversation, no
  identity beyond an ordinary asset request; generated work stays in the VM's
  browser-local overlay.
- **PA-5** — images are **build artifacts, not code**: built out of band by a
  reproducible script, uploaded to the blob store, never committed; the SDK
  arrives in the VM via the existing snapshot, adding zero build steps.
- **PA-7** — one SDK, three surfaces: the same files serve desktop, VM, and
  in-app catalog; nothing is hand-mirrored into the image.
- **PA-10** — the boot path is protected: a new image becomes the default only
  after booting end-to-end on real devices (the `verified` flag gate).

## Engine CheerpX; our own small, fast image (owner directives, 2026-07-16)

This module sits on top of the **`exec-engine`** module. Two settled
decisions:

- **Engine: CheerpX** (proprietary, CDN-loaded — the one part not built from
  source, accepted). It is **i386-only**, so images are i386.
- **Image: built from scratch by our own recipe, and SMALL + FAST.** The
  requirement that governs the image is: load quickly enough to be convenient,
  and **never stall a command while fetching hundreds of MB of blocks.** That
  makes the default the **smallest practical image — Alpine i386** — served
  self-hosted and **fully prefetched** so after the first (small) load the
  disk is entirely local and commands issue zero network reads.

archlinux32 (i686) remains a *selectable* option for anyone who specifically
wants Arch, but at several hundred MB it is the heavy choice — it works
against the load-fast requirement unless fully prefetched, so it is **not the
default** (this supersedes the earlier "smaller Arch as default" steer). The
image table, all i386:

| Image | Role | Contents |
|---|---|---|
| `alpine-i386-*` | **The default** (small + fast, once verified) | base + research toolchain (`bash coreutils grep sed gawk findutils file less python3 jq`) + **`nodejs` + `git`** so `pair-cli` and generated-app tests run in-VM; musl; trimmed hard (docs/man/caches stripped, `resize2fs -M`); target **well under ~200 MB** so full prefetch loads it in its entirety quickly |
| `debian-i386-slim-*` | Compatibility option | glibc, the known-good lineage; larger than Alpine |
| `arch32-i686-*` | Selectable (heavy) | archlinux32 for those who specifically want Arch; several hundred MB — needs prefetch to not stall, not the speed default |

**"Loads in its entirety" = full prefetch.** Block-lazy streaming is inherent
to how CheerpX mounts a disk, so the goal is not "no blocks" but "all blocks
local": a one-time fetch of the whole small image into the browser's IndexedDB
cache, after which boots and commands touch the network zero times. Prefetch
is config-gated and only ever for a small self-hosted image — never the
multi-GB third-party default. Small image + prefetch together are the answer
to "load quickly, don't stall fetching more data."

## Build plan

1. **Self-hosted image plumbing** (in the reference this is implemented and
   inert): a `sandbox` config block — image registry rows
   `{id, label, arch, size_mb, verified}` + the selected `image` id (`""` =
   built-in default) + `prefetch`; a public Range-capable blob-store route
   `GET /sandbox/img/<id>.ext2` (206 partial content, immutable cache,
   content-addressed ids — never mutate an image, publish a new id); a public
   `GET /api/sandbox-image` config read both tiers use; the boot branch
   `imageUrl ? HttpBytesDevice : the built-in CloudDevice`, with the
   IndexedDB block cache **keyed per image** so switching images never serves
   stale blocks.
2. **The build script** (out of band, reproducible, never run by deploy):
   `mkfs.ext2` (ext2 specifically — not ext4), bootstrap an **i386 userland**
   (`apk --arch x86` / `debootstrap --arch=i386` / the archlinux32 bootstrap
   tarball + `pacman`), install the toolchain packages the exec bridge and
   research transcripts depend on, configure `root` + `/bin/bash --login`,
   trim caches/docs, verify with `file` (must say `Intel 80386`), upload,
   register the row in the admin panel. The arch32 variant adds
   `nodejs git` — that is what turns the sandbox into the SDK dev
   environment.
3. **Prefetch consumption** (owed in the reference; design settled): when
   `prefetch` is on AND a self-hosted image is selected, kick a background
   full `fetch()` of the image after boot so the browser/edge cache is warm;
   escalate to precise Range-walking into the block cache only if cold reads
   persist. Gate hard: small images only.
4. **The SDK mount — free by construction**: the introspection module's
   committed source snapshot includes the whole repo (`sdk/` included), and
   the sandbox already mounts it at `/src`. Inside any image:
   `ls /src/sdk` → manifest, skills, CLI. With nodejs in the image:
   `node /src/sdk/pair-cli.mjs validate|list|plan …`. No copying, no baking
   the SDK into images — a deploy's VM always carries exactly that deploy's
   SDK (the same by-construction freshness the snapshot gives introspection).
5. **In-app discoverability**: the skills catalog (shared pure core) matches
   BOTH skill roots — operational `.claude/skills/<name>` under bare names,
   SDK modules `sdk/skills/<name>` **namespaced as `sdk/<name>`** (two ids
   deliberately collide: execution-sandbox, decision-boards). Mentions
   resolve the namespaced form always, and the bare module id when
   unshadowed; the catalog header tells the model both roots exist. Result:
   in either tier, "show me the sdk/pair-generator skill" quotes the real
   file from the running deploy.
6. **Desktop parity**: nothing VM-specific in the SDK itself — a desktop
   clone opens in VS Code (or any harness), the same CLI runs from the repo
   root, and the vendor-neutral agents file points external agents at both
   skill catalogs. The VM is a convenience surface over the same files, never
   a fork.

## Reference implementation map

| Concept | Reference |
|---|---|
| Image config block + validation | `src/config.js` (`sandbox` block) |
| Blob-store Range streamer + public config read | `src/sandbox-image.js` (`/sandbox/img/:id.ext2`, `/api/sandbox-image`) |
| Boot branch + per-image block cache | `public/js/sandbox.js` (`setSandboxImage`, `HttpBytesDevice` vs `CloudDevice`) |
| Reproducible image builds (alpine / debian / **arch32**) | `scripts/build-sandbox-image.sh` |
| The full design + rollout discipline | `docs/SANDBOX-LOCAL-IMAGE.md` |
| The `/src` snapshot mount into the VM | `public/js/sandbox-files.js` (`planSourceMount`) |
| The snapshot the SDK rides in | `scripts/bundle-source.mjs` → `public/introspect/source-snapshot.json` |
| Skills catalog incl. the `sdk/<name>` namespace | `public/js/introspect-core.js` (`SKILL_PATH_RE`, `SDK_SKILL_PATH_RE`, `skillsCatalog`, `mentionedSkills`) |
| The CLI that runs on desktop and in-VM | `sdk/pair-cli.mjs` (+ `sdk/pair-cli.test.mjs`) |
| Admin image picker | `public/js/admin.js` (Linux sandbox image panel) |

## Acceptance checklist

- [ ] Image plumbing ships **inert**: with no image selected, boot is
      byte-identical to the built-in default (unit + live check).
- [ ] The arch32 image builds reproducibly; `file` on its binaries says
      `Intel 80386`; `bash`, `sh`, `base64`, `printf`, `node`, `git` present
      on the exec bridge's PATH.
- [ ] The image boots end-to-end on Chrome, Firefox, AND real iOS Safari
      under the cross-origin-isolation headers — only then flip
      `verified: true` and select it as default (PA-10).
- [ ] Inside the VM: `ls /src/sdk/skills` lists all modules;
      `node /src/sdk/pair-cli.mjs validate` prints OK.
- [ ] With prefetch on: second boot issues zero network reads for disk
      blocks.
- [ ] In-app: the skills catalog lists `sdk/<name>` entries; naming one
      inlines its SKILL.md; the colliding bare names still resolve the
      operational skill only (test-pinned).
- [ ] Desktop: `node sdk/pair-cli.mjs plan <module>` from a fresh clone
      prints the same order the VM run prints.

## Pitfalls

- **CheerpX is i386-only.** Mainline Arch (x86_64) will not boot — no amount
  of image-building effort changes that. Any "Arch" image is archlinux32
  (i686). An accidentally-included 64-bit binary silently fails at exec time;
  verify every binary at build.
- **The boot path is a protected foundation.** The reference's sandbox skill
  requires minimal diffs + live device verification for any change there —
  the image branch was deliberately shaped as one `if` around the base device
  and nothing else.
- **iOS Safari + COEP**: the isolation headers must be `require-corp`
  (`credentialless` is ignored on iOS); the image being **same-origin** is
  what keeps CORP out of the picture entirely — don't move image hosting to a
  CDN and reintroduce that class of failure.
- **Per-image cache keys are correctness, not optimization**: block N of
  image A and image B are different bytes; a shared IndexedDB cache serves
  corruption.
- **Never mutate an uploaded image** — immutable + content-addressed ids are
  what make the year-long edge cache and the block cache coherent, and a
  rollback = reselect the old id.
- **musl vs glibc**: models reach for glibc-isms; the package list, not the
  libc, is what usually breaks a transcript — seed the common toolchain and
  grow it from real logged failures (evidence-driven, PA-5).
- **Prefetch discipline**: never prefetch the multi-GB third-party default;
  prefetch is the small-image payoff, and it's opt-in config.
- **Don't bake the SDK into images.** It's tempting ("the SDK image") and
  wrong: baked copies go stale the next deploy; the `/src` snapshot mount is
  always exactly the running deploy's SDK.
