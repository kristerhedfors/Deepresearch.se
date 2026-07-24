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
  ONDEVICE_TRACE_MAX,
  ONDEVICE_VALUE_PREFIX,
  onDeviceIdFromValue,
  onDeviceOptionValue,
  capabilityVerdict,
  completionEnvelope,
  crashMessage,
  isMemoryError,
  withOomAdvice,
  OOM_ADVICE,
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
  opfsUnavailableMessage,
  planModelFiles,
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

// Feedback #19: chatting with Bonsai 1.7B/8B crashed with a memory-exhaustion
// warning — the recognizers below drive the worker's dispose-and-advise
// recovery, so the signature list is load-bearing.
test("isMemoryError: recognizes the field memory/device-lost signatures, not ordinary errors", () => {
  for (const s of [
    "RuntimeError: memory access out of bounds",
    "Out of memory",
    "Aborted(OOM)",
    "Memory exhaustion while growing memory",
    "failed to allocate GPU buffer",
    "Cannot allocate WasmMemory",
    "GPUDevice was lost",
  ]) {
    assert.equal(isMemoryError(s), true, `should match: ${s}`);
  }
  for (const s of ["Couldn't reach huggingface.co", "checksum mismatch for onnx/model_q1.onnx", "Aborted.", ""]) {
    assert.equal(isMemoryError(s), false, `should NOT match: ${s}`);
  }
});

test("withOomAdvice: appends the remedy once to memory errors, passes others through", () => {
  const oom = withOomAdvice("RuntimeError: memory access out of bounds");
  assert.ok(oom.includes(OOM_ADVICE));
  assert.equal(withOomAdvice(oom), oom); // idempotent — never stacks
  const plain = "Couldn't reach huggingface.co — check the connection and try again.";
  assert.equal(withOomAdvice(plain), plain);
});

test("crashMessage: a memory-signature crash detail carries the out-of-memory remedy", () => {
  const m = crashMessage(true, "RuntimeError: memory access out of bounds (ort.mjs:3:9)");
  assert.ok(m.includes("The on-device engine crashed"));
  assert.ok(m.includes(OOM_ADVICE));
  // Non-memory details stay exactly as before.
  assert.equal(crashMessage(true, "SyntaxError"), "The on-device engine crashed: SyntaxError");
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
