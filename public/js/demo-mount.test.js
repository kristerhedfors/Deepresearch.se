import test from "node:test";
import assert from "node:assert/strict";
import { demoSurfacePossible } from "./demo-mount.js";
import { demoIntent } from "./demo-core.js";

// mountDemoSurface itself is DOM + dynamic-import glue and is verified live (the
// live-verify skill). What is testable here — and worth pinning, because getting
// it wrong is either a broken feature or a fat first paint — is the pure pre-gate
// the decision rests on.

test("demoSurfacePossible never blocks a turn that would have mounted something", () => {
  // The callers skip placing a host element at all when this says no, so a false
  // negative is a silently missing surface. Its contract is one-directional: no
  // means there is nothing to try; yes only means it is worth trying.
  const turns = [
    { questionText: "show me a rocket launch from space" },
    { questionText: "show me visually", priorText: "Space launch demo" },
    { questionText: "hur långt bort är månen?" },
    { questionText: "visa mig solsystemet" },
    { questionText: "what is the capital of France?" },
    { questionText: "compare Claude and GPT pricing" },
  ];
  for (const turn of turns) {
    if (demoIntent(turn.questionText, turn.priorText || "")) {
      assert.equal(demoSurfacePossible(turn), true, `blocked: ${turn.questionText}`);
    }
  }
  // And it says no to the ordinary research turns, which is the point.
  assert.equal(demoSurfacePossible({ questionText: "compare Claude and GPT pricing" }), false);
  assert.equal(demoSurfacePossible({}), false);
  for (const junk of [null, undefined, 42, { questionText: 42 }]) {
    assert.equal(demoSurfacePossible(/** @type {any} */ (junk)), false, String(junk));
  }
});

test("demoSurfacePossible honours the bare-visual-ask inheritance", () => {
  // "Space launch demo" → "show me visually" is feedback #50's sequence; the
  // pre-gate has to see the second message as an ask too, or a reload of that
  // conversation loses its scene.
  assert.equal(demoSurfacePossible({ questionText: "show me visually", priorText: "Space launch demo" }), true);
  assert.equal(demoSurfacePossible({ questionText: "hur ser den ut?" }), false);
});
