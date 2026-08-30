# Berget tool calling — measured, per model

The new main research path hands the ANSWER model a tool array and lets it drive
its own loop. That only works if the provider serving the model can actually do
it — and Berget is the primary provider, so "can it" is not a question to answer
from a capability field nobody publishes.

Measured **2026-08-29** against the live catalog with a two-round probe: one
call carrying a tool array, then a second carrying the assistant's turn back
plus a `tool` message with the result. Round two is the half that matters — a
model that emits a tool call and then cannot be told the answer has not got a
loop, it has a dead end.

`scripts/berget-tool-probe.mjs`, whole catalog, nine chat models:

| model | emits `tool_calls` | round 2, verbatim echo | round 2, narrowed echo |
|---|---|---|---|
| `mistralai/Mistral-Small-3.2-24B-Instruct-2506` | yes | **400** | yes |
| `openai/gpt-oss-120b` | yes | **400** | yes |
| `zai-org/GLM-4.7-FP8` | yes | **400** | yes |
| `meta-llama/Llama-3.3-70B-Instruct` | yes | **400** | yes |
| `Qwen/Qwen3.8-27B-FP8` | yes | yes | yes |
| `zai-org/GLM-5.2` | yes | yes | yes |
| `zai-org/GLM-5.3` | yes | yes | yes |
| `moonshotai/Kimi-K3` | yes | yes | yes |
| `google/gemma-4-31B-it` | yes | yes | yes |

**All nine chat models emit well-formed tool calls, and all nine complete the
loop once the echo is narrowed.** That is the headline, and it is what makes the
agentic path viable on the PRIMARY provider rather than only on Anthropic — the
thing CLAUDE.md's invariant 1 was written around when no such measurement
existed.

**Four of the nine fail the naive implementation**, and the split does not
follow vendor, size or family: two GLM builds land on opposite sides of it. So
this is not a property you can reason your way to from a model card — it is a
per-deployment serving detail, which is why there is a probe.

## The trap: a provider that rejects its own message

Four of the nine fail round two if you echo the assistant turn back the way the
wire format's own documentation implies — verbatim:

```
body/messages/1/function_call Invalid input: expected object, received null
```

The message the provider RETURNED looks like this:

```json
{ "role": "assistant", "content": null, "reasoning": null,
  "tool_calls": [ … ], "function_call": null, "refusal": null,
  "annotations": null, "audio": null }
```

`function_call: null` is in what it sent. Its own request validator then refuses
that null on the way back in. So the obvious implementation — and the one the
Anthropic dialect actually requires, where the assistant's content blocks must
go back untouched — is wrong here, on the fixed planning model this whole
project routes JSON to.

The fix is to echo only the three fields the wire defines:

```js
messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls })
```

with `content` narrowed from `null` to `""` at the same time. All nine models
then complete the loop. `src/tool-run.js` does this, and
`src/tool-run.test.js` pins it — the failure is invisible until round two, which
is exactly the kind of defect a unit test has to hold in place.

## Re-running the probe

Do not quote this table as current. Berget's catalog moves, and a model id here
may not exist next month.

```bash
BERGET_API_KEY=… node scripts/berget-tool-probe.mjs        # every chat model in the catalog
BERGET_API_KEY=… node scripts/berget-tool-probe.mjs <model> [<model> …]
```

The probe is deliberately a two-round round trip rather than a capability
lookup: the first round tells you the model will emit a call, and only the
second tells you the loop closes.
