// Unit suite for the SDK-mode showcase gallery catalog (public/js/sdk-showcase.js).
// Guards the DATA integrity a single-shot library depends on (unique stable
// ids, non-empty briefs, a ref model that matches the Anthropic catalog) and
// checks the one DOM export is a harmless no-op without a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SDK_SHOWCASE,
  SHOWCASE_REF,
  findShowcase,
  renderShowcaseGallery,
  showcaseItems,
} from "./sdk-showcase.js";

test("catalog has groups, each with items", () => {
  assert.ok(SDK_SHOWCASE.length >= 3, "expected a few groups");
  for (const g of SDK_SHOWCASE) {
    assert.ok(typeof g.group === "string" && g.group.trim(), "group has a name");
    assert.ok(Array.isArray(g.items) && g.items.length, `${g.group} has items`);
  }
});

test("every item has a stable id, title, blurb and a real build prompt", () => {
  for (const it of showcaseItems()) {
    assert.match(it.id, /^[a-z0-9-]+$/, `id is a slug: ${it.id}`);
    assert.ok(it.title.trim(), `title set for ${it.id}`);
    assert.ok(it.blurb.trim(), `blurb set for ${it.id}`);
    // A single-shot brief must actually say "build" something substantial.
    assert.ok(it.prompt.length > 60, `prompt is a real brief for ${it.id}`);
    assert.match(it.prompt, /build/i, `prompt describes a build for ${it.id}`);
    // The client-side reminder keeps the flavour a proper Se/cure build.
    assert.match(it.prompt, /own API key/i, `prompt keeps it client-side for ${it.id}`);
  }
});

test("ids are unique across the whole catalog", () => {
  const ids = showcaseItems().map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
});

test("findShowcase resolves by id and tags the group", () => {
  const first = showcaseItems()[0];
  const found = findShowcase(first.id);
  assert.equal(found?.id, first.id);
  assert.ok(found?.group, "resolved item carries its group");
  assert.equal(findShowcase("nope-not-real"), undefined);
});

test("reference model matches the Anthropic Sonnet catalog id", () => {
  assert.equal(SHOWCASE_REF.model, "claude-sonnet-5");
  assert.ok(SHOWCASE_REF.label.trim());
});

test("renderShowcaseGallery is a safe no-op without a DOM", () => {
  assert.equal(renderShowcaseGallery(null, () => {}), 0);
  assert.equal(renderShowcaseGallery(undefined, () => {}), 0);
  assert.equal(renderShowcaseGallery({}, () => {}), 0);
});
