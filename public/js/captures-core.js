// @ts-check
// Capture review deck — the client PURE core (Node-tested in
// public/js/captures-core.test.js). The DOM/fetch half is public/js/captures.js;
// everything import-safe outside a browser lives here.
//
// A "capture" is a recorded run of the research pipeline (one agent × one
// model × one query) edited into a short clip for sharing. The admin reviews
// them as a card deck: swipe RIGHT to keep a clip, LEFT to say what is wrong
// with it. The gesture MATH is the fiddly, regression-prone part — a threshold
// that is wrong by 20px makes the deck feel either twitchy or dead — so it
// lives here as pure functions with unit tests rather than tangled into
// pointer handlers where the only way to check it is a thumb on a phone.
//
// Nothing here may touch `document`, `window`, `fetch` or the clock: the test
// runner imports this file in bare Node.

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
  // within ~31° of the horizontal. The deck sits inside a long scrolling admin
  // page, so a mostly-vertical drag is the owner SCROLLING past the panel, not
  // judging a clip; filing a capture on a scroll would be both wrong and
  // unreviewable (the card is already gone by the time they notice).
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

// The deck filters offered above the stack. "new" is the review queue; the
// rest exist so a clip that was already filed can be found again.
export const DECK_FILTERS = [
  { id: "new", label: "To review" },
  { id: "liked", label: "Liked" },
  { id: "needs_work", label: "Needs work" },
  { id: "", label: "All" },
];

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

// ---- deck bookkeeping ------------------------------------------------------

/**
 * The captures still awaiting a verdict, in the server's display order minus
 * anything already reviewed in THIS session. The queue is not re-fetched after
 * every verdict (that would re-download 50 rows per swipe and stutter the
 * deck), so the client has to remember what it has filed.
 *
 * @param {any[]} captures
 * @param {{ reviewedIds?: Iterable<any> }} [opts]
 * @returns {any[]}
 */
export function nextDeck(captures, opts) {
  const list = Array.isArray(captures) ? captures : [];
  const raw = opts && opts.reviewedIds ? opts.reviewedIds : [];
  /** @type {Set<string>} */
  const done = new Set();
  try {
    for (const id of /** @type {Iterable<any>} */ (raw)) done.add(String(id));
  } catch {
    // A non-iterable reviewedIds (a bad caller) must not empty the deck.
  }
  return list.filter((c) => c && c.id != null && !done.has(String(c.id)));
}

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
