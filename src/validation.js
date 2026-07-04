// Request validation for POST /api/chat: message/content shape, image caps,
// and model resolution (catalog membership, availability, vision).

import { defaultModel } from "./berget.js";
import { countImages } from "./conversation.js";

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGES_PER_REQUEST = 8; // history is resent every turn — keep bounded
// Berget rejects request bodies over ~1 MB ("Request payload too large";
// measured 2026-07: 1.0M chars OK, 1.2M rejected). The client downscales
// images to fit; these server caps leave headroom for text/history.
const MAX_IMAGE_CHARS = 300_000; // per image, as a data URL
const MAX_TOTAL_IMAGE_CHARS = 750_000; // per request

// Returns an error string for invalid input, or null when acceptable.
export function validateMessages(messages) {
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

// Resolves the model for a request against the (possibly null) catalog:
// validates the override, checks availability, and enforces vision when the
// conversation carries images. Returns { model } on success or
// { error, status } to reject. Catalog unreachable → fall back to the
// default and let Berget be the judge downstream.
export function resolveModel(body, catalog, env, log) {
  let model = typeof body.model === "string" && body.model ? body.model : null;

  if (model && catalog) {
    const entry = catalog.find((m) => m.id === model);
    if (!entry) {
      log.warn("chat.invalid_model", { model: model.slice(0, 120) });
      return { error: "Unknown model.", status: 400 };
    }
    if (!entry.up) {
      log.warn("chat.model_down", { model: model.slice(0, 120) });
      return {
        error: `${entry.name} is temporarily unavailable (down for maintenance at Berget). Pick another model.`,
        status: 400,
      };
    }
  } else if (model && !catalog) {
    model = null;
  }
  const activeModel = model || defaultModel(env);

  if (countImages(body.messages) > 0 && catalog) {
    const entry = catalog.find((m) => m.id === activeModel);
    if (entry && !entry.vision) {
      const alternatives = catalog
        .filter((m) => m.vision && m.up)
        .map((m) => m.name)
        .join(", ");
      log.warn("chat.model_no_vision", { model: activeModel.slice(0, 120) });
      return {
        error:
          `${entry.name} does not support image input.` +
          (alternatives ? ` Vision-capable models: ${alternatives}.` : ""),
        status: 400,
      };
    }
  }

  return { model: activeModel };
}
