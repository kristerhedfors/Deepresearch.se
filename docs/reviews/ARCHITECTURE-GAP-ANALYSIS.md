# Architecture review — principles, adherence & gap analysis

*A structured review of the architectural principles this project actually
runs on, how faithfully the code lives up to each, and — for every gap —
whether closing it is worth the cost. Written 2026-07-23 against `main`.
Companions: `docs/ARCHITECTURE.md` (what the system **is**),
`docs/ARCHITECTURE-ROADMAP.md` (what it should **become**), and the living
risk register `SECURITY-RISKS.md` / `src/security-risks.js`.*

This document does three things the other two don't:

1. **Extracts** the principles as principles — including the ones that live
   only in code and were never written down as such (the serial-cascade
   shape, the pure-core/façade convention, docs-as-verifiable-truth).
2. **Rates** each on two axes — `Now` (how far the code has come toward the
   principle) and `Setpoint` (how far it is actually *worth* going, which is
   often **not** 100%). The interesting number is the distance between them,
   and its sign.
3. **Values** each gap: what moving toward (or deliberately away from) the
   principle buys, and roughly what it costs.

Ratings are grounded in a code-level audit (file:line evidence in the notes),
not in the docs' own claims — several places where the code is *more* honest
than the prose are called out.

---

## 0. Scorecard

`Now` = current adherence. `Setpoint` = the level worth reaching (100% is
frequently the wrong target). **Δ** = the gap worth acting on; a **negative**
Δ means the principle is *over*-applied and the value is in relaxing it.

### I. The research-pipeline engine

| # | Principle | Now | Setpoint | Δ | Headline gap |
|---|---|---|---|---|---|
| P1 | Deterministic orchestration — no model-driven control flow | 95% | ~90% | **−5** | The single biggest *upside* is a controlled step **away**: the bounded, self-liquidating model-tool fallback (roadmap §5.6) |
| P2 | Fail-soft degradation | 90% | 95% | +5 | Helper phases fail-soft; answer phases fail-**hard-but-contained** — correct, but the docs overclaim it as uniform |
| P3 | Split model routing (reliable JSON model / free-choice answer) | 98% | 100% | +2 | Essentially complete; enforced at one line (`jsonPhase`) |
| P4 | Determinism over parallelism (concurrency only where output-order-safe) | 100% | ~85% | **−15** | Over-applied for latency: sub-question fan-out at the top tier is the largest untapped lever |
| P5 | Budget determinism (plan is a ceiling; scale **down**, never up) | 95% | 90% | −5 | Depth is budget-driven; intent-driven depth (triage decides) is the pending rework |
| P6 | Model/provider agnosticism | 90% | 90% | 0 | Broad by construction; tool-use carve-outs legitimately need capable models |
| P7 | Evidence-driven tuning / benchmark-first | 85% | 95% | **+10** | The scored benchmark exists but isn't yet a *routine gate* — the highest quality lever in the repo |

### II. Privacy & trust

| # | Principle | Now | Setpoint | Δ | Headline gap |
|---|---|---|---|---|---|
| P8 | The two-tier privacy split (Se/cure never-cloud / Se/rver ciphertext) | 90% | 98% | **+8** | Ciphertext-at-rest for conversations is **client-enforced only** (P-6) — a policy, not yet a structure |
| P9 | Structural (provable), not policy-based, privacy | 80% | 90% | **+10** | CSP is authored but **OFF** (P-4); one DOMPurify bypass reaches the history key + project chats |
| P10 | Bounded, enumerated server exceptions + server-token guarantee | 95% | 95% | 0 | Test-pinned & module-graph enforced; "two exceptions" = two *exposure classes* but three credential families (doc precision) |
| P11 | Data minimization on outbound requests | 97% | 97% | 0 | Clean; one Maps nearby-search sends an intent phrase, not a bare coordinate |
| P12 | Fail-closed security | 95% | 98% | +3 | Auth/keys fail closed; the CSP-off case (P-4/P9) is the one fail-*open* corner |

### III. Codebase & method

| # | Principle | Now | Setpoint | Δ | Headline gap |
|---|---|---|---|---|---|
| P13 | Minimal dependencies / no build step | 90% | 95% | +5 | Zero runtime deps holds; 4 of 6 vendored libs lack the SHA-256 pin xterm/transformers have (L-12) |
| P14 | Swedish/English parity in **all** deterministic routing | 100% | 100% | 0 | Zero deviations across 12 gate families — the repo's cleanest discipline |
| P15 | Pure-core + façade / single source of truth | 90% | 90% | 0 | Widely applied; keep applying as new gated features land |
| P16 | Docs-as-verifiable-truth (committed artifacts, drift tests, self-documented risks) | 90% | 95% | +5 | Strong machinery; a few prose overclaims (P2, P10) to reconcile |

### IV. Platform & product direction

| # | Principle | Now | Setpoint | Δ | Headline gap |
|---|---|---|---|---|---|
| P17 | Zero-or-one-server property + the distillable pair abstraction | 85% | 85% | 0 | Property holds; DistillSDK only partly wired (SDK mode live, 33-module manifest mostly design) |
| P18 | Spec-leads-code interchange standards (DRSW / DRPL / stackless) | 40% | *choose* | — | **Deliberately** ahead of code; the open question is whether to fund a second node or park the bet |
| P19 | Hand-rolled durability over platform primitives (Workflows **not** adopted) | 100% | *conditional* | — | Correct today; the value of *reversing* it rises exactly with P4/P7 fan-out |
| P20 | MCP as a product surface, not internal plumbing | 95% | 95% | 0 | Shipped (`/mcp` + `sdk_*`); extension is more tools, not more architecture |

---

## I. The research-pipeline engine

### P1 — Deterministic orchestration, no model-driven control flow

**Now 95% · Setpoint ~90% (deliberately below 100%).**

Every planning phase funnels through one choke point, `jsonPhase`
(`src/pipeline.js:1501`), which calls `completeJson` with `{model, maxTokens}`
and **never** passes a `tools` argument. The model returns JSON *fields*
(`decision.action`, `gap.complete`, `verdict.verdict`); the Worker branches on
them. Control flow is never handed to the model on the hot path.

The one authorized exception is real and tightly gated: exactly two
server-side native tool loops (`runSourceResearchTools` `:636`,
`runSdkBuildTools` `:824`), both behind
`introspectionToolsAvailable = isAnthropicModel(model) && anthropicConfigured(env) && !imageParts.length`
(`:599`) *and* the developer/SDK knobs — with confirmed deterministic
fallbacks for every other model (the JSON read-loop `:978`; the `FILE:`-block
convention `:884`). A third tool loop (`run_bash`) exists only in the browser
on the user's own key, never server-side.

**Why the setpoint is below 100%.** The roadmap's §5.6 argues — correctly —
for a *bounded, self-liquidating* model-tool fallback: entered only when no
codified pipeline matches, on tool-capable models only, never touching the
JSON phases, and whose entire purpose is to breed new **deterministic**
pipelines (a recurring good tool-path gets promoted to a `SEARCH_SOURCES`
entry with EN+SV parity and a benchmark). The value is in the *misses* the
deterministic router currently drops to a generic web-search-then-synthesize.

**Value of the move:** medium-high, but strictly gated on P7. A fallback that
never graduates into a codified pipeline is just the function-calling agent
this project rejected — so the deliverable is the *codify* half, and it earns
its place only if a score proves it beats the generic path. **Do not build
before P7 can measure it.**

### P2 — Fail-soft degradation

**Now 90% · Setpoint 95%.**

Every *helper* phase genuinely fails soft: `jsonPhase` catches all and returns
`null` (`:1513`); enrichments are individually try/caught
(`src/enrichment.js:109`); the search layer never throws because `webSearch`
returns failure strings rather than raising (`src/exa.js:184`).

The honest nuance the prose glosses: the **answer-stream** phases are *not*
fail-soft — `streamCompletion` deliberately **throws** on a missing
`finish_reason` (`src/answer-stream.js:242`), deterministic 4xx (`:191`), and
context overflow (`:181`). Those throws propagate out of `runSynthesis`
(no local catch) and are caught one level up in `src/chat.js:363`, converted
to an emitted error event. This is the *correct* posture — an answer phase
that silently degrades to nothing is worse than an honest error with a
`(ref …)` and the one-shot model failover — but it means "every awaited call
degrades" is not literally true.

**Value of the move:** low on behavior (the design is right), medium on
**honesty** — reconcile the doc wording (feeds P16). The real fail-soft is:
*helpers degrade silently; the answer degrades to an honest, correlatable
error.*

### P3 — Split model routing

**Now 98% · Setpoint 100%.**

The three JSON phases (plus quiz, plus the introspection read-loop planner)
run on `ctx.jsonModel`, resolved once by `resolveJsonModel`
(`src/model-routing.js:18`) and hard-wired at `jsonPhase` (`:1506`). The only
paths that move a JSON phase onto the user's model are the *documented*
fail-soft escape (the fixed model is provably down/absent,
`model-routing.js:22`) and a defensive `|| model` fallback that both call
sites make unreachable. This is load-bearing, cheap, and essentially done.

**Value:** negligible to change. One forward idea worth noting: making the
fixed JSON model *self-hostable* would let a fully self-hosted fork keep the
split without depending on Berget — a P8/P9-adjacent hardening, not a P3 gap.

### P4 — Determinism over parallelism

**Now 100% (as designed) · Setpoint ~85% (the principle is *over*-applied).**

The macro-pipeline is a strictly serial cascade — enrichments → routing gates
→ triage → search → gap-loop → synthesis → validation (`:363`–`:398`), each a
bare `await` consuming the prior phase's mutations to shared `state`.
Concurrency appears in exactly two places, both output-order-safe: the search
wave (`Promise.all`, `:1555`, results reindexed to keep citation numbers
stable) and claim-level verification (`Promise.all`, `:1399`). Even the
auxiliary sources (HF Hub) run **serial-after-Exa** (`:1615`) purely to keep
registry numbering deterministic — the clearest case of wall-clock spent to
protect determinism.

The principle isn't "be serial" — it's "never let parallelism perturb the
answer." Read that way, the code is 100% faithful **and that is precisely the
opportunity**: the seriality is a latency floor. The roadmap's §5.5
(sub-question fan-out — bounded mini-pipelines per sub-question, concurrent,
merged for one synthesis) breaks the floor *without* breaking determinism, and
the paid-plan 300 s CPU ceiling leaves room.

**Value of the (deliberate) move away:** **high** at the top budget tiers —
this is the single largest latency+depth lever the pipeline has left. Costs:
cross-request source-numbering discipline, and it is the natural trigger to
adopt Cloudflare Workflows (P19). Gate behind P7; sequence last among the
pipeline moves because it multiplies cost.

### P5 — Budget determinism (the plan is a ceiling)

**Now 95% · Setpoint 90%.**

`src/budget.js` plans statically (validation reserved first, ~60% to initial
angles, remainder to gap rounds), keeps a per-model EWMA, and re-checks
`fitsDeadline` between phases, cutting optional work (extra gap rounds first,
validation last) under a budget+15% grace. Complexity only ever scales *down*
(`applyComplexityToPlan`) — the de-noised benchmark found over-researching
simple questions net-negative, and the three deep-tier phases
(notes/full-content/claim-level) are **off** behind
`DEEP_TIER_FEATURES_ENABLED = false` on that same evidence.

**Why below 100%:** depth is still *budget*-driven, not *intent*-driven. The
disabled deep-tier phases were shelved "pending an intent-gated (triage-
decided, not budget-decided) rework." The value isn't more adherence to the
budget-ceiling rule; it's letting triage — which already classifies
complexity — also decide *depth shape*, so a hard multi-hop question at a
modest budget can spend differently than an easy one at a large budget.

**Value:** medium, and it revives already-written (currently dark) code.

### P6 — Model/provider agnosticism

**Now 90% · Setpoint 90%.**

The provider registry (`src/providers.js`) dispatches by model-id namespace
and nothing downstream names a provider; the pipeline works across Berget's
whole catalog. The two frictions are inherent, not defects: the tool-use
carve-outs require a Claude-family model (P1), and synthesis quality varies by
model (mediated by evidence-driven `model-profiles.js`, P7). Leave it here.

### P7 — Evidence-driven tuning / benchmark-first

**Now 85% · Setpoint 95% — the highest-value single lever in this document.**

The discipline is real where it's applied: every `model-profiles.js` override
traces to a reproduced, ledgered finding (audited: zero evidence-free
overrides), and the deep-tier phases were built, measured, found
net-negative, and switched off — the benchmark-first loop working exactly as
intended. Three eval harnesses exist (`model-eval`, `eval-bench`, `hf-bench`)
with append-only ledgers.

**The gap:** the scored benchmark is not yet a *routine gate*. Pipeline
changes still mostly land on judgment, and the roadmap is blunt that §5.0 is
"the highest-leverage item" precisely because without a score "every pipeline
idea is a hypothesis and regressions are invisible." Everything else in
section I (P1's §5.6 fallback, P4's fan-out, P5's intent-depth) is explicitly
gated on this.

**Value of the move:** **highest.** Turning the benchmark into a
before/after gate that runs on pipeline PRs (LLM-judged citation faithfulness,
computable source diversity, coverage-vs-rubric, calibration) is what turns
the whole engine from "carefully tuned" into "hill-climbing." Cost: modest and
dependency-free (extend the in-repo harness; questions are synthetic, so it
stays clear of the zero-retention promise).

---

## II. Privacy & trust

The mission frames this project as *innovation on provable privacy*, so the
gaps here matter more than their raw severity — each is a place where a claim
is currently a **policy** that could become a **structure**.

### P8 — The two-tier privacy split

**Now 90% · Setpoint 98%.**

Se/cure is structurally clean: the browser calls the user's own providers
(`public/js/drc-providers.js`), the Worker serves only static assets + public
replay JSON (`src/pub.js`), and the two enumerated server exceptions collapse
to two *exposure classes* (P10). Se/rver stores conversations as AES-256-GCM
ciphertext in both browser and R2, key HMAC-derived server-side and never at
rest beside the ciphertext (`src/history-key.js`, `src/storage.js`); the vault
is server-undecryptable.

**The gap (self-documented, P-6 in `src/security-risks.js:101`):**
`putEncRecord` accepts a plaintext `{data}` record for the **convos** family,
not just projects (`src/storage.js:196`) — so *the ciphertext-at-rest
invariant for conversations is client-enforced only*. A buggy or hostile
client could persist a conversation in the clear and the server would store
it.

**Value of closing:** **high for the mission.** Making the server *refuse* a
non-ciphertext convos record turns invariant 4 from a policy the client
upholds into a structure the server enforces — exactly the "provable, not
promised" property the project sells. Cost: low (a shape check on one write
path), with a migration note for the readable exceptions (project chats,
file originals) that must stay plaintext.

### P9 — Structural, not policy-based, privacy

**Now 80% · Setpoint 90% (100% is unreachable by design — see below).**

The serving-chain-as-proof argument is genuine: the exact running source is
the public repo, git-connected. But two things cap it:

- The trust boundary is the **repo + Cloudflare account** (`SECURITY-RISKS.md`
  R-9). The architecture's honest answer is "fork it and self-host in a
  network-restricted environment" — which is why the setpoint isn't 100%: the
  reference deployment can't eliminate its own serving-chain trust, only make
  it auditable and forkable.
- **CSP is authored but OFF** (`CSP_ENABLED = false`, P-4 in
  `src/security-risks.js:86`). One DOMPurify bypass is full session-context
  XSS reaching IndexedDB — the history key and readable project chats. The
  at-rest encryption (P8) does nothing against in-page script.

**Value of closing:** **high and concrete** — turning CSP on is the single
biggest *structural* hardening available, and it converts the one fail-open
corner (P12) into fail-closed. Cost: real but bounded (the inline
handlers/vendored libs need a nonce/hash pass; this is exactly what a staged
`Content-Security-Policy-Report-Only` rollout is for).

### P10 — Bounded, enumerated exceptions + the server-token guarantee

**Now 95% · Setpoint 95%.**

The guarantee is enforced, not asserted: the closed service vocabulary
(`SERVER_TOKEN_SERVICES = ["web","api"]`), a **module-graph unit test** that
fails if `server-grants.js` imports anything outside a 7-module upstream
allowlist (and explicitly bans `storage/vault/chatlog/accounts/…`,
`src/server-grants.test.js:446`), and a test proving a server token is
rejected in every auth position (`src/server-token.test.js:157`) — backed
structurally by `identify()` having no Bearer/JWT branch at all
(`src/auth.js:97`).

**The only gap is precision, not security:** "exactly two exceptions" is true
for *exposure classes* (`web` = query-only, `api` = content-bearing) but the
code carries three credential families (`wsk1`, `prg1/prx1`, and the
consolidated Se/rver JWT). The `api` proxy is the one place Se/cure *content*
reaches the server — opt-in, Berget-only, disclosed. **Value:** low —
sharpen the doc wording, and eventually retire the legacy families now that
the consolidated token subsumes them.

### P11 — Data minimization on outbound requests

**Now 97% · Setpoint 97%.**

Audited clean: Exa gets `{query,type,numResults}` only; Shodan gets the
host/IP with file-extension targets filtered out so `report.pdf` never leaks;
Nominatim gets lat/lon with a deliberately generic User-Agent; Maps gets the
parsed address/coordinates and the server key never reaches the browser. The
one nuance — `placesNearbySearch` sends a natural-language intent fragment
("gas station near E18") rather than a bare coordinate
(`src/googlemaps.js:284`) — is within the "minimum needed" spirit. Leave it.

### P12 — Fail-closed security

**Now 95% · Setpoint 98%.**

No admin secrets ⇒ every request denied; `SESSION_SECRET` unset ⇒ a
config-error page rather than a keyless flow (the earlier
admin-credential fallback was removed because it made a captured cookie
brute-forceable); timing-safe comparisons; sanitized rendering with `<img>`
forbidden. The one fail-*open* corner is CSP-off (P9) — closing that closes
this. **Value:** folded into P9.

---

## III. Codebase & method

### P13 — Minimal dependencies / no build step

**Now 90% · Setpoint 95%.**

`package.json` has **no** `dependencies` block — only two dev-only tools.
That holds. The gaps are supply-chain-shaped:

- **SHA-pin inconsistency:** xterm and transformers.js are SHA-256 pinned
  (`public/js/sandbox.js:62`, `ondevice-engine.js:20`); the older vendored
  `marked` / `purify` / `jspdf` / `pdfjs` have **no** recorded hash and no SRI
  attribute. Already backlogged as L-12 (a version+SHA-256 manifest).
- Dev-deps pin to `"latest"` (a lockfile mitigates, but the manifest is soft).
- A second un-pinned live external rides beside the acknowledged CheerpX CDN:
  the WebVM Debian disk `wss://disks.webvm.io/…` (`sandbox.js:74`).

**Value:** medium and cheap — finishing the vendor SHA-pin manifest is a small
change that materially tightens the auditable-supply-chain story the security
posture leans on. Directly serves P9.

### P14 — Swedish/English parity in all deterministic routing

**Now 100% · Setpoint 100%.**

Audited across 12 gate families (quiz, HF, feedback, bash, introspection,
external-source, security-assessment, help, back-reference, the maps/
street-view cluster, AI-model, canned-FAQ) — **every** gate carries Swedish
forms side-by-side with English *and* a co-located parity test, and the DRC
client re-imports the shared cores rather than forking them. This is the
repo's most rigorously enforced discipline and the template the others should
be held to. Nothing to do but keep the invariant-6 gate on every new gate.

### P15 — Pure-core + façade / single source of truth

**Now 90% · Setpoint 90%.**

Shared logic lives in pure cores testable in Node (`bash-core`,
`introspect-core`, `sdk-core`, `vault-core`, `workspace-core`, the googlemaps
text gates), with server files re-exporting them as façades — which is *why*
P14 has a single source of truth and why the DRC/DRS tiers can't drift. Mature;
the only maintenance is applying it to each new gated feature.

### P16 — Docs-as-verifiable-truth

**Now 90% · Setpoint 95%.**

Unusually strong machinery: the introspection source snapshot and RAG index
are committed and **drift-tested** (`npm test` fails if either staleness
check trips), `CODE-LAYOUT.md` is mirror-disciplined, and the risk register
is *code* (`src/security-risks.js`) mirroring `SECURITY-RISKS.md` — including
the self-documented P-4/P-5/P-6 deviations this review leans on. The project
literally ships its own gap list.

**The gap:** a few prose overclaims where the docs are less honest than the
code — "every helper phase fails soft" (P2, the answer phases throw) and
"exactly two exceptions" (P10, two classes / three families). **Value:**
medium — run the existing `docs-drift-validation` / `anti-ai-smell` loop over
these specific claims. A principle called *docs-as-truth* is only as good as
its least honest sentence.

---

## IV. Platform & product direction

### P17 — Zero-or-one-server property + the distillable pair abstraction

**Now 85% · Setpoint 85%.**

The load-bearing property holds: across the whole pair there is at most one
server component (the one Worker), and Se/cure stays fully functional with
that Worker reduced to a static host — which is what makes the privacy claims
*auditable* rather than policy. DistillSDK generalizes the pair as a
reusable abstraction; SDK mode (`public/js/sdk-core.js`) is wired and live,
distilling Se/cure into publishable flavours. The 33-module manifest is still
mostly design + skills. **Value:** medium and strategic, not urgent — this is
the differentiator, but the near-term ROI is lower than the P7/P8/P9 cluster.

### P18 — Spec-leads-code interchange standards (DRSW / DRPL / stackless)

**Now 40% · Setpoint: a decision, not a number.**

This is the one principle where a *low* adherence is deliberate: the
interchange standards (DRSW workspace protocol, DRPL pipeline language) are
**specified ahead of the code**, with working tooling (`sdk/drpl.mjs`) and
two committed real-world DRPL documents, but the federation itself — the
reference node serving `/.well-known/drsw.json`, a second node, routing UX —
is unbuilt by design. The vision (stackless research: state in user custody,
sites as interchangeable nodes) is genuinely novel.

**The honest question isn't "close the gap" — it's "fund the bet or park
it."** A standard that leads code is healthy; a standard that leads code
*indefinitely* is a maintenance tax and a credibility risk. **Value of
funding:** high-but-speculative — the smallest experiment that would prove or
kill the thesis is a single second node (even a toy local-only one) to run the
handoff loop end to end. **Recommendation:** decide explicitly — either
schedule that one experiment, or mark the standards "frozen, revisit on
demand" so they stop implying imminent work.

### P19 — Hand-rolled durability over platform primitives

**Now 100% adherent to the decision · Setpoint: conditional.**

The recovery machinery (D1 `answers` table, 15 s heartbeat,
`RUNNING_STALE_MS` dead-run detection, `ctx.waitUntil`, the relaunch pointer)
is deliberately hand-built rather than delegated to Cloudflare Workflows —
and that is correct *today*: the machinery is battle-tested and its failure
modes are known.

**The value is in knowing when to reverse it.** The roadmap names the exact
triggers — budgets past ~10 min, the P4 sub-question fan-out, or scheduled
"research this and notify me" work. Any of those makes durable execution
worth the new binding, and the phases are already pure-ish functions of `ctx`,
which is most of the port. **Recommendation:** treat P4 and P19 as a pair — if
fan-out gets funded, migrate the orchestration shell to Workflows in the same
effort rather than extending the hand-built recovery again.

### P20 — MCP as a product surface, not internal plumbing

**Now 95% · Setpoint 95%.**

Both halves of the roadmap's verdict shipped: integrations were *not*
rebuilt on MCP (they share the internal enrichment contract instead), and
DeepResearch is exposed *as* an MCP server (`/mcp` `deep_research` +
the four `sdk_*` tools), wired after the identity gate so it inherits access
control and usage recording. Mature; extension means more exposed tools, not
new architecture.

---

## V. Where to focus — the synthesis

Ranked by (value ÷ cost), grounded in the gaps above. The first cluster is
where the project's stated *mission* and its actual *code* diverge most.

1. **Close the three self-documented privacy gaps (P8/P9/P12 → P-6, P-5,
   P-4).** The mission is *provable* privacy; these are precisely the places
   where a claim is still a policy. In rough cost order:
   - **P-6** — make the server refuse a non-ciphertext convos write (small,
     turns invariant 4 into a structure).
   - **P-4** — stage CSP on via report-only → enforce (bounded, kills the one
     fail-open corner and the biggest XSS→history-key path).
   - **P-5** — give `chat_logs` a TTL and fold it into `DELETE /api/storage`,
     or encrypt it; today it's plaintext, un-drained, and survives the
     account-wide wipe — "the dominant server-side privacy exposure."

2. **Make the scored benchmark a routine gate (P7).** The highest quality
   lever, and the prerequisite that unlocks everything in section I. Until a
   number moves, every pipeline change is a guess. Dependency-free.

3. **Sub-question fan-out at the top budget tier (P4), paired with a Workflows
   migration (P19).** The largest remaining latency+depth lever — but only
   *after* P7 can score it, and taken together with the durability migration
   its triggers imply.

4. **Finish the vendor SHA-pin manifest (P13 / L-12).** Cheap supply-chain
   hardening that directly strengthens the P9 auditability story.

5. **Decide the DRSW/DRPL bet (P18).** Fund one second node to prove the
   handoff loop, or explicitly freeze the standards. Don't leave them
   implying imminent work indefinitely.

6. **Reconcile the doc overclaims (P16 → P2, P10).** Small, and it keeps the
   *docs-as-verifiable-truth* principle honest about its own two soft spots.

The through-line: the engine's *discipline* (P1–P6, P14) is close to its
setpoints and in one case (P4) worth deliberately relaxing; the real,
fundable distance is in the **privacy structure** (P8/P9) — where the mission
lives — and in the **measurement flywheel** (P7) that gates every further
pipeline ambition. Everything else is either done, correctly parked, or a
strategic bet to name rather than a gap to close.
