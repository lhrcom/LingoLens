/**
 * Pure helpers shared by the live-caption UI and tests.
 * This file deliberately contains no credentials or Chrome API calls.
 */
var YTD_LIVE_CAPTIONS = (() => {
  const SESSION_STORAGE_PREFIX = "caption_session_";
  const SESSION_INDEX_KEY = "caption_session_index";
  const MAX_SAVED_SESSIONS = 20;
  const OVERLAY_PREFERENCES_KEY = "caption_overlay_preferences";
  const OVERLAY_WIDTH_PRESETS = Object.freeze({
    narrow: 0.56,
    standard: 0.72,
    wide: 0.88,
  });
  const OVERLAY_WIDTH_MAX_PIXELS = Object.freeze({
    narrow: 560,
    standard: 720,
    wide: 880,
  });
  const DEFAULT_OVERLAY_PREFERENCES = Object.freeze({
    version: 1,
    fontScale: 1,
    widthPreset: "standard",
    xRatio: 0.5,
    yRatio: 0.86,
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizedPageUrl(url) {
    try {
      const parsed = new URL(url || "");
      parsed.hash = "";
      return parsed.href;
    } catch (_error) {
      return String(url || "");
    }
  }

  function youtubeVideoId(url) {
    try {
      const parsed = new URL(url || "");
      if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1);
      if (
        parsed.hostname === "youtube.com" ||
        parsed.hostname.endsWith(".youtube.com")
      ) {
        if (parsed.searchParams.has("v")) return parsed.searchParams.get("v");
        if (parsed.pathname.startsWith("/embed/")) return parsed.pathname.split("/")[2];
      }
    } catch (_error) {
      return "";
    }
    return "";
  }

  function pageContextKey(tabId, url) {
    const videoId = youtubeVideoId(url);
    return `${tabId || "none"}:${videoId ? `youtube:${videoId}` : normalizedPageUrl(url)}`;
  }

  async function retryWithDelays(
    delays,
    attempt,
    {
      isCurrent = () => true,
      wait = (delayMs) =>
        delayMs
          ? new Promise((resolve) => setTimeout(resolve, delayMs))
          : Promise.resolve(),
    } = {},
  ) {
    let lastError = null;
    for (const delayMs of delays || []) {
      await wait(Math.max(0, Number(delayMs) || 0));
      if (!isCurrent()) return { cancelled: true, value: null, error: null };
      try {
        return {
          cancelled: false,
          value: await attempt(),
          error: null,
        };
      } catch (error) {
        lastError = error;
      }
    }
    return { cancelled: false, value: null, error: lastError };
  }

  function normalizeOverlayPreferences(input = {}) {
    const fontScale = Math.round(Number(input.fontScale) * 10) / 10;
    const xRatio = Number(input.xRatio);
    const yRatio = Number(input.yRatio);
    const widthPreset = Object.hasOwn(OVERLAY_WIDTH_PRESETS, input.widthPreset)
      ? input.widthPreset
      : DEFAULT_OVERLAY_PREFERENCES.widthPreset;
    return {
      version: DEFAULT_OVERLAY_PREFERENCES.version,
      fontScale: Number.isFinite(fontScale) ? clamp(fontScale, 0.7, 1.3) : 1,
      widthPreset,
      xRatio: clamp(
        Number.isFinite(xRatio) ? xRatio : DEFAULT_OVERLAY_PREFERENCES.xRatio,
        0,
        1,
      ),
      yRatio: clamp(
        Number.isFinite(yRatio) ? yRatio : DEFAULT_OVERLAY_PREFERENCES.yRatio,
        0,
        1,
      ),
    };
  }

  function nextOverlayWidthPreset(current) {
    const presets = Object.keys(OVERLAY_WIDTH_PRESETS);
    const index = presets.indexOf(current);
    return presets[(index + 1 + presets.length) % presets.length];
  }

  function resolveOverlayPosition(
    preferences,
    viewportWidth,
    viewportHeight,
    overlayWidth,
    overlayHeight,
    { margin = 8, toolbarSpace = 40 } = {},
  ) {
    const normalized = normalizeOverlayPreferences(preferences);
    const width = Math.max(0, Number(viewportWidth) || 0);
    const height = Math.max(0, Number(viewportHeight) || 0);
    const halfOverlayWidth = Math.min(width / 2, Math.max(0, Number(overlayWidth) || 0) / 2);
    const halfOverlayHeight = Math.min(height / 2, Math.max(0, Number(overlayHeight) || 0) / 2);
    const minimumX = Math.min(width / 2, margin + halfOverlayWidth);
    const maximumX = Math.max(minimumX, width - margin - halfOverlayWidth);
    const minimumY = Math.min(height / 2, margin + toolbarSpace + halfOverlayHeight);
    const maximumY = Math.max(minimumY, height - margin - halfOverlayHeight);
    const left = clamp(normalized.xRatio * width, minimumX, maximumX);
    const top = clamp(normalized.yRatio * height, minimumY, maximumY);
    return {
      left,
      top,
      xRatio: width ? left / width : normalized.xRatio,
      yRatio: height ? top / height : normalized.yRatio,
    };
  }

  function createSession({
    tabId,
    url,
    title,
    mode,
    videoId = "",
    transcriptVideoId = "",
    transcriptSourceHash = "",
  }) {
    const startedAt = Date.now();
    return {
      id: `caption-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
      tabId,
      url: String(url || ""),
      title: String(title || "Untitled video"),
      mode: mode === "prefetched" ? "prefetched" : "live",
      status: "starting",
      source: mode === "prefetched" ? "video subtitles" : "Deepgram Nova-3",
      videoId,
      transcriptVideoId: String(transcriptVideoId || ""),
      transcriptSourceHash: String(transcriptSourceHash || ""),
      startedAt,
      updatedAt: startedAt,
      segments: [],
      gaps: [],
      error: "",
    };
  }

  function normalizeSegment(input, source = "live") {
    const startMs = Math.max(0, Math.round(Number(input?.startMs) || 0));
    const endMs = Math.max(
      startMs + 1,
      Math.round(Number(input?.endMs) || startMs + 1),
    );
    return {
      id: String(input?.id || `${source}-${startMs}`),
      transcriptId: String(input?.transcriptId || ""),
      startMs,
      endMs,
      sourceText: String(input?.sourceText || input?.text || "").trim(),
      translationText: String(input?.translationText || "").trim(),
      recognitionState:
        input?.recognitionState === "interim" ? "interim" : "final",
      translationState: [
        "queued",
        "streaming",
        "translated",
        "revised",
        "error",
      ].includes(input?.translationState)
        ? input.translationState
        : "queued",
      source: String(input?.source || source),
      error: String(input?.error || ""),
    };
  }

  function upsertSegment(segments, input) {
    const segment = normalizeSegment(input, input?.source || "live");
    const next = Array.isArray(segments) ? [...segments] : [];
    const index = next.findIndex((item) => item.id === segment.id);
    if (index === -1) next.push(segment);
    else next[index] = { ...next[index], ...segment };
    next.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    return next;
  }

  /**
   * Fold Deepgram's interim and chunk-final Results into one utterance. A
   * chunk with is_final=true is stable recognition, but only speech_final
   * closes the utterance and makes it safe to translate.
   */
  function mergeDeepgramResult(state, payload, connectionBaseMs = 0) {
    const alternative = payload?.channel?.alternatives?.[0];
    const text = String(alternative?.transcript || "").trim();
    const speechFinal = !!payload?.speech_final;
    if (!text && !speechFinal) return null;

    state.finalParts ||= [];
    const startMs = Math.max(
      0,
      Math.round(Number(connectionBaseMs || 0) + Number(payload?.start || 0) * 1000),
    );
    const durationMs = Math.max(250, Math.round(Number(payload?.duration || 0) * 1000));
    const endMs = startMs + durationMs;
    if (state.utteranceStartMs == null && text) state.utteranceStartMs = startMs;

    if (payload?.is_final && text) {
      const joined = state.finalParts.map((part) => part.text).join(" ");
      const last = state.finalParts.at(-1)?.text || "";
      if (!joined) state.finalParts.push({ text, endMs });
      else if (text === last || joined.endsWith(text)) {
        state.finalParts.at(-1).endMs = Math.max(state.finalParts.at(-1).endMs, endMs);
      } else if (text.startsWith(joined)) {
        state.finalParts = [{ text, endMs }];
      } else {
        state.finalParts.push({ text, endMs });
      }
    }

    const parts = state.finalParts.map((part) => part.text);
    if (!payload?.is_final && text) parts.push(text);
    const sourceText = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!sourceText) return null;
    const utteranceStartMs = state.utteranceStartMs ?? startMs;
    const utteranceEndMs = Math.max(
      endMs,
      ...state.finalParts.map((part) => part.endMs),
    );
    const segment = {
      id: `live-${utteranceStartMs}`,
      startMs: utteranceStartMs,
      endMs: utteranceEndMs,
      sourceText,
      recognitionState: speechFinal ? "final" : "interim",
      speechFinal,
      confidence: Number(alternative?.confidence || 0),
    };
    if (speechFinal) {
      state.finalParts = [];
      state.utteranceStartMs = null;
    }
    return segment;
  }

  function activeSegmentAt(segments, currentMs) {
    const time = Math.max(0, Number(currentMs) || 0);
    let active = null;
    for (const segment of segments || []) {
      if (segment.startMs <= time && time < segment.endMs) active = segment;
      if (segment.startMs > time) break;
    }
    return active;
  }

  /**
   * Keep only videos that can actually be watched, prefer the YouTube main
   * player, and collapse DOM duplicates that point at the same media.
   */
  function rankVideoCandidates(candidates, { youtube = false } = {}) {
    const eligible = (Array.isArray(candidates) ? candidates : [])
      .filter(
        (item) =>
          item &&
          item.connected !== false &&
          item.displayVisible !== false &&
          Number(item.visibleArea || 0) >= 4_096,
      );
    const youtubeMain = youtube && eligible.some((item) => item.isMainPlayer)
      ? eligible.filter((item) => item.isMainPlayer)
      : eligible;
    const sorted = [...youtubeMain].sort(
      (a, b) =>
        Number(!!b.isMainPlayer) - Number(!!a.isMainPlayer) ||
        Number(!!a.paused) - Number(!!b.paused) ||
        Number(b.visibleArea || 0) - Number(a.visibleArea || 0),
    );
    const seen = new Set();
    return sorted.filter((item) => {
      const source = String(item.currentSrc || "").trim();
      const duration = Number.isFinite(Number(item.duration))
        ? Math.round(Number(item.duration))
        : 0;
      const key = source ? `${source}\n${duration}` : `element:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Split text into complete, ordered pages using a caller-supplied layout
   * check. The browser uses a hidden two-line measurer; tests can use a
   * deterministic character limit.
   */
  function paginateCaptionText(text, fits) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    if (typeof fits !== "function" || fits(normalized)) return [normalized];
    const characters = Array.from(normalized);
    const pages = [];
    let start = 0;

    while (start < characters.length) {
      while (characters[start] === " ") start += 1;
      if (start >= characters.length) break;
      let low = start + 1;
      let high = characters.length;
      let maximum = start;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = characters.slice(start, middle).join("").trim();
        if (candidate && fits(candidate)) {
          maximum = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (maximum <= start) maximum = start + 1;

      let cut = maximum;
      if (maximum < characters.length) {
        const lowerBound = start + Math.floor((maximum - start) * 0.55);
        for (const punctuation of [/[.!?。！？]/, /[,;:，；：]/, /\s/]) {
          for (let index = maximum - 1; index >= lowerBound; index -= 1) {
            if (punctuation.test(characters[index])) {
              cut = index + 1;
              break;
            }
          }
          if (cut !== maximum) break;
        }
      }
      const page = characters.slice(start, cut).join("").trim();
      if (page) pages.push(page);
      start = cut;
    }
    return pages;
  }

  function captionPageIndex({
    pageCount,
    mode,
    startMs = 0,
    endMs = 0,
    currentMs = 0,
    firstSeenMs = 0,
    nowMs = Date.now(),
    livePageMs = 2_600,
  }) {
    const count = Math.max(1, Math.floor(Number(pageCount) || 1));
    if (count === 1) return 0;
    if (mode === "live") {
      return Math.min(
        count - 1,
        Math.floor(Math.max(0, Number(nowMs) - Number(firstSeenMs)) / livePageMs),
      );
    }
    const duration = Math.max(1, Number(endMs) - Number(startMs));
    const progress = clamp((Number(currentMs) - Number(startMs)) / duration, 0, 0.999999);
    return Math.min(count - 1, Math.floor(progress * count));
  }

  function formatTimestamp(ms, includeHours = true) {
    const totalMs = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1000);
    const millis = totalMs % 1000;
    const body = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return `${includeHours ? `${String(hours).padStart(2, "0")}:` : ""}${body}.${String(millis).padStart(3, "0")}`;
  }

  function exportSrt(session) {
    return (session?.segments || [])
      .filter((segment) => segment.recognitionState === "final")
      .map((segment, index) => {
        const start = formatTimestamp(segment.startMs).replace(".", ",");
        const end = formatTimestamp(segment.endMs).replace(".", ",");
        const lines = [segment.sourceText, segment.translationText].filter(Boolean);
        return `${index + 1}\n${start} --> ${end}\n${lines.join("\n")}`;
      })
      .join("\n\n");
  }

  function exportVtt(session) {
    const cues = (session?.segments || [])
      .filter((segment) => segment.recognitionState === "final")
      .map((segment) => {
        const lines = [segment.sourceText, segment.translationText].filter(Boolean);
        return `${formatTimestamp(segment.startMs)} --> ${formatTimestamp(segment.endMs)}\n${lines.join("\n")}`;
      })
      .join("\n\n");
    return `WEBVTT\n\n${cues}`;
  }

  function escapeMarkdownCell(value) {
    return String(value || "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, "<br>");
  }

  function exportMarkdown(session) {
    const heading = `# ${String(session?.title || "Live captions").replace(/\r?\n/g, " ")}`;
    const meta = session?.url ? `\n\n${session.url}` : "";
    const rows = (session?.segments || [])
      .filter((segment) => segment.recognitionState === "final")
      .map(
        (segment) =>
          `| ${formatTimestamp(segment.startMs, false).slice(0, 5)} | ${escapeMarkdownCell(segment.sourceText)} | ${escapeMarkdownCell(segment.translationText)} |`,
      );
    return `${heading}${meta}\n\n| Time | English | 简体中文 |\n| --- | --- | --- |\n${rows.join("\n")}`;
  }

  function sessionStorageKey(sessionId) {
    return `${SESSION_STORAGE_PREFIX}${sessionId}`;
  }

  function pruneSessionIndex(index, max = MAX_SAVED_SESSIONS) {
    return [...new Set(Array.isArray(index) ? index : [])].slice(0, max);
  }

  return {
    DEFAULT_OVERLAY_PREFERENCES,
    MAX_SAVED_SESSIONS,
    OVERLAY_PREFERENCES_KEY,
    OVERLAY_WIDTH_MAX_PIXELS,
    OVERLAY_WIDTH_PRESETS,
    SESSION_INDEX_KEY,
    SESSION_STORAGE_PREFIX,
    activeSegmentAt,
    captionPageIndex,
    createSession,
    exportMarkdown,
    exportSrt,
    exportVtt,
    formatTimestamp,
    mergeDeepgramResult,
    nextOverlayWidthPreset,
    normalizeSegment,
    normalizeOverlayPreferences,
    normalizedPageUrl,
    pageContextKey,
    paginateCaptionText,
    pruneSessionIndex,
    retryWithDelays,
    rankVideoCandidates,
    resolveOverlayPosition,
    sessionStorageKey,
    upsertSegment,
    youtubeVideoId,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_LIVE_CAPTIONS;
}
