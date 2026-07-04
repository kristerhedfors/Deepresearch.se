// Utilities over the OpenAI-style message array: content is either a plain
// string or a multimodal array of {type:"text",text} and
// {type:"image_url",image_url:{url}} parts.

const HISTORY_TURNS = 8; // conversation turns included in LLM prompts

// Text view of a message's content; multimodal arrays become concatenated
// text parts plus an "[N image(s) attached]" marker. Used by the JSON-mode
// helper phases, which are text-only.
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

export function countImages(messages) {
  let n = 0;
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      n += m.content.filter((p) => p?.type === "image_url").length;
    }
  }
  return n;
}

export function lastUserMessage(conversation) {
  return [...conversation].reverse().find((m) => m.role === "user");
}

// Image parts of a message's multimodal content (empty for string content).
export function imagePartsOf(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((p) => p?.type === "image_url")
    : [];
}

export function formatConversation(conversation) {
  return conversation
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m.content).slice(0, 2000)}`)
    .join("\n");
}

// Image-only sends ("what is this?" implied) otherwise read as an empty
// message and get ignored: give the model an explicit instruction. Only the
// outgoing copy is modified.
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
