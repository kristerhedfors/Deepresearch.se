// @ts-check
// The introspection enrichment (developer mode): when the caller's
// developer_mode knob is on and the conversation asks about THIS SITE's own
// implementation, append the deployed source snapshot as a labeled context
// block — the complete file index, a CLAUDE.md orientation excerpt, and the
// full text of any repo files the latest message names — so every phase
// (triage, synthesis, validation) answers implementation questions from the
// real code instead of guessing.
//
// The snapshot is the committed artifact public/introspect/source-snapshot.json
// (scripts/bundle-source.mjs), served by THIS deploy's static assets and read
// back here through the ASSETS binding — so what the enrichment injects is by
// construction the exact source this Worker is running. All shared logic
// (the EN+SV intent gate, path mentions, the block builder, caps) lives in
// the pure core public/js/introspect-core.js — the bash-core.js pattern: one
// implementation, imported by the Worker bundler from under public/ and by
// the browser as a served module.
//
// Standing enrichment contract (src/enrichment.js): silent when the
// conversation doesn't engage the mode, a visible step when it does, and
// fail-soft in every branch — a missing/corrupt snapshot degrades to an
// unchanged conversation, never an error.

import {
  SNAPSHOT_PATH,
  buildIntrospectionBlock,
  introspectionActive,
  maybeRepoPathMention,
  mentionedSnapshotPaths,
  validateSnapshot,
} from "../public/js/introspect-core.js";
import { textOf, withAppendedText } from "./conversation.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').RequestState} RequestState */
/** @typedef {import('../public/js/introspect-core.js').Snapshot} Snapshot */

/**
 * Every user message's text, oldest first — introspection is a MODE: one
 * engaging message keeps it on for the conversation's follow-ups.
 * @param {Conversation} conversation
 * @returns {string[]}
 */
function userTexts(conversation) {
  return conversation.filter((m) => m.role === "user").map((m) => textOf(m.content));
}

/**
 * Fetch + validate the deployed source snapshot through the ASSETS binding.
 * Null (never a throw) when the artifact is missing or unreadable.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<Snapshot | null>}
 */
export async function loadSourceSnapshot(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    // The binding routes by path; the host is a placeholder.
    const res = await assets.fetch(new Request("https://assets.internal" + SNAPSHOT_PATH));
    if (!res.ok) {
      log.warn("introspect.snapshot_missing", { status: res.status });
      return null;
    }
    const snapshot = validateSnapshot(await res.json());
    if (!snapshot) log.warn("introspect.snapshot_invalid", {});
    return snapshot;
  } catch (/** @type {any} */ err) {
    log.warn("introspect.snapshot_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * The enrichment runner (registered in src/enrichment.js; enabled =
 * state.introspection, resolved from developerModeEnabled in chat.js).
 * @param {Env} env
 * @param {Logger} log
 * @param {(id: string, label: string) => void} step
 * @param {(id: string, label: string, details?: string[]) => void} stepDone
 * @param {Conversation} conversation
 * @param {RequestState} state
 * @returns {Promise<Conversation>}
 */
export async function runIntrospectionEnrichment(env, log, step, stepDone, conversation, state) {
  const texts = userTexts(conversation);
  if (!texts.length) return conversation;
  // Regex gate first (free); otherwise the shared path pre-filter decides
  // whether the (multi-MB) snapshot is worth loading for the exact-path
  // trigger. Ordinary dev-mode chat stays at zero extra I/O.
  const gateHit = introspectionActive(texts);
  if (!gateHit && !texts.some((t) => maybeRepoPathMention(t))) return conversation;

  step("introspect", "Loading the source snapshot…");
  const snapshot = await loadSourceSnapshot(env, log);
  if (!snapshot) {
    stepDone("introspect", "Source snapshot unavailable — continuing without it");
    return conversation;
  }
  if (!gateHit && !introspectionActive(texts, snapshot)) {
    // The pre-filter fired on something that isn't actually a snapshot path.
    stepDone("introspect", "Introspection not engaged");
    return conversation;
  }

  const latestText = texts[texts.length - 1] || "";
  const block = buildIntrospectionBlock(snapshot, {
    latestText,
    // A shell transcript means the client ran the sandbox loop for this
    // message — with developer mode on, its file provider mounts the tree at
    // /src (public/js/stream.js), so the commands above really could read it.
    sandboxMounted: (/** @type {any} */ (state).shellTranscript || []).length > 0,
  });
  state.introspectionCount = 1;
  const inlined = mentionedSnapshotPaths(latestText, snapshot).slice(0, 6);
  stepDone(
    "introspect",
    `Introspection: source snapshot in context (${snapshot.count} files)`,
    [
      `digest ${snapshot.digest.slice(0, 12) || "-"} · ${snapshot.bytes} bytes`,
      ...(inlined.length ? [`inlined: ${inlined.join(", ")}`] : []),
    ],
  );
  log.info("introspect.applied", {
    files: snapshot.count,
    bytes: snapshot.bytes,
    inlined: inlined.length,
    block_chars: block.length,
  });
  // Same convention as the Shodan block: appended to the conversation so
  // every downstream phase sees it.
  return /** @type {Conversation} */ (withAppendedText(conversation, block));
}
