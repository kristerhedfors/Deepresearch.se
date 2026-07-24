// @ts-check
// The OUTROSPECTION view — the agent's outward-looking control surface.
//
// Introspection has a window into this site's own source. This is the window
// the other way: a tabloid-shaped feed of what everyone ELSE is building,
// filed under the seven standing questions in public/js/outrospect-core.js.
// You are meant to skim it the way you skim a front page — kicker, headline,
// one line — and stop only where something bears on what this project should
// do next.
//
// Three things happen here, in this order:
//
//   1. RENDER   the merge of the committed artifact (/outrospect/feed.json,
//               written by scripts/outrospect-scan.mjs) and the live rows
//               (GET /api/outrospect/feed). mergeFeed does the dedup and the
//               fresh-flagging; this module only paints the result.
//   2. LOOK     one lens is refreshed ON THE VISITOR'S BEHALF the moment the
//               page settles (POST /api/outrospect/refresh) — the server picks
//               whichever lens has gone stalest, so the feed heals its thin
//               spots by being read. Anything genuinely new streams in at the
//               top with the NEW flash, without a reload.
//   3. ANSWER   the shortcut back: a note written here is not a bug report, it
//               is an operative/strategic idea, and it is submitted as one —
//               feedback-core's `strategy` scope, tagged with the lens it was
//               written under (strategyPageTag). The development loop reads it
//               as direction rather than triaging it as a defect.
//
// Rendering discipline: every item's title, teaser, and source come from the
// open web through a search provider. NOTHING here goes through innerHTML —
// the whole feed is built with createElement/textContent, so a headline
// containing markup is a headline containing markup, not script. (The app's
// chat surface has DOMPurify for the places that must render rich text; a feed
// of headlines never needs to, so it doesn't.)
//
// Import-safe in Node (unit-tested without a DOM): the pure helpers below
// carry the logic worth testing, and every document access is inside the
// mount path.

import {
  OUTROSPECT_LENSES,
  lensById,
  lensMatch,
  lensTally,
  mergeFeed,
  normalizeLens,
} from "./outrospect-core.js";
import { strategyPageTag } from "./feedback-core.js";

/** @typedef {import('./outrospect-core.js').FeedItem} FeedItem */

export const ARTIFACT_URL = "/outrospect/feed.json";
export const FEED_URL = "/api/outrospect/feed";
export const REFRESH_URL = "/api/outrospect/refresh";
export const FEEDBACK_URL = "/api/feedback";

/** How long after load the on-your-behalf refresh fires. */
export const AUTO_REFRESH_DELAY_MS = 900;

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in public/js/outrospect-view.test.js
// ---------------------------------------------------------------------------

/**
 * A human "when" for a feed item, tabloid-brief: today reads as a time, this
 * week as a weekday, older as a date. Never "3 days ago" arithmetic the reader
 * has to convert back.
 * @param {number} ts
 * @param {number} [now]
 * @returns {string}
 */
export function whenLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const age = now - ts;
  if (age < 12 * 3600 * 1000) return d.toISOString().slice(11, 16) + " UTC";
  if (age < 6 * 24 * 3600 * 1000) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return d.toISOString().slice(0, 10);
}

/**
 * The line under the lens strip: what this visit's refresh actually did. The
 * feed is a shared resource on a cooldown, so "nothing new" and "someone just
 * looked" are DIFFERENT outcomes and both are stated — a silent no-op reads as
 * a broken button.
 * @param {{ lens?: string | null, fresh?: unknown[], cooled?: boolean, limited?: boolean, degraded?: boolean, error?: string }} res
 * @returns {string}
 */
export function refreshStatusLine(res) {
  if (!res || res.error) return res?.error || "The outward search could not run just now.";
  if (res.limited) return "Enough refreshes for this hour — the feed keeps updating on its own.";
  const lens = res.lens ? lensById(res.lens)?.title || res.lens : null;
  if (res.cooled) {
    return lens
      ? `“${lens}” was searched moments ago — showing those results rather than paying for them twice.`
      : "Every lens was searched moments ago — showing those results rather than paying for them twice.";
  }
  const n = Array.isArray(res.fresh) ? res.fresh.length : 0;
  if (res.degraded) return `Searched “${lens}” — the search backend did not answer. Nothing lost; try again shortly.`;
  if (!n) return `Searched “${lens}” on your behalf — nothing out there we did not already have.`;
  return `Searched “${lens}” on your behalf — ${n} new item${n === 1 ? "" : "s"}, marked NEW below.`;
}

/**
 * The keys the client already holds, for the refresh's delta. Capped, newest
 * first, so the request stays small on a long-lived feed.
 * @param {FeedItem[]} items
 * @param {number} [max]
 * @returns {string[]}
 */
export function knownKeys(items, max = 400) {
  return (Array.isArray(items) ? items : []).slice(0, max).map((i) => i.key).filter(Boolean);
}

/**
 * The lens a strategic note should be filed under: the lens the reader is
 * FILTERED to, and failing that whatever the note itself is about (lensMatch,
 * EN+SV). Null when neither says anything — better unfiled than misfiled.
 * @param {string | null} activeLens
 * @param {string} noteText
 * @returns {string | null}
 */
export function noteLens(activeLens, noteText) {
  if (activeLens && lensById(activeLens)) return activeLens;
  return lensMatch(noteText);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** @param {string} tag @param {string | null} [cls] @param {string | null} [text] */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * One item, as a front-page block: kicker (the lens), headline (the link),
 * teaser, and the byline strip.
 * @param {FeedItem} item
 * @returns {HTMLElement}
 */
export function renderItem(item) {
  const art = el("article", "item" + (item.fresh ? " fresh" : ""));
  const lens = lensById(item.lens);

  const kicker = el("p", "kicker");
  kicker.appendChild(el("span", "lens", lens ? lens.title : item.lens));
  if (item.fresh) kicker.appendChild(el("span", "flash", "NEW"));
  art.appendChild(kicker);

  const h = el("h3", "headline");
  const a = el("a", null, item.title);
  a.setAttribute("href", item.url);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  h.appendChild(a);
  art.appendChild(h);

  if (item.teaser) art.appendChild(el("p", "teaser", item.teaser));

  const by = el("p", "byline");
  by.appendChild(el("span", "src", item.source || ""));
  by.appendChild(el("span", "sep", "·"));
  by.appendChild(el("span", "when", whenLabel(item.first_seen)));
  art.appendChild(by);
  return art;
}

/**
 * The lens strip: one chip per standing question, each showing its count and
 * its fresh count, each a filter. "All" leads.
 * @param {FeedItem[]} items
 * @param {string | null} active
 * @param {(lens: string | null) => void} onPick
 * @returns {HTMLElement}
 */
export function renderLensStrip(items, active, onPick) {
  const tally = lensTally(items);
  const strip = el("div", "lenses");
  /** @param {string | null} id @param {string} label @param {number} count @param {number} fresh */
  const chip = (id, label, count, fresh) => {
    const b = el("button", "chip" + (active === id ? " on" : ""));
    b.setAttribute("type", "button");
    b.appendChild(el("span", "chip-label", label));
    b.appendChild(el("span", "chip-n", String(count)));
    if (fresh) b.appendChild(el("span", "chip-new", `+${fresh}`));
    b.addEventListener("click", () => onPick(id));
    return b;
  };
  strip.appendChild(
    chip(null, "Everything", items.length, items.filter((i) => i.fresh).length),
  );
  for (const lens of OUTROSPECT_LENSES) {
    const t = tally[lens.id];
    strip.appendChild(chip(lens.id, lens.title, t.total, t.fresh));
  }
  return strip;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Both halves of the feed, merged. Each half fails soft on its own: the
 * committed artifact missing leaves the live rows, the API 401ing (signed out)
 * leaves the artifact, and both failing leaves an empty feed with an honest
 * empty state rather than an error page.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ items: FeedItem[], live: boolean }>}
 */
export async function loadFeed(fetchImpl = fetch) {
  /** @param {string} url */
  const grab = async (url) => {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
  const [artifact, live] = await Promise.all([grab(ARTIFACT_URL), grab(FEED_URL)]);
  return {
    items: mergeFeed([artifact?.items || [], live?.items || []]),
    live: !!live?.live,
  };
}

/**
 * Ask the server to go look, on this visitor's behalf.
 * @param {{ lens?: string | null, known?: string[] }} opts
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<any>}
 */
export async function requestRefresh({ lens = null, known = [] } = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lens: lens || "auto", known }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ...json, error: json.error || `Refresh failed (${res.status}).` };
    return json;
  } catch {
    return { error: "The outward search could not be reached." };
  }
}

/**
 * Submit a strategic idea. This is the shortcut the whole view exists to feed:
 * the note goes to the ordinary feedback queue, but tagged with the `strategy`
 * scope and the lens it was written under, so the development loop reads it as
 * direction for the project rather than a defect to reproduce.
 * @param {{ comment: string, lens: string | null }} note
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function submitStrategyNote({ comment, lens }, fetchImpl = fetch) {
  const text = String(comment || "").trim();
  if (!text) return { ok: false, error: "Write something first." };
  try {
    const res = await fetchImpl(FEEDBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        comment: text,
        page: strategyPageTag(lens),
        question: lens ? lensById(lens)?.question || null : null,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j.error || `Could not send (${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the site to send that." };
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Wire the page. Everything below this line touches the DOM; everything above
 * is testable without one.
 * @param {{ root?: Document }} [opts]
 */
export function mount({ root = document } = {}) {
  const feedRoot = root.getElementById("feed");
  const stripRoot = root.getElementById("lensstrip");
  const statusEl = root.getElementById("status");
  const questionEl = root.getElementById("lensquestion");
  const lookBtn = /** @type {HTMLButtonElement | null} */ (root.getElementById("lookbtn"));
  const noteBox = /** @type {HTMLTextAreaElement | null} */ (root.getElementById("note"));
  const noteBtn = root.getElementById("notebtn");
  const noteStatus = root.getElementById("notestatus");
  if (!feedRoot || !stripRoot) return;
  const feedEl = feedRoot;
  const stripEl = stripRoot;

  /** @type {FeedItem[]} */
  let items = [];
  /** @type {string | null} */
  let active = null;

  /** @param {string} text */
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  function paint() {
    const shown = active ? items.filter((i) => i.lens === active) : items;
    stripEl.replaceChildren(
      renderLensStrip(items, active, /** @param {string | null} lens */ (lens) => {
        active = active === lens ? null : lens;
        paint();
      }),
    );
    if (questionEl) {
      const lens = active ? lensById(active) : null;
      questionEl.textContent = lens
        ? lens.question
        : "Everything out there that bears on what this project should become.";
    }
    feedEl.replaceChildren();
    if (!shown.length) {
      const empty = el("p", "empty");
      empty.textContent = items.length
        ? "Nothing under this lens yet — press “Look outward now”."
        : "The feed is empty. Press “Look outward now” and it will start filling; a scan (npm run outrospect) fills it in bulk.";
      feedEl.appendChild(empty);
      return;
    }
    for (const item of shown) feedEl.appendChild(renderItem(item));
  }

  /** @param {string | null} lens */
  async function look(lens) {
    if (lookBtn) /** @type {HTMLButtonElement} */ (lookBtn).disabled = true;
    setStatus("Looking outward…");
    const res = await requestRefresh({ lens, known: knownKeys(items) });
    setStatus(refreshStatusLine(res));
    if (Array.isArray(res.fresh) && res.fresh.length) {
      items = mergeFeed([items, res.fresh]);
      paint();
    }
    if (lookBtn) /** @type {HTMLButtonElement} */ (lookBtn).disabled = false;
  }

  lookBtn?.addEventListener("click", () => look(active));

  noteBtn?.addEventListener("click", async () => {
    if (!noteBox) return;
    const lens = noteLens(active, noteBox.value);
    if (noteStatus) noteStatus.textContent = "Sending…";
    const res = await submitStrategyNote({ comment: noteBox.value, lens });
    if (noteStatus) {
      noteStatus.textContent = res.ok
        ? `Sent as a strategic note${lens ? ` under “${lensById(lens)?.title}”` : ""}. Any reply appears under Feedback in your account panel.`
        : res.error || "Could not send that.";
    }
    if (res.ok) noteBox.value = "";
  });

  (async () => {
    const loaded = await loadFeed();
    items = loaded.items;
    paint();
    setStatus(
      loaded.live
        ? `${items.length} item${items.length === 1 ? "" : "s"} on file.`
        : `${items.length} item${items.length === 1 ? "" : "s"} on file — the live half is unavailable, showing the committed scan only.`,
    );
    // The look-on-your-behalf pass. Deliberately after the first paint, so the
    // page is readable immediately and the search is something that happens
    // TO an already-useful page rather than something it waits on.
    if (loaded.live) setTimeout(() => look(null), AUTO_REFRESH_DELAY_MS);
  })();
}

// Auto-mount when served as the page's module (never in Node/tests).
if (typeof document !== "undefined" && document.getElementById("feed")) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mount());
  else mount();
}

export { normalizeLens };
