# Merged / superseded branch ledger

**This file is the branch "merged" tag.** Any branch listed here with a
verdict of **Merged** or **Superseded** is DONE — its work is already in
`main` (or was intentionally dropped). Do **not** cut new work from it,
do **not** push more commits to it, do **not** reopen its PR. Branch fresh
from the current `origin/main` instead.

The companion mechanism is the **merge-branches** skill
(`.claude/skills/merge-branches/`) — read it before integrating any branch
or editing this ledger. The `scripts/check-merged-branches.mjs` guard reads
the `tip@merge` SHAs below and shouts if anyone kept working on a branch
already marked done (see **Rule-break detection** at the bottom).

- **Baseline `main`:** `f3c594e` (2026-07-13 06:44 UTC) — the snapshot this
  inventory was reconciled against.
- **Legend for `Verdict`:**
  - **Merged** — content integrated into `main` *this session* via PR; tip
    SHA recorded so the guard can detect further pushes.
  - **Superseded** — the feature/fix is already present in `main` (the branch
    was squash-merged or re-implemented earlier; SHAs differ, content matches).
    Confirmed by content check.
  - **Superseded?** — *heuristic* guess (large squashed history whose named
    feature is visibly in `main`); still needs the one-line content check in
    the skill before you rely on it. Treat as "almost certainly done."
  - **Review** — carries a small unique delta not yet content-verified; a real
    integration candidate. See **§3 Candidates**.
  - **Dropped** — intentionally not integrated (conflicts with a later product
    decision). Do not resurrect without owner sign-off.

---

## 1. Confirmed verdicts (content-checked this session)

These override the heuristic in the inventory table.

| Branch | tip@merge | Verdict | Evidence |
|---|---|---|---|
| `claude/firefox-focus-auth-redirect-u52ljv` | `f0304de` | Superseded | `main` `src/index.js:157-159` already forces `https:` in the canonical redirect. |
| `claude/tool-calling-visibility-wlroih` | `5e914ca` | Superseded | `main` `src/chatlog.js:100-105` already records shell tool calls. |
| `claude/whitespace-slash-animation-juizwv` | `404e73a` | Superseded | CamelCase tier wordmarks are the current CLAUDE.md branding rule — already live. |
| `claude/server-secure-storage-clarity-x677jc` | `5c1da8c` | Dropped | "always store in cloud, remove the storage knobs" conflicted with `main` at the time, which then kept the `server_history` knob. SUPERSEDED 2026-07-16: the owner directed exactly this change (implicit always-on cloud storage, knobs removed) and it landed via `claude/cloud-storage-behavior-x3rrsy` — invariant 4 now reads accordingly. |
| `claude/tokemon-game-subsystem-30a8r7` | `4f677fc` | Superseded | `src/tokemon.js` / `src/tokemon-api.js` present in `main`. |
| `claude/refactor-skill-repo-kb1c7k` | `f9ee2ab` | **Merged** | `src/billing.js` extraction integrated 2026-07-13 (tests 70/70). |
| `claude/glass-pane-close-icon-v451n4` | `189db14` | **Merged** | close chevrons integrated 2026-07-13. |
| `claude/security-assessment-owasp-setup-3hznsj` | `bef0451` | **Merged** | OWASP Top-10 corpus + offline retrieval integrated 2026-07-13 via 3-way merge (only source-snapshot/rag conflicted; 1222/1222 tests, typecheck clean). |
| `claude/forbux-onboarding-flow-dsd61y` | `1460d68` | Superseded | On cherry-pick the net drc.js diff vs `main` was **empty** — the land-in-chat onboarding is already in `main`. |
| `claude/admin-feature-selection-board-9zva2a` | `9084844` | Superseded | The whole selection-board / decision-board system is in `main`: `panels.js` (attention loop), `board.js`, `admin-boards.js`, `features.js`, `security-risks.js`, `panels_reviews`/`security_reviews`/`features_reviews`, `scripts/{boards,panels,features,security}`, the decision-boards + feature-board skills, `docs/DECISION-BOARD-LOOPS.md`. Branch is ~5200 lines behind main. |
| `claude/introspection-ui-styling-dz4b0o` | `38750f8` | Dropped | Owner directive 2026-07-13: the titanium-white introspection styling already in `main` (`45d8288`, `98faa03`) is the accepted version. This branch's parallel restyle is SCRAPPED — it conflicts with the merged titanium work across `app.css`/`drc.css`/`drc.js`/`app.js`. Do NOT merge or rebuild on it. (Its PR still needs closing via the GitHub UI once the connector is back; branch delete was blocked by repo rules.) |
| `claude/selection-boards-headers-v9xhgp` | `7c11c47` | Superseded | Landed in `main` earlier via PR #6 (collapse-to-headers + features board); not in the unmerged set. |
| `claude/victorian-umbrella-animation-vooqu6` | `099a7f1e` | **Merged** | DRC umbrella intro: Victorian umbrellas revive from wire into colour. Merged 2026-07-13 at `6a10191`; only source-snapshot/rag conflicted (regenerated). 1224/1224 tests. **Tip re-recorded 2026-07-26 from `6a10191` → `099a7f1e`:** the branch was reused for follow-up work after being tagged (the rule-break this ledger exists to catch), but the work did land — "Se/cure is the front door" reached `main` via PR #30 (`8a13ad1e`). Nothing is lost; the re-record is so the guard stops reporting a violation whose damage is already reconciled. Deliberate, not a silent re-tag. |
| `claude/server-secure-docs-split-m4j48m` | `5ea5b03c` | **Merged** | Per-tier documentation split: /cure/help/ (Se/cure, khaki) + /help/ reworked as the Se/rver docs with accurate knob-dependent storage claims; cross-links both ways; `help` reserved slug. Merged 2026-07-16 (owner: "Merge"), 1603/1603 tests, typecheck clean. **Tip re-recorded 2026-07-26 from `6c86f12` → `5ea5b03c`:** the one commit on top is this ledger's own "tag it Merged" row, which is in `main`. Benign — no code followed the tag. |
| `claude/slush-spacing-precision-jqty1f` | `50d88c1` | **Merged** | slash-spacing skill + scripts/slash-gap.mjs (true ink-gap meter, headless Chromium) + the measured `b .sl { margin: 0 -.04em }` bold fix on BOTH docs pages (/help/ and the just-split /cure/help/). Merged 2026-07-16 (owner: "Merge") via rebase `fd993bc` (the remote ref stays frozen at pre-rebase `50d88c1` — repo rules block force-push AND delete on it; all content is in main). 1603/1603 tests, typecheck clean. |
| `claude/bonsai-27b-phone-inference-hqhz6p` | `25fcf6c` | **Merged** | The on-device inference tier: 1-bit Bonsai models in the browser for Se/cure (ondevice-core/engine/worker, vendored transformers.js + ort wasm, settings knob + consent popup, provider seam). Merged 2026-07-16 (owner: "Merge") via `claude/bonsai-ondevice-knob-bug-n116u9`, which builds directly on this tip. 1695/1695 tests, typecheck clean. |
| `claude/bonsai-ondevice-knob-bug-n116u9` | `784fa8e` | **Merged** | Fix for the reported "Checking this device…" forever-hang: worker onerror/workererror now fail ALL pending waiters (list/plan/delete included), every settings-drawer engine call runs under a stage-naming `withDeadline`, inconclusive GPU probe → marginal not blocked. Verified headless (worker-404 rejects in ~13 ms where it hung). Merged 2026-07-16 (owner: "Merge"). 1695/1695 tests, typecheck clean. |
| `claude/header-display-issue-7ptcre` | `64065c7` | **Merged** | /help screenshots recaptured live (header, composer on/off, popover, account panel — the header illustration still showed the pre-move layout with the model selector; user report) + "The header" / "The input area" / "Your account panel" sections rewritten to match the real UI; recapture recipe recorded in ui-notes. Merged 2026-07-16 (owner: "Merge") via rebase `fb37343` (the remote ref stays frozen at pre-rebase `64065c7` — repo rules block force-push on it; all content is in main). 1603/1603 tests, typecheck clean. |
| `claude/project-pulse-feature-timeline-tcd1l7` | `0e0ffdc` | **Merged** | Refreshed the `/pulse` commit-analytics dataset and the `/pulse/timeline.html` feature-focus timeline through 2026-07-24 (900 commits over 21 days from the unshallowed history) + curated the 8 newly-flagged day summaries + refreshed the code-size snapshot; introspection artifacts regenerated. Merged 2026-07-24 (owner: "Merge") via fast-forward — no PR needed. 2253/2253 tests, typecheck clean. |
| `claude/shared-compute-feedback-33vgh9` | `9969e6e2` | **Merged** | Feedback #31: the Se/rver panel's LLM sharing screen gained the sharer's own local-server URL + "Share my compute" toggle (lending was wired Se/cure-only; both tiers now drive one local runner, `public/js/pool-local.js`), and Se/cure's standing privacy copy became a function of the session's configuration (`public/js/secure-posture-core.js` — ghost quips, greeter, intro pane, tier explainer; `privacyNoticeLines` gained the pooled branch). Merged 2026-07-26 as PR #287 (`2aaf1cae`) at tip `9969e6e2` — the pre-merge tip `92a016b1` was what PR #288 recorded, before this branch took a `main` merge of its own. Force-push barred on the branch, so the rebase landed as merge commits; `main` moved twice mid-flight. 2928/2928 tests, typecheck clean. Owner row: `docs/MAINTENANCE-OWNERS.md`.
| `claude/parallel-subagent-feedback-oqpv0t` | `d4fb32d5` | **Merged** | Feedback #26, worked by three parallel sub-agents: orchestrator crash capture (`recordSubsystemFailure` + a closed failure-class vocabulary — before it a run that died mid-flight wrote nothing at all), the in-browser swarm memory bounds (the missing abort signal that let N models become 2N/3N, plus model-size- and heap-aware capacity), and `/feedback` + `/help` as platform-baseline slash commands in every mode and both tiers (UX-15). Merged 2026-07-26 as PR #277 (`cc53e442`). Force-push is barred on this branch, so the rebase landed as a merge commit; `main` moved three times mid-flight and the UX registry collided twice (the slash rule went 13 → 14 → 15). 2835/2835 tests, typecheck clean. **Deploy verified live; the swarm memory fix is NOT confirmed on-device** — see `docs/MAINTENANCE-OWNERS.md`. |
| `claude/post-merge-registry-oqpv0t` | `808b75c0` | **Merged** | Registry discipline for PR #277: the swarm-memory/crash-capture owner row in `docs/MAINTENANCE-OWNERS.md` and the `parallel-subagent-feedback-oqpv0t` ledger row above. Merged 2026-07-26 as PR #282 (`591017fd`), first of the eight-PR queue below. |
| `claude/admin-usage-numbers-1ijnfy` | `380fe5e1` | **Merged** | Berget changed its catalog price unit to EUR-per-**million** tokens on 2026-07-17 and `berget.js` kept reading it as per-token, so every Berget cost — and the `berget_cost` column `quotaExceeded()` enforces — has been 1e6× too high since. Normalized at the wire with a unit tag *and* a magnitude bound. Merged 2026-07-26 as PR #283 (`5d30caf8`). **The already-written rows are not rewritten** — affected users stay quota-blocked until the owner picks one of the three routes in the PR body. |
| `claude/fix-index-conflict-markers` | `8be69ab1` | **Merged** | `main` was serving unresolved conflict markers: PR #278's merge (`17c70c16`) committed a `<<<<<<< HEAD` hunk into `public/index.html`, so the landing page rendered the markers as literal text and declared **two** `id="chat"` elements. Both sides were wanted, so the resolution keeps the outrospection `empty-default`/`empty-outro` span pair and carries main's slash-command hint as the default copy. `scripts/merge-markers.test.mjs` now fails the build on any tracked conflict marker or a duplicate `#chat`. Merged 2026-07-26 as PR #286 (`0e9c3255`). |
| `claude/web-search-settings-refactor-mq44iz` | `04e813a7` | **Merged** | The Exa-or-our-Worker choice moved off the web knob's long-press card into a plain settings knob (UX-10 records the reversal); the knob answers on/off again. Merged 2026-07-26 as PR #279 (`4788f498`). `app.css` conflicted where main added the `.slash-menu` typeahead rules in the region this branch deletes `.srcpick` from — kept main's block, completed the removal. |
| `claude/agent-starter-prompt-eval-rzlu9k` | `b2e143eb` | **Merged** | 159 synthetic starter prompts across 7 agents, the exploit/explore queue behind the four chips, the scoring harness + append-only findings ledger, and the browser-local evaluation-mode knob. Merged 2026-07-26 as PR #280 (`2fe22f5c`). Three conflicts, all two independent additions in one region (mode-change handler, settings wiring, CSS) — every one resolved by keeping BOTH sides, none by picking one. |
| `claude/agent-sdk-foundation-mawlmf` | `6f854334` | **Merged** | Stages 5–7 of `docs/DEFAULT-AGENTS-GENERALIZATION.md`: the capability block becomes executed rather than merely declared (each accessor treats the platform limit as default *and* ceiling), an agent becomes addressable by id, and `resolveUntrustedAgent` fails closed with requirements derived from the selection instead of self-declared. Merged 2026-07-26 as PR #284 (`2c60b4b2`). Touches `pipeline.js` + `orchestrator.js`, so **the scored bench gate is still pending a deploy**. |
| `claude/feature-focus-timeline-text-ymhmui` | `7e23792d` | **Merged** | `/pulse/timeline.html` end-labels every shown curve (two-pass de-collision) instead of only the four heaviest; dataset refreshed to 996 commits with orchestrator/outrospection/feedback subjects added — additions only, so saved curve selections survive. Merged 2026-07-26 as PR #285 (`b96beb57`). |
| `claude/ledger-merge-queue-2026-07-26` | `0146a643` | **Merged** | Ledgered the 2026-07-26 merge queue and fixed `scripts/check-merged-branches.mjs`, which could not parse §1 at all — it required the sha cell bare and the verdict unbolded, so the section its own precedence rule names as the winner read as nothing. The guard had been reporting clean over 68 branches (§2/§3 only); it now covers 85 and found two long-invisible rule-breaks. Parse pinned by `scripts/check-merged-branches.test.mjs`. Merged 2026-07-26 as PR #289 (`a0eedb40`). |
| `claude/fix-snapshot-staleness` | `07a893b6` | **Merged** | `main` failed its own snapshot freshness check: `bundle-source.mjs` enumerates via `git ls-files`, and PR #289 regenerated its artifacts before the commit that added the new test file, so the snapshot landed one file short (729 vs 730). Regeneration only, no source change. **Rule this produced: stage before you bundle.** Merged 2026-07-26 as PR #290 (`b21878ab`). |
| `claude/shared-compute-owner-ledger-33vgh9` | `dcb9edf7` | **Merged** | Registered PR #287 as the shared-compute maintenance owner. `main` had already recorded the branch (PR #289), so the ledger briefly carried two rows for it with different shas — consolidated to one keeping the fuller prose and the tip that actually merged. That mattered: `parseLedger` keeps the FIRST row per branch, so the stale pre-merge sha would have won and the guard would have reported a false violation. Merged 2026-07-26 as PR #288 (`04db4850`). |
| `claude/fix-story-loading-stall` | `29e43960` | **Merged** | `/story/` stalled on "Loading…" forever: the container had lost its `id="history"`, so `getElementById` returned null, the render threw, and the catch handler threw again on the same null — no error ever reached the screen. `src/static-pages.test.js` now checks, for every tracked `public/**/*.html`, that each id an inline script reaches for is declared in that same file. Nothing had tested the static pages before, which is why the suite stayed green. Merged 2026-07-26 as PR #291 (`027a7dec`). |
| `claude/mcp-feedback-update-nlm7r1` | `9eb601f5` | **Merged** | Feedback #33 opened as F-19: track MCP's stateless protocol revision. The feedback's substance checked out against the published changelog but its RC date did not, and two things it missed are recorded on the item — `PROTOCOL_VERSION` is two revisions behind, not one, and the revision's twelve-month deprecation window means serving both revisions rather than deleting `initialize`. Also fixed stale **mcp-server** skill prose (five tools now, not one). `src/mcp.js` untouched. Merged 2026-07-26 as PR #292 (`87e0ffa9`). |
| `claude/landing-page-feedback-992j54` | `a1a3607f` | **Merged** | Feedback #32: the first-visit overlay now names the site before contrasting it (it opened on "what this does — and doesn't" over a page the visitor had not read), and a compact feature-focus timeline sits under the promo video. The timeline maths moved into the pure core `public/js/pulse-timeline-core.js` so the landing and `/pulse/timeline.html` cannot disagree about what a curve means; its `src/assets.js` allowlist entry is load-bearing — without it the rewired page 401s for signed-out visitors. Merged 2026-07-26 as PR #293 (`e5290358`). |
| `claude/ledger-merge-queue-2` | `c76e9ea9` | **Merged** | Ledgered the second 2026-07-26 queue (PRs #291–#293) plus the three bookkeeping branches from the first that had never been recorded — each WAS the bookkeeping, and landed after the row it would have appeared in, so the guard was not watching them. Coverage 85 → 91. Merged 2026-07-26 as PR #294 (`c9631b34`). |
| `claude/huggingface-agent-model-select-7e4dxl` | `fa0614a3` | **Merged** | The **Models agent** (amber, sixth mode) and the provider-agnostic model lifecycle it owns: `model-catalog.js` (discovered / available / enabled, naming no provider), `model-checks.js` (nine verification checks, each citing the eval round that found the failure mode), `models-api.js`, and the board as the mode's left sidebar. Verification is deliberately ORTHOGONAL to the lifecycle — a model failing checks stays selectable, because the checks report what is known, not what is permitted. Hugging Face demoted to one provider under it. Merged 2026-07-26 as PR #295 (`d7d95f11`). Touches `src/pipeline.js` — **bench gate pending a deploy**. |
| `claude/local-execution-environments-6jyem7` | `0ad95c30` | **Merged** | **DREE/1** — execution gets the spread the model choice already had: point either tier at a local runner on your own machine instead of the in-browser VM. Two endpoints, a dependency-free reference runner, `/cure/local-exec`, and the `selectRunner` seam whose load-bearing property is that it returns the browser bridge UNCHANGED for absent config, an unknown id, or a `local` pick with no URL (pinned by tests) — that is what keeps it from regressing the sandbox for people who never open the setting. No new privacy exception: both environments are browser-direct. Merged 2026-07-26 as PR #296 (`75d59ce1`). **The container backends were never executed** — no runtime in the build environment; see `docs/EXECUTION-ENVIRONMENTS.md` §8. |
| `claude/orchestrator-node-inspection-qjp2da` | `b4b02a5a` | **Merged** | Feedback #35: every node in the Orchestrator workflow graph became a button opening a LIVE inspector — task, persona, searches as they land, upstream/downstream links, and the prompt the node is working on, repainted while the answer streams. Fed by three additive SSE fields and no new event type, with only the prompt HEAD travelling (1500 chars) and the true length alongside. Merged 2026-07-26 as PR #297 (`fdbbc19c`). Its `stream.js` import block collided with #295's and #298's on the same lines — all three kept. |
| `claude/introspection-visualization-feedback-bj3plv` | `dd5ff53c` | **Merged** | Feedback #34: introspection's left drawer gained a live PIPELINE MAP of the site's own request path — idle / active / passed nodes, loops counting their rounds. The rule it rests on is that **a node lights only on a signal that the step actually ran**, never on an inference from the answer text; holding to that is why the server changed too (the finished `plan` step now carries a machine-readable `route`, and `maybeDigest` emits a `digest` step it previously ran silently). Geometry measured in a headless browser against the real stylesheet, which caught four defects and a double-counting bug. Merged 2026-07-26 as PR #298 (`48bdde65`). Touches `src/pipeline.js` — **bench gate pending a deploy**. |
| `claude/docs-overview-hub-restructure` | `6165d49d` | **Merged** | `/help/` became an overview leading with why the project exists, instead of opening into a third copy of the Se/cure-vs-Se/rver comparison grid (one copy per audience now: `/architecture/` for design, `/cure/help/` for deciding). Also moved the comment-mode chrome off the page header — measured via CDP at 390/820/1280, where it had been painting over the back link — and added `scripts/embed-truncate.mjs` for the RAG bundlers' surrogate bug. Merged 2026-07-26 as PR #299 (`1fa9ee83`). |
| `claude/arxiv-rag-search-db-0bh4gv` | `d56e325e` | **Merged** | A retrieval database over a year of arXiv (326,814 papers indexed, ~€3 to embed), with every pipeline decision traced to a measurement — including one that retired a mechanism before it was built (BM25 only *looks* like it beats dense; the needle queries inherit 0.68 of their vocabulary from the abstracts they were written from). Merged 2026-07-26 as PR #300 (`0cbe3f5f`), then **the same branch was reused** for PR #302 (`1d2e6c16`), which corrected #300's own claim that a whole-corpus build needs AWS — arXiv's HTML rendering gives 100% coverage with LaTeX fallback at 7× less transfer. Reusing a merged branch is the rule-break this ledger exists to catch; recorded here at the tip after both, and follow-ups belong on a FRESH branch. |
| `claude/groq-anthropic-provider-swap-my4o4o` | `b0301918` | **Merged** | Se/cure's data path gained Anthropic browser-direct — a real code change, not a diagram edit: CORS was never the blocker (`api.anthropic.com` serves `*` behind the dangerous-direct-browser-access opt-in), the Messages API simply is not OpenAI chat completions, so `drc-providers.js` now carries the browser mirror of `src/anthropic.js` and adapts AT THE WIRE rather than forking the pipeline. Also labels the always-present custom OpenAI-compatible endpoint as the strongest privacy mode. Merged 2026-07-26 as PR #301 (`8e0ecf76`). Touches `src/prompts.js` — **bench gate pending a deploy**. |
| `claude/ledger-merge-queue-3` | `15343d8e` | **Merged** | Ledgered the third 2026-07-26 queue (PRs #294–#302), taking guard coverage 91 → 99, and recorded the `arxiv-rag-search-db-0bh4gv` branch reuse as a rule-break rather than quietly re-tagging it. Merged 2026-07-26 as PR #303 (`04aaf488`). **Missing its own row until the fourth queue** — the third consecutive time a ledger branch went unrecorded, because the branch lands *after* the row it would have appeared in. That is structural, not an oversight: a ledger PR can never contain its own tip. The fix is for the NEXT pass to open by ledgering the previous ledger branch, which is how this row exists. |
| `claude/merge-refactor-deep-tg2j8c` | `ccd46008` | **Merged** | Refactor-clarity pass 11 over PRs #291–#303: `recordDefaultModelUsage` shared into `quota.js` (byte-identical in `orchestrator-api.js` and `quiz-api.js`), and the three side endpoints' admission preamble extracted into a new leaf `endpoint-gate.js` — drift control on a cost-control invariant, since a change to who bypasses the quota gate applied to one copy left the other two silently unenforced. Both cuts made previously-private logic testable (9 new tests). Merged 2026-07-26 as PR #304 (`0cc112bf`); verified locally at 3303/3303 tests and typecheck clean on both tsconfigs before merge. **Two questions left open for the owner, not decided under a refactor:** the gate's asymmetric fail-soft story (an absent database admits, a throwing one propagates) is pinned by a test asserting the real behaviour, and `bash-api.js` keeps a third spend-recorder copy because its catalog lookup goes through `providers.js` rather than `berget.js` — folding it in is a behaviour-equivalence argument. Both flagged in `STANDING-DECLINES.md`. |
| `claude/models-bonsai-hf-search-5tb578` | `a76421c3` | **Merged** | Feedback #36: Bonsai 27B is grayed out in the on-device rows, since its ONNX conversion is unpublished upstream and the only outcome of tapping Download… was a failure message. The declaration is a starting point rather than a verdict — a publish probe (a plain tree request, no engine worker, no weights) lifts the gray-out on its own, so the entry lights up the day the conversion ships, and a probe that cannot reach the hub returns `null` and changes nothing: an offline phone must not "discover" that a model shipped. Also fixes the mode built around the model hub answering model questions having asked the hub nothing — `state.forceAux` was honoured only inside a search wave, and developer mode never reaches one (`chat_logs` #670 and #671 both recorded `0s/0src`). Merged 2026-07-26 as PR #305 (`d30d0483`). Touches `src/pipeline.js` + `src/prompts.js` — **bench gate pending a deploy**. Two things unverified live: the grayed-out row needs a real browser with the on-device knob on, and the hub-search fix needs a Models + developer-mode turn showing a non-zero source count. |
| `claude/ephemeral-vms-firecracker-sbnghm` | `05de09cf` | **Merged** | A third place to run commands beside the browser CheerpX VM and the DREE/1 local runner: one ephemeral Cloudflare Container per conversation, speaking the SAME DREE/1 wire at `/api/exec`, so `bash-core.js`, the transcript renderer and the deliverables export are all indifferent to which machine ran a command. Remote environments gain the file mounts that were the browser VM's alone. Se/rver only by construction, because this is the first execution environment putting the server in the data path — refused twice in code for Se/cure (`selectRunner` requires an explicit server tier and defaults to the browser VM for a caller that says nothing; `/api/exec` sits behind the identity gate Se/cure never passes), leaving Se/cure's count of deliberate server-touching exceptions unchanged at two. Ships switched OFF — the `wrangler.toml` container block is commented out, since a binding whose resource does not exist fails every deploy. Merged 2026-07-26 as PR #306 (`8f0a0459`) after a `main` merge for the four artifact conflicts PR #305 created; combined 3352/3352 tests, typecheck clean. **Nothing has run in a real container** — no binding and no Docker daemon in the build environment; `docs/EXECUTION-ENVIRONMENTS.md` §10 lists what live verification owes, including per-session cost, which is unmeasured. |
| `claude/arxiv-search-integration-9w2we0` | `f1478270` | **Review** — LIVE BRANCH, do not tag | arXiv as a pipeline search source: `src/arxiv.js` plus a descriptor in `SEARCH_SOURCES`, a peer of the Hugging Face source using the registry seam already there — no new architectural seam, and the `extensions.js` core-purity guard (invariant 7) passes. Its per-request budget is deliberately below `hf`'s 3, because arXiv publishes a rate limit of one request per three seconds on a single connection and sells no way past it. **Found by branch survey, not by the PR queue** — the branch was never submitted as a PR, so five commits of finished work sat outside a merge loop that only reads open PRs. Content-checked before integrating (`src/arxiv.js` absent from `main`, `search-sources.js` never mentioning arXiv), then merged 2026-07-26 as a direct branch merge; only the two introspection artifacts conflicted. 3416/3416 tests, typecheck clean. **Unverified: no live arXiv probe and no bench A/B.** The **add-research-source** validation ladder ends in both and neither can run from a container, so the source's real-world hit rate, latency and rate-limit behaviour are untested — the first live deploy is the first real exercise. **Verdict corrected from Merged to Review the same day, and the correction is the point:** the branch was never submitted as a PR because it was still being WORKED ON. Tagging it Merged made the guard report its author as having broken the don't-build-on-a-merged-branch rule, when the rule-break was the tag — mine — not their commits. Since the merge they have pushed `fe2391f8` "Serve arXiv from a hosted Vectorize index, not the rate-limited API", which REPLACES the API-polling approach `main` now carries, plus a measurement record and an append-only checkpoint. So `main`'s copy is a superseded first draft rather than the finished source. Left in place because it is green, self-contained and fails soft, and because the replacement declares a `[[vectorize]]` binding whose resource must exist before it can deploy at all. **The lesson: an absent PR is a signal, not an oversight** — the PR queue being empty does not mean the branch survey's candidates are ready to land, and a branch with recent commits and no PR should be assumed in flight. |
| `claude/outrospect-feed-as-session-history` | `816d0b03` | **Superseded** | Outrospection's feed as session history. Content-checked 2026-07-26 by the strongest form the skill allows: `git log origin/main..<branch>` returns nothing and `git diff origin/main...<branch>` returns no files, so the branch is an ancestor of `main` with no delta of any kind. Never carried a row — found by the same branch survey that turned up the arXiv source, which is what a sweep is for. Recorded so the guard watches it. |

> **Not every merged branch belongs in this table.** A session's *rolling*
> branch — one reset to `origin/main` with `checkout -B` each round and reused
> to carry successive ledger/merge commits (e.g. `claude/merge-jhqgux`) — is
> deliberately **not** recorded. The guard flags any recorded tip that moves,
> advanced or rewritten alike, so tagging a branch whose whole purpose is to be
> reset would report a violation every round and train readers to ignore the
> banner. Record one-shot feature and ledger branches; leave the rolling
> vehicle out. This is an exemption from the tagging rule, not from the rule
> against building on a branch whose *content* has landed.

### 1a. Live branches — do NOT tag, do NOT merge

Branches with recent commits and **no open PR**. The absent PR is a signal
that the work is still in progress, not an oversight for a merge loop to
correct. Confirmed the hard way on 2026-07-26: `arxiv-search-integration`
was merged from a branch survey, and its author pushed a replacement
approach hours later — see its row above.

Verdict stays **Review** so `check-merged-branches.mjs` does not watch them;
tagging a live branch makes the guard blame its author for the tag.

| Branch | tip seen | Unmerged work | Why it is not being landed |
|---|---|---|---|
| `claude/arxiv-search-integration-9w2we0` | `8ce870e3` | Serves arXiv from a hosted Vectorize index instead of polling the rate-limited API, replacing the draft in `main`; plus a cosine-vs-rerank measurement and an append-only checkpoint | Actively being committed to — the tip moved three times within minutes on 2026-07-26. Its `[[vectorize]]` binding also needs the index to exist before it can deploy at all. Owner decision 2026-07-26: leave `main`'s draft in place and let the author land the replacement. |
| `claude/outrospection-agent-feedback-s14uzy` (= `claude/outrospection-feedback-parallel-subtasks`, same tip) | `7c0103ab` | "Bind a system prompt to every agent" — ~1000 new lines across `agent-spec-core.js`, `outrospect.js`, `outrospect-core.js`, `prompt-sets.js`, `sdk/AGENTS.json`. The sibling "quote the articles" work is already in `main`. | No PR, and its base is PR #273, so integrating needs 10 hand-resolved semantic conflicts in a subsystem `main` has changed since. Owner decision 2026-07-26: leave it for its author to submit. |

## 2. Reconciliation pass 2026-07-13 (mass merge)

Integrated into `main` this pass (both verified, tests green):

- ✅ `claude/refactor-skill-repo-kb1c7k` → **Merged** — `src/billing.js`
  (shared split-billing math) extracted from `chat.js`/`mcp.js`. 70/70 tests.
- ✅ `claude/glass-pane-close-icon-v451n4` → **Merged** — directional close
  chevrons instead of ✕ on glass panes.

Turned out already in `main` (Superseded) once content-checked:

- `claude/forbux-onboarding-flow-dsd61y` — net drc.js diff was empty.

Also merged this pass (2026-07-13, follow-up):

- ✅ `claude/security-assessment-owasp-setup-3hznsj` → **Merged** — OWASP
  Top-10 corpus + offline retrieval (~1100 lines / 17 files). The branch had
  already merged recent `main`, so a 3-way `git merge` applied cleanly except
  the two generated introspection artifacts (regenerated: `source-snapshot`
  via `npm run bundle`, `source-rag` via `bundle:rag`). Its committed
  `owasp-corpus.json` / `owasp-rag.json` came in as-is. 1222/1222 tests pass,
  typecheck clean.

Still to inspect (Review rows, ahead ≤ 5): several are already superseded
(e.g. `commit-analytics-dashboard`, `admin-feature-selection-board` — panel/
board work is in `main`); vet with the skill before any further PR.

## 3. Full inventory (76 branches, 2026-07-13)

`ahead` = commits on the branch not reachable from `main` (large numbers are
old squashed history, NOT unmerged content). Verdicts marked `?` are the
heuristic; the skill's content check confirms.

| Branch | tip | ahead | Verdict | Subject |
|---|---|---|---|---|
| `claude/admin-feature-selection-board-9zva2a` | 9084844 | 1 | Superseded | Panel-selection board (attention loop) — `src/panels.js` + `panels_reviews` + `scripts/panels` all in main (verified 2026-07-13) |
| `claude/anon-chat-copy-ui-rk0k0j` | 7a30685 | 226 | Superseded? | Header: ghost moves beside the account button copy-conv |
| `claude/anthropic-llm-provider-3ojvsm` | 5f07008 | 284 | Superseded? | eval: Round 10 ledger first Anthropic battery (opus/son |
| `claude/anthropic-llm-provider-d3iapt` | 24579aa | 284 | Superseded? | Add the model-tuning skill: per-use-case adaptation play |
| `claude/berget-ai-provider-ld51ut` | 67f5a06 | 26 | Superseded? | fix(ui): sandbox setting row leaked markup fragments |
| `claude/chat-history-pane-ui-c13rx1` | 3af91d4 | 257 | Superseded? | ui-notes skill: history-pane swipe cards, iOS rest-state |
| `claude/chat-logging-retention-ifwmk3` | 0110229 | 235 | Superseded? | Chat logging: full QA interaction log on the server |
| `claude/chat-message-understanding-tv1h8f` | 2e63e85 | 332 | Superseded? | Skill ledger: the go-on-to / street-view gate misses |
| `claude/chat-pane-close-button-feqm5j` | 6d45fbc | 270 | Superseded? | Change chat history pane close button |
| `claude/client-projects-encrypted-storage-5emv7u` | 80d8f01 | 17 | Superseded? | docs: cache-helper skill every cache layer + Dev Mode |
| `claude/commit-analytics-dashboard-hcyz3o` | b9ee3d7 | 2 | Review | merge: reconcile designated branch with rebased work |
| `claude/conversation-storage-settings-gt7yut` | f14eafc | 135 | Superseded? | Project panel: icon controls, double-tap rename |
| `claude/deep-refactor-clarity-obx2ja` | 288877b | 147 | Superseded? | Copy research JSON: capture full generation + errors |
| `claude/deep-research-architecture-eval-h8p4nx` | 3c00561 | 193 | Superseded? | hf-bench ledger: round 0 baseline |
| `claude/deepresearch-capabilities-docs-tue2w5` | e5aa9c6 | 165 | Superseded? | Render tables from models that collapse markdown |
| `claude/deepresearch-nemo-port-yrzphd` | 790d277 | 331 | Superseded? | Add NeMo port feasibility analysis |
| `claude/deepresearch-security-assessment-ictxb8` | 6a3b0ba | 243 | Superseded? | Add comprehensive security assessment |
| `claude/deepresearch-source-file-tools-930lo4` | fe3216a | 1 | Review | Introspection: research own source with agentic tools |
| `claude/dev-mode-titanium-gray-8gf3oi` | 8505e22 | 3 | Review | Developer mode: re-tint iOS status bar to titanium |
| `claude/docs-alignment-clarity-95zeo7` | 0fb52c8 | 1 | Review | docs: align documentation with the code |
| `claude/docs-sbom-data-retention-9hzqj4` | 4bed9d2 | 57 | Superseded? | Add SBOM and document zero-data-retention rationale |
| `claude/drs-onboarding-animations-47jrel` | c8e7f1e | 62 | Superseded? | Landing mascot: tap speech bubble dismisses it |
| `claude/feedback-mode-account-view-1vbke8` | 496ce61 | 282 | Superseded? | Feedback mode: per-reply feedback dialogue |
| `claude/firefox-focus-auth-redirect-u52ljv` | f0304de | 1 | Superseded | auth: force https in canonical redirect (Firefox Focus) |
| `claude/first-login-data-scroll-hpeh3x` | 38ba773 | 153 | Superseded? | Make first-visit privacy notice scrollable |
| `claude/forbux-onboarding-flow-dsd61y` | 1460d68 | 1 | Superseded | DRC onboarding: land users in chat input (already in main) |
| `claude/ghost-symbol-anonymous-chat-jbmgj2` | 5a4e50d | 166 | Superseded? | Ghost gives way to copy-conversation button |
| `claude/ghost-symbol-incognito-rl705o` | 4f603fe | 148 | Superseded? | Add incognito ghost toggle |
| `claude/glass-pane-close-icon-v451n4` | 189db14 | 1 | Merged | Directional close chevrons (integrated 2026-07-13) |
| `claude/hello-world-deploy-rubr64` | 54a66b0 | 3 | Dropped | "push straight to main" workflow — reversed to PRs 2026-07-13 |
| `claude/inline-quiz-alternatives-80dnm0` | 69ec9f0 | 241 | Superseded? | Add inline quiz capability |
| `claude/introspection-feature-arch-75zjlo` | 0447e9c | 69 | Superseded? | Introspection RAG: delta index builder |
| `claude/linux-distro-optimization-wzleyz` | ddd4bdb | 70 | Superseded? | Architecture page: render tier tokens |
| `claude/linux-vm-perf-research-1scbmz` | fd9b094 | 54 | Superseded? | chore: LOG_LEVEL=debug in prod for sandbox-fs |
| `claude/main-view-ui-scrolling-ufhq5n` | 65d80be | 197 | Superseded? | UI fixes: pencil New-chat icon, footer clearance |
| `claude/maps-api-capabilities-test-ur3fap` | 3c99b5c | 150 | Superseded? | Add Hugging Face Hub enrichment |
| `claude/maps-integration-coverage-dmxu8k` | e1a23a9 | 148 | Superseded? | Maps integration: test matrix, unit + e2e |
| `claude/model-provider-openai-refactor-nxnhx3` | ba2740b | 330 | Superseded? | Frames strip reads chronologically |
| `claude/open-source-repo-authenticity-jf3nip` | b79a278 | 3 | Review | feat(transparency): verifiable "site serves the repo" |
| `claude/rag-index-introspection-o8irl6` | a32c8dd | 78 | Superseded? | Introspection mode: answer from own source |
| `claude/rag-index-project-chats-rxfwwg` | 41562c4 | 152 | Superseded? | RAG-index project chats for cross-chat retrieval |
| `claude/reep-refactoring-tlfs0d` | 84713e0 | 179 | Superseded? | Refactor for modularity: split source registry |
| `claude/refactor-clarity-modularity-1gfa5i` | 6d1e0a7 | 237 | Superseded? | Refactor for clarity: edge-cache, googlemaps split |
| `claude/refactor-document-codebase-031nun` | f1f0c40 | 2 | Review | docs: align module tables and skills |
| `claude/refactor-skill-repo-kb1c7k` | f9ee2ab | 1 | Merged | extract split-billing math (billing.js) (integrated 2026-07-13) |
| `claude/remove-offline-privacy-4fngy5` | c46ea82 | 55 | Superseded? | Remove DRS projects + secret-keyed vault |
| `claude/repo-setup-6x6tl1` | bf70932 | 19 | Superseded? | bash-lite: let the model decide when to use the shell |
| `claude/research-agent-architecture-ka88w7` | 852dbe7 | 190 | Superseded? | Disable net-negative deep-tier phases |
| `claude/rosa-pantern-street-view-w4rfc8` | 7938671 | 285 | Superseded? | Street view for visual questions about a NAMED place |
| `claude/sandbox-execution-refactor-vjz405` | f70a696 | 43 | Superseded? | docs(skills): anonymous-verification lesson |
| `claude/sandbox-mcp-bash-integration-ta48xb` | 0e0c073 | 35 | Superseded? | Merge origin/main into sandbox-mcp-bash |
| `claude/sandbox-terminal-visibility-bvtt78` | b4f801a | 2 | Review | Sandbox: on-screen transparency bar |
| `claude/secure-client-api-analysis-0twcps` | 0198c57 | 18 | Superseded? | feat(drc): client-side RAG for conversations/projects |
| `claude/secure-providers-depth-ui-vtrlb0` | c10067d | 79 | Superseded? | Merge origin/main (DRC providers UI) |
| `claude/security-assessment-owasp-setup-3hznsj` | bef0451 | 4 | Merged | OWASP corpus + offline retrieval (integrated 2026-07-13) |
| `claude/segelflygcertifikat-chat-failure-d9v3cd` | db29e9c | 240 | Superseded? | pipeline: fail over to reliable model |
| `claude/segelflyghandboken-chapter-8zznku` | 7d49feb | 271 | Superseded? | Quiz prompt: test contained knowledge |
| `claude/sensitive-info-audit-lc44ed` | d862bc9 | 120 | Superseded? | History sidebar: list icon, tweaks |
| `claude/sentor-se-osint-improve-caaxy1` | 040ea46 | 153 | Superseded? | Docs: Workers Paid upgrade + Exa incident |
| `claude/server-secure-storage-clarity-x677jc` | 5c1da8c | 3 | Dropped | remove storage knobs — conflicts with invariant 4 |
| `claude/session-cookie-hmac-security-3awqvf` | b7f1372 | 149 | Superseded? | Trim SESSION_SECRET docs/comments |
| `claude/session-gzz9r7` | 643b584 | 81 | Superseded? | E2E attachment suite over break-glass |
| `claude/shodan-mcp-integration-cnkmcv` | 529de91 | 143 | Superseded? | Add Shodan host-intelligence integration |
| `claude/source-code-security-risks-h1i7ds` | 32b1a57 | 56 | Superseded? | feat(admin): security-risk review board |
| `claude/spiderweb-knob-layout-8p92v5` | 64582a1 | 171 | Superseded? | New-chat speech-bubble-plus icon in header |
| `claude/spiderweb-knob-ui-m7irua` | 12bff99 | 126 | Superseded? | Unify composer circles at 34px |
| `claude/street-view-api-access-fetchw` | 61451d2 | 168 | Superseded? | Add Google Maps enrichment (Places + Street View) |
| `claude/street-view-basaltvagen-issue-sff8sb` | ba9c299 | 275 | Superseded? | integrations skill: Street View radius/no-coverage |
| `claude/street-view-multilingual-maps-ojbxl8` | 74f0562 | 273 | Superseded? | Street view: "And now" continuations fire POV capture |
| `claude/street-view-photos-9k7pn3` | e677d1d | 147 | Superseded? | Live-verified Google Maps tier: per-model image caps |
| `claude/tokemon-game-subsystem-30a8r7` | 4f677fc | 286 | Superseded | Games subsystem + Tokemon (in main) |
| `claude/tool-calling-visibility-wlroih` | 5e914ca | 1 | Superseded | chatlog records shell tool calls (in main) |
| `claude/top-security-issues-5ow76w` | 1c2e16e | 74 | Superseded? | boards: unified discovery index |
| `claude/whitespace-slash-animation-juizwv` | 404e73a | 1 | Superseded | CamelCase tier wordmarks (in main) |
| `cloudflare/workers-autoconfig` | ada19ae | 5 | Review | Add Cloudflare Workers configuration |
| `golden-saturday` | 860fe8b | 25 | Superseded? | Full-width answers, markdown default, Raw/Copy |

---

## Rule-break detection

The rule: **a branch marked Merged / Superseded / Dropped above is done — no
new commits, no new PRs from it.** To catch a violation (an agent that kept
building on a dead branch):

```bash
node scripts/check-merged-branches.mjs   # reads the tables above, fetches, compares tips
```

It flags any listed branch whose current remote tip has advanced past the
recorded `tip@merge`/`tip` SHA, and prints a `NOTIFY OWNER` banner. Run it at
session start (the sync-main hook can call it) and whenever you touch branches.
If it fires, tell the owner (krister.hedfors@gmail.com) which branch moved and
who/what pushed to it — do not silently re-tag.

## When you integrate a branch (update this file in the SAME commit)

1. Open the PR, get it merged to `main`.
2. Flip the branch's row to **Merged**, set `tip@merge` to the branch tip you
   merged, add it to §1.
3. Optionally `git tag merged/<branch> <sha> && git push origin merged/<branch>`.
4. Commit the ledger change with the integration (or right after the merge).
