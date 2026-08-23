/**
 * Pure transcript-translation contracts shared by the panel, background, and
 * Node tests. This module deliberately contains no Chrome or network APIs.
 */
var YTD_TRANSCRIPT_TRANSLATION = (() => {
  const STABLE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

  function stableId(value) {
    const id = typeof value === "string" ? value.trim() : "";
    return STABLE_ID_PATTERN.test(id) ? id : "";
  }

  function validateBatch(segments, { maxSegments = 8 } = {}) {
    if (!Array.isArray(segments) || segments.length < 1 || segments.length > maxSegments) {
      throw new Error(`Transcript translation requires 1 to ${maxSegments} segments`);
    }
    const seenIds = new Set();
    let totalCharacters = 0;
    const normalized = segments.map((segment) => {
      const id = stableId(segment?.id);
      const transcriptId = segment?.transcriptId == null
        ? id
        : stableId(segment.transcriptId);
      const text = typeof segment?.text === "string"
        ? segment.text.trim()
        : String(segment?.sourceText || "").trim();
      if (!id || !transcriptId || seenIds.has(id)) {
        throw new Error("Transcript translation segment IDs must be unique and stable");
      }
      if (!text || text.length > 4000) {
        throw new Error("Transcript translation segment text is invalid or too long");
      }
      seenIds.add(id);
      totalCharacters += text.length;
      return { id, transcriptId, text };
    });
    if (totalCharacters > 16000) {
      throw new Error("Transcript translation batch is too large");
    }
    return normalized;
  }

  function parseModelJson(text) {
    let cleaned = String(text || "").trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    }
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    try {
      return JSON.parse(cleaned);
    } catch (_error) {
      return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
    }
  }

  function isValidChinese(text, sourceText) {
    const value = String(text || "").trim();
    if (!value) return false;
    const latinLetters = (String(sourceText || "").match(/[A-Za-z]/g) || []).length;
    return latinLetters < 20 || /[\u3400-\u9fff]/.test(value);
  }

  /**
   * Align untrusted model output by exact ID. Duplicate IDs invalidate that
   * row; unknown IDs are ignored; every source row is always returned.
   */
  function alignModelResult(parsed, sourceSegments) {
    const sources = validateBatch(sourceSegments);
    const sourceById = new Map(sources.map((segment) => [segment.id, segment]));
    const values = new Map();
    const seenCandidates = new Set();
    const duplicated = new Set();
    const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
    for (const candidate of candidates) {
      const id = stableId(candidate?.id);
      if (!id || !sourceById.has(id) || typeof candidate?.text !== "string") continue;
      if (seenCandidates.has(id)) {
        duplicated.add(id);
        values.delete(id);
        continue;
      }
      seenCandidates.add(id);
      if (duplicated.has(id)) continue;
      const text = candidate.text.trim();
      if (isValidChinese(text, sourceById.get(id).text)) values.set(id, text);
    }
    return sources.map((source) => ({
      id: source.id,
      text: values.get(source.id) || "",
      error: values.has(source.id) ? "" : "Missing or invalid Chinese translation",
      cached: false,
    }));
  }

  function translationStorageKey(videoId, sourceHash, model) {
    return `ytd_translation_v2_${videoId}_${sourceHash}_zh_${model}`;
  }

  function translationItemKey(videoId, sourceHash, model, transcriptId) {
    return `${videoId}:${sourceHash}:zh:${model}:semantic:${transcriptId}`;
  }

  return {
    alignModelResult,
    isValidChinese,
    parseModelJson,
    stableId,
    translationItemKey,
    translationStorageKey,
    validateBatch,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_TRANSCRIPT_TRANSLATION;
}
