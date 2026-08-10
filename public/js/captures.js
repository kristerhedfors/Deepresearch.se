// @ts-check
// Capture reviews — the swipe deck that DRIVES THE /captures/ PAGE. One
// recorded clip at a time: the video, what produced it, and the facts of the
// edit. Swipe RIGHT to keep it, LEFT to say what is wrong with it.
//
// It used to be one panel section among a dozen on /admin (`#captures-sec`).
// It moved up a level to its own admin-gated page on 2026-08-10 (owner
// directive) because it is a REVIEW tool, not an ops panel: the owner watches
// a recorded research run and files it. The move is a MOVE — the gesture math,
// the fly-out, the feedback field, the filters and the fail-soft fetch posture
// are all unchanged. What went away is the panel plumbing: the section id, the
// `hidden` unhide, the count-badge callback, and the keyboard handler's
// "is this fold open?" guard (there is no fold on a dedicated page).
//
// The left swipe does NOT post. It reveals a feedback field in the card's
// place, because the server REQUIRES a note on a `feedback` verdict — a left
// swipe with no words is a shrug, not a review, and the reviewer would only
// learn that from a 400 they cannot act on. Revealing the field is the
// mechanism that makes the gesture complete, not decoration on top of it.
//
// All the gesture MATH is public/js/captures-core.js (pure, Node-tested);
// this file is DOM + fetch only. Everything here stays fail-soft: a non-admin
// who somehow lands here, a missing endpoint, or a failed POST all end in a
// calm inline message rather than a thrown error or a half-broken deck.

import {
  DECK_FILTERS,
  KEY_VERDICTS,
  NOTE_MAX,
  captureFacts,
  captureTitle,
  cardStyle,
  flingVerdict,
  nextDeck,
  reviewSummary,
  swipeHint,
  swipeVerdict,
  validateNote,
} from "./captures-core.js";

const API = "/api/admin/captures";
/** Where the deck renders, and where the queue count is written. */
const DECK_ID = "captures";
const COUNT_ID = "cap-count";

/**
 * @typedef {{ id: number|string, label?: string, agent?: string, model?: string,
 *   starter?: string, mode?: string, lang?: string, prompt?: string, status?: string,
 *   has_video?: boolean, has_poster?: boolean, video_url?: string, poster_url?: string,
 *   reviews?: any[] }} Capture
 */

/** Module state — one deck at a time; the panel is a singleton. */
const state = {
  /** @type {string} the active filter id ("" = all) */
  filter: "new",
  /** @type {Capture[]} the fetched rows for the active filter */
  rows: [],
  /** @type {Set<string>} ids filed in THIS session (the queue is not re-fetched per swipe) */
  reviewed: new Set(),
  /** @type {number} how many were in the queue when it was fetched — the "N of M" denominator */
  total: 0,
  /** @type {number} unreviewed captures at the last queue fetch. Held separately
   * from the rendered rows because the heading count must keep reporting the
   * REVIEW QUEUE while the owner browses the liked/needs-work filters —
   * zeroing it there would claim there is no work left when there is. */
  queueCount: 0,
  /** @type {boolean} true while a card is flying out / a POST is in flight */
  busy: false,
  /** @type {boolean} true while the feedback field is open (arrow keys must not file) */
  composing: false,
};

// ---- tiny DOM helpers ------------------------------------------------------
// Capture prompts, labels, notes and model ids are attacker-influenceable text
// in principle: they arrive over an API, and the prompt of a published clip is
// content this page did not author. So NOTHING here interpolates capture text
// into innerHTML — every string lands via textContent, which cannot inject
// markup at all. If a future edit does need a template, escape it with
// notifications.js's `escapeHtml`; do not reach for a raw template literal.

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {string} id
 */
function byId(id) {
  return document.getElementById(id);
}

/**
 * Admin JSON fetch. Returns an `__error` envelope on ANY failure (403 for a
 * non-admin, a 503 with no D1, a missing endpoint) — the caller renders a calm
 * message rather than an alarming error, because someone arriving here without
 * the role is not an incident. The route in src/index.js already redirects a
 * non-admin away, so this is the second line: a session that expires with the
 * page open must degrade to a sentence, not to a broken deck.
 *
 * @param {string} path
 * @param {{ method?: string, body?: any }} [opts] body is a plain object, JSON-encoded here
 * @returns {Promise<any|null>}
 */
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      headers: opts.body ? { "content-type": "application/json" } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { __error: data?.error || `HTTP ${res.status}` };
    return data;
  } catch {
    return { __error: "Network error — the review was not saved." };
  }
}

// ---- entry point -----------------------------------------------------------

/**
 * Start the deck on the /captures/ page. Exported (rather than run straight
 * from module scope) so the module can be imported and reasoned about without
 * a DOM, and so the bootstrap below stays one readable line.
 *
 * Never throws: a rendering bug must leave the page's explanation standing
 * rather than replacing it with a broken deck.
 *
 * @returns {Promise<void>}
 */
export async function startCaptures() {
  const box = byId(DECK_ID);
  if (!box) return; // not this page — nothing to do
  try {
    await refresh(box);
  } catch {
    box.textContent = "The review deck could not be loaded.";
    box.className = "muted";
  }
}

// Self-start. `type="module"` scripts are deferred, so by the time this runs
// the document is normally parsed and #captures exists; the readyState check
// covers the one case that isn't (a dynamic import from a still-parsing
// document), because a start that silently found no container would look
// exactly like an empty queue.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { startCaptures(); });
} else {
  startCaptures();
}

/**
 * Fetch the active filter's rows and render.
 *
 * @param {HTMLElement} box
 */
async function refresh(box) {
  const qs = state.filter === "new" ? "queue=1&limit=50" : state.filter ? `status=${encodeURIComponent(state.filter)}&limit=50` : "limit=50";
  const data = await api(`${API}?${qs}`);
  if (!data || data.__error) {
    render(box, data?.__error ? String(data.__error) : null);
    return;
  }
  state.rows = Array.isArray(data.captures) ? data.captures : [];
  render(box, null);
}

// ---- rendering -------------------------------------------------------------

/**
 * @param {HTMLElement} box
 * @param {string|null} error a load error to show instead of the deck
 */
function render(box, error) {
  box.innerHTML = "";
  box.appendChild(filterRow(box));

  if (error) {
    box.appendChild(el("p", "muted", error));
    showCount(state.queueCount);
    return;
  }

  // The review QUEUE is a deck; every other filter is a read-only list, since
  // re-swiping something already filed would just churn the record.
  if (state.filter !== "new") {
    renderList(box);
    return;
  }

  const deck = nextDeck(state.rows, { reviewedIds: state.reviewed });
  state.total = state.rows.length;
  state.queueCount = deck.length;
  showCount(deck.length);

  if (!deck.length) {
    box.appendChild(emptyState());
    return;
  }

  const progress = el("p", "cap-progress muted");
  progress.textContent = `${state.total - deck.length + 1} of ${state.total}`;
  box.appendChild(progress);

  const stack = el("div", "cap-deck");
  // Only the top card is interactive; the two behind it exist to show the deck
  // has depth, which is what tells the reviewer there is more to do without
  // reading the counter.
  deck.slice(0, 3).forEach((c, i) => {
    const card = buildCard(c, i === 0);
    card.style.zIndex = String(10 - i);
    if (i > 0) card.classList.add("cap-card--behind");
    stack.appendChild(card);
  });
  box.appendChild(stack);
  box.appendChild(actionRow(box, deck[0]));
  box.appendChild(el("p", "cap-hintline muted", "Swipe right to keep it, left to send it back — or use ← / → and the buttons."));

  wireDrag(/** @type {HTMLElement} */ (stack.firstElementChild), deck[0], box);
}

/**
 * The filter row — so a clip that was already filed can be found again.
 * @param {HTMLElement} box
 */
function filterRow(box) {
  const row = el("div", "cap-filters");
  for (const f of DECK_FILTERS) {
    const b = el("button", state.filter === f.id ? "cap-filter is-on" : "cap-filter secondary", f.label);
    b.addEventListener("click", async () => {
      state.filter = f.id;
      await refresh(box);
    });
    row.appendChild(b);
  }
  return row;
}

function emptyState() {
  const wrap = el("div", "cap-empty");
  wrap.appendChild(el("p", "", "No captures waiting."));
  const p = el("p", "muted");
  p.append("Record some with ");
  p.appendChild(el("code", "", "npm run capture"));
  p.append(", edit them with ");
  p.appendChild(el("code", "", "npm run capture:edit"));
  p.append(", then publish with ");
  p.appendChild(el("code", "", "scripts/captures --upload"));
  p.append(".");
  wrap.appendChild(p);
  return wrap;
}

/**
 * One capture card.
 *
 * @param {Capture} c
 * @param {boolean} top whether this is the interactive top card
 */
function buildCard(c, top) {
  const card = el("div", top ? "cap-card cap-card--top" : "cap-card");
  card.dataset.id = String(c.id);

  // The two drag overlays. They fade in with the gesture, which is what makes
  // the swipe discoverable — otherwise the first-time reviewer has to guess
  // which direction means what, and guessing wrong files a keeper.
  card.appendChild(el("div", "cap-hint like", "👍 Like"));
  card.appendChild(el("div", "cap-hint feedback", "✍️ Feedback"));

  if (c.has_video !== false && c.video_url) {
    const v = document.createElement("video");
    v.src = String(c.video_url);
    if (c.has_poster && c.poster_url) v.poster = String(c.poster_url);
    v.controls = true;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    // metadata only: a deck of 50 clips must not pull 50 MP4s on panel open.
    v.preload = "metadata";
    card.appendChild(v);
  } else {
    card.appendChild(el("p", "muted", "No video uploaded for this capture yet."));
  }

  const body = el("div", "cap-body");
  body.appendChild(el("h3", "cap-title", captureTitle(c)));

  const chips = el("div", "cap-chips");
  for (const [k, v] of [["agent", c.agent], ["model", c.model], ["starter", c.starter], ["lang", c.lang]]) {
    if (typeof v === "string" && v.trim()) chips.appendChild(el("span", "badge", `${k}: ${v.trim()}`));
  }
  if (chips.childElementCount) body.appendChild(chips);

  if (typeof c.prompt === "string" && c.prompt.trim()) {
    body.appendChild(el("p", "cap-prompt", c.prompt.trim()));
  }

  const facts = captureFacts(c);
  if (facts.length) body.appendChild(el("p", "cap-facts muted", facts.join(" · ")));

  const summary = reviewSummary(c);
  if (summary) body.appendChild(el("p", "cap-review", summary));

  card.appendChild(body);
  return card;
}

/**
 * The explicit buttons — a gesture must never be the ONLY way to act.
 * @param {HTMLElement} box
 * @param {Capture} capture
 */
function actionRow(box, capture) {
  const row = el("div", "cap-actions");
  const like = el("button", "cap-act-like", "👍 Like");
  like.addEventListener("click", () => file("like", capture, box));
  const fb = el("button", "cap-act-feedback secondary", "✍️ Feedback");
  fb.addEventListener("click", () => file("feedback", capture, box));
  row.appendChild(like);
  row.appendChild(fb);
  const err = el("p", "cap-err err");
  err.hidden = true;
  row.appendChild(err);
  return row;
}

/**
 * Read-only rendering for the liked / needs-work / all filters.
 * @param {HTMLElement} box
 */
function renderList(box) {
  if (!state.rows.length) {
    box.appendChild(el("p", "muted", "Nothing here."));
    showCount(state.queueCount);
    return;
  }
  const list = el("div", "cap-list");
  for (const c of state.rows) {
    const row = el("div", "rowitem cap-row");
    const head = el("div", "head");
    head.appendChild(el("b", "", captureTitle(c)));
    if (typeof c.status === "string") head.appendChild(el("span", `badge ${c.status === "liked" ? "shipped" : ""}`.trim(), c.status));
    head.appendChild(el("span", "spacer"));
    row.appendChild(head);
    const facts = captureFacts(c);
    if (facts.length) row.appendChild(el("p", "cap-facts muted", facts.join(" · ")));
    const summary = reviewSummary(c);
    if (summary) row.appendChild(el("p", "cap-review", summary));
    if (c.video_url) {
      const a = el("a", "cap-link", "Open the clip");
      /** @type {HTMLAnchorElement} */ (a).href = String(c.video_url);
      /** @type {HTMLAnchorElement} */ (a).target = "_blank";
      /** @type {HTMLAnchorElement} */ (a).rel = "noopener";
      row.appendChild(a);
    }
    list.appendChild(row);
  }
  box.appendChild(list);
  // The count always reports the REVIEW QUEUE, never the filtered list — a
  // heading reading "12" while the owner browses likes would be reporting the
  // wrong number entirely.
  showCount(state.queueCount);
}

/**
 * Write the queue count into the page heading. This is what replaced the admin
 * panel's collapsed-header badge: on a dedicated page nothing is folded, so
 * the number lives in the heading instead of in a callback the host page owns.
 * Zero renders as empty, which the stylesheet hides (`h2 .count:empty`) — a
 * blank pill saying "0" is worse than no pill.
 *
 * @param {number} n
 */
function showCount(n) {
  const badge = byId(COUNT_ID);
  if (badge) badge.textContent = n > 0 ? String(n) : "";
}

/**
 * @param {HTMLElement} box
 * @param {string} msg
 */
function showError(box, msg) {
  const err = box.querySelector(".cap-err");
  if (!(err instanceof HTMLElement)) return;
  err.textContent = msg;
  err.hidden = false;
}

// ---- the drag gesture ------------------------------------------------------

/**
 * Wire pointer dragging on the top card. setPointerCapture keeps the events
 * coming even when the thumb leaves the card mid-swipe — without it a fast
 * swipe drops its own pointerup and the card sticks half off the deck.
 *
 * @param {HTMLElement|null} card
 * @param {Capture} capture
 * @param {HTMLElement} box
 */
function wireDrag(card, capture, box) {
  if (!card) return;
  /** @type {{ id:number, x:number, y:number, t:number, moving:boolean }|null} */
  let drag = null;

  card.addEventListener("pointerdown", (e) => {
    if (state.busy || state.composing) return;
    // The <video> owns its own controls (play, scrub, fullscreen). Starting a
    // drag from them would make the clip unwatchable — every scrub attempt
    // would file the capture.
    if (e.target instanceof Element && e.target.closest("video, button, a")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moving: false };
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moving) {
      // A few px of slop before the card starts moving, so a tap that wobbles
      // does not visibly shove the deck.
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      drag.moving = true;
      card.classList.add("cap-card--dragging");
    }
    const s = cardStyle(dx, dy, card.offsetWidth);
    card.style.transform = s.transform;
    card.style.opacity = String(s.opacity);
    const hint = swipeHint(dx, dy, card.offsetWidth);
    paintHint(card, hint);
  });

  /** @param {PointerEvent} e */
  const finish = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    card.releasePointerCapture?.(e.pointerId);
    card.classList.remove("cap-card--dragging");
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // Fling first (a phone user flicks), then the settled distance rule.
    const verdict = d.moving ? flingVerdict(dx, dy, card.offsetWidth, Date.now() - d.t) || swipeVerdict(dx, dy, card.offsetWidth) : null;
    paintHint(card, { side: null, progress: 0 });
    if (!verdict) {
      springBack(card);
      return;
    }
    file(verdict, capture, box, card);
  };
  card.addEventListener("pointerup", finish);
  // pointercancel fires when the browser takes the gesture over (a scroll
  // handoff, a system gesture). Treated as "no verdict" — an interrupted
  // gesture must never file a clip.
  card.addEventListener("pointercancel", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    drag = null;
    card.classList.remove("cap-card--dragging");
    paintHint(card, { side: null, progress: 0 });
    springBack(card);
  });
}

/**
 * @param {HTMLElement} card
 * @param {{side: string|null, progress: number}} hint
 */
function paintHint(card, hint) {
  const like = card.querySelector(".cap-hint.like");
  const fb = card.querySelector(".cap-hint.feedback");
  if (like instanceof HTMLElement) like.style.opacity = hint.side === "like" ? String(hint.progress) : "0";
  if (fb instanceof HTMLElement) fb.style.opacity = hint.side === "feedback" ? String(hint.progress) : "0";
}

/**
 * Return an uncommitted card to rest.
 * @param {HTMLElement} card
 */
function springBack(card) {
  card.classList.add("cap-card--spring");
  card.style.transform = "";
  card.style.opacity = "";
  setTimeout(() => card.classList.remove("cap-card--spring"), 300);
}

// ---- filing a verdict ------------------------------------------------------

/**
 * Act on a verdict, from a swipe, a button or an arrow key — one path, so the
 * three input methods can never diverge.
 *
 * @param {"like"|"feedback"} verdict
 * @param {Capture} capture
 * @param {HTMLElement} box
 * @param {HTMLElement} [card]
 */
async function file(verdict, capture, box, card) {
  if (state.busy || state.composing || !capture) return;
  const top = card || /** @type {HTMLElement|null} */ (box.querySelector(".cap-card--top")) || undefined;

  if (verdict === "feedback") {
    // NOTHING is posted yet. The card flies out left and the feedback field
    // takes its place; the server requires a note, so the note is the gesture's
    // second half rather than an optional extra.
    state.composing = true;
    if (top) flyOut(top, "left");
    openFeedback(capture, box, top);
    return;
  }

  state.busy = true;
  if (top) flyOut(top, "right");
  const res = await api(`${API}/${encodeURIComponent(String(capture.id))}/review`, {
    method: "POST",
    body: { verdict: "like" },
  });
  state.busy = false;
  if (!res || res.__error) {
    // The verdict is NOT silently dropped: the card comes back and says why.
    if (top) {
      top.classList.remove("cap-card--out-right");
      springBack(top);
    }
    showError(box, res?.__error ? String(res.__error) : "The like was not saved.");
    return;
  }
  advance(capture, box);
}

/**
 * @param {HTMLElement} card
 * @param {"left"|"right"} dir
 */
function flyOut(card, dir) {
  card.classList.add(dir === "left" ? "cap-card--out-left" : "cap-card--out-right");
}

/**
 * The FEEDBACK FIELD — revealed in the card's place by a left swipe.
 * Carries the capture's title above it so the reviewer knows what they are
 * writing about (the card itself has just flown off screen).
 *
 * @param {Capture} capture
 * @param {HTMLElement} box
 * @param {HTMLElement} [card]
 */
function openFeedback(capture, box, card) {
  const deck = box.querySelector(".cap-deck");
  if (!(deck instanceof HTMLElement)) {
    state.composing = false;
    return;
  }
  const form = el("div", "cap-feedback");
  form.appendChild(el("p", "cap-feedback-lead muted", "What is wrong with this clip?"));
  form.appendChild(el("h4", "cap-feedback-title", captureTitle(capture)));

  const ta = document.createElement("textarea");
  ta.className = "cap-feedback-note";
  ta.rows = 4;
  ta.maxLength = NOTE_MAX;
  ta.placeholder = "e.g. the cut swallows the first search round — re-run with --min-still 2500";
  form.appendChild(ta);

  const err = el("p", "cap-feedback-err err");
  err.hidden = true;
  form.appendChild(err);

  const row = el("div", "cap-feedback-actions");
  const send = el("button", "", "Send feedback");
  const cancel = el("button", "secondary", "Cancel");
  row.appendChild(send);
  row.appendChild(cancel);
  form.appendChild(row);
  deck.appendChild(form);
  ta.focus();

  const close = () => {
    state.composing = false;
    form.remove();
  };

  cancel.addEventListener("click", () => {
    close();
    // Cancel returns the card to the deck rather than filing it — a left
    // swipe the reviewer thought better of must cost nothing.
    if (card) {
      card.classList.remove("cap-card--out-left");
      springBack(card);
    }
  });

  send.addEventListener("click", async () => {
    const v = validateNote(ta.value);
    if (!v.ok) {
      err.textContent = String(v.error);
      err.hidden = false;
      ta.focus();
      return;
    }
    err.hidden = true;
    send.setAttribute("disabled", "disabled");
    const res = await api(`${API}/${encodeURIComponent(String(capture.id))}/review`, {
      method: "POST",
      body: { verdict: "feedback", note: v.note },
    });
    send.removeAttribute("disabled");
    if (!res || res.__error) {
      // The typed note stays in the box — losing someone's written feedback to
      // a transient network error is the one unforgivable failure here.
      err.textContent = String(res?.__error || "The feedback was not saved — try again.");
      err.hidden = false;
      return;
    }
    close();
    advance(capture, box);
  });
}

/**
 * Mark a capture filed and re-render the deck at the next card.
 *
 * @param {Capture} capture
 * @param {HTMLElement} box
 */
function advance(capture, box) {
  state.reviewed.add(String(capture.id));
  render(box, null);
}

// ---- keyboard --------------------------------------------------------------
// Bound once at the document, active whenever the deck has a top card.
//
// The panel version also required its <section> to be OPEN, because the module
// was loaded on /admin whether or not the owner had that fold expanded — an
// arrow key pressed while editing a quota in another panel would otherwise
// have filed a capture behind their back. On a dedicated page there is no
// fold and nothing else on screen to be typing into, so that guard went with
// the panel. The two guards that carry real weight STAY:
//
//   1. no modifier keys — ⌘←/Alt← are browser navigation, never a verdict;
//   2. never steal an arrow key while focus is in a text field — the feedback
//      textarea is right there, and left/right move a text cursor.
//
// `state.composing` covers the same textarea a third way (nothing files while
// the feedback field is open at all), and the missing top card covers the
// read-only filters.

document.addEventListener("keydown", (e) => {
  const verdict = KEY_VERDICTS[e.key];
  if (!verdict) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (state.busy || state.composing) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const box = byId(DECK_ID);
  const card = box?.querySelector(".cap-card--top");
  if (!(box instanceof HTMLElement) || !(card instanceof HTMLElement)) return;
  const capture = nextDeck(state.rows, { reviewedIds: state.reviewed })[0];
  if (!capture) return;
  e.preventDefault();
  file(verdict, capture, box, card);
});
