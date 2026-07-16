---
name: mcp-surface
description: >-
  Load when exposing a generated agent pair AS a tool that other agents call
  — an MCP server on the pair's outbound edge — or when touching the
  JSON-RPC 2.0 / Streamable HTTP endpoint, the tool schema, or an MCP client
  that can't connect or call the tool. Covers the outbound-only verdict (MCP
  is how the pair is composed WITH, never internal plumbing — inside, tool
  selection stays deterministic), the hand-rolled dependency-free protocol
  handling (initialize / tools/list / tools/call / notifications ack), the
  load-bearing file-layout rule (pure protocol helpers statically importable
  and tested WITHOUT the pipeline; the heavy pipeline import dynamic inside
  tools/call), routing after the identity gate, reusing the chat handler's
  quota gate + split model routing + split-billing recording so MCP spend is
  indistinguishable from chat spend, channel-tagged interaction logging, and
  the validation ladder (protocol unit suite → live JSON-RPC probe).
---

# The MCP surface — the pair as a tool other agents call

Expose the pair's research pipeline **as an MCP server**: one high-leverage
tool (question in; cited, validated, source-diverse answer out) that any MCP
client — a chat assistant, an IDE agent, an agent SDK — can call. This is the
one place the pipeline points *outward*: MCP adds a transport over the
existing pipeline; it never hands control flow to a model. The pair becomes a
composable capability in other agents' toolboxes without growing a second
orchestration style inside itself.

## Capability class & tier story

**Class S — server-backed, and honestly server-only.** The MCP endpoint is a
route on the one server component: it needs identity, quotas, usage
recording, and the server-orchestrated pipeline. The client tier has no
server to host an inbound surface on — and should not grow one for this; a
client-tier session that wants to *call* other MCP servers is a different,
outbound concern outside this module. The tier story is therefore one-sided
by design: the server tier gains an inbound machine-to-machine face that
inherits every gate the human-facing chat already passes through.

**The outbound-only verdict (carry this reasoning into the generated
pair).** The reference's architecture roadmap (`docs/ARCHITECTURE-ROADMAP.md`
§3) settled where MCP belongs: on the **outbound edge** — the pair *as* a
tool other agents compose with — and NOT as internal plumbing. Internal
integrations (search, enrichments, providers) stay deterministic registries
in the orchestrator's hands, because model-driven internal tool selection is
exactly the function-calling shape PA-1 rules out and would break the
works-on-any-catalog guarantee. An MCP client's model choosing to call the
pair's tool is fine — that model belongs to the caller; inside the tool call,
orchestration stays deterministic.

## Contracts

- **PA-1** — the inbound surface adds no function calling inside the pair:
  `tools/call` runs the same deterministic pipeline as chat; the "tool
  choice" happens in the CALLER's model, outside the boundary.
- **PA-3** — the tool call resolves its JSON planning model through the SAME
  shared routing-decision leaf the chat handler uses, so split routing can
  never fork between surfaces.
- **PA-4** — MCP exchanges land in the interaction log channel-tagged (so
  they are distinguishable in ops queries) under the same declared-log
  posture and opt-out semantics as chat; secrets never appear in any log.
- **PA-5** — the protocol surface is tiny, so it is hand-rolled: JSON-RPC
  2.0 over a single POST, zero dependencies, same minimal-deps stance as
  the rest of the pair.
- **PA-9-adjacent (quota, not grants)** — the endpoint enforces the SAME
  quota gate as chat BEFORE any spend; without it, MCP is an unmetered
  bypass that runs the full pipeline for real provider and search money.
- **PA-10** — validated by a protocol unit suite that loads the module
  WITHOUT the pipeline, then a live JSON-RPC probe against the deployed
  site with spend confirmed in the usage totals.

## Build plan

1. **One module, one route.** `POST /<mcp-path>` on the server component,
   wired in the entrypoint **AFTER the identity gate** — MCP inherits the
   site's access control verbatim (a signed-in session works; the
   break-glass header identity works; an anonymous caller is rejected the
   same way chat is). Never route it pre-auth "for convenience".
2. **The pure protocol layer — top of file, statically importable.**
   JSON-RPC parsing (`parseJsonRpc`), the envelope builders (result / error
   / tool-result), the RPC error-code constants, `initialize`'s result
   (protocol version, server info, `capabilities: {tools:{}}`),
   `tools/list`'s result, and the tool schema constant. The ONLY static
   imports allowed here are leaf modules (the JSON response helper, the
   shared routing-decision leaf) — nothing that pulls the pipeline graph.
3. **The method dispatch.** Handle exactly what a minimal Streamable-HTTP
   server needs: `initialize`, `tools/list`, `tools/call`, and the
   `notifications/initialized` ack. A notification has no `id` and MUST
   return no response body — answering it breaks clients. Unknown methods →
   method-not-found; malformed JSON → parse-error envelope.
4. **The tool schema, written for an LLM caller.** Required `question`;
   optional time budget (defaulted and clamped to the same bounds chat
   enforces, then re-clamped against the admin config ceiling), optional
   model id (JSON planning phases stay on the reliable model regardless —
   say so in the description), optional web-search toggle. Descriptions are
   what the calling model reads: precise, capability-honest, no marketing.
5. **The heavy half — dynamic import inside `tools/call`.** The pipeline
   and its dependency graph (pipeline, providers, budget, validation,
   config, quota, billing) are `import()`ed *inside* the tool-run function.
   This is the load-bearing file-layout rule: the protocol unit suite
   imports the module and asserts the pipeline was never loaded; new pure
   protocol logic goes at the top, anything pipeline-shaped stays behind
   the dynamic import.
6. **Mirror the chat handler's per-request setup — deliberately re-done,
   not shared-by-refactor.** Validate the single-turn conversation with the
   same validator; resolve the model against the catalog fail-soft; pick
   the JSON model via the shared routing leaf; clamp the budget the same
   two-step way; **enforce the quota gate before any spend** (admins
   exempt, every regular identity checked against their windows); run the
   pipeline; collect the streamed answer into one string and append the
   sources list. Re-doing the steps means a chat-path change can't silently
   change MCP; sharing the two LEAF decisions (routing, billing) means the
   decisions themselves can't fork.
7. **Record usage with the shared billing leaf** — the same split-billing
   spend math (per-model-bucket token costs at catalog rates + search cost)
   chat records, so MCP spend shows up in the user's usage bars and the
   admin cost totals indistinguishable from chat spend.
8. **Log the exchange** to the interaction log on its own channel tag with
   the same status vocabulary (ok / error / disconnected) and the same
   opt-out posture as chat.
9. **Error mapping.** Map failures to the JSON-RPC vocabulary, not HTTP
   improvisation: malformed body → parse error; a bad/missing `question` →
   invalid params; an unknown tool name → method-not-found; a pipeline
   failure inside the call → a tool result carrying the error text (the
   caller's model can read it), never a naked 500. The transport stays a
   200-with-envelope wherever the envelope can carry the failure.
10. **Tests + live probe.** Unit-test the pure protocol layer (parse,
    envelopes, initialize, tools/list, tool-result shape, the notification
    no-body rule) AND the loads-without-the-pipeline guarantee. Then the
    live ladder: `initialize` → `tools/list` (expect the one tool + schema)
    → `tools/call` with a cheap low-budget question → confirm a cited
    answer AND the spend landing in usage totals, correlating the request
    id through the worker logs.
11. **Adding a second tool (resist first).** The thesis is one high-leverage
    tool, not a tool zoo — a second tool must be a genuinely distinct
    outward capability, not a pipeline knob. If justified: schema constant
    at the top, `tools/list` returns the list, branch on the tool name in
    the call handler, heavy work behind the dynamic import.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| The whole MCP server (protocol top, dynamic pipeline in `tools/call`) | `src/mcp.js` |
| Route wiring after the identity gate | `src/index.js` (`/mcp` POST → `handleMcp`) |
| Shared split-routing decision leaf | `src/model-routing.js` (`resolveJsonModel`) |
| Shared split-billing spend leaf | `src/billing.js` (`summarizeSpend`, `exaCost`) |
| The chat handler whose per-request setup is mirrored | `src/chat.js` |
| Quota gate + usage recording | `src/quota.js` (`recordUsage`, window checks) |
| Channel-tagged interaction logging | `src/chatlog.js` (channel `mcp`) |
| Protocol unit suite (loads without the pipeline) | `src/mcp.test.js` |
| The outbound-edge-only reasoning | `docs/ARCHITECTURE-ROADMAP.md` §3, `.claude/skills/mcp-server/SKILL.md` |

## Acceptance checklist

- [ ] Protocol unit suite green, including the assertion that importing the
      module never loads the pipeline graph.
- [ ] `initialize` reports protocol version + server info + tools
      capability; `tools/list` returns the tool with its full input schema.
- [ ] `notifications/initialized` returns no response body.
- [ ] An unauthenticated `tools/call` is rejected by the identity gate; an
      over-quota identity is blocked BEFORE any provider spend.
- [ ] Live JSON-RPC probe completes a cheap tool call: cited answer back,
      spend visible in usage totals, an interaction-log row on the MCP
      channel.
- [ ] The JSON planning model used by an MCP call is byte-identical to the
      one an equivalent chat request would pick (shared leaf, asserted).
- [ ] Budget clamps match chat's (unit-compare the two clamp paths).

## Pitfalls

- **The unmetered-bypass trap.** The reference's quota gate on `/mcp` is
  load-bearing: every tool call runs the full pipeline for real Berget +
  Exa money, and an MCP endpoint without the chat quota gate is a free
  side door around every limit the human UI enforces. Gate before spend,
  always.
- **Breaking the file-layout rule breaks the suite — keep it that way.**
  The moment someone adds a convenient static `import` of the pipeline "for
  one helper", `src/mcp.test.js`'s loads-without-the-pipeline assertion is
  the only thing standing between you and a protocol suite that drags the
  whole provider graph into every test run. Put the helper behind the
  dynamic import instead.
- **Don't fork the leaf decisions.** `resolveJsonModel` and the billing
  math exist as leaf modules precisely because the first cut inlined copies
  in both `chat.js` and `mcp.js` and they drifted. Import the leaves;
  never paste.
- **A notification is not a request.** `notifications/initialized` carries
  no `id`; returning a JSON-RPC response to it makes strict clients error
  on an unmatched response. No body, ever.
- **Don't grow inbound model-driven tool selection.** The tempting "let the
  model pick between sub-tools inside the call" is the exact
  function-calling shape PA-1 rules out — it reintroduces catalog-dependent
  behavior on a surface whose whole value is deterministic composability.
- **Write descriptions for the calling model.** The schema descriptions are
  the only documentation the caller's LLM sees; vague descriptions produce
  malformed calls that look like protocol bugs.
- **Verify with the identity you'll operate with.** The live probe needs a
  real authenticated identity (the reference uses the break-glass Basic
  Auth header, since the worker never emits a challenge); a probe that
  skips auth tests a path production never takes.
