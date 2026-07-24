// @ts-check
// The conversation embeds registry — the pipeline-embedded elements'
// bookkeeping, extracted from stream.js.
//
// Elements the pipeline embedded into a turn's body this conversation —
// the Street View panorama (`streetview_embed`) and vision-frame strip
// (`streetview_frames`). Recorded so the copy-to-clipboard export can
// reference them with stable per-conversation id numbers ("[Embedded
// element #N: …]" — message-content.js's embedRef); persisted in the
// conversation record (`embeds`, additive) so a reloaded conversation's
// export still references them even though the live panorama itself is
// session-only. `msgIndex` is the index of the assistant message the
// element renders beside — captured as history.length while the answer
// streams, which is exactly where that answer lands on completion.
//
// stream.js owns the conversation this registry keys off: initEmbeds wires
// its live message array (a stable reference — stream.js clears it in
// place, never reassigns it) and the persist hook a quiz completed after
// its stream ended needs. Everything else goes through the exports below.

/**
 * One pipeline-embedded element recorded for a turn. Kind-specific metadata
 * (coordinates, frame data URLs, the quiz payload and its answers) rides
 * along as extra properties.
 * @typedef {object} EmbedEntry
 * @property {number} id        stable per-conversation number (copy-text references)
 * @property {string} kind      "streetview_embed" | "map_embed" | "streetview_frames" | "quiz" | "workflow"
 * @property {number} msgIndex  index of the assistant message it renders beside
 */

/** A message array entry (stream.js's history shape). */
/** @typedef {{role: string, content: string|object[], [extra: string]: any}} HistoryMessage */

/** @type {HistoryMessage[]} the live conversation array (stream.js's `history`) */
let history = [];
/** @type {() => Promise<void>} persists the conversation with the latest send's metadata */
let persist = async () => {};

/**
 * One-time wiring from stream.js.
 * @param {{history: HistoryMessage[], persist: () => Promise<void>}} deps
 */
export function initEmbeds(deps) {
  history = deps.history;
  persist = deps.persist;
}

/** @type {Array<EmbedEntry & {[extra: string]: any}>} */
let convEmbeds = []; // [{id, kind, msgIndex, …kind-specific metadata}]

/**
 * The registry for the conversation currently on screen — read for
 * persistence (`embeds` in the conversation record), the copy-text export,
 * and reload rendering.
 * @returns {Array<EmbedEntry & {[extra: string]: any}>}
 */
export function getEmbeds() {
  return convEmbeds;
}

/**
 * Replace the registry — a loaded record's `embeds` list (normalized: any
 * non-array means none), or `[]` when the conversation state resets.
 * @param {any} list
 */
export function setEmbeds(list) {
  convEmbeds = Array.isArray(list) ? list : [];
}

/**
 * @param {{kind: string, [extra: string]: any}} meta
 * @returns {EmbedEntry & {[extra: string]: any}}
 */
export function recordEmbed(meta) {
  const existing = convEmbeds.find((e) => e.msgIndex === history.length && e.kind === meta.kind);
  if (existing) {
    // Mirror the render behavior (activity.js/quiz.js): one panorama per
    // turn (repeats ignored), one frame strip per turn (last event wins),
    // one quiz per turn (repeats ignored).
    if (meta.kind === "streetview_frames") Object.assign(existing, meta);
    return existing;
  }
  const id = convEmbeds.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
  const entry = { id, msgIndex: history.length, ...meta };
  convEmbeds.push(entry);
  return entry;
}

// The interaction hooks one quiz card (public/js/quiz.js) gets for its
// embeds-registry entry: answers persist into the entry as they're given,
// and completion appends the result summary to the quiz's assistant message
// in history — so follow-up questions (and the copy-conversation export)
// know the score and what was missed — then persists. The `completed` guard
// keeps a reloaded, already-finished quiz from appending the summary twice.
/**
 * @param {EmbedEntry & {[extra: string]: any}} embed
 */
export function quizHooks(embed) {
  return {
    answers: Array.isArray(embed.answers) ? embed.answers : [],
    /** @param {any[]} answers */
    onAnswer(answers) {
      embed.answers = answers;
    },
    /** @param {string} summary */
    onComplete(summary) {
      if (embed.completed) return;
      embed.completed = true;
      const msg = history[embed.msgIndex];
      if (msg && msg.role === "assistant" && typeof msg.content === "string") {
        msg.content += "\n\n" + summary;
      }
      persist().catch(() => {});
    },
  };
}

// An exchange that reverted its user message (send failed, stopped before
// any text) also drops the embeds recorded for the answer that never
// landed — their msgIndex now points past the end of history.
export function pruneEmbeds() {
  convEmbeds = convEmbeds.filter((e) => e.msgIndex < history.length);
}

// Frame images are the one bulky embed payload (~150 KB per data URL). Cap
// the total stored across the conversation at ~4 MB by dropping the URLS
// from the OLDEST frame embeds first — their metadata (query, directions)
// stays for the copy-text export; only the reload-render of those old turns
// degrades back to text.
const MAX_EMBED_BYTES = 4_000_000;
export function capEmbedBytes() {
  let total = 0;
  for (const e of convEmbeds) {
    for (const f of e.frames || []) total += (f.url || "").length;
  }
  for (const e of convEmbeds) {
    if (total <= MAX_EMBED_BYTES) break;
    for (const f of e.frames || []) {
      total -= (f.url || "").length;
      delete f.url;
    }
  }
}
