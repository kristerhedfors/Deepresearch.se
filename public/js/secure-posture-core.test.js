// Unit tests for secure-posture-core.js — what Se/cure may honestly claim
// given the configuration a session was entered with.
//
// The contract under test is a HONESTY contract, so the assertions are mostly
// negative: no surface may promise "stays in this browser" / "no server" while
// the session relays prompts through the server to a peer's machine. That was
// the defect (feedback #31, 2026-07-26) — the decoration was unconditional
// while the session was not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SECURE_POSTURES,
  fullyLocalSession,
  securePosture,
  securePostureBrief,
  securePostureLine,
  securePostureQuips,
} from "./secure-posture-core.js";

/** Every string a surface would show for this config, lowercased. */
function allCopy(ctx) {
  const brief = securePostureBrief(ctx);
  return [...securePostureQuips(ctx), ...brief.lines, brief.headline, securePostureLine(ctx)]
    .join(" \n ")
    .toLowerCase();
}

/** The blanket claims that are only true for an unconfigured session. */
const BLANKET_CLAIMS = [
  "no server's watching",
  "everything here stays in this browser",
  "nothing leaves at all",
  "never in the path",
  "reaches no third party",
];

describe("securePosture", () => {
  it("resolves each configuration to its posture", () => {
    assert.equal(securePosture({}), "direct");
    assert.equal(securePosture({ local: true }), "local");
    assert.equal(securePosture({ viaProxy: true }), "routed");
    assert.equal(securePosture({ pool: true }), "peer");
  });

  it("lets the LARGEST disclosure win when several apply", () => {
    // A pooled completion is relayed by the server AND read by a named human,
    // so it must never be described as merely borrowed — or as local, which a
    // stale `local` flag alongside a live pool token could otherwise produce.
    assert.equal(securePosture({ pool: true, viaProxy: true }), "peer");
    assert.equal(securePosture({ pool: true, local: true }), "peer");
    assert.equal(securePosture({ viaProxy: true, local: true }), "routed");
  });

  it("only calls a session fully local when nothing at all leaves", () => {
    assert.equal(fullyLocalSession({ local: true, search: "off" }), true);
    assert.equal(fullyLocalSession({ local: true, search: "grant" }), false);
    assert.equal(fullyLocalSession({ local: true, search: "self" }), false);
    assert.equal(fullyLocalSession({ pool: true, search: "off" }), false);
    assert.equal(fullyLocalSession({ viaProxy: true, search: "off" }), false);
  });

  it("exposes the postures it can return", () => {
    for (const ctx of [{}, { local: true }, { viaProxy: true }, { pool: true }]) {
      assert.ok(SECURE_POSTURES.includes(securePosture(ctx)));
    }
  });
});

describe("securePostureQuips — the ghost never lies", () => {
  it("keeps the blanket promises ONLY for a fully local session", () => {
    const local = allCopy({ local: true, search: "off" });
    assert.match(local, /nothing leaves at all/);

    // The reported bug, in one assertion per outward-routing configuration.
    for (const ctx of [{ pool: true }, { viaProxy: true }, { pool: true, search: "grant" }]) {
      const copy = allCopy(ctx);
      for (const claim of BLANKET_CLAIMS) {
        assert.ok(!copy.includes(claim), `"${claim}" must not appear for ${JSON.stringify(ctx)}`);
      }
    }
  });

  it("leads with the peer warning when shared compute is in the path", () => {
    const quips = securePostureQuips({ pool: true });
    assert.match(quips[0], /machine/i);
    assert.ok(
      quips.some((q) => /read/i.test(q)),
      "the consumer must be told the pool owner can read what they send",
    );
  });

  it("names the pool owner when the server has resolved them", () => {
    const quips = securePostureQuips({ pool: true, peerLabel: "ada@example.com" });
    assert.ok(quips.some((q) => q.includes("ada@example.com")));
    // …and falls back to a truthful placeholder before /api/pool/peer answers.
    assert.ok(securePostureQuips({ pool: true }).some((q) => /another person/.test(q)));
  });

  it("says where SEARCH words go, separately from the model route", () => {
    assert.match(securePostureQuips({ local: true, search: "grant" }).join(" "), /exa/i);
    assert.match(securePostureQuips({ local: true, search: "self" }).join(" "), /you picked/i);
    assert.match(securePostureQuips({ local: true, search: "off" }).join(" "), /no web search/i);
  });

  it("always returns at least three short, non-empty bubbles", () => {
    for (const ctx of [{}, { local: true }, { viaProxy: true }, { pool: true }]) {
      const quips = securePostureQuips(ctx);
      assert.ok(quips.length >= 3, JSON.stringify(ctx));
      for (const q of quips) {
        assert.equal(typeof q, "string");
        assert.ok(q.trim().length > 0);
        // They float above a moving character — a wall of text does not fit.
        assert.ok(q.length <= 80, `too long for a speech bubble: ${q}`);
      }
    }
  });

  it("keeps the browser-storage promise in EVERY configuration", () => {
    // Chats and keys really are sealed browser-side whatever the route, so
    // this half of the tier's message survives — dropping it would overcorrect.
    for (const ctx of [{}, { local: true }, { viaProxy: true }, { pool: true }]) {
      assert.match(securePostureQuips(ctx).join(" "), /seal(ed)? in this browser/i);
    }
  });
});

describe("securePostureBrief / securePostureLine", () => {
  it("states the route first for the surprising configurations", () => {
    assert.match(securePostureBrief({ pool: true }).lines[0], /shared compute/i);
    assert.match(securePostureBrief({ viaProxy: true }).lines[0], /through this site's server/i);
  });

  it("flags shared compute in the headline, so the greeter is not silent about it", () => {
    assert.match(securePostureBrief({ pool: true }).headline, /shared compute/i);
    assert.match(securePostureBrief({ viaProxy: true }).headline, /borrowed/i);
    assert.equal(securePostureBrief({}).headline, "You're on Se/cure");
  });

  it("gives a one-liner that matches the posture", () => {
    assert.match(securePostureLine({ pool: true, peerLabel: "bo" }), /bo's machine/);
    assert.match(securePostureLine({ viaProxy: true }), /borrowed/i);
    assert.match(securePostureLine({ local: true }), /your own device/i);
    assert.match(securePostureLine({}), /not in the path/i);
  });
});
