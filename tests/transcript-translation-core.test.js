const test = require("node:test");
const assert = require("node:assert/strict");

const captions = require("../live-caption-shared.js");
const core = require("../transcript-translation-core.js");

test("YouTube video IDs use strict supported hosts and URL forms", () => {
  assert.equal(captions.youtubeVideoId("https://www.youtube.com/watch?v=qoqiwWvF5lA"), "qoqiwWvF5lA");
  assert.equal(captions.youtubeVideoId("https://youtu.be/2fq9wYslV0A?t=2"), "2fq9wYslV0A");
  assert.equal(captions.youtubeVideoId("https://www.youtube.com/embed/abc_123"), "abc_123");
  assert.equal(captions.youtubeVideoId("https://notyoutube.com/watch?v=wrong"), "");
});

test("stable IDs are validated and source order is preserved", () => {
  const source = [
    { id: "segment-1", text: "This is a sufficiently long English source sentence." },
    { id: "segment-2", text: "This is another sufficiently long English source sentence." },
  ];
  const rows = core.alignModelResult({
    segments: [
      { id: "unknown", text: "忽略" },
      { id: "segment-2", text: "第二句" },
      { id: "segment-1", text: "第一句" },
    ],
  }, source);
  assert.deepEqual(rows.map(({ id, text }) => ({ id, text })), [
    { id: "segment-1", text: "第一句" },
    { id: "segment-2", text: "第二句" },
  ]);
  assert.throws(
    () => core.validateBatch([{ id: "same", text: "a" }, { id: "same", text: "b" }]),
    /unique and stable/,
  );
});

test("duplicate, missing, and non-Chinese model rows remain explicit errors", () => {
  const source = [
    { id: "a", text: "This source has enough English letters to require Chinese output." },
    { id: "b", text: "This source also has enough English letters to require Chinese output." },
  ];
  const rows = core.alignModelResult({
    segments: [
      { id: "a", text: "still English output" },
      { id: "a", text: "重复结果" },
    ],
  }, source);
  assert.deepEqual(rows.map(({ id, text, error }) => ({ id, text, error })), [
    { id: "a", text: "", error: "Missing or invalid Chinese translation" },
    { id: "b", text: "", error: "Missing or invalid Chinese translation" },
  ]);
});

test("v2 storage and item keys remain backward compatible", () => {
  assert.equal(
    core.translationStorageKey("video", "hash", "model"),
    "ytd_translation_v2_video_hash_zh_model",
  );
  assert.equal(
    core.translationItemKey("video", "hash", "model", "segment-1"),
    "video:hash:zh:model:semantic:segment-1",
  );
});

