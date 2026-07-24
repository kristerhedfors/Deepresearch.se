// @ts-check
// The feedback INTENT gate — pure, shared, dependency-free. A message whose
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
