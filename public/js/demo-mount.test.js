import test from "node:test";
import assert from "node:assert/strict";
import { demoSurfacePossible, userTextsOf, watchOpenedIn } from "./demo-mount.js";
import { demoIntent } from "./demo-core.js";
import { watchThread } from "./watch-chat-core.js";

// mountDemoSurface itself is DOM + dynamic-import glue and is verified live (the
// live-verify skill). What is testable here — and worth pinning, because getting
// it wrong is either a broken feature or a fat first paint — is the two pure
// helpers the decision rests on.

test("userTextsOf takes the user side out of either tier's message shape", () => {
  // Se/cure stores plain strings; the Se/rver app sends multipart content when
  // the message carries attachments. Both have to reduce to the same list.
  const messages = [
    { role: "user", content: "Seiko watch demo" },
    { role: "assistant", content: "here it is" },
    { role: "user", content: [{ type: "text", text: "pepsi bezel" }, { type: "image_url", image_url: { url: "data:," } }] },
    { role: "assistant", content: "changed the insert" },
  ];
  assert.deepEqual(userTextsOf(messages), ["Seiko watch demo", "pepsi bezel"]);
});

test("userTextsOf is total: junk in, empty list out", () => {
  for (const junk of [null, undefined, 42, "string", {}, [null, 7, { role: "user" }]]) {
    const out = userTextsOf(junk);
    assert.ok(Array.isArray(out), String(junk));
  }
  assert.deepEqual(userTextsOf([{ role: "assistant", content: "no users here" }]), []);
});

test("watchOpenedIn is the pre-gate: it agrees with the thread it stands in for", () => {
  // The point of this helper is to answer "is it worth loading the parts
  // catalogue" using only demo-core.js, which the caller has already loaded. So
  // the one property that matters is that it never says no when the thread WOULD
  // have been active — a false negative is a feature that silently stops
  // working, and no test of watchThread alone would catch it.
  const conversations = [
    ["Seiko watch demo"],
    ["Seiko watch demo", "pepsi bezel"],
    ["visa mig klockbyggaren", "svart urtavla"],
    ["show me the watch builder", "what is the capital of France?"],
    ["what is the capital of France?"],
    ["show me a rocket launch from space"],
    ["compare Claude and GPT pricing", "jubilee bracelet"],
    ["nh36 demo", "surprise me", "lights out"],
    // Feedback #55's conversation, verbatim: the pre-gate has to see the
    // opening ask, and has to keep seeing it through the clarifying answer.
    ["Build me a fancy seiko watch"],
    ["Build me a fancy seiko watch", "Features"],
    ["Build me a fancy seiko watch", "Features", "make the dial sunburst blue"],
    ["Bygg mig en fin seiko-klocka", "gör urtavlan svart"],
    [],
  ];
  for (const texts of conversations) {
    const active = watchThread(texts).active;
    if (active) {
      assert.equal(watchOpenedIn(texts), true, `pre-gate blocked a live thread: ${JSON.stringify(texts)}`);
    }
  }
  // And it stays cheap-and-quiet on conversations that never mention the tool,
  // which is what keeps the catalogue out of the module graph.
  assert.equal(watchOpenedIn(["what is the capital of France?"]), false);
  assert.equal(watchOpenedIn(["compare Claude and GPT pricing", "jubilee bracelet"]), false);
  assert.equal(watchOpenedIn([]), false);
});

test("demoSurfacePossible never blocks a turn that would have mounted something", () => {
  // The callers skip placing a host element at all when this says no, so a false
  // negative is a silently missing surface. Its contract is one-directional: no
  // means there is nothing to try; yes only means it is worth trying.
  const turns = [
    { questionText: "Seiko watch demo", userTexts: ["Seiko watch demo"] },
    { questionText: "pepsi bezel", priorText: "Seiko watch demo", userTexts: ["Seiko watch demo", "pepsi bezel"] },
    { questionText: "show me a rocket launch from space", userTexts: ["show me a rocket launch from space"] },
    { questionText: "show me visually", priorText: "Space launch demo", userTexts: ["Space launch demo", "show me visually"] },
    { questionText: "svart urtavla", priorText: "visa mig klockbyggaren", userTexts: ["visa mig klockbyggaren", "svart urtavla"] },
    // Feedback #55: the turn the report was written about — a one-word answer
    // to a clarifying question, which used to place no host element at all.
    { questionText: "Features", priorText: "Build me a fancy seiko watch", userTexts: ["Build me a fancy seiko watch", "Features"] },
    { questionText: "what is the capital of France?", userTexts: ["Seiko watch demo", "what is the capital of France?"] },
    { questionText: "compare Claude and GPT pricing", userTexts: ["compare Claude and GPT pricing"] },
  ];
  for (const turn of turns) {
    const wouldMount = !!demoIntent(turn.questionText, turn.priorText || "")
      || watchThread(turn.userTexts).active;
    if (wouldMount) {
      assert.equal(demoSurfacePossible(turn), true, `blocked: ${turn.questionText}`);
    }
  }
  // And it says no to the ordinary research turns, which is the point.
  assert.equal(demoSurfacePossible({ questionText: "compare Claude and GPT pricing", userTexts: ["compare Claude and GPT pricing"] }), false);
  assert.equal(demoSurfacePossible({}), false);
  for (const junk of [null, undefined, 42, { questionText: 42, userTexts: "nope" }]) {
    assert.equal(demoSurfacePossible(/** @type {any} */ (junk)), false, String(junk));
  }
});

test("watchOpenedIn honours the bare-visual-ask inheritance", () => {
  // "Seiko watch demo" → "show me visually" is feedback #50's sequence; the
  // pre-gate has to see the second message as an opening too, or a reload of
  // that conversation loses its watch.
  assert.equal(watchOpenedIn(["Seiko watch demo", "show me visually"]), true);
  assert.equal(watchOpenedIn(["hur ser den ut?"]), false);
});
