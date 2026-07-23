// @ts-check
// Sanitized markdown rendering, wrapping the vendored globals `marked` and
// `DOMPurify` (loaded as classic scripts before the app module). Falls back
// to plain text if either is missing.

/**
 * Repairs a class of malformed markdown some answer models emit — GLM-4.7 in
 * particular streamed a whole GFM table with its rows JOINED by "||" and no
 * blank line before it, so CommonMark rendered it as literal "| … |" text
 * instead of a table (the reported bug). This normalizes ONLY tables and is
 * a no-op on well-formed markdown (and on text with no table at all), so it's
 * safe to run on every render. Pure (no DOM) — unit-tested in Node.
 * @param {string} text
 * @returns {string}
 */
export function normalizeLlmMarkdown(text) {
  if (typeof text !== "string" || !text) return text;
  // Anchor on a GFM separator row (|---|---|): without one there's no table
  // to repair, so leave the text completely untouched.
  if (!/\|\s*:?-{2,}:?\s*\|/.test(text)) return text;

  // (a) A whole table emitted on one line, rows joined by "||": split each
  //     row onto its own line. "||" is not meaningful in prose, and we've
  //     already confirmed a table is present, so this is safe.
  const out = text.replace(/\|\|/g, "|\n|");

  // (b) Line pass: break a table header glued to the end of the preceding
  //     paragraph, and guarantee a blank line before the table — CommonMark
  //     only starts a table block when one precedes it.
  const isSep = (/** @type {string} */ l) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);
  const isRow = (/** @type {string} */ l) => /^\s*\|.*\|\s*$/.test(l);
  const lines = out.split("\n");
  /** @type {string[]} */
  const result = [];
  const pushBlankBefore = () => {
    if (result.length && result[result.length - 1].trim() !== "") result.push("");
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const nextIsSep = i + 1 < lines.length && isSep(lines[i + 1]);
    if (nextIsSep && !isRow(l)) {
      // Prose then a header row on the same line ("…text| a | b |"): split.
      const m = l.match(/^(.*?\S)\s*(\|(?:[^|\n]*\|)+)\s*$/);
      if (m) {
        result.push(m[1], "", m[2]);
        continue;
      }
    }
    if (nextIsSep && isRow(l)) pushBlankBefore(); // clean header, ensure blank line before
    result.push(l);
  }
  return result.join("\n");
}

// The ONLY image sources an answer may render inline: this site's OWN static
// documentation images (fixed same-origin prefixes, no query/traversal —
// they're plain static assets). Everything else stays forbidden below. Exists
// for HELP mode: an answer quoting the documentation verbatim reproduces its
// `![caption](/introspect/docs-img/…)` lines and the chat shows the real
// screenshots. Same-origin static files can't track or exfiltrate anything.
const SAFE_IMG_PREFIXES = ["/introspect/docs-img/", "/help/img/"];

/** @param {string} src @returns {boolean} */
export function isSafeDocImage(src) {
  const s = String(src || "");
  return SAFE_IMG_PREFIXES.some((p) => s.startsWith(p)) && !s.includes("..") && !s.includes("//");
}

// Monotonic per-render id scope so citation anchors across multiple answers
// never collide on the same document id (see linkifyCitations).
let citeIdSeq = 0;

/**
 * Splits a run of text into segments, flagging each inline `[n]` citation
 * whose number is a known source. Pure (no DOM) so it's unit-testable; the
 * DOM wiring in `linkifyCitations` uses it to decide which text runs become
 * clickable footer anchors. A `[n]` whose number ISN'T in `valid` is left as
 * plain text — not every bracketed number is a citation, and the answer only
 * ever cites sources that exist in its own "Sources:" list.
 * @param {string} text
 * @param {Set<number>} valid the source numbers that actually have a footer entry
 * @returns {Array<{ text: string, ref: number|null }>} in order; ref!=null marks a citation
 */
export function citationSegments(text, valid) {
  /** @type {Array<{ text: string, ref: number|null }>} */
  const segs = [];
  if (typeof text !== "string" || !text || !valid || !valid.size) {
    return text ? [{ text, ref: null }] : [];
  }
  const re = /\[(\d{1,3})\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (!valid.has(n)) continue; // leave unknown brackets as ordinary text
    if (m.index > last) segs.push({ text: text.slice(last, m.index), ref: null });
    segs.push({ text: m[0], ref: n });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), ref: null });
  return segs.length ? segs : [{ text, ref: null }];
}

/**
 * Makes the inline `[n]` citations in a rendered answer clickable so they jump
 * to the matching entry in the closing "Sources:" list, where the URL is
 * written out and live. Operates on the already-sanitized DOM: it finds the
 * numbered source list items (`<li>` whose text starts with `[n]`), gives each
 * an id, then rewrites every plain-text `[n]` in the body into an anchor to it.
 * A no-op when there's no numbered sources list (partial streams, plain chat).
 * @param {HTMLElement} el
 */
export function linkifyCitations(el) {
  const doc = el.ownerDocument;
  if (!doc) return;
  // Ids must be unique DOCUMENT-wide: several answers each carry a "[1]" source,
  // and getElementById returns the first match — so scope every render's ids
  // with a fresh counter to keep a citation pointing at its OWN footer entry.
  const scope = `c${(citeIdSeq += 1)}`;
  // 1. Register the footer source entries. A source item is a list item whose
  //    text begins with "[n]" — that's exactly the "- [n] Title — URL" shape
  //    the synthesis prompt emits.
  /** @type {Set<number>} */
  const valid = new Set();
  /** @type {Map<number, string>} */
  const refIds = new Map();
  for (const li of el.querySelectorAll("li")) {
    const m = /^\s*\[(\d{1,3})\]/.exec(li.textContent || "");
    if (!m) continue;
    const n = Number(m[1]);
    if (valid.has(n)) continue; // first definition wins
    valid.add(n);
    li.classList.add("source-ref-item");
    li.id = `${scope}-source-${n}`;
    refIds.set(n, li.id);
  }
  if (!valid.size) return;

  // 2. Collect the body text nodes to rewrite (snapshot first — we mutate the
  //    tree as we go). Skip anything already inside a link, and skip the source
  //    definitions themselves (their leading [n] is a label, not a citation).
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    const parent = /** @type {Element|null} */ (node.parentElement);
    if (!parent || parent.closest("a, .source-ref-item")) continue;
    if (!/\[\d{1,3}\]/.test(node.nodeValue || "")) continue;
    targets.push(/** @type {Text} */ (node));
  }

  for (const textNode of targets) {
    const segs = citationSegments(textNode.nodeValue || "", valid);
    if (!segs.some((s) => s.ref != null)) continue;
    const frag = doc.createDocumentFragment();
    for (const s of segs) {
      if (s.ref == null) {
        frag.appendChild(doc.createTextNode(s.text));
        continue;
      }
      const targetId = refIds.get(s.ref) || "";
      const a = doc.createElement("a");
      a.className = "cite-ref";
      a.href = "#" + targetId;
      a.textContent = s.text;
      a.setAttribute("aria-label", `Jump to source ${s.ref}`);
      // Same-page jump: scroll the footer entry into view and flash it, without
      // touching location.hash (the SPA uses hash routing for other things).
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const dest = doc.getElementById(targetId);
        if (!dest) return;
        dest.scrollIntoView({ behavior: "smooth", block: "center" });
        dest.classList.remove("cite-target-flash");
        void /** @type {HTMLElement} */ (dest).offsetWidth; // reflow to restart the flash
        dest.classList.add("cite-target-flash");
      });
      frag.appendChild(a);
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

// ---- Mermaid diagrams -------------------------------------------------------
// A ```mermaid fence in an answer renders as a real flow diagram. The vendored
// library (/vendor/mermaid.min.js, ~3.4 MB) is loaded ONLY when a rendered
// answer actually contains a complete mermaid block — ordinary chats never pay
// for it. Rendering is fail-soft end to end: a load failure, an invalid
// diagram, or a half-streamed block just leaves the fenced code visible as
// ordinary code, never breaks the answer.

/** @type {Promise<any>|null} */
let mermaidLoad = null; // one lazy script load per page
let mmdSeq = 0; // unique render ids (mermaid requires one per render call)

/**
 * Extracts the bodies of COMPLETE ```mermaid fenced blocks from markdown
 * source. Pure (no DOM) — unit-tested in Node. Exists because an UNTERMINATED
 * fence still renders as a code block (CommonMark runs it to end of input), so
 * during streaming the DOM alone can't tell a finished diagram from a
 * half-streamed one; only blocks whose closing fence has arrived in the text
 * are rendered — the rest stay code until the fence closes.
 * @param {string} text
 * @returns {string[]} trimmed diagram sources, in order
 */
export function completeMermaidSources(text) {
  if (typeof text !== "string" || !text.includes("```mermaid")) return [];
  /** @type {string[]} */
  const out = [];
  /** @type {string[]|null} */
  let body = null;
  for (const line of text.split("\n")) {
    if (body === null) {
      if (/^\s{0,3}```mermaid\s*$/.test(line)) body = [];
    } else if (/^\s{0,3}```\s*$/.test(line)) {
      const src = body.join("\n").trim();
      if (src) out.push(src);
      body = null;
    } else {
      body.push(line);
    }
  }
  return out;
}

/** @returns {Promise<any>} the mermaid global, or null (fail soft) */
function ensureMermaid() {
  if (!mermaidLoad) {
    mermaidLoad = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "/vendor/mermaid.min.js";
      s.onload = () => {
        const m = /** @type {any} */ (window).mermaid;
        try {
          // strict: mermaid sanitizes label text itself; htmlLabels off keeps
          // flowchart labels as plain SVG text (no foreignObject), which also
          // survives the DOMPurify pass below. Light theme matches both tiers.
          m?.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "default",
            flowchart: { htmlLabels: false },
          });
          resolve(m || null);
        } catch {
          resolve(null);
        }
      };
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return mermaidLoad;
}

/**
 * Replaces each rendered ```mermaid code block whose source is complete with
 * the drawn diagram. Async (the library loads on first use); safe against
 * re-renders — a block whose <pre> left the document while the diagram was
 * being drawn is skipped.
 * @param {HTMLElement} el @param {string} text the markdown source
 */
async function renderMermaidBlocks(el, text) {
  const complete = new Set(completeMermaidSources(text));
  if (!complete.size) return;
  /** @type {Array<{pre: HTMLElement, src: string}>} */
  const blocks = [];
  for (const code of el.querySelectorAll("pre > code.language-mermaid")) {
    const src = (code.textContent || "").trim();
    const pre = /** @type {HTMLElement|null} */ (code.parentElement);
    if (pre && complete.has(src)) blocks.push({ pre, src });
  }
  if (!blocks.length) return;
  const mermaid = await ensureMermaid();
  const { DOMPurify } = /** @type {any} */ (window);
  if (!mermaid || !DOMPurify) return;
  for (const { pre, src } of blocks) {
    try {
      const { svg } = await mermaid.render(`mmd-${(mmdSeq += 1)}`, src);
      if (!pre.isConnected) continue; // the answer re-rendered meanwhile
      const box = document.createElement("div");
      box.className = "mermaid-diagram";
      box.style.overflowX = "auto"; // wide diagrams scroll, never overflow the bubble
      // Defense in depth: mermaid strict mode already sanitized the labels,
      // but its SVG goes through DOMPurify like everything else we render.
      box.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
      });
      const svgEl = box.querySelector("svg");
      if (!svgEl) continue;
      svgEl.style.maxWidth = "100%";
      svgEl.style.height = "auto";
      pre.replaceWith(box);
    } catch {
      // invalid/unsupported diagram — the fenced code stays visible
    }
  }
}

/**
 * Render markdown into an element, sanitized; plain text when the vendored
 * libs are missing.
 * @param {HTMLElement} el
 * @param {string} text
 */
export function renderMarkdownInto(el, text) {
  // The vendored classic-script globals aren't in lib.dom's Window type.
  const { marked, DOMPurify } = /** @type {any} */ (window);
  if (!(marked && DOMPurify)) {
    el.textContent = text;
    return;
  }
  // img is forbidden by DEFAULT: beyond XSS, a rendered <img> from answer text
  // would fire third-party requests (tracking pixels) — sources stay links.
  // The one exception is the site's own documentation images (isSafeDocImage):
  // a DOMPurify hook drops every <img> whose src isn't one of those fixed
  // same-origin static prefixes, so the third-party-request class stays closed.
  const hook = (/** @type {any} */ node) => {
    if (node.tagName === "IMG" && !isSafeDocImage(node.getAttribute("src"))) node.remove();
  };
  DOMPurify.addHook("afterSanitizeAttributes", hook);
  try {
    el.innerHTML = DOMPurify.sanitize(marked.parse(normalizeLlmMarkdown(text)), {
      FORBID_TAGS: [], // img allowed into the hook above, which enforces the allowlist
    });
  } finally {
    // removeHook pops the most recently added hook for the entry point —
    // ours, since add/sanitize/remove run synchronously right here.
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
  for (const img of el.querySelectorAll("img")) {
    img.loading = "lazy";
    img.classList.add("doc-img");
  }
  for (const a of el.querySelectorAll("a")) {
    // In-page citation jumps (added below) stay same-tab; only real links open
    // in a new tab.
    if ((a.getAttribute("href") || "").startsWith("#")) continue;
    a.target = "_blank";
    a.rel = "noopener";
  }
  // Run AFTER the loop above so the in-page [n] anchors it creates keep their
  // default same-page behavior instead of getting target="_blank".
  linkifyCitations(el);
  // Fire-and-forget: diagrams draw in when the (lazy-loaded) library is
  // ready; everything else in the answer is already usable.
  void renderMermaidBlocks(el, text);
}
