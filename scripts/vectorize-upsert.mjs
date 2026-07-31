// The corpus-agnostic half of a Vectorize fill: the append-only checkpoint and
// the wrangler upsert.
//
// Extracted when the PubMed corpus became the second one to need it
// (2026-07-31). Everything here is a lesson the arXiv build paid for, and none
// of it is about arXiv:
//
//   * The machine running a fill is EPHEMERAL and the corpus is gitignored, so
//     Vectorize itself is the durable store. Each batch embeds, uploads, and
//     only THEN records — a crash re-does at most one batch instead of
//     silently skipping it. A 123-minute arXiv run took a transient upload
//     failure at batch 346 and resumed with nothing re-embedded.
//   * The checkpoint is APPEND-ONLY, one id per line. The first version
//     rewrote a JSON array of every id after each batch, which is O(corpus)
//     per batch: a 337k build would rewrite a ~4 MB file ~1,300 times.
//   * `values` must be a plain array. Embedders return Float32Array, and
//     JSON.stringify turns a typed array into an OBJECT, which Vectorize
//     rejects with "failed to parse upsert vectors request in ndjson format:
//     line Some(0) was not expected format [code: 40023]".

import { spawnSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";

/** Vectorize caps a single upsert; 1000 rows of 1024 floats is ~8 MB of
 * NDJSON, comfortably under the 100 MB request ceiling. */
export const UPSERT_BATCH = 1000;

/**
 * One corpus row → the NDJSON line Vectorize ingests.
 * @param {string} id
 * @param {number[] | Float32Array} values
 * @param {Record<string, any>} metadata
 * @returns {string}
 */
export function vectorLine(id, values, metadata) {
  return JSON.stringify({ id: String(id), values: Array.from(values), metadata });
}

/**
 * Fail loudly, at the seam where the message can be useful, rather than let
 * Cloudflare reject the batch with an opaque parse error.
 * @param {any} vectors
 * @param {number} expected
 */
export function assertVectors(vectors, expected) {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error(`embedder returned ${vectors?.length} vectors for ${expected} passages`);
  }
  if (!vectors[0] || typeof vectors[0][0] !== "number" || !vectors[0].length) {
    throw new Error(`embedder returned a malformed vector (${vectors[0]?.constructor?.name}) — expected numbers`);
  }
}

/**
 * Read the append-only checkpoint, compacting it when an interrupted run left
 * duplicate lines so the resume read stays proportional to the corpus.
 * @param {string} statePath
 * @returns {Promise<Set<string>>}
 */
export async function loadCheckpoint(statePath) {
  /** @type {Set<string>} */
  const pushed = new Set();
  const text = await readFile(statePath, "utf8").catch(() => "");
  const lines = text.split("\n").filter(Boolean);
  for (const id of lines) pushed.add(id);
  if (lines.length > pushed.size) {
    await writeFile(statePath, [...pushed].join("\n") + "\n");
  }
  return pushed;
}

/**
 * @param {string} statePath
 * @param {string[]} ids
 */
export async function recordPushed(statePath, ids) {
  if (ids.length) await appendFile(statePath, ids.join("\n") + "\n");
}

/**
 * Push one NDJSON file into Vectorize via wrangler.
 * @param {string} index
 * @param {string} file
 * @param {string} cwd
 * @returns {boolean} true on success
 */
export function upsertFile(index, file, cwd) {
  const res = spawnSync(
    "npx",
    ["wrangler", "vectorize", "upsert", index, "--file", file, "--batch-size", String(UPSERT_BATCH)],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900000 },
  );
  if (res.status !== 0) {
    const out = `${res.stdout || ""}${res.stderr || ""}`;
    console.error(`  upsert FAILED: ${out.trim().split("\n").slice(-4).join(" | ")}`);
    return false;
  }
  return true;
}
