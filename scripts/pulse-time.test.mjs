// Unit tests for the shared pulse CET/CEST normalisation (scripts/pulse-time.mjs).
// This arithmetic had NO coverage while it lived duplicated in the two builders;
// the de-dup (refactor pass 2026-07-24) is what made it directly testable.
import test from "node:test";
import assert from "node:assert/strict";
import { toCetIso, cetOffsetMinutes } from "./pulse-time.mjs";

test("cetOffsetMinutes: +120 in summer (CEST), +60 in winter (CET)", () => {
  assert.equal(cetOffsetMinutes(new Date("2026-07-13T12:00:00Z")), 120);
  assert.equal(cetOffsetMinutes(new Date("2026-01-13T12:00:00Z")), 60);
});

test("cetOffsetMinutes: the DST switch itself (last Sunday of March, 01:00 UTC)", () => {
  // 2026-03-29T00:59Z is still CET (+60); 01:00Z is already CEST (+120).
  assert.equal(cetOffsetMinutes(new Date("2026-03-29T00:59:00Z")), 60);
  assert.equal(cetOffsetMinutes(new Date("2026-03-29T01:00:00Z")), 120);
});

test("toCetIso: a UTC-offset git date becomes Stockholm wall-clock", () => {
  assert.equal(toCetIso("2026-07-13T18:20:10+00:00"), "2026-07-13T20:20:10+02:00");
});

test("toCetIso: an instant already written in +02:00 keeps its wall-clock", () => {
  assert.equal(toCetIso("2026-07-13T20:20:10+02:00"), "2026-07-13T20:20:10+02:00");
});

test("toCetIso: the two builders bucket the SAME instant on the same CET day", () => {
  // The whole point of sharing this module: a commit made at 23:30 UTC belongs
  // to the NEXT calendar day in Stockholm, and both pages must agree.
  const fromContainer = toCetIso("2026-07-13T23:30:00+00:00");
  const fromPhone = toCetIso("2026-07-14T01:30:00+02:00");
  assert.equal(fromContainer, fromPhone);
  assert.equal(fromContainer.slice(0, 10), "2026-07-14");
});

test("toCetIso: winter dates carry the +01:00 offset", () => {
  assert.equal(toCetIso("2026-01-13T18:20:10+00:00"), "2026-01-13T19:20:10+01:00");
});

test("toCetIso: empty and unparseable input pass through (never throws)", () => {
  assert.equal(toCetIso(""), "");
  assert.equal(toCetIso("not-a-date"), "not-a-date");
});
