// @ts-check
// The CAPABILITY-DEMO registry's server FAÇADE: a pure re-export of the ONE
// shared core public/js/demo-core.js (the registry of demonstrable surfaces,
// the EN+SV "show me X demo" gate, and the bare-visual-ask inheritance). No
// endpoint of its own — the registry is consumed by the pipeline, which
// re-runs the SAME deterministic gate over the SAME text the chat clients did,
// so the answer prompts know which surface is already displayed beside the
// reply and stop apologising for being unable to show anything.
//
// The core lives under public/ for the same reason space-core.js and
// bash-core.js do: the browser can only import served modules, the Worker
// bundler imports from anywhere — one implementation, two faces. Any drift
// between what the client mounts and what the prompt is told is therefore
// impossible by construction.

export {
  DEMOS,
  demoById,
  demoIntent,
  demoIntentMatch,
  demoSurfaceTitle,
  isBareShowAsk,
  showVerbLang,
} from "../public/js/demo-core.js";
