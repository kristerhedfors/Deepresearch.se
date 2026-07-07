import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractCoordinates,
  extractPlaceQueries,
  messageHasMapTargets,
} from "./maps.js";

// These batteries ARE the "user stories & prompts" for the maps capability:
// each case is a message a real user might send, asserted against what the
// deterministic extractors should pull out of it. Reverse geocoding (coords
// → place) and forward geocoding (place → coords) are the two Nominatim
// capabilities; the negatives guard against firing on ordinary prose. Grow
// these when a new phrasing is found to trigger (or wrongly trigger).

const latlon = (arr) => arr.map(({ lat, lon }) => ({ lat, lon }));

describe("extractCoordinates — reverse-geocode triggers", () => {
  test("plain decimal pair with an 'at' cue", () => {
    assert.deepEqual(latlon(extractCoordinates("What's at 59.3293, 18.0686?")), [
      { lat: 59.3293, lon: 18.0686 },
    ]);
  });

  test("plain decimal pair with a 'geocode' cue", () => {
    assert.deepEqual(latlon(extractCoordinates("Reverse geocode 40.7128, -74.006 for me")), [
      { lat: 40.7128, lon: -74.006 },
    ]);
  });

  test("plain decimal pair with a 'where' cue", () => {
    assert.deepEqual(latlon(extractCoordinates("Where is 48.8584, 2.2945 exactly?")), [
      { lat: 48.8584, lon: 2.2945 },
    ]);
  });

  test("coordinates leading, 'here' cue trailing", () => {
    assert.deepEqual(latlon(extractCoordinates("34.0522, -118.2437 — what's near here?")), [
      { lat: 34.0522, lon: -118.2437 },
    ]);
  });

  test("hemisphere notation (N/E/S/W carry the sign, needs no cue)", () => {
    assert.deepEqual(latlon(extractCoordinates("51.5074° N, 0.1278° W")), [
      { lat: 51.5074, lon: -0.1278 },
    ]);
  });

  test("hemisphere notation, space-separated, southern/western", () => {
    assert.deepEqual(latlon(extractCoordinates("33.8688 S 151.2093 E")), [
      { lat: -33.8688, lon: 151.2093 },
    ]);
  });

  test("labeled lat/long form (self-evident, needs no cue)", () => {
    assert.deepEqual(latlon(extractCoordinates("latitude 40.71 longitude -74")), [
      { lat: 40.71, lon: -74 },
    ]);
  });

  test("labeled form with colons", () => {
    assert.deepEqual(latlon(extractCoordinates("lat: 59.33, lon: 18.07")), [
      { lat: 59.33, lon: 18.07 },
    ]);
  });

  test("two coordinate pairs in a distance question", () => {
    const out = latlon(extractCoordinates("distance from 40.7128, -74.006 to 41.8781, -87.6298"));
    assert.deepEqual(out, [
      { lat: 40.7128, lon: -74.006 },
      { lat: 41.8781, lon: -87.6298 },
    ]);
  });

  test("out-of-range numbers are dropped", () => {
    assert.deepEqual(extractCoordinates("coordinates 91.0, 200.0"), []);
  });

  test("duplicates collapse", () => {
    const out = extractCoordinates("point 59.3293, 18.0686 and again at 59.3293, 18.0686");
    assert.equal(out.length, 1);
  });

  test("caps at 4 pairs", () => {
    const msg = "gps 1.1, 1.1 2.2, 2.2 3.3, 3.3 4.4, 4.4 5.5, 5.5";
    assert.equal(extractCoordinates(msg).length, 4);
  });
});

describe("extractCoordinates — negatives (must NOT fire)", () => {
  const negatives = [
    "We shipped version 3.14, 2.71 last week.",
    "The samples had pH 7.4, 6.9 respectively.",
    "See chapters 3.2, 4.5 for details.",
    "It costs $3.50, then $4.20 with tax.",
    "Compare sizes 10.5, 11.0 for the shoes.",
    "Summarize the latest AI research.",
    "",
  ];
  for (const msg of negatives) {
    test(JSON.stringify(msg), () => assert.deepEqual(extractCoordinates(msg), []));
  }
});

describe("extractPlaceQueries — forward-geocode triggers (strong cues)", () => {
  const cases = [
    ["What are the coordinates of the Eiffel Tower?", ["Eiffel Tower"]],
    ["Show me a map of Kyoto", ["Kyoto"]],
    ["Give me directions to Stockholm Central Station", ["Stockholm Central Station"]],
    ["How do I get to the Colosseum?", ["Colosseum"]],
    ["What's the location of Machu Picchu?", ["Machu Picchu"]],
    ["gps coordinates for mount everest", ["mount everest"]],
    ["I need the latitude and longitude of Reykjavik", ["Reykjavik"]],
  ];
  for (const [msg, expected] of cases) {
    test(msg, () => assert.deepEqual(extractPlaceQueries(msg), expected));
  }
});

describe("extractPlaceQueries — 'where is' weak cue (needs a proper-noun-ish place)", () => {
  test("capitalized place resolves", () => {
    assert.deepEqual(extractPlaceQueries("Where is the Eiffel Tower?"), ["Eiffel Tower"]);
  });

  test("capitalized place with trailing 'located'", () => {
    assert.deepEqual(extractPlaceQueries("Where is Mount Kilimanjaro located?"), [
      "Mount Kilimanjaro",
    ]);
  });

  test("stops at a conjunction", () => {
    assert.deepEqual(
      extractPlaceQueries("Where is Paris and what's its population?"),
      ["Paris"],
    );
  });

  test("a lowercase generic noun does NOT fire", () => {
    assert.deepEqual(extractPlaceQueries("Where is my phone?"), []);
  });

  test("a coding question does NOT fire", () => {
    assert.deepEqual(extractPlaceQueries("Where is the bug in this function?"), []);
  });
});

describe("extractPlaceQueries — distance / route pairs", () => {
  const cases = [
    ["How far is it from Paris to Rome?", ["Paris", "Rome"]],
    ["distance between Tokyo and Osaka", ["Tokyo", "Osaka"]],
    ["route from Berlin to Munich", ["Berlin", "Munich"]],
    ["How long does it take to drive from LA to Las Vegas?", ["LA", "Las Vegas"]],
    ["How far is Paris from London?", ["Paris", "London"]],
  ];
  for (const [msg, expected] of cases) {
    test(msg, () => assert.deepEqual(extractPlaceQueries(msg), expected));
  }

  test("a distance cue with no place pair does not fabricate one", () => {
    assert.deepEqual(extractPlaceQueries("How far can a cheetah run?"), []);
  });
});

describe("extractPlaceQueries — 'what/which region is X in' phrasing", () => {
  test("what country is Kilimanjaro in", () => {
    assert.deepEqual(extractPlaceQueries("What country is Kilimanjaro in?"), ["Kilimanjaro"]);
  });

  test("which city is the Louvre located in", () => {
    assert.deepEqual(extractPlaceQueries("Which city is the Louvre located in?"), ["Louvre"]);
  });

  test("a lowercase generic subject does NOT fire", () => {
    assert.deepEqual(extractPlaceQueries("What country is the author in?"), []);
  });
});

describe("extractPlaceQueries — generic destinations are rejected", () => {
  const negatives = [
    "How do I get to work?",
    "Give me directions home",
    "How do I get to my house?",
  ];
  for (const msg of negatives) {
    test(JSON.stringify(msg), () => assert.deepEqual(extractPlaceQueries(msg), []));
  }

  test("navigate-from-home keeps only the real address", () => {
    assert.deepEqual(
      extractPlaceQueries("navigate from my house to 350 Fifth Avenue"),
      ["350 Fifth Avenue"],
    );
  });
});

describe("extractCoordinates — data-speak stays quiet", () => {
  const negatives = [
    "The point estimate was 1.5, 2.5 in the model.",
    "The ratio settled at 1.5, 2.5 last run.",
    "Figure 2.3, 4.1 shows the trend.",
  ];
  for (const msg of negatives) {
    test(JSON.stringify(msg), () => assert.deepEqual(extractCoordinates(msg), []));
  }

  test("but 'elevation at' still resolves a real pair", () => {
    assert.deepEqual(
      extractCoordinates("What's the elevation at 27.9881, 86.925?").map(({ lat, lon }) => ({ lat, lon })),
      [{ lat: 27.9881, lon: 86.925 }],
    );
  });
});

describe("extractPlaceQueries — street addresses", () => {
  test("full address with city", () => {
    assert.deepEqual(
      extractPlaceQueries("What's near 1600 Pennsylvania Avenue, Washington?"),
      ["1600 Pennsylvania Avenue, Washington"],
    );
  });

  test("short address", () => {
    assert.deepEqual(extractPlaceQueries("Take me to 10 Downing Street"), [
      "10 Downing Street",
    ]);
  });

  test("house number with a letter suffix", () => {
    assert.deepEqual(extractPlaceQueries("I want to visit 221B Baker Street, London"), [
      "221B Baker Street, London",
    ]);
  });

  test("a page/figure number is not an address", () => {
    assert.deepEqual(extractPlaceQueries("I read 42 pages of the report."), []);
  });
});

describe("extractPlaceQueries — negatives (must NOT fire)", () => {
  const negatives = [
    "Summarize the latest developments in fusion energy.",
    "What is the capital of France?",
    "Explain how photosynthesis works.",
    "Where did the project go wrong last quarter?",
    "Rewrite this paragraph to be more concise.",
    "",
  ];
  for (const msg of negatives) {
    test(JSON.stringify(msg), () => assert.deepEqual(extractPlaceQueries(msg), []));
  }

  test("caps at 3 places", () => {
    const msg = "map of Paris, map of Rome, map of Berlin, map of Madrid, map of Lisbon";
    assert.ok(extractPlaceQueries(msg).length <= 3);
  });
});

describe("messageHasMapTargets — the pipeline gate", () => {
  test("coordinates fire regardless of the web-search toggle", () => {
    assert.equal(messageHasMapTargets("what's at 59.3293, 18.0686", false), true);
    assert.equal(messageHasMapTargets("what's at 59.3293, 18.0686", true), true);
  });

  test("a named place fires ONLY when web search is on (privacy gate)", () => {
    assert.equal(messageHasMapTargets("map of Kyoto", false), false);
    assert.equal(messageHasMapTargets("map of Kyoto", true), true);
  });

  test("an ordinary question fires for neither", () => {
    assert.equal(messageHasMapTargets("summarize the news", false), false);
    assert.equal(messageHasMapTargets("summarize the news", true), false);
  });

  test("non-string input is safe", () => {
    assert.equal(messageHasMapTargets(undefined, true), false);
    assert.equal(messageHasMapTargets(null, true), false);
  });
});
