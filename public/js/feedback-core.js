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
// Canned acknowledgments (owner directive, 2026-07-24): user feedback is
// NEVER run through an LLM. The exact text goes to the developers verbatim
// (with the whole conversation as debugging context — src/feedback.js
// buildFeedbackDebugContext), and the user gets one of these fixed replies.
// Deterministic on purpose: no model call to fail, nothing paraphrased, and
// no way for feedback text to steer a model (the strongest possible
// anti-injection posture — there is no model). EN and SV variant lists are
// kept the same length and say the same things (invariant 6).
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
 * The canned acknowledgment for a feedback message: language-matched
 * (EN/SV), variant picked deterministically from the message text (a stable
 * char-code hash — same message, same reply; different messages vary), with
 * the use-case confirmation appended when the note referenced one.
 * @param {unknown} comment the user's feedback message text
 * @param {{ useCaseTag?: string | null }} [opts]
 * @returns {string}
 */
export function cannedFeedbackAck(comment, { useCaseTag = null } = {}) {
  const text = typeof comment === "string" ? comment : "";
  const lang = feedbackLangSv(text) ? "sv" : "en";
  const variants = FEEDBACK_ACKS[lang];
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash + text.charCodeAt(i)) % 0xffff;
  const ack = variants[hash % variants.length];
  return useCaseTag ? ack + FEEDBACK_ACK_USECASE[lang](useCaseTag) : ack;
}
