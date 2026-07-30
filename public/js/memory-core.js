// @ts-check
// ACCOUNT MEMORY — the pure core. Structured, durable notes an account
// accumulates across conversations, shaped the way Obsidian shapes knowledge:
// one Markdown file per note, YAML frontmatter for its properties, and
// `[[wikilinks]]` between notes as the only edge type. Exporting is therefore
// not a conversion — the store already IS a vault, and `vaultFiles` just lays
// the notes out as folders and files.
//
// WHY A NOTE GRAPH AND NOT A TRANSCRIPT. The research pipeline forgets
// everything structural between runs: each request re-derives who the entities
// are and how they relate. A transcript archive does not fix that, because
// prose is not queryable. Linked notes are — and they are also the one
// knowledge format a user can walk away with and keep using in a tool this
// project does not control, which is the point of making the export the
// headline feature rather than an afterthought (docs/AGENTIC-GRAPHS.md §5.4).
//
// I/O-free, so it is Node-tested (memory-core.test.js) and shared verbatim
// between the browser (the Settings screen) and the Worker (src/memory.js).
//
// PRIVACY POSTURE (invariant 4). This is a Se/rver-tier feature and nothing
// else. Memory is account-scoped, stored server-side, and therefore only
// coherent in the tier where the server is inside the trust boundary (owner
// directive, 2026-07-24). It is OFF until the account turns it on, it never
// records an incognito turn, and the reset path deletes rather than tombstones.
// A memory note is a DISTILLED, LINKED summary of what an account researched,
// which is materially easier to re-identify from than the raw chats it came
// from — so the exposure it adds is real and is written down in
// docs/ACCOUNT-MEMORY.md rather than left implicit.

// ---- bounds ------------------------------------------------------------------
//
// A memory that grows without limit stops being memory and becomes a second
// chat log. These caps are what keep a vault small enough to read, cheap
// enough to export in one response, and bounded as a stored-data promise.

export const MAX_NOTES = 500; // per account; oldest-touched evicted first
export const MAX_TITLE_CHARS = 80;
export const MAX_BODY_CHARS = 1200;
export const MAX_LINKS_PER_NOTE = 12;
export const MAX_TAGS_PER_NOTE = 6;
export const MAX_NOTES_PER_TURN = 6; // what one extraction pass may propose

/**
 * The closed note-type vocabulary. Closed for the same reason the
 * Orchestrator's agent kinds are (orchestrator-core.js): the extractor is a
 * model, and an open vocabulary drifts into hundreds of near-synonyms that no
 * folder layout or query can use. `note` is the escape hatch.
 * @typedef {"person"|"organisation"|"place"|"concept"|"event"|"source"|"note"} NoteType
 */

/** Type → the vault folder it files under. */
export const NOTE_TYPES = {
  person: "People",
  organisation: "Organisations",
  place: "Places",
  concept: "Concepts",
  event: "Events",
  source: "Sources",
  note: "Notes",
};

/** @type {NoteType[]} */
export const NOTE_TYPE_IDS = /** @type {NoteType[]} */ (Object.keys(NOTE_TYPES));

/**
 * @typedef {{
 *   slug: string,
 *   title: string,
 *   type: NoteType,
 *   body: string,
 *   links: string[],
 *   tags: string[],
 *   created_at: number,
 *   updated_at: number,
 * }} MemoryNote
 */

// ---- naming ------------------------------------------------------------------

/**
 * A note's stable identity, derived from its title. Obsidian keys links by
 * FILE NAME, so the slug is both the primary key and the link target, and it
 * has to survive a filesystem: no path separators, no Windows-reserved
 * characters, no leading dot.
 *
 * Non-ASCII letters are KEPT rather than transliterated. "Göteborg" must file
 * as `Göteborg`, not `goteborg` — the second is a different word, and a
 * Swedish user's vault full of stripped diacritics is a broken deliverable
 * (invariant 6's spirit again). Zip stores the name as UTF-8 with the
 * encoding flag set, so this survives export.
 * @param {unknown} title
 * @returns {string} empty when nothing usable remains
 */
export function noteSlug(title) {
  return String(title ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ") // path + Obsidian link syntax + Windows reserved
    .replace(/[\u0000-\u001f\u007f]/g, " ") // control characters a filename must not carry
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

// ---- normalization -----------------------------------------------------------

/** @param {unknown} v @param {number} max @returns {string} */
function clampText(v, max) {
  return typeof v === "string" ? v.trim().replace(/\r\n/g, "\n").slice(0, max) : "";
}

/**
 * Coerce one extraction pass's model output into storable notes — the
 * never-throw sibling of a validator, in the schema.js house style. Unknown
 * types become `note`, unusable entries are dropped, links to nothing are
 * kept (Obsidian's unresolved links are a feature: they show where the graph
 * wants to grow), and the whole thing is capped.
 *
 * Returns [] for anything unusable, which the caller treats as "this turn
 * taught us nothing" — never as an error (invariant 2).
 * @param {any} raw the parsed JSON from the extraction phase
 * @param {{ now?: number }} [opts]
 * @returns {MemoryNote[]}
 */
export function normalizeMemoryNotes(raw, opts = {}) {
  const now = Number.isFinite(opts.now) ? /** @type {number} */ (opts.now) : 0;
  const list = Array.isArray(raw?.notes) ? raw.notes : Array.isArray(raw) ? raw : [];
  /** @type {MemoryNote[]} */
  const out = [];
  const seen = new Set();
  for (const n of list) {
    if (out.length >= MAX_NOTES_PER_TURN) break;
    if (!n || typeof n !== "object") continue;
    const title = clampText(n.title, MAX_TITLE_CHARS);
    const slug = noteSlug(title);
    const body = clampText(n.body ?? n.summary, MAX_BODY_CHARS);
    // A note with no title cannot be linked to, and a note with no body is a
    // bare filename — neither is memory, so both are dropped rather than
    // stored as clutter the user has to clean up later.
    if (!slug || !body) continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const type = NOTE_TYPE_IDS.includes(n.type) ? n.type : "note";
    /** @type {string[]} */
    const links = [];
    for (const l of Array.isArray(n.links) ? n.links : []) {
      const s = noteSlug(l);
      if (s && s.toLowerCase() !== key && !links.includes(s)) links.push(s);
      if (links.length >= MAX_LINKS_PER_NOTE) break;
    }
    /** @type {string[]} */
    const tags = [];
    for (const t of Array.isArray(n.tags) ? n.tags : []) {
      // Obsidian tags cannot contain spaces; hyphenate rather than drop, so a
      // model that returns "ancient dna" still yields a usable #ancient-dna.
      const s = clampText(t, 40).replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
      if (s && !tags.includes(s)) tags.push(s);
      if (tags.length >= MAX_TAGS_PER_NOTE) break;
    }
    out.push({ slug, title: title || slug, type, body, links, tags, created_at: now, updated_at: now });
  }
  return out;
}

/**
 * Fold a freshly extracted note into what is already stored under that slug.
 *
 * The rule is ACCUMULATE, NOT OVERWRITE: links and tags union, so the graph
 * only ever gains edges, while the body takes the newer text — a later
 * conversation usually knows more than an earlier one, and keeping both would
 * grow every note without bound. `created_at` is preserved so a note's age
 * survives being re-mentioned.
 * @param {MemoryNote | null | undefined} existing
 * @param {MemoryNote} incoming
 * @returns {MemoryNote}
 */
export function mergeNote(existing, incoming) {
  if (!existing) return incoming;
  const links = [...existing.links];
  for (const l of incoming.links) if (!links.includes(l)) links.push(l);
  const tags = [...existing.tags];
  for (const t of incoming.tags) if (!tags.includes(t)) tags.push(t);
  return {
    ...existing,
    title: incoming.title || existing.title,
    type: incoming.type === "note" ? existing.type : incoming.type,
    body: incoming.body || existing.body,
    links: links.slice(0, MAX_LINKS_PER_NOTE),
    tags: tags.slice(0, MAX_TAGS_PER_NOTE),
    updated_at: incoming.updated_at || existing.updated_at,
  };
}

// ---- Obsidian serialization --------------------------------------------------

/**
 * YAML-quote a scalar. Deliberately minimal: every value written here is a
 * short string or a number, so the only hazards are the characters that would
 * end the scalar early. Always quoting is simpler to be correct about than
 * deciding when quoting is required.
 * @param {string} s
 * @returns {string}
 */
function yamlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/** @param {number} ts @returns {string} ISO date, or "" for a missing stamp */
function isoDay(ts) {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : "";
}

/**
 * One note as an Obsidian Markdown file: YAML frontmatter (Obsidian reads it
 * as note Properties), an H1 title, the body, then a "Related" section of
 * `[[wikilinks]]`. The links appear in the BODY, not only in frontmatter,
 * because Obsidian's graph view and backlinks pane resolve body links — a
 * frontmatter-only list would export a graph with no visible edges.
 * @param {MemoryNote} note
 * @returns {string}
 */
export function noteToMarkdown(note) {
  const fm = [
    "---",
    `title: ${yamlString(note.title)}`,
    `type: ${yamlString(note.type)}`,
  ];
  const created = isoDay(note.created_at);
  const updated = isoDay(note.updated_at);
  if (created) fm.push(`created: ${created}`);
  if (updated) fm.push(`updated: ${updated}`);
  if (note.tags.length) fm.push(`tags: [${note.tags.join(", ")}]`);
  fm.push("---", "");
  const parts = [fm.join("\n"), `# ${note.title}`, "", note.body, ""];
  if (note.links.length) {
    parts.push("## Related", "", ...note.links.map((l) => `- [[${l}]]`), "");
  }
  return parts.join("\n");
}

/**
 * Lay the whole memory out as an Obsidian vault: one file per note under its
 * type's folder, plus a generated index note that links every note so the
 * vault has an entry point and the graph view has a hub.
 *
 * The index is named `Memory.md` and lives at the vault root. It is
 * REGENERATED on every export and says so, because a user who edits it in
 * Obsidian and re-exports would otherwise silently lose their edits.
 * @param {MemoryNote[]} notes
 * @param {{ generatedAt?: number, account?: string }} [meta]
 * @returns {Array<{ path: string, text: string }>}
 */
export function vaultFiles(notes, meta = {}) {
  const files = notes.map((n) => ({
    path: `${NOTE_TYPES[n.type] || NOTE_TYPES.note}/${n.slug}.md`,
    text: noteToMarkdown(n),
  }));
  const byType = new Map();
  for (const n of notes) {
    const folder = NOTE_TYPES[n.type] || NOTE_TYPES.note;
    if (!byType.has(folder)) byType.set(folder, []);
    byType.get(folder).push(n);
  }
  const stamp = isoDay(meta.generatedAt || 0);
  const index = [
    "---",
    'title: "Memory"',
    ...(stamp ? [`generated: ${stamp}`] : []),
    "---",
    "",
    "# Memory",
    "",
    `This vault was exported from DeepResearch.**Se/rver**${
      meta.account ? ` for ${meta.account}` : ""
    }. It holds ${notes.length} note${notes.length === 1 ? "" : "s"} built from your research.`,
    "",
    "Open the folder in Obsidian to browse it — the links between notes are ordinary",
    "`[[wikilinks]]`, so the graph view works without any plugin.",
    "",
    "> This index file is regenerated on every export. Edits made to it here will",
    "> not survive the next download; edit the individual notes instead.",
    "",
  ];
  for (const folder of [...byType.keys()].sort()) {
    index.push(`## ${folder}`, "");
    for (const n of byType.get(folder).slice().sort((/** @type {MemoryNote} */ a, /** @type {MemoryNote} */ b) => a.slug.localeCompare(b.slug))) {
      index.push(`- [[${n.slug}]]`);
    }
    index.push("");
  }
  if (!notes.length) {
    index.push("_No notes yet. Memory fills up as you research with it switched on._", "");
  }
  files.push({ path: "Memory.md", text: index.join("\n") });
  return files;
}

// ---- the extraction phase's prompt -------------------------------------------

/**
 * The instruction the extraction phase runs with. A JSON-mode call on the
 * fixed `DEFAULT_MODEL` like every other planning phase (invariant 3), with no
 * tools (invariant 1) — memory is built by the same deterministic machinery as
 * the rest of the pipeline, not by an agent with a write tool.
 *
 * The prompt is deliberately CONSERVATIVE. A memory that records everything is
 * a liability and a mess; the value is in durable facts about recurring
 * entities, so the instruction repeatedly says to return nothing rather than
 * filler. Answer-language parity: notes follow the user's language, so a
 * Swedish conversation yields a Swedish vault.
 * @param {{ existingSlugs?: string[] }} [opts]
 * @returns {string}
 */
export function memoryExtractPrompt(opts = {}) {
  const known = (opts.existingSlugs || []).slice(0, 60);
  return [
    "You maintain a user's long-term research memory as a set of linked notes (an Obsidian vault).",
    "From the exchange below, extract only DURABLE knowledge worth remembering months from now: " +
      "the entities the user researches (people, organisations, places, concepts, events, key sources) " +
      "and what is true about them.",
    "Rules:\n" +
      `- Return at most ${MAX_NOTES_PER_TURN} notes. Returning ZERO is correct and common — most turns teach nothing durable.\n` +
      "- NEVER record: the user's passing phrasing, one-off small talk, the assistant's own reasoning, " +
      "questions themselves, or anything true only for this conversation.\n" +
      "- NEVER record credentials, keys, payment details, health details, or anything a user would be " +
      "alarmed to find written down. Skip the note entirely rather than redacting it.\n" +
      `- "title" is the entity's canonical name (max ${MAX_TITLE_CHARS} characters), the same name you would use again next month.\n` +
      `- "body" is 1-4 sentences of durable fact (max ${MAX_BODY_CHARS} characters). No preamble, no hedging.\n` +
      `- "type" is one of: ${NOTE_TYPE_IDS.join(", ")}.\n` +
      '- "links" names OTHER note titles this one relates to — this is what makes the memory a graph, so link generously among the notes you return.\n' +
      '- "tags" are 0-3 lowercase topic words, no "#".\n' +
      "- Write titles, bodies and tags in the USER'S language (skriv på svenska om användaren skriver svenska).",
    known.length
      ? `Notes that already exist — REUSE these exact titles when you mean the same thing, so the memory merges instead of duplicating:\n${known.join(", ")}`
      : "",
    'Return ONLY JSON: {"notes": [{"title": "...", "type": "...", "body": "...", "links": ["..."], "tags": ["..."]}]}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The chat context the extraction reads. Trimmed hard: the phase is a cheap
 * tail on a request that has already spent its budget, so it sees the question
 * and the answer, not the whole conversation.
 * @param {{ question: string, answer: string }} turn
 * @returns {string}
 */
export function memoryExtractInput(turn) {
  return `User asked:\n${String(turn.question || "").slice(0, 2000)}\n\nAssistant answered:\n${String(
    turn.answer || "",
  ).slice(0, 6000)}`;
}
