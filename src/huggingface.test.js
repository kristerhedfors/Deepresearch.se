import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractHfRepos,
  messageNamesHfRepo,
  hfAvailable,
  lookupRepo,
  runHuggingFaceLookup,
} from "./huggingface.js";

const ids = (arr) => arr.map((r) => r.id);

describe("extractHfRepos — Hub URLs (unambiguous, no cue needed)", () => {
  test("a model URL", () => {
    const out = extractHfRepos("see https://huggingface.co/meta-llama/Llama-3-8B-Instruct");
    assert.deepEqual(out, [{ id: "meta-llama/Llama-3-8B-Instruct", kind: "model" }]);
  });

  test("a dataset URL", () => {
    const out = extractHfRepos("the data is at huggingface.co/datasets/HuggingFaceH4/ultrachat_200k");
    assert.deepEqual(out, [{ id: "HuggingFaceH4/ultrachat_200k", kind: "dataset" }]);
  });

  test("a canonical single-name model URL", () => {
    assert.deepEqual(extractHfRepos("compare it to https://huggingface.co/gpt2"), [
      { id: "gpt2", kind: "model" },
    ]);
  });

  test("hf.co short host", () => {
    assert.deepEqual(ids(extractHfRepos("hf.co/google/gemma-2-9b")), ["google/gemma-2-9b"]);
  });

  test("a Spaces URL is ignored (not a model/dataset)", () => {
    assert.deepEqual(extractHfRepos("https://huggingface.co/spaces/huggingface/openapi"), []);
  });

  test("a docs URL is not mistaken for a repo", () => {
    assert.deepEqual(extractHfRepos("https://huggingface.co/docs/hub/api"), []);
  });
});

describe("extractHfRepos — bare owner/name with an HF/ML cue", () => {
  test("strong cue accepts a lowercase repo", () => {
    assert.deepEqual(extractHfRepos("what's the license of google/gemma on Hugging Face?"), [
      { id: "google/gemma", kind: "unknown" },
    ]);
  });

  test("weak 'model' cue accepts a repo-ish token", () => {
    assert.deepEqual(extractHfRepos("tell me about the mistralai/Mistral-7B-v0.1 model"), [
      { id: "mistralai/Mistral-7B-v0.1", kind: "unknown" },
    ]);
  });

  test("weak cue REJECTS a plain lowercase pair (needs repo-ish or strong cue)", () => {
    // "openai/whisper" is lowercase with no digit/hyphen — under only a weak
    // "model" cue it's indistinguishable from prose, so it doesn't fire.
    assert.deepEqual(extractHfRepos("which model is better"), []);
  });

  test("'dataset' cue with a repo-ish id", () => {
    assert.deepEqual(ids(extractHfRepos("load the tatsu-lab/alpaca dataset")), ["tatsu-lab/alpaca"]);
  });

  test("a versioned id fires with NO cue at all (unmistakably a repo)", () => {
    assert.deepEqual(extractHfRepos("what's the license on meta-llama/Llama-3-8B?"), [
      { id: "meta-llama/Llama-3-8B", kind: "unknown" },
    ]);
  });
});

describe("extractHfRepos — negatives (must NOT fire)", () => {
  const negatives = [
    "Should I use TCP/IP or something else?",
    "Answer yes/no and explain.",
    "It's a 24/7 service with read/write access.",
    "Toggle the feature on/off as needed.",
    "Compare he/she pronoun handling.",
    "openai/whisper is a great tool", // lowercase, no digit, no cue → stays quiet
    "Summarize the latest AI research.",
    "The year 2023/2024 was eventful.", // digits but no hyphen
    "",
  ];
  for (const msg of negatives) {
    test(JSON.stringify(msg), () => assert.deepEqual(extractHfRepos(msg), []));
  }

  test("caps at 5 repos", () => {
    const msg =
      "on hugging face: a/x1 b/x2 c/x3 d/x4 e/x5 f/x6 g/x7";
    assert.ok(extractHfRepos(msg).length <= 5);
  });
});

describe("messageNamesHfRepo / hfAvailable", () => {
  test("gate reflects extraction", () => {
    assert.equal(messageNamesHfRepo("about google/gemma on huggingface"), true);
    assert.equal(messageNamesHfRepo("summarize the news"), false);
    assert.equal(messageNamesHfRepo(undefined), false);
  });
  test("availability tracks the token", () => {
    assert.equal(hfAvailable({ HUGGINGFACE_API_TOKEN: "hf_x" }), true);
    assert.equal(hfAvailable({}), false);
  });
});

describe("lookupRepo / runHuggingFaceLookup — stubbed Hub", () => {
  const log = { info() {}, warn() {} };
  const env = { HUGGINGFACE_API_TOKEN: "hf_secret" };

  function stubHub(map) {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: opts?.headers?.Authorization });
      for (const [needle, body] of Object.entries(map)) {
        if (String(url).includes(needle)) return { ok: true, json: async () => body };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    return { calls, restore: () => (globalThis.fetch = orig) };
  }

  test("unknown kind tries model first and summarizes it", async () => {
    const s = stubHub({
      "/models/google/gemma-2-9b": {
        id: "google/gemma-2-9b",
        author: "google",
        pipeline_tag: "text-generation",
        library_name: "transformers",
        downloads: 84866,
        likes: 711,
        gated: "manual",
        lastModified: "2024-08-07T18:26:02.000Z",
        tags: ["text-generation", "license:gemma", "safetensors"],
        cardData: { license: "gemma" },
        safetensors: { total: 9241705984 },
      },
    });
    try {
      const r = await lookupRepo(env, log, { id: "google/gemma-2-9b", kind: "unknown" });
      assert.equal(r.kind, "model");
      assert.equal(r.task, "text-generation");
      assert.equal(r.license, "gemma");
      assert.equal(r.params, "9.2B params");
      assert.equal(r.url, "https://huggingface.co/google/gemma-2-9b");
      assert.ok(!r.tags.includes("safetensors")); // machine noise stripped
      // Token sent as Bearer, never in the returned data.
      assert.match(s.calls[0].auth, /^Bearer hf_secret$/);
    } finally {
      s.restore();
    }
  });

  test("unknown kind falls back to the dataset endpoint on a model 404", async () => {
    const s = stubHub({
      "/datasets/squad": { id: "squad", author: "", downloads: 5000, likes: 300, tags: ["question-answering"] },
    });
    try {
      const r = await lookupRepo(env, log, { id: "squad", kind: "unknown" });
      assert.equal(r.kind, "dataset");
      assert.equal(r.url, "https://huggingface.co/datasets/squad");
    } finally {
      s.restore();
    }
  });

  test("runHuggingFaceLookup builds a labeled block + details", async () => {
    const s = stubHub({
      "/models/google/gemma-2-9b": { id: "google/gemma-2-9b", pipeline_tag: "text-generation", downloads: 84866, likes: 711, tags: [], cardData: { license: "gemma" } },
    });
    try {
      const convo = [{ role: "user", content: "tell me about google/gemma-2-9b on hugging face" }];
      const r = await runHuggingFaceLookup(env, log, convo);
      assert.equal(r.count, 1);
      assert.match(r.block, /Hugging Face Hub/);
      assert.match(r.block, /google\/gemma-2-9b/);
      assert.match(r.block, /text-generation/);
      assert.equal(r.details.length, 1);
    } finally {
      s.restore();
    }
  });

  test("a repo not on the Hub is surfaced honestly, not invented", async () => {
    const s = stubHub({}); // everything 404s
    try {
      const convo = [{ role: "user", content: "what is fake-org/not-a-real-model on huggingface" }];
      const r = await runHuggingFaceLookup(env, log, convo);
      assert.equal(r.count, 0);
      assert.match(r.block, /No Hugging Face Hub record was found/);
    } finally {
      s.restore();
    }
  });

  test("no token → lookup is a no-op", async () => {
    const convo = [{ role: "user", content: "about google/gemma on huggingface" }];
    assert.equal(await runHuggingFaceLookup({}, log, convo), null);
  });
});
