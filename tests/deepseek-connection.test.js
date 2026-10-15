const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const provider = require("../ai-provider-core.js");
const settings = require("../settings.js");
require("../page-translation-core.js");
const page = require("../page-translation-background.js");

const segments = [{ id: "one", text: "Hello" }];
const success = { text: '{"translations":[{"id":"one","text":"你好"}]}' };

test("transient 503 recovers and respects Retry-After without changing models", async () => {
  const waits = [];
  let calls = 0;
  const api = page.createApi({
    delay: async (ms) => waits.push(ms),
    requestAiCompletion: async () => {
      if (++calls === 1) throw Object.assign(new Error("Overloaded"), {
        status: 503, retryAfterMs: 10_000,
      });
      return success;
    },
  });
  const result = await api.requestWithRetry(segments);
  assert.equal(result.translations[0].text, "你好");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [10_000]);
});

test("persistent 5xx stops after four attempts and exposes the HTTP status", async () => {
  for (const status of [500, 502, 503, 504]) {
    let calls = 0;
    const waits = [];
    const api = page.createApi({
      delay: async (ms) => waits.push(ms),
      requestAiCompletion: async () => {
        calls++;
        throw Object.assign(new Error("upstream failure"), { status });
      },
    });
    await assert.rejects(api.requestWithRetry(segments), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, "SERVER");
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
    assert.equal(calls, 4);
    assert.deepEqual(waits, [1000, 2000, 4000]);
  }
});

test("key, balance, and request errors are actionable and never retried", async () => {
  for (const [status, code] of [[401, "AUTH"], [403, "AUTH"],
    [402, "INSUFFICIENT_BALANCE"], [400, "API"], [422, "API"]]) {
    let calls = 0;
    const api = page.createApi({
      delay: async () => assert.fail("non-retryable request was retried"),
      requestAiCompletion: async () => {
        calls++;
        throw Object.assign(new Error("untrusted error body"), { status });
      },
    });
    await assert.rejects(api.requestWithRetry(segments), (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /untrusted error body/);
      if (status === 402) assert.match(error.message, /余额不足/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("rate limits retry and cancelled requests never start another API call", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = page.createApi({
    delay: async () => controller.abort(),
    requestAiCompletion: async () => {
      calls++;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    },
  });
  await assert.rejects(api.requestWithRetry(segments, controller.signal),
    (error) => error.code === "CANCELLED");
  assert.equal(calls, 1);
});

test("Retry-After accepts seconds and HTTP dates, caps waits, and rejects invalid values", () => {
  const now = Date.parse("2026-10-15T00:00:00Z");
  assert.equal(provider.retryAfterMs("2", now), 2000);
  assert.equal(provider.retryAfterMs("Thu, 15 Oct 2026 00:00:10 GMT", now), 10_000);
  for (const value of [null, "", "bad", "-1", "Thu, 15 Oct 2026 00:00:00 GMT"]) {
    assert.equal(provider.retryAfterMs(value, now), 0);
  }
  assert.equal(provider.retryAfterMs("999999", now), 30_000);
});

test("legacy Flash settings keep keys and normalize to the current official model", () => {
  const normalized = settings.normalize({
    aiModel: "deepseek-v4-flash", aiApiKey: "example-key",
    supadataApiKey: "example-supadata", deepgramApiKey: "example-deepgram",
  });
  assert.equal(normalized.aiModel, "deepseek-flash");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
  assert.equal(normalized.deepgramApiKey, "example-deepgram");
});

// Exercise the actual service-worker request and Chrome message handler with
// mocked HTTP responses. No real keys or network calls are used.
function harness(respond) {
  const root = path.resolve(__dirname, "..");
  const listeners = [];
  const context = vm.createContext({
    console, AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    fetch: respond,
    chrome: {
      storage: { local: {
        setAccessLevel: async () => {},
        get: async () => ({ ytd_settings: {
          aiModel: "deepseek-v4-flash", aiApiKey: "example-key",
        } }),
      } },
      action: { onClicked: { addListener() {} } },
      sidePanel: { setPanelBehavior() {} },
      tabs: { onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
      runtime: {
        onInstalled: { addListener() {} },
        onConnect: { addListener() {} },
        onMessage: { addListener(fn) { listeners.push(fn); } },
      },
    },
  });
  context.importScripts = (file) => {
    if (file === "live-caption-background.js") return;
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  };
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  return { context, listeners };
}

test("Chrome connection test uses a small real JSON translation and canonical Flash name", async () => {
  const { listeners } = harness(async (url, request) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const body = JSON.parse(request.body);
    assert.equal(body.model, "deepseek-flash");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.response_format, { type: "json_object" });
    const id = JSON.parse(body.messages[1].content).segments[0].id;
    return new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ translations: [{ id, text: "你好，世界！" }] }),
    } }] }));
  });
  const response = await new Promise((resolve) => {
    assert.equal(listeners[0]({ action: "ytdPageTranslationTestApi" }, {}, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.translation, "你好，世界！");
});

test("service worker preserves status and Retry-After for JSON and HTML gateway failures", async () => {
  for (const body of ['{"error":{"message":"Overloaded"}}', '<html>Bad Gateway</html>']) {
    const { context } = harness(async () => new Response(body, {
      status: 503, headers: { "Retry-After": "12" },
    }));
    await assert.rejects(context.__YTD_TRANSLATION_TESTING__.requestAiCompletion({
      messages: [{ role: "user", content: "Hello" }], maxTokens: 256,
    }), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "AI_PROVIDER_UNAVAILABLE");
      assert.equal(error.retryAfterMs, 12_000);
      return true;
    });
  }
});
