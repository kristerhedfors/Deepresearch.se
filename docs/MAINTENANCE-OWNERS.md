# Maintenance owners — who keeps each feature working

This registry maps each **maintained subsystem** to the **worker session that
owns it** (via its most recent fix PR). It exists because some features regress
repeatedly — the in-browser Linux **sandbox** above all — so a fix is not done at
merge; it needs a standing owner who is pinged when the feature breaks again and
re-resumes to fix it.

**How the loop works** (full rules in CLAUDE.md → *Regression feedback loop &
feature maintenance*, and the **feature-maintenance** skill):

1. Each fix PR is authored by a worker session that **stays subscribed to its own
   PR** (`subscribe_pr_activity`). A **comment on that PR wakes the author-worker.**
2. The watcher/merger loop sweeps for regressions each tick (`scripts/chatlogs`
   for the failure signatures below + live probes / user reports).
3. On a fresh regression, comment on the owning PR with a precise report
   (`mcp__github__add_issue_comment`) — symptom, `chat_logs` id / `client_diag`
   counters, verbatim repro, which prior fix regressed. The worker fixes it and
   opens a follow-up PR; the merger merges it; the new PR becomes the owner (update
   the row here in the same pass).
4. If the owner is unresponsive/closed, fall back to fixing it directly with a
   regression test (feedback-loop discipline) and note it here.

## Owners

| Subsystem | Owner PR | Author session (see PR trailer) | Files it guards | Regression signatures to watch |
|---|---|---|---|---|
| **Execution sandbox — boot + reliability** (standing maintenance owner; MUST stay subscribed) | **#43** (`claude/sandbox-pwa-failure-ijgemh`, session `01LQuhduTgD8g92dTMtSEPgS`) — the Playwright worker; supersedes the earlier `sandbox-terminal-visibility-ujgu88` owner | in each PR's `Claude-Session:` trailer | `public/js/sandbox.js`, `public/js/bash-core.js`, `src/bash-agent.js`, `src/bash-api.js`, `public/js/boot-messages.js`, `public/js/agent-backdrop*.js`, `tests/e2e/sandbox.spec.js` | `sandbox not ready`, `stream stalled`, `sandbox.boot_stalled`, `sandbox.exec_timeout`, `sandbox.exec_not_ready`, `sandbox.boot_torn_down`, high `client_diag.fs.ms` (11–27 s = iOS `/workspace` mount stall), never reaching `boot_done` |
| Sandbox agentic shell loop | #37 (`claude/last-chats-failure-logs-87jlxp`) | PR #37 trailer | `public/js/bash-core.js` (`runShellLoop`, `sandboxTornDown`) | `Ran N commands, all sandbox not ready`; loop not stopping on teardown |
| DRC umbrella intro / loading spinners | #36 (`claude/intro-animation-loading-states-djis82`) | PR #36 trailer | `public/cure/umbrella.js`, `public/js/umbrella-spinner.js` | intro/spinner not rendering, canvas errors |

> **Sandbox note:** the recurring failure is the CheerpX `/workspace` IndexedDB
> mount stalling on iOS WebKit / Firefox iOS (~11–27 s vs ~0.8 s on a Safari tab),
> which cascades into "sandbox not ready" / stream-stall. The loop-level fixes
> (#34 exec timeout, #37 teardown stop) make it fail *soft*.
>
> **2026-07-14 — routed regression (chat_logs #322, iOS PWA, css h34) → FIXED by
> #43 (merged `415fd75`), PENDING on-device confirmation.** Root cause: the
> debug-only boot `fs.verify` exec (`ls -la /workspace/*/`) wedged over a corrupt
> persisted `/workspace` IDB → 30 s exec timeout → `resetSandbox` fired inside
> boot, but `bootVM` still returned `true`, so the model's `ls /` hit a dead VM.
> #43 gates `fs.verify` behind debug, makes `bootVM` return honest readiness,
> self-heals the corrupt `dr-sandbox-workspace` IDB, and adds diagnostics
> (`sandbox.exec_not_ready`, `sandbox.boot_torn_down`, boot-generation counter,
> `sandbox.reset` reason). **Boot + list are green on-device (chat_logs #325); the
> read-path wedge is NOT.** Loop stays OPEN.
>
> **2026-07-14 08:17 — narrowed (chat_logs #328) → routed to #43
> (comment 4966842820):** mount + `ls -la /workspace` succeed on the iOS PWA, but
> a regular-file `read()` (`cat /workspace/INDEX.txt`) wedges → #34's 30 s exec
> timeout (exit 124) → ~120 s burned per turn. A CheerpX `IDBDevice` file-content
> read stall on iOS WebKit, distinct from the mount/list stall #43 fixed.
>
> **2026-07-14 09:02 — generalized (chat_logs #331) → nudged #43
> (comment 4967433472):** the user is now hand-steering around it —
> *"Explore but avoid /workspace and /mnt aa they freeze."* **`/mnt` wedges too**,
> not just `/workspace`. `/mnt` carries no `INDEX.txt` seed and isn't the
> persistent `dr-sandbox-workspace` IDBDevice, so this **rules out the seed-write
> hypothesis** and points at a generic persistent/mounted-device `read()` stall on
> iOS spanning BOTH mounts — likely a device-layer fix (serve small file bytes off
> the DataDevice/manifest on iOS) rather than per-volume self-heal. Keep #43's
> worker in the loop until `cat` of a file under `/workspace` **and** `/mnt`
> returns content on a real iOS PWA.
