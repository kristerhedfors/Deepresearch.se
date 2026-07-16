// @ts-check
// The introspection feature's SHARED pure core — the one implementation
// behind the DRS server enrichment (src/introspect.js re-imports from here,
// the bash-core.js pattern: the Worker bundler can import from any repo path,
// the browser only from served modules) and both client tiers (DRS
// public/js/stream.js, DRC public/cure/drc.js).
//
// Introspection mode: with the developer_mode knob on, a conversation that
// asks about THIS SITE's own implementation gets the deployed source snapshot
// (public/introspect/source-snapshot.json — see scripts/bundle-source.mjs)
// as structured context: a complete file index, an orientation excerpt
// (CLAUDE.md), and the full text of any repo files the message names. When
// the execution sandbox is also on, the whole tree is mounted at /src in the
// in-browser Linux VM so the model can explore it with real commands.
//
// Everything here is deterministic and I/O-free (Node-tested in
// introspect-core.test.js): the intent gate (EN+SV parity per invariant 6),
// snapshot validation, path-mention extraction, and the context-block
// builder with its caps. Fetching the snapshot and appending the block are
// the callers' jobs.

import { regionForModelEntry, regionForProvider } from "./provider-region.js";

// Where the committed snapshot artifact is served from (same-origin).
export const SNAPSHOT_PATH = "/introspect/source-snapshot.json";
// The committed DENSE source-RAG index (scripts/bundle-source-rag.mjs).
export const RAG_PATH = "/introspect/source-rag.json";
// The committed OWASP reference corpus + its dense index (scripts/fetch-owasp.mjs,
// scripts/bundle-owasp-rag.mjs) — the OWASP Top 10 for LLM Applications 2025 and
// for Web Applications 2021 full text, grounding introspection security
// assessments so findings quote the actual OWASP wording. The corpus is
// snapshot-shaped and the index shares the source-RAG format, so both reuse the
// chunker / int8 codec / retrieval below.
export const OWASP_CORPUS_PATH = "/introspect/owasp-corpus.json";
export const OWASP_RAG_PATH = "/introspect/owasp-rag.json";
// The HELP documentation corpus + its dense index (scripts/bundle-docs.mjs,
// scripts/bundle-docs-rag.mjs) — the repo's whole Markdown documentation
// (README, CLAUDE.md, FEATURES.md, the security register, docs/*.md) as a
// snapshot-shaped corpus, each doc carrying its title, its resolved SYMBOL
// references (backticked names → real source file + definition line) and its
// images rewritten to served /introspect/docs-img/ URLs. This is help mode's
// primary layer: usage questions are answered from the documentation near-
// verbatim (images and captions included), and follow-ups escalate into the
// source — the deeper support level. Reuses the chunker / int8 codec /
// retrieval below, exactly like the OWASP corpus.
export const DOCS_CORPUS_PATH = "/introspect/docs-corpus.json";
export const DOCS_RAG_PATH = "/introspect/docs-rag.json";

// ---- caps -------------------------------------------------------------------

// The block rides inside the conversation through EVERY phase — including the
// JSON planning phases on the fixed reliable model — so it must stay a small
// fraction of a ~32k-token context. Depth beyond these caps comes from the
// sandbox mount, not from inlining more text.
export const ORIENTATION_CHARS = 6_000; // CLAUDE.md excerpt
export const MAX_INLINE_FILE_CHARS = 30_000; // one named file, truncated beyond
export const MAX_INLINE_TOTAL_CHARS = 60_000; // all inlined files together
export const MAX_INLINE_FILES = 6; // named-file inlining stops here

// ---- the intent gate (EN + SV, deterministic) --------------------------------

// Whether one message asks about this site's own implementation. Same
// discipline as quizIntent/hfIntent: phrased-as-a-request patterns, never a
// model call, and Swedish forms with the same breadth as English (definite
// forms included — "källkoden", "arkitekturen"). Deliberately anchored to
// SELF-reference ("your …", "din …", "the code behind this site") so ordinary
// research about source code in general ("find the Linux kernel source")
// never triggers it.
const INTROSPECTION_PATTERNS = [
  /\bintrospect(?:ions?)?\b/i, // the mode's own name, EN ("introspect", "introspection")
  /\bintrospekt(?:ions?(?:läge(?:t)?)?|era)\b/i, // SV: "introspektion", "introspektionsläge(t)", "introspektera"
  // "your / this site's / deepresearch's source code | codebase | implementation | architecture"
  /\b(?:your|this\s+site'?s?|the\s+site'?s?|deepresearch(?:\.se)?'?s?)\s+(?:own\s+)?(?:source\s*(?:code|files?|tree)|code\s?base|implementation|architecture)\b/i,
  // SV counterpart: "din/er/sajtens/webbplatsens källkod(en)/kodbas(en)/implementation(en)/arkitektur(en)"
  /\b(?:din|dina|er|era|sajtens|sidans|webbplatsens|deepresearch(?:\.se)?s?)\s+(?:egen\s+)?(?:källkod(?:en)?|kodbas(?:en)?|implementation(?:en)?|implementering(?:en)?|arkitektur(?:en)?)\b/i,
  /\bhow\s+(?:are|were)\s+you\s+(?:built|implemented|coded|programmed|written)\b/i,
  /\bhur\s+är\s+du\s+(?:byggd|implementerad|kodad|programmerad|skriven)\b/i,
  /\bthe\s+code\s+behind\s+(?:you|this\s+site|the\s+site)\b/i,
  /\b(?:koden|källkoden)\s+bakom\s+(?:dig|sajten|siten|sidan|webbplatsen)\b/i,
];

/**
 * Deterministic "asks about this site's own source" gate for ONE message.
 * @param {unknown} text
 * @returns {boolean}
 */
export function introspectionIntent(text) {
  const s = String(text || "");
  return INTROSPECTION_PATTERNS.some((re) => re.test(s));
}

// Cheap pre-filter before fetching/parsing the (multi-MB) snapshot just for
// the exact-path trigger: the text must carry something path-shaped from this
// repo's top levels, or a distinctive root file. Shared by the server
// enrichment (src/introspect.js) and the client mount gate (stream.js/drc.js).
const MAYBE_REPO_PATH_RE =
  /(?:^|[\s`'"(])(?:src|public|scripts|docs|tests|\.claude)\/[\w./-]+\.\w+|CLAUDE\.md|SECURITY-RISKS\.md|wrangler\.toml/i;

/**
 * @param {unknown} text
 * @returns {boolean} whether the text might name a snapshot path at all
 */
export function maybeRepoPathMention(text) {
  return MAYBE_REPO_PATH_RE.test(String(text || ""));
}

/**
 * Introspection is a MODE: once any user message in the conversation engaged
 * it, follow-ups ("what does that function do?") stay in it — the caller
 * passes every user text. A directory-qualified snapshot path named in any
 * message engages it too ("read src/pipeline.js"); bare basenames don't
 * (too generic — "index.js" appears in ordinary questions).
 * @param {string[]} userTexts every user message's text, oldest first
 * @param {Snapshot | null} [snapshot] optional — enables the path trigger
 * @returns {boolean}
 */
export function introspectionActive(userTexts, snapshot = null) {
  const texts = Array.isArray(userTexts) ? userTexts : [];
  if (texts.some((t) => introspectionIntent(t))) return true;
  if (!snapshot) return false;
  return texts.some((t) => mentionedSnapshotPaths(t, snapshot, { exactOnly: true }).length > 0);
}

// ---- external-source intent (EN + SV, deterministic) -------------------------

// Whether a message EXPLICITLY wants outside material — web search, cited
// sources, current/recent facts, or a comparison against something external.
// In developer mode the pipeline answers from the site's OWN injected source by
// default (leaning toward pure introspection), and only runs the web/HF search
// wave when this gate fires — so it is deliberately CONSERVATIVE (clear signals
// only). Anchored away from introspection false-friends: "current"/"latest"
// alone don't count (a question about the site's CURRENT code is still
// introspection), only their outward-facing phrasings ("latest news", "up to
// date") do. Swedish forms carry the same breadth (invariant 6).
const EXTERNAL_SOURCE_PATTERNS = [
  // Explicit web / internet search requests.
  /\b(?:search|look)\s+(?:it\s+|them\s+)?(?:up\s+)?(?:on|in|across|the)?\s*(?:the\s+)?(?:web|internet|online)\b/i,
  /\bweb\s+search\b/i,
  /\bgoogle\s+(?:it|this|that|for|search)\b/i,
  /\bon\s+the\s+(?:web|internet)\b/i,
  /\bfrom\s+the\s+(?:web|internet)\b/i,
  // Sources / references / citations from outside.
  /\b(?:find|fetch|get|cite|with|use|external|provide|include|add)\s+(?:me\s+)?(?:some\s+|real\s+|actual\s+)?(?:web\s+|online\s+|external\s+)?(?:sources?|references?|citations?|links?)\b/i,
  /\bexternal\s+(?:sources?|references?|links?|docs?|documentation|material)\b/i,
  // Currency / recency, outward-facing only (not bare "current"/"latest").
  /\b(?:latest|recent|newest|current)\s+(?:news|developments?|updates?|research|papers?|articles?|releases?|trends?)\b/i,
  /\bup[\s-]?to[\s-]?date\b/i,
  /\bwhat'?s\s+new\b/i,
  /\bcurrent\s+events?\b/i,
  // Comparison against something external ("compare [our X] with/to/against …").
  /\bcompared?\b(?:\s+\S+){0,4}?\s+(?:with|to|against)\b/i,
  /\bversus\b|\bvs\.?\b/i,
  // Swedish parity.
  /\bsök(?:er|ning(?:ar)?)?\s+(?:på\s+|i\s+)?(?:nätet|webben|internet|online|google)\b/i,
  /\bwebbsökning(?:ar)?\b/i,
  /\bgoogla\b/i,
  /\bpå\s+(?:nätet|internet|webben)\b/i,
  /\b(?:hitta|ange|ge|använd|med|externa|inkludera)\s+(?:mig\s+)?(?:några\s+|riktiga\s+)?(?:web[b]?\s+|online\s+|externa\s+)?källor\b/i,
  /\bexterna\s+(?:källor|referenser|länkar)\b/i,
  /\b(?:senaste|aktuella?|nyaste)\s+(?:nyheter(?:na)?|nytt|utveckling(?:en|ar)?|forskning(?:en)?|uppdateringar(?:na)?|artiklar(?:na)?|släpp(?:en)?|trender(?:na)?)\b/i,
  /\bjämför[t]?\b(?:\s+\S+){0,4}?\s+(?:med|mot)\b/i,
];

/**
 * Deterministic "the user explicitly wants outside material" gate for ONE
 * message — the switch that re-enables the web/HF search wave in developer
 * mode. Conservative by design (see EXTERNAL_SOURCE_PATTERNS).
 * @param {unknown} text
 * @returns {boolean}
 */
export function externalSourceIntent(text) {
  const s = String(text || "");
  return EXTERNAL_SOURCE_PATTERNS.some((re) => re.test(s));
}

// ---- security-assessment intent (EN + SV, deterministic) ---------------------

// Whether a message asks for a SECURITY ASSESSMENT (audit / review / pentest /
// threat model / "how secure is this"). In introspection mode this gate decides
// whether to ALSO inject the OWASP Top 10 reference block (src/introspect.js):
// the retrieved OWASP paragraphs the model quotes and classifies findings
// against. Anchored to security specifically so an ordinary "review this code"
// or "audit the logic" doesn't trip it — the word "security"/"säkerhet" (or a
// security-specific term like pentest / OWASP / threat model) must be present.
// Swedish forms carry the same breadth as English (invariant 6).
const SECURITY_ASSESSMENT_PATTERNS = [
  // "security assessment/audit/review/analysis/posture/evaluation" (any order).
  /\bsecurity\s+(?:assessment|audit|review|analysis|posture|evaluation|appraisal|examination)\b/i,
  /\b(?:assessment|audit|review|analysis|evaluation)\s+of\s+(?:the\s+)?security\b/i,
  // "assess/audit/evaluate/review/analyse … security" within a short span.
  /\b(?:assess|audit|evaluate|review|analy[sz]e|examine|check|test)\b(?:\s+\S+){0,6}?\s+(?:the\s+)?security\b/i,
  // security-specific vulnerability wording.
  /\bsecurity\s+(?:vulnerabilit(?:y|ies)|weakness(?:es)?|flaws?|holes?|issues?|risks?|threats?)\b/i,
  /\bvulnerabilit(?:y|ies)\s+(?:assessment|analysis|scan|review|audit)\b/i,
  /\bthreat\s*model(?:l?ing)?\b/i,
  /\bpen(?:etration)?[\s-]?test(?:ing|s|er)?\b/i,
  /\bhow\s+secure\b/i,
  /\bowasp\b/i,
  // Swedish parity.
  /\bsäkerhets(?:bedömning|granskning|analys|revision|utvärdering|genomgång|översyn|test(?:ning)?|brist(?:er)?|hål|risk(?:er)?|sårbarhet(?:er)?)(?:en|ar|arna)?\b/i,
  /\b(?:bedöm|granska|utvärdera|analysera|se\s+över|testa|kontrollera)\b(?:\s+\S+){0,6}?\s+säkerheten?\b/i,
  /\bsårbarhets(?:analys|bedömning|skanning|granskning|revision)\b/i,
  /\bhot(?:modell(?:ering)?|bild)\b/i,
  /\bpenetrationstest(?:a|ning|er|are)?\b/i,
  /\bpentest(?:a|ning|er)?\b/i,
  /\bhur\s+säker\b/i,
];

/**
 * Deterministic "asks for a security assessment" gate for ONE message (EN+SV) —
 * the switch that adds the OWASP Top 10 reference block in introspection mode.
 * @param {unknown} text
 * @returns {boolean}
 */
export function securityAssessmentIntent(text) {
  const s = String(text || "");
  return SECURITY_ASSESSMENT_PATTERNS.some((re) => re.test(s));
}

// ---- help intent (EN + SV, deterministic) --------------------------------------

// Whether a message is a HELP-shaped ask — "how do I…", "what does X do",
// "where do I find…", "can I…", or an explicit ask for help/guide/manual. Help
// mode is a SPECIAL VERSION of introspection: the docs block is injected in
// dev mode regardless (the same no-brittle-gate lesson as the source
// injection, chat_logs #275), so this gate never decides WHETHER the
// documentation is available — only the EMPHASIS: a help-shaped ask widens the
// docs retrieval and labels the step as help. Deliberately generous (a false
// positive just means richer docs context); Swedish forms carry the same
// breadth as English (invariant 6).
const HELP_PATTERNS = [
  /\bhow\s+(?:do|can|would|should|does)\s+(?:i|one|you)\b/i,
  /\bhow\s+to\s+\w/i,
  /\bwhere\s+(?:do|can|would|should)\s+i\b/i,
  /\bwhere\s+(?:is|are)\s+(?:the|my)\b/i,
  /\bwhat\s+(?:is|are|does|do|happens|means?)\b/i,
  /\bcan\s+i\b/i,
  /\bhelp\b/i,
  /\b(?:user\s+)?(?:guide|manual|documentation|docs|instructions?|tutorial|walk\s?-?through)\b/i,
  // Swedish parity.
  /\bhur\s+(?:gör|kan|ska|bör|använder|fungerar)\s+(?:jag|man|du|det|den)?\b/i,
  /\bvar\s+(?:hittar|finns|ser|ligger)\b/i,
  /\bvad\s+(?:är|gör|betyder|händer|innebär)\b/i,
  /\bkan\s+(?:jag|man)\b/i,
  /\bhjälp(?:en|a)?\b/i,
  /\b(?:användar)?(?:guide(?:n)?|manual(?:en)?|dokumentation(?:en)?|instruktion(?:er|erna)?|handbok(?:en)?)\b/i,
];

/**
 * Deterministic "this is a help/usage-shaped question" gate for ONE message
 * (EN+SV) — steers the help layer's docs-retrieval emphasis and step labeling
 * in introspection mode. Never decides whether documentation is injected.
 * @param {unknown} text
 * @returns {boolean}
 */
export function helpIntent(text) {
  const s = String(text || "");
  return HELP_PATTERNS.some((re) => re.test(s));
}

// ---- snapshot validation -------------------------------------------------------

/**
 * @typedef {{ p: string, s: number, t: string }} SnapshotFile
 * @typedef {{ v: number, digest: string, count: number, bytes: number, files: SnapshotFile[] }} Snapshot
 */

/**
 * Tolerant validation of a fetched snapshot payload: returns the typed
 * snapshot or null (callers fail soft — introspection simply reports the
 * snapshot unavailable).
 * @param {unknown} value
 * @returns {Snapshot | null}
 */
export function validateSnapshot(value) {
  const v = /** @type {any} */ (value);
  if (!v || typeof v !== "object" || v.v !== 1 || !Array.isArray(v.files)) return null;
  const files = v.files.filter(
    (/** @type {any} */ f) => f && typeof f.p === "string" && f.p && typeof f.t === "string" && Number.isFinite(f.s),
  );
  if (!files.length) return null;
  return {
    v: 1,
    digest: typeof v.digest === "string" ? v.digest : "",
    count: files.length,
    bytes: files.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + (f.s || 0), 0),
    files,
  };
}

// ---- path mentions ---------------------------------------------------------------

// Candidate file-ish tokens in a message ("src/pipeline.js", "CLAUDE.md").
const PATH_TOKEN_RE = /[\w./-]*\w\.(?:js|mjs|cjs|css|html|md|json|toml|txt|sh|py|webmanifest|yml|yaml|ts)\b/gi;

/**
 * The snapshot paths a message names. Exact repo paths always match;
 * bare basenames ("pipeline.js") match only when `exactOnly` is false —
 * used for choosing what to INLINE once the mode is active, never for
 * activating it. Returns unique paths in snapshot (sorted) order.
 * @param {unknown} text
 * @param {Snapshot} snapshot
 * @param {{ exactOnly?: boolean }} [opts]
 * @returns {string[]}
 */
export function mentionedSnapshotPaths(text, snapshot, opts = {}) {
  const tokens = String(text || "").match(PATH_TOKEN_RE) || [];
  if (!tokens.length) return [];
  const lower = new Set(tokens.map((t) => t.toLowerCase().replace(/^\.?\//, "")));
  /** @type {string[]} */
  const out = [];
  for (const f of snapshot.files) {
    const p = f.p.toLowerCase();
    const base = p.slice(p.lastIndexOf("/") + 1);
    const exact = lower.has(p);
    // A unique root-level file (CLAUDE.md, wrangler.toml) IS its basename.
    const rootFile = !p.includes("/") && lower.has(base);
    const byBase = !opts.exactOnly && lower.has(base);
    if (exact || rootFile || byBase) out.push(f.p);
  }
  return out;
}

// ---- back-reference resolution -----------------------------------------------
//
// A follow-up like "read those" / "do that" (EN+SV) names no files itself — the
// files it points at were listed in a PRIOR assistant turn ("I have not re-read
// src/db.js, src/quota.js, …"). The source-read-loop PLANNER decides reads from
// the latest user message, so a contentless "those" anchors it on nothing: it
// reads no files and the answer degrades to a hallucinated "I read them" reply.
// So the source-research path resolves the referent DETERMINISTICALLY — detect
// the back-reference, then pull the paths the most recent prior turn named and
// seed them into the read loop. Fail-soft: no gate match, or no named paths, and
// the normal planner behavior is untouched.

// Demonstrative/continuation follow-ups. Anchored to an explicit demonstrative
// ("those/them/these/the rest") or a bare continuation verb so an ordinary new
// question never trips it.
const BACK_REFERENCE_PATTERNS = [
  // A verb + an explicit demonstrative — safe anywhere in the message.
  /\b(?:read|open|look\s+at|check|go\s+through|review|show\s+me|pull\s+up)\s+(?:those|them|these|the\s+(?:rest|others?|remaining|ones))\b/i,
  /\b(?:do|try|run)\s+(?:that|those|it|so)\b/i,
  /\b(?:those\s+files?|them\s+all|all\s+of\s+(?:them|those))\b/i,
  // Bare continuations — anchored to the START of the message so a long real
  // question that merely CONTAINS "continue" / "the rest" doesn't trip.
  /^\s*(?:go\s+on|go\s+ahead|carry\s+on|keep\s+going|continue|proceed|the\s+rest)\b/i,
  /^\s*(?:read|do|them|those)\b/i,
  // Swedish parity (invariant 6).
  /\b(?:läs|öppna|kolla(?:\s+på)?|titta\s+på|gå\s+igenom|granska|visa)\s+(?:dem|de(?:\s+där)?|dessa|resten|de\s+andra|de\s+(?:kvarvarande|återstående))\b/i,
  /\b(?:gör|prova|kör)\s+(?:det|de(?:t\s+där)?|så|dem)\b/i,
  /\b(?:de\s+där\s+filerna|alla\s+(?:dem|dessa))\b/i,
  /^\s*(?:fortsätt|kör\s+(?:på|vidare)|gå\s+vidare|resten)\b/i,
];

/**
 * Deterministic "this is a back-reference to a prior turn" gate (EN+SV). Kept to
 * short-ish follow-ups so a long message that merely contains "continue" or
 * "review" isn't mistaken for a bare back-reference.
 * @param {unknown} text
 * @returns {boolean}
 */
export function backReferenceIntent(text) {
  const s = String(text || "");
  if (s.trim().length > 200) return false;
  return BACK_REFERENCE_PATTERNS.some((re) => re.test(s));
}

/**
 * The snapshot paths a back-reference points at: the paths named by the most
 * recent prior text that names any (walking the given texts in order — pass
 * them MOST RECENT FIRST), bounded to `cap`. [] when nothing prior names a
 * snapshot path.
 * @param {string[]} priorTexts prior message texts, MOST RECENT FIRST
 * @param {Snapshot} snapshot
 * @param {number} [cap]
 * @returns {string[]}
 */
export function resolveReferencedPaths(priorTexts, snapshot, cap = 8) {
  for (const t of Array.isArray(priorTexts) ? priorTexts : []) {
    const paths = mentionedSnapshotPaths(t, snapshot);
    if (paths.length) return paths.slice(0, Math.max(1, cap));
  }
  return [];
}

// ---- the context block -------------------------------------------------------------

/**
 * @param {Snapshot} snapshot
 * @returns {string} the complete file index, one `path<TAB>bytes` row per file
 */
export function snapshotIndex(snapshot) {
  return snapshot.files.map((f) => `${f.p}\t${f.s}`).join("\n");
}

// ---- skills catalog ----------------------------------------------------------
//
// The repo's institutional knowledge lives as load-on-demand PLAYBOOKS under
// .claude/skills/<name>/SKILL.md — how recurring work is actually done here
// (deploy, the research pipeline, the eval batteries, the decision-board loops,
// storage/privacy, the sandbox, …). That was originally a Claude Code (the CLI
// agent) convention, so those playbooks only helped when Claude Code was the
// one working. But a SKILL.md is ordinary tracked Markdown, so it already rides
// in the source snapshot like any other file and is retrievable through the
// dense RAG index. This surfaces the whole catalog as a FIRST-CLASS section of
// the introspection block, so ANY answer model — in EITHER tier — sees the
// playbooks exist and can quote or read them by name. That's the same
// institutional knowledge Claude Code gets, now available regardless of which
// model is answering. (A vendor-neutral AGENTS.md at the repo root points
// external coding agents at the same catalog, so the pickup is model- AND
// harness-agnostic.)

/** A skill's SKILL.md path → its slug name (the catalog key). */
export const SKILL_PATH_RE = /^\.claude\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/;

/** Each catalog line's description is clipped to this in the (always-on) block. */
export const SKILL_SUMMARY_CHARS = 240;

/**
 * The first sentence of a description, clipped to `max` on a word boundary. The
 * skill descriptions front-load their trigger ("Load when …"), so one sentence
 * is a faithful one-line summary.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function firstSentence(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const dot = s.search(/\.\s/);
  let out = dot > 40 ? s.slice(0, dot + 1) : s;
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return out;
}

/**
 * Tolerant parse of a SKILL.md's `name`/`description` YAML frontmatter. The
 * bundler stores raw text, so this is a tiny purpose-built parser: the
 * frontmatter is always a leading `---` … `---` block with a `name:` line and a
 * `description:` that is usually a folded block scalar (`>-`). Missing fields
 * come back as "" — never throws.
 * @param {string} text
 * @returns {{ name: string, description: string }}
 */
export function parseSkillFrontmatter(text) {
  const m = String(text || "").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { name: "", description: "" };
  const lines = m[1].split("\n");
  const unquote = (/** @type {string} */ v) => v.replace(/^["']|["']$/g, "").trim();
  let name = "";
  let description = "";
  for (let i = 0; i < lines.length; i++) {
    const nameM = !name && lines[i].match(/^name:\s*(.+?)\s*$/);
    if (nameM) {
      name = unquote(nameM[1]);
      continue;
    }
    const descM = !description && lines[i].match(/^description:\s*(.*?)\s*$/);
    if (descM) {
      const inline = descM[1];
      if (inline && !/^[|>]/.test(inline)) {
        description = unquote(inline);
      } else {
        // Folded/literal block scalar: gather the indented continuation lines.
        const parts = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === "" || /^\s+\S/.test(lines[j])) parts.push(lines[j].trim());
          else break;
        }
        description = parts.join(" ").replace(/\s+/g, " ").trim();
      }
    }
  }
  return { name, description };
}

/**
 * Every skill present in the snapshot as { name, path, description }, sorted by
 * name. Pure over the snapshot the block already has — no I/O. [] when the
 * snapshot carries no skill files (e.g. a test fixture).
 * @param {Snapshot} snapshot
 * @returns {Array<{ name: string, path: string, description: string }>}
 */
export function skillsCatalog(snapshot) {
  const out = [];
  for (const f of (snapshot && snapshot.files) || []) {
    const m = SKILL_PATH_RE.exec(f.p);
    if (!m) continue;
    const fm = parseSkillFrontmatter(f.t);
    out.push({ name: fm.name || m[1], path: f.p, description: fm.description });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * The skills catalog rendered as one `- name — one-line summary` row per skill,
 * for the introspection block. `full: true` keeps each whole description;
 * otherwise each is clipped to its first sentence / SKILL_SUMMARY_CHARS.
 * @param {Snapshot} snapshot
 * @param {{ full?: boolean }} [opts]
 * @returns {string}
 */
export function skillsIndex(snapshot, opts = {}) {
  const full = opts && opts.full === true;
  return skillsCatalog(snapshot)
    .map((sk) => {
      const desc = full ? sk.description : firstSentence(sk.description, SKILL_SUMMARY_CHARS);
      return desc ? `- ${sk.name} — ${desc}` : `- ${sk.name}`;
    })
    .join("\n");
}

/**
 * The SKILL.md paths a message references BY NAME — the slash form (`/deploy`)
 * or "<name> skill" / "skill <name>" (hyphen-or-space tolerant, so "feedback
 * loop skill" resolves feedback-loop). Complements mentionedSnapshotPaths,
 * which needs the literal `.claude/skills/<name>/SKILL.md` path; this lets a
 * user name a skill the way they'd name it to Claude Code. Returns snapshot
 * paths so the caller inlines them like any other named file.
 * @param {unknown} text
 * @param {Snapshot} snapshot
 * @returns {string[]}
 */
export function mentionedSkills(text, snapshot) {
  const s = String(text || "");
  if (!s.trim()) return [];
  const out = [];
  for (const sk of skillsCatalog(snapshot)) {
    const n = sk.name.replace(/[-\s]+/g, "[-\\s]");
    const slash = new RegExp(`(?:^|\\s)/${n}\\b`, "i");
    const named = new RegExp(`\\b(?:${n}\\s+skill|skill\\s+${n})\\b`, "i");
    if (slash.test(s) || named.test(s)) out.push(sk.path);
  }
  return out;
}

// ---- source RAG: deterministic chunking + int8 vector index -----------------------
//
// A committed DENSE index of the source (public/introspect/source-rag.json,
// built by scripts/bundle-source-rag.mjs) lets the DRS enrichment RETRIEVE the
// chunks relevant to a question instead of relying on a brittle intent regex.
// The index stores one int8-quantized embedding per (file, chunk index) — NOT
// the chunk text: retrieval RE-CHUNKS the snapshot with the SAME deterministic
// chunker below and maps (p, ci) → text, so the vectors and the text can never
// silently drift (the freshness check enforces the chunk counts still line up).

// e5's sequence window is ~512 tokens; these mirror public/js/rag.js so a chunk
// never overflows the embedder. Kept here (not imported) so the ONE chunker is
// shared by the builder and the server with no browser-only dependency.
export const SOURCE_CHUNK_TARGET = 1400;
export const SOURCE_CHUNK_OVERLAP = 200;
const SOURCE_MAX_CHUNKS_PER_FILE = 40;

/**
 * Deterministic source chunker — the SAME algorithm public/js/rag.js chunkText
 * uses, self-contained. Both the index builder and retrieval call this, so a
 * chunk's vector always corresponds to the same slice of text.
 * @param {string} text
 * @returns {string[]}
 */
export function chunkSourceText(text) {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < SOURCE_MAX_CHUNKS_PER_FILE) {
    let end = Math.min(start + SOURCE_CHUNK_TARGET, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const brk = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (brk > SOURCE_CHUNK_TARGET * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - SOURCE_CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

/**
 * Every (file, chunk) of the snapshot, in a stable order — the index is built
 * against this order and retrieval maps back through it.
 * @param {Snapshot} snapshot
 * @returns {Array<{ p: string, ci: number, text: string }>}
 */
export function snapshotChunks(snapshot) {
  const out = [];
  for (const f of snapshot.files) {
    const pieces = chunkSourceText(f.t);
    for (let ci = 0; ci < pieces.length; ci++) out.push({ p: f.p, ci, text: pieces[ci] });
  }
  return out;
}

// int8 quantization. Cosine similarity is scale-invariant, so we quantize each
// embedding by its own max-abs to int8 (÷ that scalar) and DON'T store the
// scale — it cancels in the cosine. A 1024-d vector loses ~1/127 relative
// precision per component, far below what changes top-k ranking.
/**
 * @param {ArrayLike<number>} vec
 * @returns {Int8Array}
 */
export function quantizeInt8(vec) {
  let max = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > max) max = a;
  }
  const out = new Int8Array(vec.length);
  if (!max) return out;
  const s = 127 / max;
  for (let i = 0; i < vec.length; i++) {
    let q = Math.round(vec[i] * s);
    if (q > 127) q = 127;
    else if (q < -127) q = -127;
    out[i] = q;
  }
  return out;
}

/** @param {Int8Array} arr @returns {string} */
export function int8ToB64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa exists in browsers AND Node ≥16 (global) — the whole module is
  // written to run in both, like the rest of introspect-core.
  return btoa(bin);
}

/** @param {string} b64 @returns {Int8Array} */
export function b64ToInt8(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24; // to signed
  return out;
}

/**
 * Cosine similarity between a float query vector and an int8 chunk vector. The
 * int8's arbitrary per-vector scale cancels, so the result matches the cosine
 * of the original float vectors to within quantization noise.
 * @param {ArrayLike<number>} q
 * @param {Int8Array} c
 * @returns {number}
 */
export function cosineF32Int8(q, c) {
  let dot = 0;
  let nq = 0;
  let nc = 0;
  const n = Math.min(q.length, c.length);
  for (let i = 0; i < n; i++) {
    dot += q[i] * c[i];
    nq += q[i] * q[i];
    nc += c[i] * c[i];
  }
  const denom = Math.sqrt(nq) * Math.sqrt(nc);
  return denom ? dot / denom : 0;
}

/**
 * @typedef {{ v: number, model: string, dims: number, target: number, overlap: number, hashes: Record<string, string>, vectors: string[], map: Array<{ p: string, ci: number }> }} RagIndex
 */

/**
 * Tolerant validation of a fetched source-rag index. Returns the typed index
 * or null (callers fail soft to snapshot-only introspection). `hashes` (per-
 * file content hash) is used only by the builder for DELTA rebuilds — it
 * re-embeds a file's chunks only when its hash changed — so it's optional and
 * retrieval ignores it.
 * @param {unknown} value
 * @returns {RagIndex | null}
 */
export function validateRagIndex(value) {
  const v = /** @type {any} */ (value);
  if (!v || typeof v !== "object" || v.v !== 1) return null;
  if (!Array.isArray(v.vectors) || !Array.isArray(v.map)) return null;
  if (v.vectors.length !== v.map.length || !v.vectors.length) return null;
  if (!v.map.every((/** @type {any} */ m) => m && typeof m.p === "string" && Number.isInteger(m.ci))) return null;
  return {
    v: 1,
    model: typeof v.model === "string" ? v.model : "",
    dims: Number(v.dims) || 0,
    target: Number(v.target) || SOURCE_CHUNK_TARGET,
    overlap: Number(v.overlap) || SOURCE_CHUNK_OVERLAP,
    hashes: v.hashes && typeof v.hashes === "object" && !Array.isArray(v.hashes) ? v.hashes : {},
    vectors: v.vectors,
    map: v.map,
  };
}

/**
 * Retrieve the top-k source chunks most similar to the query embedding.
 * Re-chunks the snapshot (via the shared chunker) to resolve each indexed
 * (p, ci) back to its text — so the returned text is always the CURRENT
 * source. A (p, ci) that no longer resolves (source shrank) is skipped.
 * @param {RagIndex} index
 * @param {Snapshot} snapshot
 * @param {ArrayLike<number>} queryVec
 * @param {number} [k]
 * @returns {Array<{ p: string, ci: number, text: string, score: number }>}
 */
export function retrieveSourceChunks(index, snapshot, queryVec, k = 6) {
  if (!index || !snapshot || !queryVec || !queryVec.length) return [];
  // file path → its ordered chunk texts (chunked lazily, once per retrieval).
  /** @type {Map<string, string[] | null>} */
  const byFile = new Map();
  for (const f of snapshot.files) byFile.set(f.p, null); // lazy
  /** @param {string} p @returns {string[]} */
  const chunksOf = (p) => {
    let c = byFile.get(p);
    if (c === null || c === undefined) {
      const f = snapshot.files.find((x) => x.p === p);
      c = f ? chunkSourceText(f.t) : [];
      byFile.set(p, c);
    }
    return c || [];
  };
  const scored = [];
  for (let i = 0; i < index.vectors.length; i++) {
    const m = index.map[i];
    const texts = chunksOf(m.p);
    if (m.ci >= texts.length) continue; // source changed under this vector
    const c = b64ToInt8(index.vectors[i]);
    scored.push({ p: m.p, ci: m.ci, text: texts[m.ci], score: cosineF32Int8(queryVec, c) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

/**
 * Build the labeled introspection context block appended to the conversation
 * (the Shodan-block convention: plain text, explicit begin/end markers, and
 * the material is CONTEXT — with one capability line so the model doesn't
 * deny having its own source, the hasShell lesson).
 * @param {Snapshot} snapshot
 * @param {{
 *   latestText?: string,        // the latest user message — drives named-file inlining
 *   sandboxMounted?: boolean,   // the /src tree will be available in the Linux VM
 *   retrieved?: Array<{ p: string, text: string, score?: number }>, // RAG-retrieved source chunks
 *   includeIndex?: boolean,     // include the full file index (default true) — off keeps the always-on block lean
 * }} [opts]
 * @returns {string}
 */
export function buildIntrospectionBlock(snapshot, opts = {}) {
  const lines = [];
  lines.push("--- Introspection: deepresearch.se source (developer mode) ---");
  lines.push(
    `This conversation is in INTROSPECTION MODE. You are given the ACTUAL source code of the deepresearch.se deployment answering right now (${snapshot.count} files, ${snapshot.bytes} bytes` +
      (snapshot.digest ? `, digest ${snapshot.digest.slice(0, 12)}` : "") +
      "). You DO have this site's own source here — when the user asks about how the site works, what its code does, or for code examples FROM this project, answer from the material below, quoting real snippets and citing file paths. Never say you have no access to the source or that this isn't a coding tool: in this mode you do and it is.",
  );
  if (opts.sandboxMounted) {
    lines.push(
      "The complete tree is ALSO mounted at /src inside the Linux sandbox (e.g. /src/src/pipeline.js) — shell commands over it (ls, cat, grep -rn) read anything not shown below.",
    );
  }

  // RAG: the source chunks most relevant to THIS question (dense retrieval over
  // the committed source-rag index). This is what makes the mode work for any
  // phrasing — the model gets the pertinent code without the user naming files.
  const retrieved = Array.isArray(opts.retrieved) ? opts.retrieved.filter((r) => r && r.text) : [];
  if (retrieved.length) {
    lines.push("");
    lines.push("# Source excerpts most relevant to this question (retrieved from the project's own code):");
    for (const r of retrieved) {
      lines.push("");
      lines.push(`## ${r.p}`);
      lines.push("```");
      lines.push(r.text);
      lines.push("```");
    }
  }

  if (opts.includeIndex !== false) {
    lines.push("");
    lines.push("# Full file index (path\tbytes) — ask for any of these by name for its full contents:");
    lines.push(snapshotIndex(snapshot));
  } else {
    lines.push("");
    lines.push(`# The full project is ${snapshot.count} files; name any file path (e.g. src/pipeline.js) and its complete contents are provided.`);
  }

  // Skills — the repo's load-on-demand PLAYBOOKS (institutional knowledge:
  // how deploys, the pipeline, the eval batteries, the board loops, storage,
  // the sandbox, etc. are actually done here). Surfaced as a catalog so any
  // answer model can quote or read them by name — the same knowledge Claude
  // Code works from, now available regardless of model or tier.
  const skills = skillsCatalog(snapshot);
  if (skills.length) {
    lines.push("");
    lines.push(
      `# Skills — the project's ${skills.length} institutional playbooks (.claude/skills/<name>/SKILL.md). These encode how recurring work is actually done here; the same catalog also guides any coding agent via the repo's AGENTS.md. Name any (e.g. "the deploy skill" or /deploy) for its full text, or just ask — the relevant one is retrieved into context:`,
    );
    lines.push(skillsIndex(snapshot));
  }

  // Orientation: CLAUDE.md is the repo's own structured architecture map —
  // its opening (project description + code layout) is the best fixed-cost
  // orientation the block can carry.
  const claude = snapshot.files.find((f) => f.p === "CLAUDE.md");
  if (claude) {
    lines.push("");
    lines.push(`# CLAUDE.md — architecture orientation (first ${ORIENTATION_CHARS} chars)`);
    lines.push(clip(claude.t, ORIENTATION_CHARS));
  }

  // Named files: inline in full (capped) what the latest message points at —
  // by path (mentionedSnapshotPaths) OR by skill name ("the deploy skill"),
  // deduped so naming a skill inlines its whole SKILL.md.
  const named = [
    ...mentionedSnapshotPaths(opts.latestText, snapshot),
    ...mentionedSkills(opts.latestText, snapshot),
  ]
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, MAX_INLINE_FILES);
  let inlined = 0;
  for (const p of named) {
    if (p === "CLAUDE.md") continue; // already carried above
    const f = snapshot.files.find((x) => x.p === p);
    if (!f) continue;
    if (inlined >= MAX_INLINE_TOTAL_CHARS) {
      lines.push("");
      lines.push(`# ${p} — not inlined (block budget reached; read it at /src/${p} in the sandbox)`);
      continue;
    }
    const budget = Math.min(MAX_INLINE_FILE_CHARS, MAX_INLINE_TOTAL_CHARS - inlined);
    const text = clip(f.t, budget);
    inlined += text.length;
    lines.push("");
    lines.push(`# ${p} (${f.s} bytes${text.length < f.t.length ? ", truncated" : ""})`);
    lines.push(text);
  }

  lines.push("");
  lines.push("--- End of introspection source ---");
  return "\n\n" + lines.join("\n");
}

/** @param {string} t @param {number} max */
function clip(t, max) {
  return t.length <= max ? t : t.slice(0, max) + "\n… [truncated — full file in the snapshot/sandbox]";
}

// ---- the OWASP Top 10 reference block ----------------------------------------
//
// When an introspection conversation asks for a SECURITY ASSESSMENT
// (securityAssessmentIntent), src/introspect.js retrieves the OWASP paragraphs
// most relevant to the question from the committed OWASP corpus/index (via the
// SAME retrieveSourceChunks used for source) and appends this labeled block, so
// the model can classify findings against the real OWASP categories and quote
// the actual OWASP wording rather than paraphrasing from memory. The block
// carries the default-framework + CVSS-with-uncertainty instruction so the
// behavior holds even when the answer path's system prompt is terse.

/**
 * @param {Array<{ p: string, text: string, score?: number }>} retrieved OWASP chunks (retrieveSourceChunks output; p is the doc id)
 * @param {Record<string, { cat?: string, family?: string, year?: string, title?: string, url?: string }>} [sources] per-doc citation metadata (owasp-corpus.json `sources`)
 * @returns {string} the labeled reference block ("" when nothing was retrieved)
 */
export function buildOwaspReferenceBlock(retrieved, sources = {}) {
  const list = (Array.isArray(retrieved) ? retrieved : []).filter((r) => r && r.p && typeof r.text === "string" && r.text);
  if (!list.length) return "";
  const lines = [];
  lines.push("--- OWASP Top 10 reference (for this security assessment) ---");
  lines.push(
    "This is a SECURITY ASSESSMENT. Unless the user named a different standard, organize and classify every finding using the OWASP Top 10 for LLM Applications (2025) and the OWASP Top 10 for Web Applications (2021): map each finding to the most relevant OWASP category and cite its identifier (e.g. LLM01:2025 Prompt Injection, A01:2021 Broken Access Control). Give each finding a CVSS v3.1 base-score estimate (with the vector string where you can) and STATE THE UNCERTAINTY EXPLICITLY — flag when a score is a rough estimate or hinges on deployment factors or code you could not see. The verbatim OWASP passages below were retrieved for THIS question: quote them directly and attribute them to their category id and URL.",
  );
  lines.push(
    "Structure the report in this order, each under its own heading: (1) `## Executive Summary` FIRST — a few plain-language sentences facing the reader immediately: overall posture, the most serious issues and their risk, and finding counts by severity (no file paths or CVSS vectors here). (2) `## Scope` — what was assessed and what was not, plus assumptions and limitations. (3) `## Findings` — the technical detail, one per finding (OWASP category id, CVSS score+vector+uncertainty, affected file path/function, evidence, remediation), highest severity first. The Executive Summary replaces the usual one-line conclusion.",
  );
  for (const r of list) {
    const meta = (sources && sources[r.p]) || {};
    const cite = meta.url ? `${r.p} — ${meta.url}` : r.p;
    lines.push("");
    lines.push(`## ${cite}`);
    lines.push("```");
    lines.push(r.text);
    lines.push("```");
  }
  lines.push("");
  lines.push("--- End of OWASP Top 10 reference ---");
  return "\n\n" + lines.join("\n");
}

// ---- OWASP retrieval: category diversity + an OFFLINE lexical path ------------
//
// A security assessment should quote MULTIPLE different OWASP vulnerabilities,
// not cluster on the single closest one — so retrieval caps how many chunks it
// takes per category and backfills, guaranteeing breadth. And because the whole
// point of the committed corpus is to work SELF-CONTAINED, there's an
// embedding-FREE lexical retrieval (TF-IDF over the corpus) so the OWASP block
// is available with NO embedder at all — that's the path DRC (the client-side
// Se/cure tier, no Berget e5) uses, and the fallback DRS uses when the query
// embed is unavailable. Both are pure and Node-tested.

/**
 * The OWASP category id of a corpus key ("LLM01:2025 Prompt Injection" →
 * "LLM01:2025"). The corpus key is `<id> <title>`, so it's the leading token.
 * @param {string} p
 * @returns {string}
 */
export function owaspCategoryOf(p) {
  const s = String(p || "");
  const i = s.indexOf(" ");
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * Take the top-k chunks while capping how many come from any ONE OWASP category
 * (greedy over the already-score-sorted list; backfill from the remainder if the
 * per-category cap left fewer than k). Guarantees the returned set spans several
 * categories when the corpus has them — the "multiple different vulnerabilities"
 * requirement — instead of k near-duplicate chunks from the closest doc.
 * @template {{ p: string }} T
 * @param {T[]} scored chunks sorted by descending relevance
 * @param {number} [k]
 * @param {number} [perCat]
 * @returns {T[]}
 */
export function diversifyByCategory(scored, k = 8, perCat = 2) {
  const list = Array.isArray(scored) ? scored : [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {T[]} */
  const picked = [];
  /** @type {T[]} */
  const overflow = [];
  for (const c of list) {
    if (picked.length >= k) break;
    const cat = owaspCategoryOf(c.p);
    const n = seen.get(cat) || 0;
    if (n < perCat) {
      seen.set(cat, n + 1);
      picked.push(c);
    } else {
      overflow.push(c);
    }
  }
  // Backfill (still score order) if the cap starved us below k.
  for (const c of overflow) {
    if (picked.length >= k) break;
    picked.push(c);
  }
  return picked;
}

// Words too common to help lexical ranking (EN + a little SV). Kept small — the
// corpus is domain text, so ordinary content words ARE the signal.
const OWASP_STOPWORDS = new Set(
  ("the a an and or of to in on for with is are be been being this that these those it its as at by from into over under " +
    "can could should would may might will shall do does did has have had not no nor but if then else when where which who whom " +
    "you your yours we our us they their them he she his her out up down off about than so such very more most other some any all " +
    "att och en ett som det den de för med av till på är var det här den där inte kan ska att om men eller vad vem vilka hur")
    .split(/\s+/),
);

/** @param {string} s @returns {string[]} content terms, lowercased, ≥3 chars, no stopwords */
function owaspTerms(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9åäöé]+/i)
    .filter((w) => w.length >= 3 && !OWASP_STOPWORDS.has(w));
}

/**
 * OFFLINE lexical retrieval over a snapshot-shaped corpus — NO embeddings.
 * Scores each corpus chunk by TF-IDF overlap with the query's content terms
 * (df computed across the corpus's own chunks), then applies the per-doc/
 * category diversity cap (diversifyByCategory keys on the corpus key's leading
 * token — the OWASP category id, or the whole path for the docs corpus, i.e. a
 * per-doc cap). This is what lets a committed corpus work fully self-contained:
 * DRC uses it (no Berget e5 in the browser) for BOTH the OWASP corpus and the
 * help docs corpus, and DRS falls back to it when the query embed is
 * unavailable. Deterministic and never throws.
 * @param {Snapshot} corpus a snapshot-shaped corpus (files:[{p,s,t}])
 * @param {string} query
 * @param {{ k?: number, perCat?: number }} [opts]
 * @returns {Array<{ p: string, ci: number, text: string, score: number }>}
 */
export function lexicalRetrieveCorpus(corpus, query, opts = {}) {
  const k = opts.k || 8;
  const perCat = opts.perCat || 2;
  const chunks = snapshotChunks(corpus); // [{p,ci,text}]
  if (!chunks.length) return [];
  const qTerms = [...new Set(owaspTerms(query))];
  if (!qTerms.length) return [];
  // Per-chunk term sets + document frequency of each query term.
  const chunkTerms = chunks.map((c) => owaspTerms(c.text));
  const df = new Map();
  for (const t of qTerms) {
    let d = 0;
    for (const terms of chunkTerms) if (terms.includes(t)) d++;
    df.set(t, d);
  }
  const N = chunks.length;
  const scored = chunks.map((c, i) => {
    const terms = chunkTerms[i];
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const w of terms) tf.set(w, (tf.get(w) || 0) + 1);
    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const d = df.get(t) || 0;
      const idf = Math.log((N + 1) / (d + 0.5)); // smoothed, always > 0
      score += (1 + Math.log(f)) * idf;
    }
    // Normalize by chunk length so long chunks don't dominate on raw counts.
    const norm = score / Math.sqrt(Math.max(1, terms.length));
    return { p: c.p, ci: c.ci, text: c.text, score: norm };
  });
  scored.sort((a, b) => b.score - a.score);
  return diversifyByCategory(
    scored.filter((c) => c.score > 0),
    k,
    perCat,
  );
}

// The original OWASP-named export, kept as a pure alias so existing callers
// and tests are untouched (the function was always corpus-generic).
export const lexicalRetrieveOwasp = lexicalRetrieveCorpus;

// ---- the HELP documentation block ---------------------------------------------
//
// Help mode is a SPECIAL VERSION of introspection: one interface that answers
// everything from "what does the ghost button do?" down to "prove the server
// never sees the vault key". The DOCUMENTATION is the first layer — a help/
// usage question is answered from the committed docs corpus near-verbatim
// (structure, wording, images with their captions, links) — and the SOURCE is
// the deeper support level a follow-up escalates into (the retrieved excerpts
// / native tools / read loop introspection mode already provides). This block
// carries the retrieved doc passages plus their resolved SYMBOL references so
// every documented claim links to the implementation that proves it.

/** How many symbol references the block lists (deduped, relevance-filtered). */
export const MAX_HELP_SYMBOLS = 20;

/**
 * The docs corpus's help-specific metadata riding alongside the snapshot
 * fields (scripts/bundle-docs.mjs): per-doc titles, per-doc resolved symbol
 * references, and the public repo's blob base URL for clickable links.
 * Tolerant — missing/malformed fields come back empty, never a throw.
 * @param {unknown} raw the parsed docs-corpus.json
 * @returns {{ sources: Record<string, { title?: string }>, symbols: Record<string, Array<{ sym: string, file: string, line?: number }>>, repo: string }}
 */
export function docsCorpusMeta(raw) {
  const v = /** @type {any} */ (raw && typeof raw === "object" ? raw : {});
  const obj = (/** @type {any} */ x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  return {
    sources: obj(v.sources),
    symbols: obj(v.symbols),
    repo: typeof v.repo === "string" ? v.repo : "",
  };
}

/**
 * The symbol references relevant to a set of retrieved doc chunks: the
 * corpus's per-doc resolved symbols, kept only when the symbol actually
 * appears in a retrieved chunk's text, deduped by (sym, file), capped.
 * @param {Array<{ p: string, text: string }>} retrieved
 * @param {Record<string, Array<{ sym: string, file: string, line?: number }>>} symbols
 * @param {number} [cap]
 * @returns {Array<{ sym: string, file: string, line?: number }>}
 */
export function helpSymbolRefs(retrieved, symbols, cap = MAX_HELP_SYMBOLS) {
  const list = Array.isArray(retrieved) ? retrieved : [];
  const joined = list.map((r) => String(r?.text || "")).join("\n");
  const out = [];
  const seen = new Set();
  for (const r of list) {
    for (const s of (symbols && symbols[r?.p]) || []) {
      if (!s || !s.sym || !s.file) continue;
      const key = s.sym + "\0" + s.file;
      if (seen.has(key)) continue;
      if (!joined.includes(s.sym)) continue; // only symbols the quoted passages actually show
      seen.add(key);
      out.push(s);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * Build the labeled HELP documentation block appended to the conversation in
 * developer mode (the OWASP-block convention: explicit begin/end markers, the
 * instruction carried INSIDE the block so it holds on any answer path). The
 * doc passages are quoted VERBATIM — unfenced, because documentation contains
 * its own fenced code blocks — so the model can mirror them, image lines and
 * caption lines included. "" when nothing was retrieved.
 * @param {Array<{ p: string, text: string, score?: number }>} retrieved docs chunks (retrieveSourceChunks / lexicalRetrieveCorpus output)
 * @param {{ sources?: Record<string, { title?: string }>, symbols?: Record<string, Array<{ sym: string, file: string, line?: number }>>, repo?: string, helpAsk?: boolean }} [opts]
 * @returns {string}
 */
export function buildHelpDocsBlock(retrieved, opts = {}) {
  const list = (Array.isArray(retrieved) ? retrieved : []).filter((r) => r && r.p && typeof r.text === "string" && r.text);
  if (!list.length) return "";
  const sources = (opts && opts.sources) || {};
  const symbols = (opts && opts.symbols) || {};
  const repo = (opts && opts.repo) || "";
  const lines = [];
  lines.push("--- Site documentation (help layer) ---");
  lines.push(
    "These are the passages of this project's OWN documentation most relevant to the question, quoted VERBATIM from the committed docs this deployment serves. This is the help interface's FIRST layer:",
  );
  lines.push(
    "- For a usage / how-do-I / what-is question, answer FROM this documentation, mirroring its structure and wording near-verbatim where it answers the question: keep headings, lists, tables, links, and IMAGE lines exactly as written — reproduce `![caption](/introspect/docs-img/…)` image references together with any italic caption line under them (the chat renders these images inline).",
  );
  lines.push(
    "- Attach source references: when your answer shows a code symbol or file the documentation names, add its reference from the symbol list below (path, line, link) so every documented claim is traceable to the implementation.",
  );
  lines.push(
    "- The documentation is the first layer, not the last: when the user asks HOW something is implemented, challenges a documented claim, or wants proof, go DEEPER — investigate the actual source code available in this mode and ground the conclusion in the code you read, citing file paths. Documentation describes intent; the source is the truth.",
  );
  for (const r of list) {
    const title = sources[r.p] && sources[r.p].title ? ` — "${sources[r.p].title}"` : "";
    lines.push("");
    lines.push(`# ${r.p}${title} (verbatim excerpt)`);
    lines.push(r.text);
  }
  const refs = helpSymbolRefs(list, symbols);
  if (refs.length) {
    lines.push("");
    lines.push("# Symbol references (named by these docs, resolved to the source):");
    for (const s of refs) {
      const loc = s.line ? `${s.file}:${s.line}` : s.file;
      const link = repo ? ` (${repo}${s.file}${s.line ? `#L${s.line}` : ""})` : "";
      lines.push(`- \`${s.sym}\` — ${loc}${link}`);
    }
  }
  lines.push("");
  lines.push("--- End of site documentation ---");
  return "\n\n" + lines.join("\n");
}

// ---- the agentic source-read loop (the "read files as it wants" tool) --------
//
// For an introspection question, the pipeline does REAL research in the actual
// source instead of a single RAG-retrieved reply: the model is given a SITEMAP
// (every file + a one-line description) and, round by round, asks to READ the
// files it needs; the loop resolves each request against the snapshot, feeds
// the file text back, and loops until the model has gathered enough to answer.
// This is the source-code counterpart of the bash-lite agent (bash-core.js):
// NO function calling (invariant 1) — the read request is a plain JSON object,
// so it works on any catalog model — and fully fail-soft (a bad step, an empty
// proposal, or a missing file all just end the round with what was gathered).
//
// Everything here is pure and I/O-free (Node-tested): WHO answers the step and
// HOW the file bytes are fetched are injected, so the server (src/pipeline.js
// via the snapshot the enrichment loaded) and any future client tier share one
// driver.

// Caps — the loop is bounded so a runaway (or hostile) model can't blow the
// context window or spin forever. Sized so the gathered source fits alongside
// the sitemap on the reliable JSON model that drives the loop. This whole read
// loop only runs in developer mode (the introspection-first source-research
// path, src/pipeline.js runSourceResearch), so these caps ARE the developer
// exploration profile — leaned generously so the model gets several rounds to
// follow its own curiosity through the tree (reading files as it wants) before
// we make it answer regardless, rather than forcing a verdict after a glance.
export const MAX_SOURCE_READ_ROUNDS = 6; // agentic read rounds before we answer regardless
export const MAX_FILES_PER_ROUND = 6; // file paths accepted from one model turn
export const MAX_READ_FILE_CHARS = 16_000; // one file's text kept, truncated beyond
export const MAX_READ_TOTAL_CHARS = 60_000; // all files read together

/**
 * A one-line, human-readable description of a source file, extracted from its
 * own leading comment (this codebase opens almost every file with a `//` or
 * `/* *\/` header describing it) or, for Markdown, its first line. Deterministic
 * and best-effort — "" when the file has no usable header. Powers the sitemap.
 * @param {string} path
 * @param {string} text
 * @returns {string}
 */
export function fileSummary(path, text) {
  const p = String(path || "");
  const t = String(text || "");
  if (!t) return "";
  if (/\.md$/i.test(p)) {
    // The first PROSE line describes the doc; a leading heading is usually just
    // the title (often the filename) — keep it only as a fallback.
    let fallback = "";
    for (const line of t.split("\n")) {
      const raw = line.trim();
      if (!raw) continue;
      if (raw.startsWith("#")) {
        if (!fallback) fallback = clipSummary(raw.replace(/^#+\s*/, ""));
        continue;
      }
      if (raw.startsWith(">") || raw.startsWith("<!--")) continue;
      return clipSummary(raw);
    }
    return fallback;
  }
  const lines = t.split("\n");
  /** @type {string[]} */
  const parts = [];
  let inBlock = false;
  for (let i = 0; i < lines.length && i < 30; i++) {
    let line = lines[i].trim();
    if (!line) {
      if (parts.length) break; // blank line ends the header once we have content
      continue;
    }
    if (inBlock) {
      const end = line.includes("*/");
      const body = line.replace(/\*\//, "").replace(/^\*+\s?/, "").trim();
      if (body && !isSeparator(body)) parts.push(body);
      if (end) break;
      continue;
    }
    if (line === "// @ts-check" || line === "/* @ts-check */" || /^\/\/\s*@ts-check/.test(line)) continue;
    if (line.startsWith("//")) {
      const body = line.replace(/^\/\/+/, "").trim();
      if (!body || isSeparator(body)) {
        if (parts.length) break;
        continue;
      }
      parts.push(body);
      continue;
    }
    if (line.startsWith("/*")) {
      const oneLine = /\*\//.test(line);
      const body = line.replace(/^\/\*+/, "").replace(/\*\/.*/, "").trim();
      if (body && !isSeparator(body)) parts.push(body);
      if (oneLine) break;
      inBlock = true;
      continue;
    }
    break; // first real code line — no header
  }
  return clipSummary(parts.join(" "));
}

/** @param {string} s @returns {boolean} a comment rule/separator line, not prose */
function isSeparator(s) {
  return /^[-=*_#>\s]+$/.test(s) || /^-{2,}/.test(s);
}

/** @param {string} s first sentence, collapsed and clipped to ~160 chars */
function clipSummary(s) {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  // First sentence if it ends reasonably early, else a hard clip.
  const dot = clean.search(/[.:]\s/);
  const first = dot > 20 && dot < 170 ? clean.slice(0, dot) : clean;
  return first.length <= 180 ? first : first.slice(0, 177) + "…";
}

/**
 * The SITEMAP: every file in the snapshot as `path — one-line description`, the
 * "full list of files with brief explanations" the read loop chooses from. Files
 * with no extractable summary list their path alone.
 * @param {Snapshot} snapshot
 * @returns {string}
 */
export function buildSourceSitemap(snapshot) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  return files
    .map((f) => {
      const d = fileSummary(f.p, f.t);
      return d ? `${f.p} — ${d}` : f.p;
    })
    .join("\n");
}

/**
 * The model's parsed read step: the file paths to read this round, whether it
 * has declared itself done, and its one-line reasoning. Tolerant — never throws;
 * an empty/absent read list means done (nothing more to read is the natural
 * terminator, mirroring parseShellRequest).
 * @typedef {{ read: string[], done: boolean, reasoning: string }} ReadProposal
 */

/**
 * Normalize one raw read-step object ({read:[...], reasoning, done}) into a
 * ReadProposal. Requesting files ALWAYS continues the loop (read them, next
 * round decides); no files means done.
 * @param {any} raw
 * @returns {ReadProposal}
 */
export function normalizeReadStep(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const paths = (Array.isArray(r.read) ? r.read : [])
    .filter((/** @type {any} */ x) => typeof x === "string" && x.trim())
    .map((/** @type {string} */ x) => x.trim())
    .slice(0, MAX_FILES_PER_ROUND);
  const reasoning = typeof r.reasoning === "string" ? r.reasoning.replace(/\s+/g, " ").trim().slice(0, 400) : "";
  return { read: paths, done: paths.length === 0, reasoning };
}

/**
 * Resolve requested file paths to ACTUAL snapshot paths: exact match first
 * (case-insensitive, leading `./` stripped), then a unique basename match
 * ("auth.js" → "src/auth.js" when only one file has that basename). Ambiguous
 * or unknown requests resolve to null. Returns one entry per request, in order.
 * @param {Snapshot} snapshot
 * @param {string[]} requested
 * @returns {Array<{ requested: string, path: string | null }>}
 */
export function resolveReadPaths(snapshot, requested) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  /** @type {Map<string, string>} */
  const byPath = new Map();
  /** @type {Map<string, string | null>} */
  const byBase = new Map();
  for (const f of files) {
    byPath.set(f.p.toLowerCase(), f.p);
    const base = f.p.slice(f.p.lastIndexOf("/") + 1).toLowerCase();
    byBase.set(base, byBase.has(base) ? null : f.p); // second sighting → ambiguous
  }
  return (Array.isArray(requested) ? requested : []).map((raw) => {
    const norm = String(raw || "").trim().replace(/^\.?\//, "").toLowerCase();
    let path = byPath.get(norm) || null;
    if (!path) {
      const base = norm.slice(norm.lastIndexOf("/") + 1);
      const hit = byBase.get(base);
      if (hit) path = hit;
    }
    return { requested: String(raw || ""), path };
  });
}

/**
 * Read the requested files out of the snapshot, honoring the running char
 * budget and skipping ones already read. Each file's text is clamped to
 * MAX_READ_FILE_CHARS, the whole gathered set to MAX_READ_TOTAL_CHARS.
 * An optional line RANGE (1-based `offset`, `limit` lines; limit 0 = to EOF)
 * slices each file BEFORE the budget clamp, so a targeted read of a big file
 * charges only the lines actually returned — ranged reads carry a `lines`
 * field ({from, to, total}) for the caller's header.
 * @param {Snapshot} snapshot
 * @param {string[]} requested
 * @param {Set<string>} alreadyRead file paths gathered in earlier rounds
 * @param {{ used: number }} budget mutated: total chars gathered so far
 * @param {{ offset: number, limit: number } | null} [range]
 * @returns {Array<{ p: string, text: string, bytes: number, truncated: boolean, lines?: { from: number, to: number, total: number } }>}
 */
export function readSnapshotFiles(snapshot, requested, alreadyRead, budget, range = null) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  const resolved = resolveReadPaths(snapshot, requested);
  /** @type {Array<{ p: string, text: string, bytes: number, truncated: boolean, lines?: { from: number, to: number, total: number } }>} */
  const out = [];
  for (const r of resolved) {
    if (!r.path || (alreadyRead && alreadyRead.has(r.path))) continue;
    const f = files.find((x) => x.p === r.path);
    if (!f) continue;
    if (budget.used >= MAX_READ_TOTAL_CHARS) break; // budget spent — stop this round
    let src = String(f.t || "");
    /** @type {{ from: number, to: number, total: number } | undefined} */
    let lines;
    if (range) {
      const all = src.split("\n");
      const from = Math.min(Math.max(1, Math.floor(range.offset) || 1), all.length);
      const to = range.limit > 0 ? Math.min(all.length, from + Math.floor(range.limit) - 1) : all.length;
      src = all.slice(from - 1, to).join("\n");
      lines = { from, to, total: all.length };
    }
    const cap = Math.min(MAX_READ_FILE_CHARS, MAX_READ_TOTAL_CHARS - budget.used);
    const truncated = src.length > cap;
    const text = truncated ? src.slice(0, cap) + "\n… [truncated]" : src;
    // Charge the budget by the SOURCE chars kept (the "\n… [truncated]" marker
    // is bookkeeping, not content), so the total cap is honored exactly.
    budget.used += truncated ? cap : src.length;
    out.push({ p: r.path, text, bytes: f.s, truncated, ...(lines ? { lines } : {}) });
  }
  return out;
}

/**
 * The labeled context block of the files gathered by the read loop — appended
 * to the synthesis input as ground truth (the enrichment-block convention).
 * Empty string when nothing was read (so the input is byte-identical to a run
 * that only used the retrieved excerpts).
 * @param {Array<{ p: string, text: string, truncated?: boolean }>} reads
 * @returns {string}
 */
export function buildSourceResearchBlock(reads) {
  const list = (Array.isArray(reads) ? reads : []).filter((r) => r && r.p && typeof r.text === "string");
  if (!list.length) return "";
  const body = list.map((r) => `# ${r.p}${r.truncated ? " (truncated)" : ""}\n${r.text}`).join("\n\n");
  return (
    "Source files read from the project's own code during this research (ground " +
    "truth — quote from these and cite their file paths in the answer):\n\n" +
    body
  );
}

/**
 * The per-round USER message the loop's step sees: the question, the
 * conversation context, the sitemap to choose files from, and the files read so
 * far (round 2+). Shared so the server and any client tier ask identically.
 * @param {{ question: string, context: string, sitemap: string, priorBlock?: string }} params
 * @returns {string}
 */
export function buildSourceStepMessage({ question, context, sitemap, priorBlock = "" }) {
  return (
    `Research question (latest user message):\n${question}\n\n` +
    `Conversation context:\n${context}\n\n` +
    `Sitemap — every file in this project's source, with a one-line description. Choose the files to READ from this list:\n${sitemap}\n\n` +
    (priorBlock
      ? `${priorBlock}\n\nList the NEXT files you need to read to answer thoroughly (follow imports/references you saw), or reply {"done":true} if you have read enough of the actual code.`
      : `List the files you need to READ FIRST to research this from the actual source code, or reply {"done":true} if reading the source is not needed for this message.`)
  );
}

/**
 * Run the agentic source-read loop: repeatedly ask the MODEL which files to read
 * (via the injected `step`) and resolve them from the snapshot (via the injected
 * `read`), until the model is done or the round cap is hit. Generic over WHO
 * answers the step and HOW bytes are read, so the server and any client tier
 * share one driver. Never throws — a failing step or read ends the loop with
 * whatever was gathered (fail-soft).
 * @param {{
 *   step: (priorReads: Array<{ p: string, text: string, truncated?: boolean }>, round: number) => Promise<any>,
 *   read: (paths: string[], alreadyRead: Set<string>) => Promise<Array<{ p: string, text: string, truncated?: boolean }>>,
 *   maxRounds?: number,
 *   onRound?: (info: { round: number, reasoning: string, requested: string[], got: Array<{ p: string }> }) => void,
 *   initial?: Array<{ p: string, text: string, bytes?: number, truncated?: boolean }>,
 * }} params
 * @returns {Promise<Array<{ p: string, text: string, bytes?: number, truncated?: boolean }>>}
 */
export async function runSourceReadLoop({ step, read, maxRounds = MAX_SOURCE_READ_ROUNDS, onRound, initial = [] }) {
  /** @type {Array<{ p: string, text: string, bytes?: number, truncated?: boolean }>} */
  const reads = [];
  /** @type {Set<string>} */
  const readPaths = new Set();
  // Pre-seeded reads (e.g. a "read those" back-reference resolved to the files
  // the prior turn named): counted as already-read so the planner continues
  // from them (round 1 sees a non-empty priorReads) and they ground the answer.
  for (const r of Array.isArray(initial) ? initial : []) {
    if (r && r.p && !readPaths.has(r.p)) {
      readPaths.add(r.p);
      reads.push(r);
    }
  }
  for (let round = 1; round <= maxRounds; round++) {
    /** @type {ReadProposal} */
    let proposal;
    try {
      proposal = normalizeReadStep(await step(reads, round));
    } catch {
      break; // a failing step ends the loop with what we have (fail-soft)
    }
    if (proposal.done || !proposal.read.length) break;
    /** @type {Array<{ p: string, text: string, truncated?: boolean }>} */
    let got;
    try {
      got = await read(proposal.read, readPaths);
    } catch {
      got = [];
    }
    const fresh = (Array.isArray(got) ? got : []).filter((g) => g && g.p && !readPaths.has(g.p));
    for (const g of fresh) readPaths.add(g.p);
    reads.push(...fresh);
    if (onRound) onRound({ round, reasoning: proposal.reasoning, requested: proposal.read, got: fresh });
    if (!fresh.length) break; // nothing new resolved → stop rather than spin
  }
  return reads;
}

// ---- native tool-use executors (the invariant-1 exception) --------------------
//
// The three source-investigation TOOLS the ANSWER model drives with real
// function calls when it supports tool use — grep_source (≈ `grep -rn`),
// read_file (≈ `cat`), list_files (≈ `ls`) — executed against the deployed
// source snapshot. This is the owner-authorized 2026-07-12 exception to
// invariant 1, and it lives in this SHARED core so BOTH tiers use one
// implementation: the DRS server runs them in the Worker
// (src/introspect-tools.js re-exports these; src/pipeline.js drives the loop via
// src/anthropic.js), and DRC runs them in the BROWSER (public/js/drc-research.js
// drives the loop against the user's own tool-capable provider, and adds a real
// run_bash tool over the CheerpX sandbox, which only the browser can reach).
//
// Everything here is PURE (operates on a passed snapshot) and NEVER throws — a
// bad tool input returns an explanatory string, matching the fail-soft posture.

// Output bounds — one tool result is clamped so a broad grep or a huge file
// can't blow the model's context window or the loop's token budget.
export const MAX_GREP_MATCHES = 80; // matching lines returned from one grep
export const MAX_GREP_OUTPUT_CHARS = 6000; // total chars of grep output
export const MAX_LIST_ENTRIES = 300; // paths returned from one list_files
export const MAX_LIST_OUTPUT_CHARS = 6000;
export const MAX_PATTERN_CHARS = 300; // a grep pattern is clamped to this
export const MAX_LINE_CHARS = 240; // one matched line is clamped to this
export const MAX_GREP_CONTEXT = 5; // context lines each side of a match (grep -C)

// The provider-neutral tool definitions (name / description / JSON input
// schema). The DRS loop maps these onto Anthropic's `tools` shape and DRC onto
// the OpenAI/Groq `tools` shape — the fields line up with both. read_file /
// grep_source / list_files are source-only; DRC ADDS a run_bash entry at its
// call site (the sandbox is browser-only), so it is not declared here.
export const INTROSPECTION_TOOLS = [
  {
    name: "grep_source",
    description:
      "Search the site's own deployed source code with a regular expression, like `grep -rn`. Returns matching lines as `path:line: text`; with `context`, surrounding lines too (like `grep -C`). Use this FIRST to locate where something is implemented — grep output is free (it does not draw on the read budget), so a targeted grep with context often answers without reading the file at all.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "A JavaScript regular expression. Case-sensitive unless you prefix it with (?i), e.g. (?i)session_secret.",
        },
        path_glob: {
          type: "string",
          description: "Optional substring to limit which files are searched, e.g. 'src/', '.js', or 'auth'.",
        },
        context: {
          type: "integer",
          description: `Lines of context to show around each match, like grep -C (0-${MAX_GREP_CONTEXT}, default 0).`,
        },
        max_matches: { type: "integer", description: `Max matching lines to return (default ${MAX_GREP_MATCHES}).` },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description:
      `Read source files by exact repo path, e.g. 'src/auth.js' — whole (like \`cat\`) or a line range via offset/limit (like \`sed -n\`). IMPORTANT: all read_file output in one investigation shares a single budget of ${MAX_READ_TOTAL_CHARS} characters (each result reports what is used); whole reads of big files exhaust it fast. Prefer ranged reads of just the lines you need — grep_source reports line numbers to target, list_files reports sizes.`,
    input_schema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Repo-relative file paths to read." },
        offset: {
          type: "integer",
          description: "1-based line number to start reading from (applies to every path in this call). Default 1.",
        },
        limit: {
          type: "integer",
          description: "Number of lines to read from offset. Default: to the end of the file.",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "list_files",
    description:
      "List repo file paths (optionally filtered by a substring) with byte sizes, so you know what exists — and how big it is — before grepping or reading.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional substring to filter paths, e.g. 'src/' or '.test.js'." },
      },
      required: [],
    },
  },
];

/** @param {Snapshot} snapshot @returns {Array<{p:string,s:number,t:string}>} */
function toolFilesOf(snapshot) {
  return snapshot && Array.isArray(snapshot.files) ? snapshot.files : [];
}

/** @param {any} s @param {number} max @returns {string} */
function clipTool(s, max) {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  return str.length <= max ? str : str.slice(0, max) + `\n…[truncated ${str.length - max} chars]`;
}

// Compile the model-supplied pattern into a per-line RegExp. Supports a leading
// (?i) for case-insensitivity (JS has no inline flag). Returns null on an
// invalid or empty pattern — the caller reports it rather than throwing.
/** @param {unknown} raw @returns {RegExp | null} */
function compileToolPattern(raw) {
  let pat = String(raw || "").slice(0, MAX_PATTERN_CHARS);
  if (!pat.trim()) return null;
  let flags = "";
  if (pat.startsWith("(?i)")) {
    flags = "i";
    pat = pat.slice(4);
  }
  try {
    return new RegExp(pat, flags);
  } catch {
    return null;
  }
}

/**
 * grep_source: scan every snapshot file (optionally filtered by a path
 * substring) for the pattern, line by line, returning `path:line: text` up to
 * the match/char caps — plus, with `context`, the surrounding lines as
 * `path-line- text` with `--` between hunks (the `grep -C` wire format), so
 * the model can see how a line is used WITHOUT spending read_file budget on
 * the whole file. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @returns {string}
 */
export function grepSource(snapshot, input) {
  const re = compileToolPattern(input?.pattern);
  if (!re) return `Invalid or empty regular expression: ${JSON.stringify(input?.pattern ?? null)}`;
  const glob = String(input?.path_glob || "").toLowerCase();
  const cap = Math.max(1, Math.min(MAX_GREP_MATCHES, Number(input?.max_matches) || MAX_GREP_MATCHES));
  const ctx = Math.max(0, Math.min(MAX_GREP_CONTEXT, Math.floor(Number(input?.context) || 0)));
  /** @type {string[]} */
  const out = [];
  let total = 0;
  let truncated = false;
  for (const f of toolFilesOf(snapshot)) {
    if (glob && !f.p.toLowerCase().includes(glob)) continue;
    const lines = String(f.t || "").split("\n");
    /** @type {number[]} */
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      hits.push(i);
      if (total + hits.length >= cap) {
        truncated = true;
        break;
      }
    }
    if (!hits.length) continue;
    total += hits.length;
    const hitSet = new Set(hits);
    const render = (/** @type {number} */ j) => {
      const sep = hitSet.has(j) ? ":" : "-";
      return `${f.p}${sep}${j + 1}${sep} ${lines[j].trim().slice(0, MAX_LINE_CHARS)}`;
    };
    if (!ctx) {
      for (const i of hits) out.push(render(i));
    } else {
      let emitted = -1; // highest line index already emitted for this file
      for (const i of hits) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(lines.length - 1, i + ctx);
        if (emitted >= 0 && start > emitted + 1) out.push("--"); // gap between hunks
        for (let j = Math.max(start, emitted + 1); j <= end; j++) out.push(render(j));
        emitted = Math.max(emitted, end);
      }
    }
    if (total >= cap) break;
  }
  if (!out.length) return `No matches for /${input?.pattern}/${glob ? ` in files matching '${glob}'` : ""}.`;
  const header = `${total} match${total === 1 ? "" : "es"}${truncated ? ` (capped at ${cap})` : ""}:`;
  return clipTool([header, ...out].join("\n"), MAX_GREP_OUTPUT_CHARS);
}

/**
 * read_file: resolve the requested paths against the snapshot and return their
 * text (clamped by the shared read budget) — the whole file, or just a line
 * range when the input carries `offset`/`limit` (the cheap way to extract from
 * a big file). Accepts {paths:[...]} or a single {path:"..."}. Every result
 * ends with a running budget readout so the model can PLAN around the shared
 * cap instead of discovering it on exhaustion. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @param {{ used: number }} budget shared across the loop to bound total bytes
 * @returns {string}
 */
export function readFileTool(snapshot, input, budget) {
  const requested = Array.isArray(input?.paths)
    ? input.paths
    : typeof input?.path === "string"
      ? [input.path]
      : [];
  const paths = requested.filter((/** @type {any} */ p) => typeof p === "string" && p.trim()).slice(0, 8);
  if (!paths.length) return "read_file needs a non-empty 'paths' array of repo-relative file paths.";
  const offset = Math.floor(Number(input?.offset));
  const limit = Math.floor(Number(input?.limit));
  const range = offset >= 1 || limit >= 1 ? { offset: offset >= 1 ? offset : 1, limit: limit >= 1 ? limit : 0 } : null;
  const reads = readSnapshotFiles(snapshot, paths, new Set(), budget, range);
  if (!reads.length) {
    // A spent read budget must SAY so: reporting it as "No files resolved"
    // sends the model hunting for different paths and retrying reads that can
    // never succeed, and it reports the tool as broken (live finding
    // 2026-07-16: valid .claude/skills/* paths "failed to load" once an
    // earlier read_file batch had consumed the whole budget).
    if (budget.used >= MAX_READ_TOTAL_CHARS) {
      return (
        `Read budget exhausted: ${MAX_READ_TOTAL_CHARS} chars of file content have already been returned in this investigation, so read_file cannot return anything more — retrying will not help. ` +
        "Answer from what you have already read; grep_source (with its context parameter) still works for targeted extraction."
      );
    }
    return `No files resolved for ${JSON.stringify(paths)}. Use list_files or grep_source to find exact paths (e.g. src/auth.js).`;
  }
  const body = reads
    .map(
      (r) =>
        `# ${r.p}${r.lines ? ` (lines ${r.lines.from}-${r.lines.to} of ${r.lines.total})` : ""}${r.truncated ? " (truncated)" : ""}\n${r.text}`,
    )
    .join("\n\n");
  // Split the not-returned paths by CAUSE, so the model's next move is the
  // right one: unresolved (a wrong path — list_files can fix it) vs
  // resolved-but-dropped (the budget ran out mid-call — no retry can fix it).
  const readSet = new Set(reads.map((r) => r.p));
  const resolved = resolveReadPaths(snapshot, paths);
  const notFound = resolved.filter((r) => !r.path).map((r) => r.requested);
  const dropped = resolved.filter((r) => r.path && !readSet.has(r.path)).map((r) => r.requested);
  const notes = [];
  if (notFound.length) notes.push(`(not found: ${notFound.join(", ")})`);
  if (dropped.length) {
    notes.push(
      `(read budget exhausted before: ${dropped.join(", ")} — do not retry read_file for these; use grep_source instead)`,
    );
  }
  notes.push(`(read budget used: ${budget.used} of ${MAX_READ_TOTAL_CHARS} chars)`);
  return body + `\n\n${notes.join("\n")}`;
}

/**
 * list_files: the repo file paths (optionally substring-filtered) with byte
 * sizes. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @returns {string}
 */
export function listFilesTool(snapshot, input) {
  const filter = String(input?.filter || "").toLowerCase();
  const matched = toolFilesOf(snapshot).filter((f) => !filter || f.p.toLowerCase().includes(filter));
  if (!matched.length) return `No files${filter ? ` matching '${filter}'` : ""}.`;
  const shown = matched.slice(0, MAX_LIST_ENTRIES);
  const header = `${matched.length} file${matched.length === 1 ? "" : "s"}${
    shown.length < matched.length ? ` (showing ${shown.length})` : ""
  }:`;
  return clipTool([header, ...shown.map((f) => `${f.p}\t${f.s}`)].join("\n"), MAX_LIST_OUTPUT_CHARS);
}

/**
 * Dispatch one native SOURCE tool call to its executor. The seam both tiers'
 * tool loops call for the source tools; returns the tool result STRING the
 * model sees next round. Never throws. (DRC handles run_bash separately, at its
 * sandbox call site.)
 * @param {Snapshot} snapshot
 * @param {string} name
 * @param {any} input
 * @param {{ used: number }} budget
 * @returns {string}
 */
export function runIntrospectionTool(snapshot, name, input, budget) {
  try {
    switch (name) {
      case "grep_source":
        return grepSource(snapshot, input);
      case "read_file":
        return readFileTool(snapshot, input, budget);
      case "list_files":
        return listFilesTool(snapshot, input);
      default:
        return `Unknown tool "${name}". Available tools: grep_source, read_file, list_files.`;
    }
  } catch (/** @type {any} */ err) {
    return `Tool "${name}" failed: ${err?.message || String(err)}`;
  }
}

// One tool call → the activity HEADLINE (tool + its key argument), so a run
// reads as "grep_source /X/", "read_file src/auth.js", "run_bash $ …" instead of
// a bare counter. Shared so both tiers label calls identically.
/** @param {string} name @param {any} input @returns {string} */
export function toolStepHeadline(name, input) {
  if (name === "grep_source") {
    const pat = String(input?.pattern ?? "");
    return `grep_source  /${pat.slice(0, 80)}/${input?.path_glob ? ` in ${input.path_glob}` : ""}`;
  }
  if (name === "read_file") {
    const paths = Array.isArray(input?.paths) ? input.paths : input?.path ? [input.path] : [];
    const off = Number(input?.offset);
    const lim = Number(input?.limit);
    const range = off >= 1 || lim >= 1 ? `  [${off >= 1 ? off : 1}${lim >= 1 ? `,+${lim}` : "→end"}]` : "";
    return `read_file  ${paths.slice(0, 4).join(", ")}${paths.length > 4 ? " …" : ""}${range}`;
  }
  if (name === "list_files") return `list_files  ${input?.filter ? `'${input.filter}'` : "(all)"}`;
  if (name === "run_bash") return `run_bash  $ ${String(input?.command ?? "").slice(0, 120)}`;
  return String(name || "tool");
}

// The first lines of a tool RESULT, for a step's expandable details — so the
// user sees grep matches / a file's start / command output, not just a count.
/** @param {string} result @param {number} [max] @returns {string[]} */
export function toolResultLines(result, max = 14) {
  const text = typeof result === "string" ? result : "";
  if (!text.trim()) return ["(no output)"];
  const all = text.split("\n");
  const lines = all.slice(0, max).map((l) => l.slice(0, 200));
  if (all.length > max) lines.push(`… (+${all.length - max} more lines)`);
  return lines;
}

// ---- the introspection model picker (pure grouping) ---------------------------

// Introspection mode lets the user choose WHO answers: their own provider key
// (browser-direct — the site's server never sees the conversation; the
// private, recommended choice) or this site's server pipeline (remote). The
// picker's grouping/labeling is pure so it's Node-tested; the DOM lives in
// introspect-ui.js.

/**
 * @typedef {{ kind: "private", providerId: string, model: string } | { kind: "server", model: string }} IntrospectionChoice
 */

/**
 * Group the available answer routes for the introspection picker. Private
 * (user-key, browser-direct) options come FIRST and carry the recommendation
 * — the privacy-obvious choice; server models are labeled as remote so
 * nobody mistakes them for local.
 * @param {Array<{ id: string, label: string, models: string[] }>} privateProviders configured (key present) providers
 * @param {Array<{ id: string, name?: string, up?: boolean, provider?: string }>} serverModels /api/models entries ([] on DRC)
 * @returns {{ groups: Array<{ kind: "private" | "remote", label: string, options: Array<{ value: string, label: string, disabled?: boolean }> }>, recommended: string }}
 */
export function groupIntrospectionModels(privateProviders, serverModels) {
  /** @type {Array<{ kind: "private" | "remote", label: string, options: Array<{ value: string, label: string, disabled?: boolean }> }>} */
  const groups = [];
  // A flag prefix (with trailing space) marks where each route's data is
  // processed; a local/unknown provider yields "" (no flag) — see
  // provider-region.js.
  const priv = (Array.isArray(privateProviders) ? privateProviders : []).flatMap((p) => {
    const pr = regionForProvider(p?.id);
    const pf = pr ? pr.flag + " " : "";
    return (Array.isArray(p?.models) ? p.models : []).map((m) => ({
      value: `p:${p.id}:${m}`,
      label: `🔒 ${pf}${m} — ${p.label}, your key (private)`,
    }));
  });
  if (priv.length) {
    groups.push({ kind: "private", label: "Private — your key, straight from this browser", options: priv });
  }
  const remote = (Array.isArray(serverModels) ? serverModels : [])
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => {
      const r = regionForModelEntry(m);
      const rf = r ? r.flag + " " : "";
      return {
        value: `s:${m.id}`,
        label: `☁ ${rf}${m.name || m.id} — remote (this site's server)`,
        disabled: m.up === false,
      };
    });
  if (remote.length) {
    groups.push({ kind: "remote", label: "Remote — this site's server pipeline", options: remote });
  }
  return { groups, recommended: priv.length ? priv[0].value : "" };
}

/**
 * Parse a picker value back into a routing choice. Null for junk (callers
 * fall back to the server default).
 * @param {unknown} value
 * @returns {IntrospectionChoice | null}
 */
export function parseIntrospectionChoice(value) {
  const s = String(value || "");
  if (s.startsWith("p:")) {
    const rest = s.slice(2);
    const colon = rest.indexOf(":");
    if (colon > 0 && colon < rest.length - 1) {
      return { kind: "private", providerId: rest.slice(0, colon), model: rest.slice(colon + 1) };
    }
    return null;
  }
  if (s.startsWith("s:") && s.length > 2) return { kind: "server", model: s.slice(2) };
  return null;
}
