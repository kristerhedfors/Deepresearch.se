// Structured research notes — the pure representation/merge logic behind the
// budget-gated "notes digest" phase (see src/pipeline.js's maybeDigest and
// src/prompts.js's notesPrompt).
//
// A note distils one factual claim out of the raw source highlights and ties
// it back to the numbered source registry:
//   { claim: string, source_ids: number[], entities: string[], contradicts?: string[] }
// The digest phase (a JSON call on the cheap reliable model) produces raw
// notes from each new search wave; this module normalizes and MERGES them
// across waves (deduping by claim, unioning source ids / entities) so gap-check
// and synthesis reason over a compact claim set instead of re-reading every
// highlight. Everything here is pure and never throws — a bad note is dropped,
// never fatal, matching the fail-soft posture of the whole pipeline.

function toNumberIds(v) {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    let n = null;
    if (typeof x === "number" && Number.isFinite(x)) n = Math.trunc(x);
    else if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) n = Math.trunc(Number(x));
    if (n == null || n < 1) continue; // source numbers are 1-based
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function toStringList(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    if (typeof x !== "string") continue;
    const s = x.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Normalizes one raw note object into the canonical shape, or null if it has
// no usable claim. `contradicts` is only carried when present.
export function normalizeNote(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const claim = typeof raw.claim === "string" ? raw.claim.trim() : "";
  if (!claim) return null;
  const note = {
    claim,
    source_ids: toNumberIds(raw.source_ids),
    entities: toStringList(raw.entities),
  };
  const contradicts = toStringList(raw.contradicts);
  if (contradicts.length) note.contradicts = contradicts;
  return note;
}

// Extracts an array of canonical notes from a digest phase's JSON value
// (accepts either `{notes:[...]}` or a bare array). Pure, never throws.
export function extractNotes(value) {
  const rawList = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.notes)
      ? value.notes
      : [];
  const out = [];
  for (const raw of rawList) {
    const note = normalizeNote(raw);
    if (note) out.push(note);
  }
  return out;
}

// Dedup key: a claim's normalized text (lowercased, whitespace-collapsed).
function noteKey(note) {
  return note.claim.toLowerCase().replace(/\s+/g, " ").trim();
}

function unionNums(a, b) {
  const out = [...a];
  const seen = new Set(a);
  for (const n of b) if (!seen.has(n)) { seen.add(n); out.push(n); }
  return out;
}

function unionStrs(a, b) {
  const out = [...a];
  const seen = new Set(a.map((s) => s.toLowerCase()));
  for (const s of b) {
    const k = s.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}

// Merges `incoming` notes into `existing`, deduping by claim and unioning the
// source ids / entities / contradicts of duplicates. Both inputs may be raw or
// already-normalized; the result is always a fresh array of canonical notes
// (never shares references with the inputs).
export function mergeNotes(existing, incoming) {
  const byKey = new Map();
  const out = [];
  for (const raw of [...(existing || []), ...(incoming || [])]) {
    const note = normalizeNote(raw);
    if (!note) continue;
    const key = noteKey(note);
    const prev = byKey.get(key);
    if (prev) {
      prev.source_ids = unionNums(prev.source_ids, note.source_ids);
      prev.entities = unionStrs(prev.entities, note.entities);
      if (note.contradicts) prev.contradicts = unionStrs(prev.contradicts || [], note.contradicts);
    } else {
      const copy = { claim: note.claim, source_ids: [...note.source_ids], entities: [...note.entities] };
      if (note.contradicts) copy.contradicts = [...note.contradicts];
      byKey.set(key, copy);
      out.push(copy);
    }
  }
  return out;
}

// Unique entity list across all notes (for seeding the next digest so it can
// keep entity names consistent).
export function notesEntities(notes) {
  let acc = [];
  for (const n of notes || []) acc = unionStrs(acc, Array.isArray(n?.entities) ? n.entities : []);
  return acc;
}

// Renders notes as a compact text block for gap-check / synthesis, bounded to
// `capChars`. Each note: the claim, its cited source numbers, named entities,
// and any contradiction flag. Empty when there are no notes.
export function notesDigest(notes, capChars = 6000) {
  const lines = [];
  let used = 0;
  for (const n of notes || []) {
    if (!n?.claim) continue;
    const cites = n.source_ids?.length ? ` [${n.source_ids.map((i) => `S${i}`).join(", ")}]` : "";
    const ents = n.entities?.length ? ` (entities: ${n.entities.join(", ")})` : "";
    const contra = n.contradicts?.length ? ` (contradicts: ${n.contradicts.join("; ")})` : "";
    const line = `- ${n.claim}${cites}${ents}${contra}`;
    if (used + line.length > capChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
