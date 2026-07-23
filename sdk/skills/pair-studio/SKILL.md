---
name: pair-studio
description: >-
  Load when building or working on the in-app platform builder — "prompt an app,
  design it in the virtual Linux, try it out in the same UI": the studio flow
  (prompt → SDK-guided generation in the sandbox VM → preview deploy in an
  in-app pane → save/export as a runnable test application), the two platform
  types (a client-tier/"Se/cure-type" build is instantly runnable in-browser; a
  server-tier build exports as a deployable bundle), the service-worker preview
  origin, sealed-link/download export, and the hard rule that the platform's own
  server never hosts generated server code.
---

# Pair studio — prompt, design in the VM, try it out in the same UI

The capstone use case that ties the SDK together: a user **prompts** an
application ("build me a support chatbot over my product docs"), the assistant
**designs and generates it inside the in-browser Linux VM** working from the
mounted SDK (manifest, skills, CLI), and the result **deploys into a preview
pane in the same interface** — then saves as a **runnable test application**
the user can download, keep as a project, or (small apps) carry as a sealed
link. The studio is where the platform stops being only a research assistant and
becomes a factory for more platforms.

## Capability class & tier story

Class **X**, with a deliberately **client-heavy center of gravity**: the
generation loop runs in the sandbox VM (the user's browser), the preview runs
in the user's browser, and the artifact lands in browser-local storage — so
the whole prompt→try-out loop works on the client tier with zero server
involvement, which is exactly the posture that makes generated apps instantly
trustable. On the server tier the same studio runs with the server-side step
decision endpoint (quota-gated) deciding shell commands, like any bash-agent
conversation.

**The platform types — the studio's core concept.** Every generated app
declares its platform type up front, and the type IS its logical boundary:

| Platform type | What it is | Try-out story |
|---|---|---|
| **Client-tier build** (the reference's "Se/cure-type" — the default) | Class-C only: static no-build ES modules, sealed local state, browser-direct upstream APIs (user's keys / local server / embedded grant tokens) | **Instantly runnable in the same UI** — preview-deployed into an in-app pane; savable as a standalone artifact that runs from any static host (or `file://` for single-file builds) |
| **Server-tier / platform build** | Adds the one worker (identity, metering, storage…) per the manifest's S modules | The worker **cannot run inside the studio** — it exports as a deployable bundle (worker project + assets) for the user's own edge account; its client half still previews in-app against a generated mock of its API surface |

**The hard rule (never bend it):** the platform's own server never executes or
hosts generated server code. Hosting arbitrary user workers would put the
studio inside the platform's trust boundary and break the zero-or-one-server
property in the worst possible way. "Try out a server build" = preview the
client half against mocks + deploy the worker to the user's own account.

## Contracts

- **PA-1** — generation is the fenced-block shell loop (the model answers
  "what command next", the client executes); no function calling enters the
  pipeline. The studio adds prompts and a file-preview bridge, not a new
  orchestration style.
- **PA-2** — every studio stage fails soft: VM won't boot → the design
  conversation still happens (plans + files as chat content); preview fails →
  the export path still works.
- **PA-4** — the prompt, the generated code, and the preview never leave the
  browser on the client tier; nothing is uploaded unless the user explicitly
  exports to a server-backed destination.
- **PA-5** — generated apps inherit the no-build rule: what the VM writes is
  what the preview serves is what the export contains.
- **PA-7** — the studio's pure logic (platform-type validation, preview
  manifests, export packing) lives in a Node-testable core shared by both
  tiers.
- **PA-8/PA-9** — a generated client-tier app that needs server-lent
  capabilities embeds **grant tokens** through the existing bridge, under its
  existing meters — the studio mints nothing of its own.

## Build plan

1. **Studio intent + scaffold conversation.** A deterministic intent gate
   (bilingual, PA-6) or an explicit UI entry ("Build an app") flips the
   conversation into studio mode: the system prompt gains the SDK context —
   the manifest, the `pair-cli plan` output for the chosen selection, and the
   relevant module skills retrieved from the snapshot (the introspection
   retrieval already does this). The model's job per turn: pick the next
   module/file, emit shell commands (fenced blocks) that write it under
   `/workspace/app`.
2. **Platform-type selection.** First studio turn establishes the type.
   Default **client-tier build**; the studio refuses S-class modules in a
   client-tier selection (`pair-cli validate` semantics — run it in the VM as
   the gate). A generated app gets its own mini-manifest
   (`app/manifest.json`: name, type, modules used, entry point) — the
   machine-readable thing the preview and export steps read.
3. **Generation in the VM.** The existing bash-agent loop does the work:
   write files, run `node --test` for the app's own pure cores (the image
   ships nodejs — `vm-toolchain`), iterate. The SDK skills at `/src/sdk` are
   the model's reference material; the app's files are the deliverable.
4. **Export bridge.** The existing outbox flow already moves files out of the
   VM (guest → `/workspace/outbox` → base64-through-exec → host). The studio
   generalizes it: "collect the app" = export every file under
   `/workspace/app` into an in-browser file map `{path → bytes}` — the
   preview's and the save path's single input.
5. **Preview deploy — the same-UI try-out.** Serve the file map at a real
   URL scope so ES modules, relative fetches and routing work:
   - Register a **preview service worker** scoped to `/preview/` (a reserved
     scope, never used by the platform's own routes). It serves
     `/preview/<appId>/<path>` from the file map (stored in the Cache API /
     IndexedDB), with correct MIME types.
   - Open `/preview/<appId>/index.html` in a **sandboxed iframe pane**
     (`sandbox="allow-scripts allow-same-origin"` weighed per app; start
     stricter) beside the conversation — the same panel pattern as the
     existing embeds.
   - **Isolation interplay (the trap):** the parent document is served with
     cross-origin-isolation headers for the VM's sake; a same-origin iframe
     inherits the embedding rules, and the service worker must attach
     `Cross-Origin-Embedder-Policy`-compatible response headers
     (`Cross-Origin-Resource-Policy: same-origin`) to every preview response
     or the pane goes blank exactly the way the sandbox's CDN loads once did.
     Pin this with a live check before calling preview done.
   - Iterate: further prompts edit files in the VM → re-export → the SW cache
     updates → reload the pane. The loop feels like hot reload; it is just
     the same three steps again.
6. **Save as a runnable test application.** Three graded destinations, all
   from the same file map:
   - **Download** (always): a bundle of the app directory (plus, for
     single-file builds, the one self-contained HTML). Runs from any static
     host — the client-tier deployability guarantee made tangible.
   - **Keep as a project** (both tiers): attach the file map to a project via
     the existing add-to-project flow; reopening re-hydrates the preview.
   - **Sealed link** (small client-tier builds): pack the file map into the
     offline-workspace fragment format — the whole app in a link, no server;
     URL-size-gated with the download path as the overflow answer.
7. **Server-tier builds.** Same loop, different exit: generation produces a
   worker project (entry, config, the selected S modules' scaffolds); the
   studio ALSO generates `mocks.js` — a client-side stand-in for the app's
   API surface derived from its routes — so the client half previews in-app.
   Export is a deployable bundle + a README naming the one command that
   deploys it to the user's own account. The studio UI labels the boundary
   plainly: *this preview mocks the server half; deploy to run it for real.*
8. **Guardrails.** Preview panes get no access to the platform's own storage or
   session (scope + sandbox attributes); generated apps that want web search
   or LLM calls get them the legitimate ways (user key, local server, or
   grant tokens through the bridge); the studio never proxies.

## Reference implementation map

| Concept | Reference |
|---|---|
| The shell loop the studio drives | `public/js/bash-core.js`, `src/bash-agent.js`, `src/bash-api.js` |
| Guest→host file export (the outbox) | `public/js/bash-core.js` (outbox helpers), `public/js/sandbox.js` (`collectDeliverables`, `exportFile`) |
| File mounts into the VM (`/workspace`, `/src`) | `public/js/sandbox-files.js` |
| The SDK the model works from in-VM | `/src/sdk` via the source snapshot (see `vm-toolchain`) |
| Selection/order gate for a build | `sdk/pair-cli.mjs` (`plan`, `validate`) |
| Embed/panel pattern for the preview pane | `public/js/embeds.js`, `public/js/imagedeck.js` (panel conventions) |
| Add-to-project save path | `public/js/projects.js` (`addFilesToProject`), `public/js/turns.js` (`renderDeliverables`) |
| Sealed-link packing | `public/js/workspace-core.js` (the fragment format the app-link variant extends) |
| The client-tier app shape being generated | the `secure-tier`, `sealed-crypto`, `provider-registry` module skills |
| Isolation-header incident history | `.claude/skills/execution-sandbox/SKILL.md` (COEP saga) |

## Acceptance checklist

- [ ] Prompt → a client-tier app generated in the VM → **previewed in an
      in-app pane** in the same session, on both tiers (client tier with the
      user's own key end to end).
- [ ] The preview survives the isolation headers on Chrome, Firefox, and real
      iOS Safari (the SW sets CORP on every response) — live-verified.
- [ ] Export: the downloaded bundle runs unmodified from a plain static file
      server; the project save re-hydrates the preview after reload.
- [ ] A small app round-trips through a sealed link (seal → open on another
      profile → runs); oversize apps degrade to download with a clear notice.
- [ ] `pair-cli validate` semantics enforced: an S-class module in a
      client-tier selection is refused with the platform-type explanation.
- [ ] A server-tier build exports a deployable bundle; its client half
      previews against the generated mocks; the platform's server never executes
      any generated server code (nothing to test — there must be no such code
      path at all; review the module graph).
- [ ] Studio stages each fail soft (VM down, SW registration refused, quota
      exhausted mid-generation) with the conversation surviving.

## Pitfalls

- **The preview + COEP trap is the sandbox's CDN incident wearing a new
  hat**: under `require-corp` every response the preview iframe loads needs a
  compatible CORP header, and service-worker responses don't get them for
  free. Budget a live device pass for this before promising the feature.
- **Service-worker scope discipline**: one reserved `/preview/` scope,
  registered lazily, never overlapping the app shell's paths — a greedy scope
  can intercept the platform's own module loads and produce unexplainable
  staleness (the repo's cache-layer history says this class of bug is
  expensive).
- **URL-length limits bound sealed-link apps** hard (order tens of KB
  compressed); treat the link as the demo-sized delight path, the download as
  the real one — and say so in the UI rather than failing silently.
- **Don't let "try it out" grow into hosting.** The moment a preview URL is
  shareable server-side, the platform is a code-hosting service with someone
  else's code behind its origin. Sharing = export (download/link), full stop.
- **Generated apps drift from the SDK unless pinned**: stamp the app's
  mini-manifest with the SDK module list + snapshot digest it was built
  against, so a later session can regenerate/upgrade deliberately instead of
  guessing.
- **Browser storage is evictable**: the file map + preview cache follow the
  same guard the sealed state uses — offer the backup/download early, not
  only at the end.
- **Keep studio prompts out of the research pipeline's path**: studio mode is
  a conversation mode like introspection's sticky mode; mixing the two
  degrades both (the intent gate + mode flag pattern already exists — reuse
  it).
