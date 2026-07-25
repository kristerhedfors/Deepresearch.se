// LLM SHARING, end to end against the LIVE site — a handful of people in one
// shared workspace, ONE of them lending their local model, everyone else's
// traffic routed through that participant, and BOTH sides verifying who the
// other is before a single prompt moves (owner directive, 2026-07-25).
//
// What this file proves, in the order it proves it:
//
//   1. RUN-AS gives one break-glass credential N distinct platform identities
//      (src/run-as.js), so a genuinely multi-user flow can be driven from a
//      test harness. Each persona gets its own session cookie and is a
//      separate account to the broker — separate pool, separate consent.
//   2. The sharer registers a provider and mints a pool token, which travels
//      inside a SEALED WORKSPACE LINK (grants.pool) — the real distribution
//      path, not a side channel.
//   3. Every consumer is refused until BOTH questions are answered:
//      INGRESS (the sharer allows that identity onto their machine) and
//      EGRESS (the consumer allows their prompts to leave for that machine).
//      Each side is shown the OTHER's platform-verified identity.
//   4. Once answered, the answers are REMEMBERED — the second request is not
//      asked again — and a denied participant stays refused.
//   5. The relay itself works: the sharer's "browser" claims the job, answers
//      it from their model, and the consumer gets that completion back.
//
// HARNESS NOTES
// - The sharer's local LLM is stood in for by this process: the provider loop
//   (poll → run → result) is the sharer's browser half, and it answers with a
//   canned completion. That is the honest seam to fake — there is no Ollama in
//   CI — and everything between the consumer and that answer is the real
//   deployed broker.
// - The suite's global Basic header is CLEARED for these contexts: a consumer
//   authorizes with `Bearer pt1.…`, and a Basic Authorization header would
//   both collide with it and make everyone the same admin identity. Personas
//   authenticate by the run-as SESSION COOKIE instead, which is exactly how a
//   real signed-in participant does it.

import { expect, request as apiRequest, test } from "@playwright/test";
import { buildWorkspacePayload, sealWorkspace } from "../../public/js/workspace-core.js";

const BASE = process.env.BASE_URL || "https://deepresearch.se";
const AUTH = "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString("base64");
const PROXY = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const MODEL = "e2e-shared-model";
const SUITE = "e2e-" + Math.random().toString(36).slice(2, 8);

// One sharer, three consumers — "a handful of people in a shared workspace".
const SHARER = `test:${SUITE}-alice`;
const CONSUMERS = [`test:${SUITE}-bob`, `test:${SUITE}-carol`, `test:${SUITE}-dave`];

test.use({ extraHTTPHeaders: {} });

/** A break-glass API context — the only thing that may mint run-as sessions. */
async function adminContext() {
  return apiRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { authorization: AUTH },
    ignoreHTTPSErrors: true,
    ...(PROXY ? { proxy: PROXY } : {}),
  });
}

/**
 * A request context that IS the named persona: break-glass mints the session,
 * the context then carries only that cookie. No Basic header, so a `Bearer`
 * pool token still reaches the broker intact.
 */
async function personaContext(admin, spec) {
  const res = await admin.post("/api/admin/run-as", { data: { as: spec } });
  expect(res.ok(), `run-as ${spec} should be minted by break-glass`).toBe(true);
  const { identity, cookie } = await res.json();
  const value = String(cookie).split(";")[0].split("=").slice(1).join("=");
  const ctx = await apiRequest.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    ...(PROXY ? { proxy: PROXY } : {}),
    storageState: {
      cookies: [{ name: "dr_session", value, domain: new URL(BASE).hostname, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
      origins: [],
    },
  });
  return { ctx, identity };
}

/** POST a completion as a pool consumer (the token is the authority). */
function complete(ctx, token, content) {
  return ctx.post("/api/pool/llm/chat/completions", {
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    data: { model: MODEL, messages: [{ role: "user", content }] },
  });
}

/**
 * The sharer's browser half: claim queued jobs and answer them from "their
 * local model". Runs for `ms` in the background while consumers send.
 */
function runProviderLoop(ctx, providerId, ms) {
  const deadline = Date.now() + ms;
  const served = [];
  const done = (async () => {
    while (Date.now() < deadline) {
      const res = await ctx.post("/api/pool/poll", { data: { providerId } }).catch(() => null);
      if (!res || !res.ok()) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const { job } = await res.json();
      if (!job) continue; // the poll blocks server-side; a null just means idle
      served.push(job);
      await ctx
        .post("/api/pool/result", {
          data: {
            providerId,
            jobId: job.job_id || job.jobId,
            response: {
              id: "e2e",
              object: "chat.completion",
              model: MODEL,
              choices: [{ index: 0, message: { role: "assistant", content: "SHARED-LLM-OK: " + (job.request?.messages?.[0]?.content || "") }, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 7 },
            },
            usage: { prompt_tokens: 5, completion_tokens: 7 },
          },
        })
        .catch(() => {});
    }
  })();
  return { done, served };
}

test("@live shared workspace: one participant's LLM serves the others, both sides verifying each identity", async () => {
  const admin = await adminContext();
  const cleanup = [];
  let sharer = null;
  let providerId = null;

  try {
    // ── 1. Four distinct platform identities from one break-glass credential ──
    sharer = await personaContext(admin, SHARER);
    const consumers = [];
    for (const spec of CONSUMERS) consumers.push({ spec, ...(await personaContext(admin, spec)) });
    cleanup.push(() => sharer.ctx.dispose(), ...consumers.map((c) => () => c.ctx.dispose()));

    // They really are different accounts, and none of them is the admin.
    const ids = new Set([sharer.identity.id, ...consumers.map((c) => c.identity.id)]);
    expect(ids.size).toBe(4);
    expect(sharer.identity.role).toBe("user");
    expect(sharer.identity.synthetic).toBe(true);
    // A persona must NOT be able to reach the admin surface — run-as is an
    // identity picker, never an escalation.
    expect((await sharer.ctx.get("/api/admin/pool")).status()).toBe(403);

    // ── 2. The sharer lends their model and mints the workspace's token ──────
    const reg = await sharer.ctx.post("/api/pool/register", {
      data: { label: "Alice's e2e model", models: [MODEL], concurrency: 1 },
    });
    expect(reg.ok(), "the sharer registers a provider tab").toBe(true);
    ({ providerId } = await reg.json());
    expect(providerId).toBeTruthy();

    const mint = await sharer.ctx.post("/api/pool/token", { data: { label: "e2e workspace", source: "workspace" } });
    expect(mint.ok()).toBe(true);
    const grant = await mint.json();
    cleanup.push(() => sharer.ctx.post("/api/pool/revoke", { data: { jti: grant.jti } }).catch(() => {}));
    // The token carries the MINTER's verified identity — that is what every
    // consumer's egress question will name, and it comes from the server's
    // view of the session, not from anything a consumer can influence.
    expect(grant.owner).toBe(sharer.identity.email);

    // ── 3. The token travels inside a sealed workspace link ─────────────────
    const password = "E2ePool" + Math.random().toString(36).slice(2, 10);
    const payload = buildWorkspacePayload({}, { grants: { pool: grant.token }, name: "E2E shared compute" });
    const blob = await sealWorkspace(payload, password);
    expect(blob.length).toBeGreaterThan(40);
    // The link is the distribution path; the token inside it is what each
    // participant's client would connect (public/cure/drc.js connectPoolGrant).
    const link = `${BASE}/cure/workspace#w=${blob}`;
    expect(link).toContain("#w=");

    // ── 4. Nobody gets through on the token alone ───────────────────────────
    for (const c of consumers) {
      const res = await complete(c.ctx, grant.token, "before consent");
      expect(res.status(), `${c.spec} must be refused before consent`).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("ingress_pending");
      // The consumer is told WHO must approve them, by verified identity.
      expect(body.owner.display).toBe(sharer.identity.email);
      expect(body.owner.verified).toBe(true);
      // And the platform names THEM, not the token.
      expect(body.you.key).toBe("u:" + c.identity.id);
      expect(body.you.verified).toBe(true);
      expect(body.question.title).toContain(c.identity.email);
    }

    // ── 5. The sharer sees three verified strangers waiting ─────────────────
    const board = await (await sharer.ctx.get("/api/pool")).json();
    const waiting = board.consumers.filter((x) => x.state === "pending");
    for (const c of consumers) {
      const row = waiting.find((x) => x.consumerKey === "u:" + c.identity.id);
      expect(row, `${c.spec} should be waiting on the sharer's board`).toBeTruthy();
      expect(row.display).toBe(c.identity.email);
      expect(row.verified).toBe(true);
    }
    expect(board.pendingIngress).toBeGreaterThanOrEqual(3);

    // ── 6. INGRESS: the sharer allows two and denies the third ──────────────
    const [bob, carol, dave] = consumers;
    for (const c of [bob, carol]) {
      const res = await sharer.ctx.post("/api/pool/ingress", { data: { consumerKey: "u:" + c.identity.id, decision: "allow" } });
      expect(res.ok()).toBe(true);
    }
    const denied = await sharer.ctx.post("/api/pool/ingress", { data: { consumerKey: "u:" + dave.identity.id, decision: "deny" } });
    expect(denied.ok()).toBe(true);

    // Ingress alone is not enough: it is now the CONSUMER's turn to agree.
    const half = await complete(bob.ctx, grant.token, "half consent");
    expect(half.status()).toBe(403);
    const halfBody = await half.json();
    expect(halfBody.code).toBe("egress_pending");
    expect(halfBody.question.title).toContain(sharer.identity.email);

    // ── 7. EGRESS: each allowed consumer agrees, on their own side ──────────
    for (const c of [bob, carol]) {
      // /peer is the one answer both sides render their question from.
      const peer = await (await c.ctx.post("/api/pool/peer", { data: { token: grant.token } })).json();
      expect(peer.owner.display).toBe(sharer.identity.email);
      expect(peer.ingress).toBe("allowed");
      expect(peer.egress).toBe("pending");
      expect(peer.ready).toBe(false);
      const ok = await c.ctx.post("/api/pool/egress", { data: { token: grant.token, decision: "allow" } });
      expect(ok.ok()).toBe(true);
      expect((await ok.json()).egress).toBe("allowed");
      const after = await (await c.ctx.post("/api/pool/peer", { data: { token: grant.token } })).json();
      expect(after.ready, "both sides have now said yes").toBe(true);
    }

    // ── 8. The relay: the sharer's machine answers the others' prompts ──────
    const loop = runProviderLoop(sharer.ctx, providerId, 60_000);
    const answers = await Promise.all([
      complete(bob.ctx, grant.token, "question from bob"),
      complete(carol.ctx, grant.token, "question from carol"),
    ]);
    for (const [i, res] of answers.entries()) {
      expect(res.status(), `consumer ${i} should get a completion`).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toContain("SHARED-LLM-OK");
    }
    // The prompts really passed through the sharer's half.
    expect(loop.served.length).toBeGreaterThanOrEqual(2);
    expect(loop.served.map((j) => j.request.messages[0].content).sort()).toEqual(["question from bob", "question from carol"]);

    // ── 9. REMEMBERED: no second round of questions ─────────────────────────
    const again = await complete(bob.ctx, grant.token, "second question from bob");
    expect(again.status(), "an answered pair is never asked again").toBe(200);

    // ── 10. The denied participant stays out, workspace link or not ─────────
    const refused = await complete(dave.ctx, grant.token, "question from dave");
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("ingress_blocked");
    // A fresh token for the same person does not launder the decision: the
    // sharer's answer is remembered against the IDENTITY.
    const second = await (await sharer.ctx.post("/api/pool/token", { data: { label: "e2e second link" } })).json();
    cleanup.push(() => sharer.ctx.post("/api/pool/revoke", { data: { jti: second.jti } }).catch(() => {}));
    const stillRefused = await complete(dave.ctx, grant.token, "retry with a new link");
    expect(stillRefused.status()).toBe(403);

    // ── 11. Both halves are visible where the owner directive put them ──────
    const finalBoard = await (await sharer.ctx.get("/api/pool")).json();
    const bobRow = finalBoard.consumers.find((x) => x.consumerKey === "u:" + bob.identity.id);
    expect(bobRow.state).toBe("allowed");
    expect(bobRow.jobs).toBeGreaterThanOrEqual(2);
    const daveRow = finalBoard.consumers.find((x) => x.consumerKey === "u:" + dave.identity.id);
    expect(daveRow.state).toBe("blocked");
    // …and the consumer's own outgoing decision is on THEIR screen.
    const bobBoard = await (await bob.ctx.get("/api/pool")).json();
    const outgoing = bobBoard.egress.find((e) => e.poolId === sharer.identity.id);
    expect(outgoing, "the pool Bob consumes shows on his own LLM sharing screen").toBeTruthy();
    expect(outgoing.state).toBe("allowed");
    expect(outgoing.ownerDisplay).toBe(sharer.identity.email);

    // ── 12. Either side can withdraw, and it takes effect immediately ───────
    await bob.ctx.post("/api/pool/egress", { data: { token: grant.token, decision: "deny" } });
    const withdrawn = await complete(bob.ctx, grant.token, "after withdrawing");
    expect(withdrawn.status()).toBe(403);
    expect((await withdrawn.json()).code).toBe("egress_blocked");

    loop.done.catch(() => {});
  } finally {
    // Never leave live capacity or a live allowance behind.
    if (sharer && providerId) await sharer.ctx.post("/api/pool/unregister", { data: { providerId } }).catch(() => {});
    for (const fn of cleanup.reverse()) await fn().catch?.(() => {});
    await admin.dispose().catch(() => {});
  }
});

test("@live the LLM sharing screen sits one level below Settings and answers the ingress question", async ({ browser }) => {
  const admin = await adminContext();
  const spec = `test:${SUITE}-uisharer`;
  const res = await admin.post("/api/admin/run-as", { data: { as: spec } });
  expect(res.ok()).toBe(true);
  const { identity, cookie } = await res.json();
  const value = String(cookie).split(";")[0].split("=").slice(1).join("=");

  const context = await browser.newContext({ extraHTTPHeaders: {} });
  await context.addCookies([
    { name: "dr_session", value, domain: new URL(BASE).hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    // Pre-acknowledge the privacy notice (helpers.js openApp does the same):
    // its overlay covers the header, so without this the gear click waits on
    // actionability until the test times out.
    { name: "dr_privacy_ack", value: "1", url: BASE },
  ]);
  const page = await context.newPage();
  try {
    // A pending ingress request to answer on screen: mint a token for this
    // persona's own pool and have an anonymous holder ask through it.
    const grant = await (await admin.post("/api/pool/token", { data: { label: "ui-e2e" }, headers: { "x-run-as": spec } })).json();
    const anon = await apiRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, ...(PROXY ? { proxy: PROXY } : {}) });
    await anon.post("/api/pool/peer", { data: { token: grant.token } });
    await anon.dispose();

    await page.goto("/rver");
    await expect(page.locator("#form")).toBeVisible({ timeout: 60_000 });
    await page.click("#gearbtn");
    await expect(page.locator("#account")).toBeVisible();
    // The door: one level below Settings.
    await expect(page.locator("#llmsharingbtn")).toBeVisible({ timeout: 30_000 });
    await page.click("#llmsharingbtn");
    await expect(page.locator("#accounttitle")).toHaveText("LLM sharing");

    // The waiting request is on screen, labelled for what it is.
    const waiting = page.locator(".pool-row.waiting").first();
    await expect(waiting).toBeVisible({ timeout: 30_000 });
    await expect(waiting).toContainText("unverified");
    await waiting.locator("button[data-decision='allow']").click();
    // The answer is remembered — the row comes back allowed, not waiting.
    await expect(page.locator(".pool-row.waiting")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".pool-row").first()).toContainText("allowed");

    await admin.post("/api/pool/revoke", { data: { jti: grant.jti }, headers: { "x-run-as": spec } }).catch(() => {});
  } finally {
    await context.close();
    await admin.dispose().catch(() => {});
  }
});
