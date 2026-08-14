// @ts-check
// Video captures (D1 `captures` + `capture_reviews`, R2 `captures/<id>/…`) —
// the review side of the capture pipeline.
//
// The pipeline this serves: `tests/capture.mjs` drives a real browser through
// a deepresearch run for a chosen agent x model x starter prompt and records
// it; `scripts/capture-edit.mjs` cuts the dead air, ramps the speed and
// encodes a LinkedIn-ready MP4 (both share the pure core
// `scripts/capture-core.mjs`, which is where a capture's vocabulary — shapes,
// wait modes, the slug — is DEFINED). What lands here is the finished
// artefact: one metadata row per clip, the MP4 and its poster frame in R2,
// and the owner's verdict on it.
//
// The review is a SWIPE, and that is the whole product rule this module
// exists to enforce: swiping RIGHT is 👍 like — the clip is publishable, no
// explanation owed — and swiping LEFT is ✍️ feedback, which is worth nothing
// without a note ("too slow", "the model dropdown is cut off"), so the client
// shows a text field and the server REJECTS a feedback verdict that arrives
// without one (400). A like just moves the row to `liked` and bumps a
// counter; feedback moves it to `needs_work` and the note is the work order
// for the next capture run. Every verdict is also appended to
// `capture_reviews`, so a clip re-shot three times keeps the history of why.
//
// A QUEUE OF TWENTY THAT REFILLS ITSELF (owner directive, 2026-08-11). The
// unanswered clips ARE the queue — twenty of them, spanning every agent — and
// answering one is what makes room for the next: `queue-status` reports the
// deficit and the (agent, starter) pairs already spoken for, and the top-up
// records exactly that many new runs. Two consequences shape this module:
//
//  * **A capture is a THREAD, not a file.** A ✍️ verdict is answered by
//    RE-CUTTING the clip, so a new version is APPENDED (`capture_versions`)
//    and the earlier cut stays watchable beside it — nothing is overwritten.
//    The new version puts the capture back to `new` so it re-enters the queue.
//  * **`answered_at` is set once and never cleared.** It is the difference
//    between a genuinely fresh capture and a re-cut that came back around,
//    which is the one thing a status alone cannot say.
//
// A CLIP LINKS BACK TO ITS CHAT (owner directive, 2026-08-14: "link from
// captured agent videos to the actual chat so one can continue and explore
// from there"). The recorder reads the finished conversation off the page and
// files it in `chat_json`; `/:id/chat` hands it back as a seed the app reopens
// at `/?capture=<id>`, where it lands in the reader's own history and can be
// continued. Everything recorded before this keeps working: no transcript
// means `resumable: false`, and the link opens the composer with the same
// agent, model and question rather than pretending to restore a chat.
//
// Each capture also carries a number from an increasing series (`id`, written
// `#CAP-12`), a short few-word `name` derived with no model call, and the
// `commit_sha` it was recorded at — without which a clip is un-reproducible
// six merges later.
//
// VERSIONED BYTES, WITHOUT ORPHANING THE OLD ONES. A version's media lives at
// `captures/<id>/v<n>/{video.mp4,poster.jpg}`. The captures recorded before
// versions existed have their bytes at the UNVERSIONED `captures/<id>/…` keys
// and no `capture_versions` rows at all, so this module reads them as a
// synthetic v1 (see `syntheticVersionRow`) and materialises that row the
// moment a second version is added. Nothing recorded earlier stops playing.
//
// Access: the whole surface is ADMIN-gated (the gate is applied upstream, in
// index.js → admin-api.js). Captures are unpublished marketing material, so
// nothing here is reachable by a signed-in user, let alone a stranger.
//
// Fail-soft posture (invariant 2): R2 is OPTIONAL. Without an `env.STORAGE`
// binding the four byte endpoints answer 503 with a clear message and the
// metadata board — list, create, patch, review, delete — keeps working; a
// missing R2 object never blocks a row delete either.
//
// Endpoints, all under /api/admin/captures:
//   GET    /api/admin/captures            newest first; ?status= ?agent=
//                                         ?model= ?q= ?queue=1 ?limit=
//                                         ?format=text
//   GET    /api/admin/captures/queue-status   what the top-up needs: the
//                                         deficit against the target of 20 and
//                                         every (agent, starter) already used
//   GET    /api/admin/captures/chats      the recorded runs, named — what the
//                                         chat-history drawer's own group lists
//   GET    /api/admin/captures/:id/chat   THE RUN as a reopenable conversation
//   POST   /api/admin/captures            create the metadata row; the 201
//                                         carries the two upload URLs
//   GET    /api/admin/captures/:id        one capture (reviews + versions)
//   PATCH  /api/admin/captures/:id        {label?, name?, status?, ref?}
//   DELETE /api/admin/captures/:id        row + reviews + versions + R2 objects
//   PUT    /api/admin/captures/:id/video  raw MP4 bytes (100 MB cap)
//   GET    /api/admin/captures/:id/video  the CURRENT version, with Range
//   PUT    /api/admin/captures/:id/poster raw JPEG bytes (4 MB cap)
//   GET    /api/admin/captures/:id/poster the poster frame
//   POST   /api/admin/captures/:id/review THE SWIPE — {verdict, note?}
//   DELETE /api/admin/captures/:id/review UNDO the last verdict — the review
//                                         row goes, a like is un-counted, and
//                                         the capture returns to the queue
//   GET    /api/admin/captures/:id/versions          the thread, newest first
//   POST   /api/admin/captures/:id/versions          a NEW cut: version = max+1
//   PUT|GET /api/admin/captures/:id/versions/:v/video   one version's MP4
//   PUT|GET /api/admin/captures/:id/versions/:v/poster  one version's poster

import { getDb } from "./db.js";
import { jsonResponse, textResponse } from "./http.js";
import { cleanStr, likePattern } from "./chatlog.js";
import { captureChatSeed, captureTag, normalizeChatMessages, starterName } from "../public/js/captures-core.js";
import { modeForAgentId } from "../public/js/starters-core.js";

// Re-exported, not mirrored: `captureTag` is the SAME function the deck
// renders with, so the number on a card and the number in `?format=text`
// cannot drift apart. src/facade-contract.test.js enforces the identity.
export { captureTag };

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/**
 * A D1 `captures` row.
 * @typedef {{ id: number, created_at: number, updated_at: number, slug: string, label: string,
 *   agent: string, mode?: string | null, model: string, prompt: string, starter?: string | null,
 *   lang?: string | null, shape?: string | null, duration_ms: number, source_ms: number,
 *   cut_ms: number, speed: number, wait_mode?: string | null, width?: number | null,
 *   height?: number | null, size_bytes: number, video_key?: string | null,
 *   poster_key?: string | null, status: string, likes: number, ref?: string | null,
 *   name?: string | null, commit_sha?: string | null, version?: number | null,
 *   answered_at?: number | null, meta_json?: string | null,
 *   chat_json?: string | null }} CaptureRow
 */
/**
 * A D1 `capture_reviews` row.
 * @typedef {{ id: number, capture_id: number, created_at: number, verdict: string,
 *   note?: string | null, reviewer?: string | null }} CaptureReviewRow
 */
/**
 * A D1 `capture_versions` row. `id` is null for the SYNTHETIC v1 of a capture
 * recorded before the table existed — the row is real to every reader, it just
 * has no storage of its own until a second version materialises it.
 * @typedef {{ id: number | null, capture_id: number, version: number, created_at: number,
 *   commit_sha?: string | null, model?: string | null, video_key?: string | null,
 *   poster_key?: string | null, size_bytes?: number | null, duration_ms?: number | null,
 *   source_ms?: number | null, cut_ms?: number | null, speed?: number | null,
 *   wait_mode?: string | null, width?: number | null, height?: number | null,
 *   note?: string | null, meta_json?: string | null }} CaptureVersionRow
 */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/captures.test.js
// ---------------------------------------------------------------------------

export const CAPTURE_CAPS = {
  label: 200,
  // The short handle a human says out loud ("produce a review of #12, the
  // electricity one"). Deliberately much shorter than the label: a name that
  // does not fit on the card is a label with extra steps.
  name: 80,
  // A git object id, hex. Capped generously so an annotated ref ("abc1234" or
  // a full 40-char sha with a -dirty tail) fits without a rule about which.
  commit: 120,
  prompt: 8_000,
  note: 4_000,
  ref: 200,
  agent: 120,
  model: 120,
  slug: 120,
  // The three descriptive strings the harness rides along with. Short by
  // nature (a mode id, a starter id, "en"/"sv") — capped so a malformed
  // harness run cannot write an essay into a column nobody reads.
  mode: 120,
  starter: 120,
  lang: 16,
  reviewer: 120,
  // The edit report (scripts/capture-edit.mjs writes edit.json) is stored
  // whole in meta_json: segments, the ffprobe result, the LinkedIn check.
  meta: 20_000,
  // Byte ceilings for the two R2 objects.
  //
  // 100 MB is not a taste judgement: Cloudflare's EDGE rejects a request body
  // larger than that on this plan before the Worker is ever invoked, so it is
  // the real ceiling whatever this constant says. Setting ours to match is
  // what makes the failure LEGIBLE — a 150 MB upload gets our own 413 with a
  // sentence in it instead of an opaque edge error from a layer the CLI cannot
  // see. It is headroom either way: a finished feed clip aims at ~40 MB
  // (capture-core.mjs LINKEDIN.target_bytes), so the cap catches a mistake
  // (the raw recording, the wrong file) rather than shaping the product.
  video_bytes: 100 * 1024 * 1024,
  poster_bytes: 4 * 1024 * 1024,
  // Reviews read back per capture. A clip with more than this many verdicts
  // is a clip nobody is deciding about.
  reviews: 100,
  // The recorded conversation, serialized. Larger than `meta` because this is
  // the answer itself — a deep-research reply with its sources runs to tens of
  // thousands of characters, and a transcript truncated to fit would reopen as
  // a chat that stops mid-sentence. The MESSAGE-level bounds are the real
  // shape (captures-core.js CHAT_CAPS); this is the ceiling on what those
  // bounds serialize to.
  chat: 120_000,
};

// Lifecycle. `new` = not yet swiped (the deck). A 👍 moves it to `liked`
// (publishable), a ✍️ to `needs_work` (re-shoot with the note as the brief);
// `archived` retires a clip without deleting the file. A new VERSION on a
// `needs_work` capture puts it back to `new` — that is the whole thread loop.
export const CAPTURE_STATUSES = ["new", "liked", "needs_work", "archived"];

// How many unanswered clips the deck is meant to hold. Twenty is the owner's
// number: enough that the queue spans every agent, few enough that emptying it
// is an evening rather than a project. The top-up reads the DEFICIT against
// this (queue-status) rather than counting for itself, so the target lives in
// exactly one place.
export const CAPTURE_QUEUE_TARGET = 20;

// The two swipe directions. Deliberately NOT a like/dislike pair: a clip that
// is wrong is re-shot, so the left swipe collects the reason instead of a
// thumbs-down that says nothing.
export const CAPTURE_VERDICTS = ["like", "feedback"];

// One glyph per verdict, used everywhere a verdict is rendered (the text view
// here, the review feed's buttons).
/** @type {Record<string, string>} */
export const VERDICT_SYMBOLS = { like: "👍", feedback: "✍️" };

// The verdict → the status it drives.
/** @type {Record<string, string>} */
export const VERDICT_STATUS = { like: "liked", feedback: "needs_work" };

/**
 * UNDO — what the row looks like once the LAST verdict is taken back (owner
 * directive, 2026-08-13: "revert the one I just swiped right"). Pure, so the
 * rule can be read and tested without a database.
 *
 * A swipe is a fast gesture on a small target and the right one is permanent;
 * before this, a mis-swipe could only be half-fixed by PATCHing the status,
 * which left the like counted and the verdict sitting in the thread as if it
 * had been meant.
 *
 * Three decisions worth stating:
 *
 *  * **Only the last verdict.** Undo is for the swipe just made, not a way to
 *    rewrite a clip's history — a thread of what was asked for is the whole
 *    input to the re-record loop.
 *  * **The status comes from what REMAINS**, so undoing the second of two
 *    verdicts restores the first rather than dropping the capture to `new`.
 *  * **`answered_at` clears only when nothing is left.** Everywhere else in
 *    this module that stamp is set once and never cleared — that is what tells
 *    a fresh capture from a re-cut that came back around. An undo of the ONLY
 *    verdict is the one case where the stamp describes something that did not
 *    happen, and leaving it would keep the capture out of the top-up's
 *    unanswered count forever.
 *
 * @param {Array<{ id?: unknown, verdict?: unknown }>} reviews oldest first
 * @param {{ likes?: unknown }} row the capture row
 * @returns {{ review_id: number, verdict: string, status: string, likes: number,
 *   clear_answered: boolean } | null} null when there is no verdict to undo
 */
export function undoReviewState(reviews, row) {
  const list = (Array.isArray(reviews) ? reviews : []).filter(
    (r) => r && typeof r === "object" && Number.isFinite(Number(r.id)),
  );
  if (!list.length) return null;
  const verdictOf = (/** @type {any} */ r) =>
    CAPTURE_VERDICTS.includes(String(r?.verdict)) ? String(r.verdict) : "feedback";
  const last = list[list.length - 1];
  const remaining = list.slice(0, -1);
  const prior = remaining.length ? remaining[remaining.length - 1] : null;
  const verdict = verdictOf(last);
  const likes = Math.max(0, Math.round(Number(row?.likes) || 0) - (verdict === "like" ? 1 : 0));
  return {
    review_id: Math.trunc(Number(last.id)),
    verdict,
    status: prior ? VERDICT_STATUS[verdictOf(prior)] : "new",
    likes,
    clear_answered: remaining.length === 0,
  };
}

/** @type {Record<string, string>} */
const VERDICT_WORDS = { like: "👍 liked", feedback: "✍️ needs work" };

// The capture vocabulary, MIRRORED from scripts/capture-core.mjs (SHAPES /
// WAIT_MODES / PLAN_DEFAULTS) rather than imported: that module pulls in the
// whole starter registry to build its run matrix, and none of it belongs in
// the Worker bundle. The mirror is safe because these values are RECORDED
// here, never acted on — an unknown one falls back instead of erroring, so a
// harness that grows a fourth shape writes rows this module still accepts.
export const CAPTURE_SHAPES = ["portrait", "square", "landscape", "raw"];
export const DEFAULT_CAPTURE_SHAPE = "portrait";
export const CAPTURE_WAIT_MODES = ["cut", "speed", "keep"];
export const DEFAULT_WAIT_MODE = "cut";

/**
 * @param {unknown} value
 * @returns {string | null} the status, or null when it is not one of ours
 */
export function normalizeCaptureStatus(value) {
  return typeof value === "string" && CAPTURE_STATUSES.includes(value) ? value : null;
}

// Absent → null (the column is nullable); present but unrecognised → the
// default. See CAPTURE_SHAPES above for why an unknown value is not an error.
/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeShape(value) {
  const s = cleanStr(value, 40);
  if (!s) return null;
  return CAPTURE_SHAPES.includes(s) ? s : DEFAULT_CAPTURE_SHAPE;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeWaitMode(value) {
  const s = cleanStr(value, 40);
  if (!s) return null;
  return CAPTURE_WAIT_MODES.includes(s) ? s : DEFAULT_WAIT_MODE;
}

/** @param {unknown} v @param {number} [fallback] */
function nonNegInt(v, fallback = 0) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {unknown} v @returns {number | null} */
function optionalInt(v) {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Playback multiplier. Clamped rather than rejected: the number is descriptive
// (what the edit did), and a nonsense value should not lose the row.
/** @param {unknown} v */
function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(n, 0.1), 64);
}

/** @param {string | null | undefined} s */
function slugPart(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// The harness sends the slug it used for the capture DIRECTORY (capture-core's
// captureSlug), which is what makes a row traceable back to the files on the
// machine that produced it. A hand-made row still needs an identity, so one is
// derived from the same three parts.
/**
 * @param {{ agent: string, model: string, starter?: string | null, label?: string | null }} run
 * @returns {string}
 */
export function captureSlug(run) {
  return (
    [run.agent, run.model, run.starter || run.label]
      .map(slugPart)
      .filter(Boolean)
      .join("__")
      .slice(0, CAPTURE_CAPS.slug) || "capture"
  );
}

// The public reference for a capture — what the owner says and types when
// asking for one by number ("produce a review of #CAP-12"). The id IS the
// increasing series, never reused, so the tag needs no separate counter. The
// shape matches the repo's existing #UC-<id> / #XP-<nn> conventions.
/**
 * @param {number | string} id
 * @returns {string}
 */

// The short, few-word name that rides next to the number. Derived from the
// STARTER ID rather than the prompt on purpose: the id is already a
// hand-written slug of what the prompt is about (`res-sv-elpris`,
// `sch-vitamin-d`), so stripping the agent prefix and title-casing gives a
// usable name with NO network call, NO model call and no per-prompt
// maintenance — which is what a queue that tops itself up unattended needs.
// It is only a DEFAULT: `PATCH {name}` (scripts/captures --name) improves any
// one of them by hand, and the harness may send its own.
//
// `res-sv-elpris` → "Elpris"; `sch-vitamin-d` → "Vitamin D";
// `int-pipeline` → "Pipeline".
//
// The DERIVATION itself lives once, in public/js/captures-core.js's
// `starterName` — the same façade pattern as chat-modes.js and starters.js
// (the browser can only import served modules; the Worker bundler can import
// from anywhere). It was written out four times in one afternoon and the
// copies had already drifted on whether "sv" is part of the name, which is
// exactly the drift a shared core exists to prevent.
// NOT called `captureName`: the client core exports a function of that name
// which does something DIFFERENT — it RESOLVES what to display (server name →
// label → derived → prompt). This one DERIVES the default a new row is
// created with. Two different jobs must not share a name across a façade
// boundary, and src/facade-contract.test.js enforces exactly that.
/**
 * @param {{ agent?: string | null, starter?: string | null, prompt?: string | null }} run
 * @returns {string} never empty — an unnamed card in a deck of twenty is the
 *   one nobody can refer to
 */
export function deriveCaptureName(run) {
  const derived = starterName(run?.starter);
  if (derived) return derived.slice(0, CAPTURE_CAPS.name);
  // No usable starter id (a hand-driven run): the prompt's opening words are a
  // worse name but never an empty one.
  const fromPrompt = String(run?.prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ")
    .slice(0, CAPTURE_CAPS.name);
  return fromPrompt || "Untitled capture";
}

// POST body → the row fields for a new capture, or {error}. The five required
// fields are the ones without which a clip cannot be reviewed at all: what it
// shows (label), what produced it (agent, model, prompt) and how long it runs
// (duration_ms — a zero-length clip is a failed edit, not a capture).
// Everything else is descriptive and is clamped, defaulted or dropped.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, entry: {
 *   slug: string, label: string, name: string, agent: string, mode: string | null,
 *   model: string, prompt: string, starter: string | null, lang: string | null,
 *   shape: string | null, duration_ms: number, source_ms: number, cut_ms: number,
 *   speed: number, wait_mode: string | null, width: number | null, height: number | null,
 *   size_bytes: number, commit_sha: string | null, ref: string | null,
 *   meta_json: string | null, chat_json: string | null } }}
 */
export function validateCaptureCreate(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const label = cleanStr(body.label, CAPTURE_CAPS.label);
  if (!label) return { error: "A capture needs a non-empty label." };
  const agent = cleanStr(body.agent, CAPTURE_CAPS.agent);
  if (!agent) return { error: "A capture needs the agent it was recorded from." };
  const model = cleanStr(body.model, CAPTURE_CAPS.model);
  if (!model) return { error: "A capture needs the model it ran on." };
  const prompt = cleanStr(body.prompt, CAPTURE_CAPS.prompt);
  if (!prompt) return { error: "A capture needs the prompt that was sent." };
  const duration_ms = nonNegInt(body.duration_ms, 0);
  if (!duration_ms) return { error: "duration_ms must be a positive number of milliseconds." };

  const starter = cleanStr(body.starter, CAPTURE_CAPS.starter);
  const slug = cleanStr(body.slug, CAPTURE_CAPS.slug) || captureSlug({ agent, model, starter, label });
  return {
    entry: {
      slug,
      label,
      // A name is never absent: an unnamed clip cannot be asked for by name,
      // and the derivation costs nothing (see deriveCaptureName).
      name: cleanStr(body.name, CAPTURE_CAPS.name) || deriveCaptureName({ agent, starter, prompt }),
      agent,
      // The mode is DERIVED from the agent when the publisher did not send one:
      // it is what puts a reader who follows the clip's link into the agent the
      // clip recorded, and the documented `--add` recipe left it out of its
      // payload until 2026-08-14 (five Cyber clips published with `mode: null`,
      // every one of them opening in whichever agent the reader was already in).
      // A row that knows its agent should never fail to know its mode.
      mode: cleanStr(body.mode, CAPTURE_CAPS.mode) || modeForAgentId(agent),
      model,
      prompt,
      starter,
      lang: cleanStr(body.lang, CAPTURE_CAPS.lang),
      shape: normalizeShape(body.shape),
      duration_ms,
      source_ms: nonNegInt(body.source_ms, 0),
      cut_ms: nonNegInt(body.cut_ms, 0),
      speed: clampSpeed(body.speed),
      wait_mode: normalizeWaitMode(body.wait_mode),
      width: optionalInt(body.width),
      height: optionalInt(body.height),
      size_bytes: nonNegInt(body.size_bytes, 0),
      // Null when the harness could not resolve git HEAD. Honest beats a
      // guess: a wrong commit is worse than a missing one when the whole point
      // is reproducing the run.
      commit_sha: cleanStr(body.commit_sha, CAPTURE_CAPS.commit),
      ref: cleanStr(body.ref, CAPTURE_CAPS.ref),
      meta_json: serializeMeta(withoutChat(body.meta)),
      // The conversation the clip shows, when the recorder read one off the
      // page. OPTIONAL, and deliberately not an error when it is missing: a
      // capture whose transcript could not be read is still a publishable clip
      // (it just links to the composer rather than to the chat), and failing
      // the create would throw away the recording over its footnote.
      chat_json: serializeChat(chatFrom(body)),
    },
  };
}

// POST …/versions body → the fields of ONE new cut, or {error}.
//
// Same descriptive shape as a create, minus everything that identifies the
// capture: the agent, model choice, prompt and starter belong to the THREAD
// and a version that changed them would be a different capture, not a re-cut.
// `duration_ms` stays required for the same reason it is on a create — a
// zero-length version is a failed edit, and filing it would push a broken
// clip back onto the deck as if it were a fix.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, entry: {
 *   commit_sha: string | null, model: string | null, duration_ms: number,
 *   source_ms: number, cut_ms: number, speed: number, wait_mode: string | null,
 *   width: number | null, height: number | null, size_bytes: number,
 *   note: string | null, meta_json: string | null, chat_json: string | null } }}
 */
export function validateCaptureVersion(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const duration_ms = nonNegInt(body.duration_ms, 0);
  if (!duration_ms) return { error: "duration_ms must be a positive number of milliseconds." };
  return {
    entry: {
      commit_sha: cleanStr(body.commit_sha, CAPTURE_CAPS.commit),
      model: cleanStr(body.model, CAPTURE_CAPS.model),
      duration_ms,
      source_ms: nonNegInt(body.source_ms, 0),
      cut_ms: nonNegInt(body.cut_ms, 0),
      speed: clampSpeed(body.speed),
      wait_mode: normalizeWaitMode(body.wait_mode),
      width: optionalInt(body.width),
      height: optionalInt(body.height),
      size_bytes: nonNegInt(body.size_bytes, 0),
      // What this cut was meant to fix — usually the previous version's
      // feedback note, carried forward so the thread reads as a conversation.
      note: cleanStr(body.note, CAPTURE_CAPS.note),
      meta_json: serializeMeta(withoutChat(body.meta)),
      // A re-cut that came from a NEW RECORDING carries a new conversation,
      // and the capture's chat has to follow the footage — otherwise the card
      // plays v2 and opens v1's chat, the same class of lie as a version
      // quoting the previous cut's grading (#CAP-22). Null when this cut is
      // only a re-EDIT of the same run: the caller sent no transcript, and the
      // one already on the row is still the right one (see the COALESCE).
      chat_json: serializeChat(chatFrom(body)),
    },
  };
}

// THE RECORDED CONVERSATION, serialized for `chat_json`.
//
// Unlike the edit report this is NOT opaque: it is normalised through the same
// pure core the client reopens it with (captures-core.js), so a transcript
// that reaches the column is already the shape stream.js can restore. A
// transcript that normalises to nothing is stored as NULL rather than as `[]`
// — "this capture has no chat" is one fact, and it should have one
// representation whatever the caller sent.
/** @param {unknown} chat @returns {string | null} */
function serializeChat(chat) {
  const messages = normalizeChatMessages(chat);
  if (!messages.length) return null;
  try {
    const json = JSON.stringify(messages);
    return json && json.length <= CAPTURE_CAPS.chat ? json : null;
  } catch {
    return null;
  }
}

/**
 * THE TRANSCRIPT, wherever the uploader put it.
 *
 * `chat` at the top level is the intended place. The other two are where it
 * ACTUALLY arrives from the documented publish recipe, which posts the whole
 * edit report as `meta: .` — and edit.json embeds meta.json (with its `chat`)
 * under its own `meta` key. Reading all three is not tolerance for sloppiness;
 * it is what stops a correct-looking publish from silently filing a clip with
 * no chat behind it.
 * @param {any} body
 * @returns {unknown}
 */
function chatFrom(body) {
  if (!body || typeof body !== "object") return null;
  if ("chat" in body) return body.chat;
  const meta = body.meta;
  if (meta && typeof meta === "object") {
    if (Array.isArray(meta.chat)) return meta.chat;
    if (meta.meta && typeof meta.meta === "object" && Array.isArray(meta.meta.chat)) return meta.meta.chat;
  }
  return null;
}

/**
 * The edit report with the transcript taken OUT of it.
 *
 * Load-bearing, not tidiness: `CAPTURE_CAPS.meta` is 20 kB and a research
 * answer alone is bigger than that, so a report carrying the chat serializes
 * past the cap and `serializeMeta` drops THE WHOLE REPORT — the segments, the
 * ffprobe result, the run verdict — silently, in exchange for a transcript
 * that has its own column. The chat is stored once, here it is removed.
 * @param {unknown} meta
 * @returns {unknown}
 */
function withoutChat(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  const m = /** @type {any} */ ({ ...meta });
  delete m.chat;
  if (m.meta && typeof m.meta === "object" && !Array.isArray(m.meta)) {
    m.meta = { ...m.meta };
    delete m.meta.chat;
  }
  return m;
}

/**
 * `chat_json` → the messages, or []. Same fail-soft posture as parseMeta: a
 * column written by an older build, half-written by a failed upload, or
 * holding something that is not an array must render as "no transcript"
 * rather than 500 the card that asked for it.
 * @param {string | null | undefined} json
 * @returns {{ role: string, content: string }[]}
 */
function parseChat(json) {
  if (!json) return [];
  try {
    return normalizeChatMessages(JSON.parse(json));
  } catch {
    return [];
  }
}

// The edit report rides along as an opaque blob — this module reads none of
// it, so anything unserializable degrades to "no meta" rather than a 400.
/** @param {unknown} meta @returns {string | null} */
function serializeMeta(meta) {
  if (meta == null || typeof meta !== "object") return null;
  try {
    const json = JSON.stringify(meta);
    return json && json.length <= CAPTURE_CAPS.meta ? json : null;
  } catch {
    return null;
  }
}

// PATCH body → only the present fields, or {error}. Deliberately narrow: the
// recording facts (agent, model, prompt, timings) describe what was recorded
// and are not editable after the fact — a wrong one means re-capturing, not
// rewriting the record. Only the human-owned fields move.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, patch: Record<string, any> }}
 */
export function validateCapturePatch(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  /** @type {Record<string, any>} */
  const patch = {};
  if ("label" in body) {
    const label = cleanStr(body.label, CAPTURE_CAPS.label);
    if (!label) return { error: "label cannot be empty." };
    patch.label = label;
  }
  // The derived name is a default; this is how a human improves it. Empty is
  // rejected like the label — a nameless card is the one nobody can ask for.
  if ("name" in body) {
    const name = cleanStr(body.name, CAPTURE_CAPS.name);
    if (!name) return { error: "name cannot be empty." };
    patch.name = name;
  }
  if ("status" in body) {
    const status = normalizeCaptureStatus(body.status);
    if (!status) return { error: `status must be one of: ${CAPTURE_STATUSES.join(", ")}.` };
    patch.status = status;
  }
  if ("ref" in body) patch.ref = cleanStr(body.ref, CAPTURE_CAPS.ref);
  // BACKFILL ONLY. The recorder stamps this at capture time and nothing in the
  // normal path edits it — but the first four captures were published before
  // the column existed, and provenance that cannot be filled in afterwards is
  // provenance those rows never get. Validated as a hex sha rather than free
  // text, because a commit field holding "unknown" is worse than an empty one:
  // it looks like an answer.
  if ("commit_sha" in body) {
    if (body.commit_sha === null) patch.commit_sha = null;
    else {
      const sha = cleanStr(body.commit_sha, 40);
      if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
        return { error: "commit_sha must be a hex commit sha (7–40 chars), or null." };
      }
      patch.commit_sha = sha.toLowerCase();
    }
  }
  // BACKFILL, and the one recording fact that IS editable after the event.
  // The transcript is not a description of the run, it is a copy of it, and a
  // copy can be attached later: every capture published before 2026-08-14 was
  // recorded without one, and a clip whose chat cannot be filled in afterwards
  // is a clip that never gets the link. `null` clears it — a transcript read
  // off a run that went wrong is worth removing, and there has to be a way.
  if ("chat" in body) {
    if (body.chat === null) patch.chat_json = null;
    else {
      const chat = serializeChat(body.chat);
      if (!chat) {
        return { error: "chat must be a non-empty array of {role, content} messages (roles: user, assistant), or null." };
      }
      patch.chat_json = chat;
    }
  }
  if (!Object.keys(patch).length) {
    return { error: "Nothing to update — send label, name, status, ref, commit_sha and/or chat." };
  }
  return { patch };
}

// POST …/review body → {verdict, note}, or {error}.
//
// THE product rule: a LEFT swipe (feedback) without a note is rejected. A clip
// that "isn't right" and no record of why produces the same clip again on the
// next run, so the note is not optional decoration — it is the entire payload
// of that half of the gesture. The right swipe carries its meaning in the
// gesture itself, so its note stays optional.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, verdict: string, note: string | null }}
 */
export function validateCaptureReview(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  if (!CAPTURE_VERDICTS.includes(body.verdict)) {
    return { error: `verdict must be one of: ${CAPTURE_VERDICTS.join(", ")}.` };
  }
  const note = cleanStr(body.note, CAPTURE_CAPS.note);
  if (body.verdict === "feedback" && !note) {
    return { error: "A feedback swipe needs a note — say what is wrong with the clip." };
  }
  return { verdict: body.verdict, note };
}

/** @param {number} id */
export function videoUrl(id) {
  return `/api/admin/captures/${id}/video`;
}

/** @param {number} id */
export function posterUrl(id) {
  return `/api/admin/captures/${id}/poster`;
}

/** Where the recorded conversation is read from. The app's own
 * `/?capture=<id>` link is what a HUMAN follows (captures-core.js
 * captureChatUrl); this is the endpoint that link's boot handler fetches.
 * @param {number} id */
export function chatUrl(id) {
  return `/api/admin/captures/${id}/chat`;
}

// The per-version URLs. The unversioned pair above always serves the CURRENT
// version, so the deck can keep using it and only the thread view needs these.
/** @param {number} id @param {number} version */
export function versionVideoUrl(id, version) {
  return `/api/admin/captures/${id}/versions/${version}/video`;
}

/** @param {number} id @param {number} version */
export function versionPosterUrl(id, version) {
  return `/api/admin/captures/${id}/versions/${version}/poster`;
}

// A version number that came off a URL or a row. Falsy → 1: a capture written
// before the column existed IS version 1, and reading it as 0 would make its
// bytes unreachable.
/** @param {unknown} v @returns {number} */
export function captureVersionNumber(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** @param {string | null | undefined} json */
function parseMeta(json) {
  if (!json) return {};
  try {
    const m = JSON.parse(json);
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

// A D1 `capture_reviews` row → API object.
/**
 * @param {CaptureReviewRow} row
 * @returns {any}
 */
export function projectCaptureReview(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    time: new Date(row.created_at).toISOString(),
    verdict: CAPTURE_VERDICTS.includes(row.verdict) ? row.verdict : "feedback",
    note: row.note || null,
    reviewer: row.reviewer || null,
  };
}

// The v1 that a capture recorded before `capture_versions` existed HAS but has
// no row for. Read straight off the captures row — including its unversioned
// `video_key`, which is precisely why those four live clips keep playing. Pure:
// the same object is what gets INSERTed when a second version materialises it.
/**
 * @param {CaptureRow} row
 * @returns {CaptureVersionRow}
 */
export function syntheticVersionRow(row) {
  return {
    id: null, // no storage of its own — yet
    capture_id: row.id,
    version: 1,
    created_at: row.created_at,
    commit_sha: row.commit_sha || null,
    model: row.model || null,
    video_key: row.video_key || null,
    poster_key: row.poster_key || null,
    size_bytes: row.size_bytes || 0,
    duration_ms: row.duration_ms || 0,
    source_ms: row.source_ms || 0,
    cut_ms: row.cut_ms || 0,
    speed: row.speed || 1,
    wait_mode: row.wait_mode || null,
    width: row.width || null,
    height: row.height || null,
    note: null,
    meta_json: null,
  };
}

// A version row → API object. `is_current` is what the thread view renders as
// "the one on the card"; everything else is the same descriptive set the
// capture itself carries, so a viewer can compare two cuts side by side.
/**
 * @param {CaptureVersionRow} row
 * @param {number} currentVersion the capture's `version` column
 * @returns {any}
 */
export function projectCaptureVersion(row, currentVersion) {
  const version = captureVersionNumber(row.version);
  return {
    id: row.id ?? null,
    version,
    created_at: row.created_at || 0,
    time: new Date(row.created_at || 0).toISOString(),
    commit_sha: row.commit_sha || null,
    model: row.model || null,
    size_bytes: row.size_bytes || 0,
    duration_ms: row.duration_ms || 0,
    source_ms: row.source_ms || 0,
    cut_ms: row.cut_ms || 0,
    speed: row.speed || 1,
    wait_mode: row.wait_mode || null,
    width: row.width || null,
    height: row.height || null,
    note: row.note || null,
    // Each cut's OWN edit report — the segment plan, the ffprobe result, and
    // for an Agent Studio run the app-e2e grading. It was written to D1 from
    // the first version onward and never read back out, so the only report any
    // surface could show was the parent row's, whichever cut that belonged to.
    meta: parseMeta(row.meta_json ?? null),
    video_url: versionVideoUrl(row.capture_id, version),
    poster_url: versionPosterUrl(row.capture_id, version),
    has_video: !!row.video_key,
    is_current: version === captureVersionNumber(currentVersion),
  };
}

// Row → API object. The key set is a CONTRACT with the review feed: it reads
// `video_url`/`poster_url` straight into the <video>/<img>, `has_video` to
// decide whether the card is playable at all, and `meta` for the edit report.
// Optional columns are null-safe because a hand-made row (or an older row
// created before a column was populated) must still render.
//
// `versions` is attached only when the caller asked for the thread (the single
// -capture GET), never on the list — twenty cards do not each need their
// history, and the key would be a lie if it were always an empty array.
/**
 * @param {CaptureRow} row
 * @param {CaptureVersionRow[]} [versions] newest first
 * @returns {any}
 */
export function projectCapture(row, versions) {
  const version = captureVersionNumber(row.version);
  return {
    id: row.id,
    tag: captureTag(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    time: new Date(row.created_at).toISOString(),
    slug: row.slug,
    label: row.label,
    name: row.name || null,
    agent: row.agent,
    // THE MODE A CARD'S LINK REOPENS THE RUN IN. Derived from the agent when
    // the column is empty, which is the whole repair for the rows already in
    // D1: the documented `--add` recipe never sent `mode`, so five published
    // Cyber clips carry `agent: "cyber"` with `mode: null`, and "💬 Continue
    // this chat" left the reader in whatever agent they were already in — a
    // recorded Cyber run answered by Deep Science, with nothing on screen
    // saying the agent moved (reported 2026-08-14).
    //
    // Read-time rather than a migration because the agent is required on every
    // row and the mapping is one table (`MODE_AGENTS`, via `modeForAgentId`),
    // so there is nothing a backfill would know that this does not. Still null
    // for an agent with no mode of its own (`secure`, a TIER) — the app leaves
    // the reader's current agent alone rather than guessing.
    mode: row.mode || modeForAgentId(row.agent) || null,
    model: row.model,
    prompt: row.prompt,
    starter: row.starter || null,
    lang: row.lang || null,
    shape: row.shape || null,
    duration_ms: row.duration_ms || 0,
    source_ms: row.source_ms || 0,
    cut_ms: row.cut_ms || 0,
    speed: row.speed || 1,
    wait_mode: row.wait_mode || null,
    width: row.width || null,
    height: row.height || null,
    size_bytes: row.size_bytes || 0,
    status: row.status,
    likes: row.likes || 0,
    ref: row.ref || null,
    commit_sha: row.commit_sha || null,
    version,
    // Set on the FIRST verdict and never cleared — `status` alone cannot tell
    // a fresh capture from a re-cut that came back around to `new`.
    answered_at: row.answered_at || null,
    answered: !!row.answered_at,
    has_video: !!row.video_key,
    has_poster: !!row.poster_key,
    video_url: videoUrl(row.id),
    poster_url: posterUrl(row.id),
    // THE CHAT BEHIND THE CLIP. The messages themselves are NOT on the list
    // projection — twenty cards would each carry a full research answer, which
    // is a megabyte of feed nobody reads. What every surface needs is the two
    // facts here: whether a transcript exists (so the link can promise to
    // CONTINUE the chat rather than only re-ask the question) and where to
    // open it. The transcript itself is one GET away, at chat_url.
    has_chat: !!row.chat_json,
    chat_url: chatUrl(row.id),
    meta: parseMeta(row.meta_json),
    reviews: [],
    ...(versions ? { versions: versions.map((v) => projectCaptureVersion(v, version)) } : {}),
  };
}

// The top-up's whole input, computed from the capture rows in one pass.
//
// `deficit` is what it records next: how many NEW runs bring the unanswered
// deck back to the target. `used` is what stops it recording the same prompt
// twice — every (agent, starter) pair already in the deck IN ANY STATUS, so a
// liked or archived clip's prompt is not silently re-shot as if it were new.
// `by_agent` is the spread over the queue, which is how the top-up keeps
// twenty clips from all being the same agent.
/**
 * @param {Array<{ agent?: string | null, starter?: string | null, status?: string | null }>} rows
 * @param {{ target?: number, agents?: string[] }} [opts] `agents` seeds the
 *   spread with zeroes so an agent with nothing in the queue is visible as a
 *   gap rather than an absent key
 * @returns {{ target: number, unanswered: number, deficit: number,
 *   by_agent: Record<string, number>, used: Array<{ agent: string, starter: string }> }}
 */
export function captureQueueStatus(rows, opts = {}) {
  const target = Math.min(Math.max(Math.round(Number(opts.target)) || CAPTURE_QUEUE_TARGET, 1), 200);
  // A Map rather than a plain object: agent ids come off rows and query
  // strings, and "__proto__" as a key must be a counter, not a prototype.
  /** @type {Map<string, number>} */
  const byAgent = new Map();
  for (const a of opts.agents || []) if (a) byAgent.set(String(a), 0);
  let unanswered = 0;
  /** @type {Array<{ agent: string, starter: string }>} */
  const used = [];
  const seen = new Set();
  for (const row of rows || []) {
    const agent = String(row?.agent || "");
    if (row?.status === "new") {
      unanswered++;
      if (agent) byAgent.set(agent, (byAgent.get(agent) || 0) + 1);
    }
    const starter = row?.starter ? String(row.starter) : "";
    if (!agent || !starter) continue; // nothing to de-duplicate a re-record on
    const key = `${agent}\u0000${starter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used.push({ agent, starter });
  }
  return {
    target,
    unanswered,
    deficit: Math.max(0, target - unanswered),
    by_agent: Object.fromEntries(byAgent),
    used,
  };
}

/** @param {number} ms */
function dur(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** @param {number} bytes */
function mb(bytes) {
  return `${Math.round((Math.max(0, Number(bytes) || 0) / (1024 * 1024)) * 10) / 10} MB`;
}

// Plain-text rendering (?format=text): newest first, one block per capture.
// Made to be READ by the Claude Code loop that produces captures and acts on
// the feedback — so every block carries the four things a re-shoot needs (which
// agent, which model, the exact prompt, what the edit did) and the verbatim
// notes. Not a parseable format.
/**
 * @param {any[]} entries projectCapture output
 * @returns {string}
 */
export function formatCapturesText(entries) {
  if (!entries.length) return "(no captures match)\n";
  return (
    entries
      .map((e) => {
        // The tag rather than a bare id: it is how the owner refers to a clip
        // out loud, so the text view spells it the same way ("#CAP-12").
        const lines = [`── ${captureTag(e.id)} [${e.status}] ${e.name ? `${e.name} — ` : ""}${e.label}`];
        const facts = [`${e.agent} · ${e.model}`];
        if (e.mode) facts.push(`mode ${e.mode}`);
        if (e.lang) facts.push(e.lang);
        if (e.shape) facts.push(e.shape);
        if (e.starter) facts.push(`starter ${e.starter}`);
        lines.push(`RUN: ${facts.join(" · ")}`);
        lines.push(`PROMPT: ${e.prompt}`);
        const edit = [
          `${dur(e.duration_ms)} final`,
          `${dur(e.source_ms)} recorded`,
          `${dur(e.cut_ms)} cut`,
          `${e.speed}x`,
        ];
        if (e.wait_mode) edit.push(`waits ${e.wait_mode}`);
        lines.push(`EDIT: ${edit.join(" · ")}`);
        // The thread's state in one line: which cut is on the card, the commit
        // it was recorded at (what makes it reproducible) and whether this
        // capture has ever been answered.
        const thread = [`v${e.version || 1}`];
        if (e.commit_sha) thread.push(`commit ${String(e.commit_sha).slice(0, 12)}`);
        if (Array.isArray(e.versions) && e.versions.length > 1) {
          thread.push(`${e.versions.length - 1} earlier version${e.versions.length > 2 ? "s" : ""} kept`);
        }
        thread.push(e.answered_at ? `answered ${new Date(e.answered_at).toISOString()}` : "UNANSWERED");
        lines.push(`THREAD: ${thread.join(" · ")}`);
        const media = [e.has_video ? `${e.video_url} (${mb(e.size_bytes)})` : "no video uploaded"];
        if (e.width && e.height) media.push(`${e.width}x${e.height}`);
        if (e.has_poster) media.push("poster");
        lines.push(`VIDEO: ${media.join(" · ")}`);
        if (e.likes) lines.push(`LIKES: ${e.likes}`);
        if (e.ref) lines.push(`REF: ${e.ref}`);
        if (Array.isArray(e.reviews) && e.reviews.length) {
          lines.push("REVIEWS:");
          for (const r of e.reviews) {
            lines.push(
              `  ${VERDICT_WORDS[r.verdict] || r.verdict} (${r.time})` +
                (r.reviewer ? ` ${r.reviewer}` : "") +
                (r.note ? ` — ${r.note}` : ""),
            );
          }
        }
        return lines.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// HTTP Range — because the deck is a <video> element someone scrubs
// ---------------------------------------------------------------------------
//
// A capture is reviewed by watching it, which means seeking: Safari in
// particular refuses to play a video at all unless the server answers a byte
// range with a 206. R2 takes {offset, length} directly, so all this has to do
// is turn the header into those two numbers.
//
// Returns null for anything not worth honouring — a malformed header, a
// multi-range request (we serve one range or the whole file, never
// multipart/byteranges), or a start past the end. The caller treats null as
// "ignore the header and send the whole object", which is what RFC 9110 says
// to do with a Range a server does not understand.
/**
 * @param {string | null | undefined} header the raw `Range` header
 * @param {number} size the object's total size in bytes
 * @returns {{ offset: number, length: number, end: number } | null}
 */
export function parseRange(header, size) {
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (typeof header !== "string") return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let offset;
  let end;
  if (rawStart === "") {
    // Suffix form: "bytes=-500" is the LAST 500 bytes, not the first 500.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    offset = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    offset = Number(rawStart);
    if (!Number.isFinite(offset) || offset >= total) return null; // unsatisfiable
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
    if (!Number.isFinite(end) || end < offset) return null;
    if (end > total - 1) end = total - 1; // an over-long end is clamped, not rejected
  }
  return { offset, length: end - offset + 1, end };
}

// ---------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------

// The UNVERSIONED keys. Everything recorded before versions existed lives
// here, and this stays the fallback for v1 forever — those objects are not
// worth a migration job, and a key that already works is the cheapest possible
// back-compat.
/** @param {number} id */
const videoKey = (id) => `captures/${id}/video.mp4`;
/** @param {number} id */
const posterKey = (id) => `captures/${id}/poster.jpg`;

// Where a version's bytes go from now on.
/** @param {number} id @param {number} v */
const versionVideoKey = (id, v) => `captures/${id}/v${v}/video.mp4`;
/** @param {number} id @param {number} v */
const versionPosterKey = (id, v) => `captures/${id}/v${v}/poster.jpg`;

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<CaptureRow | null>}
 */
async function getCapture(db, id) {
  return /** @type {Promise<CaptureRow | null>} */ (
    db.prepare("SELECT * FROM captures WHERE id = ?").bind(id).first()
  );
}

// A capture's whole thread, newest first. A capture with NO rows is one
// recorded before the table existed: it still has a v1, so one is synthesized
// from the captures row rather than reporting an empty history. Fail-soft — a
// read that errors degrades to that same single version.
/**
 * @param {D1Database} db
 * @param {CaptureRow} capture
 * @returns {Promise<CaptureVersionRow[]>}
 */
async function listVersions(db, capture) {
  const { results } = await db
    .prepare("SELECT * FROM capture_versions WHERE capture_id = ? ORDER BY version DESC")
    .bind(capture.id)
    .all()
    .catch(() => ({ results: [] }));
  const rows = /** @type {CaptureVersionRow[]} */ (results || []);
  return rows.length ? rows : [syntheticVersionRow(capture)];
}

// Materialise the synthetic v1 as a real row, so that adding v2 does not leave
// the original cut describable only by a captures row that v2 is about to
// overwrite. Idempotent by construction: it only ever runs when the capture has
// no rows at all.
/**
 * @param {D1Database} db
 * @param {CaptureRow} capture
 * @param {CaptureVersionRow[]} existing the result of listVersions
 * @returns {Promise<void>}
 */
async function materializeV1(db, capture, existing) {
  if (existing.some((v) => v.id != null)) return; // already stored
  const v1 = syntheticVersionRow(capture);
  await db
    .prepare(
      `INSERT INTO capture_versions (capture_id, version, created_at, commit_sha, model, video_key,
         poster_key, size_bytes, duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, note, meta_json)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      capture.id, v1.created_at, v1.commit_sha, v1.model, v1.video_key, v1.poster_key,
      v1.size_bytes, v1.duration_ms, v1.source_ms, v1.cut_ms, v1.speed, v1.wait_mode,
      v1.width, v1.height,
      // v1's edit report travels WITH v1. It used to be dropped here, which lost
      // the only record of how the original cut was made and graded — while the
      // parent row kept serving that same report against every later cut.
      capture.meta_json ?? null,
    )
    .run()
    .catch(() => {});
}

// Which R2 key holds one version's bytes.
//
// THE BACK-COMPAT RULE lives here: v1 falls back to the capture's own
// `video_key`/`poster_key` (the unversioned object) whenever the version row
// has none — which covers both a capture recorded before versions existed and
// a v1 row materialised from one. Null means "there is nothing to serve",
// which the caller turns into a 404 rather than a throw.
/**
 * @param {CaptureRow} capture
 * @param {CaptureVersionRow[]} versions
 * @param {number} v
 * @param {"video" | "poster"} kind
 * @returns {string | null}
 */
function versionKeyFor(capture, versions, v, kind) {
  const row = versions.find((r) => captureVersionNumber(r.version) === v);
  const stored = row ? (kind === "video" ? row.video_key : row.poster_key) : null;
  if (stored) return String(stored);
  if (v !== 1) return null;
  // The capture's own pointer only speaks for v1 while v1 IS the current cut.
  // Past that it names the newest version's bytes, and serving those as v1
  // would quietly answer "show me the original" with the re-cut.
  const own =
    captureVersionNumber(capture.version) === 1 ? (kind === "video" ? capture.video_key : capture.poster_key) : null;
  return own || (kind === "video" ? videoKey(capture.id) : posterKey(capture.id));
}

// Attach each capture's reviews (oldest first, capped) to a list of projected
// captures — ONE query for the whole page, not one per capture. Fail-soft: a
// read that errors leaves the captures with empty review lists rather than
// failing the request.
/**
 * @param {D1Database} db
 * @param {any[]} entries projectCapture output (mutated in place)
 * @returns {Promise<any[]>}
 */
async function attachReviews(db, entries) {
  if (!entries.length) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) e.reviews = [];
  const marks = entries.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM capture_reviews WHERE capture_id IN (${marks}) ORDER BY id ASC`)
    .bind(...entries.map((e) => e.id))
    .all()
    .catch(() => ({ results: [] }));
  for (const row of /** @type {any[]} */ (results || [])) {
    const e = byId.get(row.capture_id);
    if (e && e.reviews.length < CAPTURE_CAPS.reviews) e.reviews.push(projectCaptureReview(row));
  }
  return entries;
}

// Count of un-swiped captures — feeds the admin panel's deck badge. Fail-soft
// to 0: a badge is never worth a 500.
/**
 * @param {Env} env
 * @returns {Promise<number>}
 */
export async function countNewCaptures(env) {
  const db = await getDb(env).catch(() => null);
  if (!db) return 0;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM captures WHERE status = 'new'")
    .first()
    .catch(() => null);
  return /** @type {number} */ (row?.n) || 0;
}

/** @param {Env} env @returns {R2Bucket | null} */
function bucket(env) {
  return /** @type {any} */ (env)?.STORAGE || null;
}

const NO_STORAGE = "Object storage (R2) is not configured on this server — the clip itself cannot be stored or served.";

// ---------------------------------------------------------------------------
// Admin surface — /api/admin/captures* (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminCaptures(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/captures/, "");
  const method = request.method;

  // GET /api/admin/captures — the board (or, with ?queue=1, the review queue).
  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 200);
    const where = [];
    /** @type {any[]} */
    const binds = [];
    if (p.get("queue") === "1") where.push("status = 'new'");
    if (normalizeCaptureStatus(p.get("status"))) {
      where.push("status = ?");
      binds.push(p.get("status"));
    }
    if (p.get("agent")) {
      where.push("agent = ?");
      binds.push(p.get("agent"));
    }
    if (p.get("model")) {
      where.push("model = ?");
      binds.push(p.get("model"));
    }
    if (p.get("q")) {
      where.push("(label LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')");
      const pat = likePattern(p.get("q"));
      binds.push(pat, pat);
    }
    const sql =
      "SELECT * FROM captures" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id DESC LIMIT ?";
    const { results } = await db.prepare(sql).bind(...binds, limit).all();
    // Not `.map(projectCapture)`: map passes the INDEX as the second argument,
    // which projectCapture now reads as the version list.
    const entries = await attachReviews(
      db,
      (/** @type {CaptureRow[]} */ (results || [])).map((r) => projectCapture(r)),
    );
    if (p.get("format") === "text") return textResponse(formatCapturesText(entries));
    return jsonResponse({ captures: entries, count: entries.length });
  }

  // GET /api/admin/captures/queue-status — the top-up's entire input.
  //
  // Answered by ONE scan of the rows rather than four aggregate queries: the
  // `used` list needs every (agent, starter) pair anyway, and a deck of a few
  // hundred captures is a small read. The scan is bounded all the same — a
  // status endpoint that gets slower forever is a status endpoint that stops
  // being called.
  if (path === "/queue-status" && method === "GET") {
    const p = url.searchParams;
    // The caller may name the agents it intends to record from (the harness
    // knows the roster; the Worker deliberately does not pull the starter
    // registry into its bundle), so an agent with nothing in the queue shows
    // as a 0 rather than an absent key.
    const agents = (p.get("agents") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    const { results } = await db
      .prepare("SELECT agent, starter, status FROM captures ORDER BY id DESC LIMIT ?")
      .bind(2_000)
      .all()
      .catch(() => ({ results: [] }));
    const status = captureQueueStatus(/** @type {any[]} */ (results || []), {
      target: Number(p.get("target")) || CAPTURE_QUEUE_TARGET,
      agents,
    });
    return jsonResponse(status);
  }

  // GET /api/admin/captures/chats — THE RECORDED RUNS, as the chat-history
  // drawer's own group lists them (public/js/capture-chats.js).
  //
  // A separate endpoint rather than a flag on the list above, for one reason
  // that decides it: this one is opened on every history-drawer refresh by a
  // pane that is mostly about the reader's own conversations, so it must stay
  // small. It selects the naming columns only — never `meta_json`, never
  // `chat_json` — so the group costs a few hundred bytes whatever the deck
  // holds. `has_chat` still comes back, because it is what says whether a row
  // reopens a conversation or only a question, and that is computable from the
  // column's nullness without reading it.
  //
  // Ordered newest first and bounded: the drawer shows the recent runs, and
  // the review feed at /captures/ is where the whole archive lives.
  if (path === "/chats" && method === "GET") {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 30, 1), 200);
    const { results } = await db
      .prepare(
        `SELECT id, created_at, slug, label, name, agent, mode, model, prompt, starter, lang,
           status, chat_json IS NOT NULL AS has_chat
         FROM captures ORDER BY id DESC LIMIT ?`,
      )
      .bind(limit)
      .all();
    const captures = (/** @type {any[]} */ (results || [])).map((r) => ({
      id: r.id,
      tag: captureTag(r.id),
      created_at: r.created_at,
      slug: r.slug,
      label: r.label,
      name: r.name || null,
      agent: r.agent,
      mode: r.mode || null,
      model: r.model,
      prompt: r.prompt,
      starter: r.starter || null,
      lang: r.lang || null,
      status: r.status,
      // D1 answers a boolean expression with 0/1, not a JS boolean.
      has_chat: !!r.has_chat,
      chat_url: chatUrl(r.id),
    }));
    return jsonResponse({ captures, count: captures.length });
  }

  // POST /api/admin/captures — the metadata row. The bytes follow in two
  // separate PUTs, whose URLs the response hands back so the uploader never
  // has to build them.
  if (path === "" && method === "POST") {
    const body = await request.json().catch(() => null);
    const v = validateCaptureCreate(body);
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const e = v.entry;
    const now = Date.now();
    const res = await db
      .prepare(
        `INSERT INTO captures (created_at, updated_at, slug, label, name, agent, mode, model, prompt, starter,
           lang, shape, duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, size_bytes,
           commit_sha, version, answered_at, status, likes, ref, meta_json, chat_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'new', 0, ?, ?, ?)`,
      )
      .bind(
        now, now, e.slug, e.label, e.name, e.agent, e.mode, e.model, e.prompt, e.starter,
        e.lang, e.shape, e.duration_ms, e.source_ms, e.cut_ms, e.speed, e.wait_mode,
        e.width, e.height, e.size_bytes, e.commit_sha, e.ref, e.meta_json, e.chat_json,
      )
      .run();
    const id = /** @type {number} */ (res.meta?.last_row_id);
    // Metadata only in the log line — the prompt is user-facing content and
    // already lives in the row.
    log.info("capture.created", { id, agent: e.agent, model: e.model, shape: e.shape });
    const row = await getCapture(db, id);
    return jsonResponse(
      {
        capture: projectCapture(/** @type {CaptureRow} */ (row)),
        upload: { video: videoUrl(id), poster: posterUrl(id) },
      },
      201,
    );
  }

  // Two shapes past the collection: /:id[/video|/poster|/review|/versions] and
  // the per-version media /:id/versions/:v/(video|poster). Matched separately
  // so an unknown tail still 404s instead of being read as a sub-path.
  const verMatch = path.match(/^\/(\d+)\/versions\/(\d+)\/(video|poster)$/);
  const idMatch = verMatch ? null : path.match(/^\/(\d+)(\/video|\/poster|\/review|\/versions|\/chat)?$/);
  const match = verMatch || idMatch;
  if (!match) return jsonResponse({ error: "Not found." }, 404);
  const capture = await getCapture(db, Number(match[1]));
  if (!capture) return jsonResponse({ error: "No such capture." }, 404);
  const sub = (idMatch && idMatch[2]) || "";

  // PUT|GET /api/admin/captures/:id/versions/:v/(video|poster) — one cut's
  // bytes. This is what makes older versions RETAINED rather than replaced:
  // the current card plays /:id/video, and every earlier cut stays reachable
  // at its own path forever.
  if (verMatch) {
    const v = captureVersionNumber(verMatch[2]);
    const kind = /** @type {"video" | "poster"} */ (verMatch[3]);
    const versions = await listVersions(db, capture);
    if (method === "PUT") {
      // v1 may still be synthetic (a capture recorded before the table) — give
      // it a row before writing bytes at it, so the thread stays complete.
      if (v === 1) await materializeV1(db, capture, versions);
      const known = v === 1 || versions.some((r) => captureVersionNumber(r.version) === v);
      if (!known) return jsonResponse({ error: `No version v${v} on this capture.` }, 404);
      return putMedia(request, env, log, db, capture, {
        kind,
        key: kind === "video" ? versionVideoKey(capture.id, v) : versionPosterKey(capture.id, v),
        contentType: kind === "video" ? "video/mp4" : "image/jpeg",
        maxBytes: kind === "video" ? CAPTURE_CAPS.video_bytes : CAPTURE_CAPS.poster_bytes,
        version: v,
      });
    }
    if (method === "GET") {
      const key = versionKeyFor(capture, versions, v, kind);
      if (!key) return jsonResponse({ error: `No version v${v} on this capture.` }, 404);
      return getMedia(request, env, capture.id, key, kind === "video" ? "video/mp4" : "image/jpeg", kind === "video");
    }
    return jsonResponse({ error: "Not found." }, 404);
  }

  // GET /api/admin/captures/:id — one card, reviews AND the whole thread.
  if (!sub && method === "GET") {
    const versions = await listVersions(db, capture);
    const [projected] = await attachReviews(db, [projectCapture(capture, versions)]);
    if (url.searchParams.get("format") === "text") return textResponse(formatCapturesText([projected]));
    return jsonResponse({ capture: projected });
  }

  // PATCH /api/admin/captures/:id — rename, retire, re-reference.
  if (!sub && method === "PATCH") {
    const v = validateCapturePatch(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const sets = ["updated_at = ?"];
    /** @type {any[]} */
    const binds = [Date.now()];
    for (const [k, val] of Object.entries(v.patch)) {
      sets.push(`${k} = ?`);
      binds.push(val);
    }
    await db.prepare(`UPDATE captures SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, capture.id).run();
    log.info("capture.patched", { id: capture.id, fields: Object.keys(v.patch) });
    return jsonResponse({ capture: await readBack(db, capture.id) });
  }

  // DELETE /api/admin/captures/:id — the clip, its reviews, EVERY version and
  // all their bytes. The R2 deletes are fail-soft on purpose: an object that
  // was never uploaded (or that a previous half-finished delete already
  // removed) must not strand the row, which would leave an undeletable card in
  // the deck forever.
  if (!sub && method === "DELETE") {
    const b = bucket(env);
    if (b) {
      // Both eras: the unversioned pair a pre-versions capture used, and every
      // key the thread ever recorded.
      const keys = new Set([videoKey(capture.id), posterKey(capture.id)]);
      if (capture.video_key) keys.add(capture.video_key);
      if (capture.poster_key) keys.add(capture.poster_key);
      for (const v of await listVersions(db, capture)) {
        if (v.video_key) keys.add(v.video_key);
        if (v.poster_key) keys.add(v.poster_key);
      }
      for (const key of keys) await b.delete(key).catch(() => {});
    }
    await db.prepare("DELETE FROM capture_reviews WHERE capture_id = ?").bind(capture.id).run().catch(() => {});
    await db.prepare("DELETE FROM capture_versions WHERE capture_id = ?").bind(capture.id).run().catch(() => {});
    await db.prepare("DELETE FROM captures WHERE id = ?").bind(capture.id).run();
    log.info("capture.deleted", { id: capture.id });
    return jsonResponse({ ok: true });
  }

  // PUT …/video, PUT …/poster — the raw bytes of the CURRENT version. Exactly
  // equivalent to PUT …/versions/<current>/video: the uploader that just
  // recorded a re-cut should not have to know which number it is.
  if ((sub === "/video" || sub === "/poster") && method === "PUT") {
    const kind = sub === "/poster" ? "poster" : "video";
    const current = captureVersionNumber(capture.version);
    return putMedia(request, env, log, db, capture, {
      kind,
      key: kind === "video" ? versionVideoKey(capture.id, current) : versionPosterKey(capture.id, current),
      contentType: kind === "video" ? "video/mp4" : "image/jpeg",
      maxBytes: kind === "video" ? CAPTURE_CAPS.video_bytes : CAPTURE_CAPS.poster_bytes,
      version: current,
    });
  }

  // GET …/video — the CURRENT version, with real Range support (see
  // parseRange). `video_key` is the pointer the last upload wrote; the
  // unversioned key is the fallback that keeps the four pre-versions captures
  // playing.
  if (sub === "/video" && method === "GET") {
    return getMedia(request, env, capture.id, capture.video_key || videoKey(capture.id), "video/mp4", true);
  }
  // GET …/poster — a poster frame is small; nothing seeks into a JPEG.
  if (sub === "/poster" && method === "GET") {
    return getMedia(request, env, capture.id, capture.poster_key || posterKey(capture.id), "image/jpeg", false);
  }

  // GET …/chat — THE RUN, as a conversation the app can reopen.
  //
  // Always 200, never 404 on a missing transcript. A capture recorded before
  // transcripts existed still answers with its prompt, agent and model, and
  // `resumable: false` is what tells the caller which of the two it got — the
  // app opens a loaded composer instead of a restored chat. A 404 here would
  // make "this clip is older" indistinguishable from "this clip is gone", and
  // the link on the card would have to guess.
  if (sub === "/chat" && method === "GET") {
    const chat = captureChatSeed(projectCapture(capture), parseChat(capture.chat_json));
    return jsonResponse({ chat });
  }

  // GET …/versions — the thread on its own, newest first.
  if (sub === "/versions" && method === "GET") {
    const versions = await listVersions(db, capture);
    const current = captureVersionNumber(capture.version);
    return jsonResponse({
      capture_id: capture.id,
      tag: captureTag(capture.id),
      version: current,
      versions: versions.map((v) => projectCaptureVersion(v, current)),
    });
  }

  // POST …/versions — A NEW CUT OF THE SAME CAPTURE, which is what answering a
  // ✍️ verdict produces. The number is max+1 over what the thread already has
  // (never a count, never a reuse), the earlier versions are left exactly as
  // they are, and the capture goes back to `new` so it re-enters the queue of
  // twenty. `answered_at` is deliberately NOT cleared: this clip has been
  // answered once, and the top-up needs to know that.
  if (sub === "/versions" && method === "POST") {
    const v = validateCaptureVersion(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const e = v.entry;
    const existing = await listVersions(db, capture);
    // The pre-versions v1 becomes a real row BEFORE the parent columns are
    // overwritten with the new cut's numbers — otherwise the original would
    // survive only as bytes nothing describes.
    await materializeV1(db, capture, existing);
    const highest = existing.reduce((max, r) => Math.max(max, captureVersionNumber(r.version)), 0);
    const version = Math.max(highest, captureVersionNumber(capture.version)) + 1;
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO capture_versions (capture_id, version, created_at, commit_sha, model, video_key,
           poster_key, size_bytes, duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, note, meta_json)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        capture.id, version, now, e.commit_sha, e.model || capture.model, e.size_bytes,
        e.duration_ms, e.source_ms, e.cut_ms, e.speed, e.wait_mode, e.width, e.height,
        e.note, e.meta_json,
      )
      .run();
    // The parent row describes the CURRENT cut, so it takes the new numbers —
    // and drops the media pointers, because this version has no bytes yet. The
    // old bytes are not deleted; they belong to the version row that now names
    // them.
    await db
      .prepare(
        `UPDATE captures SET version = ?, commit_sha = ?, model = ?, duration_ms = ?, source_ms = ?,
           cut_ms = ?, speed = ?, wait_mode = ?, width = ?, height = ?, size_bytes = ?, meta_json = ?,
           chat_json = COALESCE(?, chat_json),
           video_key = NULL, poster_key = NULL, status = 'new', updated_at = ? WHERE id = ?`,
      )
      .bind(
        version, e.commit_sha, e.model || capture.model, e.duration_ms, e.source_ms, e.cut_ms,
        e.speed, e.wait_mode, e.width, e.height, e.size_bytes,
        // The edit report goes with the numbers. Every other describing column
        // was already overwritten here and this one was not, so the parent row
        // carried the NEW cut's duration and the OLD cut's grading — #CAP-22
        // read "all six app-e2e checks pass" from v1 while playing v2, which is
        // the opposite of the visibility a re-shoot exists to provide. A cut
        // published without a report gets NULL rather than inheriting one: "no
        // report for this cut" is honest, the previous cut's report is not.
        e.meta_json ?? null,
        // COALESCE, deliberately the opposite rule from the report above: a
        // re-EDIT of the same footage answers with no transcript and must keep
        // the chat the recording actually produced, while a re-RECORDING sends
        // one and replaces it. A NULL here would leave a re-cut clip linking to
        // nothing for the sake of consistency with a column that means
        // something else.
        e.chat_json ?? null,
        now, capture.id,
      )
      .run();
    log.info("capture.version", { id: capture.id, version, commit: e.commit_sha });
    return jsonResponse(
      {
        capture: await readBack(db, capture.id),
        upload: {
          video: versionVideoUrl(capture.id, version),
          poster: versionPosterUrl(capture.id, version),
        },
      },
      201,
    );
  }

  // POST …/review — THE SWIPE. Right = 👍 like (status `liked`, likes+1),
  // left = ✍️ feedback (status `needs_work`, note required — validated above).
  // Both append a `capture_reviews` row, so re-shooting a clip keeps the
  // history of every verdict it ever drew.
  if (sub === "/review" && method === "POST") {
    const body = await request.json().catch(() => null);
    const v = validateCaptureReview(body);
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const reviewer = cleanStr(body?.reviewer, CAPTURE_CAPS.reviewer);
    const now = Date.now();
    await db
      .prepare(
        "INSERT INTO capture_reviews (capture_id, created_at, verdict, note, reviewer) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(capture.id, now, v.verdict, v.note, reviewer)
      .run();
    await db
      .prepare("UPDATE captures SET status = ?, likes = likes + ?, updated_at = ? WHERE id = ?")
      .bind(VERDICT_STATUS[v.verdict], v.verdict === "like" ? 1 : 0, now, capture.id)
      .run();
    // ANSWERED, once and for all. The `answered_at IS NULL` predicate is the
    // whole rule expressed in SQL: the first verdict stamps it, every later
    // verdict on the same capture — including one on a re-cut that went back to
    // `new` — leaves the original moment alone. Nothing ever clears it.
    await db
      .prepare("UPDATE captures SET answered_at = ? WHERE id = ? AND answered_at IS NULL")
      .bind(now, capture.id)
      .run()
      .catch(() => {});
    // The note is the owner's own words about an unpublished clip — the row
    // holds it; the log line stays metadata.
    log.info("capture.review", { id: capture.id, verdict: v.verdict });
    return jsonResponse({ capture: await readBack(db, capture.id) }, 201);
  }

  // DELETE …/review — THE UNDO. Takes back the last verdict: the review row is
  // deleted, a like is un-counted, and the capture returns to whatever the
  // verdict before it said (or to the queue, if there was none). See
  // `undoReviewState` for why each of those three is what it is.
  //
  // The response is the same `{capture}` the POST answers with, so the card
  // that undid a swipe redraws from the server's truth rather than from a
  // client-side guess about what an undo does.
  if (sub === "/review" && method === "DELETE") {
    const { results } = await db
      .prepare("SELECT * FROM capture_reviews WHERE capture_id = ? ORDER BY id ASC")
      .bind(capture.id)
      .all()
      .catch(() => ({ results: [] }));
    const undo = undoReviewState(/** @type {any[]} */ (results || []), capture);
    if (!undo) return jsonResponse({ error: "Nothing to undo — this capture has no verdict on it." }, 404);
    const now = Date.now();
    await db.prepare("DELETE FROM capture_reviews WHERE id = ?").bind(undo.review_id).run();
    await db
      .prepare("UPDATE captures SET status = ?, likes = ?, updated_at = ? WHERE id = ?")
      .bind(undo.status, undo.likes, now, capture.id)
      .run();
    if (undo.clear_answered) {
      await db
        .prepare("UPDATE captures SET answered_at = NULL WHERE id = ?")
        .bind(capture.id)
        .run()
        .catch(() => {});
    }
    log.info("capture.undo", { id: capture.id, verdict: undo.verdict, status: undo.status });
    return jsonResponse({ capture: await readBack(db, capture.id), undone: { verdict: undo.verdict } });
  }

  return jsonResponse({ error: "Not found." }, 404);
}

// Re-read one capture after a write and project it the way the single-capture
// GET does — reviews and the whole thread attached. Every mutating endpoint
// answers with this, so a client never has to re-fetch to see what it changed.
/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<any>}
 */
async function readBack(db, id) {
  const row = /** @type {CaptureRow} */ (await getCapture(db, id));
  const versions = await listVersions(db, row);
  const [projected] = await attachReviews(db, [projectCapture(row, versions)]);
  return projected;
}

// ---------------------------------------------------------------------------
// The two byte endpoints
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {D1Database} db
 * @param {CaptureRow} capture
 * @param {{ kind: "video" | "poster", key: string, contentType: string, maxBytes: number,
 *   version: number }} spec
 * @returns {Promise<Response>}
 */
async function putMedia(request, env, log, db, capture, spec) {
  const b = bucket(env);
  if (!b) return jsonResponse({ error: NO_STORAGE }, 503);
  // The content-type is REQUIRED, not sniffed: this endpoint stores bytes it
  // will later serve back with a fixed type, and an uploader that did not say
  // what it is sending is usually one that got the file wrong.
  const declaredType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (declaredType !== spec.contentType) {
    return jsonResponse(
      { error: `Expected a ${spec.contentType} body (send content-type: ${spec.contentType}).` },
      415,
    );
  }
  const declaredLength = Number(request.headers.get("content-length")) || 0;
  if (declaredLength > spec.maxBytes) {
    return jsonResponse({ error: `The ${spec.kind} exceeds the ${mb(spec.maxBytes)} limit.` }, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > spec.maxBytes) {
    return jsonResponse({ error: `The ${spec.kind} exceeds the ${mb(spec.maxBytes)} limit.` }, 413);
  }
  if (!bytes.byteLength) return jsonResponse({ error: `The ${spec.kind} body is empty.` }, 400);
  await b.put(spec.key, bytes, { httpMetadata: { contentType: spec.contentType } });
  const now = Date.now();
  // Whole statements rather than one with an interpolated column name:
  // src/sql-injection-guard.test.js allows only hand-audited identifiers into
  // SQL, and "there are exactly four of these" is a better answer than another
  // allowlist entry. The MP4 IS the artefact, so only it writes size_bytes.
  //
  // The version row is always updated (a no-op when the version has no row of
  // its own — a fresh capture's synthetic v1 reads its keys off the parent),
  // and the PARENT row only when the upload belongs to the version currently
  // on the card. That is what stops re-uploading an old cut from silently
  // replacing what the deck plays.
  const isCurrent = spec.version === captureVersionNumber(capture.version);
  if (spec.kind === "video") {
    await db
      .prepare("UPDATE capture_versions SET video_key = ?, size_bytes = ? WHERE capture_id = ? AND version = ?")
      .bind(spec.key, bytes.byteLength, capture.id, spec.version)
      .run()
      .catch(() => {});
    if (isCurrent) {
      await db
        .prepare("UPDATE captures SET video_key = ?, size_bytes = ?, updated_at = ? WHERE id = ?")
        .bind(spec.key, bytes.byteLength, now, capture.id)
        .run();
    }
  } else {
    await db
      .prepare("UPDATE capture_versions SET poster_key = ? WHERE capture_id = ? AND version = ?")
      .bind(spec.key, capture.id, spec.version)
      .run()
      .catch(() => {});
    if (isCurrent) {
      await db
        .prepare("UPDATE captures SET poster_key = ?, updated_at = ? WHERE id = ?")
        .bind(spec.key, now, capture.id)
        .run();
    }
  }
  log.info("capture.media_put", {
    id: capture.id,
    kind: spec.kind,
    version: spec.version,
    size: bytes.byteLength,
  });
  return jsonResponse({ capture: await readBack(db, capture.id) });
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {number} id
 * @param {string} key
 * @param {string} contentType
 * @param {boolean} ranged
 * @returns {Promise<Response>}
 */
async function getMedia(request, env, id, key, contentType, ranged) {
  const b = bucket(env);
  if (!b) return jsonResponse({ error: NO_STORAGE }, 503);
  // HEAD first so the total size is known before the range is resolved — R2
  // needs {offset, length}, and `content-range` needs the total either way.
  const head = await b.head(key).catch(() => null);
  if (!head) return jsonResponse({ error: "No bytes stored for this capture yet." }, 404);
  const range = ranged ? parseRange(request.headers.get("range"), head.size) : null;
  const obj = await b
    .get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined)
    .catch(() => null);
  if (!obj) return jsonResponse({ error: "No bytes stored for this capture yet." }, 404);
  /** @type {Record<string, string>} */
  const headers = {
    "content-type": contentType,
    "content-length": String(range ? range.length : head.size),
    // Unpublished material behind the admin gate — no shared cache may hold a
    // copy. Seeking still works: it rides on Range, not on the cache.
    "cache-control": "private, no-store",
    "x-capture-id": String(id),
  };
  if (ranged) headers["accept-ranges"] = "bytes";
  if (range) {
    headers["content-range"] = `bytes ${range.offset}-${range.end}/${head.size}`;
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
