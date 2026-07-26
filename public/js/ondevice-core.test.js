// The on-device inference pure core (ondevice-core.js): catalog shape, the
// HF-tree download plan, progress math, the streaming SHA-256 vs node:crypto,
// the <think> stream filter across chunk boundaries, the SSE/completion wire
// shapes, the capability-verdict ladder, and the wasm-pair selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import {
  ONDEVICE_MODELS,
  ONDEVICE_MAX_TOKENS,
  ONDEVICE_PROMPT_BUDGET_CHARS,
  ONDEVICE_TRACE_MAX,
  ONDEVICE_VALUE_PREFIX,
  onDeviceIdFromValue,
  onDeviceOptionValue,
  capabilityVerdict,
  clipMiddle,
  completionEnvelope,
  crashClass,
  crashDiag,
  crashMessage,
  heapUsedRatio,
  isMemoryPressureError,
  runBreadcrumb,
  trimForOnDevice,
  createSha256,
  createThinkFilter,
  debugFlagFrom,
  downloadProgress,
  downloadTotalBytes,
  errorEventDetail,
  fmtBytes,
  formatTraceLine,
  pushTrace,
  hfFileUrl,
  hfTreeUrl,
  onDeviceModel,
  onDeviceSummaryLine,
  opfsUnavailableMessage,
  planModelFiles,
  planReasonForStatus,
  PUBLISHED_CACHE_KEY,
  PUBLISHED_TTL_MS,
  declaredUnpublished,
  modelPublished,
  probeModelPublished,
  readPublishedCache,
  unpublishedNote,
  writePublishedCache,
  rejectionDetail,
  sseDeltaLine,
  sseDoneLine,
  wasmPathsFor,
  withDeadline,
  withJsonReminder,
} from "./ondevice-core.js";

// ---- catalog ---------------------------------------------------------------------

test("catalog: entries carry the fields the engine and UI need, 27B first", () => {
  assert.ok(ONDEVICE_MODELS.length >= 3);
  assert.equal(ONDEVICE_MODELS[0].id, "bonsai-27b-1bit"); // the headline entry
  for (const m of ONDEVICE_MODELS) {
    assert.match(m.repo, /^onnx-community\//);
    assert.ok(m.dtype && typeof m.dtype === "string");
    assert.ok(m.approxBytes > 0);
    assert.ok(m.label.includes("Bonsai"));
    assert.ok(m.minDeviceMemoryGb > 0);
  }
  assert.equal(onDeviceModel("bonsai-8b-1bit")?.repo, "onnx-community/Bonsai-8B-ONNX");
  assert.equal(onDeviceModel("nope"), null);
});

test("catalog: ids are distinct and dropdown-safe (no ::)", () => {
  const ids = ONDEVICE_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(!id.includes("::")); // "provider::model" split safety
});

// ---- the dropdown value convention -------------------------------------------------

test("option values round-trip for every catalog model", () => {
  for (const m of ONDEVICE_MODELS) {
    const value = onDeviceOptionValue(m.id);
    assert.ok(value.startsWith(ONDEVICE_VALUE_PREFIX));
    assert.equal(onDeviceIdFromValue(value), m.id);
  }
});

test("onDeviceIdFromValue rejects everything that is not a live on-device pick", () => {
  assert.equal(onDeviceIdFromValue("mistral-small"), null); // a server model id
  assert.equal(onDeviceIdFromValue(""), null);
  assert.equal(onDeviceIdFromValue(undefined), null);
  assert.equal(onDeviceIdFromValue(null), null);
  // Prefixed but unknown: a stale stored selection (a model since removed
  // from the catalog) must not route a send to a nonexistent engine model.
  assert.equal(onDeviceIdFromValue(ONDEVICE_VALUE_PREFIX + "bonsai-99b"), null);
  assert.equal(onDeviceIdFromValue(ONDEVICE_VALUE_PREFIX), null);
});

// ---- download plan ----------------------------------------------------------------

const TREE = [
  { path: "config.json", size: 2502 },
  { path: "generation_config.json", size: 290 },
  { path: "tokenizer.json", size: 9_117_036, lfs: { oid: "a".repeat(64) } },
  { path: "tokenizer_config.json", size: 4598 },
  { path: "chat_template.jinja", size: 4063 },
  { path: "onnx/model_q1f16.onnx", size: 359_361, lfs: { oid: "b".repeat(64) } },
  { path: "onnx/model_q1f16.onnx_data", size: 1_000_000, lfs: { oid: "c".repeat(64) } },
  { path: "onnx/model_q1f16.onnx_data_10", size: 500, lfs: { oid: "e".repeat(64) } },
  { path: "onnx/model_q1f16.onnx_data_2", size: 2_000_000, lfs: { oid: "d".repeat(64) } },
  { path: "onnx/model_q4.onnx", size: 999, lfs: { oid: "f".repeat(64) } },
  { path: "onnx/model_q4.onnx_data", size: 999, lfs: { oid: "0".repeat(64) } },
];

test("planModelFiles: side files + the dtype graph + its shards in numeric order, nothing else", () => {
  const files = planModelFiles(TREE, "q1f16");
  assert.ok(files);
  assert.deepEqual(
    files.map((f) => f.path),
    [
      "config.json",
      "generation_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "chat_template.jinja",
      "onnx/model_q1f16.onnx",
      "onnx/model_q1f16.onnx_data", // then numeric shard order — _2 before _10
      "onnx/model_q1f16.onnx_data_2",
      "onnx/model_q1f16.onnx_data_10",
    ],
  );
  // sha256 rides along from lfs.oid; non-LFS side files carry null
  assert.equal(files.find((f) => f.path === "config.json").sha256, null);
  assert.equal(files.find((f) => f.path === "onnx/model_q1f16.onnx").sha256, "b".repeat(64));
});

test("planModelFiles: an unpublished variant returns null (the 27B-today state)", () => {
  assert.equal(planModelFiles(TREE, "q1"), null);
  assert.equal(planModelFiles([], "q1f16"), null);
  assert.equal(planModelFiles(null, "q1f16"), null);
  assert.equal(planModelFiles(TREE, ""), null);
});

test("planReasonForStatus: HF 401/403/404 are 'unpublished', not 'network' (the Bonsai 27B trap)", () => {
  // HF returns 401 — not 404 — for a repo that doesn't exist yet or is gated,
  // so the unpublished onnx-community/Bonsai-27B-ONNX must read as unpublished.
  assert.equal(planReasonForStatus(401), "unpublished");
  assert.equal(planReasonForStatus(403), "unpublished");
  assert.equal(planReasonForStatus(404), "unpublished");
  // A transient server-side failure is the genuine network case.
  assert.equal(planReasonForStatus(429), "network");
  assert.equal(planReasonForStatus(500), "network");
  assert.equal(planReasonForStatus(503), "network");
});

test("planModelFiles: a malformed lfs oid is dropped, size defaults to 0", () => {
  const files = planModelFiles(
    [
      { path: "config.json" },
      { path: "onnx/model_q1.onnx", size: 10, lfs: { oid: "not-a-hash" } },
    ],
    "q1",
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].size, 0);
  assert.equal(files[1].sha256, null);
});

test("downloadTotalBytes + fmtBytes: the consent line's numbers", () => {
  const files = planModelFiles(TREE, "q1f16");
  const total = downloadTotalBytes(files);
  assert.equal(total, 2502 + 290 + 9_117_036 + 4598 + 4063 + 359_361 + 1_000_000 + 500 + 2_000_000);
  assert.equal(fmtBytes(3_900_000_000), "3.9 GB");
  assert.equal(fmtBytes(1_110_000_000), "1.1 GB");
  assert.equal(fmtBytes(278_000_000), "278 MB");
  assert.equal(fmtBytes(0), "0 B");
});

test("hf urls: tree + resolve, main revision", () => {
  assert.equal(hfTreeUrl("onnx-community/Bonsai-8B-ONNX"), "https://huggingface.co/api/models/onnx-community/Bonsai-8B-ONNX/tree/main?recursive=true");
  assert.equal(hfFileUrl("a/b", "onnx/model_q1.onnx"), "https://huggingface.co/a/b/resolve/main/onnx/model_q1.onnx");
});

// ---- progress ---------------------------------------------------------------------

test("downloadProgress: verified files count whole, the in-flight file partially", () => {
  const files = [
    { path: "a", size: 100 },
    { path: "b", size: 300 },
    { path: "c", size: 600 },
  ];
  assert.deepEqual(downloadProgress(files, {}), { loaded: 0, total: 1000, pct: 0 });
  assert.deepEqual(downloadProgress(files, { a: 100 }, { path: "b", loaded: 150 }), { loaded: 250, total: 1000, pct: 25 });
  // an over-reported in-flight count clamps to the file's size
  assert.deepEqual(downloadProgress(files, { a: 100, b: 300 }, { path: "c", loaded: 9999 }), { loaded: 1000, total: 1000, pct: 100 });
  assert.deepEqual(downloadProgress([], {}), { loaded: 0, total: 0, pct: 0 });
  // An explicit null current (the worker's between-files post) must not throw
  // — the live regression that killed the first verify download after file 1.
  assert.deepEqual(downloadProgress(files, { a: 100 }, null), { loaded: 100, total: 1000, pct: 10 });
});

// ---- streaming SHA-256 ---------------------------------------------------------------

test("createSha256 matches node:crypto across sizes and chunkings", () => {
  const cases = [
    new Uint8Array(0),
    new TextEncoder().encode("abc"),
    randomBytes(55), // one-byte-short-of-length-split boundary
    randomBytes(56), // padding spills into a second block
    randomBytes(64),
    randomBytes(65),
    randomBytes(1_000_003), // large, prime-ish
  ];
  for (const data of cases) {
    const expected = createHash("sha256").update(data).digest("hex");
    // whole-buffer
    assert.equal(createSha256().update(data).digestHex(), expected);
    // odd chunking
    const h = createSha256();
    for (let off = 0; off < data.length; off += 37) h.update(data.subarray(off, Math.min(off + 37, data.length)));
    assert.equal(h.digestHex(), expected);
  }
});

test("createSha256: known vector", () => {
  assert.equal(
    createSha256().update(new TextEncoder().encode("abc")).digestHex(),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

// ---- think filter ----------------------------------------------------------------------

test("think filter: drops a whole span, keeps surrounding text", () => {
  const f = createThinkFilter();
  const out = f.push("<think>step by step…</think>The answer is 4.") + f.finalize();
  assert.equal(out, "The answer is 4.");
});

test("think filter: tags split across arbitrary chunk boundaries", () => {
  const full = "<think>reasoning here</think>Hello <b>world</b>!";
  for (const n of [1, 2, 3, 5, 7]) {
    const f = createThinkFilter();
    let out = "";
    for (let i = 0; i < full.length; i += n) out += f.push(full.slice(i, i + n));
    out += f.finalize();
    assert.equal(out, "Hello <b>world</b>!", "chunk size " + n);
  }
});

test("think filter: an unterminated span drops to stream end; a dangling '<' is kept as text", () => {
  const f = createThinkFilter();
  assert.equal(f.push("<think>never closed…"), "");
  assert.equal(f.finalize(), "");
  const g = createThinkFilter();
  assert.equal(g.push("a < b and a <t"), "a < b and a "); // "<t" could open a tag — held
  assert.equal(g.finalize(), "<t"); // …but the stream ended: it was real text
});

test("think filter: multiple spans and text between them", () => {
  const f = createThinkFilter();
  const out = f.push("A<think>x</think>B<think>y</think>C") + f.finalize();
  assert.equal(out, "ABC");
});

// ---- wire shapes ---------------------------------------------------------------------

test("sse lines parse as the OpenAI delta wire readStream consumes", () => {
  const line = sseDeltaLine("hej");
  assert.ok(line.startsWith("data: ") && line.endsWith("\n\n"));
  const evt = JSON.parse(line.slice(6));
  assert.equal(evt.choices[0].delta.content, "hej");
  assert.equal(sseDoneLine(), "data: [DONE]\n\n");
  assert.equal(completionEnvelope("x").choices[0].message.content, "x");
});

test("withJsonReminder appends to the LAST user turn and never mutates input", () => {
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a" },
    { role: "user", content: "q2" },
  ];
  const out = withJsonReminder(msgs);
  assert.ok(out[3].content.startsWith("q2\n\nRespond ONLY with the JSON object"));
  assert.equal(msgs[3].content, "q2"); // input untouched
  assert.equal(out[1].content, "q1");
  // degenerate: no user turn → an appended one carries the instruction
  const none = withJsonReminder([{ role: "system", content: "s" }]);
  assert.equal(none.length, 2);
  assert.equal(none[1].role, "user");
});

// ---- capability verdict ----------------------------------------------------------------

test("capabilityVerdict ladder: no WebGPU → unsupported; low RAM/buffers → marginal; else ok", () => {
  const model = ONDEVICE_MODELS[0]; // 27B, wants 6 GB
  assert.equal(capabilityVerdict({ hasWebGpu: false }, model).verdict, "unsupported");
  assert.equal(capabilityVerdict({ hasWebGpu: true, deviceMemoryGb: 4 }, model).verdict, "marginal");
  assert.equal(capabilityVerdict({ hasWebGpu: true, deviceMemoryGb: 8 }, model).verdict, "ok");
  // unknown RAM (Safari/Firefox) is not a reason to block
  assert.equal(capabilityVerdict({ hasWebGpu: true, deviceMemoryGb: null }, model).verdict, "ok");
  assert.equal(capabilityVerdict({ hasWebGpu: true, maxBufferBytes: 256 * 1024 * 1024 }, model).verdict, "marginal");
  assert.equal(capabilityVerdict({ hasWebGpu: true, maxBufferBytes: 2 ** 31 }, model).verdict, "ok");
});

test("capabilityVerdict: a timed-out GPU probe is inconclusive — marginal (still downloadable), never a WebGPU denial", () => {
  const model = ONDEVICE_MODELS[0];
  const v = capabilityVerdict({ hasWebGpu: false, gpuTimedOut: true }, model);
  assert.equal(v.verdict, "marginal");
  assert.match(v.reason, /didn't answer the WebGPU probe/);
  // a plain "no" (no timeout flag) stays a hard unsupported
  assert.equal(capabilityVerdict({ hasWebGpu: false, gpuTimedOut: false }, model).verdict, "unsupported");
});

// ---- the never-hang deadline -------------------------------------------------------------

test("withDeadline: passes a settle through, and turns a silent stall into a stage-naming rejection", async () => {
  assert.equal(await withDeadline(Promise.resolve("ok"), 1000, "nope"), "ok");
  await assert.rejects(withDeadline(Promise.reject(new Error("real failure")), 1000, "nope"), /real failure/);
  await assert.rejects(
    withDeadline(new Promise(() => {}), 10, "the device check timed out"),
    /the device check timed out/,
  );
});

// ---- wasm pair -------------------------------------------------------------------------

test("wasmPathsFor always selects the WebGPU-capable asyncify build, on our vendor dir", () => {
  assert.deepEqual(wasmPathsFor(), {
    mjs: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
    wasm: "/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm",
  });
});

test("ONDEVICE_MAX_TOKENS is a phone-sane output cap", () => {
  assert.ok(ONDEVICE_MAX_TOKENS >= 512 && ONDEVICE_MAX_TOKENS <= 2048);
});

// ---- crash diagnostics -------------------------------------------------------------------

test("errorEventDetail: message + basename:line:col, every absent part omitted", () => {
  assert.equal(
    errorEventDetail({
      message: "RuntimeError: abort",
      filename: "https://x/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
      lineno: 12,
      colno: 34,
    }),
    "RuntimeError: abort (ort-wasm-simd-threaded.asyncify.mjs:12:34)",
  );
  assert.equal(errorEventDetail({ message: "Script error." }), "Script error.");
  assert.equal(errorEventDetail({ filename: "a/b.js", lineno: 5 }), "b.js:5"); // location alone still beats nothing
  assert.equal(errorEventDetail({ message: "x", lineno: 3 }), "x"); // a line number without a file is noise
  assert.equal(errorEventDetail({ message: "  " }), ""); // whitespace-only is not a message
  assert.equal(errorEventDetail({}), "");
  assert.equal(errorEventDetail(null), "");
  assert.equal(errorEventDetail(undefined), "");
});

test("rejectionDetail: Error, string, structured value (clamped), empty", () => {
  assert.equal(rejectionDetail(new Error("boom")), "boom");
  assert.equal(rejectionDetail(new Error("")), "Error"); // an empty-message Error still says what it is
  assert.equal(rejectionDetail("plain string reason"), "plain string reason");
  assert.equal(rejectionDetail({ code: 7 }), '{"code":7}');
  const long = rejectionDetail({ x: "y".repeat(500) });
  assert.ok(long.length <= 201 && long.endsWith("…")); // UI-verbatim message, not a log file
  assert.equal(rejectionDetail(undefined), "");
  assert.equal(rejectionDetail(null), "");
  const circular = /** @type {any} */ ({});
  circular.self = circular;
  assert.equal(rejectionDetail(circular), "[object Object]"); // unserializable falls through to String()
});

test("crashMessage: a never-spoke worker names the load failure and its remedy", () => {
  // Mid-run crash: the familiar message, detail appended when present.
  assert.equal(crashMessage(true, ""), "The on-device engine crashed.");
  assert.equal(crashMessage(true, "abort (ort.mjs:3:9)"), "The on-device engine crashed: abort (ort.mjs:3:9)");
  // Never-ran crash: self-explaining (script load / stale cache) — the case
  // a bare detail-free message left indistinguishable in the field.
  const never = crashMessage(false, "");
  assert.ok(never.includes("before it could start"));
  assert.ok(never.includes("stale cached copy"));
  assert.ok(never.endsWith("."));
  assert.ok(crashMessage(false, "SyntaxError").endsWith(": SyntaxError"));
});

test("formatTraceLine: elapsed prefix, string and structured parts, empties dropped", () => {
  assert.equal(formatTraceLine(12_340, ["←", "list", ""]), "+12.3s ← list");
  assert.equal(formatTraceLine(0, ["worker spawned"]), "+0.0s worker spawned");
  assert.equal(formatTraceLine(-5, ["x"]), "+0.0s x"); // clock skew can't produce a negative stamp
  assert.equal(formatTraceLine(500, ["probe", { hasWebGpu: true }]), '+0.5s probe {"hasWebGpu":true}');
});

test("pushTrace: capped ring keeps the newest lines", () => {
  const buf = [];
  for (let i = 0; i < ONDEVICE_TRACE_MAX + 10; i++) pushTrace(buf, "line " + i);
  assert.equal(buf.length, ONDEVICE_TRACE_MAX);
  assert.equal(buf[0], "line 10"); // oldest dropped
  assert.equal(buf[buf.length - 1], "line " + (ONDEVICE_TRACE_MAX + 9)); // the crash tail survives
  assert.deepEqual(pushTrace(["a"], "b", 2), ["a", "b"]); // returns the buffer
});

test("debugFlagFrom: the stored flag or the ?oddebug=1 param, default off", () => {
  assert.equal(debugFlagFrom("", null), false);
  assert.equal(debugFlagFrom("", "1"), true);
  assert.equal(debugFlagFrom("", "0"), false);
  assert.equal(debugFlagFrom("?oddebug=1", null), true);
  assert.equal(debugFlagFrom("?x=2&oddebug=1&y=3", null), true);
  assert.equal(debugFlagFrom("?oddebug=10", null), false); // exact value, not a prefix
  assert.equal(debugFlagFrom(undefined, undefined), false);
});

test("opfsUnavailableMessage: names OPFS, carries the underlying detail, points at Private tabs", () => {
  const bare = opfsUnavailableMessage(null);
  assert.ok(bare.includes("OPFS"));
  assert.ok(bare.includes("Private tab"));
  assert.ok(!bare.includes("()")); // no empty detail parens
  const detailed = opfsUnavailableMessage(new Error("The operation is not supported."));
  assert.ok(detailed.includes("(The operation is not supported.)"));
  assert.ok(detailed.includes("Private tab"));
  // A detail-less throw (e.g. a bare string rejection) degrades to the bare form.
  assert.equal(opfsUnavailableMessage({}), bare);
});

// ---- the phone-memory prompt budget (feedback #19) --------------------------------

test("trimForOnDevice: a list already inside the budget passes through untouched (same reference)", () => {
  const msgs = [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "what is 1-bit quantization?" },
  ];
  assert.equal(trimForOnDevice(msgs), msgs);
  assert.equal(trimForOnDevice([]).length, 0);
  assert.equal(trimForOnDevice(null).length, 0);
});

test("trimForOnDevice: a long history keeps system + the newest whole turns and stays inside the budget", () => {
  const big = "x".repeat(4_000);
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: "user", content: "q" + i + " " + big });
    msgs.push({ role: "assistant", content: "a" + i + " " + big });
  }
  msgs.push({ role: "user", content: "the live question" });
  const out = trimForOnDevice(msgs);
  const total = out.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= ONDEVICE_PROMPT_BUDGET_CHARS, "total " + total + " must fit the budget");
  // The anchors survive whole: the system prompt and the live question.
  assert.equal(out[0].content, "sys");
  assert.equal(out[out.length - 1].content, "the live question");
  // Recency wins: whatever history survives is the NEWEST turns, contiguous.
  const kept = out.slice(1, -1);
  for (const m of kept) assert.ok(!m.content.startsWith("q0") && !m.content.startsWith("a0"), "oldest turns must drop first");
  const idx = kept.map((m) => msgs.indexOf(m));
  for (let i = 1; i < idx.length; i++) assert.equal(idx[i], idx[i - 1] + 1, "kept turns stay contiguous");
});

test("trimForOnDevice: an oversized last message is clipped middle-out, head and tail preserved", () => {
  const head = "INSTRUCTIONS: answer as JSON. ";
  const tail = " Respond ONLY with the JSON object.";
  const last = head + "y".repeat(30_000) + tail;
  const out = trimForOnDevice([{ role: "user", content: last }]);
  assert.equal(out.length, 1);
  assert.ok(out[0].content.length <= ONDEVICE_PROMPT_BUDGET_CHARS);
  assert.ok(out[0].content.startsWith(head), "the head (leading instructions) survives");
  assert.ok(out[0].content.endsWith(tail), "the tail (trailing reminder) survives");
  assert.ok(out[0].content.includes("trimmed to fit this device's memory"), "the clip is visible, not silent");
  // The input message object is never mutated.
  assert.equal(last.length, head.length + 30_000 + tail.length);
});

test("trimForOnDevice: a huge system prompt keeps at most a quarter of the budget", () => {
  const msgs = [
    { role: "system", content: "s".repeat(50_000) },
    { role: "user", content: "q".repeat(50_000) },
  ];
  const out = trimForOnDevice(msgs);
  assert.ok(out[0].content.length <= Math.floor(ONDEVICE_PROMPT_BUDGET_CHARS / 4));
  const total = out.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= ONDEVICE_PROMPT_BUDGET_CHARS);
  // The question still gets the lion's share.
  assert.ok(out[1].content.length > out[0].content.length);
});

test("clipMiddle: under the cap is identity; over the cap is bounded with the marker", () => {
  assert.equal(clipMiddle("short", 100), "short");
  const clipped = clipMiddle("a".repeat(500) + "b".repeat(500), 200);
  assert.ok(clipped.length <= 200);
  assert.ok(clipped.startsWith("a"));
  assert.ok(clipped.endsWith("b"));
  // A cap too small for the marker still bounds the output.
  assert.ok(clipMiddle("abcdefghij", 3).length <= 3);
});

test("isMemoryPressureError: matches the wasm/GPU exhaustion signatures, not ordinary failures", () => {
  for (const m of [
    "Out of memory",
    "RuntimeError: memory access out of bounds",
    "Cannot enlarge memory arrays",
    "failed to allocate buffer",
    "Aborted(OOM)",
    "WebGPU device lost",
    "requested buffer size exceeds the max buffer size limit",
  ]) {
    assert.equal(isMemoryPressureError(m), true, m);
  }
  for (const m of ["HTTP 404 fetching onnx/model_q1.onnx", "checksum verification failed", "", undefined]) {
    assert.equal(isMemoryPressureError(m), false, String(m));
  }
});

test("crashMessage: a memory-looking detail carries the out-of-memory remedy; others stay unchanged", () => {
  const oom = crashMessage(true, "RuntimeError: memory access out of bounds (ort-wasm:1:2)");
  assert.ok(oom.includes("ran out of memory"));
  assert.ok(oom.includes("New chat"));
  const plain = crashMessage(true, "Script error.");
  assert.ok(!plain.includes("ran out of memory"));
});

// ---- the crash breadcrumb (feedback #26 — the tab that dies mid-run) ---------

test("crashClass sorts a failure into the three classes worth counting", () => {
  assert.equal(crashClass("Cannot enlarge memory arrays"), "oom");
  assert.equal(crashClass("oom"), "oom", "an already-classified value round-trips");
  assert.equal(crashClass("This swarm member timed out on this device."), "timeout");
  assert.equal(crashClass("timeout"), "timeout");
  assert.equal(crashClass("Script error."), "crash");
  assert.equal(crashClass(""), "");
  assert.equal(crashClass(undefined), "");
});

test("runBreadcrumb bounds every field and carries counters ONLY", () => {
  const b = runBreadcrumb({
    startedAt: 1_700_000_000_000,
    kind: "swarm",
    nodes: 99,
    members: 999,
    concurrency: 99,
    rounds: 99,
    round: 2,
    phase: "diverge",
    modelMb: 1200,
    cls: "Cannot enlarge memory arrays",
  });
  assert.deepEqual(b, {
    v: 1,
    t: 1_700_000_000_000,
    kind: "swarm",
    nodes: 16,
    members: 32,
    conc: 16,
    rounds: 8,
    round: 2,
    phase: "diverge",
    mb: 1200,
    cls: "oom",
  });
  // Nothing derived from a conversation can enter the record: unknown fields
  // are dropped, and an out-of-vocabulary phase falls back.
  const junk = runBreadcrumb({ phase: "the user asked about X", task: "secret", id: "climate-critic" });
  assert.equal(junk.phase, "start");
  assert.equal(junk.task, undefined);
  assert.equal(junk.id, undefined);
  // A stored record re-normalizes through the same function (short keys).
  assert.deepEqual(runBreadcrumb(b), b);
});

test("crashDiag reports an unfinished run, a survived-but-pressured one, and nothing else", () => {
  const now = 1_700_000_100_000;
  const base = { t: now - 30_000, kind: "swarm", nodes: 1, members: 6, conc: 4, rounds: 2, round: 2, mb: 1200 };
  const died = crashDiag({ ...base, phase: "diverge", cls: "" }, now);
  assert.equal(died.died, 1);
  assert.equal(died.phase, "diverge");
  assert.equal(died.ago, 30);
  const survived = crashDiag({ ...base, phase: "done", cls: "oom" }, now);
  assert.equal(survived.died, 0, "it finished — the class is still worth reporting");
  assert.equal(survived.cls, "oom");
  assert.equal(crashDiag({ ...base, phase: "done", cls: "" }, now), undefined, "a clean run reports nothing");
  assert.equal(crashDiag(null, now), undefined);
  assert.equal(crashDiag({ ...base, t: now - 8 * 86_400_000, phase: "diverge" }, now), undefined, "stale crumbs are dropped");
});

test("heapUsedRatio reports a fill only where the browser measures one", () => {
  assert.equal(heapUsedRatio({ usedJSHeapSize: 900, jsHeapSizeLimit: 1000 }), 0.9);
  assert.equal(heapUsedRatio(undefined), null, "Safari/Firefox report nothing — unknown, never 'fine'");
  assert.equal(heapUsedRatio({ usedJSHeapSize: 5, jsHeapSizeLimit: 0 }), null);
  assert.equal(heapUsedRatio({ usedJSHeapSize: 2000, jsHeapSizeLimit: 1000 }), 1, "clamped");
});

// ---- the collapsed settings disclosure (UX-13, feedback #27) ------------------

test("onDeviceSummaryLine: the counts state how many models are actually here", () => {
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 0 }), "Models — none on this device yet, 3 available");
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 1 }), "Models — 1 of 3 on this device");
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 3 }), "Models — 3 of 3 on this device");
});

test("onDeviceSummaryLine: 'available' counts only what this device can run", () => {
  // The expanded rows say "this browser has no WebGPU" — the folded line must
  // not advertise three downloads the user can't use.
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 0, unsupported: 3 }), "Models — none can run on this device");
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 0, unsupported: 2 }), "Models — none on this device yet, 1 available");
  // Weights already here outrank the verdict: they ran once, they're the fact.
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 1, unsupported: 3 }), "Models — 1 of 3 on this device");
});

test("onDeviceSummaryLine: a download in flight outranks the counts, and carries its percent", () => {
  // The whole point of the fold is that the rows are hidden — a running
  // download must still be visible on the one line that remains.
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 1, downloading: "Bonsai 8B · 1-bit", pct: 42 }), "Downloading Bonsai 8B · 1-bit… · 42%");
  assert.equal(onDeviceSummaryLine({ total: 3, downloading: "Bonsai 8B · 1-bit" }), "Downloading Bonsai 8B · 1-bit…");
  // A percent arriving as a float or over 100 never renders nonsense.
  assert.equal(onDeviceSummaryLine({ downloading: "X", pct: 99.7 }), "Downloading X… · 99%");
  assert.equal(onDeviceSummaryLine({ downloading: "X", pct: 140 }), "Downloading X… · 100%");
});

test("onDeviceSummaryLine: probe states and failed downloads surface on the folded line", () => {
  assert.equal(onDeviceSummaryLine({ total: 3, checking: true }), "Models — checking this device…");
  assert.equal(onDeviceSummaryLine({ total: 3, error: true }), "Models — this device couldn't be checked");
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 1, failed: 1 }), "Models — 1 of 3 on this device · 1 download failed");
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 0, failed: 2 }), "Models — none on this device yet, 3 available · 2 downloads failed");
});

test("onDeviceSummaryLine: degenerate input still yields a sane line", () => {
  assert.equal(onDeviceSummaryLine(), "Models");
  assert.equal(onDeviceSummaryLine({}), "Models");
  // A cached count above the catalog size (a stale entry) can't read "4 of 3".
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 9 }), "Models — 3 of 3 on this device");
  assert.equal(onDeviceSummaryLine({ total: -1, cached: -2 }), "Models");});


// ---- browser-build availability (feedback #36) ------------------------------
//
// "The 27b model doesn't run in browser so gray it out in the gui so we can't
// select it." The row's state now comes from the catalog's declaration first
// and this device's live probe second — the pair is what lets an entry be
// grayed out today AND light up on its own the day the conversion ships.

test("the 27B entry declares its browser build unpublished; the shipped ones do not", () => {
  const by = (/** @type {string} */ id) => ONDEVICE_MODELS.find((m) => m.id === id);
  assert.equal(declaredUnpublished(by("bonsai-27b-1bit")), true);
  assert.equal(declaredUnpublished(by("bonsai-8b-1bit")), false);
  assert.equal(declaredUnpublished(by("bonsai-1_7b-1bit")), false);
  // A row with no declaration at all is available — the flag is opt-in, so a
  // new catalog entry can never be grayed out by omission.
  assert.equal(declaredUnpublished({}), false);
});

test("modelPublished: the declaration decides until this device has probed", () => {
  const m27 = { id: "bonsai-27b-1bit", browserBuild: "unpublished" };
  const m8 = { id: "bonsai-8b-1bit" };
  assert.equal(modelPublished(m27), false);
  assert.equal(modelPublished(m8), true);
  // A probe result OVERRIDES the declaration in BOTH directions: the row must
  // light up when the conversion ships, and must gray out when a repo that
  // used to serve it stops.
  assert.equal(modelPublished(m27, { "bonsai-27b-1bit": true }), true);
  assert.equal(modelPublished(m8, { "bonsai-8b-1bit": false }), false);
  // Another model's answer never leaks across.
  assert.equal(modelPublished(m27, { "bonsai-8b-1bit": true }), false);
});

test("the published cache expires, and survives garbage without throwing", () => {
  const now = 1_800_000_000_000;
  const fresh = JSON.stringify({ a: { published: true, at: now - 1000 } });
  assert.deepEqual(readPublishedCache(fresh, now), { a: true });
  // Past the TTL the answer is forgotten, so the row re-probes rather than
  // trusting a day-old "unpublished" forever.
  const stale = JSON.stringify({ a: { published: true, at: now - PUBLISHED_TTL_MS - 1 } });
  assert.deepEqual(readPublishedCache(stale, now), {});
  // A timestamp in the future means the clock moved — distrust it.
  assert.deepEqual(readPublishedCache(JSON.stringify({ a: { published: true, at: now + 60_000 } }), now), {});
  for (const junk of [null, "", "{", "[]", '{"a":1}', '{"a":{"published":"yes","at":1}}']) {
    assert.deepEqual(readPublishedCache(junk, now), {}, `junk: ${junk}`);
  }
});

test("writePublishedCache records one answer and drops the stale ones on the way", () => {
  const now = 1_800_000_000_000;
  const prior = JSON.stringify({
    keep: { published: false, at: now - 1000 },
    drop: { published: true, at: now - PUBLISHED_TTL_MS - 1 },
  });
  const next = writePublishedCache(prior, "new", true, now);
  assert.deepEqual(readPublishedCache(next, now), { keep: false, new: true });
  // Re-recording replaces rather than appends, so the key can't outgrow the catalog.
  assert.deepEqual(readPublishedCache(writePublishedCache(next, "new", false, now), now), { keep: false, new: false });
  assert.equal(typeof PUBLISHED_CACHE_KEY, "string");
});

test("probeModelPublished: only a definite answer moves the row", async () => {
  const model = { repo: "onnx-community/Bonsai-27B-ONNX", dtype: "q1f16" };
  const tree = [
    { path: "config.json", size: 1 },
    { path: "onnx/model_q1f16.onnx", size: 2 },
  ];
  const ok = async () => ({ ok: true, status: 200, json: async () => tree });
  assert.equal(await probeModelPublished(model, ok), true);
  // The variant missing from an existing repo is the "conversion not shipped"
  // state — the exact case the 27B is in.
  const other = async () => ({ ok: true, status: 200, json: async () => [{ path: "onnx/model_q4.onnx", size: 2 }] });
  assert.equal(await probeModelPublished(model, other), false);
  // HF answers 401 for a repo that doesn't exist (it refuses to leak which) —
  // the Bonsai 27B trap planReasonForStatus was written for.
  for (const status of [401, 403, 404]) {
    assert.equal(await probeModelPublished(model, async () => ({ ok: false, status })), false, `status ${status}`);
  }
  // Everything inconclusive returns null: an offline phone must never
  // "discover" that a model shipped, nor claim one vanished.
  for (const status of [429, 500, 503]) {
    assert.equal(await probeModelPublished(model, async () => ({ ok: false, status })), null, `status ${status}`);
  }
  assert.equal(await probeModelPublished(model, async () => { throw new Error("offline"); }), null);
  assert.equal(await probeModelPublished(model, async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })), null);
  assert.equal(await probeModelPublished({ repo: "", dtype: "" }, ok), null);
});

test("unpublishedNote names the model and promises the entry lights up on its own", () => {
  const note = unpublishedNote({ label: "Bonsai 27B · 1-bit" });
  assert.match(note, /Bonsai 27B · 1-bit/);
  assert.match(note, /isn't published yet/);
  // The consent card appends "Nothing was downloaded." — the ROW must not,
  // since nothing was ever tapped there.
  assert.doesNotMatch(note, /Nothing was downloaded/);
});

test("onDeviceSummaryLine: a grayed-out model is not counted as available", () => {
  // The folded line may not advertise a download that doesn't exist upstream —
  // same rule the unsupported count already followed.
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 0, unavailable: 1 }), "Models — none on this device yet, 2 available");
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 0, unavailable: 1, unsupported: 2 }), "Models — none can run on this device");
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 0, unavailable: 3 }), "Models — none can run on this device");
  // Weights already here still outrank every verdict.
  assert.equal(onDeviceSummaryLine({ total: 3, cached: 1, unavailable: 1 }), "Models — 1 of 3 on this device");
});
