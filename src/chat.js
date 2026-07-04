// POST /api/chat — deep-research pipeline with search iterations and
// post-validation. The Worker orchestrates every phase directly (no function
// calling), so the flow is deterministic and works on any JSON-mode model:
//
//   1. Triage (JSON): direct reply | one clarifying question | research plan
//      with 2-4 search queries covering different angles.
//   2. Search wave: run the planned queries via Exa (deduped, capped).
//   3. Gap check (JSON, up to MAX_GAP_ITERATIONS): audit coverage against
//      the question; run follow-up queries for the most important gaps.
//   4. Synthesis: stream a source-grounded answer with [n] citations and a
//      Sources list, built ONLY from the numbered source registry.
//   5. Post-validation (JSON): fact-check the draft against the sources; on
//      "revise", tell the UI to discard the draft (discard_text) and emit
//      the corrected answer.
//
// Every phase is surfaced to the UI as status events (see CLAUDE.md
// "/api/chat SSE protocol"):
//   step_start   {id, label}                         spinner on
//   step_done    {id, label, details: [string]}      checkmark + expandable
//   search_start {round, query}
//   search_done  {round, query, results, duration_ms, sources}
//   discard_text {}    clear the streamed draft (validation revised it)
//   done         {model, rounds, searches, duration_ms, prompt_tokens,
//                 completion_tokens, co2_grams}
//
// Helper phases fail soft: if triage / gap check / validation error or
// return unparseable JSON, the pipeline degrades (single search, skip
// iteration, accept draft) rather than failing the request.

import {
  chatCompletion,
  completeJson,
  consumeChatStream,
  defaultModel,
  listModels,
} from "./berget.js";
import { webSearch } from "./exa.js";
import { jsonResponse } from "./http.js";

const MAX_INITIAL_QUERIES = 4;
const MAX_GAP_ITERATIONS = 2;
const MAX_FOLLOWUP_QUERIES = 3;
const MAX_TOTAL_SEARCHES = 8;
const MAX_SOURCES = 18; // registry cap fed to synthesis/validation
const DIGEST_CHAR_CAP = 14_000;
const HISTORY_TURNS = 8; // conversation turns included in prompts
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGES_PER_REQUEST = 8; // history is resent every turn — keep bounded
// Berget rejects request bodies over ~1 MB ("Request payload too large";
// measured 2026-07: 1.0M chars OK, 1.2M rejected). The client downscales
// images to fit; these server caps leave headroom for text/history.
const MAX_IMAGE_CHARS = 300_000; // per image, as a data URL
const MAX_TOTAL_IMAGE_CHARS = 750_000; // per request

const today = () => new Date().toISOString().slice(0, 10);

const TRIAGE_PROMPT = () =>
  `You are the research planner for Deepresearch.se, a deep-research assistant. Today's date: ${today()}.\n` +
  "Decide how to handle the user's LATEST message given the conversation. Respond ONLY with a JSON object:\n" +
  '- {"action":"direct"} — small talk, thanks, questions about this site, or simple stable facts that need no web sources.\n' +
  '- {"action":"clarify","question":"..."} — a research request missing details (scope, timeframe, region, purpose) that would materially change what to search. Ask exactly ONE short question.\n' +
  '- {"action":"research","queries":["...","..."]} — a research request that is clear enough. Provide 2-4 distinct, specific web-search queries covering different angles (latest developments, official/primary sources, data and numbers, criticism or risks — as applicable). Queries must be self-contained (no pronouns).\n' +
  'Messages may carry attached images (shown as "[N image(s) attached]"). Questions about the attached image itself (identify, describe, read, count, colors, "what is this") MUST be "direct" — web search cannot see images. Choose "research" for an image question only when external facts are also needed (e.g. news or prices about the thing in the image), and then write queries about the topic, never about "the image".';

const GAP_PROMPT = (pastQueries) =>
  `You audit research coverage for Deepresearch.se. Today's date: ${today()}.\n` +
  "Given the research question and the sources collected so far, respond ONLY with JSON:\n" +
  '- {"complete":true} if the sources cover the question well enough for a grounded answer.\n' +
  '- {"complete":false,"queries":["..."]} otherwise, with 1-3 NEW web-search queries targeting the most important gaps (missing angles, missing numbers, unverified key claims).\n' +
  `Do not repeat or trivially rephrase these already-run queries: ${JSON.stringify(pastQueries)}`;

const SYNTH_PROMPT = () =>
  `You are the research assistant for Deepresearch.se. Today's date: ${today()}.\n` +
  "Write a research answer to the user's question using ONLY the numbered sources provided.\n" +
  "Format in Markdown (the UI renders it):\n" +
  "- Start with a 1-3 sentence conclusion in bold.\n" +
  "- Then the key findings as short sections or bullet lists; cite sources inline with bracketed numbers like [1], [2] after each claim. Use tables when comparing figures.\n" +
  '- End with a "Sources:" section listing each cited source as "- [n] Title — URL".\n' +
  "Be honest about gaps and conflicting sources. If the sources are empty or insufficient, say so plainly and clearly label any general-knowledge statements as not source-backed.";

const VALIDATE_PROMPT =
  "You are a strict fact-checker for Deepresearch.se. You receive a research question, numbered sources, and a draft answer.\n" +
  "Check: (1) every factual claim in the draft is supported by the cited source; (2) every [n] citation and URL in the draft matches the provided source list; (3) no invented URLs, numbers, or quotes; (4) important caveats from the sources are not dropped.\n" +
  "Respond ONLY with JSON:\n" +
  '- {"verdict":"pass"} if the draft is faithful to the sources.\n' +
  '- {"verdict":"revise","issues":["..."],"revised_answer":"..."} if you found problems. revised_answer must be the complete corrected answer in the same format, changing only what is needed to fix the issues.';

const DIRECT_PROMPT =
  "You are the assistant for Deepresearch.se, a deep-research service. Reply directly, helpfully, and concisely.";

export async function handleChat(request, env, log) {
  if (!env.BERGET_API_TOKEN) {
    log.error("chat.misconfigured", { missing: "BERGET_API_TOKEN" });
    return jsonResponse(
      { error: "Server not configured: BERGET_API_TOKEN secret is missing." },
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const invalid = validateMessages(body?.messages);
  if (invalid) {
    log.warn("chat.invalid_request", { reason: invalid });
    return jsonResponse({ error: invalid }, 400);
  }

  // Optional model override from the UI dropdown, validated against the
  // catalog. If the catalog is unreachable, fall back to the default rather
  // than blocking chat.
  let catalog = null;
  try {
    catalog = await listModels(env);
  } catch (err) {
    log.warn("chat.model_catalog_unavailable", { error: err?.message || String(err) });
  }

  let model = typeof body.model === "string" && body.model ? body.model : null;
  if (model && catalog) {
    const entry = catalog.find((m) => m.id === model);
    if (!entry) {
      log.warn("chat.invalid_model", { model: model.slice(0, 120) });
      return jsonResponse({ error: "Unknown model." }, 400);
    }
    if (!entry.up) {
      log.warn("chat.model_down", { model: model.slice(0, 120) });
      return jsonResponse(
        { error: `${entry.name} is temporarily unavailable (down for maintenance at Berget). Pick another model.` },
        400,
      );
    }
  } else if (model && !catalog) {
    model = null;
  }
  const activeModel = model || defaultModel(env);
  const conversation = body.messages;

  // Image attachments require a vision-capable model. If the catalog is
  // unavailable we let Berget be the judge (its error surfaces upstream).
  if (countImages(conversation) > 0 && catalog) {
    const entry = catalog.find((m) => m.id === activeModel);
    if (entry && !entry.vision) {
      const alternatives = catalog
        .filter((m) => m.vision && m.up)
        .map((m) => m.name)
        .join(", ");
      log.warn("chat.model_no_vision", { model: activeModel.slice(0, 120) });
      return jsonResponse(
        {
          error:
            `${entry.name} does not support image input.` +
            (alternatives ? ` Vision-capable models: ${alternatives}.` : ""),
        },
        400,
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const startedAt = Date.now();
      const state = {
        searchCount: 0,
        iterations: 1,
        ranQueries: new Set(),
        sources: [],
        byUrl: new Map(),
        totals: { prompt_tokens: 0, completion_tokens: 0, co2_grams: 0 },
      };

      try {
        await runPipeline(env, log, emit, conversation, activeModel, state);
      } catch (err) {
        log.error("chat.stream_failed", { error: err?.message || String(err) });
        emit({ error: "Worker error: " + (err?.message || String(err)) });
      } finally {
        const duration_ms = Date.now() - startedAt;
        log.info("chat.complete", {
          model: activeModel,
          rounds: state.iterations,
          searches: state.searchCount,
          sources: state.sources.length,
          duration_ms,
        });
        emit({
          status: {
            type: "done",
            model: activeModel,
            rounds: state.iterations,
            searches: state.searchCount,
            duration_ms,
            prompt_tokens: state.totals.prompt_tokens,
            completion_tokens: state.totals.completion_tokens,
            co2_grams: state.totals.co2_grams,
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

async function runPipeline(env, log, emit, conversation, model, state) {
  const lastUserMsg = [...conversation].reverse().find((m) => m.role === "user");
  const lastUser = textOf(lastUserMsg?.content);
  // Image parts of the latest user message ride along into synthesis so a
  // vision model can research with the image as context.
  const imageParts = Array.isArray(lastUserMsg?.content)
    ? lastUserMsg.content.filter((p) => p?.type === "image_url")
    : [];
  const convText = formatConversation(conversation);
  const emitDelta = (t) => emit({ choices: [{ delta: { content: t } }] });

  // ---- Phase 1: triage --------------------------------------------------
  emit({ status: { type: "step_start", id: "plan", label: "Analyzing request…" } });
  const triage = await phase(log, "triage", () =>
    completeJson(
      env,
      [
        { role: "system", content: TRIAGE_PROMPT() },
        { role: "user", content: `Conversation:\n${convText}\n\nLatest user message:\n${lastUser}` },
      ],
      { model, maxTokens: 500 },
    ).then((r) => {
      addUsage(state.totals, r.usage);
      return r.value;
    }),
  );

  const decision = normalizeTriage(triage, lastUser);

  if (decision.action === "direct") {
    emit({ status: { type: "step_done", id: "plan", label: "Direct reply (no research needed)", details: [] } });
    await streamCompletion(
      env,
      [{ role: "system", content: DIRECT_PROMPT }, ...withImageNudge(conversation)],
      model,
      emitDelta,
      state,
    );
    return;
  }

  if (decision.action === "clarify") {
    emit({ status: { type: "step_done", id: "plan", label: "Need to narrow the scope first", details: [] } });
    emitChunked(emitDelta, decision.question);
    return;
  }

  const queries = decision.queries.slice(0, MAX_INITIAL_QUERIES);
  emit({
    status: {
      type: "step_done",
      id: "plan",
      label: `Planned ${queries.length} search angle${queries.length === 1 ? "" : "s"}`,
      details: queries,
    },
  });

  // ---- Phase 2: initial search wave --------------------------------------
  await runSearches(env, log, emit, state, queries, 1);

  // ---- Phase 3: gap-check iterations --------------------------------------
  for (let it = 1; it <= MAX_GAP_ITERATIONS; it++) {
    if (state.searchCount >= MAX_TOTAL_SEARCHES) break;
    const stepId = `gap${it}`;
    emit({ status: { type: "step_start", id: stepId, label: `Checking coverage (round ${it})…` } });

    const gap = await phase(log, `gap_check_${it}`, () =>
      completeJson(
        env,
        [
          { role: "system", content: GAP_PROMPT([...state.ranQueries]) },
          {
            role: "user",
            content: `Research question:\n${lastUser}\n\nSources collected so far:\n${sourceDigest(state.sources) || "(none)"}`,
          },
        ],
        { model, maxTokens: 400 },
      ).then((r) => {
        addUsage(state.totals, r.usage);
        return r.value;
      }),
    );

    const followups = (!gap || gap.complete || !Array.isArray(gap.queries))
      ? []
      : gap.queries.filter((q) => typeof q === "string" && q.trim()).slice(0, MAX_FOLLOWUP_QUERIES);

    if (followups.length === 0) {
      emit({ status: { type: "step_done", id: stepId, label: "Coverage sufficient", details: [] } });
      break;
    }
    emit({
      status: {
        type: "step_done",
        id: stepId,
        label: `Digging deeper: ${followups.length} follow-up search${followups.length === 1 ? "" : "es"}`,
        details: followups,
      },
    });
    state.iterations++;
    await runSearches(env, log, emit, state, followups, state.iterations);
  }

  // ---- Phase 4: synthesis (streamed draft) --------------------------------
  emit({ status: { type: "step_start", id: "synth", label: "Writing report…" } });
  const digest = sourceDigest(state.sources);
  const synthText =
    `Question:\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
    `Numbered sources:\n${digest || "(none — searches returned nothing usable)"}\n\nWrite the answer now.`;
  const draft = await streamCompletion(
    env,
    [
      { role: "system", content: SYNTH_PROMPT() },
      {
        role: "user",
        content: imageParts.length
          ? [{ type: "text", text: synthText }, ...imageParts]
          : synthText,
      },
    ],
    model,
    emitDelta,
    state,
  );
  emit({ status: { type: "step_done", id: "synth", label: "Report drafted", details: [] } });

  // ---- Phase 5: post-validation -------------------------------------------
  emit({ status: { type: "step_start", id: "validate", label: "Validating claims against sources…" } });
  const verdict = await phase(log, "validate", () =>
    completeJson(
      env,
      [
        { role: "system", content: VALIDATE_PROMPT },
        {
          role: "user",
          content: `Research question:\n${lastUser}\n\nNumbered sources:\n${digest || "(none)"}\n\nDraft answer:\n${draft}`,
        },
      ],
      { model, maxTokens: 3000 },
    ).then((r) => {
      addUsage(state.totals, r.usage);
      return r.value;
    }),
  );

  if (verdict?.verdict === "revise" && typeof verdict.revised_answer === "string" && verdict.revised_answer.trim()) {
    const issues = (Array.isArray(verdict.issues) ? verdict.issues : []).map(String).slice(0, 10);
    emit({
      status: {
        type: "step_done",
        id: "validate",
        label: `Fixed ${issues.length || "some"} issue${issues.length === 1 ? "" : "s"} found in fact-check`,
        details: issues,
      },
    });
    emit({ status: { type: "discard_text" } });
    emitChunked(emitDelta, verdict.revised_answer.trim());
  } else if (verdict?.verdict === "pass") {
    emit({ status: { type: "step_done", id: "validate", label: "All claims verified against sources", details: [] } });
  } else {
    emit({ status: { type: "step_done", id: "validate", label: "Validation inconclusive — draft kept as-is", details: [] } });
  }
}

// ---- helpers ---------------------------------------------------------------

// Runs a helper phase, logging duration; returns null on failure so the
// pipeline can degrade instead of breaking.
async function phase(log, name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    log.info("chat.phase", { phase: name, duration_ms: Date.now() - startedAt, ok: result != null });
    return result;
  } catch (err) {
    log.warn("chat.phase_failed", {
      phase: name,
      duration_ms: Date.now() - startedAt,
      error: err?.message || String(err),
    });
    return null;
  }
}

function normalizeTriage(triage, lastUser) {
  if (triage?.action === "clarify" && typeof triage.question === "string" && triage.question.trim()) {
    return { action: "clarify", question: triage.question.trim() };
  }
  if (triage?.action === "research") {
    const queries = (Array.isArray(triage.queries) ? triage.queries : [])
      .filter((q) => typeof q === "string" && q.trim());
    if (queries.length > 0) return { action: "research", queries };
  }
  if (triage?.action === "direct") return { action: "direct" };
  // Triage failed: research with the raw question when it looks substantial,
  // otherwise answer directly.
  return lastUser.trim().length >= 12
    ? { action: "research", queries: [lastUser.trim().slice(0, 300)] }
    : { action: "direct" };
}

async function runSearches(env, log, emit, state, queries, round) {
  for (const raw of queries) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (state.ranQueries.has(key)) continue;
    if (state.searchCount >= MAX_TOTAL_SEARCHES) break;
    state.ranQueries.add(key);
    state.searchCount++;

    emit({ status: { type: "search_start", round, query } });
    const result = await webSearch(env, log, query);
    emit({
      status: {
        type: "search_done",
        round,
        query,
        results: result.resultCount,
        duration_ms: result.durationMs,
        sources: result.sources,
      },
    });
    addSources(state, result.items);
  }
}

function addSources(state, items) {
  for (const item of items || []) {
    if (!item?.url || state.byUrl.has(item.url)) continue;
    if (state.sources.length >= MAX_SOURCES) return;
    const entry = {
      n: state.sources.length + 1,
      title: item.title || item.url,
      url: item.url,
      highlights: (item.highlights || []).slice(0, 3),
    };
    state.byUrl.set(item.url, entry);
    state.sources.push(entry);
  }
}

function sourceDigest(sources, capChars = DIGEST_CHAR_CAP) {
  const blocks = [];
  let used = 0;
  for (const s of sources) {
    const block = `[${s.n}] ${s.title}\n${s.url}\n${s.highlights.join(" … ")}`.trim();
    if (used + block.length > capChars) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}

// Streams one chat completion to the client; returns the full text.
async function streamCompletion(env, messages, model, emitDelta, state) {
  const upstream = await chatCompletion(env, messages, { model });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(`Berget API error (${upstream.status}): ${detail.slice(0, 300)}`);
  }
  const { text, usage } = await consumeChatStream(upstream.body, emitDelta);
  addUsage(state.totals, usage);
  return text;
}

function emitChunked(emitDelta, text) {
  for (let i = 0; i < text.length; i += 80) {
    emitDelta(text.slice(i, i + 80));
  }
}

function addUsage(totals, usage) {
  if (!usage) return;
  totals.prompt_tokens += usage.prompt_tokens || 0;
  totals.completion_tokens += usage.completion_tokens || 0;
  totals.co2_grams += usage.co2_grams || 0;
}

// Image-only sends ("what is this?" implied) otherwise read as an empty
// message and get ignored: give the model an explicit instruction. Only the
// outgoing copy is modified.
function withImageNudge(conversation) {
  const last = conversation[conversation.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return conversation;
  const hasText = last.content.some((p) => p?.type === "text" && p.text.trim());
  const hasImage = last.content.some((p) => p?.type === "image_url");
  if (hasText || !hasImage) return conversation;
  return [
    ...conversation.slice(0, -1),
    {
      ...last,
      content: [
        { type: "text", text: "(No text was provided.) Describe and analyze the attached image(s) helpfully." },
        ...last.content,
      ],
    },
  ];
}

// Text view of a message's content: string content as-is; multimodal arrays
// as concatenated text parts plus an "[N image(s) attached]" marker. Used for
// the JSON-mode helper phases, which are text-only.
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    const images = content.filter((p) => p?.type === "image_url").length;
    return images
      ? `${text}${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"} attached]`
      : text;
  }
  return "";
}

function countImages(messages) {
  let n = 0;
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      n += m.content.filter((p) => p?.type === "image_url").length;
    }
  }
  return n;
}

function formatConversation(conversation) {
  return conversation
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m.content).slice(0, 2000)}`)
    .join("\n");
}

// Returns an error string for invalid input, or null when acceptable.
// Content is either a plain string or an OpenAI-style multimodal array of
// {type:"text",text} and {type:"image_url",image_url:{url:"data:image/…"}}.
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "Expected a non-empty `messages` array.";
  }
  if (messages.length > MAX_MESSAGES) {
    return `Conversation too long (max ${MAX_MESSAGES} messages). Start a new chat.`;
  }
  let totalImages = 0;
  let totalImageChars = 0;
  for (const m of messages) {
    if (m?.role !== "user" && m?.role !== "assistant") {
      return "Each message must have role `user` or `assistant`.";
    }
    if (typeof m.content === "string") {
      if (m.content.length > MAX_MESSAGE_CHARS) {
        return `A message exceeds the ${MAX_MESSAGE_CHARS}-character limit.`;
      }
      continue;
    }
    if (!Array.isArray(m.content) || m.content.length === 0) {
      return "Each message `content` must be a string or a non-empty array of parts.";
    }
    let textChars = 0;
    let images = 0;
    for (const part of m.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        textChars += part.text.length;
      } else if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
        const url = part.image_url.url;
        if (!url.startsWith("data:image/")) {
          return "Images must be attached as data:image/… URLs.";
        }
        if (url.length > MAX_IMAGE_CHARS) {
          return "An attached image is too large after encoding (~220 KB max per image). Reload the page — it now compresses images automatically.";
        }
        images++;
        totalImages++;
        totalImageChars += url.length;
      } else {
        return "Unsupported message content part.";
      }
    }
    if (textChars > MAX_MESSAGE_CHARS) {
      return `A message exceeds the ${MAX_MESSAGE_CHARS}-character limit.`;
    }
    if (images > MAX_IMAGES_PER_MESSAGE) {
      return `Too many images in one message (max ${MAX_IMAGES_PER_MESSAGE}).`;
    }
  }
  if (totalImages > MAX_IMAGES_PER_REQUEST) {
    return `Too many images in the conversation (max ${MAX_IMAGES_PER_REQUEST}). Start a new chat.`;
  }
  if (totalImageChars > MAX_TOTAL_IMAGE_CHARS) {
    return "The attached images together exceed the provider's request size limit. Remove an image or start a new chat.";
  }
  return null;
}
