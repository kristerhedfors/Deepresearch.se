import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { exaErrorKind } from "./exa.js";

describe("exaErrorKind", () => {
  test("a healthy 200 (including a genuine empty result) is not an error", () => {
    assert.equal(exaErrorKind(200), null);
    assert.equal(exaErrorKind(200, "whatever body"), null);
  });

  test("402 classifies as out-of-credits", () => {
    assert.equal(exaErrorKind(402, ""), "no_credits");
  });

  test("the NO_MORE_CREDITS body tag is recognized even off a non-402 status", () => {
    // Exa has been observed returning the credits message; match the tag too.
    assert.equal(
      exaErrorKind(400, '{"error":"You have exceeded your credits limit","tag":"NO_MORE_CREDITS"}'),
      "no_credits",
    );
  });

  test("401 and 403 classify as auth", () => {
    assert.equal(exaErrorKind(401), "auth");
    assert.equal(exaErrorKind(403), "auth");
  });

  test("429 classifies as rate_limit", () => {
    assert.equal(exaErrorKind(429), "rate_limit");
  });

  test("other 4xx/5xx fall into the generic http bucket", () => {
    assert.equal(exaErrorKind(500), "http");
    assert.equal(exaErrorKind(418), "http");
  });

  test("a thrown fetch is flagged network via the sentinel", () => {
    assert.equal(exaErrorKind("network"), "network");
  });
});
