import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateMessages, resolveModel, validateImageLocations, validateMapView, validateStreetViewPov } from "./validation.js";
import { DEFAULT_MODEL } from "./berget.js";

const noopLog = { warn: () => {} };

describe("validateMessages", () => {
  test("rejects a non-array or empty messages value", () => {
    assert.match(validateMessages(null), /non-empty/);
    assert.match(validateMessages([]), /non-empty/);
  });

  test("rejects more than 60 messages", () => {
    const messages = Array.from({ length: 61 }, () => ({ role: "user", content: "hi" }));
    assert.match(validateMessages(messages), /too long/);
  });

  test("accepts exactly 60 messages", () => {
    const messages = Array.from({ length: 60 }, () => ({ role: "user", content: "hi" }));
    assert.equal(validateMessages(messages), null);
  });

  test("rejects an unknown role", () => {
    const messages = [{ role: "system", content: "hi" }];
    assert.match(validateMessages(messages), /role `user` or `assistant`/);
  });

  test("rejects a string message over the character limit", () => {
    const messages = [{ role: "user", content: "x".repeat(32_001) }];
    assert.match(validateMessages(messages), /character limit/);
  });

  test("accepts a string message at exactly the character limit", () => {
    const messages = [{ role: "user", content: "x".repeat(32_000) }];
    assert.equal(validateMessages(messages), null);
  });

  test("rejects content that is neither a string nor a non-empty array", () => {
    assert.match(validateMessages([{ role: "user", content: 42 }]), /string or a non-empty array/);
    assert.match(validateMessages([{ role: "user", content: [] }]), /string or a non-empty array/);
  });

  test("rejects an unsupported content part type", () => {
    const messages = [{ role: "user", content: [{ type: "video", url: "x" }] }];
    assert.match(validateMessages(messages), /Unsupported message content part/);
  });

  test("sums text parts against the per-message character limit", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(20_000) },
          { type: "text", text: "y".repeat(20_000) },
        ],
      },
    ];
    assert.match(validateMessages(messages), /character limit/);
  });

  test("rejects an image_url part whose url is not a data:image/ URL", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] }];
    assert.match(validateMessages(messages), /data:image/);
  });

  test("rejects a single image over the per-image size cap", () => {
    const url = "data:image/png;base64," + "a".repeat(300_000);
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    assert.match(validateMessages(messages), /too large after encoding/);
  });

  test("rejects more than 4 images in one message", () => {
    const part = { type: "image_url", image_url: { url: "data:image/png;base64,x" } };
    const messages = [{ role: "user", content: [part, part, part, part, part] }];
    assert.match(validateMessages(messages), /Too many images in one message/);
  });

  test("rejects more than 8 images across the whole conversation", () => {
    const part = { type: "image_url", image_url: { url: "data:image/png;base64,x" } };
    const messages = Array.from({ length: 9 }, () => ({ role: "user", content: [part] }));
    assert.match(validateMessages(messages), /Too many images in the conversation/);
  });

  test("rejects total image bytes over the per-request cap even under the per-message/per-request count caps", () => {
    const url = "data:image/png;base64," + "a".repeat(200_000);
    const part = { type: "image_url", image_url: { url } };
    // 4 images x 200,000 chars = 800,000 > 750,000 total cap, but only 1 message and 4 images (both under their own caps).
    const messages = [{ role: "user", content: [part, part, part, part] }];
    assert.match(validateMessages(messages), /provider's request size limit/);
  });

  test("accepts a well-formed mixed text+image conversation", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ];
    assert.equal(validateMessages(messages), null);
  });
});

describe("resolveModel", () => {
  const catalog = [
    { id: "vision-model", name: "Vision Model", up: true, vision: true },
    { id: "text-model", name: "Text Model", up: true, vision: false },
    { id: "down-model", name: "Down Model", up: false, vision: true },
  ];

  test("no model in body and no catalog falls back to the env default", () => {
    const result = resolveModel({ messages: [] }, null, {}, noopLog);
    assert.equal(result.model, DEFAULT_MODEL);
  });

  test("unknown model id against a real catalog is rejected", () => {
    const result = resolveModel({ model: "nonexistent", messages: [] }, catalog, {}, noopLog);
    assert.equal(result.status, 400);
    assert.match(result.error, /Unknown model/);
  });

  test("a model marked down in the catalog is rejected", () => {
    const result = resolveModel({ model: "down-model", messages: [] }, catalog, {}, noopLog);
    assert.equal(result.status, 400);
    assert.match(result.error, /temporarily unavailable/);
  });

  test("a valid, up model in the catalog is accepted", () => {
    const result = resolveModel({ model: "text-model", messages: [] }, catalog, {}, noopLog);
    assert.equal(result.model, "text-model");
  });

  test("a requested model is ignored (not validated) when the catalog is unreachable", () => {
    const result = resolveModel({ model: "text-model", messages: [] }, null, {}, noopLog);
    assert.equal(result.model, DEFAULT_MODEL);
  });

  test("images present + resolved model lacks vision is rejected, listing vision-capable alternatives", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const result = resolveModel({ model: "text-model", messages }, catalog, {}, noopLog);
    assert.equal(result.status, 400);
    assert.match(result.error, /does not support image input/);
    assert.match(result.error, /Vision Model/);
  });

  test("images present + resolved model has vision is accepted", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const result = resolveModel({ model: "vision-model", messages }, catalog, {}, noopLog);
    assert.equal(result.model, "vision-model");
  });

  test("a model with a profiled per-request image cap rejects an over-limit latest message clearly", () => {
    // 2026-07-08 live probe: Mistral Medium 400s ("invalid_request", opaque)
    // on >2 images — model-profiles.js carries maxImages: 2. Without this
    // check the answer call dies on that opaque Berget 400 mid-stream.
    const capped = [...catalog, { id: "mistralai/Mistral-Medium-3.5-128B", name: "Mistral Medium", up: true, vision: true }];
    const img = { type: "image_url", image_url: { url: "x" } };
    const over = [{ role: "user", content: [{ type: "text", text: "q" }, img, img, img] }];
    const result = resolveModel({ model: "mistralai/Mistral-Medium-3.5-128B", messages: over }, capped, {}, noopLog);
    assert.equal(result.status, 400);
    assert.match(result.error, /at most 2 images per message/);
    assert.match(result.error, /Remove 1 image /);

    // At the cap: accepted.
    const atCap = [{ role: "user", content: [{ type: "text", text: "q" }, img, img] }];
    const ok = resolveModel({ model: "mistralai/Mistral-Medium-3.5-128B", messages: atCap }, capped, {}, noopLog);
    assert.equal(ok.model, "mistralai/Mistral-Medium-3.5-128B");
  });

  test("the image cap counts only the LATEST user message (history images are stripped for the answer call)", () => {
    const capped = [...catalog, { id: "mistralai/Mistral-Medium-3.5-128B", name: "Mistral Medium", up: true, vision: true }];
    const img = { type: "image_url", image_url: { url: "x" } };
    const messages = [
      { role: "user", content: [{ type: "text", text: "a" }, img, img] },
      { role: "assistant", content: "…" },
      { role: "user", content: [{ type: "text", text: "b" }, img, img] },
    ];
    const ok = resolveModel({ model: "mistralai/Mistral-Medium-3.5-128B", messages }, capped, {}, noopLog);
    assert.equal(ok.model, "mistralai/Mistral-Medium-3.5-128B");
  });

  test("images present but the resolved model isn't found in the catalog: not rejected on vision grounds", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const result = resolveModel({ messages }, catalog, {}, noopLog);
    assert.equal(result.model, DEFAULT_MODEL);
  });
});

describe("validateImageLocations", () => {
  test("non-array input returns an empty list rather than throwing", () => {
    assert.deepEqual(validateImageLocations(undefined), []);
    assert.deepEqual(validateImageLocations(null), []);
    assert.deepEqual(validateImageLocations("not an array"), []);
    assert.deepEqual(validateImageLocations({}), []);
  });

  test("passes through valid entries with name/lat/lon", () => {
    const out = validateImageLocations([{ name: "photo.jpg", lat: 40.7128, lon: -74.006 }]);
    assert.deepEqual(out, [{ name: "photo.jpg", lat: 40.7128, lon: -74.006 }]);
  });

  test("drops entries with out-of-range or non-finite lat/lon", () => {
    const out = validateImageLocations([
      { name: "a", lat: 91, lon: 0 },
      { name: "b", lat: 0, lon: 181 },
      { name: "c", lat: NaN, lon: 0 },
      { name: "d", lat: "not a number", lon: 0 },
      { name: "e", lat: 10, lon: 20 }, // the only valid one
    ]);
    assert.deepEqual(out, [{ name: "e", lat: 10, lon: 20 }]);
  });

  test("boundary values (±90 lat, ±180 lon) are accepted, not off-by-one rejected", () => {
    const out = validateImageLocations([
      { name: "a", lat: 90, lon: 180 },
      { name: "b", lat: -90, lon: -180 },
    ]);
    assert.equal(out.length, 2);
  });

  test("caps the list at 4 entries", () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, lat: i, lon: i }));
    const out = validateImageLocations(raw);
    assert.equal(out.length, 4);
    assert.equal(out[0].name, "p0");
  });

  test("a missing/non-string name defaults to 'photo'; an oversized name is truncated", () => {
    const out = validateImageLocations([
      { lat: 1, lon: 1 },
      { name: 42, lat: 2, lon: 2 },
      { name: "x".repeat(500), lat: 3, lon: 3 },
    ]);
    assert.equal(out[0].name, "photo");
    assert.equal(out[1].name, "photo");
    assert.equal(out[2].name.length, 200);
  });

  test("coerces numeric strings but rejects non-numeric ones", () => {
    const out = validateImageLocations([{ name: "a", lat: "12.5", lon: "-45.5" }]);
    assert.deepEqual(out, [{ name: "a", lat: 12.5, lon: -45.5 }]);
  });
});

describe("validateStreetViewPov", () => {
  test("returns null for junk shapes and out-of-range coordinates", () => {
    assert.equal(validateStreetViewPov(undefined), null);
    assert.equal(validateStreetViewPov(null), null);
    assert.equal(validateStreetViewPov("x"), null);
    assert.equal(validateStreetViewPov({}), null);
    assert.equal(validateStreetViewPov({ lat: 91, lng: 0 }), null);
    assert.equal(validateStreetViewPov({ lat: 0, lng: 181 }), null);
    assert.equal(validateStreetViewPov({ lat: "no", lng: 10 }), null);
  });

  test("keeps a well-formed POV, rounding the view angles", () => {
    const out = validateStreetViewPov({ panoId: "abc-DEF_123", lat: 59.4, lng: 17.9, heading: 143.6, pitch: -5.4, fov: 90 });
    assert.deepEqual(out, { panoId: "abc-DEF_123", lat: 59.4, lng: 17.9, heading: 144, pitch: -5, fov: 90 });
  });

  test("wraps heading into [0,360) and clamps pitch/fov", () => {
    const out = validateStreetViewPov({ lat: 1, lng: 2, heading: -90, pitch: 400, fov: 5 });
    assert.deepEqual(out, { panoId: "", lat: 1, lng: 2, heading: 270, pitch: 90, fov: 10 });
    const out2 = validateStreetViewPov({ lat: 1, lng: 2, heading: 725, pitch: -400, fov: 500 });
    assert.deepEqual(out2, { panoId: "", lat: 1, lng: 2, heading: 5, pitch: -90, fov: 120 });
  });

  test("drops a pano id that doesn't look like one; defaults missing angles", () => {
    const out = validateStreetViewPov({ panoId: "<script>", lat: 1, lng: 2 });
    assert.deepEqual(out, { panoId: "", lat: 1, lng: 2, heading: 0, pitch: 0, fov: 90 });
    assert.equal(validateStreetViewPov({ panoId: "x".repeat(65), lat: 1, lng: 2 }).panoId, "");
  });
});

describe("validateMapView", () => {
  test("returns null for junk shapes and out-of-range coordinates", () => {
    assert.equal(validateMapView(undefined), null);
    assert.equal(validateMapView(null), null);
    assert.equal(validateMapView("x"), null);
    assert.equal(validateMapView({}), null);
    assert.equal(validateMapView({ lat: 91, lng: 0 }), null);
    assert.equal(validateMapView({ lat: 0, lng: 181 }), null);
    assert.equal(validateMapView({ lat: "no", lng: 10 }), null);
  });

  test("keeps a well-formed view, rounding and clamping zoom to Static Maps' [0,21]", () => {
    assert.deepEqual(validateMapView({ lat: 59.65, lng: 17.12, zoom: 16.6 }), { lat: 59.65, lng: 17.12, zoom: 17 });
    assert.deepEqual(validateMapView({ lat: 1, lng: 2, zoom: 99 }), { lat: 1, lng: 2, zoom: 21 });
    assert.deepEqual(validateMapView({ lat: 1, lng: 2, zoom: -3 }), { lat: 1, lng: 2, zoom: 0 });
  });

  test("defaults a missing zoom", () => {
    assert.deepEqual(validateMapView({ lat: 1, lng: 2 }), { lat: 1, lng: 2, zoom: 17 });
  });
});
