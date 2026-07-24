// @ts-check
// The feedback INTENT gate + canned acknowledgments — pure, shared,
// dependency-free. A message whose
// text OPENS with the word "feedback" (case-insensitive) is a report to the
// developers, not a research question. This is the single source of truth for
// that gate across BOTH tiers, so they can never diverge on what the word
// triggers:
//   - Se/rver: src/feedback.js re-exports this (façade), and the research
//     pipeline routes a matching message to the feedback case (server-side).
//   - Se/cure: public/cure/drc.js imports it directly and, on a match, prompts
//     for confirmation before sending the feedback to the developers over the
//     DeepResearch (Se/rver) token — the client-side pipeline never researches
//     it. (The server is normally in NO Se/cure data path; feedback is one of
//     the deliberate, confirmed, opt-in exceptions — see the SERVER-TOKEN
//     GUARANTEE's third bounded exception in src/server-token.js.)
//
// English + Swedish with the same breadth (invariant 6, EN/SV parity):
// "feedback" is the loanword used in both languages; the native Swedish terms
// are "återkoppling" and "synpunkt(er)", definite forms included. Adding a form
// here changes BOTH tiers at once — keep the parity test (feedback-core.test.js
// + src/feedback.test.js) in the same change.
//
// "feedback loop(s)" is the ONE excluded collision: it's a ubiquitous fixed
// phrase (control theory, ML, and this repo's own skill names), so a research
// question that opens with it must NOT be swallowed by the gate.

export const FEEDBACK_PATTERNS = [
  /^\s*feedback\b(?!\s+loops?\b)/i, // EN + SV loanword: "feedback", "Feedback:", "feedback – …"
  /^\s*återkoppling(?:en)?\b/i, // SV: "återkoppling", "återkopplingen"
  /^\s*synpunkt(?:er|en|erna)?\b/i, // SV: "synpunkt", "synpunkter", "synpunkten"
];

/**
 * Whether the latest user message is feedback for the developers.
 * @param {unknown} text the user's message text
 * @returns {boolean}
 */
export function feedbackIntent(text) {
  const t = typeof text === "string" ? text : "";
  return FEEDBACK_PATTERNS.some((re) => re.test(t));
}

// ---------------------------------------------------------------------------
// SCOPE classification (owner directive, 2026-07-24)
//
// A "feedback …" message that is the ABSOLUTE FIRST message of a conversation
// cannot be feedback ABOUT that conversation — there is nothing in it yet. It
// is GENERIC developer feedback: a feature suggestion, a next-steps note, a
// general remark about the product. So the capture must not dress it up as a
// session report: no prior-turn context to quote, no transcript worth
// attaching (the "transcript" would be the note itself), and an
// acknowledgment that doesn't promise the developers a conversation they
// won't get.
//
//   "standalone" — first message of the conversation → generic feedback
//   "session"    — arrived mid-conversation → about what happened in it
//
// Both tiers classify with THESE functions so they can never disagree about
// which kind of note the developers received. Only user/assistant turns
// count: a context block injected as some other role is not a session the
// user had.
// ---------------------------------------------------------------------------

/** @typedef {"standalone" | "session"} FeedbackScope */

/** @param {unknown} turns */
const dialogueTurns = (turns) =>
  (Array.isArray(turns) ? turns : []).filter((m) => m && (m.role === "user" || m.role === "assistant"));

/**
 * Classify from the turns that came BEFORE the feedback message — the shape
 * Se/cure has (the feedback text is never entered into its conversation).
 * @param {unknown} priorTurns the conversation's turns, feedback message excluded
 * @returns {FeedbackScope}
 */
export function feedbackScopeOfPrior(priorTurns) {
  return dialogueTurns(priorTurns).length ? "session" : "standalone";
}

/**
 * Classify from the full conversation ENDING in the feedback turn — the shape
 * Se/rver has (the pipeline receives the feedback message as the last turn).
 * @param {unknown} conversation
 * @returns {FeedbackScope}
 */
export function feedbackScope(conversation) {
  return feedbackScopeOfPrior(dialogueTurns(conversation).slice(0, -1));
}

// The entry's `page` column carries the SURFACE the note came from ("chat",
// "se/cure") and — for a standalone note — this suffix, so the queue and the
// development loop read the classification off the entry itself without a
// schema change (the same column already carries "usecase #UC-34").
export const STANDALONE_PAGE_SUFFIX = "/standalone";

/**
 * The `page` tag for a feedback entry: surface plus the standalone marker.
 * @param {string} surface e.g. "chat", "se/cure"
 * @param {FeedbackScope} scope
 * @returns {string}
 */
export function feedbackPageTag(surface, scope) {
  const s = typeof surface === "string" && surface.trim() ? surface.trim() : "chat";
  return scope === "standalone" ? s + STANDALONE_PAGE_SUFFIX : s;
}

/**
 * Whether a stored `page` marks a standalone (generic) note — for rendering.
 * @param {unknown} page
 * @returns {boolean}
 */
export function isStandalonePage(page) {
  return typeof page === "string" && page.endsWith(STANDALONE_PAGE_SUFFIX);
}

// ---------------------------------------------------------------------------
// Canned acknowledgments (owner directive, 2026-07-24): user feedback is
// NEVER run through an LLM. The exact text goes to the developers verbatim
// (with the whole conversation as debugging context — src/feedback.js
// buildFeedbackDebugContext), and the user gets one of these fixed replies.
// Deterministic on purpose: no model call to fail, nothing paraphrased, and
// no way for feedback text to steer a model (the strongest possible
// anti-injection posture — there is no model). EN and SV variant lists are
// kept the same length and say the same things (invariant 6).
//
// TWO variant sets, one per SCOPE (above): the session set promises the
// developers get "this conversation for context", which is simply untrue for
// a standalone note — so a first-message suggestion gets a set that says what
// actually happens to it.
// ---------------------------------------------------------------------------

export const FEEDBACK_ACKS = {
  en: [
    "Thank you — your feedback has been passed on to the developers exactly as you wrote it, together with this conversation for context. Every submission is read; if a reply is needed it will appear under Feedback in your account panel.",
    "Thanks for the report — it has been forwarded to the developers word for word, with this chat attached so they can see what happened. Any reply from them shows up under Feedback in your account panel.",
    "Got it — your message is now in the developers' queue, verbatim, along with this conversation as debugging context. If they write back, the reply appears under Feedback in your account panel.",
  ],
  sv: [
    "Tack — din feedback har skickats vidare till utvecklarna precis som du skrev den, tillsammans med den här konversationen som sammanhang. Varje inskick läses; om ett svar behövs visas det under Feedback i din kontopanel.",
    "Tack för rapporten — den har vidarebefordrats till utvecklarna ord för ord, med den här chatten bifogad så att de ser vad som hände. Eventuella svar från dem visas under Feedback i din kontopanel.",
    "Uppfattat — ditt meddelande ligger nu i utvecklarnas kö, ordagrant, tillsammans med den här konversationen som felsökningsunderlag. Om de svarar visas svaret under Feedback i din kontopanel.",
  ],
};

// The standalone set: a first-message note is generic developer feedback, so
// these promise verbatim delivery WITHOUT claiming a conversation rides along.
export const FEEDBACK_ACKS_STANDALONE = {
  en: [
    "Thank you — your suggestion has been passed on to the developers exactly as you wrote it, filed as general feedback rather than a report about a research session. Every submission is read; if a reply is needed it will appear under Feedback in your account panel.",
    "Thanks — it has been forwarded to the developers word for word and filed as a general suggestion, since this chat holds nothing else for them to look at. Any reply from them shows up under Feedback in your account panel.",
    "Got it — your message is now in the developers' queue, verbatim, filed as general feedback rather than a comment on an earlier answer. If they write back, the reply appears under Feedback in your account panel.",
  ],
  sv: [
    "Tack — ditt förslag har skickats vidare till utvecklarna precis som du skrev det, registrerat som allmän feedback och inte som en rapport om en forskningssession. Varje inskick läses; om ett svar behövs visas det under Feedback i din kontopanel.",
    "Tack — det har vidarebefordrats till utvecklarna ord för ord och registrerats som ett allmänt förslag, eftersom den här chatten inte innehåller något annat att titta på. Eventuella svar från dem visas under Feedback i din kontopanel.",
    "Uppfattat — ditt meddelande ligger nu i utvecklarnas kö, ordagrant, registrerat som allmän feedback och inte som en kommentar till ett tidigare svar. Om de svarar visas svaret under Feedback i din kontopanel.",
  ],
};

// The use-case confirmation tail ("feedback #UC-34 …" — testpoints-core.js
// parseUseCaseRef), appended in the reply's language.
export const FEEDBACK_ACK_USECASE = {
  en: (/** @type {string} */ tag) => ` It has been recorded against use case ${tag}.`,
  sv: (/** @type {string} */ tag) => ` Den har registrerats mot användningsfall ${tag}.`,
};

// Swedish detection for the reply language. Feedback opening with the
// loanword "feedback" is common in both languages, so the body decides:
// Swedish letters, the native gate words, or common Swedish function/UI
// words that are not also English words ("var"/"men"/"tack" are excluded
// as collisions). Default is English.
const SV_HINT_RE =
  /[åäö]|\b(?:återkoppling(?:en)?|synpunkt(?:er|en|erna)?|inte|och|det|att|jag|som|den|fungerar|funkar|svaret|sidan|knappen|kartan|borde|vill|skulle|blir|visas|saknas|hittar|laddar)\b/i;

/**
 * Whether a feedback message reads as Swedish (→ Swedish canned reply).
 * @param {unknown} text
 * @returns {boolean}
 */
export function feedbackLangSv(text) {
  return typeof text === "string" && SV_HINT_RE.test(text);
}

/**
 * The canned acknowledgment for a feedback message: scope-matched (standalone
 * vs session) and language-matched (EN/SV), variant picked deterministically
 * from the message text (a stable char-code hash — same message, same reply;
 * different messages vary), with the use-case confirmation appended when the
 * note referenced one.
 * @param {unknown} comment the user's feedback message text
 * @param {{ useCaseTag?: string | null, scope?: FeedbackScope }} [opts]
 * @returns {string}
 */
export function cannedFeedbackAck(comment, { useCaseTag = null, scope = "session" } = {}) {
  const text = typeof comment === "string" ? comment : "";
  const lang = feedbackLangSv(text) ? "sv" : "en";
  const variants = (scope === "standalone" ? FEEDBACK_ACKS_STANDALONE : FEEDBACK_ACKS)[lang];
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash + text.charCodeAt(i)) % 0xffff;
  const ack = variants[hash % variants.length];
  return useCaseTag ? ack + FEEDBACK_ACK_USECASE[lang](useCaseTag) : ack;
}
