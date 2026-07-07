import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildProjectContext,
  normalizeProjectName,
  noteToText,
  projectDocIds,
} from "./project-context.js";

test("normalizeProjectName trims, caps, and falls back", () => {
  assert.equal(normalizeProjectName("  My project  "), "My project");
  assert.equal(normalizeProjectName(""), "Untitled project");
  assert.equal(normalizeProjectName(null), "Untitled project");
  assert.equal(normalizeProjectName("x".repeat(300)).length, 80);
});

test("noteToText leads with the title and caps both parts", () => {
  assert.equal(noteToText("Title", "Body text"), "Title\n\nBody text");
  assert.equal(noteToText("", "Just body"), "Just body");
  assert.equal(noteToText("Just title", ""), "Just title\n\n");
  const long = noteToText("t".repeat(500), "c".repeat(600_000));
  assert.ok(long.length <= 120 + 2 + 500_000);
});

test("projectDocIds returns only indexed files' ids", () => {
  const project = {
    files: [
      { id: "a", indexed: true },
      { id: "b", indexed: false },
      { id: "c", indexed: true },
      { indexed: true }, // no id — ignored
    ],
  };
  assert.deepEqual(projectDocIds(project), ["a", "c"]);
  assert.deepEqual(projectDocIds(null), []);
  assert.deepEqual(projectDocIds({}), []);
});

test("buildProjectContext lists the inventory with kinds and image metadata", () => {
  const block = buildProjectContext({
    name: "Fieldwork",
    files: [
      { id: "1", name: "site-photo.jpg", kind: "image", metadata: "GPS: 59.33, 18.06\nCamera: Apple iPhone" },
      { id: "2", name: "report.pdf", kind: "doc", indexed: true, chunkCount: 40 },
      { id: "3", name: "Meeting notes", kind: "text", indexed: true, chunkCount: 1 },
      { id: "4", name: "data.bin", kind: "file" },
    ],
  });
  assert.ok(block.includes("--- Project: Fieldwork ---"));
  assert.ok(block.includes("site-photo.jpg (image)"));
  assert.ok(block.includes("[Image metadata]"));
  assert.ok(block.includes("GPS: 59.33, 18.06"));
  assert.ok(block.includes("report.pdf (document, indexed for retrieval"));
  assert.ok(block.includes("Meeting notes (note, indexed for retrieval"));
  assert.ok(block.includes("data.bin (file)"));
  assert.ok(block.includes("--- End of project ---"));
});

test("buildProjectContext is empty for no project and bounded for huge ones", () => {
  assert.equal(buildProjectContext(null), "");
  const files = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    name: `file-${i}.pdf`,
    kind: "doc",
    indexed: true,
    metadata: "Author: someone\n".repeat(40),
  }));
  const block = buildProjectContext({ name: "Huge", files });
  assert.ok(block.length < 8000, `block too large: ${block.length}`);
});

test("buildProjectContext notes an empty project rather than fabricating", () => {
  const block = buildProjectContext({ name: "Empty", files: [] });
  assert.ok(block.includes("no materials added yet"));
});
