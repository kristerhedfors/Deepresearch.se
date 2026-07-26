// @ts-check
// THE SE/CURE POSTURE CORE — what this session may honestly claim, given the
// configuration it was entered with.
//
// Se/cure's standing promise is "nothing leaves this browser", and its
// decoration says so loudly: the strolling ghost's speech bubbles, the
// first-visit greeter, the intro glass pane. That promise is true for a
// session running on the user's OWN machine or straight to the user's OWN
// provider — and it is FALSE for a session that was handed a borrowed
// allowance or a shared-compute pool token, where prompts deliberately travel
// through this site's server and, in the pool case, on to another person's
// computer.
//
// A user arriving on a shared-compute workspace link therefore met a flurry of
// "no server's watching — cross my heart 👻" while their queries were being
// routed to a third party (feedback #31, 2026-07-26). The decoration was
// unconditional; the session was not. This module makes the claims a FUNCTION
// of the configuration, so every surface that speaks for the tier — the ghost,
// the greeter, the pane, the tier explainer — says the same true thing.
//
// Pure, dependency-free, Node-testable (the bash-core.js convention): callers
// gather the route facts from the same accessors the send path resolves and
// render the returned strings.

/**
 * The four postures, ordered from "nothing leaves" to "a named human reads
 * your prompts". Worst exposure wins when several apply at once.
 *
 * - `local`  — the model runs on this device (the keyless local server or the
 *              in-browser on-device engine). No model call leaves at all.
 * - `direct` — browser → the user's OWN provider on the user's OWN key. This
 *              site's server is not in the path; the provider can read it.
 * - `routed` — a borrowed, metered allowance carries the model calls THROUGH
 *              this site's server to Berget.
 * - `peer`   — shared compute: the answer is computed on ANOTHER USER's
 *              machine, reached through the server's relay. A named person
 *              reads everything sent.
 */
export const SECURE_POSTURES = ["local", "direct", "routed", "peer"];

/**
 * Resolve the session's posture from its route facts.
 *
 * `pool` deliberately outranks `viaProxy`: a pooled completion is relayed by
 * the server AND read by a peer, so it is strictly the larger disclosure and
 * must never be described as merely "borrowed".
 *
 * @param {{pool?: boolean, viaProxy?: boolean, local?: boolean}} [ctx]
 * @returns {"local"|"direct"|"routed"|"peer"}
 */
export function securePosture(ctx = {}) {
  if (ctx.pool) return "peer";
  if (ctx.viaProxy) return "routed";
  if (ctx.local) return "local";
  return "direct";
}

/** True when this session sends nothing anywhere — the only case in which the
 * tier's unqualified "it all stays here" line is the whole truth.
 * @param {{pool?: boolean, viaProxy?: boolean, local?: boolean, search?: string|null}} [ctx] */
export function fullyLocalSession(ctx = {}) {
  return securePosture(ctx) === "local" && normalizedSearch(ctx.search) === "off";
}

/** @param {string|null|undefined} search @returns {"off"|"self"|"grant"} */
function normalizedSearch(search) {
  return search === "self" || search === "grant" ? search : "off";
}

// ---- the strolling ghost's speech bubbles -------------------------------------

// One quip per fact, in the order that matters: where the ANSWER comes from
// (the claim that was wrong), what this browser keeps, and where SEARCH words
// go. Kept short — they float above a moving character — and honest at every
// posture, so the mascot never contradicts the notice under the ℹ.

/** @param {{peerLabel?: string|null}} opts */
const peerName = (opts) => (opts && opts.peerLabel) || "another person";

/**
 * The ghost's quips for this session, worst-first when there is bad news.
 * Always at least three, always in the ghost's voice — the tone stays playful,
 * the FACTS follow the configuration.
 * @param {{pool?: boolean, viaProxy?: boolean, local?: boolean,
 *          search?: string|null, peerLabel?: string|null}} [ctx]
 * @returns {string[]}
 */
export function securePostureQuips(ctx = {}) {
  const posture = securePosture(ctx);
  const search = normalizedSearch(ctx.search);
  /** @type {string[]} */
  const quips = [];

  // 1. Where the answers come from. At `peer` and `routed` this LEADS, because
  //    it is the thing a visitor would otherwise get wrong.
  if (posture === "peer") {
    quips.push(`Careful: ${peerName(ctx)}'s machine answers you here. 👀`);
    quips.push("They can read every prompt you send through it.");
  } else if (posture === "routed") {
    quips.push("Your messages ride through this site's server on a borrowed pass.");
  } else if (posture === "local") {
    quips.push("The model runs on your own machine. Nothing leaves at all.");
  } else {
    quips.push("Your prompts go straight to your provider — no stop here. 👻");
  }

  // 2. What this browser keeps. True at EVERY posture: Se/cure stores chats,
  //    keys and projects sealed in this browser in all configurations, and
  //    that part of the promise never needed qualifying.
  quips.push("Your chats and keys stay sealed in this browser either way.");

  // 3. Where search words go.
  if (search === "grant") {
    quips.push("Search words travel through this server to Exa. Nothing else does.");
  } else if (search === "self") {
    quips.push("Only your search words go out, to the service you picked.");
  } else if (posture === "local") {
    quips.push("No web search either. Spooky quiet in here.");
  } else {
    quips.push("Web search is off — nothing is looked up anywhere.");
  }

  return quips;
}

// ---- the greeter popover / intro pane ------------------------------------------

/**
 * The tier's self-description for THIS session: a headline and a short set of
 * paragraphs, used by the first-visit greeter and the intro glass pane. The
 * unqualified "the server never sees them" line survives only where it is
 * true; every other posture states the route it actually uses first.
 * @param {{pool?: boolean, viaProxy?: boolean, local?: boolean,
 *          search?: string|null, peerLabel?: string|null,
 *          workspaceName?: string|boolean}} [ctx]
 * @returns {{ headline: string, lines: string[] }}
 */
export function securePostureBrief(ctx = {}) {
  const posture = securePosture(ctx);
  const search = normalizedSearch(ctx.search);
  const who = peerName(ctx);
  /** @type {string[]} */
  const lines = [];

  if (posture === "peer") {
    lines.push(
      `This session is set up to answer with SHARED COMPUTE: your prompts leave this browser, pass through this site's server, and are computed on ${who}'s machine. ${who} can read everything you send through it.`,
    );
  } else if (posture === "routed") {
    lines.push(
      "This session was handed a borrowed allowance: your conversation is sent THROUGH this site's server to Berget, metered and time-limited. It is the one call path where your text touches the server.",
    );
  } else if (posture === "local") {
    lines.push(
      "This session answers on a model running on your own device — the conversation reaches no third party at all, this site's server included.",
    );
  } else {
    lines.push(
      "Every model call goes straight from this page to the provider whose key you set — this site's server is never in the path, so it could not read or log your messages even if it wanted to.",
    );
  }

  // What is true in EVERY configuration, and worth keeping: the local vault.
  lines.push(
    "Your chats, keys and projects are sealed in this browser's storage in every configuration — nothing about them is stored on a server.",
  );

  if (search === "grant") {
    lines.push("Web search runs on a borrowed allowance: only the search query leaves, through this site's server to Exa.");
  } else if (search === "self") {
    lines.push("Web search goes straight from this browser to the service you configured — only the query leaves.");
  }

  return { headline: postureHeadline(posture), lines };
}

/** @param {"local"|"direct"|"routed"|"peer"} posture */
function postureHeadline(posture) {
  if (posture === "peer") return "You're on Se/cure — with shared compute connected";
  if (posture === "routed") return "You're on Se/cure — with a borrowed allowance connected";
  if (posture === "local") return "You're on Se/cure — fully on your own machine";
  return "You're on Se/cure";
}

/**
 * The ONE-LINE version, for places with room for a sentence and not a
 * paragraph (the tier explainer's ghost card, a banner). Always the route,
 * never the reassurance, when the route is the surprising part.
 * @param {{pool?: boolean, viaProxy?: boolean, local?: boolean,
 *          search?: string|null, peerLabel?: string|null}} [ctx]
 * @returns {string}
 */
export function securePostureLine(ctx = {}) {
  const posture = securePosture(ctx);
  if (posture === "peer") return `Answers are computed on ${peerName(ctx)}'s machine — they can read what you send.`;
  if (posture === "routed") return "Model calls run through this site's server on a borrowed, metered allowance.";
  if (posture === "local") return "The model runs on your own device — no model call leaves it.";
  return "Model calls go straight from this browser to your own provider; this site's server is not in the path.";
}
