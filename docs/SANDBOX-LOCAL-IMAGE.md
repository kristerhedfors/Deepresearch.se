# Serving a local, small Linux image for the sandbox (admin-selectable)

*Design + plan. Research date: 2026-07-14.*

> **STATUS (2026-07-14): the plumbing is IMPLEMENTED and inert-by-default; the
> image itself is not yet built/uploaded, and the boot path is not yet
> live-verified.** Shipped in this change:
> - `src/sandbox-image.js` — the R2 `Range` streamer `GET /sandbox/img/<id>.ext2`
>   and the public config endpoint `GET /api/sandbox-image` (both routed pre-auth
>   in `index.js`); Node-tested (`sandbox-image.test.js`).
> - `src/config.js` — the `sandbox` block (`image` / `images[]` / `prefetch`) +
>   its validation (`config.test.js`).
> - `public/js/sandbox.js` — `setSandboxImage(url, prefetch)` + the
>   `HttpBytesDevice`-vs-`CloudDevice` branch with a per-image block cache;
>   **fail-soft fallback to the built-in default**, so with no image selected the
>   boot is byte-identical to before.
> - `public/js/app.js` (DRS) + `public/cure/drc.js` (DRC) — fetch
>   `/api/sandbox-image` and point `sandbox.js` at the selection before boot.
> - `public/js/admin.js` — the **Linux sandbox image** config panel (dropdown +
>   registry + add-image form + i386 warning + prefetch toggle).
> - `scripts/build-sandbox-image.sh` — the reproducible Alpine/Debian i386 build.
>
> **Still owed (see §8):** build + upload a real i386 image, flip its `verified`
> flag after booting it end-to-end on a real device (iOS Safari especially), and
> only then select it as the default. `prefetch` is plumbed but not yet consumed
> by the client (§6). Until an image is uploaded and selected, everything above
> is dormant and the sandbox streams the current webvm.io default unchanged.

## What this is

Today the in-browser Linux sandbox (see the **execution-sandbox** skill) boots
by streaming a **large Debian image from a third party**:

```js
// public/js/sandbox.js
const DISK_URL = "wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2";
const blockDevice  = await CheerpX.CloudDevice.create(DISK_URL);   // WebSocket block server
const blockCache   = await CheerpX.IDBDevice.create(IDB_CACHE_ID); // "deepresearch-sandbox-vm"
const overlayDevice = await CheerpX.OverlayDevice.create(blockDevice, blockCache);
```

`CloudDevice` streams the disk **block by block over a WebSocket from
`disks.webvm.io`** (Leaning Technologies' hosted block server), caching touched
blocks in IndexedDB. This works, but it means:

- **A third-party runtime dependency in the hot path.** Every cold boot (and
  every not-yet-cached block) reaches out to `disks.webvm.io`. If it's slow,
  rate-limited, moved, or gone, the sandbox degrades or dies. This is a
  dependency we don't control and don't monitor.
- **A big image.** `debian_large` is a full Debian install (multiple GB on
  disk). Even lazy block streaming pays for cold-cache reads across a large
  filesystem, and the IndexedDB block cache grows accordingly.
- **No control over contents.** We can't pin the toolchain, trim it, or add the
  packages the research model actually reaches for.

**The goal:** serve a **small Linux image (a few hundred MB) from our own
origin**, and let an **admin in DeepResearch.Se/rver pick the default image**
from the control panel.

> ### Framing note — "chunk by chunk" streaming is inherent, and that's fine
> The request was phrased as "run smaller Linux that doesn't stream inode by
> inode / chunk by chunk." Two things to separate:
>
> 1. **Block-level lazy streaming is fundamental to how CheerpX mounts a disk
>    image.** `HttpBytesDevice` (the self-hosted device, below) *also* fetches
>    blocks on demand via HTTP `Range`, exactly like `CloudDevice` does over
>    WebSocket. You do **not** download a whole image before boot with either
>    device, and you would not *want* to for a large one. So the win isn't
>    "stop streaming blocks"; it's **(a) stream them from OUR origin instead of
>    a third party, (b) from a MUCH smaller image so there's little to stream
>    and it fully caches fast, and (c) an image WE built and can pin.**
> 2. If a truly small image is chosen (~150–300 MB), a **one-time full
>    prefetch into the IndexedDB cache** becomes practical: after the first
>    boot the whole disk is local and later boots touch the network zero times.
>    That's the closest thing to "don't stream chunk by chunk," and it's an
>    opt-in optimization layered on top (see §6), not a different device.
>
> Net: self-host a small image via `HttpBytesDevice`, keep the same overlay +
> IDB cache, and the "streaming from an external source" concern is gone.

---

## 1. The load-bearing constraint — CheerpX is **32-bit x86 (i386) ONLY**

**This determines which distros are even bootable, so read it first.** CheerpX
(through the current release; we pin `1.2.6` from the `cxrtnc.leaningtech.com`
CDN) JIT-compiles and emulates **32-bit x86 (i386) binaries only**. 64-bit
(x86-64) and ARM are on the roadmap but not shipped. This is why WebVM ships an
**i386 Debian** — the one mainstream distro that still maintains a full i386
port.

**Consequence for "Arch Linux":** mainline Arch has been **x86_64-only since
2017** and has **no i686 kernel or packages**, so it **cannot boot on CheerpX**.
The only i686 Arch is the community fork **`archlinux32`** (separate repos,
smaller mirror network, slightly heavier base than Alpine). So:

| Distro | i386 available? | Base size (minimal ext2) | Verdict |
|---|---|---|---|
| **Alpine Linux** (`x86`) | **Yes**, first-class | ~8–40 MB base, ~100–200 MB with python3/coreutils/build tools | **Recommended default** — genuinely small, musl libc, `apk` |
| **Debian i386** (slim) | **Yes** (WebVM's lineage) | ~120–300 MB slim | Safe, glibc, familiar; the "known-good" fallback |
| **archlinux32** (i686) | Yes (community fork) | ~400–800 MB | Possible if "Arch" branding is required; heavier, niche |
| **Void Linux** (i686) | Yes | ~150–350 MB | Viable alternative; less tested with CheerpX |
| **Mainline Arch** (x86_64) | **No** | — | **Won't boot** on CheerpX |

> **Recommendation:** ship **Alpine i386** as the small default (it's the
> literal "smaller Linux" the request asks for, ~10× smaller than the current
> Debian), keep a **Debian i386-slim** image as the compatibility option, and
> treat "Arch" as an **optional `archlinux32` image** an operator can build and
> select if they specifically want it, with the size reality (several hundred
> MB, not tiny) documented. The admin picker (below) makes this a per-deploy
> choice, not a code change.
>
> **One caveat with Alpine/musl:** the model sometimes reaches for
> glibc-only behaviors. The image's package list must cover the common
> research toolchain (`bash`, `coreutils`, `grep`, `sed`, `awk`, `python3`,
> `jq`, `file`, `findutils`, `less`) so transcripts don't fail on a missing
> binary. Debian-slim is the safer bet if broad compatibility beats size; the
> picker lets the operator decide.

---

## 2. The mechanism — `HttpBytesDevice` in place of `CloudDevice`

CheerpX's documented device for a **self-hosted ext2 image over HTTP** is
`HttpBytesDevice`:

> *"The default choice for loading filesystem images via HTTP … Create an
> HttpBytesDevice for streaming disk blocks via HTTP:*
> `const httpDevice = await CheerpX.HttpBytesDevice.create('https://yourserver.com/image.ext2')`*"*
> — CheerpX File-System-support guide

It supports HTTP `Range` requests (lazy block streaming) and slots straight
into the existing overlay/cache stack. The `sandbox.js` change is minimal and
**additive**: pick the base device by whether a local image is configured.

```js
// public/js/sandbox.js — inside bootVM(), replacing the fixed CloudDevice line.
// imageUrl comes from config (§4). Empty/absent → the current webvm.io default,
// so nothing regresses until an image is uploaded AND selected.
setStatus("connecting disk…");
let blockDevice;
if (imageUrl) {
  // Self-hosted ext2, same-origin, served from R2 with Range (§3).
  blockDevice = await CheerpX.HttpBytesDevice.create(imageUrl);
} else {
  blockDevice = await CheerpX.CloudDevice.create(DISK_URL); // unchanged fallback
}
const blockCache    = await CheerpX.IDBDevice.create(cacheIdFor(imageUrl));
const overlayDevice = await CheerpX.OverlayDevice.create(blockDevice, blockCache);
```

Everything downstream (`OverlayDevice`, the mounts array, the `DataDevice`
file-ingest work, the seed script, exec) is **unchanged**; only the base
block device swaps.

### Cross-origin isolation is a non-issue here (unlike the CDN loads)

The sandbox document is served **COEP `require-corp`** (so `SharedArrayBuffer`
exists — see the execution-sandbox skill). Under `require-corp` every
*cross-origin* subresource must carry `Cross-Origin-Resource-Policy`. The image
is served **same-origin** (from our own Worker route, §3), so **CORP does not
apply** and there is nothing to configure: same-origin subresources are always
allowed. (Contrast the xterm/CheerpX CDN loads, which are cross-origin and rely
on the CDN sending CORP.) Self-hosting has a real advantage here: the disk
fetch stops being a cross-origin concern entirely.

### The IndexedDB block cache must be keyed per image

`IDB_CACHE_ID` is currently the fixed `"deepresearch-sandbox-vm"`. If the admin
switches images, a cache built from image A's blocks must not be reused for
image B (block N means different bytes). Derive the cache db name from the image
identity — `cacheIdFor(imageUrl)` = `"dr-sandbox-vm-" + shortHash(imageId)` —
so each image gets its own overlay cache and switching images is clean. The
`OverlayDevice`'s persistent guest writes are likewise per-image (a fresh image
starts with a fresh overlay), which is the correct semantics.

### CheerpX version / device-availability check

`HttpBytesDevice` is a long-standing CheerpX device, but **verify it exists in
the pinned `1.2.6`** before relying on it (the CDN URL is
`https://cxrtnc.leaningtech.com/1.2.6/cx.esm.js`). If not, bump the pin to a
version that has it (and re-run the sandbox's live device verification — this
is the protected boot path; see the execution-sandbox skill's WORKING
FOUNDATION note). `GitHubDevice` (chunked, WebVM-repo-oriented) is a second
self-hostable option but is tuned for GitHub-Actions chunk prep and is more
machinery than we need; `HttpBytesDevice` is the direct fit.

---

## 3. Hosting the image on Cloudflare — R2 + a Worker route (NOT static assets)

**Static Assets won't work:** Workers Static Assets cap at **25 MiB per file**,
so a few-hundred-MB `.ext2` can't be a `public/` asset. Chunking it would break
`Range`. Use **R2** (binding `STORAGE` already exists in `wrangler.toml`), which
supports `Range` natively, and stream it through a **same-origin Worker route**:

```
GET /sandbox/img/<imageId>.ext2      # public, Range-capable, long-cache
```

Handler sketch (new `src/sandbox-image.js`, wired in `index.js` **before** the
identity gate so both tiers reach it, and added to `isPublicAsset`-style public
routing — it exposes no user data, only the operator's chosen image):

```js
// GET /sandbox/img/:id.ext2 — stream a self-hosted sandbox image from R2 with
// Range support so CheerpX's HttpBytesDevice can lazily fetch blocks.
export async function handleSandboxImage(request, env, id) {
  const bucket = env.STORAGE;
  if (!bucket) return new Response("no storage", { status: 503 }); // fail-soft
  const key = `sandbox-images/${id}.ext2`;
  const range = request.headers.get("range");
  const obj = await bucket.get(key, range ? { range: parseRange(range) } : undefined);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable"); // content-addressed by id
  headers.set("etag", obj.httpEtag);
  // Same-origin ⇒ no CORP needed under require-corp; setting it is harmless.
  headers.set("cross-origin-resource-policy", "same-origin");
  if (range && obj.range) {
    headers.set("content-range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
```

Notes:
- **Immutable + content-addressed by `<imageId>`.** Never mutate an image
  in place. Publish a new id (e.g. `alpine-i386-2026-07`) and switch the
  config pointer. Then the year-long `immutable` cache and CheerpX's block
  cache are always coherent, and a rollback is just re-selecting the old id.
- **Range parsing must be correct** (single-range `bytes=start-end`, and the
  open-ended `bytes=start-`); CheerpX issues normal single ranges. Reuse a
  tested helper.
- **Edge caching:** Cloudflare caches the immutable ranges at the edge, so
  after the first user warms a POP, others in that POP stream blocks from the
  edge — the third-party dependency is fully gone.
- **Upload:** `npx wrangler r2 object put deepresearch-se-storage/sandbox-images/alpine-i386-2026-07.ext2 --file build/alpine-i386.ext2`
  (or the dashboard). Keep images out of git — they're build artifacts.

---

## 4. Admin selection — a `sandbox` block in site config

Mirror the existing admin-editable config knobs (`websearch`, `proxy`,
`anim_speed` in `src/config.js`). Add a `sandbox` block: a **registry of
available images** + the **selected default id**.

```js
// src/config.js — DEFAULT_CONFIG additions
sandbox: {
  // The selected default image id. "" = use the built-in webvm.io CloudDevice
  // (today's behavior) — so the feature is inert until an operator uploads an
  // image AND selects it. Nothing regresses on deploy.
  image: "",
  // Registry of self-hosted images the picker offers. Each: a stable id
  // (also the R2 object basename + the served /sandbox/img/<id>.ext2 path),
  // a human label, the arch (MUST be i386 — surfaced so the picker can warn),
  // an approximate size for the UI, and a `verified` flag (only verified
  // images are offered as a default — see §7 rollout).
  images: [
    // Example rows (populated once built + uploaded + live-verified):
    // { id: "alpine-i386-2026-07",  label: "Alpine (small)",    arch: "i386", size_mb: 180, verified: false },
    // { id: "debian-i386-slim-2026-07", label: "Debian slim",   arch: "i386", size_mb: 300, verified: false },
    // { id: "archlinux32-2026-07",  label: "Arch (archlinux32)", arch: "i386", size_mb: 650, verified: false },
  ],
  // Optional: fully prefetch the (small) image into the IDB cache on first
  // boot so later boots touch the network zero times (§6). Off by default.
  prefetch: false,
}
```

`mergeConfig`/`sanitizeConfigPatch` gain a `sandbox` branch that:
- coerces `image` to a string that MUST match a known `images[].id` (else falls
  back to `""` — an admin can't point the fleet at a non-existent image);
- validates each `images[]` row (id `^[a-z0-9-]+$`, label string, `arch`
  string, `size_mb` clamped ≥0, `verified` boolean);
- coerces `prefetch` to boolean.

### How each tier reads the selected image

The image URL is **not sensitive** (it's the operator's public choice, served
publicly from R2), so expose it the same way `anim_speed` is exposed via the
public `GET /api/anim`:

```
GET /api/sandbox-image   →  { url: "/sandbox/img/alpine-i386-2026-07.ext2" | "",
                              id: "alpine-i386-2026-07" | "",
                              prefetch: false }
```

- **DRS (`/rver`):** `app.js`/`stream.js` fetch `/api/sandbox-image` (or fold
  the fields into the existing `/api/settings` response) and pass `imageUrl`
  into `ensureSandboxBooted` → `bootVM`. Empty ⇒ current CloudDevice default.
- **DRC (`/cure`, server-in-no-data-path):** DRC may fetch the same **public**
  `/api/sandbox-image` — it returns only static operator config, no user data,
  so it does not violate the "server in no DRC data path" posture (same
  category as `/api/anim`, which `/cure` already calls). The image bytes
  stream from our R2 same-origin; no third party, no account. This keeps DRC's
  sandbox on the small self-hosted image too.

### Admin UI

Add a **"Linux sandbox image"** panel to `/admin` (`public/js/admin.js`),
alongside the web-search/proxy grant panels:
- a **dropdown** of `images[]` (label + size + arch), plus "Built-in (webvm.io
  Debian)" for `""`;
- an **i386 warning** shown if a selected/added image's `arch !== "i386"`
  (guards against someone adding an x86_64 Arch image that can't boot);
- an **"add image"** form (id / label / arch / size) that just registers a row
  — the bytes are uploaded to R2 out of band (wrangler/dashboard);
- the **prefetch** toggle.

This is a plain config panel (not a decision-board), so it does **not** need the
`board.js` machinery; it edits `config` like the quota/approval fields.

---

## 5. Building the image (reproducible, out of band)

Images are **build artifacts**, not code. Build them on a Linux host or CI,
upload to R2, register the row. Add `scripts/build-sandbox-image.sh` (documented,
not run by deploy) so the process is reproducible and auditable.

**General shape (Alpine i386 example):**

```sh
# 1. Make an empty ext2 image (size the fs to leave working headroom).
dd if=/dev/zero of=alpine-i386.ext2 bs=1M count=512
mkfs.ext2 -F alpine-i386.ext2

# 2. Mount it and bootstrap a minimal i386 userland into it.
mkdir -p mnt && sudo mount -o loop alpine-i386.ext2 mnt
#   Alpine: use apk with --arch x86 against an i386 mirror to install
#   alpine-base + the research toolchain into mnt/:
sudo apk --arch x86 -X http://dl-cdn.alpinelinux.org/alpine/latest-stable/main \
    -U --allow-untrusted --root "$PWD/mnt" --initdb add \
    alpine-base bash coreutils grep sed gawk findutils file less \
    python3 py3-pip jq
#   (Debian variant: debootstrap --arch=i386 --variant=minbase bookworm mnt <mirror>)
#   (archlinux32 variant: pacstrap an i686 root from the archlinux32 mirrors.)

# 3. Minimal config so /bin/bash --login works the way sandbox.js launches it
#    (root uid/gid 0, HOME=/root, a PATH that finds the tools). Set root shell,
#    create /root, ensure /etc/passwd + /etc/profile are sane.

# 4. Trim: docs, man pages, apk/pip caches, __pycache__ — every MB counts.
sudo umount mnt

# 5. (Optional) shrink the fs to the used size with resize2fs -M, then upload.
npx wrangler r2 object put \
    deepresearch-se-storage/sandbox-images/alpine-i386-2026-07.ext2 \
    --file alpine-i386.ext2
```

**Requirements / gotchas:**
- **ext2 specifically** (CheerpX mounts the root as `type:"ext2"`; not ext4).
  `mkfs.ext2` — do not let a distro tool default to ext4.
- **i386 userland** — every binary in the image must be 32-bit x86 (`file`
  should say `ELF 32-bit LSB … Intel 80386`). This is the whole ballgame
  (§1); an accidental x86_64 binary won't run.
- **Match the launch contract in `sandbox.js`:** it runs
  `/bin/bash --login` with `HOME=/root`, `USER=root`, uid/gid 0, and the exec
  bridge runs `/bin/sh -c …` with a fixed `PATH`. The image must have
  `/bin/bash`, `/bin/sh`, and `base64`, `printf`, `cat`, `ls`, `mkdir`, `cp`,
  `ln`, `rm` on that PATH (the seed script + marker protocol depend on them).
- **Toolchain coverage** (so research transcripts don't fail): `python3`,
  `grep`/`sed`/`awk`, `jq`, `file`, `wc`, `sort`, `uniq`, `head`/`tail`,
  `find`. Grow the list from real usage (invariant 5), but seed it with these.
- **Size target:** aim ≤ ~300 MB for the "small" default so a full prefetch
  (§6) is realistic; Alpine gets well under that.
- **Licensing:** the same CheerpX Community-vs-commercial licensing note in
  `docs/SANDBOX-HOST-COMMANDS.md` applies. Self-hosting our **own** distro
  image is squarely fine (Alpine/Debian/Arch are FOSS); it also removes the
  `disks.webvm.io` dependency, which is a licensing *simplification*. The
  CheerpX **runtime** is still loaded from `cxrtnc.leaningtech.com` under the
  Community License, unchanged by this.

---

## 6. Optional: full prefetch into IndexedDB (the "no more chunk streaming" mode)

With a small image, an opt-in one-time prefetch makes later boots fully local.
Two approaches:

- **Simplest:** after boot, kick off a background `fetch()` of the whole
  `/sandbox/img/<id>.ext2` so the browser/edge cache is warm; CheerpX's own
  block reads then hit cache. Coarse but zero new machinery.
- **Precise:** walk the image in `Range` chunks and write them into the
  overlay's `IDBDevice` cache up front. More control, more code; only worth it
  if the coarse approach leaves cold reads.

Gate it behind the `sandbox.prefetch` config flag (default off) and the small
image; **never** prefetch the multi-GB webvm.io default. This is the layer that
most directly answers "don't stream chunk by chunk every time": after one warm
load, the disk is entirely in IndexedDB.

---

## 7. Rollout — fail-soft, no regression, verify-before-default

The current sandbox is a **protected, live-verified foundation** (execution-
sandbox skill). This feature must not risk it:

1. **Ship inert.** `sandbox.image` defaults to `""` ⇒ the exact current
   CloudDevice boot. The R2 route, the config block, the `/api/sandbox-image`
   endpoint, and the admin panel can all land and deploy with **zero behavior
   change** — the `HttpBytesDevice` path is dormant until an operator uploads an
   image and selects it.
2. **`verified` flag gates the default.** An image row starts `verified:false`.
   Only after a **real device** boots it end-to-end (iOS Safari under
   `require-corp` especially — the standing warning from the COEP saga) does an
   operator flip `verified:true`, and only verified images should be settable as
   the fleet default. This keeps the protected-foundation discipline.
3. **Boot-path change is the risky part.** Swapping the base device in
   `bootVM` touches the exact code the execution-sandbox skill says to change
   only with live device verification. Keep the diff minimal (the
   `if (imageUrl)` branch above), keep the CloudDevice fallback, and **verify
   live on the real target device** before making any self-hosted image the
   default.
4. **Per-image cache key** (§2) so switching images never serves stale blocks.

---

## 8. Live-verification owed (per the live-verify skill)

- `HttpBytesDevice.create("/sandbox/img/<id>.ext2")` exists in the pinned
  CheerpX `1.2.6` and boots a self-hosted **i386** ext2 (Alpine first) to a
  working `/bin/bash --login` on **Chrome, Firefox, and real iOS Safari** under
  COEP `require-corp`.
- The R2 route serves correct `206 Partial Content` for CheerpX's `Range`
  requests (single and open-ended), with `Accept-Ranges: bytes` and the
  immutable cache headers; edge caching of ranges works.
- The exec marker protocol + seed script run unchanged on the new image
  (`base64`, `printf`, `/bin/sh -c` all present and i386) — i.e. `ls /` and a
  file-mount `cat` both work, matching the DRS known-good baseline.
- Switching the admin `image` selection re-boots onto the new image with a
  fresh per-image IDB cache (no stale blocks), and DRC `/cure` picks up the
  same public selection.
- (If enabled) `sandbox.prefetch` warms the cache and a second boot issues no
  network reads for disk blocks.

---

## 9. Files this touches (when implemented)

| File | Change |
|---|---|
| `public/js/sandbox.js` | `bootVM` takes an `imageUrl` (+ prefetch flag); `if (imageUrl) HttpBytesDevice.create(imageUrl) else CloudDevice.create(DISK_URL)`; per-image `cacheIdFor(imageUrl)` for the `IDBDevice` block cache. **Protected boot path — minimal diff, live-verify.** |
| `public/js/stream.js` (DRS) / `public/cure/drc.js` (DRC) | fetch the selected image + pass `imageUrl` into `ensureSandboxBooted`/`bootVM` |
| `src/sandbox-image.js` (NEW) | `handleSandboxImage` — R2 `Range` streamer for `/sandbox/img/:id.ext2`; `handleSandboxImageConfig` — public `GET /api/sandbox-image` (url/id/prefetch); Node-tested against a mocked R2 (range → 206, missing → 404/503, headers) |
| `src/index.js` | route `/sandbox/img/*` and `/api/sandbox-image` **pre-auth** (public); no identity gate |
| `src/config.js` | `sandbox` block in `DEFAULT_CONFIG` + `mergeConfig`/`sanitizeConfigPatch` branches (image-id must match a registered row; per-row + prefetch validation); unit-tested like the `websearch`/`proxy` clamps |
| `public/js/admin.js` + `public/admin/` | the "Linux sandbox image" config panel (dropdown, i386 warning, add-image form, prefetch toggle) |
| `scripts/build-sandbox-image.sh` (NEW) | reproducible Alpine-i386 (+ Debian-i386 / archlinux32 variants) ext2 build → R2 upload; documented, not run by deploy |
| `docs/SANDBOX-HOST-COMMANDS.md` / execution-sandbox skill | cross-link once shipped |

Images themselves live in **R2** (`sandbox-images/<id>.ext2`), never in git.

---

## 10. Open decisions (for the owner)

1. **Which default image?** Recommendation: **Alpine i386** for "small," with
   **Debian i386-slim** as the compatibility option. "Arch" specifically means
   **`archlinux32`** (i686) and is several hundred MB, not tiny. Offer it as a
   selectable option, not the small default. (Mainline x86_64 Arch cannot boot.)
2. **DRC parity now or later?** DRS-first is lower risk (authed, already the
   verified baseline). DRC can adopt the same public `/api/sandbox-image` in the
   same change or a follow-up.
3. **Prefetch on by default for the small image?** Off is safer initially;
   turn on once boot + block-cache behavior is confirmed on real devices.
4. **Retire the webvm.io fallback eventually?** Keep it as the `""` default
   until a self-hosted image is verified across browsers; then consider making a
   verified small image the built-in default and demoting webvm.io to a fallback.
