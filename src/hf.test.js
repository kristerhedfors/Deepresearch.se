import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  hfAttempts,
  hfIntent,
  hfTermKey,
  hfTerms,
  toDatasetItem,
  toModelItem,
  toPaperItem,
} from "./hf.js";

describe("hfIntent — explicit-mention detection", () => {
  test("matches the explicit forms, including a bare 'HF' word", () => {
    assert.ok(hfIntent("most downloaded Swedish models on Hugging Face"));
    assert.ok(hfIntent("search huggingface for whisper variants"));
    assert.ok(hfIntent("what's at hf.co/datasets/vtllms/sealqa?"));
    assert.ok(hfIntent("look on the HF hub"));
    assert.ok(hfIntent("most downloaded whisper variants on hf?"));
    // Accepted tradeoff (requested): ham-radio HF fires too — the hub
    // search is free and fail-soft, and irrelevant results go uncited.
    assert.ok(hfIntent("HF radio propagation at night"));
  });

  test("does NOT match an org/name path, an hf-substring, or unrelated text", () => {
    assert.equal(hfIntent("compare meta-llama/Llama-3.3 to mistral"), false);
    assert.equal(hfIntent("the shfted spectrum"), false);
    assert.equal(hfIntent("latest EU AI act deadlines"), false);
    assert.equal(hfIntent(""), false);
    assert.equal(hfIntent(null), false);
  });
});

describe("hfTerms — noise stripping for the name-substring endpoints", () => {
  test("keeps domain terms, drops platform/question/stop words", () => {
    assert.deepEqual(
      hfTerms("What are the most downloaded Swedish speech recognition models on Hugging Face?"),
      ["swedish", "speech", "recognition"],
    );
  });

  test("strips URLs and caps at 6 terms", () => {
    const terms = hfTerms("alpha beta gamma delta epsilon zeta eta https://hf.co/x");
    assert.equal(terms.length, 6);
    assert.ok(!terms.some((t) => t.includes("hf.co")));
  });

  test("empty/noise-only input gives no terms", () => {
    assert.deepEqual(hfTerms("what are the most popular models on the hub"), []);
    assert.deepEqual(hfTerms(""), []);
  });
});

describe("hfAttempts — the distinctive-term ladder", () => {
  test("full join first, then singles with the distinctive (non-generic) term ranked ahead", () => {
    // The run A junk case: naive term-dropping degraded "swedish speech
    // recognition" to "speech recognition" (irrelevant popular repos). The
    // fallback singles must lead with "swedish", the only non-generic term.
    assert.deepEqual(hfAttempts(["swedish", "speech", "recognition"]), [
      "swedish speech recognition",
      "swedish",
      "recognition",
    ]);
  });

  test("generic-only terms still rank by length", () => {
    assert.deepEqual(hfAttempts(["speech", "recognition"]), [
      "speech recognition",
      "recognition",
      "speech",
    ]);
  });

  test("short inputs don't produce redundant attempts", () => {
    assert.deepEqual(hfAttempts(["whisper"]), ["whisper"]);
    assert.deepEqual(hfAttempts(["whisper", "swedish"]), ["whisper swedish", "whisper", "swedish"]);
    assert.deepEqual(hfAttempts([]), []);
  });
});

describe("hfTermKey — the cross-wave dedup key", () => {
  test("same terms after noise-stripping give the same key", () => {
    assert.equal(
      hfTermKey("most downloaded Swedish speech recognition models on Hugging Face"),
      hfTermKey("swedish speech recognition huggingface"),
    );
  });

  test("noise-only queries key to the empty string", () => {
    assert.equal(hfTermKey("most popular models on the hub"), "");
  });

  test("search-intent qualifiers are stripped, so a gap follow-up dedups against the initial wave", () => {
    // The live probe's round-2 junk case: "independent reviews" must not
    // survive as distinctive terms — the follow-up reduces to the same key
    // as the initial query and the repeat hub search is skipped.
    assert.equal(
      hfTermKey("swedish speech recognition independent reviews"),
      hfTermKey("swedish speech recognition"),
    );
    assert.deepEqual(hfTerms("independent expert analysis vs official announcements"), []);
    // Question-meta words about artifacts ("variants of X") strip too.
    assert.deepEqual(hfTerms("most downloaded whisper variants on hf"), ["whisper"]);
  });
});

describe("item mappers — Hub API item -> source-registry item", () => {
  test("model item carries id URL, title tag, and metadata highlight", () => {
    const item = toModelItem({
      id: "KBLab/kb-whisper-large",
      downloads: 9786,
      likes: 63,
      pipeline_tag: "automatic-speech-recognition",
      lastModified: "2025-08-27T12:35:05.000Z",
      gated: false,
    });
    assert.equal(item.url, "https://huggingface.co/KBLab/kb-whisper-large");
    assert.match(item.title, /Hugging Face model/);
    assert.match(item.highlights[0], /task: automatic-speech-recognition/);
    assert.match(item.highlights[0], /9,786 downloads/);
    assert.match(item.highlights[0], /updated 2025-08-27/);
    assert.doesNotMatch(item.highlights[0], /gated/);
  });

  test("dataset item uses the /datasets/ URL and marks gated", () => {
    const item = toDatasetItem({ id: "vtllms/sealqa", downloads: 1200, likes: 10, gated: true });
    assert.equal(item.url, "https://huggingface.co/datasets/vtllms/sealqa");
    assert.match(item.highlights[0], /gated/);
  });

  test("paper item handles the nested {paper:{...}} search shape and collapses whitespace", () => {
    const item = toPaperItem({
      paper: {
        id: "2505.17538",
        title: "Swedish Whispers; Leveraging a Massive Speech Corpus for Swedish Speech\n  Recognition",
        summary: "  This work presents\n a suite of fine-tuned Whisper models. ",
        publishedAt: "2025-05-23T06:42:16.000Z",
      },
    });
    assert.equal(item.url, "https://huggingface.co/papers/2505.17538");
    assert.match(item.title, /Swedish Whispers; Leveraging a Massive Speech Corpus for Swedish Speech Recognition/);
    assert.match(item.highlights[0], /published 2025-05-23/);
    assert.match(item.highlights[1], /^This work presents a suite/);
  });

  test("junk items map to null instead of throwing", () => {
    assert.equal(toModelItem(null), null);
    assert.equal(toModelItem({}), null);
    assert.equal(toDatasetItem({ downloads: 5 }), null);
    assert.equal(toPaperItem({ paper: { id: "x" } }), null);
  });
});
