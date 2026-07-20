// The on-device inference WEB WORKER (browser-only glue, like sandbox.js —
// deliberately not Node-testable; the pure logic lives in ondevice-core.js).
// Runs the VENDORED transformers.js (WebGPU) over Bonsai weights cached in
// OPFS, plus the download manager itself — fetch → streaming SHA-256 →
// OPFS write happens here, off the UI thread (and OPFS sync access lives in
// workers anyway). Spawned lazily by ondevice-engine.js: a page where the
// knob is off never fetches this file or anything it imports.
//
// Protocol (all messages carry `t`):
//   in:  plan{modelId} · download{modelId} · canceldl{modelId} · delete{modelId}
//        · list{} · generate{id, modelId, messages, maxTokens, json} · abort{id}
//        · debug{on}
//   out: plan{modelId, published, files?, totalBytes?} · progress{modelId, pct,
//        loaded, total} · downloaded{modelId} · dlerror{modelId, message}
//        · deleted{modelId} · list{entries} · loadstatus{modelId, status}
//        · token{id, text} · gendone{id, text} · generror{id, message}
//        · workererror{message} · workerdiag{message}

import {
  ONDEVICE_MODELS,
  completionEnvelope,
  createSha256,
  createThinkFilter,
  debugFlagFrom,
  downloadProgress,
  errorEventDetail,
  hfFileUrl,
  hfTreeUrl,
  onDeviceModel,
  opfsUnavailableMessage,
  planModelFiles,
  rejectionDetail,
  wasmPathsFor,
  withJsonReminder,
} from "/js/ondevice-core.js";

const MODELS_DIR = "ondevice-models";

// ---- verbose debug + the uncaught-error surface -----------------------------------

// A worker can't read localStorage — the engine forwards dr_ondevice_debug
// via the spawn URL (?oddebug=1) and flips it live with {t:"debug"}.
let debug = false;
try {
  debug = debugFlagFrom(self.location.search, null);
} catch {
  /* location unavailable */
}

/** @param {...unknown} args */
function dbg(...args) {
  if (debug) console.info("[ondevice-worker]", ...args);
}

// Uncaught errors in this scope — including ones that propagate up from the
// NESTED pthread workers ort-wasm-simd-threaded spawns — bypass the dispatch
// try/catch below, and the copy the main thread's worker.onerror receives is
// often degraded ("Script error.", no location). Ship the full detail ahead
// of it (workerdiag), and do NOT preventDefault(): the event must still
// propagate so the engine keeps its crash semantics (fail every pending
// call, respawn on next use).
self.addEventListener("error", (e) => {
  console.error("[ondevice-worker] uncaught error:", e);
  try {
    self.postMessage({ t: "workerdiag", message: errorEventDetail(e) });
  } catch {
    /* posting must never throw out of an error handler */
  }
});

// Unhandled REJECTIONS never propagate to the parent at all — before this
// listener a stray async failure inside the runtime was fully silent, and
// every pending call just hung to its deadline. Fail them with the real
// reason instead (the worker itself stays alive; the next call retries).
self.addEventListener("unhandledrejection", (e) => {
  console.error("[ondevice-worker] unhandled rejection:", e?.reason);
  const detail = rejectionDetail(e?.reason);
  try {
    self.postMessage({ t: "workererror", message: "The on-device engine failed" + (detail ? ": " + detail : ".") });
  } catch {
    /* posting must never throw out of an error handler */
  }
});

// ---- OPFS helpers -----------------------------------------------------------------

async function modelDir(modelId, create = false) {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(MODELS_DIR, { create });
  return base.getDirectoryHandle(modelId, { create });
}

// Weight paths nest ("onnx/model_q1.onnx") — walk/create the directory chain.
async function fileHandle(dir, path, create = false) {
  const parts = path.split("/");
  let d = dir;
  for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create });
  return d.getFileHandle(parts[parts.length - 1], { create });
}

async function readJson(dir, name) {
  try {
    const fh = await fileHandle(dir, name);
    return JSON.parse(await (await fh.getFile()).text());
  } catch {
    return null;
  }
}

async function writeJson(dir, name, value) {
  const fh = await fileHandle(dir, name, true);
  const w = await openWrite(fh, false);
  await w.write(0, new TextEncoder().encode(JSON.stringify(value)));
  await w.close();
}

// The OPFS write seam: Chromium writes through createWritable() (a swap-file
// stream committed on close), but WebKit — iOS Safari included — has shipped
// OPFS since 16.4 WITHOUT FileSystemWritableFileStream, so there the write
// path is createSyncAccessHandle(), which is worker-only — and this IS the
// worker. Sync-handle writes land in place (no swap file), which suits the
// resume-from-partial design even better: verified bytes are on disk however
// the write ends. Every handle call is awaited, so the older WebKit
// generation (15.2–16.3) whose handle methods were async works too. Found
// 2026-07-17: the iPhone "confirm → brief flicker, nothing downloads" report
// — createWritable was assumed, and its absence failed the download in under
// a second.
async function openWrite(fh, keepExistingData) {
  if (typeof fh.createWritable === "function") {
    const w = await fh.createWritable({ keepExistingData });
    return {
      write: (position, data) => w.write({ type: "write", position, data }),
      close: () => w.close(),
    };
  }
  if (typeof fh.createSyncAccessHandle === "function") {
    const h = await fh.createSyncAccessHandle();
    if (!keepExistingData) await h.truncate(0);
    return {
      write: async (position, data) => {
        // write() reports bytes written — loop the (rare) short write rather
        // than silently corrupt the file and fail checksum later.
        let off = 0;
        while (off < data.byteLength) {
          const n = await h.write(off ? data.subarray(off) : data, { at: position + off });
          if (!(n > 0)) throw new Error("OPFS write made no progress at byte " + (position + off));
          off += n;
        }
      },
      close: async () => {
        await h.flush();
        await h.close();
      },
    };
  }
  throw new Error("This browser has no OPFS write API (neither createWritable nor createSyncAccessHandle) — model downloads can't be stored here.");
}

// The post-download manifest is the "this model is complete and verified"
// marker — list/load trust it instead of re-hashing gigabytes at startup.
const MANIFEST = "manifest.json";

// ---- list / delete ------------------------------------------------------------------

async function listEntries() {
  const entries = [];
  for (const m of ONDEVICE_MODELS) {
    let cachedBytes = null;
    try {
      const dir = await modelDir(m.id);
      const manifest = await readJson(dir, MANIFEST);
      if (manifest?.totalBytes > 0) cachedBytes = manifest.totalBytes;
    } catch {
      // no dir — not downloaded
    }
    entries.push({ id: m.id, cachedBytes });
  }
  return entries;
}

async function deleteModel(modelId) {
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(MODELS_DIR);
    await base.removeEntry(modelId, { recursive: true });
  } catch {
    // already gone — deletion is idempotent
  }
}

// ---- download manager ----------------------------------------------------------------

const dlAborts = new Map(); // modelId → AbortController

// Plan result: {files} on success, or {reason: "unpublished"|"network"} —
// the two failure kinds NEED different messages: "not published yet" is a
// statement about the model, "couldn't reach huggingface.co" is a statement
// about the connection, and telling a user the wrong one sends them away
// from a working feature (found in the first headless verify run: a blocked
// fetch read as "isn't published").
async function planFor(model) {
  let res;
  try {
    res = await fetch(hfTreeUrl(model.repo));
  } catch {
    return { reason: "network" };
  }
  if (!res.ok) return { reason: res.status === 404 ? "unpublished" : "network" };
  try {
    const files = planModelFiles(await res.json(), model.dtype);
    return files ? { files } : { reason: "unpublished" }; // repo exists, variant doesn't
  } catch {
    return { reason: "network" };
  }
}

// One file: resume from whatever OPFS already holds (re-hash the partial
// bytes first so the streaming SHA-256 still covers the whole file), fetch
// the remainder with a Range request, verify against the tree's LFS sha256
// when it has one (plus the size always), and only then mark it done in the
// manifest bookkeeping. TLS protects the transport; the hash protects
// against truncation, a force-pushed repo mid-download, and cache rot.
async function downloadFile(dir, model, file, signal, onLoaded) {
  const fh = await fileHandle(dir, file.path, true);
  const existing = await fh.getFile();
  let offset = existing.size > 0 && existing.size <= file.size ? existing.size : 0;
  const hasher = createSha256();
  if (offset > 0) {
    const reader = existing.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
    onLoaded(offset);
  }
  if (offset < file.size || file.size === 0) {
    const res = await fetch(hfFileUrl(model.repo, file.path), {
      signal,
      headers: offset > 0 ? { range: "bytes=" + offset + "-" } : {},
    });
    if (!res.ok || (offset > 0 && res.status !== 206)) {
      // A 200 to a range request means the server ignored it — restart clean
      // rather than corrupt the file with an appended full copy.
      if (res.ok && offset > 0) {
        await dir.removeEntry(file.path.split("/").pop(), { recursive: false }).catch(() => {});
        throw new Error("resume not honored for " + file.path + " — retry the download");
      }
      throw new Error("HTTP " + res.status + " fetching " + file.path);
    }
    const writable = await openWrite(fh, offset > 0);
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
        await writable.write(offset, value);
        offset += value.length;
        onLoaded(offset);
      }
      await writable.close();
    } catch (err) {
      // Keep the partial bytes for resume; abort() would discard them.
      await Promise.resolve()
        .then(() => writable.close())
        .catch(() => {});
      throw err;
    }
  }
  const finalSize = (await fh.getFile()).size;
  if (finalSize !== file.size) throw new Error(file.path + " is " + finalSize + " bytes, expected " + file.size);
  const digest = hasher.digestHex();
  if (file.sha256 && digest !== file.sha256) {
    // A corrupt file must not survive to poison the next resume.
    await dir.removeEntry(file.path.split("/").pop()).catch(() => {});
    throw new Error(file.path + " failed checksum verification — try the download again");
  }
}

async function download(modelId) {
  const model = onDeviceModel(modelId);
  if (!model) throw new Error("Unknown model " + modelId);
  // Storage FIRST, network second: WebKit Private Browsing rejects
  // getDirectory() outright, and a browser without OPFS never gets it —
  // both must fail with the named message instantly, not after a fetch.
  let dir;
  try {
    if (typeof navigator.storage?.getDirectory !== "function") throw new Error("navigator.storage.getDirectory is missing");
    dir = await modelDir(modelId, true);
  } catch (err) {
    throw new Error(opfsUnavailableMessage(err));
  }
  const plan = await planFor(model);
  const files = plan.files;
  if (!files) {
    throw new Error(
      plan.reason === "unpublished"
        ? "The " + model.label + " browser build isn't published yet."
        : "Couldn't reach huggingface.co — check the connection and try again.",
    );
  }
  const ctrl = new AbortController();
  dlAborts.set(modelId, ctrl);
  try {
    const done = {};
    let lastPost = 0;
    const post = (current) => {
      const now = Date.now();
      if (now - lastPost < 150 && current) return; // throttle the progress spam
      lastPost = now;
      const p = downloadProgress(files, done, current);
      self.postMessage({ t: "progress", modelId, ...p });
    };
    for (const file of files) {
      if (ctrl.signal.aborted) throw new Error("cancelled");
      await downloadFile(dir, model, file, ctrl.signal, (loaded) => post({ path: file.path, loaded }));
      done[file.path] = file.size;
      lastPost = 0;
      post(null);
    }
    await writeJson(dir, MANIFEST, {
      repo: model.repo,
      dtype: model.dtype,
      files: files.map((f) => ({ path: f.path, size: f.size })),
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      downloadedAt: Date.now(),
    });
    self.postMessage({ t: "downloaded", modelId });
  } finally {
    dlAborts.delete(modelId);
  }
}

// ---- the inference engine ---------------------------------------------------------------

let tf = null; // the vendored transformers.js module, imported on first load
let loaded = null; // { modelId, tokenizer, model }
let loadingPromise = null;
const stoppers = new Map(); // generate id → InterruptableStoppingCriteria

async function importRuntime() {
  if (tf) return tf;
  // The SELF-CONTAINED dist bundle (transformers.min.js), NOT the
  // bundler-oriented transformers.web.min.js: the web build externalizes
  // onnxruntime as BARE import specifiers ("onnxruntime-web/webgpu"), which
  // cannot resolve inside a worker — import maps apply to documents only —
  // so importing it threw "Failed to resolve module specifier" on every
  // engine (found 2026-07-17, the first time generate was driven end to
  // end). The full bundle inlines the ort JS API and fetches the SAME four
  // vendored wasm-loader files via wasmPaths below.
  tf = await import("/vendor/transformers/transformers.min.js");
  const env = tf.env;
  env.allowLocalModels = false;
  env.useBrowserCache = false; // ONE disclosed storage location: our OPFS cache below
  env.useCustomCache = true;
  env.customCache = opfsCache;
  // The vendored wasm pair (invariant 7 — never the CDN default) — always
  // the WebGPU-capable asyncify build, since every load below requests
  // device:"webgpu".
  env.backends.onnx.wasm.wasmPaths = wasmPathsFor();
  return tf;
}

// transformers.js resolves every model file to a huggingface.co /resolve/
// URL; this cache maps those URLs onto the verified OPFS copies, so a load
// never touches the network for bytes the download manager already owns.
const opfsCache = {
  async match(request) {
    const url = String(request?.url || request);
    const m = url.match(/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/);
    if (!m) return undefined;
    const model = ONDEVICE_MODELS.find((x) => x.repo === m[1]);
    if (!model) return undefined;
    try {
      const dir = await modelDir(model.id);
      const fh = await fileHandle(dir, decodeURIComponent(m[2]));
      const file = await fh.getFile();
      return new Response(file, { status: 200 });
    } catch {
      return undefined; // not cached — transformers falls back to fetch
    }
  },
  async put() {
    // Everything a load needs was pre-downloaded and verified; incidental
    // extras (a HEAD probe, a redirect body) aren't worth persisting.
  },
};

async function ensureLoaded(modelId) {
  if (loaded?.modelId === modelId) return loaded;
  if (loadingPromise) await loadingPromise.catch(() => {});
  if (loaded?.modelId === modelId) return loaded;
  const model = onDeviceModel(modelId);
  if (!model) throw new Error("Unknown model " + modelId);
  loadingPromise = (async () => {
    const t0 = Date.now();
    const { AutoTokenizer, AutoModelForCausalLM } = await importRuntime();
    self.postMessage({ t: "loadstatus", modelId, status: "Loading tokenizer…" });
    const tokenizer = await AutoTokenizer.from_pretrained(model.repo);
    self.postMessage({ t: "loadstatus", modelId, status: "Compiling the model on this device's GPU…" });
    const lm = await AutoModelForCausalLM.from_pretrained(model.repo, {
      dtype: model.dtype,
      device: "webgpu",
    });
    loaded = { modelId, tokenizer, model: lm };
    dbg("model loaded:", modelId, "in", Date.now() - t0, "ms");
    return loaded;
  })();
  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

async function generate({ id, modelId, messages, maxTokens, json }) {
  const { InterruptableStoppingCriteria, TextStreamer } = await importRuntime();
  const { tokenizer, model } = await ensureLoaded(modelId);
  const msgs = json ? withJsonReminder(messages) : messages;
  const inputs = tokenizer.apply_chat_template(msgs, {
    add_generation_prompt: true,
    return_dict: true,
    // Bonsai inherits Qwen's reasoning switch; the think filter below still
    // guards the models whose template ignores this.
    enable_thinking: false,
  });
  const filter = createThinkFilter();
  let text = "";
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (piece) => {
      const clean = filter.push(piece);
      if (clean) {
        text += clean;
        self.postMessage({ t: "token", id, text: clean });
      }
    },
  });
  const stopper = new InterruptableStoppingCriteria();
  stoppers.set(id, stopper);
  try {
    await model.generate({
      ...inputs,
      max_new_tokens: maxTokens,
      do_sample: false,
      streamer,
      stopping_criteria: stopper,
    });
    const tail = filter.finalize();
    if (tail) {
      text += tail;
      self.postMessage({ t: "token", id, text: tail });
    }
    self.postMessage({ t: "gendone", id, text });
  } finally {
    stoppers.delete(id);
  }
}

// ---- dispatch -----------------------------------------------------------------------------

self.onmessage = async (e) => {
  const msg = e.data || {};
  dbg("←", msg.t, msg.modelId ?? msg.id ?? "");
  try {
    if (msg.t === "debug") {
      debug = !!msg.on;
    } else if (msg.t === "list") {
      self.postMessage({ t: "list", entries: await listEntries() });
    } else if (msg.t === "plan") {
      const model = onDeviceModel(msg.modelId);
      const plan = model ? await planFor(model).catch(() => ({ reason: "network" })) : { reason: "unpublished" };
      self.postMessage({
        t: "plan",
        modelId: msg.modelId,
        published: !!plan.files,
        reason: plan.reason || null,
        totalBytes: plan.files ? plan.files.reduce((n, f) => n + f.size, 0) : null,
      });
    } else if (msg.t === "download") {
      await download(msg.modelId).catch((err) => {
        self.postMessage({ t: "dlerror", modelId: msg.modelId, message: err?.message || String(err) });
      });
    } else if (msg.t === "canceldl") {
      dlAborts.get(msg.modelId)?.abort();
    } else if (msg.t === "delete") {
      if (loaded?.modelId === msg.modelId) loaded = null; // a deleted model must not serve from memory
      await deleteModel(msg.modelId);
      self.postMessage({ t: "deleted", modelId: msg.modelId });
    } else if (msg.t === "generate") {
      await generate(msg).catch((err) => {
        self.postMessage({ t: "generror", id: msg.id, message: err?.message || String(err) });
      });
    } else if (msg.t === "abort") {
      stoppers.get(msg.id)?.interrupt();
    }
  } catch (err) {
    // A dispatch-level failure must never kill the worker silently.
    self.postMessage({ t: "workererror", message: err?.message || String(err) });
  }
};
