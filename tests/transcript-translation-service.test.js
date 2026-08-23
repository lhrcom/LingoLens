const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../transcript-translation-core.js");
global.YTD_TRANSCRIPT_TRANSLATION = core;
const background = require("../transcript-translation-background.js");

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(values) {
      await Promise.resolve();
      Object.assign(data, structuredClone(values));
    },
  };
}

function makeService(storage, requestAiCompletion) {
  return background.createService({
    storage,
    getSettings: async () => ({ aiApiKey: "test", aiModel: "deepseek-test" }),
    getTranslationBaseRules: async () => "rules",
    loadPromptSection: async () => "semantic prompt",
    requestAiCompletion,
  });
}

function translatingProvider(counter) {
  return async ({ messages }) => {
    counter.calls += 1;
    const payload = JSON.parse(messages.at(-1).content);
    return {
      text: JSON.stringify({
        segments: payload.segments.map((segment) => ({
          id: segment.id,
          text: `中文-${segment.text}`,
        })),
      }),
    };
  };
}

test("a semantic translation is reused by the prefetched entry", async () => {
  const storage = memoryStorage();
  const counter = { calls: 0 };
  const service = makeService(storage, translatingProvider(counter));
  const identity = { videoId: "video", sourceHash: "hash", videoTitle: "Title" };
  const first = await service.translateTranscriptBatch({
    ...identity,
    profile: "semantic",
    segments: [{ id: "segment-1", text: "Hello there, this is a long English sentence." }],
  });
  const second = await service.translateTranscriptBatch({
    ...identity,
    profile: "prefetched",
    segments: [{
      id: "youtube-segment-1",
      transcriptId: "segment-1",
      text: "Hello there, this is a long English sentence.",
    }],
  });
  assert.equal(counter.calls, 1);
  assert.equal(first[0].cached, false);
  assert.equal(second[0].cached, true);
  assert.equal(second[0].id, "youtube-segment-1");
  assert.equal(second[0].text, first[0].text);
});

test("old v2 cache entries are read without calling the model", async () => {
  const storageKey = core.translationStorageKey("video", "hash", "deepseek-test");
  const itemKey = core.translationItemKey("video", "hash", "deepseek-test", "segment-1");
  const storage = memoryStorage({
    [storageKey]: { translations: { [itemKey]: "旧缓存翻译" } },
  });
  const counter = { calls: 0 };
  const service = makeService(storage, translatingProvider(counter));
  const rows = await service.translateTranscriptBatch({
    profile: "semantic",
    videoId: "video",
    sourceHash: "hash",
    segments: [{ id: "segment-1", text: "A long English source that needs Chinese output." }],
  });
  assert.equal(counter.calls, 0);
  assert.deepEqual(rows[0], { id: "segment-1", text: "旧缓存翻译", error: "", cached: true });
});

test("concurrent batches merge rather than overwriting the same cache", async () => {
  const storage = memoryStorage();
  const counter = { calls: 0 };
  const service = makeService(storage, translatingProvider(counter));
  const base = { profile: "semantic", videoId: "video", sourceHash: "hash" };
  await Promise.all([
    service.translateTranscriptBatch({
      ...base,
      segments: [{ id: "segment-1", text: "First sufficiently long English sentence." }],
    }),
    service.translateTranscriptBatch({
      ...base,
      segments: [{ id: "segment-2", text: "Second sufficiently long English sentence." }],
    }),
  ]);
  const key = core.translationStorageKey("video", "hash", "deepseek-test");
  assert.equal(Object.keys(storage.data[key].translations).length, 2);
});

test("rate limiting is retried and then classified as a failure", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const service = makeService(storage, async () => {
    calls += 1;
    const error = new Error("rate limited");
    error.status = 429;
    throw error;
  });
  await assert.rejects(
    service.translateTranscriptBatch({
      profile: "semantic",
      segments: [{ id: "segment-1", text: "A sufficiently long English sentence for translation." }],
    }),
    /rate limited/,
  );
  assert.equal(calls, 3);
});

