// Maps integration — the location-enrichment surface the live site exposes:
// photo GPS EXIF and coordinates named in the message text get reverse-
// geocoded server-side, a labeled context block reaches the model, the
// pipeline emits `map` SSE events, and the client renders them as inline
// map / Street View figures loaded through the Worker's authenticated
// /api/maps/* image proxies (the maps API key never reaches the browser).
//
// User stories covered here (mocked project — free, deterministic; the
// figure-rendering stories exercise the LIVE deployed client JS against a
// mocked /api/chat, same pattern as every other mocked spec):
//   1. "As a user I see the map(s) of resolved locations inline in the
//      answer turn, each captioned, without duplicates."
//   2. "As a user I never see a broken-image icon — a tile that fails to
//      load simply doesn't appear."
//   3. "As a user my map tiles are private — the image endpoints require
//      my session; nothing is served signed-out."
//   4. "As an operator the map proxies serve real images only for
//      well-formed coordinates and 404 unknown subpaths."
// The live-pipeline stories (photo GPS → geocode step → map figure; text
// coordinates → maps step; resolved place feeding the research queries)
// are in live.spec.js, tagged @live.
//
// See tests/MAPS-COVERAGE.md for the full story ↔ test matrix and the
// open findings from the 2026-07-07 end-to-end review.

import { expect, test } from "@playwright/test";
import { mockChat, openApp, send, waitForDone } from "./helpers.js";

const BASE = process.env.BASE_URL || "https://deepresearch.se";

// Minimal real images for mocking the /api/maps/* proxies.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// An /api/chat SSE body carrying the maps enrichment contract: a geocode
// step plus `map` events with map + streetview figures. The duplicate
// second `map` event mirrors production behavior (the photo-GPS and
// text-coordinate enrichments can both resolve the same location) — the
// client must dedupe by URL.
function mapsSseBody() {
  const images = [
    {
      kind: "map",
      url: "/api/maps/static?lat=40.7128&lon=-74.006&zoom=14",
      label: "Lower Manhattan",
      caption: "Map — Lower Manhattan",
      lat: 40.7128,
      lon: -74.006,
    },
    {
      kind: "streetview",
      url: "/api/maps/streetview?lat=40.7128&lon=-74.006",
      label: "Lower Manhattan",
      caption: "Street View — Lower Manhattan",
      lat: 40.7128,
      lon: -74.006,
    },
  ];
  const events = [
    { status: { type: "step_start", id: "geocode", label: "Resolving photo location…" } },
    { status: { type: "step_done", id: "geocode", label: "Resolved 1 photo location", details: ["photo.jpg: near Lower Manhattan"] } },
    { status: { type: "map", id: "geocode", images } },
    { status: { type: "map", id: "maps", images } }, // duplicate — must dedupe
    { choices: [{ delta: { content: "The photo was taken in Lower Manhattan." } }] },
    { status: { type: "done", model: "mock-model", rounds: 1, searches: 0, duration_ms: 42, prompt_tokens: 10, completion_tokens: 20 } },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function mockChatWithMaps(page) {
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: mapsSseBody() }),
  );
}

test("map SSE events render captioned figures in the turn, deduped by URL", async ({ page }) => {
  await openApp(page);
  await page.route("**/api/maps/**", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "image/png" }, body: PNG_1PX }),
  );
  await mockChatWithMaps(page);
  await send(page, "Where was this taken?");
  const turn = await waitForDone(page);

  // Two figures (map + streetview) — the duplicate `map` event added none.
  const figures = turn.locator(".map-figure");
  await expect(figures).toHaveCount(2);
  await expect(figures.nth(0).locator("figcaption")).toHaveText("Map — Lower Manhattan");
  await expect(figures.nth(1).locator("figcaption")).toHaveText("Street View — Lower Manhattan");
  // Each image src is the Worker proxy path — never a maps-provider URL
  // (the API key stays server-side).
  const srcs = await figures.locator("img").evaluateAll((els) => els.map((e) => e.getAttribute("src")));
  for (const src of srcs) expect(src).toMatch(/^\/api\/maps\//);
});

test("a figure whose tile fails to load is removed, never shown broken", async ({ page }) => {
  await openApp(page);
  await page.route("**/api/maps/static**", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "image/png" }, body: PNG_1PX }),
  );
  // No Street View imagery for this location after all: the tile 404s.
  await page.route("**/api/maps/streetview**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await mockChatWithMaps(page);
  await send(page, "Where was this taken?");
  const turn = await waitForDone(page);

  await expect(turn.locator(".map-figure")).toHaveCount(1);
  await expect(turn.locator(".map-figure figcaption")).toHaveText("Map — Lower Manhattan");
});

test("ordinary answers without map events show no figure strip", async ({ page }) => {
  await openApp(page);
  await mockChat(page, "Plain answer, no maps.");
  await send(page, "Just a question.");
  const turn = await waitForDone(page);
  await expect(turn.locator(".map-figure")).toHaveCount(0);
});

test("map image proxies serve real images to a signed-in session", async ({ request }) => {
  const staticRes = await request.get("/api/maps/static?lat=40.7128&lon=-74.006&zoom=14");
  expect(staticRes.status()).toBe(200);
  expect(staticRes.headers()["content-type"]).toContain("image/png");
  expect((await staticRes.body()).subarray(1, 4).toString("latin1")).toBe("PNG");

  const svRes = await request.get("/api/maps/streetview?lat=40.7128&lon=-74.006");
  expect(svRes.status()).toBe(200);
  expect(svRes.headers()["content-type"]).toContain("image/jpeg");
});

test("map image proxies are auth-gated and 404 unknown subpaths", async ({ playwright, request }) => {
  // A request context WITHOUT the break-glass credentials. NOTE:
  // playwright.request.newContext() inherits the config's `use` options —
  // including extraHTTPHeaders, i.e. the Authorization header — so it must
  // be explicitly blanked here or this "anonymous" context is signed in.
  const anon = await playwright.request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: {},
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY }, ignoreHTTPSErrors: true } : {}),
  });
  try {
    const res = await anon.get("/api/maps/static?lat=48.8584&lon=2.2945&zoom=14", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    // …and the 401 body is the JSON error, never a tile.
    expect(res.headers()["content-type"] || "").not.toContain("image/");
  } finally {
    await anon.dispose();
  }

  const unknown = await request.get("/api/maps/does-not-exist");
  expect(unknown.status()).toBe(404);
});

// Finding from the 2026-07-07 review (tests/MAPS-COVERAGE.md): the static
// proxy currently answers a parameterless request with 200 and a junk tile,
// forwarding garbage upstream on the site's maps quota. It should reject
// missing/malformed coordinates with a 4xx before any provider call.
test.fixme("map proxy rejects missing coordinates with a 4xx", async ({ request }) => {
  const res = await request.get("/api/maps/static");
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
});
