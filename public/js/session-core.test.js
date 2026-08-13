// Node tests for session-core.js — the multi-tab session registry.
//
// The reported bug (owner, 2026-07-27) was that a second tab silently joined the
// first tab's in-flight research and could be running a different agent while
// doing it. The rules that prevent that are all in resumeTarget /
// attachDecision, so those two get the heaviest coverage — including the iOS
// cold-relaunch case the old single-slot pointer existed to serve, which must
// keep working.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  HEARTBEAT_MS,
  LEASE_STALE_MS,
  MAX_SESSIONS,
  PENDING_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_SCHEMA_V,
  anySessionHeld,
  attachDecision,
  blankSession,
  claimSession,
  dropSession,
  emptyRegistry,
  freshPending,
  getSession,
  heartbeat,
  listSessions,
  newSessionId,
  newTabId,
  normalizeConfig,
  normalizePending,
  normalizeSession,
  parseAttachment,
  parseRegistry,
  pruneRegistry,
  putSession,
  releaseSession,
  resumeTarget,
  serializeAttachment,
  serializeRegistry,
  sessionHeld,
  touchSession,
} from "./session-core.js";

const NOW = 1_700_000_000_000;

/** A registry holding the given records. */
function regOf(...recs) {
  let reg = emptyRegistry();
  for (const r of recs) reg = putSession(reg, r);
  return reg;
}

/** A session with an in-flight answer started `ago` ms before NOW. */
function withPending(sid, { ago = 1000, held = null, heldAt = NOW, now = NOW } = {}) {
  const rec = blankSession({ sid, agent: "science", now });
  return {
    ...rec,
    pending: { convId: "c-" + sid, requestId: "r-" + sid, startedAt: now - ago, model: "m", budgetS: 60, webSearch: true },
    heldBy: held,
    heldAt: held ? heldAt : 0,
  };
}

describe("ids", () => {
  test("a session id is safe to hand to the server as the container session", () => {
    // src/exec-container.js sanitizeSession: /^[A-Za-z0-9._-]{1,64}$/. One id
    // names the agent, the workspace AND the history, so it must survive that
    // gate verbatim or the workspace half silently gets a fresh container.
    for (let i = 0; i < 200; i++) {
      const sid = newSessionId(NOW + i);
      assert.match(sid, /^[A-Za-z0-9._-]{1,64}$/, sid);
    }
  });

  test("ids are distinct for the same instant given different randomness", () => {
    let n = 0;
    const rand = () => [0.1111, 0.9999][n++ % 2];
    assert.notEqual(newSessionId(NOW, rand), newSessionId(NOW, rand));
    assert.notEqual(newTabId(NOW, () => 0.5), newSessionId(NOW, () => 0.5));
  });
});

describe("normalizeConfig", () => {
  test("fills the app's defaults for missing or junk fields", () => {
    assert.deepEqual(normalizeConfig(null), { model: "", budgetS: null, webSearch: true });
    // Only an EXPLICIT false turns search off — the app's convention
    // everywhere (`record.webSearch !== false`), so a junk value must not
    // silently disable a user's web search.
    assert.deepEqual(normalizeConfig({ model: 7, budgetS: "x", webSearch: 0 }), {
      model: "",
      budgetS: null,
      webSearch: true,
    });
    assert.equal(normalizeConfig({ webSearch: false }).webSearch, false);
    assert.deepEqual(normalizeConfig({ model: "m", budgetS: 120, webSearch: false }), {
      model: "m",
      budgetS: 120,
      webSearch: false,
    });
    // NaN/Infinity are finite-checked, so they can't poison the slider.
    assert.equal(normalizeConfig({ budgetS: NaN }).budgetS, null);
    assert.equal(normalizeConfig({ budgetS: Infinity }).budgetS, null);
  });
});

describe("normalizePending", () => {
  const good = { convId: "c", requestId: "r", startedAt: NOW };

  test("accepts a well-formed fresh pointer and normalizes its settings", () => {
    const p = normalizePending(good, NOW + 1000);
    assert.equal(p.convId, "c");
    assert.equal(p.requestId, "r");
    assert.deepEqual([p.model, p.budgetS, p.webSearch], ["", null, true]);
  });

  test("rejects anything past the recovery window (the answer is already purged)", () => {
    assert.equal(normalizePending(good, NOW + PENDING_TTL_MS - 1) !== null, true);
    assert.equal(normalizePending(good, NOW + PENDING_TTL_MS), null); // boundary is expired
    assert.equal(normalizePending(good, NOW + PENDING_TTL_MS + 1), null);
  });

  test("rejects missing or wrongly-typed identifiers", () => {
    assert.equal(normalizePending(null, NOW), null);
    assert.equal(normalizePending("nope", NOW), null);
    assert.equal(normalizePending({ requestId: "r", startedAt: NOW }, NOW), null);
    assert.equal(normalizePending({ convId: "c", startedAt: NOW }, NOW), null);
    assert.equal(normalizePending({ convId: "c", requestId: "r" }, NOW), null);
    assert.equal(normalizePending({ convId: 1, requestId: "r", startedAt: NOW }, NOW), null);
    assert.equal(normalizePending({ convId: "c", requestId: "r", startedAt: "x" }, NOW), null);
  });
});

describe("normalizeSession", () => {
  test("drops a record with no usable id", () => {
    assert.equal(normalizeSession(null), null);
    assert.equal(normalizeSession({}), null);
    assert.equal(normalizeSession({ sid: "" }), null);
    assert.equal(normalizeSession({ sid: 5 }), null);
  });

  test("parsing does not apply the pending TTL (that is a use-time decision)", () => {
    // Deliberate: parseRegistry must be a pure function of its input, so an
    // ancient pointer survives the read and freshPending filters it later.
    const rec = normalizeSession({
      sid: "s1",
      agent: "sdk",
      pending: { convId: "c", requestId: "r", startedAt: 1 },
    });
    assert.equal(rec.pending.requestId, "r");
    assert.equal(freshPending(rec, NOW), null); // …and it is filtered at use
  });

  test("coerces junk fields without throwing", () => {
    const rec = normalizeSession({ sid: "s1", agent: 9, convId: 4, heldBy: 1, heldAt: "x", updatedAt: "y" });
    assert.deepEqual(
      [rec.agent, rec.convId, rec.heldBy, rec.heldAt, rec.updatedAt],
      ["", null, null, 0, 0],
    );
  });
});

describe("parseRegistry / serializeRegistry", () => {
  test("absent, malformed or non-object input yields an empty registry", () => {
    for (const raw of [null, undefined, "", "{not json", "[]", '"str"', "7"]) {
      assert.deepEqual(parseRegistry(raw), emptyRegistry(), String(raw));
    }
  });

  test("a registry from a different schema version is not adopted", () => {
    // Reading a newer build's registry and writing it back would silently drop
    // fields this build doesn't know about, corrupting the other build's state.
    const raw = JSON.stringify({ v: SESSION_SCHEMA_V + 1, sessions: { s1: { sid: "s1" } } });
    assert.deepEqual(parseRegistry(raw), emptyRegistry());
  });

  test("round-trips records and drops individually unreadable ones", () => {
    const reg = regOf(blankSession({ sid: "s1", agent: "science", now: NOW }));
    const back = parseRegistry(serializeRegistry(reg));
    assert.deepEqual(Object.keys(back.sessions), ["s1"]);
    assert.equal(back.sessions.s1.agent, "science");

    const mixed = JSON.stringify({
      v: SESSION_SCHEMA_V,
      sessions: { s1: { sid: "s1", agent: "sdk" }, bad: null, s2: { sid: "MISMATCH" } },
    });
    // `bad` is unreadable; `s2`'s key disagrees with its own id, which would
    // make lookups lie — both dropped, `s1` kept.
    assert.deepEqual(Object.keys(parseRegistry(mixed).sessions), ["s1"]);
  });
});

describe("registry mutators are immutable", () => {
  test("putSession / dropSession / touchSession never mutate their input", () => {
    const rec = blankSession({ sid: "s1", agent: "science", now: NOW });
    const reg = regOf(rec);
    const snapshot = serializeRegistry(reg);

    putSession(reg, blankSession({ sid: "s2", agent: "sdk", now: NOW }));
    dropSession(reg, "s1");
    touchSession(reg, "s1", { agent: "models" }, NOW + 5);
    assert.equal(serializeRegistry(reg), snapshot);
  });

  test("touchSession on a missing session is a no-op, not an error", () => {
    const reg = emptyRegistry();
    assert.equal(touchSession(reg, "ghost", { agent: "sdk" }, NOW), reg);
  });

  test("touchSession stamps updatedAt and cannot rewrite the id", () => {
    const reg = regOf(blankSession({ sid: "s1", agent: "science", now: NOW }));
    const next = touchSession(reg, "s1", { agent: "sdk", sid: "hacked" }, NOW + 500);
    assert.equal(getSession(next, "s1").agent, "sdk");
    assert.equal(getSession(next, "s1").sid, "s1");
    assert.equal(getSession(next, "s1").updatedAt, NOW + 500);
    assert.equal(getSession(next, "hacked"), null);
  });

  test("dropSession on a missing session returns the same registry", () => {
    const reg = regOf(blankSession({ sid: "s1", agent: "science", now: NOW }));
    assert.equal(dropSession(reg, "nope"), reg);
  });
});

describe("the lease", () => {
  test("a session is held only while its heartbeat is fresh", () => {
    const rec = { ...blankSession({ sid: "s1", agent: "science", now: NOW }), heldBy: "tabA", heldAt: NOW };
    assert.equal(sessionHeld(rec, NOW), true);
    assert.equal(sessionHeld(rec, NOW + LEASE_STALE_MS - 1), true);
    assert.equal(sessionHeld(rec, NOW + LEASE_STALE_MS), false); // gone quiet → orphaned
    // A record nobody claimed is never held.
    assert.equal(sessionHeld(blankSession({ sid: "s2", agent: "science", now: NOW }), NOW), false);
    assert.equal(sessionHeld(null, NOW), false);
  });

  test("the heartbeat interval leaves room for missed beats", () => {
    // A busy main thread (a VM boot, a large render) must not read as a dead
    // tab, so the stale window is several beats wide.
    assert.ok(LEASE_STALE_MS >= HEARTBEAT_MS * 3);
  });

  test("heartbeat refuses to beat for a session another live tab took over", () => {
    const reg = regOf({ ...blankSession({ sid: "s1", agent: "science", now: NOW }), heldBy: "tabB", heldAt: NOW });
    // tabA lost the session to tabB ("take over here"); its next beat must not
    // steal it back, or the lease would stop being single-writer.
    const after = heartbeat(reg, "s1", "tabA", NOW + 1000);
    assert.equal(getSession(after, "s1").heldBy, "tabB");
    // Once tabB goes quiet, tabA may take it.
    const later = heartbeat(reg, "s1", "tabA", NOW + LEASE_STALE_MS + 1);
    assert.equal(getSession(later, "s1").heldBy, "tabA");
  });

  test("only the holder may release", () => {
    const reg = claimSession(regOf(blankSession({ sid: "s1", agent: "science", now: NOW })), "s1", "tabA", NOW);
    assert.equal(getSession(releaseSession(reg, "s1", "tabB", NOW), "s1").heldBy, "tabA");
    assert.equal(getSession(releaseSession(reg, "s1", "tabA", NOW), "s1").heldBy, null);
  });

  test("anySessionHeld ignores this tab's own leases", () => {
    const reg = regOf(
      { ...blankSession({ sid: "s1", agent: "science", now: NOW }), heldBy: "tabA", heldAt: NOW },
    );
    assert.equal(anySessionHeld(reg, NOW), true);
    assert.equal(anySessionHeld(reg, NOW, "tabA"), false); // only ourselves
    assert.equal(anySessionHeld(reg, NOW + LEASE_STALE_MS), false); // gone quiet
  });
});

describe("attachDecision", () => {
  test("an unknown session is `missing` so the tab starts a fresh one", () => {
    assert.deepEqual(attachDecision({ reg: emptyRegistry(), sid: "gone", tabId: "tabA", now: NOW }), {
      action: "missing",
      holder: null,
    });
    assert.equal(attachDecision({ reg: emptyRegistry(), sid: null, tabId: "tabA", now: NOW }).action, "missing");
  });

  test("this tab reloading always retakes its own session", () => {
    const reg = claimSession(regOf(blankSession({ sid: "s1", agent: "science", now: NOW })), "s1", "tabA", NOW);
    assert.deepEqual(attachDecision({ reg, sid: "s1", tabId: "tabA", now: NOW + 1 }), {
      action: "attach",
      holder: "tabA",
    });
  });

  test("a session another live tab holds reports `held` with the holder", () => {
    const reg = claimSession(regOf(blankSession({ sid: "s1", agent: "science", now: NOW })), "s1", "tabA", NOW);
    // The owner's rule: offer a choice (new session / take over), never silent
    // co-editing of one workspace.
    assert.deepEqual(attachDecision({ reg, sid: "s1", tabId: "tabB", now: NOW + 1 }), {
      action: "held",
      holder: "tabA",
    });
  });

  test("an orphaned session is free to attach to", () => {
    const reg = claimSession(regOf(blankSession({ sid: "s1", agent: "science", now: NOW })), "s1", "tabA", NOW);
    assert.deepEqual(attachDecision({ reg, sid: "s1", tabId: "tabB", now: NOW + LEASE_STALE_MS + 1 }), {
      action: "attach",
      holder: null,
    });
  });
});

describe("resumeTarget — THE multi-tab fix", () => {
  test("a tab collects its OWN session's in-flight answer", () => {
    const reg = regOf(withPending("s1"));
    const got = resumeTarget({ reg, sid: "s1", tabId: "tabA", now: NOW });
    assert.equal(got.sid, "s1");
    assert.equal(got.pending.requestId, "r-s1");
  });

  test("a NEW tab never adopts a live tab's run (the reported bug)", () => {
    // Tab A is mid-research and holding its session. Tab B opens with no
    // attachment. Before this it read the single global pointer, showed Stop,
    // polled tab A's answer, cleared tab A's marker and acked the server's
    // parked copy out from under it.
    const reg = regOf(withPending("s1", { held: "tabA" }));
    assert.equal(resumeTarget({ reg, sid: null, tabId: "tabB", now: NOW }), null);
  });

  test("a new tab does not adopt an ORPHAN either while any other tab is alive", () => {
    // Two sessions: one orphaned with a pending answer, one held by a live tab.
    // A live lease anywhere means this is a second tab, not a relaunch — so it
    // gets a fresh session and touches neither.
    const reg = regOf(withPending("orphan"), withPending("live", { held: "tabA" }));
    assert.equal(resumeTarget({ reg, sid: null, tabId: "tabB", now: NOW }), null);
  });

  test("a cold relaunch DOES collect the answer that finished while it was gone", () => {
    // The iOS PWA-discard case pending-answer.js exists for: the app died, so
    // nothing is held, and the finished research must still be collectable.
    // This is what a naive move to sessionStorage would have broken.
    const reg = regOf({ ...withPending("s1", { held: "tabOld" }), heldAt: NOW - LEASE_STALE_MS - 1 });
    const got = resumeTarget({ reg, sid: null, tabId: "tabNew", now: NOW });
    assert.equal(got.sid, "s1");
    assert.equal(got.pending.requestId, "r-s1");
  });

  test("a cold relaunch takes the most recently started of several orphans", () => {
    const reg = regOf(
      withPending("old", { ago: 60_000 }),
      withPending("newest", { ago: 1000 }),
      withPending("mid", { ago: 30_000 }),
    );
    assert.equal(resumeTarget({ reg, sid: null, tabId: "tabNew", now: NOW }).sid, "newest");
  });

  test("an expired pointer is never resumed, attached or orphaned", () => {
    const stale = withPending("s1", { ago: PENDING_TTL_MS + 1 });
    assert.equal(resumeTarget({ reg: regOf(stale), sid: "s1", tabId: "tabA", now: NOW }), null);
    assert.equal(resumeTarget({ reg: regOf(stale), sid: null, tabId: "tabA", now: NOW }), null);
  });

  test("a session with no pending answer resumes nothing", () => {
    const reg = regOf(blankSession({ sid: "s1", agent: "science", now: NOW }));
    assert.equal(resumeTarget({ reg, sid: "s1", tabId: "tabA", now: NOW }), null);
  });

  test("an attached tab whose session was taken over resumes nothing", () => {
    // tabA still believes it is on s1, but tabB took over and is live. The
    // answer belongs to whoever holds the session.
    const reg = regOf(withPending("s1", { held: "tabB" }));
    assert.equal(resumeTarget({ reg, sid: "s1", tabId: "tabA", now: NOW }), null);
  });

  test("an attached tab resumes its own session even while holding it", () => {
    const reg = regOf(withPending("s1", { held: "tabA" }));
    assert.equal(resumeTarget({ reg, sid: "s1", tabId: "tabA", now: NOW }).sid, "s1");
  });

  test("an attached tab never reaches for ANOTHER session's answer", () => {
    // s1 (ours) has nothing; s2 has a fresh orphaned answer. Rule 1 is absolute:
    // an attached tab gets its own session's answer or none.
    const reg = regOf(blankSession({ sid: "s1", agent: "science", now: NOW }), withPending("s2"));
    assert.equal(resumeTarget({ reg, sid: "s1", tabId: "tabA", now: NOW }), null);
  });
});

describe("pruneRegistry", () => {
  test("forgets unheld idle sessions", () => {
    const reg = regOf(
      { ...blankSession({ sid: "fresh", agent: "science", now: NOW }), updatedAt: NOW },
      { ...blankSession({ sid: "idle", agent: "science", now: NOW }), updatedAt: NOW - SESSION_IDLE_MS - 1 },
    );
    const after = pruneRegistry(reg, NOW);
    assert.deepEqual(Object.keys(after.sessions), ["fresh"]);
  });

  test("never evicts a held session or one with a collectable answer", () => {
    const ancient = NOW - SESSION_IDLE_MS - 1;
    const reg = regOf(
      { ...blankSession({ sid: "held", agent: "science", now: NOW }), updatedAt: ancient, heldBy: "tabA", heldAt: NOW },
      { ...withPending("busy"), updatedAt: ancient },
    );
    // Losing either would lose real work, so an idle sweep must skip both.
    assert.deepEqual(Object.keys(pruneRegistry(reg, NOW).sessions).sort(), ["busy", "held"]);
  });

  test("over the cap it drops the least recently updated droppable sessions", () => {
    let reg = emptyRegistry();
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      reg = putSession(reg, { ...blankSession({ sid: "s" + i, agent: "science", now: NOW }), updatedAt: NOW + i });
    }
    const after = pruneRegistry(reg, NOW + MAX_SESSIONS + 3);
    assert.equal(Object.keys(after.sessions).length, MAX_SESSIONS);
    // The three oldest went; the newest stayed.
    for (const gone of ["s0", "s1", "s2"]) assert.equal(getSession(after, gone), null);
    assert.ok(getSession(after, "s" + (MAX_SESSIONS + 2)));
  });

  test("a registry of nothing but protected sessions stays over the cap", () => {
    // Deliberate: dropping a live session to satisfy a storage bound would lose
    // work. Over-quota-but-all-live is the correct outcome.
    let reg = emptyRegistry();
    for (let i = 0; i < MAX_SESSIONS + 2; i++) {
      reg = putSession(reg, { ...withPending("s" + i), updatedAt: NOW + i });
    }
    assert.equal(Object.keys(pruneRegistry(reg, NOW).sessions).length, MAX_SESSIONS + 2);
  });
});

describe("listSessions", () => {
  test("newest activity first, annotated with held/busy", () => {
    const reg = regOf(
      { ...blankSession({ sid: "a", agent: "science", now: NOW }), updatedAt: NOW - 100 },
      { ...withPending("b"), agent: "sdk", updatedAt: NOW, heldBy: "tabA", heldAt: NOW },
    );
    const list = listSessions(reg, NOW);
    assert.deepEqual(list.map((s) => s.sid), ["b", "a"]);
    assert.deepEqual([list[0].held, list[0].busy, list[0].agent], [true, true, "sdk"]);
    assert.deepEqual([list[1].held, list[1].busy], [false, false]);
  });

  test("carries no message-derived text (privacy invariant 4)", () => {
    const reg = regOf({ ...withPending("a"), agent: "science" });
    const keys = Object.keys(listSessions(reg, NOW)[0]).sort();
    // ids, agent, flags and a timestamp — no title, no filename, no text.
    assert.deepEqual(keys, ["agent", "busy", "convId", "held", "sid", "updatedAt"]);
  });
});

describe("the per-tab attachment blob", () => {
  test("round-trips", () => {
    const att = { tabId: "tabA", sid: "s1" };
    assert.deepEqual(parseAttachment(serializeAttachment(att)), att);
  });

  test("junk yields nulls so the boot mints a fresh tab + session", () => {
    for (const raw of [null, undefined, "", "{oops", "[]", "5"]) {
      assert.deepEqual(parseAttachment(raw), { tabId: null, sid: null }, String(raw));
    }
    assert.deepEqual(parseAttachment(JSON.stringify({ tabId: 1, sid: "" })), { tabId: null, sid: null });
  });
});
