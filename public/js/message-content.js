// Pure builders for the /api/chat message the composer sends — the labeled
// text blocks (inline documents, image metadata, RAG retrieval excerpts)
// and the message-array transforms (title derivation, history image
// stripping) that stream.js assembles around its DOM/network/state
// orchestration. Kept import-free so the Node unit suite exercises them
// directly, the same pattern as project-context.js and rag.js's pure core.
//
// The labeled-block convention (--- Attached document: … --- / --- Image
// metadata: … ---) is shared with the server-side context blocks
// (src/conversation.js's withAppendedText) and the project-materials block
// (project-context.js): each piece of research material is its own clearly
// delimited block, never silently blended into the user's text.

// How long a streaming /api/chat connection may go silent before stream.js
// treats it as dead and switches to answer recovery. The server emits a
// `: keepalive` line every 15s even during quiet phases (triage/gap/
// validation produce no user-visible bytes for tens of seconds), so a
// healthy stream never goes silent this long — only a torn-down connection
// does. This is the core of the "switched to another app" fix: iOS freezes
// a backgrounded PWA and tears down its socket, and on return the dead
// `reader.read()` often just HANGS with no error, so nothing would trigger
// recovery without this watchdog. 30s = 2× keepalive plus margin.
export const STREAM_STALL_MS = 30000;

// Whether a stream should be considered stalled (dead) right now: silent
// past the stall window AND currently in the foreground. The foreground
// gate matters because a backgrounded tab's JS is frozen — its timers don't
// fire while hidden, and elapsed wall-clock time while hidden must not by
// itself count as a stall (the connection may resume fine on return). On
// return to foreground stream.js resets the silence clock, granting a fresh
// full window for the connection to prove it's alive before this trips.
export function isStreamStale(lastByteAt, now, hidden, stallMs = STREAM_STALL_MS) {
  if (hidden) return false;
  return now - lastByteAt > stallMs;
}

// Per-question excerpt budget for RAG retrieval blocks: generous enough for
// real answers, small enough that history-resending never approaches the
// server's 32K message cap.
export const EXCERPT_TOTAL_CHARS = 12000;

// Per-excerpt cap inside a retrieval block — one chunk never crowds out the
// others when several docs are relevant to the same question.
const EXCERPT_CHUNK_CHARS = 1600;

// Title for the encrypted local-history sidebar: the first user message's
// text, trimmed to a sidebar-friendly length. Handles both string content
// and multimodal arrays (uses the first text part).
export function deriveTitle(history) {
  const first = history.find((m) => m.role === "user");
  const text =
    typeof first?.content === "string"
      ? first.content
      : (first?.content || []).find((p) => p.type === "text")?.text || "";
  return text.trim().slice(0, 60) || "New conversation";
}

// Keep images only on the latest message when sending: history is resent
// every turn and would otherwise re-inflate each request past the provider's
// ~1 MB body limit. Older user turns keep their text plus a marker; the
// latest message and all non-user/string messages pass through untouched.
export function stripOldImages(history) {
  return history.map((m, i) => {
    if (i === history.length - 1 || m.role !== "user" || typeof m.content === "string") return m;
    const text = m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return {
      role: "user",
      content: (text ? text + "\n" : "") + "[image was attached earlier in this conversation]",
    };
  });
}

// A user message's content split into display text + image data URLs — for
// re-hydrating the assistant turn on a boot resume (stream.js), so its PDF
// report keeps the title/images a live turn would have had. Handles both
// string content and multimodal arrays.
export function splitUserContent(content) {
  if (typeof content === "string") return { text: content, imageUrls: [] };
  if (Array.isArray(content)) {
    return {
      text: content.filter((p) => p?.type === "text").map((p) => p.text).join("\n"),
      imageUrls: content.filter((p) => p?.type === "image_url").map((p) => p.image_url?.url).filter(Boolean),
    };
  }
  return { text: "", imageUrls: [] };
}

// ---- Copy-conversation export ----------------------------------------------
// Plain-text export of a conversation for the header's copy-to-clipboard
// button (app.js): one labeled paragraph per turn ("User: …" /
// "Assistant: …"), blank-line separated. Non-text content is REFERENCED,
// never dumped — attached images become "[Image attached]" lines and every
// appended context block (inline documents, retrieval excerpts, project
// materials, related project chats) collapses to a one-line reference
// carrying its display name, so the reader gets the conversation, not
// kilobytes of excerpt plumbing. Image-metadata blocks are dropped
// outright: the image reference already stands for the image.

// Where the appended labeled blocks begin in a user message's text — the
// same block family chat-rag.js strips before indexing (kept in sync with
// inlineDocBlock / ragExcerptBlocks / project-context.js / the image-
// metadata block below).
const APPENDED_BLOCK = /\n\n--- (Attached document:|Project:|Related project chat:|Image metadata:)/;

// One appended block's opening line, capturing kind + display name.
const BLOCK_OPENER = /^--- (Attached document|Related project chat|Project|Image metadata): (.*?) ---$/gm;

// The block openers decorate the name with a parenthetical descriptor
// ("(truncated)", "(large document, indexed for retrieval — …)", "(an
// earlier conversation in this project, …)") — strip it for the reference.
function blockRefName(name) {
  return name.replace(/ \((?:truncated|large document[^)]*|an earlier conversation[^)]*)\)$/, "").trim();
}

export function conversationCopyText(messages) {
  const out = [];
  for (const m of messages || []) {
    const { text, imageUrls } = splitUserContent(m?.content);
    const refs = [];
    let main = text;
    const cut = main.search(APPENDED_BLOCK);
    if (cut >= 0) {
      for (const [, kind, name] of main.slice(cut).matchAll(BLOCK_OPENER)) {
        if (kind === "Image metadata") continue;
        refs.push(`[${kind === "Project" ? "Project materials" : kind}: ${blockRefName(name)}]`);
      }
      main = main.slice(0, cut);
    }
    imageUrls.forEach((_, i) => {
      refs.push(imageUrls.length > 1 ? `[Image ${i + 1} attached]` : "[Image attached]");
    });
    const body = [main.trim(), ...refs].filter(Boolean).join("\n");
    if (!body) continue;
    out.push((m?.role === "assistant" ? "Assistant: " : "User: ") + body);
  }
  return out.join("\n\n");
}

// One inline (non-RAG) document as a labeled text block: the doc's parsed
// text, its extracted metadata (docProps / tracked changes / PDF Info dict —
// see docs.js) as its own sub-block, and a truncation marker when the parse
// hit the inline char cap.
export function inlineDocBlock(doc) {
  return (
    `\n\n--- Attached document: ${doc.name}${doc.truncated ? " (truncated)" : ""} ---\n` +
    (doc.metadata ? `[Document metadata]\n${doc.metadata}\n\n` : "") +
    doc.text +
    "\n--- End of document ---"
  );
}

// An image's extracted metadata (EXIF — capture time/place/device, see
// exif.js) as its own labeled block. Returns "" for an image that carried
// none, so the caller can append unconditionally.
export function imageMetadataBlock(image) {
  if (!image.metadata) return "";
  return `\n\n--- Image metadata: ${image.name} ---\n${image.metadata}\n--- End of image metadata ---`;
}

// The RAG retrieval blocks: the pure assembly half of stream.js's
// buildRagBlocks (retrieval itself stays there — it's async/network). Groups
// the retrieved `matches` ({docId, seq, text}) back under their documents,
// enforces a per-excerpt cap and a total char budget, and formats one
// labeled block per document. `names` maps docId → display name and
// `metaByDoc` maps docId → extracted metadata (both Maps). `chatDocIds`
// (a Set) marks docs that are indexed PROJECT CHATS (chat-rag.js) — those
// get a header saying what they actually are (an earlier conversation in
// this project) instead of the attached-document one. Returns "" when
// nothing survives the budget.
export function ragExcerptBlocks(matches, names, metaByDoc, totalBudget = EXCERPT_TOTAL_CHARS, chatDocIds = new Set()) {
  const byDoc = new Map();
  let used = 0;
  for (const m of matches) {
    if (used >= totalBudget) break;
    const excerpt = m.text.slice(0, Math.min(EXCERPT_CHUNK_CHARS, totalBudget - used));
    if (!excerpt.trim()) continue;
    used += excerpt.length;
    if (!byDoc.has(m.docId)) byDoc.set(m.docId, []);
    byDoc.get(m.docId).push({ seq: m.seq, text: excerpt });
  }

  let out = "";
  for (const [docId, excerpts] of byDoc) {
    const meta = metaByDoc.get(docId);
    if (chatDocIds.has(docId)) {
      const name = names.get(docId) || "Untitled chat";
      out +=
        `\n\n--- Related project chat: ${name} (an earlier conversation in this project, ` +
        `indexed for retrieval — showing the excerpts most relevant to this question) ---\n` +
        excerpts.map((e) => `[Excerpt — part ${e.seq + 1}]\n${e.text}`).join("\n\n") +
        "\n--- End of chat excerpts ---";
      continue;
    }
    const name = names.get(docId) || "document";
    out +=
      `\n\n--- Attached document: ${name} (large document, indexed for retrieval — ` +
      `showing the excerpts most relevant to this question) ---\n` +
      (meta ? `[Document metadata]\n${meta}\n\n` : "") +
      excerpts.map((e) => `[Excerpt — part ${e.seq + 1}]\n${e.text}`).join("\n\n") +
      "\n--- End of document excerpts ---";
  }
  return out;
}
