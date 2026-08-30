// @ts-check
// THE GATHER-THEN-WRITE NOTES CONTRACT — how a research loop's transcript
// becomes the block the writer reads.
//
// SERVED AND PURE so both tiers' agentic engines assemble the SAME writer
// input: the server's loop (src/agentic.js, which re-exports these) and
// Se/cure's client loop (public/js/drc-research.js). This paragraph decides
// which tool results reach the writer, how they are labelled ("YOUR OWN
// working notes, not numbered sources… do NOT give them an [n]"), and the two
// caps — two copies of it would be two different writers, which is exactly
// the drift research-brief-core.js's header names as its reason to exist.

/** How much of one tool result reaches the writer's notes block. The source
 * registry already carries everything a search returned; this is for the
 * tools that add no sources, so it is sized for a finding, not a document. */
export const MAX_NOTE_CHARS = 1500;
/** The whole notes block's ceiling. It rides in the synthesis user message
 * beside the numbered digest, and the digest is what the answer must cite. */
export const MAX_NOTES_BLOCK_CHARS = 12_000;

/**
 * The loop's gathered material, as the block the writer receives.
 *
 * Results that ADDED SOURCES are left out on purpose: they are already in the
 * numbered registry the synthesis input renders, and repeating them would
 * spend the writer's context on a second, unnumbered copy of the thing it
 * must cite by number. What survives is the material that has no other way
 * in — a corpus row, a computed figure, a lookup — plus whatever the model
 * wrote in its own last turn, which is the closest thing this path has to a
 * plan.
 *
 * @param {{ name: string, headline: string, text: string, sourcesAdded: number }[]} entries
 * @param {string} notes the loop's final assistant text (never emitted)
 * @returns {string}
 */
export function researchNotesSection(entries, notes) {
  /** @type {string[]} */
  const lines = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.sourcesAdded > 0) continue;
    const body = String(e.text || "").trim();
    if (!body) continue;
    lines.push(`${e.headline}\n${body.slice(0, MAX_NOTE_CHARS)}`);
  }
  const summary = String(notes || "").trim();
  if (!lines.length && !summary) return "";
  const block =
    (lines.length
      ? "Findings from tools that returned no citable source (a corpus row, a computed figure, a lookup). " +
        "These are YOUR OWN working notes, not numbered sources: state what they establish in your own words and do NOT give them an [n].\n" +
        lines.join("\n\n")
      : "") +
    (summary ? `${lines.length ? "\n\n" : ""}Your working conclusion at the end of the research:\n${summary}` : "");
  return `Research notes:\n${block.slice(0, MAX_NOTES_BLOCK_CHARS)}\n\n`;
}
