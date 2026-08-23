/** Pure request lifecycle and bounded response readers for AI providers. */
var YTD_AI_PROVIDER = (() => {
  function responseTooLarge(maxBytes) {
    const error = new Error(
      `DeepSeek response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MiB limit.`,
    );
    error.code = "AI_RESPONSE_TOO_LARGE";
    return error;
  }

  async function readText(response, { maxBytes, onActivity }) {
    const reader = response.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onActivity?.();
        bytes += value?.byteLength ?? 0;
        if (bytes > maxBytes) {
          await reader.cancel?.().catch(() => {});
          throw responseTooLarge(maxBytes);
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    }
    if (typeof response.text === "function") {
      const text = await response.text();
      onActivity?.();
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw responseTooLarge(maxBytes);
      }
      return text;
    }
    const data = await response.json();
    onActivity?.();
    const text = JSON.stringify(data);
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw responseTooLarge(maxBytes);
    }
    return text;
  }

  async function readJson(response, options) {
    return JSON.parse((await readText(response, options)).trimStart());
  }

  async function readSse(response, { maxBytes, onActivity, onDelta }) {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const error = new Error("DeepSeek streaming response was unavailable.");
      error.code = "AI_STREAM_UNAVAILABLE";
      throw error;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      bytes += value?.byteLength ?? 0;
      if (bytes > maxBytes) {
        await reader.cancel?.().catch(() => {});
        throw responseTooLarge(maxBytes);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            text += delta;
            onDelta?.(text);
          }
        } catch (_error) {
          // Malformed keepalive lines contain no usable content.
        }
      }
    }
    return text.trim();
  }

  function createLifecycle({
    signal,
    idleTimeoutMs,
    hardTimeoutMs,
    AbortControllerImpl = AbortController,
  }) {
    const controller = new AbortControllerImpl();
    let timeoutKind = "";
    let idleTimer;
    let hardTimer;
    const abortFromCaller = () => controller.abort();
    const abortForTimeout = (kind) => {
      if (controller.signal.aborted) return;
      timeoutKind = kind;
      controller.abort();
    };
    const activity = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortForTimeout("idle"), idleTimeoutMs);
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    hardTimer = setTimeout(() => abortForTimeout("hard"), hardTimeoutMs);
    activity();
    return {
      activity,
      signal: controller.signal,
      finish() {
        signal?.removeEventListener("abort", abortFromCaller);
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
      },
      normalizeError(error) {
        if (!timeoutKind) return error;
        const timeoutError = new Error(
          timeoutKind === "idle"
            ? "DeepSeek request was inactive for 50 seconds. Please Retry."
            : "DeepSeek request exceeded the 120-second limit. Please Retry.",
        );
        timeoutError.code = timeoutKind === "idle"
          ? "AI_IDLE_TIMEOUT"
          : "AI_HARD_TIMEOUT";
        return timeoutError;
      },
    };
  }

  return { createLifecycle, readJson, readSse, readText };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_AI_PROVIDER;
}
