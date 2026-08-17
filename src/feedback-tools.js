// @ts-check
// THE FEEDBACK TOOL ON /mcp — telling this platform it got something wrong,
// from the client that got the wrong thing.
//
// Why it belongs on this surface at all. The feedback loop
// (skills-disabled/feedback-loop, src/feedback.js) is how a user report becomes
// a fix: it is read as a work queue, decided on one entry at a time, and
// answered back. Every existing way in is a SCREEN — the chat's `/feedback`
// command, the account panel, the Se/cure write-only endpoint. So the callers
// most likely to hit a rough edge on this surface, the agents and voice clients
// driving `deep_research` through an MCP key, were the ones with no way to say
// so. Their report had to travel through a human who would open the site.
//
// ONE tool, and the shape is deliberately the narrow one:
//
//   send_feedback   file a report against this platform, threaded to the account
//
// WHAT IT IS NOT. It does not read the queue. An MCP key is not a login (the
// server-token guarantee, CLAUDE.md invariant 4), and a tool that could list
// feedback would let any key holder read what other people reported —
// conversations included, since `feedback.context` carries whole transcripts on
// the chat path. Write-only is the same posture
// `POST /api/server-token/feedback` already takes for Se/cure, and for the same
// reason: filing is safe, reading is not.
//
// FREE, like `platform_map` and the `literature_fetch` pair. It writes one D1
// row and contacts no provider, so it takes no quota and holds no concurrency
// slot — an agent whose budget is gone is exactly the agent with something to
// report, and a slot held on a free call could only deny the caller its own
// next call.
//
// PURE — imports nothing, so src/mcp-config.js (a leaf by contract) can take the
// catalog row from here, exactly as it takes PLATFORM_MCP_CATALOG and
// EXTENSION_MCP_CATALOG. Everything touching a binding is in
// src/feedback-tools-run.js behind a dynamic import.

/** The tool name. A verb, because a model routes on names: "tell them this was
 *  wrong" has to land somewhere obvious without the caller knowing an enum. */
export const FEEDBACK_TOOL_NAME = "send_feedback";

/** @type {Set<string>} */
export const FEEDBACK_TOOL_NAMES = new Set([FEEDBACK_TOOL_NAME]);

/** Spends nothing at any provider, so it is outside the quota gate — the same
 *  membership test the other free tools fail. Exported as an empty set rather
 *  than omitted, so the mirror assertions in mcp-inflight.test.js can name it. */
export const FEEDBACK_SPENDING_TOOLS = new Set();

/** Recorded as the entry's `page`, which is what tells whoever reads the queue
 *  where a report came IN from. Without it an MCP report is indistinguishable
 *  from a browser one, and the first question a reader asks about a rough edge
 *  is which surface produced it. */
export const FEEDBACK_TOOL_PAGE = "mcp:send_feedback";

/**
 * The tool definition served in `tools/list`.
 *
 * The description carries three things the calling model cannot infer and will
 * otherwise get wrong: that this WRITES rather than reads, that it reaches a
 * person rather than a bot, and that it should carry what actually happened
 * instead of a summary of the complaint. The last one is the difference between
 * an entry someone can act on and one that needs a reply asking what happened.
 */
export const FEEDBACK_MCP_TOOLS = [
  {
    name: FEEDBACK_TOOL_NAME,
    description:
      "Send feedback about this platform to the people who maintain it — a wrong or unhelpful answer, a tool that " +
      "behaved unexpectedly, a missing capability, or a suggestion. Use it when the user says something like " +
      '"tell them this is wrong", "report this", "give them feedback", or when you have hit a limitation worth ' +
      "reporting. The report is filed against the account whose key made this call and is read by a human, who may " +
      "act on it and reply — it is a work queue, not an automated channel, so write what would let someone " +
      "reproduce the problem rather than a summary of the complaint. Include the question that produced the bad " +
      "result in `question` and the part that was wrong in `answer_excerpt`; both are what make an entry " +
      "actionable. Writes only: it cannot read feedback, yours or anyone else's. Costs nothing and needs no quota.",
    inputSchema: {
      type: "object",
      properties: {
        comment: {
          type: "string",
          description:
            "Required. What is wrong, missing, or worth changing, in the user's own terms where you have them. " +
            "This is the entry a person reads first.",
        },
        question: {
          type: "string",
          description:
            "Optional but strongly preferred. The question or request that produced the problem, verbatim. A " +
            "report that cannot be reproduced usually gets a reply asking for this.",
        },
        answer_excerpt: {
          type: "string",
          description:
            "Optional. The part of the answer that was wrong, quoted rather than described — the specific claim, " +
            "citation, or number, not a characterisation of it.",
        },
        model: {
          type: "string",
          description:
            "Optional. The model that produced the answer being reported on, if you know which one it was.",
        },
      },
      required: ["comment"],
    },
  },
];

/**
 * The Settings → MCP server catalog row. `def: true` — it arrives exposed, like
 * every other free tool: it costs the account nothing, and an account that
 * cannot report a defect is one whose defects are found some slower way.
 */
export const FEEDBACK_MCP_CATALOG = [
  {
    id: FEEDBACK_TOOL_NAME,
    group: "This platform",
    label: FEEDBACK_TOOL_NAME,
    blurb:
      "Lets a connected client file feedback against your account — a wrong answer, a rough edge, a suggestion. " +
      "Write-only: it cannot read the feedback queue. Contacts nothing and spends nothing.",
    def: true,
  },
];
