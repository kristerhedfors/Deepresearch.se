---
name: deploy-pipeline
description: >-
  Load when building the deploy-and-try-live pipeline — a deploy tool + build
  step that turns a workspace into a running thing the user can open: a live
  same-origin preview URL for a client-tier (static) build, or a push to the
  USER'S OWN edge account for a server-tier build (the platform never hosts
  generated server code on its own origin). Server-tier first. Covers the build
  hook over the VM, the platform-type-driven deploy targets, the user-held
  deploy credential under the grant discipline, and the live-URL return.
  Companion to workspace-fs (the source tree), pair-studio (in-app preview),
  exec-engine (the build shell). Design: docs/WORKSPACE-FS-DESIGN.md §7.
---

# Deploy pipeline — deploy the workspace and try it live

Close the loop: after the model builds an app in the workspace (host-side file
ops + VM shell, the `workspace-fs` module), a **`deploy` tool** turns it into a
running thing the user can open and try — a live URL, not just an in-tab
preview. Server-tier first, because a live deploy needs a real host and a real
deploy target.

## Capability class & tier story

Class **S**, **server-tier**. The deployer is a signed-in user; the pipeline
builds from the authoritative workspace store and publishes to a live target.
On **Se/cure** the analogue is export/download or the `pair-studio` in-tab
preview — there is no server in its data path to deploy *from*, so a true live
deploy is a server-tier capability. The hard rule from `pair-studio` holds:
**the platform's own server never runs generated server code on its own origin** —
server-tier builds deploy to the *user's* account.

## Contracts

- **PA-2** — fail soft: a failed build or deploy returns the log and leaves the
  workspace and any prior deployment untouched; the chat never breaks.
- **PA-4** — the deploy credential (the user's edge-account token) is minimal,
  user-held, ridden through the grant/token discipline, and never logged; the
  workspace content is the user's own.
- **PA-8/PA-9** — the deploy credential is a grant-class secret (minted/held
  like a server token, minimal scope); deploy is quota-gated; no store/target
  configured → deploy is unavailable, never a silent unmetered publish.
- **PA-10** — a deploy is verified by opening the returned live URL; the
  pipeline is proven end-to-end on a real target before it is offered by
  default.

## Build plan

1. **Build hook** (`src/deploy.js` + `run_bash`): optionally run the project's
   build in the VM (`npm run build`, etc.) via the `workspace-fs` exec path;
   harvest the output back into the store. Skipped for a no-build static app.
2. **Deploy target by platform type** (the `pair-studio` platform-type rule
   governs):
   - **Client-tier build (static):** publish the built assets to a **live
     same-origin preview route** — the reserved-scope service worker from
     `pair-studio`, promoted from an in-tab pane to a shareable
     `…/preview/<id>/` URL. Instantly openable; nothing leaves the origin; no
     credentials needed.
   - **Server-tier build:** push a **deployable bundle to the USER'S OWN edge
     account** — a wrangler-style publish the user authorizes with their own
     token. The platform proxies/forwards the publish; it never runs the user's
     server code on its origin. Returns the user's live URL.
3. **The deploy credential** is a grant-class secret: minted/stored like a
   server token, scoped to the one publish, never logged, revocable. For the
   static preview path there is no credential (same-origin).
4. **Return** the **live URL** ("try it out") + the deploy log + the platform
   type, so the user gets a link and the model gets the outcome.
5. **Idempotence & rollback:** deploys are content-addressed by a build id;
   re-deploying publishes a new id and flips the pointer; the previous id stays
   openable for rollback (same discipline as the sandbox image ids).

## Reference implementation map

| Concept | Reference |
|---|---|
| The workspace the build reads from | the `workspace-fs` module (`src/workspace.js`) |
| The build shell (run the build in the VM) | `workspace-fs` `run_bash`, `public/js/bash-core.js`, the `exec-engine` seam |
| The in-tab preview this promotes to a live URL | the `pair-studio` module (reserved-scope service worker) |
| The platform-type rule (never host generated server code) | the `pair-studio` + `secure-tier` modules; `sdk/DESIGN.md` §3.1 |
| The deploy credential discipline | the `grant-bridge` module (`src/server-token.js`, `src/server-grants.js`) |
| Quota/usage/log | `src/quota.js`, `src/chatlog.js`, `src/mcp.js` (the `deploy` tool) |
| Full design | `docs/WORKSPACE-FS-DESIGN.md` §7 |

## Acceptance checklist

- [ ] A client-tier build deploys to a **live same-origin URL** the user can
      open in the same session; opening it renders the built app.
- [ ] A server-tier build publishes to the **user's own edge account** with the
      user's token and returns their live URL; the platform's own origin serves
      **no** generated server code (verify the module graph / routes).
- [ ] The deploy credential is never logged (scan) and is scoped to the one
      publish; revoking it kills the deploy path.
- [ ] A failed build/deploy returns the log and leaves the prior deployment and
      the workspace intact (fail soft).
- [ ] Re-deploy publishes a new build id and the previous id still opens
      (rollback).
- [ ] No store/target configured → deploy is unavailable (fail-safe), never a
      silent publish.
- [ ] The returned live URL is verified by actually opening it (PA-10).

## Pitfalls

- **Never host generated server code on the platform's own origin.** This is the
  load-bearing rule inherited from `pair-studio`: a server-tier build deploys
  to the *user's* account. Hosting it yourself makes the platform a code-execution
  service behind its own trust boundary — the exact thing the zero-or-one-
  server property forbids.
- **The deploy token is a live credential — treat it as one.** Grant-class
  handling, minimal scope, never logged, revocable. It is the highest-value
  secret this capability touches.
- **A live preview URL is a share surface.** Promoting the in-tab preview to a
  shareable URL means content leaves the tab; keep it same-origin, scoped by an
  unguessable id, and expiring — don't turn it into open hosting.
- **Build failures are normal, not exceptional.** Return the log and let the
  model iterate (edit host-side, rebuild) — do not treat a nonzero build rc as
  an error that breaks the turn.
- **Server-tier first; Se/cure gets export/preview, not live deploy.** Don't
  stretch this to Se/cure — it has no server to deploy from; its answer is the
  download/sealed-link/in-tab preview from `pair-studio`/`secure-tier`.
