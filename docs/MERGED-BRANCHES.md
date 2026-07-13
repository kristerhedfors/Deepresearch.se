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
| `claude/server-secure-storage-clarity-x677jc` | `5c1da8c` | Dropped | "always store in cloud, remove the storage knobs" conflicts with `main`, which deliberately keeps the `server_history` knob (invariant 4). |
| `claude/tokemon-game-subsystem-30a8r7` | `4f677fc` | Superseded | `src/tokemon.js` / `src/tokemon-api.js` present in `main`. |
| `claude/refactor-skill-repo-kb1c7k` | `f9ee2ab` | **Merged** | `src/billing.js` extraction integrated 2026-07-13 (tests 70/70). |
| `claude/glass-pane-close-icon-v451n4` | `189db14` | **Merged** | close chevrons integrated 2026-07-13. |
| `claude/security-assessment-owasp-setup-3hznsj` | `bef0451` | **Merged** | OWASP Top-10 corpus + offline retrieval integrated 2026-07-13 via 3-way merge (only source-snapshot/rag conflicted; 1222/1222 tests, typecheck clean). |
| `claude/forbux-onboarding-flow-dsd61y` | `1460d68` | Superseded | On cherry-pick the net drc.js diff vs `main` was **empty** — the land-in-chat onboarding is already in `main`. |
| `claude/admin-feature-selection-board-9zva2a` | `9084844` | Superseded | The whole selection-board / decision-board system is in `main`: `panels.js` (attention loop), `board.js`, `admin-boards.js`, `features.js`, `security-risks.js`, `panels_reviews`/`security_reviews`/`features_reviews`, `scripts/{boards,panels,features,security}`, the decision-boards + feature-board skills, `docs/DECISION-BOARD-LOOPS.md`. Branch is ~5200 lines behind main. |
| `claude/selection-boards-headers-v9xhgp` | `7c11c47` | Superseded | Landed in `main` earlier via PR #6 (collapse-to-headers + features board); not in the unmerged set. |
| `claude/victorian-umbrella-animation-vooqu6` | `6a10191` | **Merged** | DRC umbrella intro: Victorian umbrellas revive from wire into colour. Merged 2026-07-13; only source-snapshot/rag conflicted (regenerated). 1224/1224 tests. |

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
