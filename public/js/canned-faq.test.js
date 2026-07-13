// Tests for the prepackaged non-LLM helper (canned-faq.js): topic matching in
// English AND Swedish (invariant 6 parity), tier-tailored answers, the
// always-present non-AI label, and the never-null fallback. Pure module — runs
// in Node unmodified.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CANNED_LABEL, CANNED_TOPICS, detectLang, matchCanned } from "./canned-faq.js";

test("detectLang: Swedish diacritics and function words → sv, else en", () => {
  assert.equal(detectLang("Vad är det här?"), "sv");
  assert.equal(detectLang("hur fungerar det"), "sv");
  assert.equal(detectLang("är det gratis"), "sv");
  assert.equal(detectLang("What is this?"), "en");
  assert.equal(detectLang("how does it work"), "en");
  assert.equal(detectLang(""), "en");
  assert.equal(detectLang(undefined), "en");
});

test("every reply carries the localized non-AI label", () => {
  const en = matchCanned("what is this?", { tier: "drc" });
  assert.equal(en.label, CANNED_LABEL.en);
  assert.match(en.label.toLowerCase(), /not the language model/);
  const sv = matchCanned("vad är det här?", { tier: "drc" });
  assert.equal(sv.label, CANNED_LABEL.sv);
  assert.match(sv.label.toLowerCase(), /inte språkmodellen/);
});

// The EN + SV phrasings each topic must catch (invariant-6 parity): every id
// gets at least one English and one Swedish probe, asserted to hit that id.
const PROBES = {
  greeting: [["Hi there", "en"], ["Hej!", "sv"], ["tjena", "sv"]],
  whatis: [["What is this site?", "en"], ["Vad är det här?", "sv"], ["berätta om deepresearch", "sv"]],
  howworks: [["How does it work?", "en"], ["hur fungerar det", "sv"], ["what is deep research", "en"]],
  privacy: [["Is this private?", "en"], ["do you store my data", "en"], ["sparar ni mina meddelanden", "sv"], ["är det anonymt", "sv"]],
  builtwith: [["How are you built?", "en"], ["what's the tech stack", "en"], ["hur är sajten byggd", "sv"], ["visa din källkod", "sv"]],
  opensource: [["Is it open source?", "en"], ["link to github", "en"], ["öppen källkod?", "sv"]],
  cost: [["How much does it cost?", "en"], ["is it free", "en"], ["vad kostar det", "sv"], ["är det gratis", "sv"]],
  access: [["How do I sign in?", "en"], ["can i get access", "en"], ["hur loggar jag in", "sv"], ["behöver jag ett konto", "sv"]],
  apikey: [["Where do I put my API key?", "en"], ["which provider do you use", "en"], ["hur lägger jag in api-nyckel", "sv"]],
  tiers: [["difference between se/cure and se/rver", "en"], ["skillnad mellan se/cure och se/rver", "sv"]],
  websearch: [["Can you search the web?", "en"], ["söker du på nätet", "sv"]],
  who: [["Who made this?", "en"], ["who are you", "en"], ["vem ligger bakom det här", "sv"]],
  language: [["Do you speak Swedish?", "en"], ["vilka språk stödjer du", "sv"], ["pratar du svenska", "sv"]],
  help: [["help", "en"], ["what can you answer", "en"], ["hjälp", "sv"], ["vad kan du svara på", "sv"]],
};

test("all knowledge-base topics have EN+SV probes", () => {
  for (const id of CANNED_TOPICS) {
    assert.ok(PROBES[id], `missing probes for topic "${id}"`);
  }
});

for (const [id, cases] of Object.entries(PROBES)) {
  test(`topic "${id}" matches its EN + SV phrasings`, () => {
    for (const [text, lang] of cases) {
      const r = matchCanned(text, { tier: "drc" });
      assert.equal(r.matched, true, `"${text}" should match a topic`);
      assert.equal(r.id, id, `"${text}" matched "${r.id}", expected "${id}"`);
      assert.equal(r.lang, lang, `"${text}" detected ${r.lang}, expected ${lang}`);
      assert.ok(r.answer.length > 0);
    }
  });
}

test("tier tailoring: privacy/apikey answers differ between drc and drs", () => {
  const drcPriv = matchCanned("is it private", { tier: "drc" }).answer;
  const drsPriv = matchCanned("is it private", { tier: "drs" }).answer;
  assert.notEqual(drcPriv, drsPriv);
  assert.match(drcPriv, /nothing to log/i);
  assert.match(drsPriv, /answer-recovery/i);

  const drcKey = matchCanned("api key", { tier: "drc" }).answer;
  const drsKey = matchCanned("api key", { tier: "drs" }).answer;
  assert.notEqual(drcKey, drsKey);
});

test("start CTA is tier-specific: DRC points to a key, DRS points to sign-in", () => {
  const drc = matchCanned("how do i start", { tier: "drc" }).answer;
  const drs = matchCanned("how do i start", { tier: "drs" }).answer;
  // "how do i start" hits the access topic; both include the fallthrough CTA
  // in their tier flavor somewhere. Use the fallback to check START directly:
  const drcFb = matchCanned("zxqw nonsense", { tier: "drc" }).answer;
  const drsFb = matchCanned("zxqw nonsense", { tier: "drs" }).answer;
  assert.match(drcFb, /API key/i);
  assert.match(drcFb, /Se\/cure runs entirely in your browser/i);
  assert.match(drsFb, /sign in/i);
  assert.ok(drc && drs);
});

test("fallback: unmatched text still returns a labeled, non-empty reply", () => {
  const r = matchCanned("qwertyuiop asdfghjkl", { tier: "drc" });
  assert.equal(r.matched, false);
  assert.equal(r.id, "fallback");
  assert.ok(r.answer.length > 0);
  assert.equal(r.label, CANNED_LABEL.en);
  assert.match(r.answer, /prewritten helper/i);

  const sv = matchCanned("qwertyuiop åäö", { tier: "drc" });
  assert.equal(sv.matched, false);
  assert.equal(sv.lang, "sv");
  assert.match(sv.answer, /färdigskriven hjälpare/i);
});

test("default tier is drs when unspecified", () => {
  const r = matchCanned("is it private");
  assert.match(r.answer, /answer-recovery/i);
});

test("answers use the secure-first, full-URL wordmark form (no scheme)", () => {
  const a = matchCanned("difference between se/cure and se/rver", { tier: "drs" }).answer;
  // Se/cure named before Se/rver when paired.
  assert.ok(a.indexOf("Se/cure") < a.indexOf("Se/rver"));
  assert.doesNotMatch(a, /https?:\/\/deepresearch/i);
});
