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
| **Sandbox FILE MOUNTING** (attached/project files read from inside the VM) | **#52** (`claude/file-integrations-workspace-read-ndhwt5`, session `01GE154SMjg759eTivTkpV8d`, merged `9e341c0`) — root-caused + fixed the `/workspace`/`/mnt` read wedge | `public/js/sandbox.js` (device mounts), `public/js/sandbox-files.js`, `docs/SANDBOX-HOST-COMMANDS.md` | file read wedges to `sandbox not ready` / `cat` exit 124; corrupt `dr-sandbox-workspace` IDB. **ROOT-FIXED by #52**: bare `IDBDevice {type:"dir"}` hangs on first read in CheerpX 1.2.6 → now `/workspace` + project dirs are plain dirs in the root `OverlayDevice`. Retires the whole corrupt-volume class. **On-device: FULLY CONFIRMED 2026-07-15** — `/workspace` write+read (chat_logs #345, iOS 18.7, fs.ms 968), attached-file read (chat_logs #352, `file` on an attached PDF exit 0), and overlay persistence across reload (try-it #7 PASSED). No items owed; watch the signatures. |
| **Sandbox /src SOURCE MOUNT** (introspection source tree seeded into the VM) | **#131** (`claude/sandbox-source-mount-timeout-gre7zf`, merged `d5b32f8`, deployed; supersedes **#119** `claude/introspection-sandbox-source-mount-9704xa`, whose tar+seed-timeout fix regressed same-day) — owes on-device confirmation: first dev-mode boot fails soft ("still preparing mounted files") instead of wedging, SECOND boot answers `ls -l /src` fast via the stamp skip | in the PR's `Claude-Session:` trailer | `public/js/sandbox-files.js` (`planSourceMount`, `sourceStamp`), `public/js/sandbox.js` (seed tracking + exec seed-wait), `public/js/bash-core.js` (`execTimeoutForBudget`) | `ls`/`cat` on `/src` → exit 124; `sandbox.exec_seed_busy` repeating across sends; `sandbox.seed_wedged`; `sandbox.fs.seed_timeout` with no later `seed_late_done`; `client_diag.fs.ms` ≫ 45 s on a SECOND dev-mode boot (stamp skip not firing) |
| **Sandbox SELF-HOSTED IMAGE** (admin-selectable R2 ext2 boot disk; INERT by default) | **#62** (`claude/local-linux-image-serving-3dsu2g`, session `01BuSBKyRzjn1fyqXWohdstS`, merged `01d9c14`) | `src/sandbox-image.js`, `src/config.js` (`sandbox` block), `public/js/sandbox.js` (`HttpBytesDevice` branch), `public/js/admin.js` (image panel), `scripts/build-sandbox-image.sh`, `docs/SANDBOX-LOCAL-IMAGE.md` | boot regresses with NO image selected (must stay byte-identical to `CloudDevice`); a selected image fails to boot (206/Range/`require-corp` CORP); non-`i386` image picked (CheerpX is i386-only — won't boot). **Inert until an operator uploads an image to R2 AND selects it. Owes:** build+upload a real i386 image and boot it end-to-end on a real device (iOS Safari under `require-corp`) before flipping its `verified` flag / selecting it as default. |
| Sandbox agentic shell loop | #37 (`claude/last-chats-failure-logs-87jlxp`) | PR #37 trailer | `public/js/bash-core.js` (`runShellLoop`, `sandboxTornDown`) | `Ran N commands, all sandbox not ready`; loop not stopping on teardown |
| DRC umbrella intro / loading spinners | #36 (`claude/intro-animation-loading-states-djis82`) | PR #36 trailer | `public/cure/umbrella.js`, `public/js/umbrella-spinner.js` | intro/spinner not rendering, canvas errors |
| **D1 schema bootstrap / `getDb`** (site-wide DB availability) | **#210** (`claude/login-internal-server-error-5qde9i`, session `01H237YTknr5rN8stJMpfM7w`, merged `9ec2b7e`) — root-caused the 2026-07-23 outage: #207's schema comment carried a semicolon, the naive `SCHEMA.split(";")` cut it into a bogus statement, `getDb` threw on every DB-backed request (17:30–19:45 UTC). Supersedes #209's login-side hardening (login was a symptom, not the bug) | in the PR's `Claude-Session:` trailer | `src/db.js` (`splitStatements`, `SCHEMA`, `getDb`), `src/db.test.js` | `D1_ERROR: … syntax error at offset 0` under `request.failed`; sign-in (`/auth/google/callback`) AND `/api/admin/*` all 500 at once. NOTE: the `server_errors` fix queue CANNOT capture this class — recording a crash also calls `getDb` — so detection is Workers Logs only |
| **Mermaid diagram rendering** (answers, both tiers) | **#213** (`267da70`, merged `11b646f`) introduced the fix; **re-applied + regression-locked** by `claude/mermaid-diagram-text-fhwk57` (2026-07-24) after merge `cb2deb6` (PR #216's merge-from-main on the workspace-flow branch) resolved `markdown.js` to its pre-#213 side and silently reverted it (feedback #8/#9) | in each PR's `Claude-Session:` trailer | `public/js/markdown.js` (`MERMAID_INIT`, `renderMermaidBlocks`, `completeMermaidSources`), `public/vendor/mermaid.min.js`, `public/js/markdown.test.js` | flowchart node boxes EMPTY while `\|yes\|`/`\|no\|` edge labels show (= `<foreignObject>` labels stripped by DOMPurify — root-level `htmlLabels: false` missing from `MERMAID_INIT`; the `MERMAID_INIT` unit tests fail if so); diagrams staying as code fences (= load/parse fail-soft, different class); bomb-icon error SVG appearing at the page bottom behind the input pane (= mermaid's parse-error rendering leaking into `document.body` — `suppressErrorRendering: true` missing from `MERMAID_INIT`; fixed + regression-locked by `claude/latest-feedback-bugfix-64f0ri`, feedback #12 2026-07-24, which also added the quote-repair retry `repairMermaidLabels` so paren-in-unquoted-label diagrams render instead of staying fences) |
| **On-device inference engine** (Bonsai in-browser, Se/cure) | **#128** (`claude/download-confirmation-flicker-wxgf3s`) for the DOWNLOAD path — WebKit has no `createWritable`; writes go through the `openWrite` seam (`createSyncAccessHandle` fallback), OPFS probed before network with the named Private-tab message, failures persist into the model row. **#124** (`claude/secure-local-llm-crash-17erxu`) stays owner for spawn/COEP/runtime: #123 fixed the top-level COEP worker-spawn crash for Chromium; #124 extended it to the worker's WHOLE module graph — WebKit/iOS checks every import — and swapped the vendored runtime to the self-contained transformers.min.js; #108/#114 built the field diagnostics | PR #128 / #124 trailers | `public/js/ondevice-core.js`, `ondevice-engine.js`, `ondevice-worker.js`, `src/assets.js` (`isWorkerScriptAsset` — the worker's whole same-origin module graph MUST carry COEP `require-corp` on the isolated /cure page, not just the top-level script), vendored transformers/ort runtimes | "engine crashed before it could start" (= a worker-graph module served without COEP — Safari-only if the top-level script has it, all engines if not — or stale PWA cache), "Failed to resolve module specifier"/"Module name … does not resolve" in generror (= a bundler-oriented dist vendored where a self-contained one is needed), silent hangs to deadline (worker-internal rejection), download crash/stall; debug via `?oddebug=1` + the on-screen trace (build stamp must match current d-stamp) |

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
> iOS spanning BOTH mounts.
>
> **2026-07-14 ~15:00 — ROOT-FIXED by #52 (merged `9e341c0`).** A different worker
> (session `01GE154SMjg759eTivTkpV8d`) proved the mechanism live in Chromium: a bare
> `IDBDevice {type:"dir"}` mount **hangs on the FIRST file read** in CheerpX 1.2.6
> (the device docs list `{type:"dir"}` but it only works as an `OverlayDevice`
> overlay). The nudge's device-layer hunch was right. #52 drops the `WORKSPACE_DB`
> + `dr-proj-` IDBDevice mounts and makes `/workspace` + project dirs **plain dirs
> in the root `OverlayDevice`** (already persistent via `IDB_CACHE_ID`) — retiring
> the whole corrupt-`/workspace`-volume failure class. Ownership of file mounting
> moves to **#52** (row above). **Still owes on-device confirmation:** an attached
> file `cat`-able from the VM + overlay persistence of `/workspace`/project dir +
> the cross-dir symlink across a reload. #43 stays the boot/reliability owner.
>
> **2026-07-15 — #52's read-path fix confirmed GREEN on-device (chat_logs #345,
> iPhone iOS 18.7 Safari, css h36) → evidence posted on #52 (comment
> 4977662270).** `/workspace` write + read-back both exit 0, `client_diag.fs.ms
> 968` (sub-second, vs the retired 11–27 s stall class). Partial confirmation
> only — #52 still owes: (1) a mounted *attachment/project file* readable from
> the VM, (2) overlay persistence of `/workspace`/project dir + the cross-dir
> symlink across a reload. Same sweep: chat_logs #346 hit one #34-style 30 s
> exec timeout on a trivial pipe (no filesystem involved), immediate retry
> (#347) succeeded — initially held back as a possible transient.
>
> **2026-07-15 (second tick) — RECURRENCE established → routed to #43
> (comment 4977916312).** chat_logs #344 (07-14 21:21) is the SAME symptom a
> day earlier: `ls /` fine (#343), then the first *piped* command
> (`echo -n … | sha256sum`) exit 124 at 30 s, identical retry succeeds
> (#347). Two occurrences across two sessions on the same iPhone; yesterday's
> run did not warm whatever is cold (cache not persisting across sessions?).
> Not the #52 file-read wedge — no filesystem path involved. Fail-soft held
> both times. Signature: first-pipe/uncached-binary exec timeout on iOS.
>
> **2026-07-15 (third tick) — hypothesis NARROWED → nudged #43
> (comment 4980601948): the cold unit is the BINARY, not the session.**
> chat_logs #351 (10:53, `sha256sum` pipe → exit 124, third morning in a
> row), then #352 (10:56, `file` on an attached PDF → exit 0, fast), then
> #353 (10:59, `zip` → exit 124 — a *different* previously-unused binary
> timing out MID-SESSION three minutes after a successful exec), then #354
> (11:15, `file` again → exit 0). Success sandwiched between two timeouts
> rules out first-exec-of-session cold: each not-yet-used binary's FIRST
> invocation blows the 30 s budget (cold disk-block fetches off the network
> disk on iOS), already-used binaries stay warm, and the block cache does
> not persist across sessions. Incidentally #352 is the on-device
> confirmation of #52's owed item (1): a mounted attachment IS readable
> from the VM (`file` exit 0 on `/workspace/Resume ….pdf`) — #52 still owes
> (2) overlay persistence + the cross-dir symlink across a reload.
>
> **2026-07-15 (merge tick) — #52 loop CLOSED: overlay persistence confirmed
> on-device (try-it #7 PASSED).** With the attachment-read confirmation
> (chat_logs #352, previous tick) this completes every owed item; the row
> above flips to fully confirmed. Confirmation posted on #52
> (the /try/10 502 was a DIFFERENT subsystem — fixed by PR #83: Berget's
> down-for-maintenance GLM-5.2 was the DRC dropdown default for borrowed
> sessions; down models are now excluded and upstream error detail surfaces).
>
> **2026-07-17 — /src source-mount regression (chat_logs #522, iOS 18.7, css
> h46) → owner-routed to a fresh worker (`claude/sandbox-source-mount-timeout-
> gre7zf`).** #119's tar seeding + fail-soft seed timeout was NOT enough on the
> phone: the seed re-extracted the whole 6.6 MB snapshot every boot (`rm -rf
> /src` first), blew the 45 s abandon point (fs.ms 61914), and — since CheerpX
> cannot kill the guest process — kept extracting while the model's
> `ls -l /src` ran against it on the single-threaded VM → 30 s exec timeout,
> exit 124, teardown. The same exchange had `budget_s: 15`, which the fixed
> 30 s exec ceiling ignored. Fix: (1) stamp-guarded seeding — `/src/.dr-stamp`
> written only after a successful extraction, matching stamp skips rm-rf+tar
> entirely on re-boots; (2) the background seed is tracked and execInSandbox
> WAITS for it (bounded) instead of racing it, failing soft without teardown
> when still busy (`sandbox.exec_seed_busy`) and discarding only a truly
> wedged seed (`sandbox.seed_wedged`, 180 s); (3) the per-command ceiling is
> scoped to the user's research budget (`execTimeoutForBudget`, both tiers).
> Owed: on-device confirmation (first dev-mode boot seed-busy fail-soft, and
> a fast stamped SECOND boot where `ls -l /src` answers).
>
> **2026-07-18 — #131's owed on-device confirmation ARRIVED (both items) +
> residual first-boot-after-deploy timeout → reported to #131 (comment
> 5012187482) AND fixed directly per owner directive
> (`claude/swe-sandbox-timeouts-tjd7y0`).** Owner hit "ls in sandbox timed
> out" during a SWE-mode session; live logs confirm #131's fail-soft is
> working: **#526** (css **h47**, iOS 18.7, FIRST boot after the deploy) →
> `ls -l /src` exit 124 with the graceful `sandbox.exec_seed_busy` message
> ("still preparing …") — NOT #522's 30 s wedge+teardown; and **#523** (css
> h46, warm/stamped SECOND boot) → `ls -l /src` exit 0, six fast listings
> (stamp skip). **Residual root cause:** #526's `client_diag.fs.ms` was
> **80401** (a ~6.8 MB full re-extraction because the h47 deploy changed the
> stamp), and the seed-wait used the *per-command* exec ceiling
> (`budget_s:45 → 30 s`) — so the first `ls -l /src` after every deploy
> soft-failed at 30 s though the seed (with a ~45 s boot head start) was
> seconds from done. **Fix:** the seed-wait is decoupled from the command
> ceiling — `SEED_WAIT_MS` (bash-core.js, 60 s, `min`-bounded by
> `SEED_WEDGE_MS`) now covers the cold-seed tail so the first command lands;
> new `sandbox.exec_seed_ready` info event confirms it on-device;
> `exec_seed_busy` gains `seed_age_ms`. Owner-directed direct edit to #131/#43
> files — owner-worker need not duplicate; @-mention on the PR comment.
> (The same #526 session's SWE "no clickable link" was a SEPARATE pipeline bug,
> also fixed on this branch — `build-pub.js` `replyLinksTo` + recovered-answer
> slug re-derivation.)
