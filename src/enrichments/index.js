// Enrichment registry.
//
// The in-pipeline enrichments (Shodan host intelligence, Google Maps / Street
// View) all share one shape: deterministic target extraction → a bounded,
// privacy-minimal lookup → append ONE labeled context block to the
// conversation (via withAppendedText) → emit a named activity step ONLY when
// something real happened → fail soft → count into state.*Count. This module
// codifies that shape so the pipeline drives them through one loop instead of
// a hand-wired `if (state.shodan)` / `if (state.googleMaps)` block per source.
//
// A descriptor is:
//   {
//     id,               // step id + activity id ("shodan" | "maps")
//     settingsKey,      // the users.settings_json knob key
//     stateFlag,        // the pre-resolved per-request state flag chat.js sets
//     countKey,         // where the hosts-found / maps-found count is stashed
//     startLabel,       // step_start label
//     unavailableLabel, // step_done label when run() returns null / throws
//     failEvent,        // log event name when run() throws
//     enabled(env, identity) -> boolean,     // settings-module gate
//     detect(conversation, state) -> targets | null,  // null = stay silent
//     run(ctx, targets) -> { block, details, count, doneLabel, embed? } | null
//   }
//
// The reverse-geocode enrichment (chat.js's augmentWithLocations, run
// pre-pipeline) is deliberately NOT in this registry yet — it runs before the
// pipeline is even entered and is out of scope here. It could join later by
// adopting the same descriptor shape.

import { withAppendedText } from "../conversation.js";
import { shodanEnrichment } from "./shodan.js";
import { googleMapsEnrichment } from "./googlemaps.js";

// Order matters: Shodan first, then Google Maps — exactly the order the
// hand-wired pipeline ran them in, so each block is appended in the same
// sequence and downstream phases see an identical conversation.
export const ENRICHMENTS = [shodanEnrichment, googleMapsEnrichment];

function safeEnabled(enr, env, identity) {
  try {
    return !!enr.enabled?.(env, identity);
  } catch {
    return false;
  }
}

// Iterates the registry, running each enabled enrichment whose detect() finds
// a target, appending its context block, and emitting its activity step.
// Returns the (possibly augmented) conversation. Every enrichment is fully
// fail-soft — a detect() or run() that throws degrades to "no enrichment" and
// leaves the conversation unchanged, never breaking the request.
//
// Gating: when `identity` is supplied the settings-module gate
// (enr.enabled(env, identity)) decides; otherwise the pre-resolved
// per-request state flag (state[enr.stateFlag]) does — which is how the
// pipeline calls it, since runPipeline has no identity and chat.js already
// resolved every knob into the state. `registry` is overridable for testing.
export async function runEnrichments(env, log, emit, conversation, state, identity, registry = ENRICHMENTS) {
  const step = (id, label) => emit({ status: { type: "step_start", id, label } });
  const stepDone = (id, label, details = []) => emit({ status: { type: "step_done", id, label, details } });

  let convo = conversation;
  for (const enr of registry) {
    const on = identity != null
      ? safeEnabled(enr, env, identity)
      : enr.stateFlag
        ? !!state?.[enr.stateFlag]
        : true;
    if (!on) continue;

    let targets = null;
    try {
      targets = enr.detect(convo, state);
    } catch (err) {
      log?.warn?.(`enrichment.${enr.id}_detect_failed`, { error: err?.message || String(err) });
      targets = null;
    }
    if (!targets) continue; // stay silent: no step, no conversation change

    step(enr.id, enr.startLabel);
    let result = null;
    try {
      result = await enr.run({ env, log, emit, state, conversation: convo, step, stepDone }, targets);
    } catch (err) {
      log?.warn?.(enr.failEvent || `enrichment.${enr.id}_failed`, { error: err?.message || String(err) });
    }
    if (!result) {
      stepDone(enr.id, enr.unavailableLabel);
      continue; // conversation unchanged
    }

    if (state && enr.countKey && typeof result.count === "number") {
      state[enr.countKey] = result.count;
    }
    stepDone(enr.id, result.doneLabel, result.details || []);
    if (result.embed) {
      emit({ status: { type: "streetview_embed", lat: result.embed.lat, lng: result.embed.lng } });
    }
    if (result.block) convo = withAppendedText(convo, result.block);
  }
  return convo;
}
