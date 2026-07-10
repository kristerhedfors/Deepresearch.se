# Porting deepresearch.se to NVIDIA NeMo — feasibility analysis

*2026-07-10. An architectural examination, not an implementation. Grounded in
the codebase as of this date; NVIDIA product details reflect the NeMo
ecosystem as of early 2026 and should be re-verified before acting.*

## 1. What "NeMo" would even mean here

NVIDIA NeMo is not one product but a family. Each member maps to a
*different* part of this codebase, with very different feasibility:

| NeMo component | What it is | Would replace / touch here |
|---|---|---|
| **NIM** (NVIDIA Inference Microservices) + build.nvidia.com hosted endpoints | OpenAI-compatible containerized model inference | `src/berget.js` / the `src/providers.js` provider seam |
| **NeMo Retriever** | Embedding + reranking inference microservices for RAG | `src/rag.js`'s Berget embedding proxy (+ the Vectorize index) |
| **NeMo Guardrails** | Python toolkit for programmable input/output/fact-check rails (Colang) | The pipeline's validation phase (`runValidation` in `src/pipeline.js`) |
| **NeMo Agent Toolkit** (née AgentIQ) | Python framework for building/profiling agent workflows | The whole orchestration: `src/pipeline.js`, `budget.js`, `chat.js` |
| **NeMo Framework** | GPU-cluster training/fine-tuning (Megatron-based) | Nothing directly — would *produce* models the site serves |
| **NeMo microservices platform** (Customizer/Evaluator/Data Store) | Kubernetes-deployed model lifecycle services | The eval harnesses (`tests/*-bench.mjs`), fine-tuning workflows |

So "port to NeMo" decomposes into five separate questions, examined below.

## 2. The architectural facts that constrain everything

1. **The runtime is a Cloudflare Worker.** JavaScript, no build step, no
   runtime dependencies (CLAUDE.md invariant 5). Every NeMo library is
   Python-first and heavy. Nothing from the NeMo software stack can *run
   inside* this application — any NeMo integration is either (a) an HTTP
   call to a NeMo-served endpoint, or (b) a platform migration off Workers.

2. **The platform bindings are Cloudflare-proprietary.** D1 (accounts,
   quotas, chat logs, feedback, game saves), R2 (encrypted conversations and
   files), Vectorize (RAG vectors), Workers Cache, Workers Logs, the asset
   pipeline, custom domains. None of these has a NeMo counterpart —
   a platform port means re-homing all of them.

3. **The pipeline deliberately uses NO function calling** (invariant 1).
   Every phase is a plain JSON-mode or streamed chat-completions call. Two
   consequences cut in opposite directions:
   - *For* NeMo inference: the pipeline's LLM traffic is maximally portable.
     Any OpenAI-compatible endpoint — which NIM is — can serve it verbatim.
   - *Against* NeMo orchestration: agent frameworks (NeMo Agent Toolkit
     included) are organized around tool-calling loops. Porting the flow
     there either violates the invariant or fights the framework.

4. **The provider seam already exists and is cheap.** `src/providers.js`
   dispatches by model-id namespace; `src/openai.js` (~200 lines) is the
   worked example of adding an OpenAI-native-wire provider: no SSE adapter,
   just wire params and a static priced catalog. The **add-llm-provider**
   skill documents the whole ladder.

5. **The privacy posture is EU/sovereignty-driven.** Berget.ai is a Swedish
   sovereign AI cloud (itself running NVIDIA GPUs). Conversations rest
   encrypted; outbound calls carry the minimum. NVIDIA's *hosted* endpoints
   (build.nvidia.com) are US-operated — a step *backwards* for this posture.
   Self-hosted NIM on EU GPU infrastructure would preserve it, at real cost.

6. **Fail-soft and time-budgeting are load-bearing and home-grown.**
   Invariant 2 (helper phases degrade, never error the chat), the EWMA
   time-budget planner (`budget.js`), per-model profiles, stream guards,
   answer-recovery. None of this comes for free in any framework; a port
   must rebuild it all.

## 3. Option-by-option feasibility

### 3a. NIM as an LLM provider — HIGH feasibility, low cost, real value

NIM speaks the OpenAI Chat Completions wire format, including SSE
streaming. That is *exactly* the contract `consumeChatStream` and the
provider registry expect. Adding NVIDIA as a fourth provider is the
`src/openai.js` pattern almost verbatim:

- One `src/nvidia.js` module: raw fetch, `NVIDIA_API_KEY`-gated, static
  priced catalog, a base-URL override (`NVIDIA_URL`) that serves double
  duty — hosted endpoints for development, a self-hosted NIM cluster URL
  for production sovereignty.
- One registry entry in `SECONDARY_PROVIDERS`. Model-id namespace needs a
  prefix decision (NIM ids look like `meta/llama-3.3-70b-instruct` —
  vendor-path shaped, which **collides with Berget's namespace**; the clean
  fix is an explicit `nvidia/` alias prefix stripped at the wire, since
  namespace routing is the whole dispatch mechanism).
- Split routing (invariant 3) is preserved by construction: JSON phases stay
  on Berget's `DEFAULT_MODEL` regardless.
- Open questions to resolve empirically (per the validation ladder): JSON-mode
  reliability per NIM model (the pipeline needs `response_format`-style JSON
  or prompt-reinforced JSON — `model-profiles.js` exists for exactly this),
  pricing for the catalog (hosted NVIDIA endpoints are credit-based dev
  tiers, not per-token production pricing; self-hosted NIM cost is GPU-hours
  plus an NVIDIA AI Enterprise license, which doesn't map cleanly onto the
  per-token quota/billing model in `quota.js`).

**Caveat on value:** Berget already serves open-weight models on NVIDIA GPUs
with per-token pricing and EU sovereignty. Hosted NIM adds model choice but
worse data posture; self-hosted NIM adds sovereignty control but a large ops
and licensing bill. This option is *easy*, but only *worth it* if there's a
model on NIM the catalog can't otherwise reach, or a mandate to run on owned
GPU infrastructure.

### 3b. NeMo Retriever for RAG embeddings — MEDIUM feasibility, conditional value

`/api/embed` proxies Berget's `multilingual-e5-large` (1024-dim), matching
the Vectorize index. NeMo Retriever's embedding NIMs are also
OpenAI-compatible-ish HTTP endpoints, so the proxy swap is small. But:

- Changing the embedding model **invalidates every stored vector** — full
  reindex of all user RAG documents and project chats (client-held and
  Vectorize copies).
- Dimensions must match or the Vectorize index must be recreated.
- Retrieval quality must beat the incumbent *for Swedish + English* to
  justify it — no evidence of a deficiency exists today, and invariant 5
  demands evidence before special-casing.

Do this only if RAG quality is demonstrated to be a problem.

### 3c. NeMo Guardrails for validation — LOW value, architectural mismatch

The pipeline *already has* a validation phase: a JSON fact-check of the
draft against the numbered source registry, fail-soft, on the fixed JSON
model. Guardrails would re-implement this as a Python sidecar service
(it cannot run in the Worker), adding a network hop, an ops surface, and a
new failure mode to a phase whose defining property is that it *cannot*
break the request. Its dialog-rails model (Colang flows) also overlaps the
deterministic intent gates (`googlemaps-text.js`, `quiz.js`) — which are
pure, unit-tested JS with a hard Swedish-parity requirement (invariant 6)
that a Colang port would have to re-prove. Nothing here is gained.

### 3d. NeMo Agent Toolkit for orchestration — FEASIBLE but a rewrite, not a port

This is the reading closest to "porting deepresearch.se to NeMo," and the
honest sizing is:

- **What ports cleanly:** the phase *logic* and prompts. Because there is no
  function calling, triage → search → gap → synth → validate is just a
  sequence of chat-completions calls with JSON parsing between them —
  expressible in any framework, or in 300 lines of plain Python. Exa, HF
  Hub, Shodan, and Google Maps are ordinary HTTP clients.
- **What must be rebuilt:** everything else, which is most of the product.
  Auth (Google OIDC, sessions, terms/approval gates), quotas and split-model
  billing, the SSE protocol and its client, encrypted storage and the
  privacy split, RAG, chat logs, feedback mode, the admin surface, games,
  the time-budget planner, model profiles, stream guards, answer recovery,
  edge caching, and the two test suites. `pipeline.js` is ~1,450 of roughly
  20k+ lines of server+client code; the port would carry ~10% and rewrite
  ~90% on a new platform (Python service on GPU-adjacent infra vs. a
  zero-ops global edge Worker).
- **What gets worse:** cost model (always-on containers vs. per-request
  isolates that spend almost all wall-clock idle-waiting on fetches),
  latency to the edge, operational burden (Kubernetes vs. `git push`),
  and the deterministic-orchestration invariant, which an agent framework's
  tool-loop idiom actively erodes.
- **What gets better:** Python ecosystem access, NeMo's profiling/eval
  tooling, and co-location with self-hosted models if that's the endgame.

### 3e. NeMo Framework / Customizer for fine-tuning — ORTHOGONAL

Fine-tuning (say, a small model specialized for the JSON planning phases or
the Swedish research domain) doesn't port anything; it *produces* a model
that would then be served via Berget or a NIM and consumed through the
existing seam. Potentially interesting someday, but the eval ledgers show no
evidence the current fixed JSON model is a quality bottleneck, and the GPU
training cost is far outside this project's current economics.

## 4. Summary

**Benefits (real, but narrow):**
- NIM's OpenAI-compatible wire means near-zero-friction *inference*
  integration through the existing provider seam.
- Self-hosted NIM offers a sovereignty-preserving path to models Berget
  doesn't carry, plus GPU-level control (batching, quantization).
- NeMo Evaluator/profiling tooling could complement the home-grown benches.
- A NeMo Agent Toolkit rewrite would gain Python-ecosystem leverage.

**Challenges:**
- Runtime mismatch: NeMo is Python/Kubernetes; this product is a
  dependency-free JS Worker. No NeMo code can run in-process.
- Platform gravity: D1/R2/Vectorize/SSE/auth/quota — the bulk of the code —
  has no NeMo equivalent and would be rewritten, not ported.
- Economics invert: per-token serverless → GPU instances + NVIDIA AI
  Enterprise licensing, for a service whose wall-clock is mostly idle I/O.
- Namespace collision between NIM's vendor-path model ids and Berget's
  requires an aliasing scheme in the routing key.
- Sovereignty: NVIDIA hosted endpoints are US-operated — worse than the
  status quo; only self-hosting preserves the privacy posture.

**Shortcomings of NeMo for this use case:**
- Guardrails and Agent Toolkit solve problems this codebase solved
  differently on purpose (deterministic gates, no function calling,
  fail-soft phases) — adopting them trades tested invariants for framework
  idioms without a user-visible gain.
- No NeMo component addresses the actual differentiators here: the
  time-budget planner, split-model routing, the encrypted-storage model,
  Swedish/English parity, or the eval-ledger discipline.

## 5. Recommendation

**Do not port the application or its orchestration to NeMo.** The
cost/benefit is strongly negative: ~90% rewrite, inverted economics, weaker
privacy posture, and the loss of load-bearing invariants, in exchange for
framework features the pipeline was deliberately designed not to need.

**If NVIDIA/NeMo technology is wanted, integrate at the seams built for it,
in this order:**

1. **Add NVIDIA NIM as a fourth key-gated provider** (`src/nvidia.js` +
   one `SECONDARY_PROVIDERS` entry, the `openai.js` pattern with an
   `nvidia/` id-alias prefix and a base-URL override for self-hosted
   deployments). Days of work including the validation ladder; zero risk to
   existing providers; reversible by unsetting the key. Do it when a
   concrete NIM-served model is wanted in the dropdown — not speculatively.
2. **Evaluate (don't adopt) a NeMo Retriever embedding NIM** only if RAG
   retrieval quality is shown deficient, and budget for the full reindex.
3. **Skip NeMo Guardrails and the NeMo Agent Toolkit** — they duplicate
   existing, tested machinery at the cost of a Python sidecar or a platform
   rewrite.
4. **Revisit fine-tuning (NeMo Framework/Customizer)** only with ledger
   evidence that a served model underperforms on a codified use case, per
   the evidence-before-override rule.

The deepest fact this analysis rests on: because the pipeline avoids
function calling, its *LLM traffic* is trivially NeMo-compatible already —
the value of "porting" is therefore almost entirely captured by pointing the
existing provider seam at a NIM endpoint, and almost none of it by moving
the orchestration into NeMo.
