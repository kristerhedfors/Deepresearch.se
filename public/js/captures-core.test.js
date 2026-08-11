// Unit tests for the capture-review pure core (public/js/captures-core.js):
// the swipe/fling verdict maths, the drag-feedback styling, deck bookkeeping,
// note validation and the display formatters.
//
// The gesture rules are the reason this core exists. Every one of them is a
// judgement about a thumb on glass that cannot be re-derived from the code
// six months from now, so each test says WHAT WOULD BREAK if the rule went.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DECK_FILTERS,
  KEY_VERDICTS,
  MAX_TILT_DEG,
  NOTE_MAX,
  QUEUE_TARGET,
  SWIPE,
  activeVersion,
  badgeText,
  captureFacts,
  captureHeadline,
  captureName,
  captureRef,
  captureTag,
  captureThread,
  captureTitle,
  captureVersions,
  cardStyle,
  flingVerdict,
  formatBytes,
  formatClock,
  formatDay,
  formatDuration,
  hasVersionHistory,
  nextDeck,
  playbackSource,
  queueHealthLine,
  queueTarget,
  queueUnanswered,
  reviewSummary,
  shortSha,
  statusLabel,
  swipeHint,
  swipeThreshold,
  swipeVerdict,
  validateNote,
  versionLabel,
  versionMedia,
} from "./captures-core.js";

// A card wide enough that the fractional threshold governs rather than the
// px floor: 600 × 0.28 = 168px.
const W = 600;

// ---- swipeVerdict ---------------------------------------------------------

test("swipeVerdict: right past the threshold is a like, left is feedback", () => {
  assert.equal(swipeVerdict(200, 0, W), "like");
  assert.equal(swipeVerdict(-200, 0, W), "feedback");
  // Exactly ON the threshold commits — a boundary that required one extra
  // pixel would make the documented 28% a lie.
  assert.equal(swipeVerdict(168, 0, W), "like");
  assert.equal(swipeVerdict(-168, 0, W), "feedback");
});

test("swipeVerdict: a short drag springs back instead of filing a clip", () => {
  // One pixel short of the threshold must NOT file: this is the difference
  // between "I changed my mind mid-drag" and a capture silently marked liked.
  assert.equal(swipeVerdict(167, 0, W), null);
  assert.equal(swipeVerdict(-167, 0, W), null);
  assert.equal(swipeVerdict(0, 0, W), null);
});

test("swipeVerdict: a mostly-vertical drag is a page scroll, not a verdict", () => {
  // The deck sits in a long scrolling admin page. |dy| > |dx| * 0.6 is the
  // scroll; filing a clip on it would be both wrong and unnoticed, because
  // the card is gone by the time the owner looks back.
  assert.equal(swipeVerdict(200, 200, W), null);
  assert.equal(swipeVerdict(-200, 200, W), null);
  assert.equal(swipeVerdict(200, 121, W), null); // 200 * 0.6 = 120 → 121 rejects
  assert.equal(swipeVerdict(200, 120, W), "like"); // …120 is still in the cone
  // Pure vertical never files, however far it travels.
  assert.equal(swipeVerdict(0, 400, W), null);
});

test("swipeVerdict: the px floor governs a narrow card", () => {
  // A 200px card's 28% is 56px — inside the slop of a sloppy tap. minPx keeps
  // an accidental nudge on a narrow card from filing a capture.
  assert.equal(swipeThreshold(200), SWIPE.minPx);
  assert.equal(swipeVerdict(60, 0, 200), null);
  assert.equal(swipeVerdict(72, 0, 200), "like");
});

test("swipeVerdict: width 0 / NaN / missing never throws and never files early", () => {
  // getBoundingClientRect() on a hidden or torn-down card measures 0 or NaN.
  // Throwing inside a pointermove handler leaves the pointer captured and
  // locks the panel until reload, so these MUST degrade to the px floor.
  for (const bad of [0, NaN, undefined, null, "wide", Infinity, -100]) {
    assert.equal(swipeThreshold(bad), SWIPE.minPx);
    assert.equal(swipeVerdict(200, 0, bad), "like");
    assert.equal(swipeVerdict(10, 0, bad), null);
  }
  // Non-numeric pointer deltas are inert rather than fatal.
  assert.equal(swipeVerdict(undefined, undefined, W), null);
  assert.equal(swipeVerdict(NaN, NaN, NaN), null);
});

test("swipeVerdict: per-call overrides are honoured", () => {
  assert.equal(swipeVerdict(100, 0, W, { minPx: 10, threshold: 0.1 }), "like");
  assert.equal(swipeVerdict(200, 0, W, { minPx: 400 }), null);
});

// ---- flingVerdict ---------------------------------------------------------

test("flingVerdict: a fast short flick files the card", () => {
  // 60px in 40ms = 1.5 px/ms. The distance rule alone would reject this, and
  // a deck that ignores flicks reads as broken on a phone — a phone user
  // flicks, they do not drag a card 168px.
  assert.equal(swipeVerdict(60, 0, W), null);
  assert.equal(flingVerdict(60, 0, W, 40), "like");
  assert.equal(flingVerdict(-60, 0, W, 40), "feedback");
});

test("flingVerdict: a slow drag still has to cover the distance", () => {
  // 60px over 600ms = 0.1 px/ms — a considered, abandoned drag. The distance
  // rule must keep governing the careful case or the deck becomes twitchy.
  assert.equal(flingVerdict(60, 0, W, 600), null);
  // A long drag files regardless of how slow it was.
  assert.equal(flingVerdict(200, 0, W, 5000), "like");
});

test("flingVerdict: a twitch is not a flick", () => {
  // 5px in 4ms is 1.25 px/ms — past the velocity gate. Without flingMinPx a
  // tap on the video's play button would file the clip.
  assert.equal(flingVerdict(5, 0, W, 4), null);
  assert.equal(flingVerdict(24, 0, W, 20), "like"); // at the floor, 1.2 px/ms
});

test("flingVerdict: velocity does not defeat the vertical guard", () => {
  // A fast flick down the page is a fling-scroll, the single most common
  // gesture on this page. It must never file a capture.
  assert.equal(flingVerdict(60, 200, W, 40), null);
  assert.equal(flingVerdict(-60, -200, W, 40), null);
});

test("flingVerdict: missing/zero duration falls back to the distance rule", () => {
  assert.equal(flingVerdict(60, 0, W, 0), null);
  assert.equal(flingVerdict(60, 0, W, -5), null);
  assert.equal(flingVerdict(60, 0, W, undefined), null);
  assert.equal(flingVerdict(200, 0, W, undefined), "like");
});

// ---- keyboard equivalence -------------------------------------------------

test("the arrow keys produce exactly the pointer verdicts", () => {
  // A swipe-only surface is unusable with a mouse and inaccessible with a
  // keyboard. If these two ever disagree, one input method files the opposite
  // verdict from the other — silently.
  assert.equal(KEY_VERDICTS.ArrowRight, swipeVerdict(200, 0, W));
  assert.equal(KEY_VERDICTS.ArrowLeft, swipeVerdict(-200, 0, W));
  assert.equal(KEY_VERDICTS.ArrowRight, "like");
  assert.equal(KEY_VERDICTS.ArrowLeft, "feedback");
  assert.deepEqual(Object.keys(KEY_VERDICTS).sort(), ["ArrowLeft", "ArrowRight"]);
});

// ---- cardStyle ------------------------------------------------------------

test("cardStyle leans the card the way it will be filed, capped at ±12°", () => {
  assert.ok(cardStyle(100, 0, W).tilt > 0, "dragging right leans right");
  assert.ok(cardStyle(-100, 0, W).tilt < 0, "dragging left leans left");
  assert.equal(cardStyle(0, 0, W).tilt, 0);
  // The cap: without it a long drag spins the card past legibility, and on a
  // narrow card any drag at all would.
  assert.equal(cardStyle(10000, 0, W).tilt, MAX_TILT_DEG);
  assert.equal(cardStyle(-10000, 0, W).tilt, -MAX_TILT_DEG);
  assert.equal(cardStyle(500, 0, 50).tilt, MAX_TILT_DEG);
});

test("cardStyle emits a usable transform and a partial fade", () => {
  const s = cardStyle(40, 12, W);
  assert.match(s.transform, /^translate\(40px, 12px\) rotate\(-?[\d.]+deg\)$/);
  assert.equal(cardStyle(0, 0, W).opacity, 1);
  // Never fades to nothing: an invisible card mid-gesture reads as a bug and
  // the owner loses track of what is being filed.
  assert.ok(cardStyle(9999, 0, W).opacity >= 0.6);
  assert.ok(cardStyle(400, 0, W).opacity < 1);
});

test("cardStyle survives a card it cannot measure", () => {
  for (const bad of [0, NaN, undefined, null]) {
    const s = cardStyle(100, 0, bad);
    assert.ok(Number.isFinite(s.tilt));
    assert.ok(Number.isFinite(s.opacity));
    assert.match(s.transform, /translate\(100px, 0px\)/);
  }
});

// ---- swipeHint ------------------------------------------------------------

test("swipeHint names the side and how close the drag is to committing", () => {
  // This drives the 👍 / ✍️ overlay. Without it a first-time reviewer has to
  // GUESS which direction means what — and guessing wrong files a keeper.
  assert.deepEqual(swipeHint(84, 0, W), { side: "like", progress: 0.5 });
  assert.deepEqual(swipeHint(-84, 0, W), { side: "feedback", progress: 0.5 });
  assert.equal(swipeHint(400, 0, W).progress, 1, "progress saturates at 1");
  assert.deepEqual(swipeHint(0, 0, W), { side: null, progress: 0 });
});

test("swipeHint shows nothing while the page is being scrolled", () => {
  assert.deepEqual(swipeHint(40, 300, W), { side: null, progress: 0 });
  assert.deepEqual(swipeHint(0, 300, W), { side: null, progress: 0 });
});

test("swipeHint reaches full progress exactly when swipeVerdict commits", () => {
  // The overlay is a promise about what release will do. If the hint saturated
  // before or after the verdict fired, the UI would be lying about the gesture.
  const t = swipeThreshold(W);
  assert.equal(swipeHint(t, 0, W).progress, 1);
  assert.equal(swipeVerdict(t, 0, W), "like");
  assert.ok(swipeHint(t - 1, 0, W).progress < 1);
  assert.equal(swipeVerdict(t - 1, 0, W), null);
});

// ---- nextDeck -------------------------------------------------------------

test("nextDeck drops what was reviewed this session, keeping server order", () => {
  // The queue is not re-fetched per swipe (50 rows per gesture would stutter
  // the deck), so the client has to remember what it filed.
  const list = [{ id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(nextDeck(list, { reviewedIds: new Set([4]) }), [{ id: 3 }, { id: 5 }]);
  assert.deepEqual(nextDeck(list, { reviewedIds: [3, 5] }), [{ id: 4 }]);
  // Ids may arrive as strings from a dataset attribute — compare as strings.
  assert.deepEqual(nextDeck(list, { reviewedIds: ["4"] }), [{ id: 3 }, { id: 5 }]);
});

test("nextDeck is inert on junk rather than emptying the deck", () => {
  assert.deepEqual(nextDeck(null), []);
  assert.deepEqual(nextDeck(undefined, {}), []);
  assert.deepEqual(nextDeck([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(nextDeck([{ id: 1 }], { reviewedIds: 7 }), [{ id: 1 }]);
  // Rows with no id can never be reviewed (no endpoint to post to), so they
  // are dropped rather than shown as an unactionable card.
  assert.deepEqual(nextDeck([null, { id: 1 }, {}]), [{ id: 1 }]);
});

// ---- titles and facts -----------------------------------------------------

test("captureTitle prefers the author's label", () => {
  assert.equal(captureTitle({ label: "  Portrait demo  ", agent: "research" }), "Portrait demo");
});

test("captureTitle falls back to agent · model plus the prompt", () => {
  // A deck of clips all titled with the same model is unreviewable; the prompt
  // is what tells two runs of one model apart.
  const t = captureTitle({ agent: "research", model: "mistral-small", prompt: "What is CRISPR?" });
  assert.equal(t, "research · mistral-small — What is CRISPR?");
  assert.equal(captureTitle({ agent: "research" }), "research");
  assert.equal(captureTitle({ prompt: "hello" }), "hello");
  assert.equal(captureTitle({}), "Untitled capture");
  assert.equal(captureTitle(null), "Untitled capture");
});

test("captureTitle truncates a long prompt to one line", () => {
  const t = captureTitle({ agent: "a", model: "b", prompt: "x".repeat(400) });
  assert.ok(t.length < 100, `title stayed one line: ${t.length}`);
  assert.ok(t.endsWith("…"));
});

test("captureFacts builds the facts row in order", () => {
  assert.deepEqual(
    captureFacts({
      size_bytes: 3355443,
      duration_ms: 24000,
      speed: 1.5,
      cut_ms: 161000,
      shape: "portrait",
    }),
    ["3.2 MB", "0:24", "1.5x", "cut 2m 41s", "portrait"],
  );
});

test("captureFacts OMITS a missing fact rather than printing undefined", () => {
  // Captures come from a harness still under development, so half-filled rows
  // are normal — "undefined · NaN:aN" in an admin card is the bug report we
  // would otherwise get.
  assert.deepEqual(captureFacts({ duration_ms: 5000, shape: "square" }), ["0:05", "square"]);
  assert.deepEqual(captureFacts({}), []);
  assert.deepEqual(captureFacts(null), []);
  assert.deepEqual(captureFacts({ size_bytes: null, duration_ms: "x", cut_ms: undefined }), []);
  // 1× is the default and says nothing — it is noise in a five-item row.
  assert.deepEqual(captureFacts({ speed: 1 }), []);
});

// ---- formatters -----------------------------------------------------------

test("formatBytes scales and blanks the unknown", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(3355443), "3.2 MB");
  assert.equal(formatBytes(52428800), "50 MB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.0 GB");
  for (const bad of [undefined, null, NaN, -1, "big", {}]) {
    assert.equal(formatBytes(bad), "", `blank for ${String(bad)}`);
  }
});

test("formatClock renders m:ss the way a player does", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(24000), "0:24");
  assert.equal(formatClock(161000), "2:41");
  assert.equal(formatClock(605000), "10:05");
  for (const bad of [undefined, null, NaN, -1, "x"]) assert.equal(formatClock(bad), "");
});

test("formatDuration speaks the length", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(41000), "41s");
  assert.equal(formatDuration(161000), "2m 41s");
  assert.equal(formatDuration(3723000), "1h 2m");
  for (const bad of [undefined, null, NaN, -1, "x"]) assert.equal(formatDuration(bad), "");
});

// ---- note validation ------------------------------------------------------

test("validateNote rejects an empty note", () => {
  // The server 400s a feedback verdict with no note. Posting one anyway turns
  // the owner's swipe into an HTTP error they cannot act on — the whole point
  // of revealing the field on a left swipe.
  for (const bad of ["", "   ", "\n\t ", undefined, null, 42]) {
    const v = validateNote(bad);
    assert.equal(v.ok, false);
    assert.ok(v.error, "an actionable message, not a bare false");
    assert.equal(v.note, undefined);
  }
});

test("validateNote trims and caps", () => {
  assert.deepEqual(validateNote("  the intro drags  "), { ok: true, note: "the intro drags" });
  const long = validateNote("x".repeat(NOTE_MAX + 1));
  assert.equal(long.ok, false);
  assert.match(String(long.error), new RegExp(String(NOTE_MAX)));
  assert.equal(validateNote("x".repeat(NOTE_MAX)).ok, true);
});

// ---- reviewSummary --------------------------------------------------------

test("reviewSummary reads back the last verdict", () => {
  assert.equal(reviewSummary({ reviews: [{ verdict: "like" }] }), "👍 liked");
  assert.equal(
    reviewSummary({ reviews: [{ verdict: "like" }, { verdict: "feedback", note: "too long" }] }),
    "✍️ too long",
  );
  assert.equal(reviewSummary({ reviews: [{ verdict: "feedback", note: "  " }] }), "✍️ feedback (no note)");
});

test("reviewSummary falls back to the row status, and is blank for an unreviewed clip", () => {
  assert.equal(reviewSummary({ status: "liked" }), "👍 liked");
  assert.equal(reviewSummary({ status: "needs_work" }), "✍️ feedback (no note)");
  assert.equal(reviewSummary({ status: "new", reviews: [] }), "");
  assert.equal(reviewSummary(null), "");
});

test("reviewSummary keeps a long note to one line", () => {
  const s = reviewSummary({ reviews: [{ verdict: "feedback", note: "y".repeat(500) }] });
  assert.ok(s.length < 200, `summary stayed one line: ${s.length}`);
  assert.ok(s.endsWith("…"));
});

// ---- the filter row -------------------------------------------------------

test("DECK_FILTERS covers every server status plus all", () => {
  // A reviewed clip has to be findable again; a filter row missing a status
  // means captures that were filed simply vanish from the admin.
  assert.deepEqual(DECK_FILTERS.map((f) => f.id), ["new", "liked", "needs_work", ""]);
  for (const f of DECK_FILTERS) assert.ok(f.label, "every filter is labelled");
});

// ===========================================================================
// The 2026-08-11 extension: identity (the number + the name), provenance (the
// commit), version history, the feedback thread, and the queue's health.
// ===========================================================================

// ---- captureTag / captureRef ----------------------------------------------

test("captureTag writes the reference the owner speaks in", () => {
  // "produce a review of #12" only works if the card SHOWS #CAP-12.
  assert.equal(captureTag(12), "#CAP-12");
  assert.equal(captureTag("12"), "#CAP-12");
  assert.equal(captureTag(12.7), "#CAP-12");
});

test("captureTag renders nothing rather than a wrong number", () => {
  // "#CAP-undefined" as the leading fact of a card is worse than no heading.
  assert.equal(captureTag(undefined), "");
  assert.equal(captureTag(null), "");
  assert.equal(captureTag(""), "");
  assert.equal(captureTag(NaN), "");
});

test("captureRef prefers the server's tag over one derived from the id", () => {
  // A future renumbering must not need a client release to be shown right.
  assert.equal(captureRef({ id: 3, tag: "#CAP-903" }), "#CAP-903");
  assert.equal(captureRef({ id: 3 }), "#CAP-3");
  assert.equal(captureRef(null), "");
});

// ---- captureName / captureHeadline -----------------------------------------

test("captureName prefers the server's short name, then the label", () => {
  assert.equal(captureName({ name: "Swedish electricity prices", label: "x" }), "Swedish electricity prices");
  assert.equal(captureName({ label: "Elpris i Sverige" }), "Elpris i Sverige");
});

test("captureName derives a few-word name from the starter id", () => {
  // The fallback the four pre-versions captures need: no name column, but a
  // starter id that says what the clip is about.
  assert.equal(captureName({ starter: "res-sv-elpris" }), "Elpris");
  assert.equal(captureName({ starter: "sch-vitamin-d" }), "Vitamin D");
  assert.equal(captureName({ starter: "int-pipeline" }), "Pipeline");
  // Never more than four words — this is a NAME, not a sentence.
  assert.equal(captureName({ starter: "a-b-c-d-e-f" }).split(" ").length, 4);
});

test("captureName falls back to a short prompt, never a paragraph", () => {
  const c = { prompt: "z".repeat(300) };
  const name = captureName(c);
  assert.ok(name.length <= 48, `name stayed short: ${name.length}`);
  assert.equal(captureName({}), "Untitled capture");
});

test("captureHeadline leads with the number", () => {
  const h = captureHeadline({ id: 12, name: "Swedish electricity prices" });
  assert.deepEqual(h, {
    tag: "#CAP-12",
    name: "Swedish electricity prices",
    text: "#CAP-12 · Swedish electricity prices",
  });
  // No id (an unsaved row) still reads as a title rather than " · name".
  assert.equal(captureHeadline({ name: "Draft" }).text, "Draft");
});

// ---- shortSha --------------------------------------------------------------

test("shortSha shortens a real sha and drops anything that is not one", () => {
  assert.equal(shortSha("4f2a1c9d3b8e7a6f5c4d3b2a1908070605040302"), "4f2a1c9");
  assert.equal(shortSha("4F2A1C9D3B8E"), "4f2a1c9");
  // A branch name or a "dirty" marker in the column is NOT provenance: a chip
  // there claims "check this out and you get this clip", which would be a lie.
  assert.equal(shortSha("main"), "");
  assert.equal(shortSha("4f2a1c9-dirty"), "");
  assert.equal(shortSha(null), "");
  assert.equal(shortSha(""), "");
});

// ---- versions --------------------------------------------------------------

const VERSIONED = {
  id: 7,
  versions: [
    { version: 1, created_at: Date.UTC(2026, 7, 3), commit_sha: "aaaaaaa1111111" },
    { version: 3, created_at: Date.UTC(2026, 7, 11), commit_sha: "ccccccc3333333", is_current: true },
    { version: 2, created_at: Date.UTC(2026, 7, 7) },
  ],
};

test("captureVersions orders newest first and fills in the media URLs", () => {
  const list = captureVersions(VERSIONED);
  assert.deepEqual(list.map((v) => v.version), [3, 2, 1]);
  assert.equal(list[1].video_url, "/api/admin/captures/7/versions/2/video");
  assert.equal(list[1].poster_url, "/api/admin/captures/7/versions/2/poster");
  // A URL the server did send is kept — the client never overrides the server.
  const kept = captureVersions({ id: 7, versions: [{ version: 1, video_url: "/x.mp4" }] });
  assert.equal(kept[0].video_url, "/x.mp4");
});

test("captureVersions marks exactly one current, defaulting to the newest", () => {
  assert.equal(captureVersions(VERSIONED).filter((v) => v.is_current).length, 1);
  const noFlag = captureVersions({ id: 7, versions: [{ version: 1 }, { version: 2 }] });
  assert.equal(noFlag[0].version, 2);
  assert.equal(noFlag[0].is_current, true);
});

test("captureVersions drops rows it could not play or name", () => {
  // A version with no number has no API path and no label — offering a button
  // for it would be a control that cannot work (UX-18).
  const list = captureVersions({ id: 7, versions: [{ version: 2 }, {}, { version: "x" }, null, { version: 2 }] });
  assert.deepEqual(list.map((v) => v.version), [2]);
});

test("captureVersions is empty for a server that has no version list yet", () => {
  // The whole point of the fallback: the deck must render exactly as before
  // against a Worker that predates versions.
  assert.deepEqual(captureVersions({ id: 1 }), []);
  assert.deepEqual(captureVersions({ id: 1, versions: "nope" }), []);
  assert.deepEqual(captureVersions(null), []);
  assert.equal(hasVersionHistory({ id: 1 }), false);
  assert.equal(activeVersion({ id: 1 }), null);
});

test("hasVersionHistory needs TWO versions — one version is just the video", () => {
  assert.equal(hasVersionHistory({ id: 7, versions: [{ version: 1 }] }), false);
  assert.equal(hasVersionHistory(VERSIONED), true);
});

test("activeVersion plays the current cut, else the newest", () => {
  assert.equal(activeVersion(VERSIONED).version, 3);
  assert.equal(activeVersion({ id: 7, versions: [{ version: 1 }, { version: 4 }] }).version, 4);
});

test("versionMedia refuses to build a URL it cannot address", () => {
  assert.deepEqual(versionMedia("", 2), { video: "", poster: "" });
  assert.deepEqual(versionMedia(7, 0), { video: "", poster: "" });
});

test("versionLabel names the cut and dates the older ones", () => {
  const [v3, v2] = captureVersions(VERSIONED);
  assert.equal(versionLabel(v3), "v3 · current");
  assert.equal(versionLabel(v2), "v2 · 7 Aug 2026");
  assert.equal(versionLabel(null), "");
});

test("playbackSource falls back to the capture's own URLs when there is no version", () => {
  // The four captures recorded before versions existed keep their bytes at the
  // unversioned key; "no version" is a supported input, not a bug.
  assert.deepEqual(playbackSource({ video_url: "/v.mp4", poster_url: "/p.jpg", has_poster: true }), {
    video_url: "/v.mp4",
    poster_url: "/p.jpg",
    has_video: true,
  });
  assert.equal(playbackSource({ has_video: false, video_url: "/v.mp4" }).has_video, false);
  // The capture-level poster_url is derived from the id, so it is a string
  // even when nothing was uploaded — `has_poster` is what decides.
  assert.equal(playbackSource({ video_url: "/v.mp4", poster_url: "/p.jpg" }).poster_url, "");
  assert.equal(playbackSource({}).has_video, false);
  const v = captureVersions(VERSIONED)[0];
  assert.equal(playbackSource(VERSIONED, v).video_url, "/api/admin/captures/7/versions/3/video");
});

test("formatDay is UTC so the tests do not depend on the runner's timezone", () => {
  assert.equal(formatDay(Date.UTC(2026, 7, 11, 12)), "11 Aug 2026");
  assert.equal(formatDay("2026-08-11T12:00:00.000Z"), "11 Aug 2026");
  assert.equal(formatDay(null), "");
  assert.equal(formatDay("not a date"), "");
});

// ---- the feedback thread ---------------------------------------------------

test("captureThread keeps the notes in the order they were written", () => {
  const t = captureThread({
    reviews: [
      { verdict: "feedback", note: "the cut swallows the first search", created_at: Date.UTC(2026, 7, 3) },
      { verdict: "like", created_at: Date.UTC(2026, 7, 9) },
    ],
  });
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], {
    verdict: "feedback",
    note: "the cut swallows the first search",
    day: "3 Aug 2026",
    mark: "✍️",
  });
  assert.equal(t[1].mark, "👍");
});

test("captureThread is empty when there is nothing to show", () => {
  assert.deepEqual(captureThread({ reviews: [] }), []);
  assert.deepEqual(captureThread({}), []);
  assert.deepEqual(captureThread(null), []);
});

// ---- queue health ----------------------------------------------------------

test("queueUnanswered reads either endpoint's answer", () => {
  assert.equal(queueUnanswered({ target: 20, unanswered: 14 }), 14);
  assert.equal(queueUnanswered({ captures: [{ id: 1 }, { id: 2 }], count: 2 }), 2);
  assert.equal(queueUnanswered({ count: 5 }), 5);
  assert.equal(queueUnanswered({ unanswered: 0 }), 0);
});

test("queueUnanswered says 'I do not know' rather than zero", () => {
  // null and 0 are DIFFERENT facts: an empty queue is worth reporting, an
  // unreadable one is not — and reporting "0 of 20" to a non-admin whose probe
  // 403'd would be a confident lie.
  assert.equal(queueUnanswered(null), null);
  assert.equal(queueUnanswered({ __error: "HTTP 403" }), null);
  assert.equal(queueUnanswered({}), null);
  assert.equal(queueUnanswered("nope"), null);
});

test("queueTarget follows the server, so the number can move without a release", () => {
  assert.equal(queueTarget({ target: 30 }), 30);
  assert.equal(queueTarget({}), QUEUE_TARGET);
  assert.equal(queueTarget(null), QUEUE_TARGET);
  assert.equal(QUEUE_TARGET, 20);
});

test("queueHealthLine states the queue against its target", () => {
  assert.equal(queueHealthLine(14), "14 of 20 unanswered");
  assert.equal(queueHealthLine(14, 30), "14 of 30 unanswered");
  assert.equal(queueHealthLine(0), "0 of 20 unanswered");
});

test("queueHealthLine stays silent when the count is unknown", () => {
  assert.equal(queueHealthLine(null), "");
  assert.equal(queueHealthLine(undefined), "");
  assert.equal(queueHealthLine(-1), "");
});

// ---- the header launcher's badge -------------------------------------------

test("badgeText hides an empty queue and caps a full one", () => {
  // An empty queue is good news, not a notification: the caller hides the pill
  // when this is "".
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(null), "");
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
  assert.equal(badgeText(4000), "99+");
});

test("DECK_FILTERS are the owner's four lists, in the owner's words", () => {
  assert.deepEqual(DECK_FILTERS.map((f) => f.label), ["To review", "Appreciated", "Needs work", "All"]);
});

test("statusLabel says a status in the same words as its list", () => {
  // A badge reading "liked" beside a filter reading "Appreciated" makes the
  // reader work out whether they are the same state. They are.
  assert.equal(statusLabel("liked"), "appreciated");
  assert.equal(statusLabel("new"), "to review");
  assert.equal(statusLabel("needs_work"), "needs work");
  // A status the deck does not know is passed through, never hidden.
  assert.equal(statusLabel("archived"), "archived");
  assert.equal(statusLabel(""), "");
  assert.equal(statusLabel(null), "");
});
