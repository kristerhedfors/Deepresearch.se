---
name: cyber
description: >-
  Load when working on the CYBER agent — the cybersecurity and OSINT chat mode
  (`chat_mode: "cyber"`, agent id `cyber`, crimson `cyber-mode` theme, shipped
  2026-08-13). It is the ONLY agent allowed the platform's outward-facing
  intelligence, and it owns five capabilities exclusively: host intelligence
  (Shodan — `src/shodan.js`, `src/shodan-enrichment.js`, `src/shodan-text.js`),
  street imagery and place lookup (Google Maps / Street View —
  `src/googlemaps*.js`, `src/maps-enrichment.js`), the entity-OSINT method
  (`src/entity-research.js`, `public/js/entity-research-core.js`), the
  person-OSINT method (`src/person-research.js`,
  `public/js/person-research-core.js`), and the OWASP reference corpus
  (`src/owasp-context.js`). Load it for any of those modules, for
  "why does Shodan/Street View not fire any more", "which agent may reach X",
  "add an OSINT source", "the security-assessment answer stopped citing OWASP",
  or when touching the `capability.context` blocks `host-intel`,
  `street-imagery`, `entity-method`, `person-method` or `owasp`. Covers what
  Cyber owns and why, how ownership is declared and enforced
  (`capHasContext`), the AND-gate with the per-account extension knobs, the
  privacy rail that is deliberately NOT part of the domain, the exclusivity
  guard, and how to add a new OSINT source. Companion to **integrations** (the
  services themselves), **add-research-source** (a new search leg) and
  **security-posture** (the risk register, which is a different thing).
---

# The Cyber agent

Cybersecurity and open-source intelligence, as one agent. Shipped 2026-08-13
with the owner directive that made the roster specific: mode `cyber`, agent id
`cyber`, red accent `#b32d3a`, root class `cyber-mode`, second entry in the
composer dropdown.

It runs the ordinary `research` answer phase and the ordinary `research` prompt
set. Nothing about the pipeline is special. What makes it a domain agent is its
`capability.context` list, and what makes that list mean anything is that
`capability.context` became **executed** on the same day (`capHasContext`) —
before then a spec could declare a block and nothing read the declaration.

## 1. What it owns, and why each is exclusive

| Block | Reaches | Modules |
|---|---|---|
| `host-intel` | open ports, running services, hosting organization/ASN and known CVEs for a host, IP or organization named in the conversation | `src/shodan.js`, `src/shodan-text.js`, `src/shodan-enrichment.js` |
| `street-imagery` | place resolution, street-level imagery described by a vision model, the interactive panorama embed | `src/googlemaps.js`, `src/googlemaps-text.js`, `src/maps-enrichment.js` |
| `entity-method` | subject disambiguation, and the depth-scaled dossier scaffold whose deepest tier is shaped like a TIBER-EU targeted threat-intelligence report | `public/js/entity-research-core.js`, `src/entity-research.js` |
| `person-method` | the OSINT tradecraft half of person research: the source ladder, the verification rungs, the write-up | `public/js/person-research-core.js`, `src/person-research.js` |
| `owasp` | the OWASP Top 10 for web (2021) and for LLM applications (2025), retrieved as real reference text | `src/owasp-context.js` |

Only `owasp` is shared, and with exactly one other agent: **Introspection**,
because a security assessment *of this platform* is what introspection is for.
Everything else is Cyber's alone.

The argument for exclusivity is the same in every row. Each of these already
shipped and each was reachable by *any* turn whose wording matched a keyword
gate, so the reach and the declaration had nothing to do with each other. The
clearest case is OWASP: it lived inside `runIntrospectionEnrichment`, behind
`state.introspection`, so **five modes reached it as a side effect of carrying
the source snapshot while exactly one agent declared it**. Extracting it into
`src/owasp-context.js` and gating it on the declaration is what fixed that, and
it also stopped a security-assessment turn loading a multi-megabyte snapshot of
this repository to get at twenty pages of a public web standard.

## 2. How ownership is declared and enforced

**Declared** in `sdk/AGENTS.json`, in the `cyber` spec's `capability.context`.
The vocabulary is `CONTEXT_BLOCKS` in `public/js/agent-spec-core.js`; a block
not in that table fails `validateAgentSpec`.

**Enforced** at two registries, both of which read the block generically and
never learn which agent or which service it belongs to:

- **Enrichments** — `src/enrichment.js`, one row per capability:
  `enabled: (state) => capHasContext(state.capability, "<block>")`. That is how
  `owasp` and `entity_research` run, and it is the pattern the ancient-sample
  corpus and the Scholar metrics leg already used. The extension rows get the
  same treatment generically through `extensionEnrichments()`, which ANDs the
  descriptor's `enabled` with `capHasContext(state.capability, e.contextBlock)`.
- **Search sources** — `src/search-sources.js`, the `requiresContext` field on
  a registry entry, honoured by `sourceAllowed` in `src/pipeline.js`. Cyber
  declares no literature block, so the literature legs do not fire for it.

**Two rules that are easy to get backwards:**

- **A null capability means two different things, and the polarity is opposite
  on the two seams. Read this before assuming.** Null means *no agent was
  resolved* — the `POST /mcp` channel builds its state without a registry, and a
  deployment whose registry will not load resolves nothing either. Both must
  keep working (invariant 2), but "keep working" resolves differently depending
  on what is being gated:
  - **Search sources** (`requiresContext` in `src/search-sources.js`, the
    literature legs): null **allows** the source. These legs have always run for
    any caller, MCP included, and switching them off for a channel with no
    concept of an agent would be a silent capability loss rather than a fail-soft
    degradation.
  - **Enrichments and extension capabilities** (`capHasContext` in
    `src/enrichment.js` and `src/extensions.js`): null **denies** the row. This
    is the shipped `aadr`/`scholar` precedent, and it is the right default for a
    block that costs an outbound request to a third party or injects a method
    the turn did not ask for.

  Declaring an **empty** `context` is a real declaration on both seams and does
  gate — that is an agent saying "nothing", not a caller saying nothing.
- `routingNeedsRegistry` therefore returns `true` unconditionally. A request
  that skipped the registry would resolve a null capability and silently get the
  unrestricted platform default — the exact failure this work exists to prevent.

## 3. The AND-gate with the extension knobs

Host intelligence and street imagery are third-party services, so they are
**extensions** (`src/extensions.js`, invariant 7) with per-account knobs
`shodan_mcp` and `google_maps`. The capability does **not** replace the knob;
the two are ANDed, and they answer different questions:

> The **knob** is the user's consent to send a host, an address or a coordinate
> to a third party. The **capability** is which agent may use it.

Turning the knob on for an account that is answering in Deep Science must not
make Deep Science reach Shodan, and holding `host-intel` must not spend a
deployment's Shodan key for a user who never consented. Neither gate subsumes
the other, so both stay.

Invariant 7 still holds through all of this: `src/extensions.js` is the only
`src/` module that may name an individual service at the architectural seam, and
the context-block vocabulary is written to match — the blocks are called
`host-intel` and `street-imagery`, never `shodan` and `google-maps`, and their
gate ids in `GATE_IDS` deliberately name no module for the same reason.
`src/extensions.test.js`'s core-purity guard fails the build if a core module
starts naming a service again.

## 4. What is deliberately NOT part of the domain

**The person-research privacy rail.** Person research was split in two
(`docs/PERSON-RESEARCH.md` §3.0). The GUARDRAILS half — the special categories,
the personnummer, the home address, the family, face matching, de-anonymising a
pseudonymous account — is a **privacy rail**, not domain expertise, and it stays
unconditional on every agent. The gate that fires is `personResearchIntent`, and
"who is this founder" reaches Deep Science and Introspection too; an agent that
lost the block would lose the *limits*, which is worse than never having had the
method (invariant 4).

So the registry row stays `enabled: () => true` and the choice is made inside
the runner: `capHasContext(state.capability, "person-method")` picks
`personResearchBlock()` (the full protocol) or `personGuardrailsBlock()` (the
rail alone), and the activity step says which half applied. Being the security
agent widens what Cyber may look **up**, never **who** it may look up.

**Scanning, probing and buying data.** Cyber reads what the internet already
publishes. An answer that reads like an engagement report is still a desk study
and the agent says so; exposure is an observation, not a vulnerability, and the
answer separates what was observed from what was inferred.

## 5. The prompt half

`OWASP_ASSESSMENT_NOTE` in `src/prompts.js` — the instruction to classify
findings against OWASP categories, cite the identifiers and give CVSS estimates
— is spliced **conditionally**, on the same `owasp` declaration
(`owaspNoteFor(capability)`). That pairing is load-bearing: told to cite
`LLM01:2025` while holding none of the text those ids come from, a model writes
the classification from memory, which is the failure the retrieval exists to
prevent. `capability === undefined` splices it, so a caller that passes no
capability at all keeps the pre-2026-08-13 behaviour.

## 6. Adding a new OSINT source

Decide which of three shapes it is before writing anything.

1. **A third-party service the user must consent to** (the Shodan/Maps shape) —
   an `Extension` descriptor in `src/extensions.js` plus its own modules, and a
   new `CONTEXT_BLOCKS` entry named for the *capability*, not the service. Add
   the block to the `cyber` spec, and gate the enrichment on it as well as on
   the knob. No core file is edited. Read **integrations** first.
2. **A citable search leg** (a new intelligence feed producing sources) — a
   `SEARCH_SOURCES` entry with `requiresContext` set to its block. Read
   **add-research-source** for the whole ladder: intent design, API probing,
   SSE visibility, the validation protocol.
3. **Method, not data** (the entity/person shape) — a constant block and a
   bilingual intent gate in a pure core under `public/js/`, a thin runner in
   `src/`, and the registry row flagged `method: true` so the query-planning
   phases read past it (`docs/ARCHITECTURE.md` §4.2b). A ~900-word protocol
   naming registries and archives is a rich set of things to search for and none
   of them is the subject.

Whichever shape: the gate carries **Swedish and English at equal breadth**
(invariant 6) with a parity unit test in the same change, and the enrichment is
**fail-soft in every branch** — the conversation comes back unchanged rather
than erroring the chat (invariant 2).

## 7. The exclusivity guard

Exclusivity is a claim about *every other agent*, which is exactly the kind of
claim that rots silently: nothing fails when a future spec quietly adds
`host-intel` to Deep Science — the enrichment simply starts running there, the
grounded capabilities note starts advertising it, and the roster is general
again by accident.

**`src/cyber-exclusivity.test.js`** pins it, over the SHIPPED registry rather
than a fixture: the four blocks Cyber owns alone (`entity-method`,
`person-method`, `host-intel`, `street-imagery`) are asserted declared by
`cyber` and by no other agent, and `owasp` is asserted shared with
`introspection` and nothing else. Each assertion names the capability it
switches on, so a reader who finds the suite failing can see what the other
agent just gained. Widening ownership is then a deliberate edit to a named
assertion with the reason recorded beside it.

Its literature sibling is `src/literature-exclusivity.test.js`, worth reading
for the shape: it asserts the pairing from **both** ends — which agents may hold
each block, and what a real resolved capability can actually reach — and pins
the fail-soft null-capability hole on purpose.

Also check, when changing anything here:

- `src/extensions.test.js` — the core-purity guard (invariant 7).
- `public/js/agent-capability.test.js` — the capability rules, each with a
  passing and a failing case.
- `src/person-research.test.js` — both halves of the split, and the fail-soft
  cases (null conversation, absent ctx, image-only message, frozen state bag).

## 8. Where the rest is written down

- `docs/AGENT-PLATFORM.md` §2 (the roster), §3.1–§3.2 (the capability block and
  the four narrowing accessors), §4 (routing).
- `docs/ENTITY-RESEARCH.md`, `docs/PERSON-RESEARCH.md` — the two methods in
  full.
- `docs/ARCHITECTURE.md` §4.2a — the extension boundary, and why a capability
  names `host-intel` rather than a vendor.
- `docs/DEFAULT-AGENTS-GENERALIZATION.md` §7 — the declared-versus-executed
  table, and what moved `capability.context` across it.
