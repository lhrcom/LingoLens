(function initDeepSeekTranslatorCore(global) {
  "use strict";

  const MAX_BATCH_ITEMS = 20;
  const MAX_BATCH_CHARS = 6000;
  const MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];
  const EXCLUDED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "PRE",
    "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "NAV", "FOOTER", "ASIDE"
  ]);

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function hasEnglish(value) {
    return /[A-Za-z]/.test(normalizeText(value));
  }

  function isExcludedTag(tagName) {
    return EXCLUDED_TAGS.has(String(tagName || "").toUpperCase());
  }

  function shouldExcludeElementDescriptor(descriptor) {
    if (!descriptor) return true;
    if (descriptor.generated || descriptor.hidden || descriptor.ariaHidden || descriptor.contentEditable) {
      return true;
    }
    return (descriptor.ancestorTags || []).some(isExcludedTag);
  }

  function batchSegments(segments, options = {}) {
    const maxItems = options.maxItems || MAX_BATCH_ITEMS;
    const maxChars = options.maxChars || MAX_BATCH_CHARS;
    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const segment of segments || []) {
      const text = normalizeText(segment && segment.text);
      if (!segment || !segment.id || !text) continue;
      const normalized = { id: String(segment.id), text };
      const size = text.length;
      if (current.length && (current.length >= maxItems || currentChars + size > maxChars)) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(normalized);
      currentChars += size;
      if (current.length >= maxItems || currentChars >= maxChars) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
    }
    if (current.length) batches.push(current);
    return batches;
  }

  function deduplicateSegments(segments) {
    const unique = [];
    const groups = new Map();
    for (const segment of segments || []) {
      if (!segment || !segment.id) continue;
      const text = normalizeText(segment.text);
      if (!text) continue;
      if (!groups.has(text)) {
        groups.set(text, []);
        unique.push({ id: String(segment.id), text });
      }
      groups.get(text).push(String(segment.id));
    }
    return {
      unique,
      groups: unique.map((item) => ({ representativeId: item.id, sourceIds: groups.get(item.text) }))
    };
  }

  function parseTranslationResponse(content, expectedSegments) {
    let parsed;
    try {
      parsed = typeof content === "string" ? JSON.parse(content) : content;
    } catch (_error) {
      throw new Error("DeepSeek 返回的内容不是有效 JSON");
    }
    if (!parsed || !Array.isArray(parsed.translations)) {
      throw new Error("DeepSeek 返回的数据缺少 translations 数组");
    }

    const expected = new Set((expectedSegments || []).map((item) => String(item.id)));
    const seen = new Set();
    const translations = [];
    for (const item of parsed.translations) {
      const id = item && String(item.id || "");
      const text = normalizeText(item && item.text);
      if (!expected.has(id) || seen.has(id) || !text) continue;
      seen.add(id);
      translations.push({ id, text });
    }
    const missingIds = [...expected].filter((id) => !seen.has(id));
    return { translations, missingIds };
  }

  function classifyHttpError(status) {
    if (status === 401 || status === 403) {
      return { code: "AUTH", retryable: false, message: "API Key 无效或没有访问权限" };
    }
    if (status === 429) {
      return { code: "RATE_LIMIT", retryable: true, message: "DeepSeek 请求过于频繁，请稍后重试" };
    }
    if (status >= 500) {
      return { code: "SERVER", retryable: true, message: "DeepSeek 服务暂时不可用" };
    }
    return { code: "API", retryable: false, message: `DeepSeek 请求失败（HTTP ${status}）` };
  }

  function isRetryableError(error) {
    return Boolean(error && error.retryable);
  }

  function retryDelay(attempt) {
    return Math.min(4000, 1000 * (2 ** Math.max(0, attempt)));
  }

  function safeModel(value) {
    return MODELS.includes(value) ? value : MODELS[0];
  }

  const core = {
    MAX_BATCH_ITEMS,
    MAX_BATCH_CHARS,
    MODELS,
    normalizeText,
    hasEnglish,
    isExcludedTag,
    shouldExcludeElementDescriptor,
    batchSegments,
    deduplicateSegments,
    parseTranslationResponse,
    classifyHttpError,
    isRetryableError,
    retryDelay,
    safeModel
  };

  global.YTD_PAGE_TRANSLATION_CORE = core;
  if (typeof module !== "undefined" && module.exports) module.exports = core;
})(globalThis);
