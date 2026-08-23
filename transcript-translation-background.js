/* global YTD_TRANSCRIPT_TRANSLATION */

var YTD_TRANSCRIPT_TRANSLATION_BACKGROUND = (() => {
  const core = typeof YTD_TRANSCRIPT_TRANSLATION !== "undefined"
    ? YTD_TRANSCRIPT_TRANSLATION
    : require("./transcript-translation-core.js");
  const storageLocks = new Map();

  function createService({
    getSettings,
    getTranslationBaseRules,
    loadPromptSection,
    requestAiCompletion,
    storage,
  }) {
    async function semanticPrompt(message) {
      const baseRules = await getTranslationBaseRules("zh");
      return loadPromptSection("translation.md", "Transcript batch translation", {
        langName: "Simplified Chinese",
        videoTitle: message.videoTitle || "Unknown",
        sourceLanguage: message.sourceLanguage || "auto-detected",
        baseRules,
      });
    }

    function prefetchedPrompt(message) {
      return [
        `Translate the requested ${message.sourceLanguage || "source-language"} subtitle segments to natural Simplified Chinese.`,
        "Preserve IDs exactly and return JSON {segments:[{id,text}]}. Do not merge, split, omit, or explain segments.",
        "Use the supplied title, summary, glossary, and nearby context only to improve terminology and continuity.",
      ].join(" ");
    }

    async function readCache(identity, settings) {
      if (!identity.videoId || !identity.sourceHash) return { key: "", translations: {} };
      const key = core.translationStorageKey(
        identity.videoId,
        identity.sourceHash,
        settings.aiModel,
      );
      const stored = await storage.get(key);
      return { key, translations: stored[key]?.translations || {} };
    }

    async function mergeCache(key, identity, settings, additions) {
      if (!key || !Object.keys(additions).length) return;
      const previous = storageLocks.get(key) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const stored = await storage.get(key);
        const current = stored[key] || {};
        await storage.set({
          [key]: {
            ...current,
            videoId: identity.videoId,
            sourceHash: identity.sourceHash,
            targetLanguage: "zh",
            model: settings.aiModel,
            translations: { ...(current.translations || {}), ...additions },
            timestamp: Date.now(),
          },
        });
      });
      storageLocks.set(key, operation);
      try {
        await operation;
      } finally {
        if (storageLocks.get(key) === operation) storageLocks.delete(key);
      }
    }

    async function requestMissing(message, missing, signal) {
      const profile = message.profile === "prefetched" ? "prefetched" : "semantic";
      const systemPrompt = profile === "prefetched"
        ? prefetchedPrompt(message)
        : await semanticPrompt(message);
      const userPayload = profile === "prefetched"
        ? {
            title: message.videoTitle || "",
            summary: message.context?.summary || "",
            glossary: message.context?.glossary || [],
            nearbyContext: message.context?.nearbyContext || [],
            segments: missing.map(({ id, text }) => ({ id, text })),
          }
        : { segments: missing.map(({ id, text }) => ({ id, text })) };
      let bestRows = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const options = {
            signal,
            temperature: profile === "prefetched" ? 0.1 : 0.2,
            maxTokens: profile === "prefetched" ? 2400 : 1536,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: JSON.stringify(userPayload) },
            ],
          };
          if (!(lastError?.code === "EMPTY_AI_RESPONSE")) {
            options.responseFormat = { type: "json_object" };
          }
          const { text } = await requestAiCompletion(options);
          const rows = core.alignModelResult(
            core.parseModelJson(text),
            missing,
          );
          bestRows = rows;
          if (rows.every((row) => row.text)) return rows;
          const error = new Error("Translation did not preserve every requested segment ID.");
          error.code = "INVALID_TRANSLATION_RESPONSE";
          throw error;
        } catch (error) {
          lastError = error;
          if (signal?.aborted || error?.name === "AbortError" || error?.code === "NO_AI_KEY") throw error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
      if (bestRows?.some((row) => row.text)) return bestRows;
      throw lastError || new Error("Translation failed");
    }

    async function translateTranscriptBatch(message, { signal } = {}) {
      const profile = message?.profile === "prefetched" ? "prefetched" : "semantic";
      const sourceSegments = core.validateBatch(
        message?.segments,
        { maxSegments: profile === "prefetched" ? 6 : 4 },
      );
      const settings = await getSettings();
      const identity = {
        videoId: String(message.videoId || ""),
        sourceHash: String(message.sourceHash || ""),
      };
      const cache = await readCache(identity, settings);
      const rowsById = new Map();
      const missing = [];
      for (const segment of sourceSegments) {
        const itemKey = cache.key
          ? core.translationItemKey(
              identity.videoId,
              identity.sourceHash,
              settings.aiModel,
              segment.transcriptId,
            )
          : "";
        const cachedText = typeof cache.translations[itemKey] === "string"
          ? cache.translations[itemKey].trim()
          : "";
        if (cachedText && core.isValidChinese(cachedText, segment.text)) {
          rowsById.set(segment.id, { id: segment.id, text: cachedText, error: "", cached: true });
        } else {
          missing.push(segment);
        }
      }

      if (missing.length) {
        if (!settings.aiApiKey) {
          const error = new Error("DeepSeek API key not configured");
          error.code = "NO_AI_KEY";
          throw error;
        }
        const translated = await requestMissing(message, missing, signal);
        const additions = {};
        for (const row of translated) {
          rowsById.set(row.id, row);
          const source = missing.find((segment) => segment.id === row.id);
          if (cache.key && source && row.text) {
            additions[core.translationItemKey(
              identity.videoId,
              identity.sourceHash,
              settings.aiModel,
              source.transcriptId,
            )] = row.text;
          }
        }
        await mergeCache(cache.key, identity, settings, additions);
      }

      return sourceSegments.map((segment) => rowsById.get(segment.id) || ({
        id: segment.id,
        text: "",
        error: "Translation unavailable",
        cached: false,
      }));
    }

    return { translateTranscriptBatch };
  }

  return { createService };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_TRANSCRIPT_TRANSLATION_BACKGROUND;
}
