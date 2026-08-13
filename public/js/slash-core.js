// @ts-check
// SLASH COMMANDS — the platform's deterministic composer command surface,
// shared by BOTH tiers (owner directive, 2026-07-26, feedback #26: "let's have
// slash commands just like most orchestrators do … and those shall be
// available in every agent").
//
// A slash command is PLATFORM BASELINE, not an agent feature: typing `/help` in
// Orchestrator does the same thing as typing it in Deep Science, Cyber, Agent
// Studio, Introspection or Outrospection, and the same thing on Se/cure as on
// Se/rver.
// That is the whole point of the directive — the user should not have to know
// which agent is listening to reach the developers or the documentation. So the
// registry lives here, in one dependency-free pure core, and every consumer
// reads it generically:
//
//   - the typeahead MENU in both composers (public/js/slash-menu.js, mounted by
//     public/js/app.js on Se/rver and public/cure/drc.js on Se/cure);
//   - the Se/rver ROUTING (src/slash.js is the façade; src/chat.js resolves the
//     command before the mode/agent dispatch, so no executor phase can swallow
//     one — src/pipeline.js then answers it);
//   - the Se/cure ROUTING (public/cure/drc.js send(), before provider routing,
//     so a command works with no model configured at all);
//   - the feedback gate (public/js/feedback-core.js feedbackRequested), which
//     accepts `/feedback …` alongside the older bare keyword.
//
// Adding a THIRD command is one entry in SLASH_COMMANDS plus one branch where
// its effect is honored. Nothing else in either tier enumerates the commands.
//
// INVARIANT 1 (no function calling): this is deterministic code reading a
// literal table. A model never decides that a message was a command, and a
// command never becomes a tool call.
//
// INVARIANT 6 (EN/SV parity): the command NAMES are not translated — `/feedback`
// and `/help` are the same two tokens in both languages, exactly as `/help` is
// in every chat product a Swedish user has already used, and translating them
// would mean a Swedish user's muscle memory silently failing. What IS
// translated, with the same breadth, is everything the user READS: the menu
// label, the argument hint and the one-line description. Language selection
// follows the repo's established convention — the deterministic, EN-default
// `detectLang` from canned-faq.js, applied by the caller to the user's own
// text — so nothing here has to guess a locale.

/**
 * One command in the registry.
 * @typedef {Object} SlashCommand
 * @property {string} name       the token after the slash, lowercase, no slash
 * @property {string} effect     what the tiers route on ("feedback" | "help")
 * @property {{ en: string, sv: string }} label     menu heading
 * @property {{ en: string, sv: string }} args      argument hint, "" when it takes none
 * @property {{ en: string, sv: string }} desc      the one-line description in the menu
 */

/** The character that opens a command. */
export const SLASH = "/";

/**
 * THE registry. Two commands for now (the owner's "for starters"), both
 * available in every agent and on both tiers.
 * @type {SlashCommand[]}
 */
export const SLASH_COMMANDS = [
  {
    name: "feedback",
    effect: "feedback",
    label: { en: "Feedback", sv: "Feedback" },
    args: { en: "[your message]", sv: "[ditt meddelande]" },
    desc: {
      en: "Send this straight to the developers — never researched, never run through a model.",
      sv: "Skicka direkt till utvecklarna — forskas aldrig på, körs aldrig genom en modell.",
    },
  },
  {
    name: "help",
    effect: "help",
    label: { en: "Help", sv: "Hjälp" },
    args: { en: "[your question]", sv: "[din fråga]" },
    desc: {
      en: "Answer from this site's documentation — how something works, in any mode.",
      sv: "Svara utifrån sajtens dokumentation — hur något fungerar, i alla lägen.",
    },
  },
];

/** Every command name, registry order. */
export const SLASH_COMMAND_NAMES = SLASH_COMMANDS.map((c) => c.name);

/** Every effect a tier may be asked to honor, registry order. */
export const SLASH_EFFECTS = SLASH_COMMANDS.map((c) => c.effect);

/**
 * The registry entry for a name (case-insensitive), or null.
 * @param {unknown} name
 * @returns {SlashCommand | null}
 */
export function slashCommand(name) {
  const n = String(name ?? "").trim().toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === n) || null;
}

// The command form. Leading whitespace is tolerated for the same reason
// FEEDBACK_PATTERNS tolerate it (a pasted or soft-wrapped message often carries
// some), and the separator after the name may be whitespace OR a colon
// ("/feedback: the map is cut off") because that is how people already write
// the bare keyword. The name must be the WHOLE token: "/helper" is not "/help",
// and "/etc/passwd" is not a command at all — an unknown name is ordinary text,
// never an error, so a research question that happens to open with a path is
// researched exactly as before.
const COMMAND_RE = /^\s*\/([A-Za-z0-9_-]+)(?:[:\s]([\s\S]*))?$/;

/**
 * Parse a composed message into a command + its argument text. Null when the
 * message is not a known command — which is the common case and must stay
 * completely inert.
 * @param {unknown} text
 * @returns {{ command: SlashCommand, name: string, effect: string, args: string } | null}
 */
export function parseSlashCommand(text) {
  const m = COMMAND_RE.exec(String(text ?? ""));
  if (!m) return null;
  const command = slashCommand(m[1]);
  if (!command) return null;
  return { command, name: command.name, effect: command.effect, args: String(m[2] ?? "").trim() };
}

/**
 * The effect a message asks for, or null. The one function the routing layers
 * need: `slashEffect(text) === "feedback"`.
 * @param {unknown} text
 * @returns {string | null}
 */
export function slashEffect(text) {
  return parseSlashCommand(text)?.effect ?? null;
}

/**
 * The message with its command prefix removed — what the user actually wrote.
 * Falls back to the original text when there is no command, and ALSO when the
 * command carried no argument: a bare `/feedback` then behaves exactly like the
 * bare keyword "feedback" always has, rather than recording an empty note.
 * @param {unknown} text
 * @returns {string}
 */
export function slashArgs(text) {
  const raw = String(text ?? "");
  const parsed = parseSlashCommand(raw);
  return parsed && parsed.args ? parsed.args : raw;
}

// ---- the typeahead menu's pure half ----------------------------------------
//
// The menu opens on a slash typed at the START of the composer and closes the
// moment the text stops being a bare command token — so `/f` filters the list
// while "/feedback the map is cut off" (a command with an argument, already
// being written) shows nothing, and neither does "what does /etc do?" (the
// slash is not at position 0). No leading-whitespace tolerance here on purpose:
// the parse above is forgiving because it judges a SENT message, while the menu
// judges what is on screen, where "the first character is a slash" is the rule
// the user can see.

const QUERY_RE = /^\/([A-Za-z0-9_-]*)$/;

/**
 * The partial command name being typed ("" for a lone slash), or null when the
 * composer's text is not an open command token.
 * @param {unknown} text
 * @returns {string | null}
 */
export function slashQuery(text) {
  const m = QUERY_RE.exec(String(text ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The commands to offer for what is currently typed — every command for a lone
 * slash, prefix-filtered as the user keeps typing, empty when the menu should
 * be closed. Registry order is preserved so the list never reshuffles under the
 * user's finger.
 * @param {unknown} text
 * @returns {SlashCommand[]}
 */
export function slashSuggestions(text) {
  const q = slashQuery(text);
  if (q === null) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

/**
 * The renderable rows for the menu: the localized strings plus the text to put
 * in the composer when a row is chosen (the command and a trailing space, so
 * the user types the argument straight on).
 * @param {unknown} text
 * @param {"en" | "sv"} [lang]
 * @returns {Array<{ name: string, title: string, hint: string, desc: string, insert: string }>}
 */
export function slashMenuItems(text, lang = "en") {
  const l = lang === "sv" ? "sv" : "en";
  return slashSuggestions(text).map((c) => ({
    name: c.name,
    title: SLASH + c.name,
    hint: c.args[l],
    desc: c.desc[l],
    insert: SLASH + c.name + " ",
  }));
}

/**
 * Move a highlighted index within a list of n rows, wrapping at both ends.
 * Pure so the keyboard behaviour is unit-tested without a DOM.
 * @param {number} index current index
 * @param {number} delta -1 (up) or +1 (down)
 * @param {number} count number of rows
 * @returns {number}
 */
export function moveSlashIndex(index, delta, count) {
  if (!count) return 0;
  const i = Number.isInteger(index) ? index : 0;
  return ((i + delta) % count + count) % count;
}
