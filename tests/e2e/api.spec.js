// Server-side validation of attachment-bearing requests, exercised over
// break-glass Basic Auth directly against the live API. All of these are
// rejected before any model/search spend.

import { expect, test } from "@playwright/test";

test("break-glass identity is the unthrottled admin", async ({ request }) => {
  const res = await request.get("/api/me");
  expect(res.ok()).toBeTruthy();
  const me = await res.json();
  expect(me.enforced).toBeFalsy(); // admins are never blocked
});

test("model catalog offers at least one up, vision-capable model", async ({ request }) => {
  const res = await request.get("/api/models");
  expect(res.ok()).toBeTruthy();
  const { models } = await res.json();
  expect(models.length).toBeGreaterThan(0);
  expect(models.some((m) => m.up !== false)).toBeTruthy();
  expect(
    models.some((m) => m.up !== false && m.vision),
    "image tests need an up vision model",
  ).toBeTruthy();
});

test("images on a non-vision model are rejected with alternatives", async ({ request }) => {
  const { models } = await (await request.get("/api/models")).json();
  const nonVision = models.find((m) => m.up !== false && !m.vision);
  test.skip(!nonVision, "no non-vision model in the catalog");
  const res = await request.post("/api/chat", {
    data: {
      model: nonVision.id,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAAA" } },
          ],
        },
      ],
    },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("does not support image input");
});

test("unknown model is rejected", async ({ request }) => {
  const res = await request.post("/api/chat", {
    data: { model: "no-such/model", messages: [{ role: "user", content: "hi" }] },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("Unknown model");
});

test("oversized image data URL is rejected", async ({ request }) => {
  const res = await request.post("/api/chat", {
    data: {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + "A".repeat(310_000) } }],
        },
      ],
    },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("too large");
});

test("non-data image URLs are rejected", async ({ request }) => {
  const res = await request.post("/api/chat", {
    data: {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.jpg" } }] },
      ],
    },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("data:image/");
});

test("too many images in one message are rejected", async ({ request }) => {
  const img = { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAAA" } };
  const res = await request.post("/api/chat", {
    data: { messages: [{ role: "user", content: [img, img, img, img, img] }] },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("Too many images");
});

test("a message over the 32K cap (e.g. un-truncated docs) is rejected", async ({ request }) => {
  const res = await request.post("/api/chat", {
    data: { messages: [{ role: "user", content: "x".repeat(33_000) }] },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("32000-character limit");
});

test("unsupported content part is rejected", async ({ request }) => {
  const res = await request.post("/api/chat", {
    data: { messages: [{ role: "user", content: [{ type: "audio", data: "x" }] }] },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("Unsupported message content part");
});
