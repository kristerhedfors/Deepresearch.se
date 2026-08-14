// @ts-check
// Direct web browsing from the Worker — reading the pages a user NAMED in
// their message, as a complement to the search index rather than a
// replacement for it.
//
// Why this exists (feedback #67, chat_logs #1729, 2026-08-13). A question
// arrived carrying five explicit URLs and a per-URL instruction ("check last
// release, supported CUDA versions"; "assess commit recency"). The pipeline
// had no way to READ a URL: every source has to be rediscovered by keyword
// through the search index, so the run spent 15 angles searching for pages it
// had already been handed, and the answer reported that
// `github.com/avtomaton/barracuda` "was not retrieved by any of the angles
// run" — a page the user had pasted in full. The user's words for the fix:
// "there are unanswered questions on github here as well where you should
// have looked up the actual data. If it is the case that exa did not index
// this, then use direkt web browsing from cloudflare as conplement!"
//
// So: when the latest user message names URLs, the Worker fetches them
// itself, before the first search wave, and registers them as ordinary
// sources. Search still runs — this ADDS the pages the user pointed at, it
// never stands the index down.
//
// Privacy (invariant 4). The only thing that leaves the Worker is a GET to
// the URL the user typed, carrying no conversation, no identity and no
// referrer. That is strictly less than the search leg already sends (a query
// derived from the message goes to a third-party index); here the request
// goes to the origin the user chose, which is the same host their browser
// would have contacted had they opened the link themselves.
//
// Fail-soft (invariant 2). Every branch degrades to "fewer sources": a
// refused, slow, oversized, non-HTML or unparseable page is dropped and the
// run continues on the search results alone. Nothing here can error a chat.

import { htmlToText } from "../public/js/arxiv-rag-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./search-sources.js').SearchSourceItem} SearchSourceItem */

// Bounds. Every one of these exists to keep a pasted wall of links from
// turning into an unbounded fan-out on the user's wall clock and the
// Worker's subrequest budget.
export const MAX_NAMED_URLS = 6;
const PER_URL_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 20000;
const MAX_BYTES = 600_000;
const MAX_TEXT_CHARS = 12_000;
const HIGHLIGHT_CHARS = 1200;
const MAX_HIGHLIGHTS = 3;

// A URL written in prose, http(s) only. Trailing punctuation is stripped
// below rather than excluded here, because a URL at the end of a sentence
// legitimately abuts a period, a comma or a closing bracket.
const URL_RE = /https?:\/\/[^\s<>"'`|\\^{}[\]]+/gi;

/**
 * Hosts that are never fetched: the local network and the link-local
 * metadata range. Both are SSRF targets, and neither is ever a citable
 * source — a research answer cannot cite the machine it is running on.
 *
 * Written out rather than regex-anchored because the obvious
 * `/^(127\.|10\.)$/` shape cannot match a full address at all: the `$`
 * demands the prefix BE the hostname. The octet rules are the same ones
 * shodan-text.js applies in isPublicIpv4, for the same reason.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "::1") return true;
  if (/\.(local|internal|localhost|home\.arpa)$/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // this-net, private, loopback, multicast/reserved
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Trailing characters that belong to the sentence, not the URL. Balanced
 * brackets are kept — a Wikipedia URL really can end in ")".
 * @param {string} raw
 * @returns {string}
 */
function trimUrlTail(raw) {
  let u = raw;
  for (;;) {
    const last = u[u.length - 1];
    if (!last) break;
    if (".,;:!?".includes(last)) { u = u.slice(0, -1); continue; }
    if (last === ")" && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === "]" && (u.match(/\[/g) || []).length < (u.match(/\]/g) || []).length) {
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return u;
}

/**
 * The http(s) URLs a message names, deduped, normalized and capped.
 *
 * Deliberately NOT intent-gated: pasting a link IS the ask. The cost of a
 * false positive is one page read that the answer may not cite; the cost of
 * a miss is the failure this module was written for.
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractNamedUrls(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const m of raw.matchAll(URL_RE)) {
    const cleaned = trimUrlTail(m[0]);
    let url;
    try {
      url = new URL(cleaned);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (isPrivateHost(url.hostname)) continue;
    // The fragment is a client-side concern and only splits the dedup key.
    url.hash = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_NAMED_URLS) break;
  }
  return out;
}

/**
 * The page title, preferring <title> and falling back to the first <h1>.
 * A titleless page still needs a label, so the URL's own tail is the last
 * resort — a source with no title renders as a bare number in the answer.
 * @param {string} html
 * @param {string} url
 * @returns {string}
 */
export function titleOf(html, url) {
  const t = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  const fromTitle = t ? htmlToText(t[1]) : "";
  if (fromTitle) return fromTitle.slice(0, 200);
  const h1 = html.match(/<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i);
  const fromH1 = h1 ? htmlToText(h1[1]) : "";
  if (fromH1) return fromH1.slice(0, 200);
  try {
    const u = new URL(url);
    return (u.pathname === "/" ? u.hostname : `${u.hostname}${u.pathname}`).slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

/**
 * Turn a fetched page into the highlight slices a source carries. The
 * registry and the digest both read `highlights`, so the shape has to match
 * what a search result returns rather than being a bespoke blob.
 * @param {string} text
 * @returns {string[]}
 */
export function highlightsOf(text) {
  const body = text.slice(0, MAX_TEXT_CHARS);
  if (!body) return [];
  const out = [];
  for (let i = 0; i < body.length && out.length < MAX_HIGHLIGHTS; i += HIGHLIGHT_CHARS) {
    const slice = body.slice(i, i + HIGHLIGHT_CHARS).trim();
    if (slice) out.push(slice);
  }
  return out;
}

/**
 * Read one URL. Resolves to a source item, or null for every failure mode —
 * the caller cannot tell them apart and must not care (invariant 2).
 * @param {string} url
 * @param {Logger} log
 * @param {AbortSignal} [outerSignal] the whole-phase deadline
 * @returns {Promise<SearchSourceItem | null>}
 */
async function readOne(url, log, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_URL_TIMEOUT_MS);
  const onOuter = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuter);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Identify honestly and ask for documents. No cookies, no referrer,
        // nothing derived from the conversation or the account.
        "user-agent": "DeepResearch.se/1.0 (+https://deepresearch.se; direct page read)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en,sv;q=0.8",
      },
    });
    if (!resp.ok) {
      log.info("named_urls.skipped", { reason: "status", status: resp.status });
      return null;
    }
    const type = resp.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml|application\/json|text\/markdown/i.test(type)) {
      log.info("named_urls.skipped", { reason: "content_type" });
      return null;
    }
    // Read at most MAX_BYTES: a PDF mislabeled as HTML, or a very large page,
    // must not spend the request's whole memory and CPU budget.
    const body = await readCapped(resp, MAX_BYTES);
    if (!body) {
      log.info("named_urls.skipped", { reason: "empty" });
      return null;
    }
    const isHtml = /html|xml/i.test(type);
    const text = isHtml ? htmlToText(body) : body.replace(/\s+/g, " ").trim();
    if (text.length < 80) {
      log.info("named_urls.skipped", { reason: "too_short", chars: text.length });
      return null;
    }
    return {
      url: resp.url || url,
      title: isHtml ? titleOf(body, url) : titleOf("", url),
      highlights: highlightsOf(text),
    };
  } catch (/** @type {any} */ err) {
    // Includes the abort: a slow page is a skipped page, never a failed chat.
    log.info("named_urls.skipped", {
      reason: controller.signal.aborted ? "timeout" : "fetch_failed",
      error: String(err?.message || err).slice(0, 120),
    });
    return null;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuter);
  }
}

/**
 * Read a response body up to a byte ceiling, without buffering more than
 * that. `resp.text()` would happily pull a 200 MB file into the isolate.
 * @param {Response} resp
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readCapped(resp, maxBytes) {
  const reader = resp.body?.getReader();
  if (!reader) return (await resp.text()).slice(0, maxBytes);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf.slice(0, maxBytes));
}

/**
 * Read every URL the message named, concurrently and within one deadline.
 * Returns the pages that came back, in the order the user wrote them, so
 * source numbering follows the message rather than the network.
 * @param {Env} _env unused today; kept so a future per-account policy (a
 *   deny list, a proxy) has a seam that costs no call-site churn
 * @param {Logger} log
 * @param {string[]} urls
 * @returns {Promise<{ items: SearchSourceItem[], durationMs: number, attempted: number }>}
 */
export async function readNamedUrls(_env, log, urls) {
  const startedAt = Date.now();
  const list = (urls || []).slice(0, MAX_NAMED_URLS);
  if (!list.length) return { items: [], durationMs: 0, attempted: 0 };

  const outer = new AbortController();
  const deadline = setTimeout(() => outer.abort(), TOTAL_TIMEOUT_MS);
  let settled;
  try {
    settled = await Promise.all(list.map((u) => readOne(u, log, outer.signal)));
  } finally {
    clearTimeout(deadline);
  }
  const items = settled.filter(Boolean);
  const durationMs = Date.now() - startedAt;
  log.info("named_urls.read", { attempted: list.length, read: items.length, duration_ms: durationMs });
  return { items: /** @type {SearchSourceItem[]} */ (items), durationMs, attempted: list.length };
}
