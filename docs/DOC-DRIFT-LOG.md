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
