const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Transcript header exposes Original, Chinese, and bilingual modes", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(js, /action: "translateTranscriptBatch"/);
  assert.match(js, /profile: "semantic"/);
});

test("live caption history is absent while exports remain wired", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  const css = read("sidepanel.css");
  const background = read("live-caption-background.js");
  assert.doesNotMatch(html + js + css, /liveCaptionHistory|live-caption-history|live-history-/);
  assert.doesNotMatch(js + background, /retrySegmentTranslation/);
  for (const format of ["srt", "vtt", "md"]) {
    assert.match(html, new RegExp(`data-live-export="${format}"`));
  }
  assert.match(js, /exportLiveCaptionSession/);
  assert.match(js, /recognitionState === "final"/);
});

test("AI requests disable thinking and use shared bounded readers", () => {
  const background = read("background.js");
  assert.match(background, /body\.thinking = \{ type: "disabled" \}/);
  assert.match(background, /YTD_AI_PROVIDER\.readJson/);
  assert.match(background, /YTD_AI_PROVIDER\.readSse/);
  assert.match(background, /AI_PROVIDER_MAX_RESPONSE_BYTES/);
});

test("Chinese prompt preserves natural bilingual-learning rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Simplified Chinese/i);
  assert.match(prompt, /natural/i);
  assert.match(prompt, /preserve/i);
});

