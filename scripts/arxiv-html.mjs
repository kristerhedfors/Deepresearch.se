#!/usr/bin/env node
// LaTeXML-aware section extraction from arXiv's HTML rendering, for the
// full-text tier (scripts/arxiv-fulltext.mjs).
//
// WHY A SECOND EXTRACTOR, when public/js/arxiv-rag-core.js already has
// htmlSections: that one is deliberately regex-only so the whole ingestion path
// can run inside a Cloudflare Worker with nothing but `fetch` and string work
// (docs/ARXIV-RAG.md §9.9). That property is worth keeping, so the core is
// untouched and stays the Worker-native path. This module is the BUILD-SIDE
// extractor: `scripts/` is the only consumer of the HTML functions (no `src/`
// module imports arxiv-rag-core at all), so a devDependency here adds no
// runtime dependency to the Worker and CLAUDE.md invariant 5 holds.
//
// The library is `cheerio` (htmlparser2 under the hood) — chosen after a
// survey, and the survey's first finding is worth recording: **there is no
// mature arXiv-HTML-specific parser to take off the shelf.** `ar5iv` PRODUCES
// this HTML (a LaTeXML conversion service), it does not parse it. The mature
// general-purpose options are Python: Trafilatura, which is reported to drop
// mathematical formulas entirely — disqualifying for papers — and Docling,
// which brings models and a heavyweight install to a repo with zero runtime
// deps. So the real choice is a battle-tested DOM library pointed at LaTeXML's
// own `ltx_*` class contract, which is what this is.
//
// ---- what the DOM buys, measured over 9 real papers (2026-07-26) -----------
// Against the regex core on the same HTML:
//
//   * **Mathematics survives.** LaTeXML emits `<math alttext="…">` carrying the
//     original LaTeX. The regex core strips the element and loses the formula:
//     math was present in the output for 3 of 9 papers, vs 9 of 9 here. For a
//     corpus where the answer is often IN the formula, that is the main win.
//   * **+11% more prose** (451,621 vs 406,703 chars) — and that understates it,
//     because this extractor simultaneously DISCARDS 66,235 chars of
//     bibliography the regex core was indexing as prose. Net genuine-prose gain
//     is nearer +27%.
//   * **The nesting trap is structural, not a rule.** LaTeXML nests
//     subsections inside their parent `<section>`; the core solves this by
//     splitting on opening tags. Here the parent's own prose is whatever
//     remains after removing descendant units, which cannot drift.
//
// Cost: ~100 ms per paper vs ~4 ms. Irrelevant — the tier is warmed on demand
// at ~5 s per paper including the embedding calls.
//
// One correction found by measuring rather than assuming: a first version
// selected only section/subsection/subsubsection and so MISSED `.ltx_appendix`
// and `.ltx_paragraph` units, reading as a regression on papers that carry
// them. Both are in UNIT_SELECTOR now. Add to that list rather than adding
// special cases.

import * as cheerio from "cheerio";

// The structural units LaTeXML emits for a document's own divisions. Order does
// not matter — the DOM walk finds them in document order.
const UNIT_SELECTOR = ".ltx_section, .ltx_subsection, .ltx_subsubsection, .ltx_paragraph, .ltx_appendix";
// Bibliography is a citation LIST, not prose. Indexed as text it yields chunks
// that can only match on author surnames, and it was 16% of the regex core's
// output across the sample.
const DROP_SELECTOR = ".ltx_bibliography, script, style, .ltx_page_footer";
const MIN_SECTION_CHARS = 40;

/**
 * The prose sections of one arXiv HTML document, in document order.
 * Never throws: unparseable input yields an empty list, so the caller can fall
 * back to the regex core exactly as it would on a fetch failure.
 *
 * @param {string} html
 * @returns {{ heading: string, text: string }[]}
 */
export function htmlSectionsDom(html) {
  const source = typeof html === "string" ? html : "";
  if (!source.trim()) return [];
  /** @type {{ heading: string, text: string }[]} */
  const out = [];
  try {
    const $ = cheerio.load(source);
    $(DROP_SELECTOR).remove();
    // Replace every formula with the LaTeX LaTeXML preserved in `alttext`, so
    // the extracted text still carries the mathematics.
    $("math[alttext]").each((_, el) => {
      $(el).replaceWith(` ${$(el).attr("alttext")} `);
    });

    /** @param {string} heading @param {any} node */
    const push = (heading, node) => {
      const clone = $(node).clone();
      // A unit's OWN prose is what remains once nested units are removed —
      // the structural answer to LaTeXML's nesting.
      clone.find(UNIT_SELECTOR).remove();
      clone.find(".ltx_title").first().remove();
      const text = clone.text().replace(/\s+/g, " ").trim();
      if (text.length >= MIN_SECTION_CHARS) {
        out.push({ heading: String(heading || "").slice(0, 90), text });
      }
    };

    const abstract = $(".ltx_abstract");
    if (abstract.length) push("Abstract", abstract);
    $(UNIT_SELECTOR).each((_, el) => {
      const heading = $(el).find(".ltx_title").first().text().replace(/\s+/g, " ").trim();
      push(heading, el);
    });
  } catch {
    return [];
  }
  return out;
}

/**
 * The paper's title and abstract from its HTML rendering — tier 1's inputs,
 * from the same fetch tier 2 already pays for.
 *
 * This is what makes the GCS route complete (scripts/arxiv-gcs.mjs): the GCS
 * mirror enumerates every id in seconds but its metadata dump is frozen at
 * 2020, so recent abstracts have to come from somewhere. They are right here in
 * the rendering, which means a corpus can be built with no OAI-PMH sweep and no
 * call to the rate-limited query API — one request per paper serving both tiers.
 *
 * Authors come along because the source registry's citable metadata line uses
 * them. What the rendering does NOT carry is the primary CATEGORY: a corpus
 * built purely from GCS + HTML has an empty category field, which is a real
 * (small) gap versus an OAI-harvested row — the submission DATE is recoverable
 * from the GCS object's own `updated` timestamp, but the archive is not. Fill it
 * from OAI or the abs page if a build needs category facets.
 *
 * @param {string} html
 * @returns {{ title: string, abstract: string, authors: string[] }}
 */
export function htmlTitleAbstract(html) {
  const source = typeof html === "string" ? html : "";
  const empty = { title: "", abstract: "", authors: /** @type {string[]} */ ([]) };
  if (!source.trim()) return empty;
  try {
    const $ = cheerio.load(source);
    $("script, style").remove();
    const title = $(".ltx_title_document").first().text().replace(/\s+/g, " ").trim();
    const abs = $(".ltx_abstract").first().clone();
    abs.find(".ltx_title").remove(); // the literal word "Abstract"
    const authors = $(".ltx_personname")
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      // LaTeXML sometimes puts affiliations and emails inside personname; keep
      // the first line, which is the name.
      .get()
      .map((s) => s.split(/\s{2,}|,\s*(?=[A-Z][a-z]+\s+(?:University|Institute|Lab))/)[0].trim())
      .filter((s) => s && s.length < 80);
    return { title, abstract: abs.text().replace(/\s+/g, " ").trim(), authors: [...new Set(authors)] };
  } catch {
    return empty;
  }
}

/**
 * Does this look like LaTeXML output at all? Used to decide whether the DOM
 * extractor is even applicable before spending a parse on it — arXiv serves
 * some ids as a stub or an error page.
 * @param {string} html
 */
export function isLatexmlHtml(html) {
  return typeof html === "string" && /class="[^"]*\bltx_/.test(html);
}
