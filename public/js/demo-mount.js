// @ts-check
// The ONE mount decision behind the capability-demo registry: given the turn
// being rendered, which of the site's own surfaces goes above the reply — and
// which module has to be fetched to draw it.
//
// Both tiers used to carry their own copy of this branch (turns.js
// mountDemoEmbed, drc.js mountDrcSpaceEmbed), and two copies of a routing
// decision is how a tier quietly drifts. So the decision lives here once and
// each tier keeps only its DOM placement.
//
// LAZY BY CONSTRUCTION. Every renderer is dynamic-imported, and the pre-gate is
// demo-core.js's own matcher, which the caller already has loaded — so a
// conversation that asks for no surface never pays a byte for one.
//
// Fail-soft throughout: every path returns a boolean and swallows its own
// errors. A demo that cannot draw must cost a turn nothing.

import { demoIntent } from "./demo-core.js";

/**
 * @typedef {{ questionText?: string, priorText?: string }} DemoTurn
 */

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
    return !!demoIntent(turn.questionText || "", turn.priorText || "");
  } catch {
    return false;
  }
}

/**
 * Mount the surface this turn calls for into `host`, setting host.className to
 * say which one it was. Resolves true when something mounted.
 *
 * The order is the registry's: a /space/ scene is the most specific answer and
 * wins whenever it matches; then a link card for any page-only surface.
 *
 * @param {HTMLElement} host an element the caller has already placed
 * @param {DemoTurn} turn
 * @returns {Promise<boolean>}
 */
export async function mountDemoSurface(host, turn = {}) {
  try {
    if (!host) return false;
    const match = demoIntent(turn.questionText || "", turn.priorText || "");
    if (!match) return false;

    if (match.kind === "space") {
      host.className = "space-embed-host";
      const { mountSpaceScene } = await import("./space-embed.js");
      return !!mountSpaceScene(host, match.sceneId || "", { lang: match.lang, caption: true, moreLink: true });
    }

    host.className = "demo-card-host";
    const { mountDemoCard } = await import("./demo-embed.js");
    return !!mountDemoCard(host, { ...match, kind: "page" });
  } catch {
    return false;
  }
}
