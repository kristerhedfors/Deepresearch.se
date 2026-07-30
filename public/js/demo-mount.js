// @ts-check
// The ONE mount decision behind the capability-demo registry: given the turn
// being rendered, which of the site's own surfaces goes above the reply — and
// which module has to be fetched to draw it.
//
// Both tiers used to carry their own copy of this branch (turns.js
// mountDemoEmbed, drc.js mountDrcSpaceEmbed) and it was fine while there were
// two outcomes. The inline watch builder (feedback #52) adds a third, plus a
// fallback between two of them and a conversation-wide state walk, and two
// copies of THAT is how a tier quietly drifts. So the decision lives here once
// and each tier keeps only its DOM placement.
//
// LAZY BY CONSTRUCTION. Every renderer is dynamic-imported, and the watch
// modules — the catalogue is the biggest pure-data module in the client — are
// only reached when the conversation has actually opened a watch thread. The
// pre-gate for that is demo-core.js's own matcher, which the caller already has
// loaded, so a conversation that never mentions watches never pays a byte.
//
// Fail-soft throughout: every path returns a boolean and swallows its own
// errors. A demo that cannot draw must cost a turn nothing.

import { demoById, demoIntent } from "./demo-core.js";

// The host page's composer, when a tier has lent us one. The inline watch
// builder's suggestion chips send the command they show, and this is the whole
// wiring for it. Registered HERE rather than on watch-embed.js itself so a boot
// module can lend the composer without statically importing the builder — which
// would pull the whole parts catalogue into the app's first paint and undo the
// laziness this module exists to keep. Unset, the chips are read-only hints.
/** @type {((text: string) => void) | null} */
let commandSender = null;

/**
 * Lend the demo surfaces the page's composer. Called once at boot by each tier.
 * @param {(text: string) => void} fn
 */
export function setDemoCommandSender(fn) {
  commandSender = typeof fn === "function" ? fn : null;
}

/**
 * The user messages of a conversation as plain text, oldest first — the input
 * the watch thread walks. Accepts both message shapes the two tiers store: a
 * plain string, or the multipart array the Se/rver app sends with attachments.
 * @param {unknown} messages
 * @returns {string[]}
 */
export function userTextsOf(messages) {
  /** @type {string[]} */
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) {
      out.push(
        content
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join(" "),
      );
    } else out.push("");
  }
  return out;
}

/**
 * Could a watch thread be open in this conversation? A thread can ONLY start on
 * an explicit watch demo ask, which demo-core.js decides on its own — so this
 * answers "is it worth loading the builder" without loading it.
 * @param {string[]} userTexts
 * @returns {boolean}
 */
export function watchOpenedIn(userTexts) {
  const texts = Array.isArray(userTexts) ? userTexts : [];
  for (let i = 0; i < texts.length; i++) {
    const m = demoIntent(texts[i], i > 0 ? texts[i - 1] : "");
    if (m && m.id === "watch") return true;
  }
  return false;
}

/**
 * @typedef {{ questionText?: string, priorText?: string, userTexts?: string[] }} DemoTurn
 */

/**
 * The user side this turn resolves against: what the caller passed, or the
 * question and the turn before it when that is all there is.
 * @param {DemoTurn} turn
 * @returns {string[]}
 */
function textsOf(turn) {
  const questionText = turn.questionText || "";
  const priorText = turn.priorText || "";
  return Array.isArray(turn.userTexts) && turn.userTexts.length
    ? turn.userTexts
    : [priorText, questionText].filter(Boolean);
}

/**
 * Could ANY surface mount for this turn? SYNCHRONOUS and cheap — demo-core.js
 * only, no dynamic import — so a caller can decide whether to place a host
 * element at all. Without it every ordinary turn in every conversation inserts a
 * host div and removes it a microtask later, which is layout churn on a
 * re-rendered history for no reason. A true answer here does not promise a mount
 * (WebGL may still be missing); a false one promises there is nothing to try.
 * @param {DemoTurn} turn
 * @returns {boolean}
 */
export function demoSurfacePossible(turn = {}) {
  try {
    if (demoIntent(turn.questionText || "", turn.priorText || "")) return true;
    return watchOpenedIn(textsOf(turn));
  } catch {
    return false;
  }
}

/**
 * Mount the surface this turn calls for into `host`, setting host.className to
 * say which one it was. Resolves true when something mounted.
 *
 * The order is the registry's: a /space/ scene is the most specific answer and
 * wins whenever it matches; then the watch thread, which can be live on a turn
 * whose own text matched nothing (a bare "pepsi bezel" is a command, not an
 * ask); then a link card for any page-only surface.
 *
 * @param {HTMLElement} host an element the caller has already placed
 * @param {DemoTurn} turn
 * @returns {Promise<boolean>}
 */
export async function mountDemoSurface(host, turn = {}) {
  try {
    if (!host) return false;
    const questionText = turn.questionText || "";
    const priorText = turn.priorText || "";
    const userTexts = textsOf(turn);
    const match = demoIntent(questionText, priorText);

    if (match && match.kind === "space") {
      host.className = "space-embed-host";
      const { mountSpaceScene } = await import("./space-embed.js");
      return !!mountSpaceScene(host, match.sceneId || "", { lang: match.lang, caption: true, moreLink: true });
    }

    if (watchOpenedIn(userTexts)) {
      const { watchThread, builderLink } = await import("./watch-chat-core.js");
      const state = watchThread(userTexts);
      if (state.active) {
        host.className = "watch-embed-host";
        const { mountWatchBuild } = await import("./watch-embed.js");
        if (mountWatchBuild(host, state, { lang: state.lang, onCommand: commandSender })) return true;
        // No WebGL here. Degrade to the card: the builder still exists, this
        // device just cannot draw it in the turn — and the card carries THIS
        // build's permalink, so the app opens on the watch the conversation
        // reached rather than on the default one (feedback #56).
        const entry = demoById("watch");
        if (!entry) return false;
        host.className = "demo-card-host";
        const { mountDemoCard } = await import("./demo-embed.js");
        return !!mountDemoCard(host, {
          ...entry, kind: "page", lang: state.lang, path: builderLink(state.code || state.build),
        });
      }
    }

    if (match) {
      host.className = "demo-card-host";
      const { mountDemoCard } = await import("./demo-embed.js");
      return !!mountDemoCard(host, { ...match, kind: "page" });
    }
    return false;
  } catch {
    return false;
  }
}
