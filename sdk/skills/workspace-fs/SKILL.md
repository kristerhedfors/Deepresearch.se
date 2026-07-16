---
name: workspace-fs
description: >-
  Load when building the fast-track workspace filesystem — the answer model
  does read/write/edit/grep/glob/list through MCP tools that hit a host-side
  authoritative store DIRECTLY (no VM round-trip), while only arbitrary shell
  routes through the CheerpX VM, kept coherent by a sync-in→exec→harvest
  protocol at each run_bash boundary. Server-tier first (Se/cure is deferred /
  likely unsuitable — no MCP-client model, no server host). Covers the
  authoritative store (Durable Object / R2), the fast-track file tools, the
  CheerpX coherence protocol (DataDevice.writeFile in, IDBDevice.readFileAsBlob
  out), and concurrency. Design: docs/WORKSPACE-FS-DESIGN.md. Companion to
  exec-engine, execution-sandbox, mcp-surface, deploy-pipeline.
---

# Workspace FS — host-side file ops, VM-routed shell

Split the sandbox agent's file work by where it belongs. The answer model does
the bulk — read, write, edit, grep, glob, list — through **MCP tool calls that
hit a host-side authoritative workspace directly**, at server speed with no
VM boot/exec/marker cost. Only **arbitrary shell** (`bash`, pipelines, builds,
package installs, "run this on the results") routes through the CheerpX VM,
which stays coherent with the store so a file the model just edited is exactly
what `bash` sees. This is the capability that makes an in-app coding agent
fast: most operations never touch the VM.

## Capability class & tier story

Class **S**, **server-tier first**. The authoritative store is a real
server-side filesystem (Durable Object / R2), the file tools are MCP tools the
model drives, and the VM (CheerpX, in the browser) is the execution view. On
**Se/cure this is deferred and likely unsuitable**: the model there is the
user's own browser-direct provider — not an MCP client to the page — and there
is no server host to hold the authoritative store or serialize it. A
browser-local echo (OPFS store + client file functions + the browser VM) is a
possible *separate* future module with weaker guarantees, not this one. Build
server-tier; do not force the two into one design.

## Contracts

- **PA-1** — the file/exec tools are the ANSWER-model dev-loop (the sanctioned
  invariant-1 exception, extended from source-introspection tools); the JSON
  planning phases never use them, so the no-function-calling guarantee holds
  for the pipeline everywhere else.
- **PA-2** — fail soft: a VM that won't boot degrades to host-only file ops
  (read/edit/grep still work; only `run_bash` is unavailable, surfaced
  clearly); a failed harvest leaves the store at its pre-exec state plus the
  command output — never a corrupt tree.
- **PA-4** — server-tier by design; the workspace is the user's own content
  under their session, interaction-logged like other tools, no third-party
  exposure.
- **PA-7** — the sync-in→exec→harvest wrapper is an engine-agnostic step over
  the existing loop, sitting on `bash-core` and the `ExecEngine` seam, not
  hard-wired to CheerpX call sites.
- **PA-9** — fail-safe metering: no store backing (no DO/R2) → the capability
  is unavailable, never an unmetered file/exec path; `run_bash` is quota-gated.
- **PA-10** — the coherence protocol only proves out on a real VM on a real
  device; live-verify the sync/harvest cycle before defaulting it on.

## Build plan

1. **The authoritative store** (`src/workspace.js`): one per session/workspace,
   holding path → {bytes, mode, mtime, contentHash} plus a **generation
   counter**. Prefer a **Durable Object** (serialized access — the natural
   home for "one FS, concurrent readers/writers, an in-flight exec"); fall back
   to **R2 + a small index** (objects under `workspace/<wsid>/<path>`, an index
   row per file so `glob`/`grep` don't list everything) for single-session use.
   The store lives OUTSIDE the VM — that is the whole point.
2. **The fast-track file tools** on the MCP surface (`src/mcp.js`), each
   operating directly on the store, no VM: `read_file`/`write_file`/
   `edit_file`(`apply_patch`)/`list_dir`/`stat`/`move`/`delete`, and
   `glob`/`grep` as **server-side scans** over the store. Quota-gated,
   usage-recorded, interaction-logged (inherited from the surface's
   post-identity-gate placement). Every write bumps the file hash + the
   generation counter.
3. **The coherence protocol around `run_bash`** — the only VM-routing tool.
   The key simplification: **nothing in the VM observes the FS except a running
   command**, so coherence only has to hold *at exec boundaries*. Implement:
   - **Sync-in:** for each file whose store hash != its last-materialized hash,
     `DataDevice.writeFile` it and `cp` into the `/workspace` overlay (the
     existing ingest path); `rm` store-deleted paths. Drop a marker:
     `touch /workspace/.dr-exec-marker`.
   - **Exec:** run the command via the existing marker-protocol bridge.
   - **Harvest-out:** `find /workspace -newer /workspace/.dr-exec-marker -type f`
     to enumerate changed guest paths; read each via
     `IDBDevice.readFileAsBlob`; write back into the store (bump hashes +
     generation); apply guest deletions.
   - **Return** stdout/stderr/rc **and the changed-path list** so the model's
     next host read is oriented.
   Only changed files cross in either direction (hash-gated in, `-newer` out).
4. **Correctness vs overlay shadowing:** CheerpX's overlay shadows the base for
   any guest-written path, so do NOT rely on lazily re-serving a host edit
   under such a path. Sync-in **writes current store bytes into the overlay
   itself** before each run, so the overlay *is* the store at exec time; there
   is no stale-shadow window because the model never reads inside the VM
   between runs.
5. **Concurrency:** serialize host writes against an in-flight exec — during a
   `run_bash`, workspace writes queue and apply after harvest; reads always
   serve from the store. The DO backing makes this a single-writer lock; the R2
   backing uses a workspace mutex flag. (A 3-way merge surfacing conflicts is
   the advanced option, not the baseline.)
6. **Wire the wrapper** as an engine-agnostic step (`bash-core.js` +
   `sandbox-files.js`/`sandbox.js`): sync-in and harvest bracket the existing
   exec, so the loop code doesn't grow CheerpX specifics.

## Reference implementation map

| Concept | Reference (existing primitives this builds on) |
|---|---|
| Host→guest write (sync-in) | `DataDevice.writeFile` + `cp` into overlay — `public/js/sandbox-files.js`, `public/js/sandbox.js`; facts in `docs/SANDBOX-HOST-COMMANDS.md` |
| Guest→host read-back (harvest) | `IDBDevice.readFileAsBlob` — the only guest→host read path (same doc) |
| The exec bridge + marker protocol | `public/js/bash-core.js` (envelope codec), `public/js/sandbox.js` |
| The outbox (harvest's ancestor — export changed guest files) | `public/js/bash-core.js` outbox helpers, `public/js/sandbox.js` `collectDeliverables` |
| The MCP surface the tools extend | `src/mcp.js` (post-identity-gate, quota/usage/log inherited) |
| The engine seam the wrapper rides | the `exec-engine` module (`ExecEngine`) |
| Quota/usage/log the tools inherit | `src/quota.js`, `src/chatlog.js` |
| Full protocol + concurrency + correctness argument | `docs/WORKSPACE-FS-DESIGN.md` |

## Acceptance checklist

- [ ] File tools operate on the store with **no VM boot** — a `read`/`edit`/
      `grep` completes even when the VM is not booted.
- [ ] A file edited host-side is exactly what `run_bash` sees (sync-in makes
      the overlay equal the store at exec time) — verified live.
- [ ] A file written by `bash` is harvested back and is what the next host
      `read_file` returns; a `bash` deletion propagates to the store.
- [ ] Only changed files cross: an unchanged workspace + one build does not
      re-ship unchanged files (watch the DataDevice/harvest counts).
- [ ] Concurrency: a host write during an in-flight `run_bash` neither clobbers
      nor is clobbered by harvest (serialized).
- [ ] Fail-soft: VM won't boot → file tools still work, `run_bash` reports
      unavailable; a harvest failure leaves the store pre-exec + output.
- [ ] Fail-safe: no DO/R2 backing → the whole capability is unavailable, no
      unmetered path.
- [ ] The coherence cycle is live-verified on a real device (iOS Safari).

## Pitfalls

- **Coherence is an exec-boundary property, not a live-sync one.** The whole
  design hinges on "nothing in the VM reads the FS except a running command."
  Don't over-engineer a continuous two-way sync — sync-in before each run and
  harvest after is sufficient and correct.
- **Overlay shadowing is the correctness trap.** Once the guest writes a path,
  the overlay wins over any base; lazily re-serving host edits under that path
  would go stale. Writing store bytes into the overlay at sync-in is what makes
  it correct — don't switch to a lazy WebDevice base and assume host edits show
  through.
- **`DataDevice` has no exec bit and is read-only from the guest.** Files that
  must be executable in the VM get their mode set after `cp` into the overlay;
  the store carries the mode so sync-in can restore it.
- **Harvest must enumerate, not guess.** Use the `-newer` marker (or an
  equivalent touched-path record); do not assume the outbox convention — this
  is a general workspace, not a single deliverables dir.
- **Serialize writes vs exec, or corrupt the store.** A host write racing
  harvest is the one data-loss path; the DO lock (or R2 mutex) is not optional.
- **Server-tier only, for now.** Resist wiring this into Se/cure to "unify" —
  there is no MCP-client model and no server host there; a browser-local
  variant is a different module. The owner flagged this; honor it.
- **Metering & logging are inherited, not re-invented.** The tools ride the MCP
  surface's identity gate, quota, and interaction log — don't add a side door.
