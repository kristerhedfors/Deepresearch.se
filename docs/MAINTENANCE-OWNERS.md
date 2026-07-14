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
| **Execution sandbox — boot + reliability** (standing maintenance owner; MUST stay subscribed) | #39 (`claude/sandbox-terminal-visibility-ujgu88`) — plus the **incoming boot-investigation PRs** (Playwright); whichever lands latest takes ownership | in each PR's `Claude-Session:` trailer | `public/js/sandbox.js`, `public/js/bash-core.js`, `src/bash-agent.js`, `src/bash-api.js`, `public/js/boot-messages.js`, `public/js/agent-backdrop*.js` | `sandbox not ready`, `stream stalled`, `sandbox.boot_stalled`, `sandbox.exec_timeout`, high `client_diag.fs.ms` (11–27 s = the iOS `/workspace` mount stall), never reaching `boot_done` |
| Sandbox agentic shell loop | #37 (`claude/last-chats-failure-logs-87jlxp`) | PR #37 trailer | `public/js/bash-core.js` (`runShellLoop`, `sandboxTornDown`) | `Ran N commands, all sandbox not ready`; loop not stopping on teardown |
| DRC umbrella intro / loading spinners | #36 (`claude/intro-animation-loading-states-djis82`) | PR #36 trailer | `public/cure/umbrella.js`, `public/js/umbrella-spinner.js` | intro/spinner not rendering, canvas errors |

> **Sandbox note:** the recurring failure is the CheerpX `/workspace` IndexedDB
> mount stalling on iOS WebKit / Firefox iOS (~11–27 s vs ~0.8 s on a Safari tab),
> which cascades into "sandbox not ready" / stream-stall. The loop-level fixes
> (#34 exec timeout, #37 teardown stop) make it fail *soft*; the ROOT fix (the
> mount model) is the live-on-device work the incoming Playwright worker(s) own.
> Keep that worker in the loop until the boot is reliably green on a real iOS PWA.
