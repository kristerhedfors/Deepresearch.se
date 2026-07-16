# Fast-track workspace filesystem — host-side file ops, VM-routed shell

*Design. 2026-07-16. The capability: the answer model does the bulk of its
file work — read, write, edit, grep, glob, list — through **MCP tool calls
that hit a host-side authoritative workspace directly**, never paying the VM's
boot/exec/marker-protocol cost; those edits are **coherent inside the VM** so
that **only arbitrary shell** (`bash`, pipelines, builds, package installs)
routes through the CheerpX VM. Plus a **deploy pipeline** so the built
workspace can be pushed live and tried. **Server-tier first** — the
MCP-agent + host-workspace + live-deploy combination is structurally a
server-tier capability; Se/cure is deferred and may be unsuitable (§2).*

Companion to `docs/SANDBOX-HOST-COMMANDS.md` (the CheerpX device facts this
builds on) and the SDK's `workspace-fs` + `deploy-pipeline` module skills.

## 1. The split — what goes through the VM and what does not

Today every file touch by the sandbox agent is a shell command inside the VM
(the fenced-block loop): `cat`, `grep`, an editor round-trip — each pays a
marker-protocol exec cycle. That is slow and wasteful for what are really just
file operations. The insight: **most agent file activity is structured file
ops that do not need a shell at all**, and only a minority is genuine shell.

| Operation | Route | Why |
|---|---|---|
| `read_file`, `write_file`, `edit_file` / `apply_patch`, `list_dir`, `glob`, `grep`, `move`, `delete`, `stat` | **Host, direct (fast track)** — MCP tool → authoritative store, no VM | These are pure filesystem operations; a server-side store does them transactionally in microseconds with no boot/exec cost |
| `run_bash(cmd)` — arbitrary shell, pipelines, `make`/`npm`/`pytest`, package installs, "run this on the results" | **VM** (the existing CheerpX exec bridge) | Only a real POSIX userland can run arbitrary Unix commands |

So the agent greps and edits at host speed and drops into the VM only when it
truly needs to *execute*. The workspace stays coherent across the boundary
(§5) so a file the model just edited host-side is exactly what `bash` sees.

## 2. Why server-tier first; why Se/cure is deferred

The capability presumes three things Se/rver has and Se/cure structurally does
not:

1. **An MCP tool surface the model drives.** Se/rver already exposes the pair
   *as* an MCP server (`src/mcp.js`); adding file/exec/deploy tools extends
   that surface, and a tool-capable answer model (or an external MCP client)
   drives them. Se/cure's model is the user's own provider called
   browser-direct — it is **not an MCP client to the page**, so "the LLM makes
   MCP file calls" has no natural actor there.
2. **A host that is a real server.** The authoritative store is a server-side
   filesystem (Durable Object / R2). On Se/cure the only "host" is the
   browser; the analogue is an OPFS-backed local store driven by the client's
   own file functions (not MCP) — a *different*, weaker capability.
3. **A place to deploy live.** The deploy pipeline (§7) pushes to a real
   target. Se/cure has no server in its data path to deploy from.

So: **build it server-tier.** A browser-local echo of the fast-track idea on
Se/cure is possible later (OPFS store + client file ops + the browser VM), but
it is a separate module with weaker guarantees and no live deploy — do not
force the two into one design. The owner's instinct ("might be entirely
unsuitable for Se/cure") is correct.

## 3. The authoritative workspace store

**Source of truth = a host-side store, one per session/workspace.** It holds
the file tree (path → bytes + mode + mtime + content hash). Two backings:

- **Durable Object (preferred).** A per-workspace DO gives serialized,
  coordinated access — exactly the "one authoritative FS with concurrent
  readers/writers and an in-flight exec" problem (this is the first genuine
  trigger for a DO in the roadmap's §6 sense). The tree lives in DO storage;
  the DO serializes file-tool writes against exec boundaries (§5.4).
- **R2 + a small index (fallback).** Objects under
  `workspace/<wsid>/<path>`; a D1/R2 index row per file for `glob`/`grep`
  without listing all objects. No serialization guarantees — acceptable for
  single-session use, weaker under concurrency.

The store is **not** the VM's overlay; it lives outside the VM (that is the
whole point — file ops must not pass through the VM). The VM gets a *view* of
it (§5).

## 4. The fast-track MCP file tools

New tools on the MCP surface (or a sibling `workspace` MCP server), each
operating **directly on the store**, no VM:

- `read_file(path[, range])`, `write_file(path, bytes)`,
  `edit_file(path, old, new)` / `apply_patch(diff)`, `list_dir(path)`,
  `stat(path)`, `move(from, to)`, `delete(path)`.
- `glob(pattern)` and `grep(pattern[, pathspec])` run as **server-side scans
  over the store** — fast, and the common case the user called out ("read,
  edit, grep … happen outside the VM"). Only when the model needs a real
  pipeline (`grep … | sed … | sort`) does it fall to `run_bash`.

All are quota-gated, usage-recorded, and interaction-logged like every other
Se/rver tool (they inherit the MCP surface's post-identity-gate placement).
Each write bumps the file's content hash + a workspace **generation counter**
(§5).

## 5. Coherence with the CheerpX VM — the protocol

The hard part, because CheerpX exposes **no hypercall, no hostfs, no NIC**;
host↔guest moves only through two proven primitives
(`docs/SANDBOX-HOST-COMMANDS.md`):

- **Host → guest:** `DataDevice.writeFile(path, bytes)` — the only host→guest
  write path (in-memory, no exec bit), bytes then `cp`'d into the `/workspace`
  overlay (the existing ingest path).
- **Guest → host:** `IDBDevice.readFileAsBlob(path)` — the only way the host
  reads guest-written data (the overlay is an IDBDevice).

### 5.1 The key simplification: coherence only has to hold at exec boundaries

Nothing inside the VM observes the filesystem **except a running command**.
Between `run_bash` calls the VM is idle and looks at nothing. Therefore the VM
never needs a host edit reflected *until the next command runs*. So the
protocol only has to guarantee: **at the moment `run_bash` executes, the VM's
`/workspace` equals the current store.** That turns a hard live-sync problem
into a simple boundary-sync one.

### 5.2 `run_bash` = sync-in → exec → harvest-out

```
run_bash(cmd):
  1. SYNC-IN: for each file whose store hash != its last-materialized hash,
     DataDevice.writeFile it and cp into /workspace (delete removed paths).
     Drop a timestamp marker:  touch /workspace/.dr-exec-marker
  2. EXEC: run cmd in the VM via the existing marker-protocol bridge.
  3. HARVEST-OUT: enumerate changed guest paths with
        find /workspace -newer /workspace/.dr-exec-marker -type f
     read each via IDBDevice.readFileAsBlob, write back into the store
     (bumping hashes + the generation counter); apply guest deletions.
  4. RETURN: stdout, stderr, rc, AND the list of changed paths, so the
     model's next host-side read sees exactly the post-run state.
```

Only **changed** files cross in either direction (hash-gated sync-in, `-newer`
harvest), so a workspace that the model edited host-side and then runs one
build against does not re-ship unchanged files.

### 5.3 Why this is correct despite overlay shadowing

CheerpX's overlay shadows the base for any path the guest has written — so you
cannot rely on lazily re-serving a host edit under a guest-written path.
Sync-in sidesteps this: it **writes the current store bytes into the overlay
itself** (via DataDevice + `cp`) before each run, so the overlay *is* the
store at exec time. There is no stale-shadow window because the model does not
read inside the VM between runs. Removed-in-store paths are `rm`'d during
sync-in so deletions propagate.

### 5.4 Concurrency: serialize host writes against an in-flight exec

While a `run_bash` is materialized-and-running, a host `write_file` to the
same path could be clobbered by harvest (or clobber it). Rule (correct,
simple): **host file-writes are serialized against exec** — during an
in-flight `run_bash`, writes to the workspace queue and apply after harvest;
reads are always fine (served from the store). The DO backing makes this a
natural single-writer lock; the R2 backing does it with a workspace-level
mutex flag. The advanced option (a 3-way merge of pre-exec snapshot / guest
result / concurrent host edits, surfacing conflicts) is noted but not the
baseline.

### 5.5 Cost

Sync-in/harvest touch only changed files, and a workspace is small, so the
per-`run_bash` overhead is a few `DataDevice.writeFile` + `readFileAsBlob`
calls — dwarfed by the command's own runtime. The *frequent* operations
(read/edit/grep) never pay it at all. Net: the common path gets dramatically
faster, and the shell path is unchanged plus a small bounded sync.

## 6. What the model sees (the tool contract)

The model is handed one coherent set of tools and does not manage sync itself:

- File tools (§4) — instant, host-side.
- `run_bash(cmd)` — the only tool that mentions the VM; it hides sync-in and
  harvest entirely and returns changed paths so the model stays oriented.
- Everything is deterministic and no-function-calling-compatible in the
  pipeline sense: these are **tools the ANSWER model uses in the dev-mode
  agentic loop** (the one authorized invariant-1 exception, extended from
  source-introspection tools to workspace tools), never in the JSON planning
  phases.

## 7. Deploy pipeline — deploy and try it live

A `deploy` tool + a build step turns the workspace into a running thing the
user can open (the `deploy-pipeline` module):

1. **Build** (optional): `run_bash` the project's build (`npm run build`, etc.)
   in the VM; harvest the output into the store.
2. **Deploy target by platform type** (the `pair-studio` platform-type rule
   still governs — the pair's own server never hosts generated *server* code):
   - **Client-tier build** (static): publish the workspace's built assets to a
     **live preview route** (the reserved-scope service worker from
     `pair-studio`, promoted from in-tab preview to a shareable same-origin
     URL) — instantly openable.
   - **Server-tier build**: push a **deployable bundle to the user's own edge
     account** (a wrangler-style publish the user authorizes with their own
     token, minted/held like any grant), returning the live URL. The pair
     never runs the user's server code on its own origin.
3. **Return a live URL** to "try it out," plus the deploy log.

Deploy is quota-gated, authenticated (the deployer is a signed-in Se/rver
user), and the user's deploy credential rides the grant/token discipline —
never logged, minimal scope.

## 8. Invariant alignment

- **PA-1** (no function calling in the pipeline): the file/exec/deploy tools
  are the **answer-model dev-loop** exception, already sanctioned for source
  tools; JSON planning phases never use them.
- **PA-2** (fail soft): a VM that won't boot degrades to host-only file ops
  (the model can still read/edit/grep; only `run_bash`/deploy are
  unavailable, surfaced clearly). Harvest failure never corrupts the store
  (writes are transactional; a failed harvest leaves the store at its
  pre-exec state + the command output).
- **PA-4** (privacy): server-tier by design; the workspace is the user's own
  content under their session; deploy credentials are minimal and unlogged.
- **PA-9** (fail-safe metering): deploy and exec are quota-gated; no store
  backing (no DO/R2) → the capability is unavailable, never unmetered.
- **PA-10** (verify live): the coherence protocol only proves out on a real VM
  on a real device — the sync-in/harvest cycle and the `-newer` enumeration
  are live-verified before the capability is defaulted on.

## 9. Files this would touch (when implemented)

| File | Change |
|---|---|
| `src/workspace.js` (NEW) | The authoritative store (DO or R2-backed): file CRUD, `glob`/`grep` scans, generation counter, the exec serialization lock |
| `src/mcp.js` | Register the fast-track file tools + `run_bash` + `deploy` on the MCP surface (post-identity-gate; quota/usage/log inherited) |
| `public/js/sandbox-files.js` / `public/js/sandbox.js` | Sync-in (DataDevice.writeFile + cp, delete removed) and harvest (`find -newer` + `IDBDevice.readFileAsBlob`) around `run_bash`; the marker file |
| `public/js/bash-core.js` | The sync-in→exec→harvest wrapper as an engine-agnostic step over the existing loop |
| `src/deploy.js` (NEW) | The deploy pipeline: build hook, client-tier preview publish, server-tier user-account publish, live-URL return |
| `wrangler.toml` | The Durable Object binding for the workspace store (if DO-backed) |

Images/artifacts stay build artifacts; nothing here changes the CheerpX
engine decision (`docs/JS-VM-RESEARCH.md`).
