# Documentation drift log

Append-only ledger of **Class C** documentation drift — cases where the
code and a capability/architecture/privacy-posture claim in the canonical
docs disagreed, and the owner ruled which side was wrong. Maintained by the
**docs-drift-validation** skill; see it for the full workflow. Class M
(mechanical) drift is not logged here — it lands via **update-docs**.

Each entry records the finding, the owner's verdict, and how the checkmark
was given, so future validation runs can tell an owner-validated posture
change from an unexamined one. Only append, and only after the checkmark.

Entry format:

```
## YYYY-MM-DD — <one-line finding>
- **Doc claim:** <doc file> — "<quoted claim>"
- **Code:** <file:line summary> (introduced by <commit(s)>)
- **Verdict:** intended | regression — by owner via <PR #n merge / approving comment / AskUserQuestion>
- **Action:** <doc rewrite landed in …> | <code fix routed via …, doc unchanged>
```

---

## 2026-07-22 — ARCHITECTURE.md still claimed the removed SESSION_SECRET admin-credential fallback
- **Doc claim:** `docs/ARCHITECTURE.md` §3 — "the dedicated `SESSION_SECRET` (falls back to the admin-credential key when unset, verifying against both)"; §10 — "with a legacy fallback to the admin-credential key".
- **Code:** `src/auth.js:225-256` (`SESSION_SECRET` is the SOLE key; signing throws without it) + `src/index.js:171-179` (unset ⇒ 503 config-error page). The fallback was deliberately removed (auth.js self-documents why: a captured cookie was offline-brute-forceable against `ADMIN_PASS`). Independently confirmed by the PRIVACY-MODEL cross-check.
- **Verdict:** intended — the code is the correct, self-documented state (a security hardening); the doc lagged. Owner directive 2026-07-22 ("make the documentation reflect what is actually implemented") is the checkmark.
- **Action:** doc rewritten (§3 + §10) to state SESSION_SECRET is the sole key with no fallback and fail-closed behavior.

## 2026-07-22 — ARCHITECTURE.md framed `/mcp` as a single `deep_research` tool
- **Doc claim:** `docs/ARCHITECTURE.md` §7 — "**One tool**: `deep_research`".
- **Code:** `src/mcp.js` `toolsListResult()` returns `deep_research` + the four DistillSDK `sdk_*` tools (`SDK_MCP_TOOLS`). CLAUDE.md's DistillSDK section already ratifies "the `/mcp` `sdk_*` tools".
- **Verdict:** intended — SDK tools on `/mcp` are canon (CLAUDE.md). Owner directive 2026-07-22 is the checkmark.
- **Action:** §7 rewritten to list `deep_research` plus the four `sdk_*` tools.

## 2026-07-22 — ARCHITECTURE.md stated "no function calling" without the authorized exception
- **Doc claim:** `docs/ARCHITECTURE.md` §4.2 — "no function calling" presented as absolute.
- **Code:** `src/pipeline.js` `runSourceResearchTools`/`runSdkBuildTools` drive real native tool use on tool-capable answer models (introspection + SDK build), the exact carve-out CLAUDE.md invariant 1 authorizes.
- **Verdict:** intended — the exception is a load-bearing, owner-authorized invariant (CLAUDE.md). Owner directive 2026-07-22 is the checkmark.
- **Action:** §4.2 now documents the single authorized native-tool exception and its deterministic fallback; §14 (introspection) updated to describe the agentic read-loop rather than one-shot RAG injection.

## 2026-07-24 — CLAUDE.md invariant 4 stated the SERVER-TOKEN GUARANTEE as "never any Se/rver data"
- **Doc claim:** `CLAUDE.md` invariant 4 — "carries THE SERVER-TOKEN GUARANTEE: upstream APIs ONLY — never any Se/rver data — and NEVER a login". `docs/SERVER-TOKENS.md`'s guarantee block said the same, absolutely: "the token only opens doors that lead OUT of the site, never doors that lead into its storage."
- **Code:** `src/feedback.js:1047` `handleServerTokenFeedback`, routed at `src/index.js:390` — a live token CREATES one `feedback` row. Write-only: `GET /api/feedback` stays behind the identity gate. Already documented as intended in `docs/PRIVACY-MODEL.md` and `docs/CODE-LAYOUT.md`; only the always-loaded invariant and `SERVER-TOKENS.md` lagged.
- **Verdict:** intended — and reframed. Owner via in-session directive: *"lets focus on functionality and collaboration now assuming server is within trust boundary. So of course feedback, only secure needs those only pass through-guarantees. Other agents want to collaborate and orchestrate using various server side storage."*
- **Action:** the guarantee is now scoped to what it protects rather than stated as a blanket property. It is a rule about **Se/cure** — a borrowed credential must be pass-through only — not about the Se/rver tier, where the server is inside the trust boundary and agent collaboration/orchestration over server-side storage is the intended direction. Two properties kept verbatim and still test-pinned: a token READS nothing Se/rver stores, and is never a login. The Se/cure feedback write is named in both places. Landed in `CLAUDE.md` invariant 4, `docs/SERVER-TOKENS.md` (guarantee block + the closed-vocabulary point), `docs/PRIVACY-MODEL.md`.
- **Follow-up (not drift — new capability):** `SERVER_TOKEN_SERVICES` is a closed upstream-only vocabulary, so the collaboration surfaces cannot be built by adding a perm to this credential. They need Se/rver-side capabilities behind the identity gate, designed on their own terms.

## 2026-07-24 — ARCHITECTURE.md claimed to be the "complete technical architecture" while whole surfaces had no section
- **Doc claim:** `docs/ARCHITECTURE.md` opening — "Complete technical architecture of the site." Sections ran §1–§14 with nothing for Orchestrator mode, Agent Studio, on-device inference, compute sharing, workspace knowledge or the decision boards; 13 of 30 D1 tables and (before the same pass) 11 of 30 API route families went unnamed.
- **Code:** `src/orchestrator.js`, `public/js/ondevice-*.js`, `src/pool.js` + `src/pool-token.js`, `src/knowledge.js`, `src/quiz.js`, `src/board.js` + `src/admin-boards.js` — all shipped, none described.
- **Verdict:** intended, and reframed rather than expanded. Owner via in-session directive: *"Those are really examples and pre-bundled agents ideally built as much as possible on the platform and agents sdks."*
- **Action:** the doc no longer claims to cover the feature surfaces. Its opening now scopes it to the **platform** (Worker, pipeline, tiers, storage/identity/security), and a new §15 states the framing: the visible surfaces are examples and pre-bundled agents, to be carried by the Agents SDK (`sdk/AGENTS.json`) or the Platform SDK (`sdk/MANIFEST.json`) rather than built bespoke. §15 also records the honest split — which surfaces already have a Platform-SDK module (`execution-sandbox`, `introspection-help`, `decision-boards`, `publish-replays`, `games-shelf`, `mcp-surface`, `grant-bridge`, `symbol-language`, `pair-studio`, `agent-platform`) and which are still bespoke and owe one (Orchestrator, on-device inference, compute sharing, workspace knowledge, quiz). Mirrored as a directive in `CLAUDE.md`'s SDK section; `public/help/index.html` gained the chat-mode selector entry it had been missing, describing the three non-default modes as bundled examples.
