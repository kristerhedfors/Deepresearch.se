// @ts-check
// Utilities over the OpenAI-style message array: content is either a plain
// string or a multimodal array of {type:"text",text} and
// {type:"image_url",image_url:{url}} parts.
//
// These traversal helpers manipulate content parts dynamically (mapping over
// a mixed part array, editing the text part in place), so they type content
// as `string | any[]` rather than the precise discriminated `ContentPart`
// union from types.d.ts — that union documents the shape for the pipeline,
// but narrowing it across filter/map here would need casts that add noise
// without adding safety. The precise Conversation/Message types are still
// used where property access is straightforward.

// The starter-prompt tag helpers come from the shared pure core rather than
// the src/starters.js façade on purpose: the façade also re-exports the
// 195-entry registry, and a leaf utility every request imports has no business
// pulling that in. They live in the core (not here) because Se/cure's pipeline
// runs in the BROWSER and has to strip tags with the same code — see the
// starter-tag note below.
export { starterRefOf, withoutStarterTags } from "../public/js/starters-core.js";

/** @typedef {string | any[]} Content */
/** @typedef {{ role?: string, content?: Content }} Msg */

const HISTORY_TURNS = 8; // conversation turns included in LLM prompts

// Text view of a message's content; multimodal arrays become concatenated
// text parts plus an "[N image(s) attached]" marker. Used by the JSON-mode
// helper phases, which are text-only.
/**
 * @param {Content} [content]
 * @returns {string}
 */
export function textOf(content) {
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

/**
 * @param {Msg[]} messages
 * @returns {number}
 */
export function countImages(messages) {
  let n = 0;
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      n += m.content.filter((p) => p?.type === "image_url").length;
    }
  }
  return n;
}

/**
 * @param {Msg[]} conversation
 * @returns {Msg | undefined}
 */
export function lastUserMessage(conversation) {
  return [...conversation].reverse().find((m) => m.role === "user");
}

// The latest user message's text — the ENRICHMENT reading, which is not
// textOf(): text parts are joined with a space and images leave no marker,
// because the callers are intent gates matching phrases across a multipart
// send, not prompt builders describing what was attached.
//
// It exists next to textOf for the pre-pipeline enrichments (src/aadr.js,
// src/models-agent.js, and the same shape introspection uses): they run BEFORE
// pipeline.js builds its ctx, so they read the conversation directly and
// cannot reach ctx.cleanLastUser.
/**
 * @param {Msg[]} conversation
 * @returns {string}
 */
export function lastUserText(conversation) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = conversation[i];
    if (m?.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter((p) => p?.type === "text").map((p) => p.text || "").join(" ");
    }
    return "";
  }
  return "";
}

// Append a context block to a MESSAGE, preserving multipart content (an
// attached image — a photo of an excavation, a screenshot — must survive the
// append). The message-level counterpart of withAppendedText below, and
// deliberately a different shape from it: this one adds a NEW text part rather
// than editing an existing one, so the block reads as its own labeled section
// instead of running on from whatever the user typed.
/**
 * @param {any} message
 * @param {string} block
 * @returns {any}
 */
export function appendToLast(message, block) {
  if (!message) return message;
  if (typeof message.content === "string") {
    return { ...message, content: `${message.content}\n\n${block}` };
  }
  if (Array.isArray(message.content)) {
    return { ...message, content: [...message.content, { type: "text", text: block }] };
  }
  return message;
}

// Text of the user message BEFORE the latest one (the prior turn's question),
// or "" when there is no earlier user turn. Triage's fallback uses it to seed
// a search from the established topic when the latest message is a bare
// back-reference ("undersök saken", "tell me more") whose literal text would
// be a meaningless query on its own.
/**
 * @param {Msg[]} conversation
 * @returns {string}
 */
export function previousUserText(conversation) {
  const users = conversation.filter((m) => m?.role === "user");
  return users.length >= 2 ? textOf(users[users.length - 2].content) : "";
}

// Every user message as plain text, oldest first. The demo registry's stateful
// surfaces need the whole user side rather than the last one or two turns: the
// inline watch builder replays its text commands in order to arrive at the build
// the turn is being answered with (public/js/watch-chat-core.js watchThread),
// and the Worker has to walk the identical list the client walked or the answer
// describes a different watch than the one on screen.
/**
 * @param {Msg[]} conversation
 * @returns {string[]}
 */
export function userTexts(conversation) {
  return (Array.isArray(conversation) ? conversation : [])
    .filter((m) => m?.role === "user")
    .map((m) => textOf(m.content));
}

// Text of the most recent assistant message — the reply the latest user
// message is answering. Triage reads it to notice that it has already asked a
// clarifying question (src/triage.js looksLikeClarifyTurn): the request the
// client sends carries only roles and content, so the previous turn's ROUTE is
// not in it, and the reply itself is the only trace of it.
/**
 * @param {Msg[]} conversation
 * @returns {string}
 */
export function lastAssistantText(conversation) {
  const last = [...conversation].reverse().find((m) => m?.role === "assistant");
  return last ? textOf(last.content) : "";
}

// Image parts of a message's multimodal content (empty for string content).
/**
 * @param {Msg} [message]
 * @returns {any[]}
 */
export function imagePartsOf(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((p) => p?.type === "image_url")
    : [];
}

/**
 * @param {Msg[]} conversation
 * @returns {string}
 */
export function formatConversation(conversation) {
  return conversation
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m.content).slice(0, 2000)}`)
    .join("\n");
}

// Image-only sends ("what is this?" implied) otherwise read as an empty
// message and get ignored: give the model an explicit instruction. Only the
// outgoing copy is modified.
/**
 * @param {Msg[]} conversation
 * @returns {Msg[]}
 */
export function withImageNudge(conversation) {
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

// ---- starter-prompt tags -------------------------------------------------
//
// An evaluation-mode starter chip sends its question with a `#XP-07` tag in
// front (public/js/starters.js), so a reviewer's later "feedback …" note is
// tied to the exact starter by the first message of the conversation — the
// same trick the try-it list plays with `#UC-34`. The tag is for the humans
// and the records; it must never reach a model, because triage would plan
// against it and the search queries would carry it, and then the thing being
// evaluated is no longer the starter.
//
// So the pipeline strips it from its working copy (src/pipeline.js) while
// chat.js keeps the raw conversation for the chat log and the feedback entry.
// Both halves are needed: strip at the request boundary instead and the tag
// never reaches the record that makes it useful. starterRefOf /
// withoutStarterTags are re-exported at the top of this module from
// starters-core.js, which Se/cure's browser pipeline imports directly.

// Appends server-resolved context (e.g. geocode.js's reverse-geocoded photo
// locations) to the LAST message — content the client couldn't have known
// ahead of time. Handles string content, array content with an existing
// text part, and array content with none (image-only send). Non-mutating,
// same convention as withImageNudge; a no-op when there's nothing to add.
/**
 * @param {Msg[]} conversation
 * @param {string} extraText
 * @returns {Msg[]}
 */
export function withAppendedText(conversation, extraText) {
  if (!extraText || conversation.length === 0) return conversation;
  const last = conversation[conversation.length - 1];
  if (typeof last.content === "string") {
    return [...conversation.slice(0, -1), { ...last, content: last.content + extraText }];
  }
  if (Array.isArray(last.content)) {
    const idx = last.content.findIndex((p) => p?.type === "text");
    const content =
      idx >= 0
        ? last.content.map((p, i) => (i === idx ? { ...p, text: p.text + extraText } : p))
        : [{ type: "text", text: extraText }, ...last.content];
    return [...conversation.slice(0, -1), { ...last, content }];
  }
  return conversation;
}

// Appends a server-fetched image (e.g. an enrichment's fetched imagery) as
// an image_url part on the LAST message, so a vision model can see it exactly
// like a user-attached image. String content becomes a two-part array (its
// text plus the image); array content gets the image pushed on the end.
// Non-mutating, same convention as withAppendedText; a no-op when there's no
// url or no last message. Callers must only use this when the answering model
// is vision-capable (Berget rejects images on text-only models).
/**
 * @param {Msg[]} conversation
 * @param {string} url
 * @returns {Msg[]}
 */
export function withAppendedImage(conversation, url) {
  if (!url || conversation.length === 0) return conversation;
  const last = conversation[conversation.length - 1];
  const part = { type: "image_url", image_url: { url } };
  if (typeof last.content === "string") {
    const content = last.content
      ? [{ type: "text", text: last.content }, part]
      : [part];
    return [...conversation.slice(0, -1), { ...last, content }];
  }
  if (Array.isArray(last.content)) {
    return [...conversation.slice(0, -1), { ...last, content: [...last.content, part] }];
  }
  return conversation;
}
