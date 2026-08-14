// Unit tests for the capture-review pure core (public/js/captures-core.js):
// the swipe/fling verdict maths, the drag-feedback styling, feed bookkeeping,
// note validation and the display formatters.
//
// The gesture rules are the reason this core exists. Every one of them is a
// judgement about a thumb on glass that cannot be re-derived from the code
// six months from now, so each test says WHAT WOULD BREAK if the rule went.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_CAPS,
  DECK_FILTERS,
  KEY_VERDICTS,
  MAX_TILT_DEG,
  NOTE_MAX,
  QUEUE_TARGET,
  SWIPE,
  activeVersion,
  badgeText,
  captureChatLink,
  captureChatRows,
  captureChatSeed,
  captureChatUrl,
  captureFacts,
  captureHeadline,
  captureName,
  captureRef,
  captureTag,
  captureThread,
  normalizeChatMessages,
  captureTitle,
  captureVersions,
  cardStyle,
  flingVerdict,
  formatBytes,
  formatClock,
  formatDay,
  formatDuration,
  cardState,
  feedRows,
  hasVersionHistory,
  pendingCount,
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
  undoLabel,
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

// ---- the feed -------------------------------------------------------------

test("feedRows keeps the server's order and drops what cannot be acted on", () => {
  // Every control a card offers posts to /:id/review, so an id-less row would
  // render buttons that cannot work (UX-18).
  assert.deepEqual(feedRows([{ id: 3 }, { id: 4 }, { id: 5 }]), [{ id: 3 }, { id: 4 }, { id: 5 }]);
  assert.deepEqual(feedRows([null, { id: 1 }, {}]), [{ id: 1 }]);
  assert.deepEqual(feedRows(null), []);
  assert.deepEqual(feedRows(undefined), []);
});

test("pendingCount counts what still wants a verdict, from the STATUS", () => {
  // Not from a tally of what was swiped this session: on the feed a filed card
  // stays on the page and can be UNDONE, and only the row the server sent back
  // can be right about that.
  const rows = [{ id: 1 }, { id: 2, status: "liked" }, { id: 3, status: "needs_work" }, { id: 4, status: "new" }];
  assert.equal(pendingCount(rows), 2);
  assert.equal(pendingCount([]), 0);
  assert.equal(pendingCount(null), 0);
});

test("cardState reads the STATUS, so a re-cut is reviewable again", () => {
  // The trap this pins: a capture that was sent back and then re-recorded goes
  // to `new` while KEEPING every earlier verdict in its thread. Deriving the
  // card's state from the last review would render that card as already filed
  // and there would be no way to review the new cut at all.
  const recut = { id: 1, status: "new", reviews: [{ verdict: "feedback", note: "too fast" }] };
  const st = cardState(recut);
  assert.equal(st.filed, false);
  assert.equal(st.verdict, null);
  assert.equal(st.can_undo, true, "the earlier verdict is still takeable back");

  const liked = cardState({ id: 2, status: "liked", reviews: [{ verdict: "like" }] });
  assert.equal(liked.filed, true);
  assert.equal(liked.verdict, "like");
  assert.equal(liked.label, "👍 Liked");

  const sent = cardState({ id: 3, status: "needs_work", reviews: [{ verdict: "feedback" }] });
  assert.equal(sent.verdict, "feedback");
  assert.equal(sent.label, "✍️ Sent back");
});

test("cardState treats an unknown status as reviewable, and junk as empty", () => {
  // A row from a newer server must not render a card nobody can act on: being
  // offered a clip twice costs one swipe, a dead card costs the review.
  assert.equal(cardState({ id: 1, status: "quarantined" }).filed, false);
  assert.equal(cardState({ id: 1 }).status, "new");
  assert.equal(cardState(null).status, "new");
  assert.equal(cardState(null).can_undo, false);
  // Archived is filed, but there is no verdict to name.
  const arch = cardState({ id: 1, status: "archived" });
  assert.equal(arch.filed, true);
  assert.equal(arch.verdict, null);
  assert.equal(arch.label, "Archived");
});

test("undoLabel names the verdict being taken back", () => {
  // "Undo" alone on a page where every card has one does not say what is about
  // to happen to THIS card.
  assert.equal(undoLabel({ id: 1, status: "liked", reviews: [{ verdict: "like" }] }), "↩︎ Undo the 👍");
  assert.equal(
    undoLabel({ id: 1, status: "needs_work", reviews: [{ verdict: "like" }, { verdict: "feedback" }] }),
    "↩︎ Undo the ✍️",
    "the LAST verdict is the one that comes back",
  );
  assert.equal(undoLabel({ id: 1, status: "new", reviews: [] }), "", "nothing to undo says nothing");
  assert.equal(undoLabel(null), "");
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

// ---- the chat behind the clip ----------------------------------------------
// A capture links back to the run it recorded (owner directive, 2026-08-14).
// The rules below are the ones that decide whether that link keeps its promise:
// what a transcript is allowed to contain, what a clip WITHOUT one offers
// instead, and where a row that cannot be opened goes (nowhere).

test("normalizeChatMessages keeps user/assistant turns and drops everything else", () => {
  const msgs = normalizeChatMessages([
    { role: "user", content: "  How much geothermal?  " },
    { role: "assistant", content: "About 30%." },
    // A system prompt is the pipeline's internals, not the conversation —
    // restoring it would put the harness's scaffolding into the model's context.
    { role: "system", content: "You are a research assistant." },
    { role: "tool", content: "{}" },
    null,
    "not a message",
    { role: "user", content: "   " },
  ]);
  assert.deepEqual(msgs, [
    { role: "user", content: "How much geothermal?" },
    { role: "assistant", content: "About 30%." },
  ]);
});

test("normalizeChatMessages reads the multipart content shape /api/chat uses", () => {
  // A turn sent with an attachment carries an array of parts. The text parts
  // are the message; an image part is not text and is simply not carried.
  const msgs = normalizeChatMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this photo?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    },
  ]);
  assert.deepEqual(msgs, [{ role: "user", content: "What is in this photo?" }]);
});

test("normalizeChatMessages bounds a transcript FROM THE FRONT", () => {
  // Dropping the head would leave a chat whose first turn answers nothing.
  const long = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  const msgs = normalizeChatMessages(long);
  assert.equal(msgs.length, CHAT_CAPS.messages);
  assert.equal(msgs[0].content, "m0");
});

test("normalizeChatMessages truncates rather than dropping an over-long answer", () => {
  const huge = "x".repeat(CHAT_CAPS.content + 5_000);
  const msgs = normalizeChatMessages([{ role: "user", content: "q" }, { role: "assistant", content: huge }]);
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.length <= CHAT_CAPS.content);
  // The question survives whole — it is the shorter of the two and the one a
  // reader needs to make sense of what they reopened.
  assert.equal(msgs[0].content, "q");
});

test("normalizeChatMessages answers a non-array with an empty transcript", () => {
  for (const junk of [null, undefined, "", 0, {}, { messages: [] }]) {
    assert.deepEqual(normalizeChatMessages(/** @type {any} */ (junk)), []);
  }
});

test("captureChatSeed carries the run's agent, model and question", () => {
  const seed = captureChatSeed({
    id: 12,
    tag: "#CAP-12",
    name: "Elpris",
    agent: "science",
    mode: "science",
    model: "mistral-small",
    prompt: "Vad kostar elen?",
    lang: "sv",
    created_at: 1_700_000_000_000,
    chat: [{ role: "user", content: "Vad kostar elen?" }, { role: "assistant", content: "Svar." }],
  });
  assert.equal(seed.title, "#CAP-12 · Elpris");
  assert.equal(seed.mode, "science");
  assert.equal(seed.model, "mistral-small");
  assert.equal(seed.lang, "sv");
  assert.equal(seed.recorded_at, 1_700_000_000_000);
  assert.equal(seed.resumable, true);
  assert.equal(seed.messages.length, 2);
});

test("captureChatSeed of a clip recorded before transcripts is NOT resumable", () => {
  // Every capture published before 2026-08-14 is this row. It still links —
  // with the question, the agent and the model — and `resumable: false` is what
  // stops the link promising to continue a conversation that is not there.
  const seed = captureChatSeed({ id: 3, name: "Vitamin D", agent: "science", model: "m", prompt: "Ask me again" });
  assert.equal(seed.resumable, false);
  assert.deepEqual(seed.messages, []);
  assert.equal(seed.prompt, "Ask me again");
});

test("captureChatSeed leaves the tab's agent alone when the capture named none", () => {
  // Null, never the default mode: an unknown agent must not silently move the
  // reader into Deep Science, the same rule stream.js applies to a record with
  // no chatMode.
  assert.equal(captureChatSeed({ id: 1, agent: "science", model: "m", prompt: "p" }).mode, null);
  assert.equal(captureChatSeed({ id: 1, mode: "   ", model: "m", prompt: "p" }).mode, null);
});

test("captureChatSeed survives a round trip through its own output", () => {
  // The client re-normalises what the server sends rather than trusting it, so
  // the seed has to be a fixed point — above all `recorded_at`, which is
  // `created_at` on a row and `recorded_at` on a seed.
  const first = captureChatSeed({
    id: 7, name: "Elpris", mode: "cyber", model: "m", prompt: "p", created_at: 1_699_000_000_000,
    chat: [{ role: "user", content: "p" }],
  });
  const second = captureChatSeed(first, first.messages);
  assert.deepEqual(second, first);
});

test("captureChatUrl links to the app, and only for a real id", () => {
  assert.equal(captureChatUrl({ id: 12 }), "/?capture=12");
  assert.equal(captureChatUrl(12), "/?capture=12");
  for (const bad of [{ id: 0 }, { id: -3 }, { id: null }, {}, null, "abc"]) {
    assert.equal(captureChatUrl(/** @type {any} */ (bad)), "");
  }
});

test("captureChatLink promises only what the capture can deliver", () => {
  const withChat = captureChatLink({ id: 1, has_chat: true });
  const without = captureChatLink({ id: 1, has_chat: false });
  assert.match(withChat.text, /Continue/);
  assert.equal(withChat.resumable, true);
  // "Continue this chat" over an empty history is a promise the app cannot
  // keep, so a clip with no transcript says something smaller and true.
  assert.match(without.text, /again/);
  assert.equal(without.resumable, false);
});

test("captureChatRows drops anything that cannot be opened", () => {
  const rows = captureChatRows({
    captures: [
      { id: 12, tag: "#CAP-12", name: "Elpris", agent: "science", prompt: "p", has_chat: true, created_at: 5 },
      { id: 0, name: "no id" },
      { name: "no id at all" },
      null,
      "junk",
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 12, tag: "#CAP-12", title: "Elpris", agent: "science", prompt: "p",
    url: "/?capture=12", resumable: true, when: 5,
  });
});

test("captureChatRows accepts a bare array as well as the API envelope", () => {
  const row = { id: 4, name: "N", agent: "cyber", prompt: "q", has_chat: false };
  assert.deepEqual(captureChatRows([row]), captureChatRows({ captures: [row] }));
  assert.deepEqual(captureChatRows(null), []);
  assert.deepEqual(captureChatRows({ captures: "nope" }), []);
});
