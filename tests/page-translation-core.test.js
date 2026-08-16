"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../page-translation-core.js");

test("normalizeText 合并空白并识别英文", () => {
  assert.equal(Core.normalizeText("  Hello\n   world  "), "Hello world");
  assert.equal(Core.hasEnglish("你好，world"), true);
  assert.equal(Core.hasEnglish("纯中文 123"), false);
});

test("元素排除规则保留行内代码并跳过代码块、导航、隐藏和编辑区域", () => {
  assert.equal(Core.isExcludedTag("code"), false);
  assert.equal(Core.isExcludedTag("kbd"), false);
  assert.equal(Core.isExcludedTag("samp"), false);
  assert.equal(Core.isExcludedTag("pre"), true);
  assert.equal(Core.isExcludedTag("p"), false);
  assert.equal(Core.shouldExcludeElementDescriptor({ ancestorTags: ["P", "ARTICLE"] }), false);
  assert.equal(Core.shouldExcludeElementDescriptor({ ancestorTags: ["P", "NAV"] }), true);
  assert.equal(Core.shouldExcludeElementDescriptor({ ancestorTags: ["P"], hidden: true }), true);
  assert.equal(Core.shouldExcludeElementDescriptor({ ancestorTags: ["P"], contentEditable: true }), true);
});

test("相同段落去重并保留所有来源 ID", () => {
  const result = Core.deduplicateSegments([
    { id: "a", text: " Hello  world " },
    { id: "b", text: "Hello world" },
    { id: "c", text: "Another paragraph" }
  ]);
  assert.deepEqual(result.unique, [
    { id: "a", text: "Hello world" },
    { id: "c", text: "Another paragraph" }
  ]);
  assert.deepEqual(result.groups, [
    { representativeId: "a", sourceIds: ["a", "b"] },
    { representativeId: "c", sourceIds: ["c"] }
  ]);
});

test("分批同时遵守段落数与字符数限制", () => {
  const segments = Array.from({ length: 23 }, (_, index) => ({ id: String(index), text: `text-${index}` }));
  const byCount = Core.batchSegments(segments, { maxItems: 10, maxChars: 1000 });
  assert.deepEqual(byCount.map((batch) => batch.length), [10, 10, 3]);

  const byChars = Core.batchSegments([
    { id: "a", text: "12345" },
    { id: "b", text: "67890" },
    { id: "c", text: "abc" }
  ], { maxItems: 20, maxChars: 8 });
  assert.deepEqual(byChars.map((batch) => batch.map((item) => item.id)), [["a"], ["b", "c"]]);
});

test("DeepSeek JSON 响应只接受预期 ID、非空译文和首次结果", () => {
  const parsed = Core.parseTranslationResponse(JSON.stringify({
    translations: [
      { id: "a", text: "你好" },
      { id: "a", text: "重复" },
      { id: "unknown", text: "忽略" },
      { id: "b", text: "" }
    ]
  }), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(parsed.translations, [{ id: "a", text: "你好" }]);
  assert.deepEqual(parsed.missingIds, ["b"]);
  assert.throws(() => Core.parseTranslationResponse("not-json", [{ id: "a" }]), /有效 JSON/);
});

test("HTTP 错误映射和退避策略符合重试约定", () => {
  assert.deepEqual(Core.classifyHttpError(401), {
    code: "AUTH", retryable: false, message: "API Key 无效或没有访问权限"
  });
  assert.equal(Core.classifyHttpError(429).retryable, true);
  assert.equal(Core.classifyHttpError(503).retryable, true);
  assert.equal(Core.classifyHttpError(400).retryable, false);
  assert.deepEqual([0, 1, 2, 3].map(Core.retryDelay), [1000, 2000, 4000, 4000]);
});

test("未知模型回退到 Flash", () => {
  assert.equal(Core.safeModel("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(Core.safeModel("unknown"), "deepseek-v4-flash");
});
