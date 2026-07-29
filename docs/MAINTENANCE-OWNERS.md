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
| **arXiv as a research source — routing, query breadth, latency** | `claude/arxiv-latest-feedback-nmrg0u` (branch; PR number to be filled at merge) — fixed feedback #44's three subtasks: an explicitly-arXiv request that ran nine web searches first, an arXiv query narrowed to `linux performance optimization`, and searches taking close to a minute | in the branch's `Claude-Session:` trailer | `src/arxiv.js` (`arxivLeadIntent`, `arxivPickQuery`, the NOISE list), `src/arxiv-rag.js` (the served-tier time budget), `src/search-sources.js` (`leadIntent`/`leadMaxPerRequest`/`leadSourceIds`), `src/pipeline.js` (`leadingSources`, `startAuxSearches`, `planAuxSource`, `runWebLeg`), `embedTexts`'s `timeoutMs` in `src/berget.js` | a chat_logs row whose question names arXiv but whose `meta.queries` are web angles and whose sources are arxiv.org *mirrors and help pages* (the #694 signature); an `arxiv` `search_done` whose query narrows away from what the user asked (check it against `meta.queries` — the pick should COVER the user's terms, not add new ones); `arxiv.ladder_budget` warnings with `attempts: 0` (= a leg upstream of the ladder overspent, which is how the 60 s `embedTexts` default hid); `arxiv_rag.rerank_skipped` firing routinely (= the dense tier is at its budget, not just over it once); a lead that never releases — an explicitly-arXiv turn ending with 0 sources instead of falling back to the web leg |
| **arXiv CORPUS + hosted index — coverage, window, retrieval quality** (distinct from the routing owner above: this row guards WHAT IS IN the index and how well it retrieves, not how a turn reaches it) | `claude/arxiv-window-late2023-eval` (branch; PR number to be filled at merge) — widened the window 13 → 34 months (337,768 → 772,658 vectors), built the first evaluation of the SERVED path, and fixed the two defects it exposed: a rerank pool of 20 justified by a Vectorize cap that had since been raised to 50, and sources dated by last revision rather than submission | in the branch's `Claude-Session:` trailer | `scripts/arxiv-harvest.mjs` (`planWindow`, `--keep-months`), `scripts/arxiv-crosscheck.mjs`, `scripts/arxiv-hosted.mjs`, `scripts/arxiv-hosted-eval.mjs`, `scripts/arxiv-vectorize.mjs`, `src/arxiv-rag.js` (`CANDIDATES`, `arxivSubmitted`, `arxivRagItem`), `docs/ARXIV-RAG.md` §11 | a harvest that exits 0 with per-month coverage under 95% (`arxiv-crosscheck.mjs` — the failure mode here is a run REPORTING SUCCESS while short, twice now: 48.1% of one month, then 26.5% of a band); `arxiv-hosted-eval.mjs coverage` showing a month below ~98%; `inPool` falling while r@10 tracks it (= the candidate pool is the constraint, not the reranker); any recall figure quoted for the served path that came from `arxiv-eval.mjs` (that measures the local pack — different pipeline); `CANDIDATES` reverting to 20 on the strength of the old comment or of `src/rag.js`, which still assumes 20 and has never been re-probed; a recency boost added to retrieval on the strength of §11 alone (the age shift is measured, the ranking change is NOT) |
| Sandbox agentic shell loop | #37 (`claude/last-chats-failure-logs-87jlxp`) | PR #37 trailer | `public/js/bash-core.js` (`runShellLoop`, `sandboxTornDown`) | `Ran N commands, all sandbox not ready`; loop not stopping on teardown |
| **Terminal PANE + the `#termbtn` switch** (what the user SEES of the sandbox, as opposed to whether it boots) | `claude/terminal-background-feedback-q037nt` — fixed feedback #42, the follow-on to #38: the switch and the boot line worked, but `stopBootQuips()` cleared that one replaceable line the moment the boot ended, so the pane fell back to the idle placeholder and a boot that FAILED left it blank while the icon still claimed Linux was running. Supersedes **PR #311** (`claude/terminal-visibility-feedback-21n6j2`), which fixed #38 | in the branch's `Claude-Session:` trailer | `public/js/agent-backdrop.js` (`feedTerminalLine`), `public/js/agent-backdrop-core.js`, `bootLogLine` in `public/js/boot-messages.js`, `setStatus`/`startBootQuips`/`stopBootQuips` + the login-shell banner in `public/js/sandbox.js`, the `#termbtn` + `body.term-fg`/`term-hidden` blocks in `public/css/app.css` + `public/cure/drc.css` | a tap on `#termbtn` that changes nothing (no `body.term-fg`/`term-hidden` flip); the pane forward showing a blank black field; the pane reading `sandbox terminal idle` when a boot has already run; a boot that ends (ready, failed, timed out) without a closing line; the boot-progress line missing while `sandbox.boot_stage` is still advancing; the icon visible with the sandbox knob off. Regression cover: `tests/e2e/terminal-pane.spec.js` (`--config=sandbox.pw.config.js`) + the `bootLogLine` unit tests. **Owes:** on-device confirmation on iOS that a real cold boot leaves a readable transcript behind the chat. |
| DRC umbrella intro / loading spinners | #36 (`claude/intro-animation-loading-states-djis82`) | PR #36 trailer | `public/cure/umbrella.js`, `public/js/umbrella-spinner.js` | intro/spinner not rendering, canvas errors |
| **Orchestrator research quality** (reference-object grounding + the outside-registry citation gate) | **#251** (`claude/loop-feedback-hvc991`, feedback #21) — the prompt-layer quality owner; PR #247 remains the mode's feature owner (executor, SSE events, graph view) | in the PR's `Claude-Session:` trailer | `public/js/orchestrator-core.js` (`orchestratorPlanPrompt` GROUND COMPARISONS rule), `src/prompts.js` (`orchAgentPrompt` / `orchSynthPrompt` citation gates) | a comparison answer whose plan has no grounding agent for the reference object (site questions: no introspection node); a merged answer citing/footnoting a source absent from its Sources registry ("not in the original source list" in a footnote is the signature); sub-agent briefs citing numbers their material never contained |
| **iOS bar tint / mode-theme chrome** (the strip behind the iPhone status icons following the mode theme, browser + installed app) | **#248** (`claude/loop-feedback-hvc991`, feedback #20) — owes on-device confirmation (Safari leg, PWA-reinstall leg, status-icon legibility): `docs/test-requests/claude-loop-feedback-hvc991.json` | in the PR's `Claude-Session:` trailer | `public/js/bar-tint.js` (`nudgeTint`), `public/js/chat-mode.js` (`applyChatModeTheme` tint repaint), `public/index.html` (viewport-fit / `apple-mobile-web-app-*` metas, data-devtheme script), `public/css/app.css` (safe-area insets on `.header-bar`/`#chat`/`#composer`) | top strip stuck on the PREVIOUS mode's colour after a dropdown switch (iPhone); stuck Deep Research blue in the installed app; status icons unreadable over a mode field (needs the standalone-only scrim follow-up); header/composer content sliding under the notch or home indicator |
| **Terminal PANE on a REMOTE execution environment** (the pane when the commands do NOT run in the browser VM) | `claude/terminal-visibility-logging-yvso49` (branch; PR number to be filled at merge) — fixed feedback #43. NOT a regression of the `terminal-background-feedback-q037nt` row above: that fix still holds for the browser VM. This is a path that never had a mirror at all, exposed when the 2026-07-27 default flip made the cloud container the environment most sends use | in the branch's `Claude-Session:` trailer | `remoteTerminalMirror` in `public/js/agent-backdrop.js`, `execConnectLog` in `public/js/exec-backends-core.js`, the mirror wiring in `public/js/stream.js` `maybeRunShellLoop` and the `onStatus` handler in `public/cure/drc.js`, `sanitizeExecDiag` in `src/validation.js`, `formatShellForLog` in `src/chatlog.js`, `flushSandboxLog` (exported) in `public/js/sandbox.js` | the pane reading `sandbox terminal idle` on a send whose `client_diag.xb` is `local`/`cloudflare` and whose `ran` is > 0 — the #43 signature, now checkable directly as `client_diag.xd.cmds > 0` with `xd.term == 0`; a connect that ends without a closing line (`xd.boot: 0` with a blank pane); the pane naming a different environment than `xb`; `xd` missing from a send that ran commands; the browser VM printing every command TWICE (= the remote-only guard lost, so the mirror double-feeds what sandbox.js already feeds); `exec.runner_*` events absent from Workers Logs on a remote send (= the flush regressed). Regression cover: `tests/e2e/terminal-remote.spec.js` (`--config=sandbox.pw.config.js`) + the `execConnectLog` / `sanitizeExecDiag` / `formatShellForLog` unit tests. **Owes:** on-device confirmation that a real cloud-container send fills the pane on iOS. |
| **Agent Studio — which SDK builds a request, and what it is CALLED** | `claude/legal-research-agent-feedback-r14yhg` (branch; PR number to be filled at merge) — fixed feedback #41: a single-agent build was run AND described as a Platform SDK distillation, under the internal codename, with no sandbox action at all | in the branch's `Claude-Session:` trailer | `public/js/sdk-core.js` (`buildTargetFor`, `buildSdkContextBlock`), `public/js/agent-spec-core.js` (`buildAgentSdkDigest`), `src/prompts.js` (`SDK_METHOD_NOTE`, `sdkBuild*Prompt`, `bashAgentPrompt` sdkMode branch), `src/pipeline.js` `runSdkBuild`, `public/js/bash-core.js` (`shellPrePassPurpose`), `public/js/stream.js` `maybeRunShellLoop` | the string `DistillSDK` in anything the model reads (the unit tests fail on it — a new prompt or context string is the likely reintroduction path); a single-agent ask briefed on the Platform SDK (`sdk.build_gate` logs `target`, so check it against the request); an Agent Studio build turn with no `sandbox` step at all (= the recon pre-pass skipped again — the inverse regression is a build turn that boots the VM and then writes the app's files into it, which feedback #7 forbids) |
| Agent Studio plant spinner + SPROUT greeter (SDK-mode waiting symbol) | #232 (`claude/agent-studio-sprout-animation-esif4i`) | PR #232 trailer | `public/js/plant-spinner.js`, `public/js/sdk-plant.js`, `public/js/mode-spinner.js` | spinner not rendering, canvas errors; anything brown drawn (seed/soil regression — the loop must be the 🌱-shape sprout only, owner directive 2026-07-24); finale missing the flower + golden seed scatter; finish() never firing onDone (caller's ✓ swap stalls) |
| **D1 schema bootstrap / `getDb`** (site-wide DB availability) | **#210** (`claude/login-internal-server-error-5qde9i`, session `01H237YTknr5rN8stJMpfM7w`, merged `9ec2b7e`) — root-caused the 2026-07-23 outage: #207's schema comment carried a semicolon, the naive `SCHEMA.split(";")` cut it into a bogus statement, `getDb` threw on every DB-backed request (17:30–19:45 UTC). Supersedes #209's login-side hardening (login was a symptom, not the bug) | in the PR's `Claude-Session:` trailer | `src/db.js` (`splitStatements`, `SCHEMA`, `getDb`), `src/db.test.js` | `D1_ERROR: … syntax error at offset 0` under `request.failed`; sign-in (`/auth/google/callback`) AND `/api/admin/*` all 500 at once. NOTE: the `server_errors` fix queue CANNOT capture this class — recording a crash also calls `getDb` — so detection is Workers Logs only |
| **Mermaid diagram rendering** (answers, both tiers) | **#213** (`267da70`, merged `11b646f`) introduced the fix; **re-applied + regression-locked** by `claude/mermaid-diagram-text-fhwk57` (2026-07-24) after merge `cb2deb6` (PR #216's merge-from-main on the workspace-flow branch) resolved `markdown.js` to its pre-#213 side and silently reverted it (feedback #8/#9) | in each PR's `Claude-Session:` trailer | `public/js/markdown.js` (`MERMAID_INIT`, `renderMermaidBlocks`, `completeMermaidSources`), `public/vendor/mermaid.min.js`, `public/js/markdown.test.js` | flowchart node boxes EMPTY while `\|yes\|`/`\|no\|` edge labels show (= `<foreignObject>` labels stripped by DOMPurify — root-level `htmlLabels: false` missing from `MERMAID_INIT`; the `MERMAID_INIT` unit tests fail if so); diagrams staying as code fences (= load/parse fail-soft, different class); bomb-icon error SVG appearing at the page bottom behind the input pane (= mermaid's parse-error rendering leaking into `document.body` — `suppressErrorRendering: true` missing from `MERMAID_INIT`; fixed + regression-locked by `claude/latest-feedback-bugfix-64f0ri`, feedback #12 2026-07-24, which also added the quote-repair retry `repairMermaidLabels` so paren-in-unquoted-label diagrams render instead of staying fences); a dev-mode diagram/visualization ask answered with ASCII/Unicode box art in a plain fence instead of a ```mermaid fence (= PROMPT-guidance gap, not a rendering failure — fixed + regression-locked by `claude/mermaid-feedback-introspection-cqt65c`, feedback #14 2026-07-24: the shared `MERMAID_DIAGRAM_NOTE` in `public/js/introspect-core.js`, spliced into both tiers' introspection answer prompts AND `buildIntrospectionBlock`) |
| **On-device inference engine** (Bonsai in-browser, both tiers — Se/cure's knob and Se/rver's `ondevice::` model group) | **#128** (`claude/download-confirmation-flicker-wxgf3s`) for the DOWNLOAD path — WebKit has no `createWritable`; writes go through the `openWrite` seam (`createSyncAccessHandle` fallback), OPFS probed before network with the named Private-tab message, failures persist into the model row. **#124** (`claude/secure-local-llm-crash-17erxu`) stays owner for spawn/COEP/runtime: #123 fixed the top-level COEP worker-spawn crash for Chromium; #124 extended it to the worker's WHOLE module graph — WebKit/iOS checks every import — and swapped the vendored runtime to the self-contained transformers.min.js; #108/#114 built the field diagnostics. **`claude/device-llm-crash-fix-guva4y`** (feedback #19, 2026-07-24) owns the MEMORY class: the phone-memory prompt budget (`trimForOnDevice` / `ONDEVICE_PROMPT_BUDGET_CHARS` — prefill memory is quadratic in prompt length, so long chats killed 1.7B and 8B alike), dispose-on-model-switch, and the free-the-model-and-say-so recovery on memory-looking generate failures | PR #128 / #124 / branch trailers | `public/js/ondevice-core.js`, `ondevice-engine.js`, `ondevice-worker.js`, `src/assets.js` (`isWorkerScriptAsset` — the worker's whole same-origin module graph MUST carry COEP `require-corp` on the isolated /cure page, not just the top-level script), vendored transformers/ort runtimes | "engine crashed before it could start" (= a worker-graph module served without COEP — Safari-only if the top-level script has it, all engines if not — or stale PWA cache), "Failed to resolve module specifier"/"Module name … does not resolve" in generror (= a bundler-oriented dist vendored where a self-contained one is needed), silent hangs to deadline (worker-internal rejection), download crash/stall; "memory exhaustion"/OOM/device-lost on a LONG chat (= the prompt budget failed — check `trimForOnDevice` still runs in the worker's `generate`) or right after switching models (= dispose-on-switch regressed); debug via `?oddebug=1` + the on-screen trace (build stamp must match current d-stamp) |
| **Agents SDK — the capability layer + registry-driven mode routing** | **#266** (`claude/default-agents-sdk-generalization-budw4k`) — made the five default chat modes AgentSpec entries and `/api/chat` route on what they declare | in the PR's `Claude-Session:` trailer | `sdk/AGENTS.json`, `public/js/agent-spec-core.js`, `src/agent-spec.js`, `src/agent-registry.js`, `src/prompt-sets.js`, the `ANSWER_PHASE_RUNNERS` dispatch in `src/pipeline.js`, the routing block in `src/chat.js` | a mode flag that stops routing (`sdk_mode`/`orchestrator_mode`/`outrospection_mode` answering as plain Deep Research = `resolveRequestAgent` returned null AND the boolean fallback also missed); a plain Deep Research turn suddenly loading the source snapshot (= `routingNeedsRegistry` regressed — a latency, not a correctness, signature); `agent-capability.test.js` / `agent-bounds.test.js` failing on a bound whose constant moved without the spec (the declaration is then lying about the agent); `prompt-sets.test.js` failing on identity (a prompt builder renamed or re-pointed); a new AgentSpec field added without a `validateCapability` rule |
| **Feedback SEND ROUTING** (a "feedback …" report reaching the developers whatever route the send takes) | **`claude/feedback-loop-0evgg0`** (feedback #23, 2026-07-25) — the Se/rver tier checked its two browser-direct routes (on-device `ondevice::` pick, private-introspection own-key route) BEFORE any gate, so a report sent while a Bonsai model was picked was answered by that local model and no feedback entry was created. The rule now lives with the gate as `feedbackForcesServerRoute` and is consulted ABOVE every route decision, so a future browser-direct route inherits it | in the branch's `Claude-Session:` trailer | `public/js/feedback-core.js` (`feedbackForcesServerRoute`), `public/js/stream.js` (`sendMessage` route order + the `ondevice::` model strip), `public/cure/drc.js` (`send` — Se/cure's gate stays FIRST, before provider routing) | a "feedback …" message answered by a model instead of the canned acknowledgment (on-device picks: the answer reads as small-model filler); no new row in `scripts/feedback` after a user says they sent feedback; a forced server send 400ing on "Unknown model." (= the `ondevice::` strip regressed); a NEW early-return route added to `sendMessage` above the `feedbackSend` check |
| **Shared compute — cross-tier lending + the Se/cure posture copy** (the sharer control in BOTH tiers, and what Se/cure claims about a session's data path) | **#287** (`claude/shared-compute-feedback-33vgh9`, feedback #31, merged `2aaf1cae`) — gave the Se/rver LLM sharing screen its own local-server URL + "Share my compute" toggle (was a pointer at /cure), unified both tiers' local-model wire in `pool-local.js`, and made the tier's ambient privacy copy follow the session's configuration (`secure-posture-core.js`: `local` < `direct` < `routed` < `peer`, largest disclosure wins; `privacyNoticeLines` gained the pooled branch) | in the PR's `Claude-Session:` trailer | `public/js/pool-local.js`, `public/js/secure-posture-core.js`, `public/js/account-pool.js` (the sharer engine + `resumePoolSharing`), `public/js/app.js` (the boot resume), `public/cure/drc.js` (posture wiring, `applyPostureCopy`, the sharer loop), `public/cure/ghostwalk.js` (`resolveQuips` + per-leg re-resolution), `public/js/drc-page-core.js` (the pooled Model-calls line) | the Se/rver "Your shared model" section pointing back at /cure with no toggle; the ghost/greeter/intro promising "stays in this browser" while a pool token is connected+enabled or the pool provider is selected; a pooled privacy notice claiming "on your own API key" / "the server is not involved"; a sharer's toggle left ON not re-registering on the next app boot; the two tiers sending different bodies to the same local server. **Deployed 2026-07-26, relay NOT re-confirmed live post-merge** — `tests/e2e/llm-sharing.live.spec.js` covers the four-identity relay against a deploy, and the new Se/rver-tab lending leg has never run against a real broker + local model. Owes that run. |
| **Orchestrator SWARM MEMORY + crash capture** (the in-browser Bonsai pool that runs a plan's swarm nodes, and whether a run that dies leaves a trace) | **#277** (`claude/parallel-subagent-feedback-oqpv0t`, feedback #26, merged `cc53e442`) — root-caused the tab OOM: `stream.js` ran the swarm WITHOUT the send's abort signal, so Stop/re-send/mode-switch left every member decoding to `MEMBER_DEADLINE_MS` while the next send spawned another full pool (N → 2N → 3N), and `planSwarmCapacity` ignored model size on browsers with no `navigator.deviceMemory` (Safari). Also the first owner of the durable failure record — before it, a dead run wrote NOTHING (`chat_logs` only lands at completion, `server_errors` was empty, `client_gone` had never fired) | in the PR's `Claude-Session:` trailer | `public/js/swarm-runtime.js` (pool lifecycle, `stopSwarms`, breadcrumb + crash guards), `public/js/swarm-core.js` (`planSwarmCapacity`), `public/js/ondevice-core.js` (`runBreadcrumb`/`crashDiag`), `public/js/ondevice-engine.js` (terminate/abort finality), `public/js/stream.js` (signal + `client_diag.sw`), `src/validation.js` (`sanitizeSwarmDiag`), `src/orchestrator.js` + `src/server-errors.js` (`recordSubsystemFailure`) | a tab that dies mid-run on a device with cached weights; `client_diag.sw.died: 1` (a run that never reached `done`) or `sw.cls: "oom"` in the chat log; `orch.plan` with no matching `chat.complete`; the swarm still running after Stop (`swarmRunning()` true with no send in flight); concurrency not dropping for a large model on a browser that reports no RAM. **Deployed 2026-07-26, NOT confirmed on-device** — the swarm path only exists in a real browser with cached weights, so the memory fix is unproven until the reporter (or anyone with weights cached) runs Orchestrator and it survives. Owes that confirmation. |

| **Static promo pages — inline-script DOM contracts** (`/story/` today; the guard sweeps every tracked `public/**/*.html` whose inline scripts look up their own markup by id) | **`claude/fix-story-loading-stall`** (2026-07-26, owner-reported) — `/story/` shipped with `id="history"` missing from its container div, so the ~90 KB build story never rendered: `getElementById` returned null, the render threw, and the `catch` threw again on the same null, leaving the lead paragraph plus a permanent "Loading…" and no on-screen error. Confirmed live — the deployed page carried the bare `<div>` while `/build/history.md` served 200 with all 89,625 bytes, so the content was always there and only the render target was missing. No test had ever looked at these pages, which is why the suite stayed green through it | in the branch's `Claude-Session:` trailer | `public/story/index.html`, `src/static-pages.test.js`, and the `/story/` + `/build/` entries in `src/assets.js` | any static page stuck on its own placeholder ("Loading…") while the file it fetches returns 200 (= the render target is null, not a fetch failure); `src/static-pages.test.js` failing on an id an inline script reaches for but the markup no longer declares; `/story/` or `/build/` dropping off `isPublicAsset` (a 401 there is the same blank page for signed-out visitors) |

| **Space animations — scene rendering + the chat embed's answer** (`/space/` and both tiers' chat embeds) | **`claude/space-launch-feedback-qq6zxm`** (2026-07-29, feedback #46) — the `rocket-launch` scene drew Earth as one thin `ctx.arc` limb with the starfield showing through it, so a user asked to be shown a launch and reported seeing no planet at all; the flat circle also drifted off the true silhouette under rotation. Replaced with real geometry (`sphereSilhouette` tangent circle, `spherePatchGrid` ground, `facesCamera` culling) plus a camera dolly from pad to orbit. Same fix closed the second half: the embed was client-only, so the answer model read its own "does NOT … display media" capabilities line and apologised for being unable to show visuals while the animation played beside it — `ctx.spaceScene` now threads the matched scene into the three answer prompts | in the branch's `Claude-Session:` trailer | `public/js/space-core.js`, `public/js/space-embed.js`, `public/js/space-core.test.js`, `src/prompts.js` (`capabilitiesTail`), `src/pipeline.js` (`spaceSceneTitle`, `ctx.spaceScene`) | an answer that offers to *describe* a visual the chat already mounted (= `spaceScene` not reaching the answer phase); ground grid crossing its own horizon or the far side drawing over the near side (= a flat-circle limb or missing `facesCamera` cull); a scene reported "empty"/"missing the planet" — check the render, not the matcher, which fires correctly; `space_feedback` 👎 rows on `rocket-launch` |

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

> **2026-07-25 — the 07-21 `/src` seed regression is CLOSED green; the cold-seed
> window is the surviving residual (reported to #131, comment 5077966785).**
> Feedback entry #2 (`seed_wedged`, chat_logs #534) was routed to #131 on 07-21.
> It has not recurred: a chatlogs scan for `seeding never finished` returns only
> #534, and the same device (iPhone, iOS 18.7) ran `cat /src/src/pipeline.js`
> **exit 0** with `fs.ms 516` on 07-24 (**#607**, and **#611** the same hour) —
> the stamp skip working as designed. #620 the same afternoon soft-failed with
> `exec_seed_busy` ("still preparing"), which is #131's intended behavior, not
> the wedge. Entry #2 resolved; the reporter was told the retry-after-an-update
> behavior is expected.
> **Residual, trending worse:** #620's cold re-seed was **155 157 ms** for an
> **8.63 MB** `/src` payload against `SEED_WAIT_MS` = 60 s, so the first
> dev-mode command after every deploy is now *guaranteed* to soft-fail
> (6.8 MB/80 s on 07-18 → 7.44 MB on 07-21 → 8.63 MB/155 s on 07-24). Raising
> the constant only buys time; shrinking the mounted payload or stamping
> per-path so a deploy re-seeds only what changed is the real fix. Open with
> #131 as the `/src` mount owner.
