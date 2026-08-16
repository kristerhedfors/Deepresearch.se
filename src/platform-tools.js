// @ts-check
// THE INTROSPECTION FAMILY ON /mcp — asking this platform about ITSELF, out loud.
//
// Introspection already existed on this surface: `deep_research` takes an
// `agent`, and `introspection` is one of the ids it resolves. So the capability
// was reachable and the routing was not. A caller with no screen says "how does
// the research pipeline actually work" into a phone, and the client's model
// picks `deep_research` with no agent — which resolves to Deep Science, the
// terminal fallback, and answers about deep research as a FIELD, from the
// literature. The answer is fluent, well-sourced and about somebody else. That
// is the failure this family fixes, and the fix is a tool NAME: a model routes
// on names far more reliably than it fills in an optional enum it has to know
// exists.
//
// Three tools, and the split is by QUESTION SHAPE rather than by mechanism:
//
//   explain_internals   how does a part of this platform work
//   improvement_areas   where does a part of it have room to improve
//   platform_map        what is there to ask about at all (free, contacts nothing)
//
// The first two run the same machinery — the introspection agent over the
// committed source snapshot — and differ only in the LENS note appended to the
// question. That is deliberate and it is not a duplicate: the two notes ask for
// different work (a mechanism vs a ranked set of levers), and the note also
// steers RETRIEVAL, because the enrichment embeds the last user message and this
// note is part of it. One mechanism, two effects, two names a model can route on.
//
// `platform_map` is the free one, and it is here for the reason
// `literature_corpora` is here: an agent that cannot check what exists will
// conclude that whatever it asked about does not, and say so confidently. A
// caller who hears "the platform has no sandbox" because they said "VM" is worse
// off than one who was told the vocabulary first.
//
// PURE — imports nothing, so src/mcp-config.js (a leaf by contract) can take the
// catalog rows from here without pulling anything into the config layer, exactly
// as it takes EXTENSION_MCP_CATALOG from src/extension-tools.js. Everything that
// touches a binding lives in src/platform-tools-run.js behind a dynamic import.

/** The agent every tool in this family answers as. Resolved through the same
 * registry + grant chain a chat turn uses (src/mcp.js resolveMcpAgent), so this
 * module names the agent and knows nothing else about it. */
export const PLATFORM_AGENT = "introspection";

/**
 * The lens appended to the caller's question for `explain_internals`.
 *
 * Short on purpose. It rides on the user turn, and the introspection enrichment
 * embeds that turn to decide WHICH SOURCE CHUNKS to retrieve — so a long
 * preamble does not just compete for the model's attention, it dilutes the
 * query vector and retrieves worse code. Every word here is either an
 * instruction or a retrieval term, and most are both.
 */
export const EXPLAIN_NOTE =
  "\n\nAnswer about THIS platform's own implementation — the deployed source, its modules, " +
  "its pipeline phases and its documented design decisions — not about the field in general " +
  "and not about any other product with a similar name. Say how it actually works and why it " +
  "was built that way. If the source does not settle something, say that rather than guessing.";

/**
 * The lens appended for `improvement_areas`.
 *
 * The second half is the load-bearing half, and it exists because of a specific
 * way this repository records its own engineering. Several subsystems keep a
 * REGISTER OF SETTLED NEGATIVES — experiments already run, measured, and
 * rejected, written down precisely so nobody spends another session on them.
 * An improvement answer that lists those back as opportunities is not merely
 * unhelpful: it is a confident instruction to redo finished work, and a listener
 * has no way to see that the source said the opposite. So the note asks for the
 * distinction explicitly, and the words it uses ("already measured and
 * rejected", "still open") are also what pull those sections into retrieval.
 */
export const IMPROVE_NOTE =
  "\n\nAnswer about THIS platform's own implementation. Name where it has room to improve, " +
  "in the order that would matter most, and say what evidence in the source or the project's " +
  "own measurements supports each one. Distinguish what is still open from what has already " +
  "been measured and rejected: this project records settled negatives on purpose, and " +
  "reporting one of those as an opportunity would send someone to redo finished work. If a " +
  "limit is known and accepted rather than fixable, say so.";

/** Tool name → the lens note its question carries. */
export const PLATFORM_LENS_NOTES = {
  explain_internals: EXPLAIN_NOTE,
  improvement_areas: IMPROVE_NOTE,
};

/** The shared optional arguments of the two answering tools. Written out twice
 * rather than shared by reference: a JSON Schema that two tools point at is one
 * an editor can change for both by accident, and these two are only the same
 * until one of them isn't. */
const answeringArgs = () => ({
  style: {
    type: "string",
    enum: ["text", "voice"],
    default: "voice",
    description:
      "How the answer is shaped. `voice` (the default here) returns speakable prose: no " +
      "markdown, no bullet lists, no file paths read out character by character, and no " +
      "citation markers. `text` returns the screen-shaped answer with markdown and explicit " +
      "`path/to/file.js` references, which is what you want when the caller can read it. " +
      "The default differs from deep_research's on purpose — these tools were built for a " +
      "caller who is listening.",
  },
  time_budget_s: {
    type: "integer",
    minimum: 15,
    maximum: 600,
    description:
      "How long the investigation may run, in seconds. Defaults to the account's setting, " +
      "lowered for `voice` because a spoken exchange dies in silence long before a chat " +
      "window does. Reading source takes time; below about 30 seconds the answer gets " +
      "shallower rather than faster.",
  },
  model: {
    type: "string",
    description:
      "Answer model id. Optional, and the account may forbid overriding it. A model with " +
      "real tool use investigates the source by grepping and reading it; every other model " +
      "falls back to a deterministic read loop and still answers from the same source.",
  },
});

/**
 * The three tool definitions, in the order src/mcp.js serves them.
 *
 * `explain_internals` leads because it is the one a caller reaches for first;
 * `platform_map` comes last despite being the natural first CALL, because a
 * client scanning the list should meet the capability before the index of it.
 */
export const PLATFORM_MCP_TOOLS = [
  {
    name: "explain_internals",
    description:
      "Explain how this deep-research platform itself works, from its own deployed source. " +
      "Use this for any question about the machinery behind this server — how the research " +
      "pipeline is orchestrated, how a phase or a module or an agent works, why a design " +
      "decision was made, what a subsystem does, how two parts fit together. It reads the " +
      "exact source this deployment is running, plus the project's own documentation and " +
      "engineering playbooks, and investigates it rather than summarising a description of " +
      "it. It does NOT search the web: the answer is grounded in this codebase. Prefer this " +
      "over deep_research whenever the subject is THIS system — deep_research with no agent " +
      "answers from the scientific literature and will describe the field instead. Answers " +
      "in speakable prose by default.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "What to explain, in plain language. Naming a module, a file path, a phase or a " +
            "subsystem sharpens the answer, but is not required — ordinary phrasing works, " +
            "and the question can be asked in English or Swedish.",
        },
        ...answeringArgs(),
      },
      required: ["question"],
    },
  },
  {
    name: "improvement_areas",
    description:
      "Say where a part of this platform has room to improve, from its own source, its " +
      "documentation and its recorded measurements. Use this for questions like \"where " +
      "could X be better\", \"what are the weak points of X\", \"what is worth optimising " +
      "in X\", \"what is still open on X\" — where X is any part of this system. It reads " +
      "the project's own record of what has been tried, what was measured, what shipped and " +
      "what was deliberately rejected, so the answer separates a genuine open lever from an " +
      "experiment that was already run and lost. It does not search the web and it does not " +
      "invent a roadmap: if the source has nothing to say about a part, it says so. Answers " +
      "in speakable prose by default.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "What to assess, in plain language — a subsystem, a module, a file, or the " +
            "platform as a whole. English or Swedish. Naming the part narrows the answer to " +
            "it; a broad question gets a broad survey, which is usually less useful.",
        },
        ...answeringArgs(),
      },
      required: ["question"],
    },
  },
  {
    name: "platform_map",
    description:
      "Describe what this platform is made of and what can be asked about it — the size of " +
      "the source this deployment carries, its main areas, and the named subsystems that " +
      "have their own documented playbook. Contacts nothing, spends nothing, and needs no " +
      "quota. Call this FIRST when you are not sure a subsystem exists or what it is called " +
      "here: guessing at the vocabulary and being told nothing was found reads as \"this " +
      "platform does not have that\", which is usually wrong. Naming an `area` narrows the " +
      "map to the parts matching it. Answers in speakable prose.",
    inputSchema: {
      type: "object",
      properties: {
        area: {
          type: "string",
          description:
            "Optional. A word or two to narrow the map — a subsystem, a technology, a " +
            "concern (\"sandbox\", \"privacy\", \"retrieval\", \"python\"). Matched against " +
            "the names and one-line summaries of the platform's documented areas, which are " +
            "written in ENGLISH: unlike the question the other two tools take, a Swedish term " +
            "here will simply miss. Omit it for the whole map.",
        },
      },
      required: [],
    },
  },
];

/** @type {Set<string>} */
export const PLATFORM_TOOL_NAMES = new Set(PLATFORM_MCP_TOOLS.map((t) => t.name));

/**
 * The subset that reaches a provider, and so holds a concurrency slot and passes
 * the research quota gate. `platform_map` is deliberately outside both, for the
 * same reason `literature_corpora` is: it reads committed artifacts of this very
 * deploy, it costs nothing, and an agent whose budget is gone should still be
 * able to learn what exists rather than be left guessing at names.
 * @type {Set<string>}
 */
export const PLATFORM_SPENDING_TOOLS = new Set(["explain_internals", "improvement_areas"]);

/** The two that answer by running the introspection agent. */
export const PLATFORM_ANSWERING_TOOLS = new Set(Object.keys(PLATFORM_LENS_NOTES));

/** The per-account exposure rows, in src/mcp-config.js's MCP_TOOL_CATALOG shape.
 * On by default like every other tool: nothing here reaches a third party, and
 * the source these answer from is public. */
export const PLATFORM_MCP_CATALOG = [
  {
    id: "explain_internals",
    group: "This platform",
    label: "explain_internals",
    blurb:
      "Explains how this platform works, investigated in the exact source this deployment is " +
      "running. No web search. Runs the research pipeline against the source, so it draws on " +
      "the same research quota as deep_research.",
    def: true,
  },
  {
    id: "improvement_areas",
    group: "This platform",
    label: "improvement_areas",
    blurb:
      "Says where a part of this platform has room to improve, from the source and the " +
      "project's own recorded measurements — separating open levers from experiments already " +
      "run and rejected. Quota-gated like explain_internals.",
    def: true,
  },
  {
    id: "platform_map",
    group: "This platform",
    label: "platform_map",
    blurb:
      "Describes what the platform is made of and what can be asked about it. Reads committed " +
      "artifacts of this deploy — contacts nothing and spends nothing.",
    def: true,
  },
];

/**
 * The question a lens tool actually asks, with its lens appended.
 *
 * Appended, never substituted: the caller's words reach the model exactly as
 * written, which is the same promise `deep_research` makes when it appends the
 * voice note. An unknown name returns the question untouched rather than
 * throwing — this is called on a path where a wrong name is already a
 * method-not-found further up, and inventing a second failure there would only
 * hide the first.
 *
 * @param {string} name the tool name
 * @param {string} question the caller's question
 * @returns {string}
 */
export function lensQuestion(name, question) {
  const note = /** @type {Record<string, string>} */ (PLATFORM_LENS_NOTES)[name] || "";
  return `${question}${note}`;
}

/** The longest question accepted. Long enough for a real multi-clause ask,
 * short enough that a caller cannot push the retrieval query into noise. */
export const MAX_PLATFORM_QUESTION_CHARS = 2000;

/**
 * Read the `question` argument, or say what is wrong with it.
 *
 * A missing question is the one argument error worth refusing rather than
 * defaulting: every other field has a sensible default, and a lens tool with no
 * question has nothing to be about. The message is written for the client's
 * MODEL, which will decide whether to retry — so it says what to send, not that
 * something was invalid.
 *
 * @param {any} args
 * @returns {{ ok: true, question: string } | { ok: false, error: string }}
 */
export function readPlatformQuestion(args) {
  const raw = args && typeof args === "object" ? args.question : undefined;
  const question = typeof raw === "string" ? raw.trim() : "";
  if (!question) {
    return {
      ok: false,
      error:
        "This tool needs a `question` — what about this platform to explain or assess, in " +
        "plain language. Nothing was run and nothing was spent. Send the caller's question " +
        "as `question` and call again.",
    };
  }
  return { ok: true, question: question.slice(0, MAX_PLATFORM_QUESTION_CHARS) };
}
