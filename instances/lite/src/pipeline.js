// @ts-check
// The deterministic deep-research pipeline (research-pipeline module). No
// function calling (PA-1): triage is a JSON-mode completion, synthesis is a
// streamed completion, and the orchestrator picks every query and phase. Helper
// phases fail soft (PA-2): a failed triage falls back model-free, a failed
// search yields an empty digest, and synthesis streams whatever it can — the
// chat never errors out. Split routing (PA-3): triage runs on the fixed reliable
// JSON_MODEL, synthesis on the user's chosen model.
//
// The flow emits a small SSE event vocabulary (see public/js/sse.js + app.js):
//   {type:"status", phase}                       phase marker
//   {type:"search_start", query}                 a search wave began
//   {type:"search_done", query, results, sources} a wave resolved
//   {type:"delta", text}                          an answer token chunk
//   {type:"done", model, searches, ms}            stats footer
//   [DONE]                                        terminator (always sent)

import { jsonCompletion, streamCompletion, safeParseJson } from "./berget.js";
import { webSearch } from "./exa.js";
import { triageSchema, normalizeTriage } from "./triage.js";
import { hardenJson } from "./schema.js";
import { triagePrompt, synthesisPrompt } from "./prompts.js";
import { JSON_MODEL, answerModel, searchEnabled } from "./config.js";

const MAX_QUERIES = 4;

/**
 * @param {any} env
 * @param {import('./log.js').Logger} log
 * @param {{ messages: {role:string,content:string}[], model?: string }} body
 * @param {{ jsonCompletion?: Function, streamCompletion?: Function, webSearch?: Function }} [deps]
 * @returns {ReadableStream}
 */
export function runPipeline(env, log, body, deps = {}) {
  const _json = deps.jsonCompletion || jsonCompletion;
  const _stream = deps.streamCompletion || streamCompletion;
  const _search = deps.webSearch || webSearch;

  const encoder = new TextEncoder();
  const started = Date.now();

  return new ReadableStream({
    async start(controller) {
      /** @param {any} obj */
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const model = body.model || answerModel(env);
      let searches = 0;

      try {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const userTurns = messages.filter((m) => m.role === "user");
        const lastUser = userTurns[userTurns.length - 1]?.content || "";
        const priorUser = userTurns[userTurns.length - 2]?.content || "";

        // ---- Phase 1: triage (JSON model, split routing) -----------------
        send({ type: "status", phase: "triage" });
        let plan;
        if (searchEnabled(env)) {
          const raw = await _json(env, log, {
            model: JSON_MODEL,
            messages: triagePrompt(lastUser, priorUser),
            maxTokens: 400,
          }).catch(() => null);
          const parsed = raw && typeof raw === "object" ? raw : safeParseJson(String(raw ?? ""));
          const hardened = parsed ? hardenJson(triageSchema, parsed) : null;
          plan = normalizeTriage(hardened, lastUser, priorUser);
        } else {
          // Search disabled — answer directly.
          plan = { mode: "direct", queries: [] };
        }

        // ---- Phase 2: search waves (fail soft, concurrent) ---------------
        let digest = "";
        /** @type {{title:string,url:string}[]} */
        let allSources = [];
        if (plan.mode === "research" && plan.queries.length) {
          const queries = plan.queries.slice(0, MAX_QUERIES);
          queries.forEach((q) => send({ type: "search_start", query: q }));
          const results = await Promise.all(
            queries.map((q) =>
              Promise.resolve(_search(env, log, q, { numResults: 5 })).catch(() => ({
                content: "",
                sources: [],
                resultCount: 0,
              })),
            ),
          );
          const parts = [];
          results.forEach((r, i) => {
            searches++;
            send({ type: "search_done", query: queries[i], results: r.resultCount || 0, sources: r.sources || [] });
            if (r.content) parts.push(r.content);
            if (Array.isArray(r.sources)) allSources = dedupeSources(allSources.concat(r.sources));
          });
          digest = renumberDigest(parts);
        }

        // ---- Phase 3: synthesis (answer model, streamed) -----------------
        send({ type: "status", phase: "synthesis" });
        const history = messages.slice(0, -1).filter((m) => m.role === "user" || m.role === "assistant");
        let any = false;
        for await (const delta of _stream(env, log, {
          model,
          messages: synthesisPrompt(lastUser, digest, history),
          maxTokens: 1600,
        })) {
          any = true;
          send({ type: "delta", text: delta });
        }
        if (!any) {
          // Total synthesis failure — degrade to a plain, honest message rather
          // than an empty bubble (PA-2).
          send({ type: "delta", text: "I couldn't produce an answer just now. Please try again." });
        }

        send({ type: "done", model, searches, ms: Date.now() - started, sources: allSources });
      } catch (e) {
        log.error("pipeline.error", { message: String(e && /** @type {any} */ (e).message) });
        send({ type: "delta", text: "Something went wrong while researching. Please try again." });
        send({ type: "done", model, searches, ms: Date.now() - started });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

/** @param {{title:string,url:string}[]} sources */
function dedupeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out.slice(0, 20);
}

/**
 * Concatenate per-wave digests into one stream renumbered from [1], so the
 * citation numbers synthesis sees are contiguous regardless of wave order.
 * @param {string[]} parts
 * @returns {string}
 */
export function renumberDigest(parts) {
  let n = 0;
  const lines = [];
  for (const part of parts) {
    for (const block of String(part).split(/\n\n+/)) {
      const b = block.trim();
      if (!b) continue;
      n++;
      lines.push(b.replace(/^\[\d+\]\s*/, `[${n}] `));
    }
  }
  return lines.join("\n\n");
}
