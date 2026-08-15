// Unit tests for src/maps-tools.js — the pure half of the street-imagery MCP
// tools: the direction vocabulary, the view handle, and the spoken renderers.
//
// The direction parsing is the load-bearing part and the easiest to get subtly
// wrong. It decides where a caller ends up standing, and a wrong turn produces a
// confident, fluent description of somewhere else entirely — a failure a
// listener has no way to catch, because they cannot see the picture.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MOVE_M,
  MAX_MOVE_M,
  MIN_MOVE_M,
  PLACE_NEARBY_TOOL,
  STREET_VIEW_TOOL,
  clampMoveMeters,
  compassPoint,
  directionTokens,
  formatViewHandle,
  normalizeBearing,
  parseViewHandle,
  renderNearbyAnswer,
  renderStreetViewAnswer,
  resolveDirection,
  resolvePitch,
  spokenDate,
  spokenDistance,
  usableCoords,
} from "./maps-tools.js";

// ---------------------------------------------------------------------------
// The direction vocabulary — EN and SV at equal breadth (invariant 6)
// ---------------------------------------------------------------------------

test("compass words are absolute and ignore where we are facing", () => {
  for (const facing of [0, 90, 200, 359]) {
    assert.deepEqual(resolveDirection("north", facing), { bearing: 0, absolute: true });
    assert.deepEqual(resolveDirection("south", facing), { bearing: 180, absolute: true });
    assert.deepEqual(resolveDirection("northeast", facing), { bearing: 45, absolute: true });
    assert.deepEqual(resolveDirection("north-west", facing), { bearing: 315, absolute: true });
  }
});

test("Swedish parity: every compass direction, in the forms a Swede actually types", () => {
  // The definite and adverbial forms are the point. A gate that knows only
  // "south" answers a Swedish caller's question about somewhere else, silently.
  const pairs = [
    ["north", ["norr", "nord", "norrut", "åt norr", "mot norr"]],
    ["south", ["söder", "syd", "söderut", "åt söder", "hundra meter söderut"]],
    ["east", ["öster", "öst", "österut", "mot öster"]],
    ["west", ["väster", "väst", "västerut", "åt väster"]],
    ["northeast", ["nordost", "nordöst"]],
    ["southeast", ["sydost", "sydöst"]],
    ["southwest", ["sydväst"]],
    ["northwest", ["nordväst"]],
  ];
  for (const [english, swedish] of pairs) {
    const expected = resolveDirection(english, 0);
    assert.ok(expected, `${english} must parse`);
    for (const form of swedish) {
      assert.deepEqual(resolveDirection(form, 0), expected, `"${form}" must mean ${english}`);
    }
  }
});

test("relative turns are applied to the direction currently faced", () => {
  assert.deepEqual(resolveDirection("right", 0), { bearing: 90, absolute: false });
  assert.deepEqual(resolveDirection("right", 300), { bearing: 30, absolute: false }, "wraps past north");
  assert.deepEqual(resolveDirection("left", 0), { bearing: 270, absolute: false });
  assert.deepEqual(resolveDirection("back", 90), { bearing: 270, absolute: false });
  assert.deepEqual(resolveDirection("forward", 137), { bearing: 137, absolute: false });
});

test("Swedish parity: the relative turns too", () => {
  assert.deepEqual(resolveDirection("höger", 0), resolveDirection("right", 0));
  assert.deepEqual(resolveDirection("till höger", 45), resolveDirection("right", 45));
  assert.deepEqual(resolveDirection("åt vänster", 45), resolveDirection("left", 45));
  assert.deepEqual(resolveDirection("vänster", 0), resolveDirection("left", 0));
  assert.deepEqual(resolveDirection("bakåt", 10), resolveDirection("back", 10));
  assert.deepEqual(resolveDirection("tillbaka", 10), resolveDirection("back", 10));
  assert.deepEqual(resolveDirection("framåt", 10), resolveDirection("forward", 10));
  assert.deepEqual(resolveDirection("rakt fram", 10), resolveDirection("straight ahead", 10));
  // The JS `\b` trap that has broken bilingual gates in this repo before: there
  // IS a word boundary between "r" and "ö", so /\bsöder\b/ never matches
  // "söderut". The token split sidesteps it — this asserts it stays sidestepped.
  assert.deepEqual(resolveDirection("söderut", 0), { bearing: 180, absolute: true });
  assert.deepEqual(resolveDirection("högerut", 0), resolveDirection("right", 0));
});

test("a bare bearing is taken as one, and nonsense turns nothing", () => {
  assert.deepEqual(resolveDirection(225, 0), { bearing: 225, absolute: true });
  assert.deepEqual(resolveDirection("225", 0), { bearing: 225, absolute: true });
  assert.deepEqual(resolveDirection("400", 0), { bearing: 40, absolute: true }, "wrapped, not rejected");
  // An unparsed direction must NOT default to anything: silently walking or
  // turning somewhere the caller did not ask for is worse than not moving.
  assert.equal(resolveDirection("towards the nice building", 0), null);
  assert.equal(resolveDirection("", 0), null);
  assert.equal(resolveDirection(null, 0), null);
  assert.equal(resolveDirection({}, 0), null);
});

test("a half turn is 45 degrees, and there is no such thing as slightly behind", () => {
  assert.deepEqual(resolveDirection("slightly right", 0), { bearing: 45, absolute: false });
  assert.deepEqual(resolveDirection("snett vänster", 0), { bearing: 315, absolute: false });
  assert.deepEqual(resolveDirection("half back", 0), { bearing: 180, absolute: false });
});

test("looking up and down is a pitch, not a bearing", () => {
  assert.equal(resolvePitch("up"), 25);
  assert.equal(resolvePitch("uppåt"), 25);
  assert.equal(resolvePitch("down"), -25);
  assert.equal(resolvePitch("ner"), -25);
  assert.equal(resolvePitch("right"), 0);
  assert.equal(resolvePitch(""), 0);
});

test("directionTokens splits on punctuation and keeps Unicode letters", () => {
  assert.deepEqual(directionTokens("till höger!"), ["till", "höger"]);
  assert.deepEqual(directionTokens("NORTH-EAST"), ["north-east"]);
  assert.deepEqual(directionTokens(90), ["90"]);
  assert.deepEqual(directionTokens(undefined), []);
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

test("bearings normalize into [0,360)", () => {
  assert.equal(normalizeBearing(0), 0);
  assert.equal(normalizeBearing(360), 0);
  assert.equal(normalizeBearing(-90), 270);
  assert.equal(normalizeBearing(725), 5);
  assert.equal(normalizeBearing(Number.NaN), 0);
});

test("a bearing is spoken as a 16-point compass direction", () => {
  assert.equal(compassPoint(0), "north");
  assert.equal(compassPoint(90), "east");
  assert.equal(compassPoint(135), "southeast");
  assert.equal(compassPoint(67), "east-northeast");
  assert.equal(compassPoint(359), "north");
});

test("move distances clamp into the window the schema advertises", () => {
  assert.equal(clampMoveMeters(100), 100);
  assert.equal(clampMoveMeters(99999), MAX_MOVE_M);
  assert.equal(clampMoveMeters(1), MIN_MOVE_M);
  assert.equal(clampMoveMeters(0), DEFAULT_MOVE_M, "absent or zero means the default, not a zero-metre move");
  assert.equal(clampMoveMeters("nope"), DEFAULT_MOVE_M);
});

test("usableCoords rejects the (0,0) a mis-parsed argument produces", () => {
  assert.equal(usableCoords(59.33, 18.06), true);
  assert.equal(usableCoords(0, 0), false, "the Gulf of Guinea is what a dropped argument looks like");
  assert.equal(usableCoords(91, 10), false);
  assert.equal(usableCoords("59.33", "18.06"), true);
  assert.equal(usableCoords(undefined, 5), false);
});

// ---------------------------------------------------------------------------
// The view handle — this family's whole "session"
// ---------------------------------------------------------------------------

test("a handle round-trips, and carries nothing but the standpoint", () => {
  const view = { lat: 59.334591, lng: 18.06324, heading: 135, panoId: "abc-123_XYZ" };
  const handle = formatViewHandle(view);
  assert.match(handle, /^sv1:/);
  const back = parseViewHandle(handle);
  assert.equal(back?.heading, 135);
  assert.equal(back?.panoId, "abc-123_XYZ");
  assert.ok(Math.abs(/** @type {number} */ (back?.lat) - view.lat) < 1e-5);
  assert.ok(Math.abs(/** @type {number} */ (back?.lng) - view.lng) < 1e-5);
  // Nothing account-derived, so a leaked handle is a public coordinate.
  assert.equal(handle.includes("@"), false);
});

test("handle parsing is tolerant of what a voice pipeline does to a string", () => {
  assert.equal(parseViewHandle("sv1: 59.3,18.0,90,abc")?.heading, 90);
  assert.equal(parseViewHandle("59.3,18.0,90,abc")?.panoId, "abc", "a lost prefix still parses");
  assert.equal(parseViewHandle("sv1:59.3,18.0")?.heading, 0, "a missing heading is north, not a failure");
  // …but never a partly-filled handle: a silent 0,0 is the Atlantic.
  assert.equal(parseViewHandle("sv1:north,west,90,abc"), null);
  assert.equal(parseViewHandle("sv1:200,18,0,abc"), null);
  assert.equal(parseViewHandle(""), null);
  assert.equal(parseViewHandle(undefined), null);
});

// ---------------------------------------------------------------------------
// The spoken renderers
// ---------------------------------------------------------------------------

test("the look answer says where, which way, what, when — and how to come back", () => {
  const text = renderStreetViewAnswer({
    at: { label: "Basaltvägen 1, Enköping", lat: 59.6, lng: 17.0 },
    heading: 180,
    moved: null,
    description: "A two-storey brick industrial building with a loading bay.",
    date: "2023-07",
    handle: "sv1:59.600000,17.000000,180,pano",
    imagery: true,
  });
  assert.match(text, /Basaltvägen 1, Enköping/);
  assert.match(text, /facing south/);
  assert.match(text, /loading bay/);
  assert.match(text, /in July 2023/);
  assert.match(text, /sv1:59\.600000,17\.000000,180,pano/);
});

test("a move reports the distance actually achieved when the snap drifted", () => {
  const near = renderStreetViewAnswer({
    at: { lat: 59.6, lng: 17 },
    heading: 180,
    moved: { bearing: 180, meters: 100, actual: 96 },
    description: "A road.",
    handle: "sv1:x",
    imagery: true,
  });
  assert.match(near, /about 96 metres south/);
  // Street View snaps to the nearest panorama, which can be far from the metres
  // asked for. Reporting the request as if it were the result is the kind of
  // small lie that makes a whole spoken tour untrustworthy.
  const far = renderStreetViewAnswer({
    at: { lat: 59.6, lng: 17 },
    heading: 180,
    moved: { bearing: 180, meters: 100, actual: 260 },
    description: "A road.",
    handle: "sv1:x",
    imagery: true,
  });
  assert.match(far, /about 260 metres from where you were, not the 100 asked for/);
});

test("no imagery and no description are different sentences", () => {
  const none = renderStreetViewAnswer({
    at: { lat: 59.6, lng: 17 },
    heading: 0,
    description: "",
    handle: "sv1:x",
    imagery: false,
  });
  assert.match(none, /no street-level imagery/);
  const undescribed = renderStreetViewAnswer({
    at: { lat: 59.6, lng: 17 },
    heading: 0,
    description: "",
    handle: "sv1:x",
    imagery: true,
  });
  assert.match(undescribed, /could not be described/);
});

test("nearby places are spoken as distance plus direction, and an empty result says so", () => {
  const text = renderNearbyAnswer({
    query: "petrol station",
    at: { label: "Enköping", lat: 59.6, lng: 17 },
    places: [{ name: "Preem", type: "gas station", meters: 412, bearing: 47 }],
  });
  assert.match(text, /Preem \(gas station\)/);
  assert.match(text, /400 metres northeast/);
  const empty = renderNearbyAnswer({ query: "sushi", at: { label: "Enköping", lat: 59.6, lng: 17 }, places: [] });
  assert.match(empty, /Nothing matching "sushi"/);
});

test("distances and dates are rounded to what a person would say", () => {
  assert.equal(spokenDistance(38), "40 metres");
  assert.equal(spokenDistance(412), "400 metres");
  assert.equal(spokenDistance(1450), "1.5 kilometres");
  assert.equal(spokenDate("2023-07"), "in July 2023");
  assert.equal(spokenDate("2019-12-04"), "in December 2019");
  // Unparseable input comes back as-is: a wrong shape is still information, and
  // inventing a date is worse.
  assert.equal(spokenDate("recently"), "recently");
  assert.equal(spokenDate(""), "");
});

// ---------------------------------------------------------------------------
// The schemas
// ---------------------------------------------------------------------------

test("the tool schemas describe the voice flow they exist for", () => {
  assert.equal(STREET_VIEW_TOOL.name, "street_view_look");
  const props = STREET_VIEW_TOOL.input_schema.properties;
  for (const field of ["place", "lat", "lng", "view", "move", "move_meters", "look", "question"]) {
    assert.ok(props[field], `${field} property`);
  }
  // Nothing is required: an anchor can arrive three ways, and demanding one of
  // them would refuse the follow-up call, which is the commonest one.
  assert.deepEqual(STREET_VIEW_TOOL.input_schema.required, []);
  assert.match(STREET_VIEW_TOOL.description, /never an image/);
  assert.equal(PLACE_NEARBY_TOOL.name, "place_nearby");
  assert.deepEqual(PLACE_NEARBY_TOOL.input_schema.required, ["query"]);
});
