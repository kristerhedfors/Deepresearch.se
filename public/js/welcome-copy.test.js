// The landing page's first-visit message ("First time here?", #wintro in
// public/welcome/index.html) is END-USER copy with a spec (2026-07-12
// directive): instruct precisely, briefly and correctly, explain the two
// tiers and what each provides, link the build story — and read like a
// person wrote it. "Doesn't smell like AI" is enforced DETERMINISTICALLY
// here: a ban list of the stock phrases and tics that mark generated
// marketing copy, plus hard budgets on length and punctuation. Any future
// rewrite of the pane must keep passing this file — that IS the review.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../welcome/index.html", import.meta.url), "utf8");

// The pane, by its markers (the button closes the copy).
const start = html.indexOf('<div id="wintro"');
const end = html.indexOf('id="wintrook"');
assert.ok(start > 0 && end > start, "the #wintro pane exists");
const pane = html.slice(start, end);
// Visible text only: tags stripped, entities decoded, whitespace folded.
const text = pane
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

test("the first-visit message states the required facts", () => {
  // Both tiers, by their full-URL names (branding rule).
  assert.match(text, /deepresearch\.\s*se\/cure/);
  assert.match(text, /deepresearch\.\s*se\/rver/);
  // What each side provides, correctly: DRC = in-browser on the user's own
  // model (the three provider choices), nothing sent to this server;
  // DRS = hosted search, invite-only sign-in.
  assert.match(text, /browser/i);
  assert.match(text, /OpenAI or Berget/);
  assert.match(text, /local server|local endpoint/i);
  assert.match(text, /never receives|never sees/i);
  assert.match(text, /invite-only/i);
  // The precise instructions: which button does what.
  assert.match(text, /ghost/i);
  assert.match(text, /account button/i);
  // The tier headings wear the app headers' brand treatment (2026-07-12
  // follow-up): the wordplay tails are the ONLY bold in the pane — the
  // site names carry the emphasis, the bullets stay plain.
  const bolds = pane.match(/<b[^>]*>[\s\S]*?<\/b>/g) || [];
  assert.deepEqual(
    bolds.map((b) => b.replace(/<[^>]+>/g, "")),
    ["se/cure", "se/rver"],
    "bold is reserved for the two tier tails",
  );
  assert.match(pane, /<h3 class="wtier">deepresearch\.<b>se\/cure<\/b><\/h3>/);
  assert.match(pane, /<h3 class="wtier">deepresearch\.<b>se\/rver<\/b><\/h3>/);
  // The links the pane must carry.
  for (const href of ["/story/", "/build/", "/help/", "github.com/kristerhedfors/Deepresearch.se"]) {
    assert.ok(pane.includes(`href="${href}`) || pane.includes(`href="https://${href}`), "links " + href);
  }
});

test("the first-visit message is brief", () => {
  // "Briefly explained" is a budget, not a mood: the whole pane reads in
  // well under a minute.
  assert.ok(text.length < 1250, `pane text is ${text.length} chars`);
  // And each bullet stands on its own — no run-on list items.
  for (const li of pane.split("<li>").slice(1)) {
    const t = li.split("</li>")[0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    assert.ok(t.length < 190, `bullet too long: "${t.slice(0, 60)}…"`);
  }
});

test("the first-visit message does not smell like AI", () => {
  // The deterministic ban list: stock phrases of generated marketing copy.
  // Extend it when a new tell slips in; never delete to make copy pass.
  const BANNED = [
    "delve", "seamless", "unlock", "unleash", "empower", "elevate",
    "supercharge", "game-chang", "revolutioniz", "effortless",
    "cutting-edge", "state-of-the-art", "harness", "robust",
    "in today's", "whether you're", "look no further", "dive in",
    "embark", "journey", "treasure trove", "landscape", "realm",
    "testament to", "vibrant", "comprehensive", "streamline",
    "isn't just", "is not just", "not just a", "more than just",
    "welcome to the future", "magic", "superpower", "best-in-class",
    "world-class", "next-level", "say goodbye", "say hello",
    "the power of", "at your fingertips", "peace of mind",
  ];
  const lower = text.toLowerCase();
  for (const phrase of BANNED) {
    assert.equal(lower.includes(phrase), false, `banned phrase present: "${phrase}"`);
  }
  // Punctuation tells: no exclamation marks, no emoji, an em-dash budget.
  assert.equal(text.includes("!"), false, "no exclamation marks");
  assert.equal(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}✨⭐]/u.test(text), false, "no emoji");
  const dashes = (text.match(/—/g) || []).length;
  assert.ok(dashes <= 3, `${dashes} em-dashes (budget 3)`);
  // No first-person plural puffery ("we believe", "our mission").
  assert.equal(/\b(we believe|our mission|our vision|we're passionate)\b/i.test(text), false);
});
