// @ts-check
// Pure helpers for the projects feature (public/js/projects.js) — kept
// import-free so the Node unit suite can exercise them directly, the same
// pattern as rag.js's pure core.

/**
 * One project material as projects.js stores it (file, image, or note).
 * @typedef {object} ProjectFile
 * @property {string} [id] retrieval doc id (present when indexed)
 * @property {string} [name]
 * @property {"image" | "text" | "doc" | string} [kind]
 * @property {boolean} [indexed]
 * @property {string} [metadata] extracted EXIF / document metadata summary
 */

/**
 * @typedef {object} Project
 * @property {string} [name]
 * @property {ProjectFile[]} [files]
 */

// The per-doc metadata slice and total block budget: the project context
// block is INVENTORY + image metadata, not content — document content
// arrives via retrieval excerpts, so this stays small even for a project
// full of material.
const META_CHARS = 900;
const BLOCK_MAX_CHARS = 6000;

export const PROJECT_NAME_MAX = 80;
export const NOTE_TITLE_MAX = 120;
export const NOTE_TEXT_MAX = 500_000;

/**
 * @param {unknown} name
 * @returns {string} trimmed, capped, never empty
 */
export function normalizeProjectName(name) {
  const n = String(name || "").trim().slice(0, PROJECT_NAME_MAX);
  return n || "Untitled project";
}

/**
 * A note ("text content with header and content") is stored/indexed as a
 * single text document; the title leads the text so retrieval can match on
 * it too.
 * @param {unknown} title
 * @param {unknown} content
 * @returns {string}
 */
export function noteToText(title, content) {
  const t = String(title || "").trim().slice(0, NOTE_TITLE_MAX);
  const c = String(content || "").trim().slice(0, NOTE_TEXT_MAX);
  return (t ? t + "\n\n" : "") + c;
}

/**
 * Doc ids eligible for retrieval in this project's scope.
 * @param {Project | null | undefined} project
 * @returns {string[]}
 */
export function projectDocIds(project) {
  /** @type {string[]} */
  const ids = [];
  for (const f of project?.files || []) {
    if (f.indexed && f.id) ids.push(f.id);
  }
  return ids;
}

/**
 * The "project materials" block appended to every message sent inside a
 * project: an inventory of the project's files and notes, plus extracted
 * image metadata (EXIF — capture time/place/device) since images aren't
 * otherwise readable to a text pipeline. Document CONTENT is deliberately
 * absent here — the indexed files contribute retrieval excerpts through
 * the same mechanism attachments use.
 * @param {Project | null | undefined} project
 * @returns {string} the labeled block ("" when there's nothing to describe)
 */
export function buildProjectContext(project) {
  const files = project?.files || [];
  if (!project || (!files.length && !project.name)) return "";
  const lines = [`--- Project: ${normalizeProjectName(project.name)} ---`];
  if (files.length) lines.push("Materials in this project:");
  else lines.push("(no materials added yet)");
  for (const f of files) {
    const kind =
      f.kind === "image" ? "image" : f.kind === "text" ? "note" : f.kind === "doc" ? "document" : "file";
    const indexed = f.indexed ? ", indexed for retrieval — relevant excerpts are supplied separately" : "";
    lines.push(`- ${f.name} (${kind}${indexed})`);
    if (f.metadata) {
      const meta = String(f.metadata).slice(0, META_CHARS);
      lines.push(
        `  [${f.kind === "image" ? "Image metadata" : "Document metadata"}]`,
        ...meta.split("\n").map((l) => "  " + l),
      );
    }
    if (lines.join("\n").length > BLOCK_MAX_CHARS) break;
  }
  lines.push(`--- End of project ---`);
  let out = lines.join("\n");
  if (out.length > BLOCK_MAX_CHARS + 500) out = out.slice(0, BLOCK_MAX_CHARS + 500);
  return "\n\n" + out;
}
