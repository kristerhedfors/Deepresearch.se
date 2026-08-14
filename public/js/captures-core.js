// @ts-check
// Capture review deck — the client PURE core (Node-tested in
// public/js/captures-core.test.js). The DOM/fetch half is public/js/captures.js;
// everything import-safe outside a browser lives here.
//
// A "capture" is a recorded run of the research pipeline (one agent × one
// model × one query) edited into a short clip for sharing. The admin reviews
// them as a vertical FEED: every capture in the open list is on the page, in
// order, scrolled north to south, and any one of them can be reviewed —
// swipe RIGHT to keep a clip, LEFT to say what is wrong with it. The gesture
// MATH is the fiddly, regression-prone part — a threshold that is wrong by
// 20px makes the feed feel either twitchy or dead — so it lives here as pure
// functions with unit tests rather than tangled into pointer handlers where
// the only way to check it is a thumb on a phone.
//
// It was a one-card-at-a-time DECK until 2026-08-13 (owner directive: "I can
// see only the next in queue — I want to scroll through all of them north to
// south and review any one of my choice"). The gesture math did not change;
// what changed is that a card is no longer consumed by being filed. It stays
// where it is, wearing its verdict, with an UNDO beside it — which is the
// other half of the same directive ("revert the one I just swiped right").
//
// Nothing here may touch `document`, `window`, `fetch` or the clock: the test
// runner imports this file in bare Node. It imports NOTHING, either — the
// admin-only /captures/ page reaches this module, and src/captures-page.test.js
// walks that whole graph asserting every file in it is off the public asset
// allowlist. An import of a deliberately-public module (starters-core.js, say)
// fails that guard by construction, which is why the agent→mode fallback this
// file used to want lives in src/captures.js's projectCapture instead.

/** @typedef {"like"|"feedback"} Verdict */
/** @typedef {{ id:number|string, verdict?:string, note?:string|null, created_at?:number }} Review */

// ---- small numeric guards --------------------------------------------------
// Pointer coordinates arrive from event handlers and card widths from
// getBoundingClientRect(); a detached/hidden card measures 0 and a card
// measured mid-teardown can measure NaN. Every one of those must degrade to
// "no verdict" rather than throwing inside a pointermove handler — an
// exception there kills the drag AND leaves the pointer captured, which locks
// the whole panel until reload.

/**
 * @param {unknown} v
 * @returns {number} a finite number; NaN/Infinity/null/undefined → 0
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Two decimals — keeps generated transform strings stable and comparable.
 * @param {number} v
 */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * A capture FIELD as a finite number, or null when the field is absent.
 *
 * `Number()` alone cannot be used here: `Number(null)`, `Number("")`,
 * `Number([])` and `Number(false)` are all 0, so a capture row that never got
 * a `size_bytes` would render "0 B" — a confident fact about a value nobody
 * measured. The facts row must OMIT what is missing, which means "missing"
 * has to be distinguishable from zero.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function field(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A stored chat-mode id, trimmed — "" for anything that is not a non-empty
 * string, so a row with `mode: null`, `""` or `"   "` falls through to the
 * agent-derived one instead of pinning the app to nothing.
 * @param {unknown} v
 * @returns {string}
 */
function cleanMode(v) {
  return typeof v === "string" ? v.trim() : "";
}

// ---- the gesture constants -------------------------------------------------

export const SWIPE = {
  // Fraction of the CARD's width a drag must cover to commit. 0.28 is a bit
  // over a quarter of the card: far enough that a thumb resting on a scrolling
  // page cannot reach it accidentally, near enough that one comfortable thumb
  // arc clears it on a phone-width card without repositioning the hand.
  threshold: 0.28,
  // Absolute floor in px. On a narrow card (a portrait clip in a collapsed
  // panel can render ~200px wide) 28% is ~56px, which is inside the slop of a
  // sloppy tap — every mis-tap would file a clip. 72px is comfortably past
  // that and still under one thumb arc.
  minPx: 72,
  // A gesture counts as horizontal only while |dy| <= |dx| * maxAngle, i.e.
  // within ~31° of the horizontal. The feed is a long north–south scroll, so a
  // mostly-vertical drag is the owner SCROLLING PAST a clip, not judging it;
  // filing a capture on a scroll would be both wrong and — before the feed
  // kept filed cards in place — unnoticeable until much later. This rule
  // carries more weight now than it did in the deck, not less: there are
  // twenty cards under the thumb on the way down instead of one.
  maxAngle: 0.6,
  // px/ms. A flick is how a deck is actually used on a phone: the thumb leaves
  // the glass long before the card has travelled 28% of its width. 0.5 px/ms
  // (~500px/s) is a deliberate flick — a slow considered drag never reaches it,
  // so the distance rule still governs the careful case.
  flingVelocity: 0.5,
  // …but a flick still has to GO somewhere. Without a floor, a 3px twitch over
  // 4ms is 0.75px/ms and would file a clip on what the owner meant as a tap on
  // the video's play button.
  flingMinPx: 24,
};

// Degrees of lean per unit of (dx / cardWidth). Tuned so the card reaches the
// ±12° cap at just about the commit threshold (0.28 × 45 ≈ 12.6): the tilt
// maxing out IS the "let go now and it files" signal, without a second cue.
const TILT_PER_WIDTH = 45;
export const MAX_TILT_DEG = 12;

// Fallback card width when the real one can't be measured (0/NaN). A typical
// admin card; only used so the tilt/hint still respond instead of freezing.
const FALLBACK_WIDTH = 320;

// Keyboard equivalents. A swipe-only surface is unusable with a mouse and
// inaccessible with a keyboard, so the arrow keys map to exactly the same two
// verdicts — this table is the single definition both halves read.
/** @type {Record<string, Verdict>} */
export const KEY_VERDICTS = { ArrowRight: "like", ArrowLeft: "feedback" };

// The deck filters offered above the stack — the owner's four lists, in the
// owner's words (2026-08-11). "new" is the review queue; the rest exist so a
// clip that was already filed can be found again. "Appreciated" rather than
// "Liked": it is what the owner calls a clip that was kept and filed, and the
// list is read far more often than the button that fills it.
export const DECK_FILTERS = [
  { id: "new", label: "To review" },
  { id: "liked", label: "Appreciated" },
  { id: "needs_work", label: "Needs work" },
  { id: "", label: "All" },
];

/**
 * A row's status in the SAME words as the list it belongs to. A badge reading
 * "liked" next to a filter reading "Appreciated" makes the reader stop and
 * work out whether they are the same thing; they are, so they are said the
 * same way. An unknown status (a future one) is passed through rather than
 * hidden — the deck must not silently mislabel a state it does not know.
 *
 * @param {unknown} status
 * @returns {string}
 */
export function statusLabel(status) {
  const s = typeof status === "string" ? status.trim() : "";
  if (!s) return "";
  const f = DECK_FILTERS.find((x) => x.id && x.id === s);
  return f ? f.label.toLowerCase() : s.replace(/_/g, " ");
}

// How many unanswered captures the queue is meant to hold. The recorder tops
// the queue back up to this number as verdicts land, so the health line reads
// "N of 20 unanswered" — a denominator, not a cap on the table.
export const QUEUE_TARGET = 20;

// Server-side cap on a feedback note. Mirrored here so the UI refuses a
// doomed request instead of posting it and rendering the 400 as a mystery.
export const NOTE_MAX = 4000;

// ---- the verdict functions -------------------------------------------------

/**
 * The px a drag must cover on a card of this width to commit.
 *
 * ROUNDED to whole pixels on purpose. Sub-pixel precision is meaningless for a
 * thumb, and the float product bites at the boundary: 600 × 0.28 is
 * 168.00000000000003, so a drag of exactly 28% of the card would NOT commit
 * and the documented threshold would be a lie by one ulp.
 *
 * @param {unknown} width card width in px (0/NaN → the minimum applies)
 * @param {Partial<typeof SWIPE>} [opts]
 * @returns {number}
 */
export function swipeThreshold(width, opts) {
  const cfg = config(opts);
  return Math.round(Math.max(num(cfg.minPx), num(width) * num(cfg.threshold)));
}

/**
 * @param {Partial<typeof SWIPE>|undefined} opts
 * @returns {typeof SWIPE}
 */
function config(opts) {
  return opts && typeof opts === "object" ? { ...SWIPE, ...opts } : SWIPE;
}

/**
 * True when the gesture leans more vertical than `maxAngle` allows — the user
 * is scrolling the admin page past the deck, not filing a clip.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} maxAngle
 */
function mostlyVertical(x, y, maxAngle) {
  return Math.abs(y) > Math.abs(x) * maxAngle;
}

/**
 * The verdict for a settled (released) drag: right past the threshold is a
 * like, left is feedback, anything shorter or too vertical is no verdict (the
 * card springs back).
 *
 * @param {unknown} dx horizontal travel, px (positive = right)
 * @param {unknown} dy vertical travel, px
 * @param {unknown} width the card's width, px
 * @param {Partial<typeof SWIPE>} [opts]
 * @returns {Verdict|null}
 */
export function swipeVerdict(dx, dy, width, opts) {
  const cfg = config(opts);
  const x = num(dx);
  const y = num(dy);
  if (mostlyVertical(x, y, num(cfg.maxAngle))) return null;
  const t = swipeThreshold(width, cfg);
  if (x >= t) return "like";
  if (x <= -t) return "feedback";
  return null;
}

/**
 * The verdict INCLUDING the flick case: a short, fast horizontal flick files
 * the card even though it never travelled the full threshold. A deck that only
 * answers to long deliberate drags reads as broken on a phone, because a phone
 * user flicks. Falls back to swipeVerdict for everything slower.
 *
 * @param {unknown} dx
 * @param {unknown} dy
 * @param {unknown} width
 * @param {unknown} dt gesture duration, ms
 * @param {Partial<typeof SWIPE>} [opts]
 * @returns {Verdict|null}
 */
export function flingVerdict(dx, dy, width, dt, opts) {
  const settled = swipeVerdict(dx, dy, width, opts);
  if (settled) return settled;
  const cfg = config(opts);
  const x = num(dx);
  const y = num(dy);
  const ms = num(dt);
  // dt <= 0 means the caller has no timing (or a clock that went backwards);
  // without a duration there is no velocity, so only the distance rule applies.
  if (ms <= 0) return null;
  if (mostlyVertical(x, y, num(cfg.maxAngle))) return null;
  if (Math.abs(x) < num(cfg.flingMinPx)) return null;
  if (Math.abs(x) / ms < num(cfg.flingVelocity)) return null;
  return x > 0 ? "like" : "feedback";
}

/**
 * The live transform for a card being dragged. The rotation is what makes the
 * gesture legible: the card physically leans the way it will be filed, so the
 * owner can see the verdict before committing to it.
 *
 * @param {unknown} dx
 * @param {unknown} dy
 * @param {unknown} width
 * @returns {{ transform: string, opacity: number, tilt: number }}
 */
export function cardStyle(dx, dy, width) {
  const x = num(dx);
  const y = num(dy);
  const w = num(width) > 0 ? num(width) : FALLBACK_WIDTH;
  const tilt = round2(clamp((x / w) * TILT_PER_WIDTH, -MAX_TILT_DEG, MAX_TILT_DEG));
  // Fade only part of the way: a card that goes fully transparent before it
  // leaves the stack looks like a bug, and the owner loses track of what is
  // being filed mid-gesture.
  const t = swipeThreshold(w);
  const opacity = round2(1 - 0.35 * clamp(Math.abs(x) / (t * 2), 0, 1));
  return {
    transform: `translate(${round2(x)}px, ${round2(y)}px) rotate(${tilt}deg)`,
    opacity,
    tilt,
  };
}

/**
 * The 👍 / ✍️ overlay state for a drag in progress. This is what makes the
 * gesture DISCOVERABLE — without it a first-time reviewer has to guess which
 * direction means what, and guessing wrong files a clip they wanted to keep.
 * A mostly-vertical drag shows nothing (they are scrolling).
 *
 * @param {unknown} dx
 * @param {unknown} dy
 * @param {unknown} width
 * @returns {{ side: Verdict|null, progress: number }}
 */
export function swipeHint(dx, dy, width) {
  const x = num(dx);
  const y = num(dy);
  if (x === 0 || mostlyVertical(x, y, SWIPE.maxAngle)) return { side: null, progress: 0 };
  const t = swipeThreshold(width);
  return {
    side: x > 0 ? "like" : "feedback",
    progress: round2(clamp(Math.abs(x) / t, 0, 1)),
  };
}

// ---- feed bookkeeping ------------------------------------------------------

/**
 * The rows the feed can actually render, in the server's display order. A row
 * with no id is dropped: every action the card offers posts to `/:id/review`,
 * so an id-less row would be a card whose buttons cannot work (UX-18).
 *
 * @param {any[]} captures
 * @returns {any[]}
 */
export function feedRows(captures) {
  return (Array.isArray(captures) ? captures : []).filter((c) => c && c.id != null);
}

/**
 * How many of these captures still want a verdict. This is the number in the
 * heading, and it is computed from the rows' STATUS rather than from a count
 * of what was swiped this session: filing a card no longer removes it, so the
 * server's answer (merged back into the row after each verdict) is the only
 * thing that can be right after an undo.
 *
 * @param {any[]} captures
 * @returns {number}
 */
export function pendingCount(captures) {
  return feedRows(captures).filter((c) => cardStatus(c) === "new").length;
}

/**
 * A capture's status, normalised. Anything unrecognised — including a row from
 * a newer server — reads as `new`, because the failure that matters is a card
 * that cannot be acted on; a card offered twice costs one extra swipe.
 *
 * @param {any} c
 * @returns {string}
 */
function cardStatus(c) {
  const s = c && typeof c === "object" && typeof c.status === "string" ? c.status.trim() : "";
  return s === "liked" || s === "needs_work" || s === "archived" ? s : "new";
}

/** How a filed card announces what was done to it. */
export const FILED_LABELS = { liked: "👍 Liked", needs_work: "✍️ Sent back", archived: "Archived" };

/**
 * Everything the feed needs to know about ONE card's state, derived from the
 * row the server sent.
 *
 * Driven by `status`, deliberately NOT by the last review. A capture that was
 * sent back and then RE-CUT returns to `new` while keeping every earlier
 * verdict in its thread — reading the last review would render that card as
 * already filed and there would be no way to review the new cut at all.
 *
 * `can_undo` is the mirror: it asks whether there is a verdict to take back,
 * which is a question about the THREAD, not about the status. That is what
 * makes "revert the one I just swiped right" work on a capture whose status
 * someone has since moved by hand.
 *
 * @param {any} c
 * @returns {{ status: string, filed: boolean, verdict: Verdict|null, label: string,
 *   can_undo: boolean, reviews: number }}
 */
export function cardState(c) {
  const status = cardStatus(c);
  const reviews = c && typeof c === "object" && Array.isArray(c.reviews) ? c.reviews.length : 0;
  return {
    status,
    filed: status !== "new",
    verdict: status === "liked" ? "like" : status === "needs_work" ? "feedback" : null,
    label: FILED_LABELS[/** @type {keyof typeof FILED_LABELS} */ (status)] || "",
    can_undo: reviews > 0,
    reviews,
  };
}

/**
 * The one-line label on the undo control — "Undo the 👍", "Undo the ✍️".
 * Names the verdict being taken back rather than saying "undo", because on a
 * page where every card has one, "Undo" alone does not say what is about to
 * happen to THIS card.
 *
 * @param {any} c
 * @returns {string} "" when there is nothing to undo
 */
export function undoLabel(c) {
  const st = cardState(c);
  if (!st.can_undo) return "";
  const last = /** @type {any[]} */ (c.reviews)[c.reviews.length - 1];
  const verdict = last && last.verdict === "like" ? "like" : last && last.verdict === "feedback" ? "feedback" : null;
  const mark = verdict ? VERDICT_MARKS[verdict] : st.verdict ? VERDICT_MARKS[st.verdict] : "";
  return mark ? `↩︎ Undo the ${mark}` : "↩︎ Undo the last verdict";
}

/** @type {Record<string, string>} */
const VERDICT_MARKS = { like: "👍", feedback: "✍️" };

// ---- display helpers -------------------------------------------------------

/**
 * @param {unknown} s
 * @param {number} max
 * @returns {string} trimmed, with an ellipsis when it had to be cut
 */
function truncate(s, max) {
  const str = typeof s === "string" ? s.trim() : "";
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/**
 * A one-line human title for a capture. Prefers the author's own label; falls
 * back to "agent · model" plus the truncated prompt, because a deck of clips
 * all titled with the same model is unreviewable.
 *
 * @param {any} c
 * @returns {string}
 */
export function captureTitle(c) {
  if (!c || typeof c !== "object") return "Untitled capture";
  const label = typeof c.label === "string" ? c.label.trim() : "";
  if (label) return label;
  const head = [c.agent, c.model]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => String(v).trim())
    .join(" · ");
  const prompt = truncate(c.prompt, 70);
  if (head && prompt) return `${head} — ${prompt}`;
  return head || prompt || "Untitled capture";
}

/**
 * The small facts row under a card. A missing field is OMITTED rather than
 * rendered as "undefined" — captures come from a harness that is itself under
 * development, so half-filled rows are normal and must still read cleanly.
 *
 * @param {any} c
 * @returns {string[]}
 */
export function captureFacts(c) {
  if (!c || typeof c !== "object") return [];
  const out = [];
  const size = formatBytes(c.size_bytes);
  if (size) out.push(size);
  const dur = formatClock(c.duration_ms);
  if (dur) out.push(dur);
  // 1× is the default and says nothing — it is noise in a five-item row.
  const speed = field(c.speed);
  if (speed !== null && speed > 0 && speed !== 1) out.push(`${round2(speed)}x`);
  const cut = formatDuration(c.cut_ms);
  if (cut) out.push(`cut ${cut}`);
  if (typeof c.shape === "string" && c.shape.trim()) out.push(c.shape.trim());
  return out;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * @param {unknown} n bytes
 * @returns {string} "" when absent/invalid (so captureFacts can drop it)
 */
export function formatBytes(n) {
  const v = field(n);
  if (v === null || v < 0) return "";
  if (v < 1024) return `${Math.round(v)} B`;
  let x = v;
  let i = 0;
  while (x >= 1024 && i < BYTE_UNITS.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${BYTE_UNITS[i]}`;
}

/**
 * Clip length as a player reads it — "0:24", "2:41". Minutes are NOT rolled
 * into hours: a capture is a short clip, and "1:02:03" in a facts row would
 * read as a bug.
 *
 * @param {unknown} ms
 * @returns {string} "" when absent/invalid
 */
export function formatClock(ms) {
  const v = field(ms);
  if (v === null || v < 0) return "";
  const total = Math.round(v / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A spoken duration — "41s", "2m 41s", "1h 2m". Used for the amount of source
 * footage the edit CUT, where "2m 41s" says what "2:41" would leave ambiguous.
 *
 * @param {unknown} ms
 * @returns {string} "" when absent/invalid
 */
export function formatDuration(ms) {
  const v = field(ms);
  if (v === null || v < 0) return "";
  const total = Math.round(v / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Validate a feedback note before posting it. The server 400s on an empty
 * note (a left swipe with nothing to say is not feedback), so the UI checks
 * first — otherwise the reviewer's gesture disappears into an HTTP error they
 * cannot act on.
 *
 * @param {unknown} text
 * @returns {{ ok: boolean, note?: string, error?: string }}
 */
export function validateNote(text) {
  const raw = typeof text === "string" ? text : "";
  const note = raw.trim();
  if (!note) return { ok: false, error: "Say what is wrong with the clip — a feedback swipe needs a note." };
  if (note.length > NOTE_MAX) {
    return { ok: false, error: `Too long — ${note.length} characters, the limit is ${NOTE_MAX}.` };
  }
  return { ok: true, note };
}

/**
 * The one-line record shown on an ALREADY-reviewed capture (the liked /
 * needs-work filters render read-only). Prefers the latest review; falls back
 * to the row's status when the server sent no review list.
 *
 * @param {any} capture
 * @returns {string} "" when the capture has never been reviewed
 */
export function reviewSummary(capture) {
  if (!capture || typeof capture !== "object") return "";
  const reviews = Array.isArray(capture.reviews) ? capture.reviews : [];
  const last = reviews.length ? reviews[reviews.length - 1] : null;
  if (last && last.verdict === "like") return "👍 liked";
  if (last && last.verdict === "feedback") {
    const note = truncate(last.note, 160);
    return note ? `✍️ ${note}` : "✍️ feedback (no note)";
  }
  if (capture.status === "liked") return "👍 liked";
  if (capture.status === "needs_work") return "✍️ feedback (no note)";
  return "";
}

// ---- identity: the number and the short name -------------------------------
// A capture is REFERRED TO by its number — "produce a review of #12" — so the
// number is the card's first fact, not a subtitle. `captures.id` is the
// increasing series; `#CAP-<id>` is its written form, matching the repo's
// existing `#UC-<id>` convention.

/**
 * The public reference tag for a capture id. Empty string for a row with no
 * usable id (a half-written fixture), because "#CAP-undefined" as a heading is
 * worse than no heading at all.
 *
 * @param {unknown} id
 * @returns {string} e.g. "#CAP-12", or ""
 */
export function captureTag(id) {
  if (typeof id === "number") return Number.isFinite(id) ? `#CAP-${Math.trunc(id)}` : "";
  const s = typeof id === "string" ? id.trim() : "";
  if (!s) return "";
  // A string id is used verbatim rather than parsed: the series is the D1
  // rowid today, and coercing an unexpected id shape to a number would print a
  // confident wrong number.
  return `#CAP-${s}`;
}

/**
 * The tag the SERVER sent (contract §5 `tag`), falling back to one derived
 * from the id. The server value wins so a future renumbering does not need a
 * client release.
 *
 * @param {any} c
 * @returns {string}
 */
export function captureRef(c) {
  if (!c || typeof c !== "object") return "";
  const tag = typeof c.tag === "string" ? c.tag.trim() : "";
  return tag || captureTag(c.id);
}

// Words that carry no meaning in a starter id: the agent prefix and the
// language marker. Stripping them is what turns "res-sv-elpris" into
// "Elpris" rather than "Res Sv Elpris".
// Every prefix the shipped registry actually uses (checked against
// starters-data.js rather than guessed: "mdl" and "agb" were missing and
// produced "Mdl Cheapest Vision" / "Agb Minimal"), plus the two language
// markers. "sdk"/"mod"/"sci" are kept as historical spellings — a retired
// prefix in an old capture should still resolve to a clean name.
const STARTER_NOISE = new Set([
  "res", "sch", "int", "orc", "out", "mdl", "agb", "pal", "sec", "unc", "cyb",
  "sdk", "mod", "sci",
  "en", "sv",
]);

/**
 * A short name derived from a starter id, per the shared contract §6: dashes
 * to spaces, title case, at most four words. Deterministic and offline — a
 * recording must never wait on a model to be named.
 *
 * @param {unknown} starter
 * @returns {string} "" when there is nothing to derive from
 */
export function starterName(starter) {
  const raw = typeof starter === "string" ? starter.trim() : "";
  if (!raw) return "";
  const words = raw
    .split(/[-_\s]+/)
    .filter((w) => w && !STARTER_NOISE.has(w.toLowerCase()))
    .slice(0, 4)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ");
}

/**
 * The capture's SHORT name — a few words a human can say out loud. The
 * server's `name` wins; then the author's `label`; then a name derived from
 * the starter id; and only then a truncated prompt, which is a last resort
 * because a sentence is not a name.
 *
 * @param {any} c
 * @returns {string}
 */
export function captureName(c) {
  if (!c || typeof c !== "object") return "Untitled capture";
  const name = typeof c.name === "string" ? c.name.trim() : "";
  if (name) return name;
  const label = typeof c.label === "string" ? c.label.trim() : "";
  if (label) return label;
  const derived = starterName(c.starter);
  if (derived) return derived;
  const prompt = truncate(c.prompt, 48);
  return prompt || "Untitled capture";
}

/**
 * The card's headline, split so the two halves can be rendered as separate
 * nodes (the number wants its own emphasis) and joined for a copyable title.
 *
 * @param {any} c
 * @returns {{ tag: string, name: string, text: string }}
 */
export function captureHeadline(c) {
  const tag = captureRef(c);
  const name = captureName(c);
  return { tag, name, text: tag ? `${tag} · ${name}` : name };
}

/**
 * The commit a recording was made at, shortened for a chip. Provenance, not
 * decoration: it is what makes a run reproducible.
 *
 * Only hex is accepted. A `commit_sha` that is not a sha (a branch name, a
 * "dirty" marker a harness once wrote there) is dropped rather than rendered,
 * because a chip in that slot claims "check this out and you get this clip".
 *
 * @param {unknown} sha
 * @param {number} [len]
 * @returns {string} "" when absent or not a sha
 */
export function shortSha(sha, len = 7) {
  const s = typeof sha === "string" ? sha.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{7,64}$/.test(s)) return "";
  return s.slice(0, Math.max(4, Math.min(len, s.length)));
}

// ---- versions --------------------------------------------------------------
// Feedback on a clip is answered by RE-RECORDING it, and the older cut is kept
// on purpose. So a capture with more than one version has a history, and the
// history is shown rather than hidden: the newest plays, any older one is one
// tap away. A server that has not grown the `versions` array yet simply has no
// history — everything below returns empty and the card renders as before.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A calendar day in UTC — "11 Aug 2026". UTC rather than local time on
 * purpose: this core is clock-free and Node-tested, and a local-time format
 * would make the tests pass or fail by the runner's timezone.
 *
 * @param {unknown} when epoch ms, or an ISO string (`time`)
 * @returns {string} "" when absent/unparseable
 */
export function formatDay(when) {
  let ms = field(when);
  if (ms === null && typeof when === "string" && when.trim()) {
    const parsed = Date.parse(when);
    ms = Number.isFinite(parsed) ? parsed : null;
  }
  if (ms === null) return "";
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (!Number.isFinite(y)) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${y}`;
}

/**
 * Where a specific version's bytes live. Derived rather than required, so a
 * server that sends versions without URLs still plays them.
 *
 * @param {unknown} captureId
 * @param {unknown} version
 * @returns {{ video: string, poster: string }} empty strings when either id is unusable
 */
export function versionMedia(captureId, version) {
  const id = captureId == null ? "" : String(captureId).trim();
  const v = field(version);
  if (!id || v === null || v < 1) return { video: "", poster: "" };
  const base = `/api/admin/captures/${encodeURIComponent(id)}/versions/${Math.trunc(v)}`;
  return { video: `${base}/video`, poster: `${base}/poster` };
}

/**
 * The capture's versions, NEWEST FIRST, normalised: a whole number, media
 * URLs, and exactly one `is_current`. Rows without a usable version number are
 * dropped — an unnumbered version cannot be named in the UI or fetched from
 * the API, so showing it would offer a button that cannot work (UX-18).
 *
 * @param {any} c
 * @returns {any[]} [] when the capture has no version list at all
 */
export function captureVersions(c) {
  if (!c || typeof c !== "object" || !Array.isArray(c.versions)) return [];
  /** @type {Set<number>} */
  const seen = new Set();
  /** @type {any[]} */
  const out = [];
  for (const v of c.versions) {
    if (!v || typeof v !== "object") continue;
    const n = field(v.version);
    if (n === null || n < 1) continue;
    const num = Math.trunc(n);
    if (seen.has(num)) continue; // a duplicate from the server: first wins
    seen.add(num);
    const media = versionMedia(c.id, num);
    const url = (/** @type {unknown} */ x, /** @type {string} */ fallback) =>
      typeof x === "string" && x.trim() ? x.trim() : fallback;
    out.push({
      ...v,
      version: num,
      commit_sha: typeof v.commit_sha === "string" ? v.commit_sha : null,
      video_url: url(v.video_url, media.video),
      poster_url: url(v.poster_url, media.poster),
      has_video: v.has_video !== false,
      is_current: v.is_current === true,
    });
  }
  out.sort((a, b) => b.version - a.version);
  // A list where nothing claims to be current still has to play something, and
  // "newest" is the only defensible choice — that is the cut the feedback loop
  // produced last.
  if (out.length && !out.some((v) => v.is_current)) out[0].is_current = true;
  return out;
}

/**
 * True when there is a history worth rendering. One version is just "the
 * video"; the control only earns its space at two.
 *
 * @param {any} c
 */
export function hasVersionHistory(c) {
  return captureVersions(c).length > 1;
}

/**
 * The version that plays by default: the current one, else the newest.
 *
 * @param {any} c
 * @returns {any|null} null when the capture has no version list
 */
export function activeVersion(c) {
  const list = captureVersions(c);
  return list.find((v) => v.is_current) || list[0] || null;
}

/**
 * What the player should load for a capture: a specific version when one is
 * being played, otherwise the capture's own current-version URLs.
 *
 * Split out of the DOM half because the fallback is the part that matters and
 * the part that is easy to get wrong: FOUR captures were recorded before
 * versions existed and their bytes sit at the unversioned key. A server that
 * has not grown a `versions` array yet must keep playing them, so "no version"
 * is a supported input here, not a bug to guard against.
 *
 * @param {any} c
 * @param {any} [version] one entry from captureVersions
 * @returns {{ video_url: string, poster_url: string, has_video: boolean }}
 */
export function playbackSource(c, version) {
  const str = (/** @type {unknown} */ v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  if (version && typeof version === "object") {
    const video = str(version.video_url);
    return {
      video_url: video,
      poster_url: str(version.poster_url),
      has_video: version.has_video !== false && !!video,
    };
  }
  if (!c || typeof c !== "object") return { video_url: "", poster_url: "", has_video: false };
  const video = str(c.video_url);
  return {
    video_url: video,
    // `has_poster` gates the poster, not the URL's presence: the capture-level
    // poster_url is DERIVED from the id and so is always a string, even when no
    // poster was ever uploaded. Trusting it would point every posterless card
    // at a 404.
    poster_url: c.has_poster ? str(c.poster_url) : "",
    has_video: c.has_video !== false && !!video,
  };
}

/**
 * The label on a version button — "v3 · current", "v1 · 11 Aug 2026".
 *
 * @param {any} v a normalised version (from captureVersions)
 * @returns {string}
 */
export function versionLabel(v) {
  if (!v || typeof v !== "object") return "";
  const parts = [`v${field(v.version) ?? "?"}`];
  if (v.is_current) parts.push("current");
  else {
    const day = formatDay(v.created_at ?? v.time);
    if (day) parts.push(day);
  }
  return parts.join(" · ");
}

// ---- the feedback thread ---------------------------------------------------

/**
 * A capture's reviews as a THREAD — oldest first, each entry ready to render.
 * This is what "thread" means here: the notes that asked for a re-cut, in the
 * order they were written, so the next version can be judged against them.
 *
 * @param {any} c
 * @returns {{ verdict: string, note: string, day: string, mark: string }[]}
 */
export function captureThread(c) {
  if (!c || typeof c !== "object" || !Array.isArray(c.reviews)) return [];
  return (/** @type {any[]} */ (c.reviews))
    .filter((/** @type {any} */ r) => r && typeof r === "object")
    .map((/** @type {any} */ r) => {
      const verdict = r.verdict === "like" ? "like" : "feedback";
      return {
        verdict,
        note: typeof r.note === "string" ? r.note.trim() : "",
        day: formatDay(r.created_at ?? r.time),
        mark: verdict === "like" ? "👍" : "✍️",
      };
    });
}

// ---- queue health ----------------------------------------------------------

/**
 * How many captures are waiting for a verdict, from whichever endpoint
 * answered: the counts probe (`unanswered`), or the list itself.
 *
 * Returns null — NOT 0 — when the answer cannot be read (a non-admin's 403, a
 * Worker too old to have the probe, a malformed body). The two are different
 * facts: 0 means "the queue is empty", null means "we do not know", and only
 * the first is worth telling the owner.
 *
 * @param {any} data a parsed JSON body, or null
 * @returns {number|null}
 */
export function queueUnanswered(data) {
  if (!data || typeof data !== "object" || data.__error) return null;
  const direct = field(data.unanswered);
  if (direct !== null && direct >= 0) return Math.trunc(direct);
  if (Array.isArray(data.captures)) return data.captures.length;
  const count = field(data.count);
  if (count !== null && count >= 0) return Math.trunc(count);
  return null;
}

/**
 * The queue's target size, as the server reports it (so the number can move
 * without a client release), falling back to the shared constant.
 *
 * @param {any} data
 * @returns {number}
 */
export function queueTarget(data) {
  const t = data && typeof data === "object" ? field(data.target) : null;
  return t !== null && t > 0 ? Math.trunc(t) : QUEUE_TARGET;
}

/**
 * The calm one-liner about the queue's health — "14 of 20 unanswered".
 * Empty when the count is unknown: a health line that guesses is worse than no
 * health line.
 *
 * @param {number|null} unanswered
 * @param {number} [target]
 * @returns {string}
 */
export function queueHealthLine(unanswered, target = QUEUE_TARGET) {
  if (unanswered === null || unanswered === undefined) return "";
  const n = field(unanswered);
  if (n === null || n < 0) return "";
  const t = field(target);
  return `${Math.trunc(n)} of ${t !== null && t > 0 ? Math.trunc(t) : QUEUE_TARGET} unanswered`;
}

/**
 * The text on the header launcher's badge. Zero renders as "" so the caller
 * can hide the pill entirely — a badge reading "0" claims attention for
 * nothing. Capped at "99+" because the badge is ~18px wide.
 *
 * @param {unknown} n
 * @returns {string}
 */
export function badgeText(n) {
  const v = field(n);
  if (v === null || v <= 0) return "";
  return v > 99 ? "99+" : String(Math.trunc(v));
}

// ---- the chat behind the clip ----------------------------------------------
// A capture is a recording of a REAL research run, and until 2026-08-14 the
// run died with the browser that made it: the clip showed an answer nobody
// could open, follow up on, or check a citation in. The owner's ask was the
// obvious missing half — "link from captured agent videos to the actual chat
// so one can continue and explore from there".
//
// So the harness now reads the finished conversation off the page and files it
// with the row (`chat_json`), and every surface that names a capture can hand
// the reader a chat to CONTINUE: the review feed's card, and the history
// drawer's own "Recorded runs" group.
//
// Two properties this core exists to keep:
//
//  * **A capture without a transcript still links.** Every clip recorded
//    before this existed has its prompt, its agent and its model, which is
//    enough to open the composer loaded and ready to ask the same question
//    again. `resumable` is what says which of the two the reader is getting,
//    so the link can promise the right thing instead of the better thing.
//  * **The transcript is the site's own output, not a user's chat.** Capture
//    prompts are the shipped starters (synthetic by construction — see the
//    video-capture skill) and the answers are this pipeline's, recorded by the
//    operator. Nothing here reads `chat_logs`, and nothing here may start
//    doing so: a full-visibility log is not consent to replay somebody's
//    conversation into a video or a drawer (privacy invariant 4).

/** Bounds on a stored transcript. A capture is one or two turns; these are
 * guards against a malformed harness run, not a product shape. */
export const CHAT_CAPS = {
  messages: 40,
  /** per message, characters */
  content: 24_000,
  /** the whole transcript, characters */
  total: 80_000,
};

/** The two roles a stored transcript may carry. A capture records a
 * conversation, not a prompt set: a `system` message in here would be the
 * harness leaking the pipeline's internals into a resumable chat. */
const CHAT_ROLES = new Set(["user", "assistant"]);

/**
 * A stored transcript, cleaned into the shape stream.js's ConversationRecord
 * wants: `[{role, content}]` with string content, roles limited to
 * user/assistant, and the whole thing bounded.
 *
 * Bounding is applied from the FRONT (the earliest messages are kept) so a
 * truncated transcript still opens with the question that was asked. Dropping
 * the head would leave a chat whose first turn is an answer to nothing.
 *
 * @param {unknown} value
 * @returns {{ role: string, content: string }[]} [] when there is nothing usable
 */
export function normalizeChatMessages(value) {
  if (!Array.isArray(value)) return [];
  /** @type {{ role: string, content: string }[]} */
  const out = [];
  let total = 0;
  for (const raw of value) {
    if (out.length >= CHAT_CAPS.messages || total >= CHAT_CAPS.total) break;
    if (!raw || typeof raw !== "object") continue;
    const role = typeof (/** @type {any} */ (raw).role) === "string" ? /** @type {any} */ (raw).role.trim() : "";
    if (!CHAT_ROLES.has(role)) continue;
    const content = chatText(/** @type {any} */ (raw).content);
    if (!content) continue;
    const room = Math.max(0, Math.min(CHAT_CAPS.content, CHAT_CAPS.total - total));
    if (!room) break;
    const text = content.length > room ? content.slice(0, room) : content;
    out.push({ role, content: text });
    total += text.length;
  }
  return out;
}

/**
 * One message's content as text. Accepts the multipart shape `/api/chat`
 * itself uses (`[{type:"text", text}, …]`) so a transcript read off a turn
 * with attachments does not come back empty — the image parts are simply not
 * text and are dropped.
 *
 * @param {unknown} content
 * @returns {string}
 */
function chatText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && /** @type {any} */ (p).type === "text" && typeof (/** @type {any} */ (p).text) === "string")
    .map((p) => /** @type {any} */ (p).text)
    .join("\n")
    .trim();
}

/**
 * THE SEED: everything the app needs to reopen a capture's run as a live chat.
 *
 * `resumable` is the honest half of the contract. True means the recorded
 * conversation itself is here and reopening it restores what the clip shows;
 * false means only the question survived, and the reader gets a composer
 * loaded with it rather than a transcript. The link's wording keys off this,
 * because "continue this chat" over an empty history is a promise the app
 * cannot keep.
 *
 * @param {any} c a capture (row projection or API entry)
 * @param {unknown} [messages] the transcript, when it is not on `c`
 * @returns {{ id: number|string|null, tag: string, name: string, title: string,
 *   prompt: string, mode: string|null, model: string, lang: string|null,
 *   messages: {role: string, content: string}[], resumable: boolean,
 *   recorded_at: number|null }}
 */
export function captureChatSeed(c, messages) {
  const src = c && typeof c === "object" ? c : {};
  const msgs = normalizeChatMessages(messages === undefined ? /** @type {any} */ (src).chat : messages);
  const tag = captureRef(src);
  const name = captureName(src);
  const prompt = typeof (/** @type {any} */ (src).prompt) === "string" ? /** @type {any} */ (src).prompt.trim() : "";
  return {
    id: /** @type {any} */ (src).id ?? null,
    tag,
    name,
    // The conversation's title in the history drawer. The tag leads for the
    // same reason it leads on a card: #CAP-12 is how the clip is asked for out
    // loud, and a chat that cannot be matched back to its video is a chat
    // nobody knows the provenance of.
    title: tag ? `${tag} · ${name}` : name,
    prompt,
    // THE AGENT THE RUN WAS RECORDED UNDER — the one field a reopened capture
    // cannot afford to get wrong: a Cyber run continued under Deep Science is a
    // different agent answering the follow-up, and nothing on screen says so.
    // Null leaves the tab's current agent alone rather than snapping it to the
    // default — the same rule stream.js applies to a conversation record with
    // no `chatMode`.
    //
    // A row whose `mode` column is empty has it DERIVED FROM ITS AGENT before
    // it ever reaches here (src/captures.js `projectCapture`), because the
    // documented publish recipe left `mode` out of its payload until
    // 2026-08-14 and five published Cyber clips reached D1 with `mode: null` —
    // every one of them opening in whichever agent the reader was already in.
    // The derivation is upstream and not here only because this file must stay
    // import-free (see the header); it is not optional.
    mode: cleanMode(/** @type {any} */ (src).mode) || null,
    model: typeof (/** @type {any} */ (src).model) === "string" ? /** @type {any} */ (src).model.trim() : "",
    lang: typeof (/** @type {any} */ (src).lang) === "string" && /** @type {any} */ (src).lang.trim() ? /** @type {any} */ (src).lang.trim() : null,
    messages: msgs,
    resumable: msgs.length > 0,
    // `created_at` on a capture row, `recorded_at` on a seed that has already
    // been through here once — the client re-normalises the server's answer
    // rather than trusting it, and a round trip must not lose the one date
    // that says when the run happened.
    recorded_at: field(/** @type {any} */ (src).created_at ?? /** @type {any} */ (src).recorded_at),
  };
}

/**
 * Where a capture's chat opens. A query parameter on the app's own root, not a
 * fragment: the app reads it during boot (app.js) and a fragment is also where
 * Se/cure keeps workspace material, which is not this.
 *
 * @param {any} c a capture, or a bare id
 * @returns {string} "" when there is no id to link to
 */
export function captureChatUrl(c) {
  const id = c && typeof c === "object" ? /** @type {any} */ (c).id : c;
  const n = field(id);
  if (n === null || n <= 0) return "";
  return `/?capture=${Math.trunc(n)}`;
}

/**
 * The link's own words. A clip whose transcript survived offers to CONTINUE
 * the conversation; one recorded before transcripts existed offers to ask the
 * question again, which is a smaller and truthful promise.
 *
 * @param {any} c
 * @returns {{ text: string, title: string, resumable: boolean }}
 */
export function captureChatLink(c) {
  const resumable = !!(c && typeof c === "object" && /** @type {any} */ (c).has_chat);
  return resumable
    ? {
      text: "💬 Continue this chat",
      title: "Open the recorded conversation in the app and keep asking from where the clip ends",
      resumable,
    }
    : {
      text: "💬 Ask this again",
      title: "This clip was recorded before transcripts were kept — opens the composer with the same agent, model and question",
      resumable,
    };
}

/**
 * The rows the history drawer's "Recorded runs" group renders: one per
 * capture, newest first, each carrying what it takes to name a run and open
 * it. Anything without an id is dropped — a row that cannot be opened is a
 * row that only teaches the reader the group is broken.
 *
 * @param {any} data the /api/admin/captures/chats body, or a bare array
 * @returns {{ id: number, tag: string, title: string, agent: string,
 *   prompt: string, url: string, resumable: boolean, when: number|null }[]}
 */
export function captureChatRows(data) {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray(/** @type {any} */ (data).captures)
      ? /** @type {any} */ (data).captures
      : [];
  /** @type {any[]} */
  const rows = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const id = field(/** @type {any} */ (c).id);
    if (id === null || id <= 0) continue;
    const url = captureChatUrl(c);
    if (!url) continue;
    rows.push({
      id: Math.trunc(id),
      tag: captureRef(c),
      title: captureName(c),
      agent: typeof (/** @type {any} */ (c).agent) === "string" ? /** @type {any} */ (c).agent.trim() : "",
      prompt: typeof (/** @type {any} */ (c).prompt) === "string" ? /** @type {any} */ (c).prompt.trim() : "",
      url,
      resumable: !!(/** @type {any} */ (c).has_chat),
      when: field(/** @type {any} */ (c).created_at),
    });
  }
  return rows;
}
