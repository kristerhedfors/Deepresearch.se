// (no @ts-check: node:test / node:assert have no type declarations here.)
// Covers account memory's pure core: slugging, extraction normalization, the
// accumulate-don't-overwrite merge, and the Obsidian vault serialization.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_CHARS,
  MAX_NOTES_PER_TURN,
  MAX_TITLE_CHARS,
  NOTE_TYPE_IDS,
  memoryExtractInput,
  memoryExtractPrompt,
  mergeNote,
  noteSlug,
  noteToMarkdown,
  normalizeMemoryNotes,
  vaultFiles,
} from "./memory-core.js";

describe("noteSlug", () => {
  test("keeps a plain title intact", () => {
    assert.equal(noteSlug("Ada Lovelace"), "Ada Lovelace");
  });

  test("keeps hyphens and non-ASCII letters", () => {
    // Transliterating would file "Göteborg" as a different word, and a vault
    // of stripped diacritics is a broken deliverable for a Swedish user.
    assert.equal(noteSlug("Jean-Luc Picard"), "Jean-Luc Picard");
    assert.equal(noteSlug("Göteborgs universitet"), "Göteborgs universitet");
  });

  test("strips path separators and Obsidian link syntax", () => {
    // A slug is both a filename and a [[link]] target, so `/`, `[`, `]`, `#`
    // and `^` would each break one of the two.
    for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|", "#", "^", "[", "]"]) {
      assert.equal(noteSlug(`a${ch}b`).includes(ch), false, ch);
    }
  });

  test("removes leading and trailing dots", () => {
    assert.equal(noteSlug("...hidden..."), "hidden");
  });

  test("caps length and returns empty for nothing usable", () => {
    assert.equal(noteSlug("x".repeat(300)).length, MAX_TITLE_CHARS);
    for (const junk of ["", "   ", null, undefined, "///", 42]) {
      assert.equal(noteSlug(junk), typeof junk === "number" ? "42" : "", String(junk));
    }
  });
});

describe("normalizeMemoryNotes", () => {
  const one = (note) => normalizeMemoryNotes({ notes: [note] }, { now: 1000 });

  test("keeps a well-formed note", () => {
    const [n] = one({ title: "Exa", type: "organisation", body: "A web search API.", tags: ["search"] });
    assert.equal(n.slug, "Exa");
    assert.equal(n.type, "organisation");
    assert.equal(n.body, "A web search API.");
    assert.deepEqual(n.tags, ["search"]);
    assert.equal(n.created_at, 1000);
    assert.equal(n.updated_at, 1000);
  });

  test("drops notes with no title or no body — neither is memory", () => {
    assert.deepEqual(one({ title: "", body: "orphan body" }), []);
    assert.deepEqual(one({ title: "Bare name", body: "" }), []);
  });

  test("maps an unknown type to `note` rather than storing junk", () => {
    assert.equal(one({ title: "X", type: "spacecraft", body: "b" })[0].type, "note");
    for (const t of NOTE_TYPE_IDS) {
      assert.equal(one({ title: "X", type: t, body: "b" })[0].type, t);
    }
  });

  test("accepts a bare array as well as {notes: []}", () => {
    assert.equal(normalizeMemoryNotes([{ title: "X", body: "b" }]).length, 1);
  });

  test("returns [] for anything unusable instead of throwing", () => {
    for (const junk of [null, undefined, 42, "text", {}, { notes: "no" }, { notes: [null, 3] }]) {
      assert.deepEqual(normalizeMemoryNotes(junk), [], JSON.stringify(junk));
    }
  });

  test("de-duplicates by slug, case-insensitively", () => {
    const notes = normalizeMemoryNotes({
      notes: [{ title: "Exa", body: "first" }, { title: "exa", body: "second" }],
    });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].body, "first");
  });

  test("drops a self-link — a note relating to itself is not an edge", () => {
    assert.deepEqual(one({ title: "Exa", body: "b", links: ["Exa", "Berget"] })[0].links, ["Berget"]);
  });

  test("hyphenates tag whitespace and strips a leading #", () => {
    assert.deepEqual(one({ title: "X", body: "b", tags: ["#Ancient DNA"] })[0].tags, ["ancient-dna"]);
  });

  test("caps the notes one turn may propose", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `N${i}`, body: "b" }));
    assert.equal(normalizeMemoryNotes({ notes: many }).length, MAX_NOTES_PER_TURN);
  });

  test("clamps an over-long body", () => {
    assert.equal(one({ title: "X", body: "y".repeat(5000) })[0].body.length, MAX_BODY_CHARS);
  });

  test("accepts `summary` as an alias for `body`", () => {
    assert.equal(one({ title: "X", summary: "from summary" })[0].body, "from summary");
  });
});

describe("mergeNote", () => {
  const base = {
    slug: "Exa", title: "Exa", type: "organisation", body: "old body",
    links: ["Berget"], tags: ["search"], created_at: 100, updated_at: 100,
  };

  test("returns the incoming note when nothing is stored", () => {
    assert.deepEqual(mergeNote(null, { ...base }), base);
  });

  test("unions links and tags — the graph only gains edges", () => {
    const merged = mergeNote(base, { ...base, links: ["Berget", "Vectorize"], tags: ["rag"] });
    assert.deepEqual(merged.links, ["Berget", "Vectorize"]);
    assert.deepEqual(merged.tags, ["search", "rag"]);
  });

  test("takes the newer body but preserves the original creation date", () => {
    const merged = mergeNote(base, { ...base, body: "new body", created_at: 900, updated_at: 900 });
    assert.equal(merged.body, "new body");
    assert.equal(merged.created_at, 100);
    assert.equal(merged.updated_at, 900);
  });

  test("a vague `note` type never overwrites a specific stored one", () => {
    assert.equal(mergeNote(base, { ...base, type: "note" }).type, "organisation");
    assert.equal(mergeNote(base, { ...base, type: "place" }).type, "place");
  });
});

describe("noteToMarkdown", () => {
  const note = {
    slug: "Ada Lovelace", title: "Ada Lovelace", type: "person",
    body: "Wrote the first published algorithm.", links: ["Charles Babbage"],
    tags: ["computing"], created_at: Date.UTC(2026, 0, 2), updated_at: Date.UTC(2026, 6, 30),
  };

  test("opens with YAML frontmatter Obsidian reads as properties", () => {
    const md = noteToMarkdown(note);
    assert.ok(md.startsWith("---\n"), "must start with the frontmatter fence");
    assert.match(md, /^title: "Ada Lovelace"$/m);
    assert.match(md, /^type: "person"$/m);
    assert.match(md, /^created: 2026-01-02$/m);
    assert.match(md, /^updated: 2026-07-30$/m);
    assert.match(md, /^tags: \[computing\]$/m);
  });

  test("puts links in the BODY as wikilinks, not only in frontmatter", () => {
    // Obsidian's graph view and backlinks pane resolve body links; a
    // frontmatter-only list exports a graph with no visible edges.
    const md = noteToMarkdown(note);
    assert.match(md, /## Related/);
    assert.match(md, /- \[\[Charles Babbage\]\]/);
  });

  test("omits the Related section when a note has no links", () => {
    assert.equal(noteToMarkdown({ ...note, links: [] }).includes("## Related"), false);
  });

  test("escapes a quote in a title rather than breaking the YAML", () => {
    const md = noteToMarkdown({ ...note, title: 'The "Big" One', tags: [] });
    assert.match(md, /^title: "The \\"Big\\" One"$/m);
  });

  test("omits date fields when the note carries no timestamps", () => {
    const md = noteToMarkdown({ ...note, created_at: 0, updated_at: 0 });
    assert.equal(md.includes("created:"), false);
    assert.equal(md.includes("updated:"), false);
  });
});

describe("vaultFiles", () => {
  const notes = [
    { slug: "Ada Lovelace", title: "Ada Lovelace", type: "person", body: "b", links: [], tags: [], created_at: 1, updated_at: 1 },
    { slug: "Göteborg", title: "Göteborg", type: "place", body: "b", links: [], tags: [], created_at: 1, updated_at: 1 },
  ];

  test("files each note under its type's folder", () => {
    const paths = vaultFiles(notes).map((f) => f.path);
    assert.ok(paths.includes("People/Ada Lovelace.md"));
    assert.ok(paths.includes("Places/Göteborg.md"));
  });

  test("adds a root index that links every note", () => {
    const index = vaultFiles(notes).find((f) => f.path === "Memory.md");
    assert.ok(index, "the vault needs an entry point");
    assert.match(index.text, /- \[\[Ada Lovelace\]\]/);
    assert.match(index.text, /- \[\[Göteborg\]\]/);
    assert.match(index.text, /## People/);
    assert.match(index.text, /## Places/);
    assert.match(index.text, /regenerated on every export/);
  });

  test("an empty memory still exports a readable vault", () => {
    const files = vaultFiles([]);
    assert.equal(files.length, 1);
    assert.match(files[0].text, /No notes yet/);
  });

  test("an unknown type still files somewhere rather than at the root", () => {
    const [file] = vaultFiles([{ ...notes[0], type: "spacecraft" }]);
    assert.equal(file.path, "Notes/Ada Lovelace.md");
  });
});

describe("memoryExtractPrompt", () => {
  test("names every note type so the model cannot invent one", () => {
    const p = memoryExtractPrompt();
    for (const t of NOTE_TYPE_IDS) assert.ok(p.includes(t), t);
  });

  test("states the conservative rules that keep memory from becoming a chat log", () => {
    const p = memoryExtractPrompt();
    assert.match(p, /Returning ZERO is correct/);
    assert.match(p, /NEVER record: /);
    assert.match(p, /credentials/);
  });

  test("asks for the user's language — a Swedish chat yields a Swedish vault", () => {
    assert.match(memoryExtractPrompt(), /svenska/);
  });

  test("lists known titles so a second mention merges instead of duplicating", () => {
    const p = memoryExtractPrompt({ existingSlugs: ["Exa", "Berget"] });
    assert.match(p, /REUSE these exact titles/);
    assert.match(p, /Exa, Berget/);
  });

  test("omits the reuse block entirely when memory is empty", () => {
    assert.equal(memoryExtractPrompt({ existingSlugs: [] }).includes("REUSE"), false);
  });
});

describe("memoryExtractInput", () => {
  test("carries the question and the answer, both clamped", () => {
    const input = memoryExtractInput({ question: "q".repeat(5000), answer: "a".repeat(9000) });
    assert.match(input, /^User asked:\nq{2000}\n\nAssistant answered:\na{6000}$/);
  });

  test("tolerates a missing half", () => {
    assert.equal(typeof memoryExtractInput({}), "string");
  });
});
