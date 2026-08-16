const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const captions = require("../live-caption-shared.js");
const audio = require("../audio-worklet.js");

test("caption segments stay ordered and preserve translation state", () => {
  let segments = captions.upsertSegment([], {
    id: "later",
    startMs: 2000,
    endMs: 3000,
    sourceText: "Later",
    recognitionState: "final",
  });
  segments = captions.upsertSegment(segments, {
    id: "earlier",
    startMs: 1000,
    endMs: 2000,
    sourceText: "Earlier",
    recognitionState: "final",
    translationText: "更早",
    translationState: "revised",
  });
  assert.deepEqual(segments.map((item) => item.id), ["earlier", "later"]);
  assert.equal(segments[0].translationState, "revised");
  assert.equal(captions.activeSegmentAt(segments, 1500).id, "earlier");
});

test("bilingual exports preserve aligned cues and escape markdown", () => {
  const session = {
    title: "Demo",
    url: "https://example.com/video",
    segments: [
      {
        id: "one",
        startMs: 1234,
        endMs: 4567,
        sourceText: "Hello | world",
        translationText: "你好",
        recognitionState: "final",
      },
    ],
  };
  assert.match(captions.exportSrt(session), /00:00:01,234 --> 00:00:04,567/);
  assert.match(captions.exportSrt(session), /Hello \| world\n你好/);
  assert.match(captions.exportVtt(session), /^WEBVTT/);
  assert.match(captions.exportMarkdown(session), /Hello \\\| world/);
});

test("session index retains the newest twenty unique sessions", () => {
  const input = ["new", ...Array.from({ length: 25 }, (_, index) => `s${index}`), "new"];
  const pruned = captions.pruneSessionIndex(input);
  assert.equal(pruned.length, 20);
  assert.equal(pruned[0], "new");
  assert.equal(new Set(pruned).size, 20);
});

test("overlay preferences normalize scale, width, and global defaults", () => {
  assert.deepEqual(captions.normalizeOverlayPreferences(), {
    version: 1,
    fontScale: 1,
    widthPreset: "standard",
    xRatio: 0.5,
    yRatio: 0.86,
  });
  assert.deepEqual(
    captions.normalizeOverlayPreferences({
      version: 99,
      fontScale: 2,
      widthPreset: "invalid",
      xRatio: -1,
      yRatio: 4,
    }),
    {
      version: 1,
      fontScale: 1.3,
      widthPreset: "standard",
      xRatio: 0,
      yRatio: 1,
    },
  );
  assert.equal(captions.nextOverlayWidthPreset("narrow"), "standard");
  assert.equal(captions.nextOverlayWidthPreset("standard"), "wide");
  assert.equal(captions.nextOverlayWidthPreset("wide"), "narrow");
  assert.deepEqual(captions.OVERLAY_WIDTH_MAX_PIXELS, {
    narrow: 560,
    standard: 720,
    wide: 880,
  });
});

test("overlay positioning keeps captions and the hover toolbar in the viewport", () => {
  const topLeft = captions.resolveOverlayPosition(
    { xRatio: 0, yRatio: 0 },
    1000,
    600,
    400,
    100,
  );
  assert.deepEqual(topLeft, {
    left: 208,
    top: 98,
    xRatio: 0.208,
    yRatio: 98 / 600,
  });

  const bottomRight = captions.resolveOverlayPosition(
    { xRatio: 1, yRatio: 1 },
    1000,
    600,
    400,
    100,
  );
  assert.equal(bottomRight.left, 792);
  assert.equal(bottomRight.top, 542);
  assert.ok(bottomRight.xRatio <= 1 && bottomRight.yRatio <= 1);
});

test("audio helpers clamp PCM and resample to approximately 16 kHz", () => {
  assert.deepEqual([...audio.floatTo16BitPCM([-2, -1, 0, 1, 2])], [
    -32768,
    -32768,
    0,
    32767,
    32767,
  ]);
  const source = Float32Array.from({ length: 4800 }, (_, index) => Math.sin(index / 10));
  const result = audio.resampleLinear(source, 48_000, 16_000);
  assert.ok(result.samples.length >= 1599 && result.samples.length <= 1601);
});

test("Deepgram chunk finals remain interim until speech_final closes the utterance", () => {
  const state = {};
  const first = captions.mergeDeepgramResult(state, {
    type: "Results",
    start: 0,
    duration: 0.8,
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ transcript: "Hello there", confidence: 0.9 }] },
  }, 1000);
  assert.equal(first.recognitionState, "interim");
  assert.equal(first.id, "live-1000");

  const final = captions.mergeDeepgramResult(state, {
    type: "Results",
    start: 0.8,
    duration: 0.7,
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "general Kenobi.", confidence: 0.95 }] },
  }, 1000);
  assert.equal(final.recognitionState, "final");
  assert.equal(final.sourceText, "Hello there general Kenobi.");
  assert.equal(state.finalParts.length, 0);
});

test("extension wires tab capture, offscreen audio, overlay, and live controls", () => {
  const manifest = JSON.parse(read("manifest.json"));
  for (const permission of ["activeTab", "offscreen", "tabCapture"]) {
    assert.ok(manifest.permissions.includes(permission));
  }
  assert.match(read("offscreen.js"), /wss:\/\/api\.deepgram\.com\/v1\/listen/);
  assert.match(read("offscreen.js"), /source\.connect\(audioContext\.destination\)/);
  assert.match(read("page-caption.js"), /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(read("page-caption.js"), /caption_overlay_preferences|OVERLAY_PREFERENCES_KEY/);
  assert.match(read("page-caption.js"), /role="toolbar"/);
  assert.match(read("page-caption.js"), /\.caption:hover \.tools, \.caption:focus-within \.tools/);
  assert.match(read("page-caption.js"), /addEventListener\("pointermove", moveOverlay\)/);
  assert.match(read("live-caption-background.js"), /"live-caption-shared\.js", "page-caption\.js"/);
  assert.match(read("sidepanel.html"), /id="startLiveCaptionBtn"/);
  assert.match(read("live-caption-background.js"), /currentMs \+ 180_000/);
  assert.match(read("live-caption-background.js"), /stream: true/);
});

test("overlay toolbar overlaps the caption so hover has no dead zone", () => {
  const source = read("page-caption.js");
  assert.match(source, /bottom: calc\(100% - 2px\)/);
  assert.match(source, /pointer-events: none; transform: translateY\(2px\)/);
  assert.match(source, /opacity: 1; pointer-events: auto; transform: translateY\(0\)/);
  assert.doesNotMatch(source, /top: -36px/);
});
