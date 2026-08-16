var YTD_PAGE_TRANSLATION_BACKGROUND = (() => {
  "use strict";

  const Core = globalThis.YTD_PAGE_TRANSLATION_CORE;
  const MAX_RETRIES = 3;
  const jobs = new Map();

  class PageTranslationError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "PageTranslationError";
      this.code = options.code || "UNKNOWN";
      this.status = options.status || 0;
      this.retryable = Boolean(options.retryable);
    }
  }

  function serializeError(error) {
    return {
      code: error?.code || "UNKNOWN",
      status: error?.status || 0,
      message: error?.message || "Translation failed. Try again.",
    };
  }

  function normalizeSegments(input) {
    if (!Array.isArray(input) || input.length > 2_000) {
      throw new PageTranslationError("Invalid page translation request.", {
        code: "INVALID_REQUEST",
      });
    }
    const seen = new Set();
    return input.map((item) => {
      const id = String(item?.id || "").trim();
      const text = Core.normalizeText(item?.text);
      if (!id || id.length > 200 || seen.has(id) || !text || text.length > 12_000) {
        throw new PageTranslationError("Invalid page translation segment.", {
          code: "INVALID_REQUEST",
        });
      }
      seen.add(id);
      return { id, text };
    });
  }

  function toPageTranslationError(error) {
    if (error instanceof PageTranslationError) return error;
    if (error?.name === "AbortError") {
      return new PageTranslationError("Translation cancelled.", { code: "CANCELLED" });
    }
    if (error?.code === "NO_AI_KEY") {
      return new PageTranslationError(
        "Add your DeepSeek API key in LingoLens Settings.",
        { code: "NO_AI_KEY", retryable: false },
      );
    }
    if (error?.code === "AI_RESPONSE_TOO_LARGE") {
      return new PageTranslationError(error.message, {
        code: error.code,
        retryable: false,
      });
    }
    if (error?.status) {
      const classified = Core.classifyHttpError(error.status);
      return new PageTranslationError(classified.message, {
        ...classified,
        status: error.status,
      });
    }
    const timeoutCodes = new Set(["AI_IDLE_TIMEOUT", "AI_HARD_TIMEOUT"]);
    if (timeoutCodes.has(error?.code)) {
      return new PageTranslationError(error.message, {
        code: error.code,
        retryable: true,
      });
    }
    if (error instanceof SyntaxError || error?.code === "EMPTY_AI_RESPONSE") {
      return new PageTranslationError("DeepSeek returned invalid translation data.", {
        code: "INVALID_RESPONSE",
        retryable: true,
      });
    }
    return new PageTranslationError(error?.message || "Network request failed.", {
      code: error?.code || "NETWORK",
      retryable: true,
    });
  }

  function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(new PageTranslationError("Translation cancelled.", { code: "CANCELLED" }));
      };
      if (!signal) return;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  function createApi({ requestAiCompletion }) {
    async function requestBatch(segments, signal) {
      const systemPrompt = [
        "You are a professional English to Simplified Chinese translator.",
        "Translate only the English text in the input. Do not summarize or explain.",
        "Preserve proper nouns, numbers, URLs, placeholders, and code fragments.",
        "Preserve dotted identifiers such as a.shape, function names, variable names, and programming expressions exactly; never translate, rewrite, or omit them.",
        'Return one JSON object: {"translations":[{"id":"input ID","text":"Simplified Chinese translation"}]}.',
        "Return every input ID exactly once and in the original order.",
      ].join("\n");
      try {
        const { text } = await requestAiCompletion({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify({ segments }) },
          ],
          maxTokens: 8_192,
          temperature: 0.2,
          responseFormat: { type: "json_object" },
          signal,
        });
        const result = Core.parseTranslationResponse(text, segments);
        if (!result.translations.length) {
          throw new PageTranslationError("DeepSeek returned no usable translations.", {
            code: "INVALID_RESPONSE",
            retryable: true,
          });
        }
        return result;
      } catch (error) {
        throw toPageTranslationError(error);
      }
    }

    async function requestWithRetry(segments, signal) {
      let lastError;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          return await requestBatch(segments, signal);
        } catch (error) {
          lastError = error;
          if (signal?.aborted) {
            throw new PageTranslationError("Translation cancelled.", { code: "CANCELLED" });
          }
          if (!Core.isRetryableError(error) || attempt === MAX_RETRIES) throw error;
          await abortableDelay(Core.retryDelay(attempt), signal);
        }
      }
      throw lastError;
    }

    async function translateSelection(value, signal) {
      const text = Core.normalizeText(value);
      if (!Core.hasEnglish(text)) {
        throw new PageTranslationError("Select text containing English.", {
          code: "NO_ENGLISH",
        });
      }
      if (text.length > 12_000) {
        throw new PageTranslationError("The selection is longer than 12,000 characters.", {
          code: "TOO_LONG",
        });
      }
      const id = `selection-${Date.now()}`;
      const result = await requestWithRetry([{ id, text }], signal);
      const translation = result.translations.find((item) => item.id === id);
      if (!translation) {
        throw new PageTranslationError("DeepSeek did not return this translation.", {
          code: "MISSING_TRANSLATION",
        });
      }
      return translation.text;
    }

    function safePostMessage(port, message) {
      try {
        port.postMessage(message);
      } catch (_error) {
        // The tab or side panel may have closed while a request was finishing.
      }
    }

    async function runPageJob(tabId, jobId, inputSegments, port) {
      const segments = normalizeSegments(inputSegments);
      const controller = new AbortController();
      jobs.set(jobId, { tabId, jobId, controller, port });
      const batches = Core.batchSegments(segments);
      let nextBatch = 0;
      let completed = 0;

      async function worker() {
        while (!controller.signal.aborted) {
          const index = nextBatch;
          nextBatch += 1;
          if (index >= batches.length) return;
          const batch = batches[index];
          try {
            const result = await requestWithRetry(batch, controller.signal);
            completed += batch.length;
            safePostMessage(port, {
              action: "ytdPageTranslationProgress",
              jobId,
              completed,
              total: segments.length,
              results: result.translations,
              errors: result.missingIds.map((id) => ({
                id,
                error: { code: "MISSING_TRANSLATION", message: "DeepSeek did not return this segment." },
              })),
              done: false,
            });
          } catch (error) {
            if (error.code === "CANCELLED") return;
            completed += batch.length;
            safePostMessage(port, {
              action: "ytdPageTranslationProgress",
              jobId,
              completed,
              total: segments.length,
              results: [],
              errors: batch.map((item) => ({ id: item.id, error: serializeError(error) })),
              done: false,
            });
          }
        }
      }

      try {
        await Promise.all([worker(), worker()]);
        safePostMessage(port, {
          action: "ytdPageTranslationProgress",
          jobId,
          completed,
          total: segments.length,
          results: [],
          errors: [],
          done: true,
          cancelled: controller.signal.aborted,
        });
      } finally {
        jobs.delete(jobId);
      }
    }

    function register() {
      chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== "ytd-page-translation") return;
        const tabId = port.sender?.tab?.id;
        const portJobs = new Set();
        port.onMessage.addListener((message) => {
          if (message?.action === "ytdPageTranslationStartJob" && tabId && message.jobId) {
            jobs.get(message.jobId)?.controller.abort();
            portJobs.add(message.jobId);
            runPageJob(tabId, message.jobId, message.segments, port)
              .catch((error) => {
                safePostMessage(port, {
                  action: "ytdPageTranslationProgress",
                  jobId: message.jobId,
                  completed: 0,
                  total: Array.isArray(message.segments) ? message.segments.length : 0,
                  results: [],
                  errors: [],
                  done: true,
                  fatalError: serializeError(error),
                });
              })
              .finally(() => portJobs.delete(message.jobId));
          }
          if (message?.action === "ytdPageTranslationCancelJob" && message.jobId) {
            jobs.get(message.jobId)?.controller.abort();
          }
        });
        port.onDisconnect.addListener(() => {
          for (const jobId of portJobs) jobs.get(jobId)?.controller.abort();
        });
      });

      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.action === "ytdPageTranslationTranslateSelection" ||
            message?.action === "ytdPageTranslationTestApi") {
          const text = message.action === "ytdPageTranslationTestApi"
            ? "Hello, world!"
            : message.text;
          translateSelection(text)
            .then((translation) => sendResponse({ ok: true, translation }))
            .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
          return true;
        }
        if (message?.action === "ytdPageTranslationCancelJob" && message.jobId) {
          jobs.get(message.jobId)?.controller.abort();
          sendResponse({ ok: true });
          return false;
        }
        return false;
      });
    }

    return { register, requestBatch, requestWithRetry, translateSelection };
  }

  function register(dependencies) {
    const api = createApi(dependencies);
    api.register();
    return api;
  }

  return { PageTranslationError, createApi, normalizeSegments, register };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_PAGE_TRANSLATION_BACKGROUND;
}
