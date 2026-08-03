// @ts-check
// THE OUTWARD FEED AS THE OUTROSPECTION SESSION'S HISTORY
// (owner directive, 2026-07-26).
//
// Entering the outrospection agent used to show the same empty chat every
// other mode shows, which was backwards: this agent already knows a great
// deal — the whole outward feed — and showed none of it until asked. So a
// blank outrospection session now opens with the feed AS its history: the
// latest entries already in the transcript, older pages loading as you scroll
// back, and the entire feed indexed for retrieval in this browser.
//
// Two different jobs, deliberately answered two different ways:
//
//   THE READER gets the whole list, paged. Scrolling back is how you read a
//   feed, and 400 entries is a lot to scroll — so it pages instead of
//   rendering everything at once.
//   THE MODEL gets a handful of semantically retrieved entries, because the
//   whole feed does not fit in a prompt. Sending "the newest 24" instead
//   would silently truncate the feed to recency and lose the entry from three
//   weeks ago that actually answers the question. That is what the index is
//   for.
//
// The index is BROWSER-LOCAL: public/js/rag.js over IndexedDB, the same store
// attachments and project chats already use, and its excerpts ride out inside
// the outgoing message exactly like document excerpts do. What leaves is the
// question and the excerpts this browser chose (invariant 4's posture,
// unchanged).
//
// It is indexed with `mirror: false`, which is load-bearing rather than
// tidiness. Every other indexed doc mirrors to the server index when cloud
// storage is on, and appendToDoc re-pushes the WHOLE doc on each append — so
// mirroring a feed that grows to hundreds of entries would upload the same
// PUBLIC articles the Worker already stores in D1 back to the server, once per
// user, on every visit. There is nothing to gain and real bandwidth to lose.
//
// Import-safe in Node: every document/IndexedDB access is inside a function
// and guarded, so the pure paging/indexing logic can be unit-tested.

import {
  FEED_PAGE_SIZE,
  FEED_RETRIEVE_K,
  LENS_IDS,
  feedIndexText,
  feedItemIndexText,
  feedPage,
  lensById,
  mergeFeed,
  outwardExcerptBlock,
} from "./outrospect-core.js";
import { appendToDoc, hasDoc, indexDocument, retrieve } from "./rag.js";

/** @typedef {import('./outrospect-core.js').FeedItem} FeedItem */

/** The browser-local RAG document the whole feed is indexed into. */
export const FEED_DOC_ID = "outrospect-feed";
export const FEED_DOC_NAME = "Outward feed";

export const ARTIFACT_URL = "/outrospect/feed.json";
export const FEED_URL = "/api/outrospect/feed";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Both halves of the feed, merged — the committed artifact and the live rows.
 * Each half fails soft on its own, so a missing artifact or an unavailable
 * live half still yields whatever the other has.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<FeedItem[]>} newest first
 */
export async function loadOutwardFeed(fetchImpl = fetch) {
  const grab = async (/** @type {string} */ url) => {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
  const [artifact, live] = await Promise.all([grab(ARTIFACT_URL), grab(FEED_URL)]);
  return mergeFeed([artifact?.items || [], live?.items || []]);
}

// ---------------------------------------------------------------------------
// Indexing — the whole feed, incrementally
// ---------------------------------------------------------------------------

/**
 * Which items are not yet in the local index. The doc is append-only, so this
 * is what keeps a revisit from re-embedding (and re-paying for) 400 entries
 * that have not changed.
 * @param {FeedItem[]} items
 * @param {Iterable<string>} indexedKeys
 * @returns {FeedItem[]}
 */
export function unindexedItems(items, indexedKeys) {
  const seen = new Set(indexedKeys || []);
  return (Array.isArray(items) ? items : []).filter((i) => i?.key && !seen.has(i.key));
}

/** The keys this browser has already indexed (localStorage — a hint, not a source of truth). */
const KEYS_STORE = "dr_outrospect_indexed";

/** @returns {string[]} */
export function readIndexedKeys() {
  try {
    const raw = globalThis.localStorage?.getItem(KEYS_STORE);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** @param {string[]} keys */
export function writeIndexedKeys(keys) {
  try {
    globalThis.localStorage?.setItem(KEYS_STORE, JSON.stringify(keys.slice(-2000)));
  } catch {
    /* storage full or unavailable — we re-index next time, which is only a cost */
  }
}

/**
 * Index the feed into this browser's RAG store, embedding ONLY what is new.
 * Fail-soft in full: embedding needs the network and the /api/embed proxy, and
 * none of this may ever stop the session from opening.
 * @param {FeedItem[]} items
 * @param {{ onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<{ indexed: number, total: number, ok: boolean }>}
 */
export async function indexFeedLocally(items, { onProgress } = {}) {
  const list = Array.isArray(items) ? items : [];
  try {
    const existing = await hasDoc(FEED_DOC_ID).catch(() => false);
    const known = existing ? readIndexedKeys() : [];
    const fresh = unindexedItems(list, known);
    if (!fresh.length) return { indexed: 0, total: list.length, ok: true };

    if (!existing) {
      await indexDocument(FEED_DOC_ID, FEED_DOC_NAME, feedIndexText(fresh), { onProgress, mirror: false });
    } else {
      await appendToDoc(FEED_DOC_ID, FEED_DOC_NAME, feedIndexText(fresh), {
        meta: { kind: "outrospect-feed" },
        // No server mirror: appendToDoc re-pushes the WHOLE doc every time,
        // and this doc is public web content the Worker already holds in D1.
        // Mirroring it would upload the same public feed back to the server
        // once per user per visit, growing, for nothing.
        mirror: false,
      });
    }
    writeIndexedKeys([...known, ...fresh.map((i) => i.key)]);
    return { indexed: fresh.length, total: list.length, ok: true };
  } catch {
    // No index this time: the session still opens and the server's own
    // newest-first retrieval still answers. Degraded, never broken.
    return { indexed: 0, total: list.length, ok: false };
  }
}

/**
 * Retrieve against the browser's feed index and render the block that rides
 * out with the question. "" when there is no index or nothing matched — the
 * server's own retrieval then carries the turn alone.
 * @param {string} question
 * @param {{ k?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function outwardExcerptsFor(question, { k = FEED_RETRIEVE_K } = {}) {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q) return "";
  try {
    if (!(await hasDoc(FEED_DOC_ID))) return "";
    const matches = await retrieve([FEED_DOC_ID], q, k);
    return outwardExcerptBlock(matches, { limit: k });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Rendering the feed as the session's history
// ---------------------------------------------------------------------------

/** @param {string} tag @param {string | null} [cls] @param {string | null} [text] */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * One feed entry as a transcript row. Everything here is third-party text, so
 * it is built with createElement/textContent — nothing goes through innerHTML.
 * @param {FeedItem} item
 * @returns {HTMLElement}
 */
export function renderFeedEntry(item) {
  const row = el("div", "outro-entry" + (item.fresh ? " fresh" : ""));
  const lens = lensById(item.lens);

  const kicker = el("p", "outro-kicker");
  kicker.appendChild(el("span", "outro-lens", lens ? lens.title : item.lens));
  if (item.fresh) kicker.appendChild(el("span", "outro-new", "NEW"));
  row.appendChild(kicker);

  const h = el("p", "outro-head");
  const a = el("a", null, item.title);
  a.setAttribute("href", item.url);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  h.appendChild(a);
  row.appendChild(h);

  if (item.teaser) row.appendChild(el("p", "outro-teaser", item.teaser));
  row.appendChild(el("p", "outro-src", item.source || ""));
  return row;
}

/**
 * Mount the feed as the session's history inside the chat container.
 *
 * Newest at the BOTTOM, like a chat transcript, so the session opens on the
 * latest entry and reading backwards means scrolling up — the direction the
 * gesture already means everywhere else in the app.
 *
 * @param {HTMLElement} chatEl the scrolling chat container
 * @param {FeedItem[]} items newest-first
 * @param {{ pageSize?: number }} [opts]
 * @returns {{ el: HTMLElement, loadOlder: () => number } | null}
 */
export function mountFeedHistory(chatEl, items, { pageSize = FEED_PAGE_SIZE } = {}) {
  if (!chatEl || !Array.isArray(items) || !items.length) return null;

  // The feed IS this session's opening content, so the "ask me anything"
  // placeholder would be a second, contradictory empty state above it.
  chatEl.querySelector(".empty")?.remove();

  const host = el("div", "outro-history");
  const older = el("button", "outro-more");
  older.setAttribute("type", "button");
  const list = el("div", "outro-list");
  host.appendChild(older);
  host.appendChild(list);

  let offset = 0;

  // A page is prepended ABOVE what is already there and the scroll position is
  // pinned to the entry you were reading — otherwise loading older entries
  // yanks the view, which is the classic way infinite-scroll-back feels broken.
  const addPage = () => {
    const { page, more, nextOffset } = feedPage(items, { offset, size: pageSize });
    offset = nextOffset;
    const beforeH = chatEl.scrollHeight;
    const beforeTop = chatEl.scrollTop;
    const frag = document.createDocumentFragment();
    // Newest-first data, oldest-at-top display: reverse this page, and put
    // each older page above the last.
    for (const item of [...page].reverse()) frag.appendChild(renderFeedEntry(item));
    list.insertBefore(frag, list.firstChild);
    older.hidden = !more;
    older.textContent = more ? `Load ${Math.min(pageSize, items.length - offset)} older entries` : "";
    if (beforeH) chatEl.scrollTop = beforeTop + (chatEl.scrollHeight - beforeH);
    return page.length;
  };

  addPage();
  older.addEventListener("click", () => addPage());

  const intro = el("p", "outro-intro");
  // The lens count comes from the registry, never a literal — a lens added
  // there must not leave this line quietly claiming the old number.
  intro.textContent = `The outward feed — ${items.length} entr${items.length === 1 ? "y" : "ies"} from the ${LENS_IDS.length} lenses, indexed in this browser. Ask about any of it.`;
  host.appendChild(intro);

  chatEl.appendChild(host);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { el: host, loadOlder: addPage };
}

/**
 * The whole entry behavior for a blank outrospection session: load, mount as
 * history, and index in the background. Fail-soft — any failure just leaves
 * the normal empty chat.
 * @param {HTMLElement} chatEl
 * @param {{ fetchImpl?: typeof fetch, pageSize?: number }} [opts]
 * @returns {Promise<{ items: FeedItem[], mounted: boolean }>}
 */
export async function openFeedSession(chatEl, { fetchImpl = fetch, pageSize = FEED_PAGE_SIZE } = {}) {
  /** @type {FeedItem[]} */
  let items = [];
  try {
    items = await loadOutwardFeed(fetchImpl);
  } catch {
    items = [];
  }
  const mounted = !!mountFeedHistory(chatEl, items, { pageSize });
  // Indexing is deliberately NOT awaited by the caller's UI path: reading the
  // feed must never wait on embeddings.
  indexFeedLocally(items).catch(() => {});
  return { items, mounted };
}

export { FEED_PAGE_SIZE, FEED_RETRIEVE_K, feedItemIndexText };
