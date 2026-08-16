"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

require("../page-translation-core.js");
const pageBackground = require("../page-translation-background.js");

test("manifest isolates generic page translation from LingoLens YouTube content", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const generic = manifest.content_scripts.find((entry) =>
    entry.js?.includes("page-translation-content.js"),
  );
  const youtube = manifest.content_scripts.find((entry) =>
    entry.js?.includes("content.js"),
  );
  assert.deepEqual(generic.matches, ["http://*/*", "https://*/*"]);
  assert.deepEqual(generic.js, [
    "page-translation-core.js",
    "page-translation-content.js",
  ]);
  assert.deepEqual(generic.css, ["page-translation.css"]);
  assert.deepEqual(youtube.matches, ["https://www.youtube.com/*"]);
  assert.equal(generic.all_frames, false);
});

test("page content shows an isolated selection translator without automatic requests", () => {
  const content = read("page-translation-content.js");
  const inspectSource = content.slice(
    content.indexOf("function inspectCurrentSelection"),
    content.indexOf("function nextSourceId"),
  );
  assert.match(content, /MAX_SELECTION_CHARS = 12_000/);
  assert.match(content, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(content, /<button class="trigger"[^>]*>译<\/button>/);
  assert.match(content, /class="card" role="dialog" aria-label="划词翻译"/);
  for (const action of ["copy", "retry", "close"]) {
    assert.match(content, new RegExp(`data-action="${action}"`));
  }
  assert.match(content, /function translateCurrentSelection/);
  assert.match(content, /action: "ytdPageTranslationTranslateSelection"/);
  assert.match(content, /navigator\.clipboard\.writeText\(selectionTranslation\)/);
  assert.match(content, /复制失败/);
  assert.match(content, /text\.length > MAX_SELECTION_CHARS/);
  assert.match(content, /window\.addEventListener\("scroll", hideSelectionUi/);
  assert.match(content, /window\.addEventListener\("resize", hideSelectionUi/);
  assert.doesNotMatch(inspectSource, /sendMessage|ytdPageTranslationTranslateSelection/);
  assert.doesNotMatch(content, /ytdPageTranslationGetSelection/);
  assert.doesNotMatch(content, /ytdPageTranslationSelectionChanged/);
  assert.match(content, /ytdPageTranslationStart/);
  assert.match(content, /ytd-page-translation/);
  assert.doesNotMatch(content, /DeepSeekTranslatorCore/);
  assert.doesNotMatch(content, /TRANSLATE_SELECTION|START_PAGE_TRANSLATION/);
});

test("full-page extraction keeps inline code while excluding preformatted blocks", () => {
  const content = read("page-translation-content.js");
  const excludedSelector = content.slice(
    content.indexOf("const EXCLUDED_SELECTOR"),
    content.indexOf("].join", content.indexOf("const EXCLUDED_SELECTOR")),
  );
  assert.match(excludedSelector, /"pre"/);
  assert.doesNotMatch(excludedSelector, /"code"|"kbd"|"samp"/);
  assert.match(content, /node\.textContent = translation/);

  const background = read("page-translation-background.js");
  assert.match(background, /dotted identifiers such as a\.shape/);
  assert.match(background, /never translate, rewrite, or omit them/);
});

test("side panel exposes only full-page translation controls with smart layout", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  for (const id of [
    "pageTranslationCard",
    "translatePageBtn",
    "stopPageTranslationBtn",
    "removePageTranslationsBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const removedId of [
    "translateSelectionBtn",
    "copySelectionTranslationBtn",
    "retrySelectionTranslationBtn",
    "pageSelectionPreview",
    "pageSelectionResult",
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removedId}"`));
  }
  assert.match(html, /Full-page bilingual translation/);
  assert.match(js, /card\.open = !url\.startsWith\("https:\/\/www\.youtube\.com"\)/);
  assert.match(js, /ytdPageTranslationStatusChanged/);
  assert.doesNotMatch(js, /ytdPageTranslationTranslateSelection/);
  assert.doesNotMatch(js, /ytdPageTranslationGetSelection/);
  assert.doesNotMatch(js, /ytdPageTranslationSelectionChanged/);
});

test("page translation backend validates batches and uses shared AI completion", async () => {
  assert.throws(
    () => pageBackground.normalizeSegments([
      { id: "same", text: "First" },
      { id: "same", text: "Second" },
    ]),
    /Invalid page translation segment/,
  );
  assert.throws(
    () => pageBackground.normalizeSegments([
      { id: "long", text: "x".repeat(12_001) },
    ]),
    /Invalid page translation segment/,
  );

  const calls = [];
  const api = pageBackground.createApi({
    async requestAiCompletion(request) {
      calls.push(request);
      const payload = JSON.parse(request.messages[1].content);
      return {
        text: JSON.stringify({
          translations: payload.segments.map((item) => ({
            id: item.id,
            text: `译文:${item.text}`,
          })),
        }),
      };
    },
  });
  const translated = await api.translateSelection("Hello world");
  assert.equal(translated, "译文:Hello world");
  await assert.rejects(
    api.translateSelection("纯中文 123"),
    /Select text containing English/,
  );
  await assert.rejects(
    api.translateSelection("x".repeat(12_001)),
    /longer than 12,000 characters/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].responseFormat, { type: "json_object" });
  assert.equal(calls[0].temperature, 0.2);
  assert.match(calls[0].messages[0].content, /Simplified Chinese/);
});

test("settings and release package expose one key with Flash or Pro", () => {
  const html = read("options.html");
  const settings = require("../settings.js");
  assert.match(html, /id="aiApiKey"/);
  assert.match(html, /id="aiModel"/);
  assert.match(html, /value="deepseek-v4-flash"/);
  assert.match(html, /value="deepseek-v4-pro"/);
  assert.match(html, /id="testDeepseekBtn"/);
  assert.deepEqual([...settings.AI_MODELS], [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
  const checkScript = read("scripts/check-release.sh");
  for (const file of [
    "page-translation-core.js",
    "page-translation-content.js",
    "page-translation-background.js",
    "page-translation.css",
  ]) {
    assert.match(checkScript, new RegExp(file.replaceAll(".", "\\.")));
  }
});
