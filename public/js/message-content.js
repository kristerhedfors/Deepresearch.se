// @ts-check
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

/**
 * One part of a multimodal user message (OpenAI wire shape).
 * @typedef {{type?: string, text?: string, image_url?: {url?: string}}} MessagePart
 */

/**
 * One conversation message. `content` is a string except for multimodal
 * user turns, which carry an array of parts.
 * @typedef {{role?: string, content?: string | MessagePart[]}} ChatMessage
 */

/**
 * One convEmbeds entry (stream.js's registry of elements the pipeline
 * embedded into a turn's body). `kind` picks the reference format in
 * embedRef; the rest is per-kind metadata.
 * @typedef {object} ConvEmbed
 * @property {number} [id] 1-based, conversation-wide
 * @property {string} [kind] "streetview_embed" | "map_embed" | "streetview_frames" | "quiz" | future kinds
 * @property {number} [msgIndex] index of the message the element belongs to
 * @property {number} [lat]
 * @property {number} [lng]
 * @property {string} [q] map_embed's search query
 * @property {string} [query] streetview_frames' place query
 * @property {string[]} [directions]
 * @property {{title?: string, questions?: unknown[]}} [quiz]
 * @property {boolean} [completed]
 */

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
/**
 * @param {number} lastByteAt epoch ms of the last received byte
 * @param {number} now epoch ms
 * @param {boolean} hidden document.hidden at the time of the check
 * @param {number} [stallMs]
 * @returns {boolean}
 */
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

/**
 * Title for the encrypted local-history sidebar: the first user message's
 * text, trimmed to a sidebar-friendly length. Handles both string content
 * and multimodal arrays (uses the first text part).
 * @param {ChatMessage[]} history
 * @returns {string}
 */
export function deriveTitle(history) {
  const first = history.find((m) => m.role === "user");
  const text =
    typeof first?.content === "string"
      ? first.content
      : (first?.content || []).find((p) => p.type === "text")?.text || "";
  return text.trim().slice(0, 60) || "New conversation";
}

/**
 * Keep images only on the latest message when sending: history is resent
 * every turn and would otherwise re-inflate each request past the provider's
 * ~1 MB body limit. Older user turns keep their text plus a marker; the
 * latest message and all non-user/string messages pass through untouched.
 * @param {ChatMessage[]} history
 * @returns {ChatMessage[]}
 */
export function stripOldImages(history) {
  return history.map((m, i) => {
    if (i === history.length - 1 || m.role !== "user" || !Array.isArray(m.content)) return m;
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

/**
 * A user message's content split into display text + image data URLs — for
 * re-hydrating the assistant turn on a boot resume (stream.js), so its PDF
 * report keeps the title/images a live turn would have had. Handles both
 * string content and multimodal arrays.
 * @param {ChatMessage["content"]} content
 * @returns {{text: string, imageUrls: string[]}}
 */
export function splitUserContent(content) {
  if (typeof content === "string") return { text: content, imageUrls: [] };
  if (Array.isArray(content)) {
    return {
      text: content.filter((p) => p?.type === "text").map((p) => p.text).join("\n"),
      imageUrls: content
        .filter((p) => p?.type === "image_url")
        .map((p) => p.image_url?.url)
        .filter(/** @returns {u is string} */ (u) => Boolean(u)),
    };
  }
  return { text: "", imageUrls: [] };
}

// ---- Copy-conversation export ----------------------------------------------
// Plain-text export of a conversation for the header's copy-to-clipboard
// button (app.js): one labeled paragraph per turn ("User: …" /
// "Assistant: …"), blank-line separated. Non-text content is REFERENCED,
// never dumped — attached images become "[Image attached]" lines, every
// appended context block (inline documents, retrieval excerpts, project
// materials, related project chats) collapses to a one-line reference
// carrying its display name, and elements the pipeline embedded into a
// turn's body (the Street View panorama / vision-frame strip — stream.js's
// convEmbeds registry) become id-numbered "[Embedded element #N: …]" lines
// under their assistant turn, so the reader gets the conversation, not
// kilobytes of excerpt plumbing or JPEG data URLs. Image-metadata blocks
// are dropped outright: the image reference already stands for the image.

// Where the appended labeled blocks begin in a user message's text — the
// same block family chat-rag.js strips before indexing (kept in sync with
// inlineDocBlock / ragExcerptBlocks / project-context.js / the image-
// metadata block below).
const APPENDED_BLOCK = /\n\n--- (Attached document:|Project:|Related project chat:|Image metadata:)/;

// One appended block's opening line, capturing kind + display name.
const BLOCK_OPENER = /^--- (Attached document|Related project chat|Project|Image metadata): (.*?) ---$/gm;

/**
 * The block openers decorate the name with a parenthetical descriptor
 * ("(truncated)", "(large document, indexed for retrieval — …)", "(an
 * earlier conversation in this project, …)") — strip it for the reference.
 * @param {string} name
 */
function blockRefName(name) {
  return name.replace(/ \((?:truncated|large document[^)]*|an earlier conversation[^)]*)\)$/, "").trim();
}

// Whether the outgoing message explicitly asks for Street View at the
// user's CURRENT location ("street view here", "popup street view at my
// current location", "gatuvy här"). A cheap client-side prefilter — the
// server's typo-tolerant gate is authoritative — used only to decide
// whether to request the device's geolocation before sending, so the
// permission prompt fires for exactly these asks and nothing else. Pure —
// unit-tested.
const SV_WORD_RE = /(?:(?:street|streer|stret|steet|streat)\s*(?:view|veiw|veew)|streetview|gatu?vy(?:n)?|gatubild(?:en)?)/iu;
const HERE_WORD_RE =
  /(?<![\p{L}\p{M}])(?:here|current\s+(?:location|position|spot)|my\s+(?:actual\s+|real\s+|physical\s+|current\s+|own\s+)?(?:location|position)|där\s+jag\s+(?:faktiskt\s+|egentligen\s+)?är|var\s+jag\s+är|min\s+(?:nuvarande\s+|faktiska\s+|riktiga\s+|verkliga\s+|fysiska\s+)?(?:position|plats)|nuvarande\s+(?:plats|läge)|denna\s+plats|den\s+här\s+platsen|härifrån|här)(?![\p{L}\p{M}])/iu;
/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function asksStreetViewHere(text) {
  const t = typeof text === "string" ? text : "";
  return SV_WORD_RE.test(t) && HERE_WORD_RE.test(t);
}

// A plain "where am I?" ask — mirrors the server's WHERE_AM_I_RE
// (src/googlemaps-text.js): same EN typo set, same Swedish breadth, same
// end-of-clause lookahead so "where are we going with this" never fires.
const WHERE_AM_I_RE =
  /(?<![\p{L}\p{M}])(?:(?:where|wher|were|whree?)\s+(?:exactly\s+)?(?:am\s+i|are\s+we)|va(?:r|rt)\s+(?:exakt\s+)?(?:är|e)\s+(?:jag|vi)|var\s+n[åa]gonstans\s+(?:är|e)\s+(?:jag|vi)|var\s+befinner\s+(?:jag\s+mig|vi\s+oss))(?=\s*(?:right\s+now|just\s+nu|now|exactly|currently|located|somewhere|nu|egentligen|n[åa]gonstans)?\s*(?:[?!.,]|$))/iu;

// The conversation-level device-location prefilter (mirrors the server's
// isHereAsk gate in src/googlemaps-text.js — reported verbatim 2026-07-09:
// "Where am i now" → "Street view" → "My location" never requested the
// device location because the old prefilter needed street-view word +
// here-word in ONE message). True when the LATEST user turn asks
// street-view-here outright, is a plain where-am-I ask, or is a short
// here-fragment ("My location", "här", "min plats") answering an EARLIER
// street-view turn.
/**
 * @param {unknown[]} userTexts every user turn's text, oldest first
 * @returns {boolean}
 */
export function asksDeviceLocation(userTexts) {
  const texts = Array.isArray(userTexts) ? userTexts.map((t) => (typeof t === "string" ? t : "")) : [];
  const latest = texts[texts.length - 1] || "";
  if (asksStreetViewHere(latest) || WHERE_AM_I_RE.test(latest) || asksPhysicalLocation(latest)) return true;
  if (asksNearbyPlace(latest) || asksCrossBarrier(latest) || asksRelocation(latest)) return true;
  const t = latest.trim();
  const isFragment = !!t && t.length <= 48 && t.split(/\s+/).length <= 4 && HERE_WORD_RE.test(t);
  if (isFragment && texts.slice(0, -1).some((prev) => SV_WORD_RE.test(prev))) return true;
  // A short fragment right after a relocation/nearby ask continues it
  // ("Lets go to hemköp stälet" → clarify → "Hemköp stäket" — verbatim
  // 2026-07-09, logged maps_intent "none" because no location was sent):
  // the server's pending-relocation matcher needs the anchor, so these
  // fragments request the device location too.
  const isShort = !!t && t.length <= 40 && t.split(/\s+/).length <= 3;
  return (
    isShort &&
    texts
      .slice(0, -1)
      .slice(-6)
      .some((prev) => asksRelocation(prev) || asksNearbyPlace(prev))
  );
}

// A relocation ask aimed at a name or place ("Lets go to hemköp", "teleport
// to willys", "gå till ica") — mirrors the server's extractRelocationQuery
// gate loosely (the server is authoritative; junk like "go to sleep" is
// rejected there): the message must START with an optional opener + a
// relocation verb + to/till, and stay short. These need the device location
// on a fresh chat exactly like the nearby asks — the verbatim 2026-07-09
// report had the server matchers ready but anchor-less.
const RELOCATION_START_RE =
  /^(?:(?:please|ok|okay|let'?s|lets|legs)\s+)?(?:jump|teleport|beam|hoppa|teleportera|get|go|move|travel|walk|head|take|ta|gå|ga|åk|förflytta|forflytta)(?:\s+(?:me|us|mig|oss))?\s+(?:to|till|över|over|across)\s+\S/iu;
/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function asksRelocation(text) {
  const t = (typeof text === "string" ? text : "").trim();
  return !!t && t.length <= 80 && t.split(/\s+/).length <= 8 && RELOCATION_START_RE.test(t);
}

// A NEARBY-place ask ("Gas station near e18 there", "närmaste mack") —
// mirrors the server's extractNearbyPlaceQuery gate (src/googlemaps-text.js:
// a place-TYPE word plus a NEARBY word). With no live view on screen the
// server has nothing to anchor the Places search to, so these asks request
// the device location like the other here-ask shapes. Sent location is
// ignored server-side unless the user's Maps knob is on.
const PLACE_TYPE_WORD_RE = new RegExp(
  "(?<![\\p{L}\\p{M}])(?:" +
    "restaurants?|diners?|caf[ée]s?|coffee ?shops?|bars?|pubs?|hotels?|hostels?|shops?|stores?|" +
    "supermarkets?|malls?|museums?|galler(?:y|ies)|schools?|universit(?:y|ies)|church(?:es)?|stations?|" +
    "kiosks?|pizzerias?|baker(?:y|ies)|gyms?|cinemas?|theatres?|theaters?|" +
    "gas ?stations?|petrol ?stations?|fuel ?stations?|service ?stations?|pharmac(?:y|ies)|drugstores?|" +
    "atms?|banks?|grocer(?:y|ies)|grocery ?stores?|parking|hospitals?|clinics?|police ?stations?|" +
    "restaurang(?:en|er|erna)?|gatukök(?:et|en)?|kaf[ée](?:et|er)?|krog(?:en|ar|arna)?|hotell(?:et|en)?|" +
    "butik(?:en|er|erna)?|affär(?:en|er|erna)?|köpcentr(?:um|et)|museet|skol(?:a|an|or|orna)|" +
    "universitet(?:et)?|kyrk(?:a|an|or|orna)|kiosk(?:en|er)?|pizzeri(?:a|an|or)|" +
    "bageri(?:et|er)?|biograf(?:en|er)?|teater(?:n|rar)?|" +
    "bensinstation(?:en|er|erna)?|bensinmack(?:en|ar)?|mack(?:en|ar|arna)?|tankställe(?:t|n)?|" +
    "apotek(?:et|en)?|bankomat(?:en|er|erna)?|uttagsautomat(?:en|er)?|parkering(?:en|ar|arna)?|" +
    "sjukhus(?:et|en)?|vårdcentral(?:en|er|erna)?|polisstation(?:en|er)?|" +
    "mataffär(?:en|er|erna)?|matbutik(?:en|er|erna)?|livsmedelsbutik(?:en|er|erna)?" +
    ")(?![\\p{L}\\p{M}])",
  "iu",
);
const NEARBY_WORD_RE =
  /(?<![\p{L}\p{M}])(?:near(?:by|est)?|closest|close by|around here|here|there|närmaste|närmsta|nära|i närheten|häromkring|i området|runt här|här|där)(?![\p{L}\p{M}])/iu;
// Relocation verbs — "jump"/"teleport" mean instant relocation (the user's
// stated semantics); travel verbs carry the same intent. Mirrors the
// server's TELEPORT_VERB_RE / TRAVEL_TO_RE (src/googlemaps-text.js).
const TELEPORT_VERB_RE =
  /(?<![\p{L}\p{M}])(?:jump|teleport|beam(?:\s+(?:me|us))?|hoppa|teleportera)(?![\p{L}\p{M}])/iu;
const TRAVEL_TO_RE =
  /(?<![\p{L}\p{M}])(?:get|go|move|travel|walk|head|take\s+(?:me|us)|ta\s+(?:mig|oss)|gå|ga|åk|förflytta|forflytta)(?:\s+(?:me|us|mig|oss))?\s+(?:to|till|över|over|across)(?![\p{L}\p{M}])/iu;
/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function asksNearbyPlace(text) {
  const t = (typeof text === "string" ? text : "").trim();
  if (!t || t.length > 120 || !PLACE_TYPE_WORD_RE.test(t)) return false;
  return NEARBY_WORD_RE.test(t) || TELEPORT_VERB_RE.test(t) || TRAVEL_TO_RE.test(t);
}

// A cross-barrier relocation ask ("get to the other side of the railway",
// "hoppa över spåret") — mirrors the server's extractCrossBarrierAsk. With
// no live view, the crossing probe needs the device location as its anchor.
const BARRIER_SIDE_RE =
  /(?:(?:other|far)\s+side\s+of|andra\s+sidan(?:\s+av)?|across|över|over)\s+(?:the\s+)?(?:railway|railroad|rail\s*way|train\s*tracks?|tracks?|rails|river|stream|canal|road|street|highway|motorway|freeway|bridge|järnväg(?:en)?|jarnvag(?:en)?|(?:tåg)?spår(?:et|en)?|(?:tag)?spar(?:et|en)|älven|alven|ån|floden|kanalen|vägen|vagen|gatan|motorvägen|motorvagen|bron)(?![\p{L}\p{M}])/iu;
/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function asksCrossBarrier(text) {
  const t = (typeof text === "string" ? text : "").trim();
  if (!t || t.length > 120 || !BARRIER_SIDE_RE.test(t)) return false;
  return TELEPORT_VERB_RE.test(t) || TRAVEL_TO_RE.test(t) || t.split(/\s+/).length <= 8;
}

// An EXPLICIT reference to the user's PHYSICAL location ("my actual
// location", "min faktiska plats") — mirrors the server's
// PHYSICAL_LOCATION_RE (src/googlemaps-text.js). Unlike the other here-ask
// shapes, this one requests the device location EVEN WHILE a live
// panorama/map exists: the user has navigated the view elsewhere and is
// saying they mean their real position (stream.js consults this
// separately, outside the no-live-view guard).
const PHYSICAL_LOCATION_RE =
  /(?<![\p{L}\p{M}])(?:my\s+(?:actual|real|physical|true|own)\s+(?:location|position)|where\s+i\s+(?:actually|really)\s+am|min\s+(?:faktiska|riktiga|verkliga|fysiska|egna)\s+(?:plats|position)|där\s+jag\s+(?:faktiskt|egentligen)\s+är|var\s+jag\s+faktiskt\s+är)(?![\p{L}\p{M}])/iu;
/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function asksPhysicalLocation(text) {
  return PHYSICAL_LOCATION_RE.test(typeof text === "string" ? text : "");
}

/**
 * One embedded element's reference line; each kind formats its own
 * metadata. Unknown kinds still get an id-numbered line — a new source's
 * embed must never silently vanish from the export (see the
 * add-research-source skill).
 * @param {ConvEmbed | null | undefined} e
 * @returns {string}
 */
export function embedRef(e) {
  if (e?.kind === "streetview_embed") {
    return `[Embedded element #${e.id}: interactive Google Street View panorama at ${e.lat}, ${e.lng}]`;
  }
  if (e?.kind === "map_embed") {
    return `[Embedded element #${e.id}: interactive Google Map at ${e.lat}, ${e.lng}${e.q ? ` (${e.q})` : ""}]`;
  }
  if (e?.kind === "streetview_frames") {
    const dirs = (e.directions || []).filter(Boolean).join(", ");
    return (
      `[Embedded element #${e.id}: Street View frames` +
      (e.query ? ` of "${e.query}"` : "") +
      (dirs ? ` (${dirs})` : "") +
      "]"
    );
  }
  if (e?.kind === "quiz") {
    const n = Array.isArray(e.quiz?.questions) ? e.quiz.questions.length : 0;
    // The score itself isn't repeated here: on completion the result summary
    // is appended to the quiz's assistant message (stream.js quizHooks), so
    // the export already carries it in the turn text.
    return (
      `[Embedded element #${e.id}: interactive quiz` +
      (e.quiz?.title ? ` "${e.quiz.title}"` : "") +
      (n ? ` — ${n} question${n === 1 ? "" : "s"}` : "") +
      (e.completed ? ", completed" : "") +
      "]"
    );
  }
  return `[Embedded element #${e?.id}: ${e?.kind || "element"}]`;
}

/**
 * Cut a message's text at its first appended block and collapse every
 * block after the cut to a one-line reference (image-metadata blocks
 * dropped — the image reference already stands for the image).
 * @param {string} text
 * @returns {{main: string, refs: string[]}}
 */
function collapseAppendedBlocks(text) {
  const cut = text.search(APPENDED_BLOCK);
  if (cut < 0) return { main: text, refs: [] };
  /** @type {string[]} */
  const refs = [];
  for (const [, kind, name] of text.slice(cut).matchAll(BLOCK_OPENER)) {
    if (kind === "Image metadata") continue;
    refs.push(`[${kind === "Project" ? "Project materials" : kind}: ${blockRefName(name)}]`);
  }
  return { main: text.slice(0, cut), refs };
}

/**
 * @param {ChatMessage[] | null | undefined} messages
 * @param {ConvEmbed[]} [embeds] stream.js's convEmbeds registry
 * @returns {string} the plain-text conversation export
 */
export function conversationCopyText(messages, embeds = []) {
  const out = [];
  const msgs = messages || [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const { text, imageUrls } = splitUserContent(m?.content);
    const { main, refs } = collapseAppendedBlocks(text);
    imageUrls.forEach((_, n) => {
      refs.push(imageUrls.length > 1 ? `[Image ${n + 1} attached]` : "[Image attached]");
    });
    for (const e of embeds || []) {
      if (e?.msgIndex === i) refs.push(embedRef(e));
    }
    const body = [main.trim(), ...refs].filter(Boolean).join("\n");
    if (!body) continue;
    out.push((m?.role === "assistant" ? "Assistant: " : "User: ") + body);
  }
  return out.join("\n\n");
}

/**
 * One inline (non-RAG) document as a labeled text block: the doc's parsed
 * text, its extracted metadata (docProps / tracked changes / PDF Info dict —
 * see docs.js) as its own sub-block, and a truncation marker when the parse
 * hit the inline char cap.
 * @param {{name: string, text: string, truncated?: boolean, metadata?: string | null}} doc
 * @returns {string}
 */
export function inlineDocBlock(doc) {
  return (
    `\n\n--- Attached document: ${doc.name}${doc.truncated ? " (truncated)" : ""} ---\n` +
    (doc.metadata ? `[Document metadata]\n${doc.metadata}\n\n` : "") +
    doc.text +
    "\n--- End of document ---"
  );
}

/**
 * An image's extracted metadata (EXIF — capture time/place/device, see
 * exif.js) as its own labeled block. Returns "" for an image that carried
 * none, so the caller can append unconditionally.
 * @param {{name: string, metadata?: string | null}} image
 * @returns {string}
 */
export function imageMetadataBlock(image) {
  if (!image.metadata) return "";
  return `\n\n--- Image metadata: ${image.name} ---\n${image.metadata}\n--- End of image metadata ---`;
}

/**
 * The RAG retrieval blocks: the pure assembly half of stream.js's
 * buildRagBlocks (retrieval itself stays there — it's async/network). Groups
 * the retrieved matches back under their documents, enforces a per-excerpt
 * cap and a total char budget, and formats one labeled block per document.
 * Docs in `chatDocIds` are indexed PROJECT CHATS (chat-rag.js) — those get
 * a header saying what they actually are (an earlier conversation in this
 * project) instead of the attached-document one.
 * @param {Array<{docId: string, seq: number, text: string}>} matches
 * @param {Map<string, string>} names docId → display name
 * @param {Map<string, string>} metaByDoc docId → extracted metadata
 * @param {number} [totalBudget]
 * @param {Set<string>} [chatDocIds]
 * @returns {string} "" when nothing survives the budget
 */
export function ragExcerptBlocks(matches, names, metaByDoc, totalBudget = EXCERPT_TOTAL_CHARS, chatDocIds = new Set()) {
  /** @type {Map<string, Array<{seq: number, text: string}>>} */
  const byDoc = new Map();
  let used = 0;
  for (const m of matches) {
    if (used >= totalBudget) break;
    const excerpt = m.text.slice(0, Math.min(EXCERPT_CHUNK_CHARS, totalBudget - used));
    if (!excerpt.trim()) continue;
    used += excerpt.length;
    let docExcerpts = byDoc.get(m.docId);
    if (!docExcerpts) byDoc.set(m.docId, (docExcerpts = []));
    docExcerpts.push({ seq: m.seq, text: excerpt });
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
