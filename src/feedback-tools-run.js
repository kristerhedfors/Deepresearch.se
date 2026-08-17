// @ts-check
// The runner behind `send_feedback` — everything that touches a binding, so
// src/feedback-tools.js can stay pure and src/mcp-config.js can import it.
//
// It is a thin adapter on purpose. Validation, the caps and the write are
// src/feedback.js's, reached unchanged, because a second copy of "how long may a
// comment be" or "what does a feedback row look like" would drift from the one
// the browser path uses and nothing would notice until a report was silently
// truncated differently on one surface.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO.
//
// It does not accept IMAGES. `validateFeedbackCreate` takes them and the browser
// path sends screenshots, but an agent or a voice client has none, and accepting
// base64 blobs on a keyed surface is an abuse vector that buys nothing here. The
// argument is simply absent from the schema, so a caller cannot supply one.
//
// It does not fabricate a CONVERSATION. On the chat path an entry carries the
// whole transcript (buildFeedbackDebugContext) and threads onto a prior report
// found in it. There is no conversation here — the caller is one stateless tool
// call — so `context` stays empty and the threading lookup is given an empty
// conversation, which makes every MCP report a NEW entry. That is the honest
// shape: inventing a transcript would put words in the reporter's mouth, and
// guessing at a thread would append someone's new problem to an unrelated one.
//
// It does not work for an UNIDENTIFIED caller. Feedback is filed against an
// account: it is how the loop replies, and how a reader knows who to answer. A
// break-glass identity has no D1 row, so there is nothing to attribute to and
// nothing to reply to — refused with a message that says which of the two is
// missing rather than a generic failure.

import { createOrThreadFeedbackEntry, validateFeedbackCreate } from "./feedback.js";
import { FEEDBACK_TOOL_NAME, FEEDBACK_TOOL_PAGE } from "./feedback-tools.js";

/** @typedef {{ text: string, isError: boolean, entryId?: number | null }} FeedbackToolAnswer */

/**
 * Run `send_feedback`.
 *
 * NEVER throws for an ordinary refusal — a bad argument or a missing account
 * comes back as an `isError` result the calling model can read and act on,
 * because a JSON-RPC error would reach the user as a transport failure and tell
 * them nothing. A binding that is genuinely absent still throws, and the
 * dispatch in src/mcp.js turns that into the tool-failed branch.
 *
 * @param {any} env
 * @param {any} log
 * @param {string} name
 * @param {any} args
 * @param {{ identity?: any, requestId?: string }} billing
 * @returns {Promise<FeedbackToolAnswer>}
 */
export async function runFeedbackTool(env, log, name, args, billing) {
  if (name !== FEEDBACK_TOOL_NAME) {
    return { text: `Unknown tool: ${name}`, isError: true };
  }

  const userId = billing?.identity?.id;
  if (userId === undefined || userId === null || userId === "") {
    // The break-glass case. Naming it is the point: "feedback needs an account"
    // is actionable, "could not file feedback" is not.
    return {
      text:
        "Feedback is filed against an account, and this call arrived without one — a break-glass credential has " +
        "no account row to attribute a report to or reply to. Connect with an MCP key minted by an account and " +
        "the report will reach the queue.",
      isError: true,
    };
  }

  // The browser path's validator, unchanged, so the caps are the same ones the
  // account panel enforces. `images` is absent from the schema, so the images
  // half of the result is always empty here.
  const parsed = validateFeedbackCreate({
    comment: args?.comment,
    question: args?.question,
    answer_excerpt: args?.answer_excerpt,
    model: args?.model,
    page: FEEDBACK_TOOL_PAGE,
  });
  if (typeof parsed.error === "string") {
    return { text: parsed.error, isError: true };
  }

  if (!env?.DB) {
    // Not fail-soft: a report that silently evaporates is worse than one that
    // was refused, because the reporter believes it was filed and stops.
    return {
      text: "Feedback could not be stored — this deployment has no database configured. Nothing was recorded.",
      isError: true,
    };
  }

  // An empty conversation, deliberately: see the header. This makes every MCP
  // report a new entry rather than a follow-up threaded onto whatever the
  // account last reported from a browser.
  const created = await createOrThreadFeedbackEntry(env.DB, String(userId), parsed.entry, []);
  if (!created || !created.id) {
    return {
      text: "Feedback could not be stored just now, and nothing was recorded. Worth trying again shortly.",
      isError: true,
    };
  }

  log.info("mcp.feedback_filed", {
    tool: name,
    user_id: userId,
    request_id: billing?.requestId,
    entry_id: created.id,
    // The comment itself is NOT logged. It is user content, it rests in D1
    // where the queue reads it, and invariant 4 keeps conversation text out of
    // Workers Logs — the id is what a debugger needs to find the row.
    comment_chars: String(parsed.entry.comment || "").length,
    has_question: !!parsed.entry.question,
    has_excerpt: !!parsed.entry.answer_excerpt,
  });

  return {
    text:
      `Filed as feedback #${created.id}. It is on the maintainers' work queue and a person reads it; if they ` +
      "reply, the answer appears in this account's feedback view on the site. Nothing else was sent.",
    isError: false,
    entryId: created.id,
  };
}
