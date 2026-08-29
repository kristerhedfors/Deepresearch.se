// @ts-check
// The RUNNER half of the platform introspection family — everything that
// touches a binding. src/platform-tools.js holds the schemas and stays pure so
// src/mcp-config.js can import its catalog; this half is reached only by a
// dynamic import() inside tools/call, so src/mcp.test.js still loads the
// protocol without the pipeline graph. Same cut as literature-tools.js ⇄
// literature-run.js, and merging the two is the natural "simplification" that
// breaks both suites.
//
// Only `platform_map` runs here. The two answering tools (`explain_internals`,
// `improvement_areas`) go through runDeepResearch with the introspection agent
// forced — they are the research pipeline with a lens, not a second pipeline,
// and giving them their own runner would have meant a second copy of the quota
// gate, the billing, the progress plumbing and the chat_logs write.
//
// What `platform_map` reads is committed artifacts of THIS deploy, served
// through the ASSETS binding: the source snapshot the introspection mode
// already runs on, and the documentation corpus beside it. So the map describes
// the code that is actually running, by construction — the same guarantee the
// snapshot gives the chat mode. It contacts nothing, spends nothing, and needs
// no quota.

import { skillsCatalog } from "../public/js/introspect-core.js";
import { loadDocsCorpus, loadSourceSnapshot } from "./introspect.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * How many matched areas get a spoken GLOSS, and how many more are named
 * without one.
 *
 * Both numbers came from listening to the output rather than from taste. An
 * eight-item list where every item carries a subordinate clause is not a map, it
 * is an obstacle: by the fourth the listener has lost the first, and there is no
 * scrollback. Three glossed plus five named is about what survives one hearing,
 * and the named tail still tells a caller the vocabulary exists.
 */
export const MAX_GLOSSED_AREAS = 3;
export const MAX_SPOKEN_AREAS = 8;

/** The longest `area` accepted. A real one is two or three words; the cap exists
 * because this tool is free and echoes its argument. */
export const MAX_AREA_CHARS = 120;

/** How much of an area's summary is spoken. Its written form runs to 240
 * characters, which is a paragraph in the ear. */
export const SPOKEN_SUMMARY_CHARS = 120;

/**
 * The top-level areas of the codebase, as path prefixes → what they are.
 *
 * Derived rather than curated: the counts come from the snapshot, so this can
 * describe the tree wrongly only if the tree moved, and a prefix that matches
 * nothing is dropped rather than spoken as an empty area. A hand-written list
 * of subsystems would have been more informative and would have gone stale
 * silently, which on a surface nobody can see is the worse failure.
 */
const CODE_AREAS = [
  { prefixes: ["src/"], name: "the Cloudflare Worker itself" },
  { prefixes: ["public/js/"], name: "the browser client" },
  { prefixes: ["public/cure/"], name: "the client-side privacy tier" },
  { prefixes: ["docs/"], name: "design and architecture documentation" },
  // TWO roots for one area, counted together. The playbook tree was PARKED at
  // skills-disabled/ on 2026-08-16 to find out which of them are needed, and
  // introspect-core.js's SKILL_PATH_RE accepts either root — so this must too. A
  // prefix that silently stops matching does not fail: it makes a whole area of
  // the codebase vanish from the map, which is the one thing a map must not do.
  // They share an entry rather than taking one each because two entries with the
  // same name would speak the area twice if the tree were ever half-moved.
  { prefixes: [".claude/skills/", "skills-disabled/"], name: "engineering playbooks" },
  { prefixes: ["sdk/"], name: "the two software development kits" },
  { prefixes: ["scripts/"], name: "build, ingest and evaluation tooling" },
  { prefixes: ["tests/"], name: "the test and evaluation harnesses" },
];

/**
 * Run one platform tool. Only `platform_map` reaches here.
 *
 * Never throws: every failure comes back as a spoken sentence with `isError`,
 * because a tool that throws is a client model that retries the same call
 * forever. The interesting failure is a MISSING snapshot, and it is answered
 * rather than hidden — a caller told "the map is unavailable" can still ask a
 * question, while one told nothing concludes the platform is empty.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {string} name
 * @param {any} args
 * @returns {Promise<{ text: string, isError: boolean, areas: number }>}
 */
export async function runPlatformTool(env, log, name, args) {
  if (name !== "platform_map") {
    return { text: `Unknown platform tool: ${name}`, isError: true, areas: 0 };
  }
  // The area is CAPPED, and this is the one tool where that matters most: it is
  // deliberately outside the quota gate and holds no concurrency slot, and it
  // echoes the caller's word back in both the match sentence and the miss. Left
  // uncapped, a megabyte in was a megabyte out, free and repeatable in parallel
  // from one key. A real area is two or three words.
  const area = typeof args?.area === "string" ? args.area.trim().slice(0, MAX_AREA_CHARS) : "";
  try {
    return await runPlatformMap(env, log, area);
  } catch (/** @type {any} */ err) {
    log.warn("platform.map_failed", { error: err?.message || String(err) });
    return {
      text:
        "The platform map could not be read just now, so this answer would be a guess. " +
        "Nothing was spent. You can still ask a question about how the platform works — " +
        "that path reads the source directly and does not depend on this map.",
      isError: true,
      areas: 0,
    };
  }
}

/**
 * The map itself, spoken.
 *
 * Structure is deliberate for an ear: what this is, then how much of it there
 * is, then where to go next. A listener who stops after the first sentence has
 * still learned the thing that stops them asking the wrong question.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {string} area
 * @returns {Promise<{ text: string, isError: boolean, areas: number }>}
 */
async function runPlatformMap(env, log, area) {
  const snapshot = await loadSourceSnapshot(env, log);
  if (!snapshot) {
    return {
      text:
        "The source snapshot this map is built from is not available on this deployment, so " +
        "there is nothing reliable to describe. Nothing was spent. Ask a question about how " +
        "the platform works anyway — that path reads the source directly.",
      isError: true,
      areas: 0,
    };
  }

  const catalog = skillsCatalog(snapshot);
  const parts = [];

  // A NARROWED call leads with its answer. The orientation below is worth about
  // ninety words, which is fine as the first thing a caller ever hears and wrong
  // as the preamble to "what do you have on python" — by the time the answer
  // arrives the listener has stopped attending, and unlike a reader they cannot
  // skip to it. So the whole-map preamble is spoken only when there is no area,
  // and a narrowed call gets one orienting clause at the END instead.
  const matched = area ? matchAreas(catalog, area) : { shown: [], total: 0 };
  if (area) {
    parts.push(
      matched.total ? speakMatches(area, matched.shown, matched.total) : speakMiss(area, catalog.length),
    );
  } else {
    parts.push(
      "This is a deep research platform running as a single Cloudflare Worker. It orchestrates " +
        "a fixed research pipeline — triage, search, gap check, synthesis, validation — with no " +
        "function calling, so the same pipeline runs on any model. It has two tiers: one where " +
        "the server is never in the data path, and one that is account-scoped and cloud-first.",
    );
    const sizeLine = describeSize(snapshot, await docsCount(env, log));
    if (sizeLine) parts.push(sizeLine);
    const areasLine = describeCodeAreas(snapshot);
    if (areasLine) parts.push(areasLine);
    if (catalog.length) {
      parts.push(
        `Beyond the code itself there ${catalog.length === 1 ? "is" : "are"} ` +
          `${plural(catalog.length, "documented area")}, each with its own engineering playbook ` +
          "covering one subsystem — the research pipeline, the in-browser Linux sandbox, the " +
          "privacy model, the hosted scientific corpora, the agent registry and so on. Name a " +
          "topic and this tool lists the ones that match.",
      );
    }
  }

  parts.push(
    "To go further, ask how a part works and the source gets read and investigated, or ask " +
      "where a part could improve and the project's own measurements and rejected experiments " +
      "get read with it.",
  );

  // The log line carries the TRUE match count, not the spoken one: a log that
  // agrees with a wrong answer is worse than no log.
  return { text: parts.join(" "), isError: false, areas: area ? matched.total : catalog.length };
}

/**
 * The matched areas, spoken: the first few with a gloss, the rest named only,
 * and the true total said out loud even when the list is shorter than it.
 * @param {string} area
 * @param {Array<{ name: string, description: string }>} shown the truncated list
 * @param {number} total how many actually matched
 * @returns {string}
 */
function speakMatches(area, shown, total) {
  const glossed = shown.slice(0, MAX_GLOSSED_AREAS);
  const named = shown.slice(MAX_GLOSSED_AREAS);
  const lead = `On ${area}, ${plural(total, "part")} of the platform ${
    total === 1 ? "has its" : "have their"
  } own documented playbook. ${speakGlossed(glossed)}`;
  const tail = named.length
    ? ` There ${named.length === 1 ? "is" : "are"} also ${speakList(named.map((a) => spokenName(a.name)))}.`
    : "";
  // Say so when the list is shorter than the count, rather than letting the two
  // numbers quietly disagree — a caller that hears twelve and is read eight
  // needs to know the remainder exists in order to ask for it.
  const rest = total - shown.length;
  const more = rest > 0 ? ` ${plural(rest, "other")} matched and ${rest === 1 ? "is" : "are"} not listed here.` : "";
  return `${lead}${tail}${more}`;
}

/**
 * A miss, said so it cannot be heard as "the platform does not have that".
 * @param {string} area
 * @param {number} total
 * @returns {string}
 */
function speakMiss(area, total) {
  return (
    `Nothing in the platform's ${total} documented areas matches "${area}" by name or summary. ` +
    "That does not mean the platform lacks it — a playbook exists only where the work was worth " +
    "writing down, and these names are all in English, so a term in another language misses " +
    "even when the thing exists. Ask the question directly and the source gets read."
  );
}

/**
 * The glossed areas as sentences rather than one semicolon-joined clause. A
 * semicolon is silent, so a joined list of subordinate clauses arrives as one
 * unbroken sentence; full stops are what give a listener somewhere to land.
 * @param {Array<{ name: string, description: string }>} areas
 * @returns {string}
 */
function speakGlossed(areas) {
  return areas
    .map((a) => {
      const label = spokenName(a.name);
      const { text, kind } = spokenSummary(a.description, a.name);
      if (!text) return `${label}.`;
      // TWO frames, chosen by which half of the description survived. A trigger
      // clause is a subordinate "when" clause and needs a frame that can take
      // one; a detail is a noun phrase and reads as a complement. Forcing both
      // into "covers …" is what produced "cache helper covers the live site
      // serves stale content".
      return kind === "trigger"
        ? `${label} is the playbook for when ${lowerFirst(text)}.`
        : `${label} covers ${lowerFirst(text)}.`;
    })
    .join(" ");
}

/**
 * The documentation corpus's document count, or 0 when it cannot be read.
 * Separate from the snapshot because the two artifacts fail independently and
 * a missing corpus should cost one clause, not the map.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<number>}
 */
async function docsCount(env, log) {
  try {
    const corpus = await loadDocsCorpus(env, log);
    return corpus?.snapshot?.files?.length || 0;
  } catch {
    return 0;
  }
}

/**
 * How big the introspectable surface is, in a sentence.
 *
 * Bytes are spoken as megabytes because "three million two hundred thousand
 * bytes" is a number nobody retains, and the point of the figure is scale
 * rather than precision.
 *
 * The playbook count is deliberately NOT here even though it was at first: the
 * sentence after this one already gives it as "N documented areas", and the two
 * disagreed — the catalog counts playbooks including the SDK's, while the file
 * division below counts files under the playbooks directory. On a screen that is
 * two figures measuring two things; in the ear it is the same sentence
 * contradicting itself a clause later.
 *
 * @param {{ count?: number, bytes?: number }} snapshot
 * @param {number} docs
 * @returns {string}
 */
function describeSize(snapshot, docs) {
  const count = Number(snapshot?.count) || 0;
  if (!count) return "";
  const mb = Math.round(((Number(snapshot?.bytes) || 0) / 1_000_000) * 10) / 10;
  const bits = [plural(count, "source file")];
  if (mb > 0) bits.push(`about ${mb} megabyte${mb === 1 ? "" : "s"} of text`);
  if (docs) bits.push(plural(docs, "document"));
  return (
    `The deployment carries its own source with it — ${speakList(bits)} — so anything said ` +
    "about the implementation comes from the exact code this server is running, not from a " +
    "description of it."
  );
}

/**
 * The top-level areas that actually exist in this snapshot, with file counts.
 * @param {{ files?: Array<{ p?: string }> }} snapshot
 * @returns {string}
 */
function describeCodeAreas(snapshot) {
  const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  if (!files.length) return "";
  const counted = CODE_AREAS.map((areaDef) => ({
    name: areaDef.name,
    n: files.filter((f) => {
      const path = typeof f?.p === "string" ? f.p : "";
      return path && areaDef.prefixes.some((prefix) => path.startsWith(prefix));
    }).length,
  })).filter((a) => a.n > 0);
  if (!counted.length) return "";
  // "with N files" rather than ", N files": the list separator is already a
  // comma, so a comma inside each item leaves a listener unable to tell where
  // one area ends and the next begins. On a screen the punctuation carries it;
  // in the ear it does not.
  return `It divides into ${speakList(counted.map((a) => `${a.name} with ${plural(a.n, "file")}`))}.`;
}

/**
 * The documented areas matching a caller's word, best first.
 *
 * A name hit outranks a summary hit, because someone who says "cache-helper"
 * means the caching playbook and not the four others that mention it in
 * passing. Below
 * that, order is the catalog's own, which is alphabetical — there is no
 * relevance signal here worth inventing one for.
 *
 * @param {Array<{ name: string, description: string }>} catalog
 * @param {string} area
 * @returns {{ shown: Array<{ name: string, description: string }>, total: number }}
 */
function matchAreas(catalog, area) {
  const needle = normalizeForMatch(area);
  if (!needle) return { shown: [], total: 0 };
  const terms = needle.split(" ").filter((t) => t && !MATCH_STOPWORDS.has(t));
  // A needle made only of stopwords matches almost everything by substring —
  // "the" hit 98 of 99 and produced the sentence "On the, 98 parts of the
  // platform…". Nothing useful can be said about it, so it falls through to the
  // graceful miss rather than to a list of the entire catalog.
  if (!terms.length) return { shown: [], total: 0 };

  /** @type {Array<{ name: string, description: string }>} */
  const byName = [];
  /** @type {Array<{ name: string, description: string }>} */
  const bySummary = [];
  for (const entry of catalog) {
    const name = String(entry?.name || "");
    const description = String(entry?.description || "");
    // Normalised on BOTH sides, so a hyphenated needle finds a spaced name and
    // the reverse. Without it "deep research" missed `pipeline-architecture`,
    // `ground-truth-eval` and `add-research-source` — every one of which writes
    // it "deep-research" — and the single most likely thing to ask this platform
    // about returned one unrelated playbook. That is the "you asked, so it must
    // not exist" failure platform_map was written to prevent, produced by
    // platform_map.
    const nameText = normalizeForMatch(name);
    const summaryText = normalizeForMatch(description);
    // Every term must appear, so a two-word needle narrows rather than widens.
    if (terms.every((t) => nameText.includes(t))) byName.push({ name, description });
    else if (terms.every((t) => summaryText.includes(t))) bySummary.push({ name, description });
  }
  const all = [...byName, ...bySummary];
  // The TOTAL travels beside the truncated list, and keeping the two apart is
  // the whole point. The first version returned only the slice, and speakMatches
  // then reported ITS length as the number of matches — so a caller asking about
  // the sandbox was told "8 parts" when twelve matched, and the four it never
  // heard were, from where it was standing, parts this platform does not have.
  // A listener has no scrollback to check a spoken number against.
  return { shown: all.slice(0, MAX_SPOKEN_AREAS), total: all.length };
}

/**
 * Lower-cased, with every separator flattened to a space, so "deep-research",
 * "deep_research", "Deep Research" and "deep/research" all compare equal.
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Needle words too common to narrow anything. A needle made ONLY of these is
 * refused rather than answered with most of the catalog. */
const MATCH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "on", "in", "to", "with", "is", "it", "this",
  "that", "how", "what", "does", "do", "any", "all", "about", "from", "by", "as", "at",
]);

/**
 * A playbook's name, said the way a person would. The catalog names are
 * hyphenated slugs ("execution-sandbox", "sdk/exec-engine") and a speech engine
 * reads both the hyphen and the slash out loud.
 * @param {string} name
 * @returns {string}
 */
function spokenName(name) {
  return String(name || "")
    .replace(/^sdk\//, "the SDK's ")
    .replace(/[-_/]+/g, " ")
    .trim();
}

/**
 * The LOAD-TRIGGER preamble every playbook description opens with.
 *
 * This is the single thing that made the first version of this tool unusable,
 * and it was invisible until the output was read aloud. A SKILL.md
 * `description` is not a description of the subsystem — it is an instruction to
 * an agent about WHEN TO READ THE FILE, so nearly every one begins "Load when
 * working on X" or "Use this skill when …". Spoken, the map said "cache-helper,
 * which covers load when working on cache-helper", which is not merely clumsy:
 * it is not about caching at all. The substance is what follows the trigger, so
 * the trigger is cut and the substance kept.
 */
const TRIGGER_OPENER =
  /^(?:load|use|read|reach for)\s+(?:it\s+|this\s+skill\s+)?(?:when|whenever|if|before)\s+(?:you\s+(?:are\s+)?)?/i;

/** Capitalised runs that are real acronyms and must survive as they are. Anything
 * else in capitals is a written EMPHASIS, which a speech engine either spells out
 * letter by letter or over-stresses — 45 of the 99 playbook descriptions carried
 * at least one ("the sandbox HANGS", "the CANONICAL documentation"). */
const ACRONYMS = new Set([
  "SDK", "SDKS", "RAG", "OSINT", "LLM", "LLMS", "API", "APIS", "MCP", "D1", "R2", "UI", "UX",
  "VM", "VMS", "AI", "ETL", "EN", "SV", "PDF", "HTML", "CSS", "JS", "JSON", "SQL", "URL", "URLS",
  "HTTP", "HTTPS", "SSE", "CI", "CPU", "DOM", "PWA", "COEP", "CORS", "CVE", "CVES", "DNS", "TTS",
  "OWASP", "CVSS", "ORCID", "PMID", "DRC", "DRS", "DRPL", "DRSW", "PGO", "LTO", "UPX", "GCC",
  "WASM", "IDB", "OAI", "PMH", "GCS", "TF", "IDF", "P", "F", "K", "N", "I", "A", "X", "S", "M", "L",
]);

/**
 * One playbook's summary, made speakable — plus WHICH HALF of the description it
 * came from, because the two halves are different kinds of sentence and need
 * different frames around them.
 *
 * A SKILL.md `description` is a load TRIGGER written for an agent, and it has a
 * standard shape: `Load when <trigger clause> — <detail>`. The trigger clause is
 * a subordinate "when" clause and can be a gerund phrase ("adding a new LLM
 * provider"), a noun phrase ("working on the sandbox") or a full finite clause
 * ("the live site serves STALE content"). The detail after the dash is a noun
 * phrase describing the subsystem.
 *
 * The first version tried to force both into one frame, `"<name> covers <x>"`,
 * by stripping the participle off the front of the trigger. That produced a
 * quarter of the catalog as ungrammatical speech — "add llm provider covers a
 * NEW LLM provider", "cache helper covers the live site serves STALE content".
 * Keeping the trigger intact and choosing the frame from the half it came from
 * fixes every one of them, and is less code than the stripping was.
 *
 * @param {string} raw the SKILL.md frontmatter description
 * @param {string} name the playbook's name, so it is not described as itself
 * @returns {{ text: string, kind: "trigger" | "detail" }} empty text = no gloss
 */
function spokenSummary(raw, name) {
  const whole = String(raw || "").replace(/\s+/g, " ").trim();
  if (!whole) return { text: "", kind: "detail" };
  // Parentheticals go BEFORE the dash split, not after. A dash inside a
  // parenthetical otherwise splits the text mid-aside, and the paren-stripping
  // pass then finds an opener with no closer and leaves it in the spoken output.
  const stripped = cleanForSpeech(whole.replace(TRIGGER_OPENER, ""));

  const dash = stripped.search(/\s[—–]\s/);
  const head = dash > 0 ? stripped.slice(0, dash) : stripped;
  const detail = dash > 0 ? stripped.slice(dash).replace(/^\s*[—–]\s*/, "") : "";

  // The head is preferred unless it says only what the NAME already said, which
  // is the shape of every playbook named after its subject ("working on
  // cache-helper — every cache layer…"): there the detail is the description.
  const preferDetail = isJustTheName(head, name) && detail;
  const first = preferDetail ? detail : head;
  const firstKind = /** @type {"trigger" | "detail"} */ (preferDetail ? "detail" : "trigger");
  if (isSubstantive(first)) return { text: clipSpoken(first), kind: firstKind };

  const second = preferDetail ? head : detail;
  const secondKind = /** @type {"trigger" | "detail"} */ (preferDetail ? "trigger" : "detail");
  if (isSubstantive(second)) return { text: clipSpoken(second), kind: secondKind };

  // Nothing speakable survived — a description that was entirely file paths.
  // Naming the area with no gloss is the honest answer; a fragment would be
  // worse, because a listener cannot see that it is one.
  return { text: "", kind: "detail" };
}

/**
 * Clip to a spoken length, then trim again.
 *
 * The order matters and cost a round to get right: cleanForSpeech trims dangling
 * function words, but the CLIP that follows can create a fresh one by cutting a
 * clause just after its preposition ("…a frozen public replay at"). Trimming
 * before clipping fixes only the words the path stripper stranded; trimming
 * after fixes those the clip strands too.
 * @param {string} text
 * @returns {string}
 */
function clipSpoken(text) {
  return trimDanglingFunctionWords(clipSentence(text, SPOKEN_SUMMARY_CHARS));
}

/**
 * Strip everything a speech engine would pronounce as itself, or shout.
 * @param {string} raw
 * @returns {string}
 */
function cleanForSpeech(raw) {
  let text = String(raw || "");
  // Parenthetical asides are almost always identifiers and file paths here, and
  // a listener can use neither. Dropped whole rather than de-punctuated, and any
  // unbalanced opener left by a clip goes with them.
  text = text.replace(/\([^)]*\)/g, " ");
  text = text.replace(/\([^)]*$/g, " ");
  // Inline code: the content is an identifier or a path, which reads as noise.
  text = text.replace(/`[^`]*`/g, " ");
  // Paths, bare filenames, and snake_case identifiers — all of which a speech
  // engine spells out one separator at a time.
  text = text.replace(/\S*\/\S*/g, " ");
  text = text.replace(/\b[\w-]+\.(?:js|mjs|json|md|ts|sh|css|html|jsonl)\b/gi, " ");
  text = text.replace(/\b\w+_\w+\b/g, " ");
  // Emphasis and stray quoting, then the punctuation the removals left behind.
  text = text.replace(/[*_"“”]+/g, " ");
  // SHOUTED emphasis. Written capitals are a screen convention; spoken, they are
  // either spelled out or over-stressed. Real acronyms are kept.
  text = text.replace(/\b[A-Z][A-Z0-9-]{1,}\b/g, (word) => (ACRONYMS.has(word) ? word : word.toLowerCase()));
  text = text.replace(/\s+([,;:.])/g, "$1");
  text = text.replace(/([,;:]\s*){2,}/g, "$1 ");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/^[\s,;:—–-]+/, "");
  // A trigger verb whose whole object was a list of file paths is left standing
  // alone once the paths go ("touching, or anything about …"). Drop the orphan
  // and the conjunction after it so the clause starts on its subject. To
  // FIXPOINT, because a trigger commonly lists several verbs and each pass
  // uncovers the next.
  let prev;
  do {
    prev = text;
    text = text.replace(/^(?:or|and)\s+/i, "");
    text = text.replace(/^\w+ing[,;]\s*/i, "");
    text = text.trim();
  } while (text !== prev);
  return trimDanglingFunctionWords(text);
}

/**
 * A count and its noun, agreeing. Trivial, and it is here because the first
 * version of this module said "1 files" — which on a screen is a typo and in the
 * ear is the sentence a listener stops trusting.
 * @param {number} n
 * @param {string} noun singular form
 * @returns {string}
 */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A list spoken the way a person reads one out — commas, then "and".
 * @param {string[]} items
 * @returns {string}
 */
function speakList(items) {
  const list = items.filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The function words that governed something now removed. A clause ending
 * "…a frozen public replay at" lost its object to the path stripper, and the
 * stranded preposition is audible in a way it never is on a page. */
const DANGLING = "at|in|on|to|with|from|into|for|of|the|a|an|and|or|by|as|per|via|about";

/**
 * Drop a trailing run of function words left governing nothing.
 * @param {string} text
 * @returns {string}
 */
function trimDanglingFunctionWords(text) {
  let out = String(text || "").trim();
  let prev;
  do {
    prev = out;
    out = out.replace(new RegExp(`[\\s,;:]*\\b(?:${DANGLING})\\s*[.,;:]?$`, "i"), "").trim();
  } while (out !== prev);
  return out.replace(/[\s,;:—–-]+$/, "").trim();
}

/**
 * Whether a cleaned summary says anything. Guards the case where the whole
 * clause was file paths and identifiers: the cleanup removes them all and what
 * is left is punctuation and a conjunction, which reads aloud as a mistake.
 * @param {string} text
 * @returns {boolean}
 */
function isSubstantive(text) {
  const words = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w));
  return words.length >= 3 && String(text).trim().length >= 16;
}

/**
 * Whether a description's opening clause says nothing the playbook's NAME did
 * not already say. Compared on words rather than the whole string so
 * "working on the cache-helper playbook" still counts as substantive.
 * @param {string} head
 * @param {string} name
 * @returns {boolean}
 */
function isJustTheName(head, name) {
  const nameWords = new Set(spokenName(name).toLowerCase().split(/\s+/).filter(Boolean));
  const extra = head
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !nameWords.has(w) && !FILLER.has(w) && !TRIGGER_VERBS.has(w));
  return extra.length < 2;
}

/** Words that carry no subject on their own, so they do not make an opening
 * clause substantive. */
const FILLER = new Set(["the", "a", "an", "and", "or", "of", "for", "on", "in", "to", "with", "this", "its"]);

/** The META verbs a trigger opens with — they say "when you work on it", not what
 * it IS, so a head made only of one plus the skill's own name is still just the
 * name ("working on cache-helper"). */
const TRIGGER_VERBS = new Set(["working", "touching", "editing", "modifying", "changing", "using", "reading"]);

/**
 * The first sentence of a summary, clipped to a length an ear holds.
 *
 * Cut at a word boundary rather than mid-word: a truncated word is the one
 * artefact of clipping a listener actually notices. The trailing period is
 * dropped because the caller supplies its own punctuation.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clipSentence(text, max) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  // A full stop ends a thought; a semicolon joins two, so cutting at one leaves
  // a clause with nothing to attach to. Only `. ` ends the sentence — and not
  // one after an initial or an abbreviation, which is why the character before
  // it has to be more than one letter's worth of word.
  const stop = raw.search(/[a-z0-9)][.!?]\s/i);
  let out = stop > 0 ? raw.slice(0, stop + 1) : raw;
  if (out.length > max) {
    const cut = out.slice(0, max);
    // Prefer breaking at a clause boundary inside the window; fall back to the
    // last word. Either way never mid-word — a truncated word is the one
    // artefact of clipping a listener actually notices.
    const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "), cut.lastIndexOf(" — "));
    const space = cut.lastIndexOf(" ");
    const at = clause > max * 0.5 ? clause : space;
    out = at > max * 0.4 ? cut.slice(0, at) : cut;
  }
  return out.replace(/[\s.,;:—-]+$/, "").trim();
}

/**
 * Lowercase a leading capital, unless the word is an acronym or a proper name
 * that would be wrong lowercased ("OWASP", "PubMed"). Only the first character
 * is touched, and only when the second is lowercase — which is exactly the
 * "ordinary sentence start" case.
 * @param {string} text
 * @returns {string}
 */
function lowerFirst(text) {
  const s = String(text || "");
  if (s.length < 2) return s;
  const isSentenceStart = /^[A-Z][a-z]/.test(s);
  return isSentenceStart ? s[0].toLowerCase() + s.slice(1) : s;
}
