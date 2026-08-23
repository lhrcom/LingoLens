const test = require("node:test");
const assert = require("node:assert/strict");

const provider = require("../ai-provider-core.js");

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: encoder.encode(chunks[index++]) };
          },
          async cancel() {},
        };
      },
    },
  };
}

test("bounded JSON and SSE readers process incremental streams", async () => {
  const json = await provider.readJson(streamResponse(['{"choices":', '[]}']), {
    maxBytes: 100,
  });
  assert.deepEqual(json, { choices: [] });

  const deltas = [];
  const text = await provider.readSse(streamResponse([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n',
    'data: malformed\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ]), {
    maxBytes: 1000,
    onDelta: (value) => deltas.push(value),
  });
  assert.equal(text, "你好");
  assert.deepEqual(deltas, ["你", "你好"]);
});

test("both readers enforce the same response size limit", async () => {
  await assert.rejects(
    provider.readJson(streamResponse(['{"value":"too large"}']), { maxBytes: 5 }),
    (error) => error.code === "AI_RESPONSE_TOO_LARGE",
  );
  await assert.rejects(
    provider.readSse(streamResponse(["data: oversized\n"]), { maxBytes: 5 }),
    (error) => error.code === "AI_RESPONSE_TOO_LARGE",
  );
});

test("request lifecycle distinguishes cancellation, idle timeout, and hard timeout", async () => {
  const caller = new AbortController();
  const cancelled = provider.createLifecycle({
    signal: caller.signal,
    idleTimeoutMs: 100,
    hardTimeoutMs: 100,
  });
  caller.abort();
  assert.equal(cancelled.signal.aborted, true);
  assert.equal(cancelled.normalizeError(new DOMException("Aborted", "AbortError")).name, "AbortError");
  cancelled.finish();

  const idle = provider.createLifecycle({ idleTimeoutMs: 5, hardTimeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(idle.normalizeError(new Error("aborted")).code, "AI_IDLE_TIMEOUT");
  idle.finish();

  const hard = provider.createLifecycle({ idleTimeoutMs: 100, hardTimeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(hard.normalizeError(new Error("aborted")).code, "AI_HARD_TIMEOUT");
  hard.finish();
});

test("an empty SSE response stays empty for the caller to classify", async () => {
  assert.equal(await provider.readSse(streamResponse(["data: [DONE]\n\n"]), {
    maxBytes: 100,
  }), "");
});
