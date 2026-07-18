// @ts-check
// Shared pure recognizer: does a message ask about an AI / LLM MODEL — a model
// family name, on its own or with a version token like glm-5.2, kimi k2,
// deepseek v3, llama 4, qwen3? A research assistant is asked "latest on
// glm-5.2" constantly, and without this the offline sandbox mistook the name
// for a piece of local software and ran `apt-cache search glm-5.2` / `ls
// /usr/include/glm-5.2` (the C++ GLM math library's namespace) instead of
// researching the Zhipu model — a bad-UX misfire the user reported (IMG_5207).
//
// WHY A SHARED PURE CORE under public/js/: the exact same recognition is needed
// on BOTH tiers — the Worker/DRS side (src/ reaches it through the src/
// ai-models.js re-export façade) and the DRC client (public/js/drc-research.js
// and public/js/stream.js import it directly). A browser can only import
// modules the Worker serves, so the single source of truth lives here.
//
// The recognizer is LANGUAGE-NEUTRAL: model names read the same in every
// language, so Swedish and English parity (invariant 6) is inherent — "senaste
// om glm-5.2" and "latest on glm-5.2" both hit the same token. The surrounding
// intent phrasing ("latest on…", "vad är nytt i…") is triage's job; this file
// only answers "is a model named here?". Node-tested in ai-models.test.js
// (EN + SV cases, and the GLM-library false-positive guard).

// STRONG families — a bare mention is unambiguous enough in a research chat to
// count as a model (they are not common English/Swedish words and rarely name
// anything else). deepseek/kimi/qwen and friends the user named live here.
const STRONG_FAMILIES = new RegExp(
  "\\b(" +
    "deepseek|chatglm|kimi|qwen|qwq|mixtral|codestral|mistral|" +
    "ernie|hunyuan|nemotron|dbrx|olmo|wizardlm|command[- ]?r\\+?|" +
    "o[13](?:[- ]?(?:mini|pro))?" +
  ")\\b",
  "i",
);

// VERSIONED families — a name that IS an ordinary word or an unrelated library
// (glm the C++ math lib, gemma, grok, gpt, claude, gemini, llama, yi, phi, …)
// only counts as a model when a version token rides right after it: glm-5.2,
// glm 4.6, glm4, kimi-k2, llama 4, gemini 2.5, gpt-5, claude 3.7, grok-4,
// phi-3, yi-34b. The version token allows an optional separator, an optional
// v/r/k/b prefix (release/reasoning/K-series/param-size), and dotted numbers.
// This is what keeps a bare "glm" (the math library) from matching while
// "glm-5.2" (the model) does — exactly the reported misfire.
const VERSIONED_FAMILIES = new RegExp(
  "\\b(" +
    "glm|kimi|llama|gemma|gemini|grok|gpt|claude|falcon|doubao|" +
    "minimax|yi|phi|qwen|deepseek|command[- ]?r|mistral|solar|" +
    "sonnet|opus|haiku" +
  ")" +
  "[- ]?(?:v|r|k|b)?\\d+(?:\\.\\d+)*",
  "i",
);

// A combined matcher for pulling out the actual mentioned tokens (for a hint /
// telemetry). Global + case-insensitive; the two family patterns above stay
// the authoritative gate.
const ALL_MODELS = new RegExp(
  VERSIONED_FAMILIES.source + "|" + STRONG_FAMILIES.source,
  "gi",
);

/**
 * Does the message reference an AI/LLM model (a known family, alone or with a
 * version)? Deterministic, typo-tolerant at the family level, EN+SV-neutral.
 * @param {string} text the latest user message
 * @returns {boolean}
 */
export function aiModelIntent(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  return VERSIONED_FAMILIES.test(t) || STRONG_FAMILIES.test(t);
}

/**
 * The distinct model tokens mentioned (normalized to lowercase, deduped, in
 * order of appearance) — for building a targeted prompt hint. Empty when none.
 * @param {string} text
 * @returns {string[]}
 */
export function aiModelMentions(text) {
  const t = String(text || "");
  const out = [];
  const seen = new Set();
  for (const m of t.matchAll(ALL_MODELS)) {
    const tok = m[0].trim().toLowerCase().replace(/\s+/g, " ");
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

// The prompt note both bash-agent prompts splice in so the MODEL — which owns
// the decision to run a shell (invariant 1, no brittle keyword gate) — treats
// model names as external-knowledge topics rather than local packages. Kept
// here, next to the recognizer, so the family list and the guidance never
// drift apart.
export const AI_MODEL_NOT_A_PACKAGE_NOTE =
  "\nAI / LLM MODELS ARE NOT LOCAL SOFTWARE: names like GLM (e.g. glm-5.2), " +
  "Kimi (k2/k3), DeepSeek, Qwen, Llama, Mistral, GPT, Claude, Gemini or Grok " +
  "and their version numbers refer to AI models, NOT packages installed in " +
  "this offline sandbox. Never apt-cache/apt-get/dpkg/ls/which/find them — the " +
  "sandbox has no network and cannot look them up. A question like \"latest on " +
  "glm-5.2\" is an external-knowledge question: reply SHELL_DONE and let the " +
  "research pipeline answer it.";

// The triage note both research-planner prompts splice in so a model question
// gets DECOMPOSED into a good research plan ("nice pipeline") instead of a
// single flat lookup.
export const AI_MODEL_RESEARCH_NOTE =
  "A question about an AI/LLM model or one of its versions (e.g. \"latest on " +
  "glm-5.2\", \"kimi k2 vs k3\", \"what's new in deepseek\") is a RESEARCH " +
  "question — decompose it into distinct angles such as the model's release " +
  "date and version, its capabilities and benchmark results, how it compares " +
  "to peers, and its availability/pricing. Never treat a model name as a " +
  "software package to look up locally.";
