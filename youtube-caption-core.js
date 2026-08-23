(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YTD_YOUTUBE_CAPTIONS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function trackName(track) {
    return String(track?.name?.simpleText || track?.name?.runs?.map((run) => run.text).join("") || "");
  }

  function trackScore(track) {
    const language = String(track?.languageCode || "").toLowerCase();
    const english = language === "en" || language.startsWith("en-");
    const automatic = track?.kind === "asr";
    if (english && !automatic) return 400;
    if (english && automatic) return 300;
    if (!automatic) return 200;
    return 100;
  }

  function chooseTrack(tracks) {
    return orderedEnglishTracks(tracks)[0] || null;
  }

  function orderedEnglishTracks(tracks) {
    return (Array.isArray(tracks) ? tracks : [])
      .filter((track) => {
        const language = String(track?.languageCode || "").toLowerCase();
        return (
          typeof track?.baseUrl === "string" &&
          track.baseUrl &&
          (language === "en" || language.startsWith("en-"))
        );
      })
      .map((track, index) => ({ track, index, score: trackScore(track) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ track }) => track);
  }

  function extractTracks(playerResponse, expectedVideoId) {
    const actualVideoId = String(playerResponse?.videoDetails?.videoId || "");
    if (!actualVideoId || (expectedVideoId && actualVideoId !== expectedVideoId)) {
      return { success: false, error: "VIDEO_CONTEXT_CHANGED", videoId: actualVideoId };
    }
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return {
      success: true,
      videoId: actualVideoId,
      duration: Math.max(
        0,
        Number(playerResponse?.videoDetails?.lengthSeconds) || 0,
      ),
      tracks: Array.isArray(tracks)
        ? tracks.map((track) => ({
            baseUrl: track.baseUrl,
            languageCode: track.languageCode || "",
            kind: track.kind || "",
            name: trackName(track),
            isTranslatable: !!track.isTranslatable,
          }))
        : [],
    };
  }

  function cleanCaptionText(value) {
    return String(value || "")
      .replace(/\n+/g, " ")
      .replace(/>> ?/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseJson3(payload, language) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const segments = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const text = cleanCaptionText(
        Array.isArray(event?.segs) ? event.segs.map((segment) => segment?.utf8 || "").join("") : "",
      );
      if (!text) continue;
      const offset = Math.max(0, Number(event.tStartMs) || 0);
      const nextOffset = Number(events[index + 1]?.tStartMs);
      const duration = Math.max(
        1,
        Number(event.dDurationMs) || (Number.isFinite(nextOffset) ? nextOffset - offset : 1000),
      );
      const previous = segments.at(-1);
      if (previous && text === previous.text) {
        previous.duration = Math.max(previous.duration, offset + duration - previous.offset);
        continue;
      }
      if (
        previous &&
        offset - previous.offset < 5000 &&
        text.startsWith(previous.text)
      ) {
        previous.text = text;
        previous.duration = Math.max(previous.duration, offset + duration - previous.offset);
        previous.sourceSegmentIds.push(`event-${index}`);
        continue;
      }
      segments.push({
        text,
        offset,
        duration,
        lang: language || null,
        sourceSegmentIds: [`event-${index}`],
      });
    }
    return segments;
  }

  function rendererText(value) {
    if (typeof value === "string") return cleanCaptionText(value);
    if (!value || typeof value !== "object") return "";
    if (typeof value.simpleText === "string") {
      return cleanCaptionText(value.simpleText);
    }
    if (Array.isArray(value.runs)) {
      return cleanCaptionText(value.runs.map((run) => run?.text || "").join(""));
    }
    return "";
  }

  function walkJson(root, visitor, maxNodes = 100_000) {
    const stack = [root];
    const seen = new Set();
    let visited = 0;
    while (stack.length && visited < maxNodes) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      visitor(value);
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push(value[index]);
        }
      } else {
        const values = Object.values(value);
        for (let index = values.length - 1; index >= 0; index -= 1) {
          stack.push(values[index]);
        }
      }
    }
  }

  function transcriptRequestDescriptor(value) {
    if (!value || typeof value !== "object") return null;
    const endpoint =
      value.continuationEndpoint ||
      value.serviceEndpoint ||
      value.navigationEndpoint ||
      value;
    const params = endpoint?.getTranscriptEndpoint?.params;
    if (typeof params === "string" && params) {
      return { params };
    }
    const continuation =
      endpoint?.continuationCommand?.token ||
      endpoint?.reloadContinuationData?.continuation ||
      value?.continuation?.reloadContinuationData?.continuation;
    if (typeof continuation === "string" && continuation) {
      return { continuation };
    }
    return null;
  }

  function extractTranscriptEndpoint(payload) {
    let found = null;
    walkJson(payload, (value) => {
      if (found) return;
      const descriptor = transcriptRequestDescriptor(value);
      if (
        descriptor?.params &&
        (value?.getTranscriptEndpoint ||
          value?.continuationEndpoint?.getTranscriptEndpoint ||
          value?.serviceEndpoint?.getTranscriptEndpoint)
      ) {
        found = descriptor;
      }
    });
    return found;
  }

  function extractTranscriptLanguageOptions(payload) {
    const options = [];
    const keys = new Set();
    walkJson(payload, (value) => {
      const items = Array.isArray(value?.subMenuItems)
        ? value.subMenuItems
        : Array.isArray(value?.dropdownItems)
          ? value.dropdownItems
          : null;
      if (!items) return;
      for (const rawItem of items) {
        const item = rawItem?.dropdownItemRenderer || rawItem;
        const label = rendererText(item?.title || item?.label || item?.text);
        const descriptor = transcriptRequestDescriptor(item);
        if (!label || !descriptor) continue;
        const key = `${label}:${descriptor.params || descriptor.continuation || ""}`;
        if (keys.has(key)) continue;
        keys.add(key);
        options.push({
          label,
          selected: !!item?.selected,
          languageCode: String(item?.languageCode || ""),
          ...descriptor,
        });
      }
    });
    return options;
  }

  function isAutomaticCaptionLabel(value) {
    return /(auto(?:matically)?[- ]generated|automatic captions?|\basr\b|自动生成)/i.test(
      String(value || ""),
    );
  }

  function chooseEnglishTranscriptOption(options, tracks) {
    const englishTracks = orderedEnglishTracks(tracks);
    const normalizedTracks = englishTracks.map((track) => ({
      track,
      name: cleanCaptionText(track.name).toLowerCase(),
      languageCode: String(track.languageCode || "").toLowerCase(),
    }));
    const candidates = [];
    for (const [index, option] of (Array.isArray(options) ? options : []).entries()) {
      const label = cleanCaptionText(option?.label).toLowerCase();
      const languageCode = String(option?.languageCode || "").toLowerCase();
      const matchingTrack = normalizedTracks.find(({ name }) =>
        name && (name === label || name.includes(label) || label.includes(name)),
      ) || normalizedTracks.find(({ languageCode: code }) =>
        languageCode && code === languageCode,
      );
      const english =
        !!matchingTrack ||
        languageCode === "en" ||
        languageCode.startsWith("en-") ||
        /(^|\W)english(\W|$)/i.test(label);
      if (!english) continue;
      const automatic = matchingTrack
        ? matchingTrack.track.kind === "asr"
        : isAutomaticCaptionLabel(label);
      candidates.push({
        option,
        track: matchingTrack?.track || null,
        score: automatic ? 300 : 400,
        index,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    return candidates[0] || null;
  }

  function parseTranscriptApiSegments(payload, language) {
    const segments = [];
    const segmentKeys = new Set();
    const continuations = [];
    const continuationKeys = new Set();

    const addSegment = (renderer, type) => {
      const text = rendererText(
        type === "cue"
          ? renderer?.cue || renderer?.snippet || renderer?.text
          : renderer?.snippet || renderer?.cue || renderer?.text,
      );
      if (!text) return;
      const offset = Math.max(
        0,
        Number(
          renderer?.startMs ??
          renderer?.startOffsetMs ??
          renderer?.startTimeMs ??
          0,
        ) || 0,
      );
      const explicitDuration = Number(
        renderer?.durationMs ?? renderer?.duration ?? 0,
      );
      const end = Number(renderer?.endMs ?? renderer?.endTimeMs ?? 0);
      const duration = Math.max(
        1,
        explicitDuration || (Number.isFinite(end) && end > offset ? end - offset : 1000),
      );
      const key = `${offset}:${duration}:${text}`;
      if (segmentKeys.has(key)) return;
      segmentKeys.add(key);
      segments.push({
        text,
        offset,
        duration,
        lang: language || null,
        sourceSegmentIds: [`transcript-${segments.length}`],
      });
    };

    walkJson(payload, (value) => {
      if (value?.transcriptSegmentRenderer) {
        addSegment(value.transcriptSegmentRenderer, "segment");
      }
      if (value?.transcriptCueRenderer) {
        addSegment(value.transcriptCueRenderer, "cue");
      }
      const list =
        value?.transcriptSegmentListRenderer ||
        value?.transcriptSegmentListContinuation;
      if (!list) return;
      const items = [
        ...(Array.isArray(list.initialSegments) ? list.initialSegments : []),
        ...(Array.isArray(list.contents) ? list.contents : []),
        ...(Array.isArray(list.continuationItems) ? list.continuationItems : []),
      ];
      for (const item of items) {
        const descriptor = transcriptRequestDescriptor(item?.continuationItemRenderer);
        if (!descriptor) continue;
        const key = descriptor.params || descriptor.continuation;
        if (!key || continuationKeys.has(key)) continue;
        continuationKeys.add(key);
        continuations.push(descriptor);
      }
    });

    segments.sort((a, b) => a.offset - b.offset);
    return { segments, continuations };
  }

  function parseTimestampSeconds(value) {
    const text = String(value || "").trim();
    if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) return null;
    const parts = text.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 2) {
      if (parts[1] >= 60) return null;
      return parts[0] * 60 + parts[1];
    }
    if (parts[1] >= 60 || parts[2] >= 60) return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  const NATIVE_TIME_SCALES = [1, 1000, 0.001];

  function nativeTimeCandidate(rawValue, visibleMilliseconds, preferredScale = null) {
    if (rawValue === null || rawValue === undefined || rawValue === "") return null;
    const raw = Number(rawValue);
    if (!Number.isFinite(raw) || raw < 0) return null;
    const scales = preferredScale
      ? [preferredScale, ...NATIVE_TIME_SCALES.filter((scale) => scale !== preferredScale)]
      : NATIVE_TIME_SCALES;
    if (!Number.isFinite(visibleMilliseconds)) {
      return preferredScale ? { milliseconds: raw * preferredScale, scale: preferredScale } : null;
    }
    let best = null;
    for (const scale of scales) {
      const milliseconds = raw * scale;
      const error = Math.abs(milliseconds - visibleMilliseconds);
      if (!best || error < best.error) best = { milliseconds, scale, error };
    }
    // YouTube's visible transcript time is rounded to a whole second. If no
    // numeric interpretation agrees with it, the visible timestamp is safer.
    if (!best || best.error > 1500) return null;
    return best;
  }

  function inferNativeTimeScale(rows, videoDurationSeconds = 0) {
    const anchors = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const raw = Number(row?.startMs);
      const seconds = parseTimestampSeconds(row?.timestamp);
      if (!Number.isFinite(raw) || raw <= 0 || seconds === null) continue;
      anchors.push({ raw, visible: seconds * 1000 });
    }
    if (anchors.length) {
      const ranked = NATIVE_TIME_SCALES.map((scale) => {
        const errors = anchors
          .map(({ raw, visible }) => Math.abs(raw * scale - visible))
          .sort((a, b) => a - b);
        return {
          scale,
          matches: errors.filter((error) => error <= 1500).length,
          medianError: errors[Math.floor(errors.length / 2)] || 0,
        };
      }).sort((a, b) => b.matches - a.matches || a.medianError - b.medianError);
      if (ranked[0]?.matches) return ranked[0].scale;
    }

    const durationMs = Math.max(0, Number(videoDurationSeconds) || 0) * 1000;
    const rawStarts = (Array.isArray(rows) ? rows : [])
      .map((row) => Number(row?.startMs))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const maximum = rawStarts.length ? Math.max(...rawStarts) : 0;
    if (!durationMs || !maximum) return null;
    const candidates = NATIVE_TIME_SCALES
      .map((scale) => ({ scale, maximum: maximum * scale }))
      .filter(({ maximum: scaled }) => scaled <= durationMs * 1.1 + 30_000)
      .sort((a, b) => {
        const aRatio = Math.max(0.000001, a.maximum / durationMs);
        const bRatio = Math.max(0.000001, b.maximum / durationMs);
        return Math.abs(Math.log(aRatio)) - Math.abs(Math.log(bRatio));
      });
    return candidates[0]?.scale || null;
  }

  function normalizeNativeTranscriptRows(rows, language, { videoDuration = 0 } = {}) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    const inferredScale = inferNativeTimeScale(sourceRows, videoDuration);
    const preliminary = [];
    let previousSourceOffset = -1;
    let reversed = false;

    for (const [index, row] of sourceRows.entries()) {
      const text = cleanCaptionText(row?.text);
      if (!text) continue;
      const timestampSeconds = parseTimestampSeconds(row?.timestamp);
      const visibleMilliseconds = timestampSeconds === null ? null : timestampSeconds * 1000;
      const candidate = nativeTimeCandidate(
        row?.startMs,
        visibleMilliseconds,
        inferredScale,
      );
      const offset = candidate?.milliseconds ?? visibleMilliseconds;
      if (!Number.isFinite(offset) || offset < 0) continue;
      if (previousSourceOffset >= 0 && offset + 2000 < previousSourceOffset) reversed = true;
      previousSourceOffset = Math.max(previousSourceOffset, offset);

      const rowScale = candidate?.scale || inferredScale;
      const explicitEnd = rowScale && Number.isFinite(Number(row?.endMs))
        ? Number(row.endMs) * rowScale
        : null;
      const explicitDuration = rowScale && Number.isFinite(Number(row?.durationMs))
        ? Number(row.durationMs) * rowScale
        : null;
      preliminary.push({
        text,
        offset,
        explicitEnd,
        explicitDuration,
        lang: row?.language || language || null,
        sourceSegmentIds: [`native-panel-${index}`],
        sourceOrder: index,
      });
    }

    preliminary.sort((a, b) => a.offset - b.offset || a.sourceOrder - b.sourceOrder);
    const deduplicated = [];
    const keys = new Set();
    for (const item of preliminary) {
      const key = `${Math.round(item.offset)}:${item.text}`;
      if (keys.has(key)) continue;
      keys.add(key);
      deduplicated.push(item);
    }

    // Visible timestamps have whole-second precision. Spread distinct rows
    // sharing the same displayed second across the interval to the next cue so
    // none becomes an unrenderable one-millisecond segment.
    for (let start = 0; start < deduplicated.length;) {
      let end = start + 1;
      while (end < deduplicated.length && deduplicated[end].offset === deduplicated[start].offset) {
        end += 1;
      }
      const count = end - start;
      if (count > 1) {
        const nextDistinct = deduplicated[end]?.offset;
        const available = Number.isFinite(nextDistinct) && nextDistinct > deduplicated[start].offset
          ? nextDistinct - deduplicated[start].offset
          : count * 1000;
        const step = Math.max(1, Math.min(1000, Math.floor(available / count)));
        for (let index = start + 1; index < end; index += 1) {
          deduplicated[index].offset = deduplicated[start].offset + step * (index - start);
        }
      }
      start = end;
    }

    const normalized = deduplicated.map((item, index) => {
      const nextOffset = deduplicated[index + 1]?.offset;
      const explicitEnd = Number(item.explicitEnd);
      const explicitDuration = Number(item.explicitDuration);
      let duration = 0;
      if (Number.isFinite(explicitDuration) && explicitDuration >= 250) {
        duration = explicitDuration;
      } else if (Number.isFinite(explicitEnd) && explicitEnd > item.offset) {
        duration = explicitEnd - item.offset;
      } else if (Number.isFinite(nextOffset) && nextOffset > item.offset) {
        duration = nextOffset - item.offset;
      } else {
        duration = 3000;
      }
      if (Number.isFinite(nextOffset) && nextOffset > item.offset) {
        duration = Math.min(duration, nextOffset - item.offset);
      }
      return {
        text: item.text,
        offset: item.offset,
        duration: Math.max(250, duration),
        lang: item.lang,
        sourceSegmentIds: item.sourceSegmentIds,
      };
    });
    if (reversed) {
      Object.defineProperty(normalized, "timelineError", {
        value: "YOUTUBE_NATIVE_PANEL_INVALID_TIMESTAMPS",
      });
    }
    return normalized;
  }

  function validateNativeTranscriptTimeline(chunks, videoDurationSeconds = 0) {
    if (!Array.isArray(chunks) || !chunks.length) {
      return { success: false, error: "YOUTUBE_NATIVE_PANEL_INVALID_TIMESTAMPS" };
    }
    if (chunks.timelineError) return { success: false, error: chunks.timelineError };
    let previous = -1;
    for (const chunk of chunks) {
      const offset = Number(chunk?.offset);
      const duration = Number(chunk?.duration);
      if (!Number.isFinite(offset) || offset < previous || !Number.isFinite(duration) || duration <= 0) {
        return { success: false, error: "YOUTUBE_NATIVE_PANEL_INVALID_TIMESTAMPS" };
      }
      previous = offset;
    }
    const videoDurationMs = Math.max(0, Number(videoDurationSeconds) || 0) * 1000;
    const finalOffset = Number(chunks.at(-1)?.offset) || 0;
    if (videoDurationMs >= 120_000 && chunks.length >= 8 && finalOffset < 5000) {
      return { success: false, error: "YOUTUBE_NATIVE_PANEL_INVALID_TIMESTAMPS" };
    }
    if (videoDurationMs && finalOffset > videoDurationMs * 1.1 + 30_000) {
      return { success: false, error: "YOUTUBE_NATIVE_PANEL_INVALID_TIMESTAMPS" };
    }
    return { success: true };
  }

  function normalizeTranscript(chunks, {
    videoId = "",
    language = null,
    source = "youtube-manual",
    sourceVersion = 1,
  } = {}) {
    const transcript = [];
    const plain = [];
    const timestamped = [];
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      const text = cleanCaptionText(chunk?.text);
      if (!text) continue;
      const start = Math.max(0, (Number(chunk.offset) || 0) / 1000);
      const duration = Math.max(0.001, (Number(chunk.duration) || 0) / 1000);
      transcript.push({
        id: `${source}-${transcript.length}-${Math.round(start * 1000)}`,
        text,
        start,
        duration,
        language: chunk.lang || language || null,
        sourceSegmentIds: Array.isArray(chunk.sourceSegmentIds)
          ? [...chunk.sourceSegmentIds]
          : [`raw-${transcript.length}`],
      });
      plain.push(text);
      const wholeSeconds = Math.floor(start);
      timestamped.push(`[${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}] ${text}`);
    }
    return {
      success: transcript.length > 0,
      transcript,
      transcriptText: plain.join(" "),
      transcriptTextTimestamped: timestamped.join("\n"),
      language,
      source,
      sourceVersion,
      sourceLabel:
        source === "youtube-auto" ? "YouTube Auto" :
        source === "youtube-manual" ? "YouTube CC" :
        source === "supadata-ai" ? "Supadata AI" : "Video subtitles",
      record: {
        videoId,
        language,
        source,
        sourceVersion,
        segments: transcript,
      },
    };
  }

  function classifySupadataFailure(status, data) {
    const detail = JSON.stringify(data || {}).toLowerCase();
    if (status === 429 && /(credit|quota|monthly|plan|limit used|usage limit)/.test(detail)) {
      return {
        error: "SUPADATA_QUOTA_EXHAUSTED",
        message: "Supadata monthly credits are exhausted.",
      };
    }
    if (status === 429) {
      return {
        error: "SUPADATA_RATE_LIMITED",
        message: "Supadata plan or rate limit was reached.",
      };
    }
    if (status >= 500 || status === 408) {
      return {
        error: "SUPADATA_UNAVAILABLE",
        message: "Supadata is temporarily unavailable.",
      };
    }
    return null;
  }

  function estimateSupadataCredits(durationSeconds) {
    const duration = Math.max(0, Number(durationSeconds) || 0);
    return duration ? Math.ceil(duration / 60) * 2 : null;
  }

  async function tryEnglishTracksInOrder(tracks, loadTrack) {
    const attempts = [];
    for (const track of orderedEnglishTracks(tracks)) {
      let outcome;
      try {
        outcome = await loadTrack(track);
      } catch (_error) {
        outcome = { success: false, error: "YOUTUBE_CAPTION_FETCH_FAILED" };
      }
      attempts.push({ track, error: outcome?.error || null });
      if (outcome?.success) {
        return { success: true, track, value: outcome.value, attempts };
      }
      if (outcome?.error === "VIDEO_CONTEXT_CHANGED") {
        return {
          success: false,
          error: "VIDEO_CONTEXT_CHANGED",
          attempts,
        };
      }
    }
    return {
      success: false,
      error: attempts.at(-1)?.error || "YOUTUBE_CAPTION_FETCH_FAILED",
      attempts,
    };
  }

  return {
    chooseTrack,
    orderedEnglishTracks,
    extractTracks,
    parseJson3,
    normalizeTranscript,
    classifySupadataFailure,
    estimateSupadataCredits,
    tryEnglishTracksInOrder,
    trackScore,
    rendererText,
    extractTranscriptEndpoint,
    extractTranscriptLanguageOptions,
    chooseEnglishTranscriptOption,
    parseTranscriptApiSegments,
    isAutomaticCaptionLabel,
    parseTimestampSeconds,
    normalizeNativeTranscriptRows,
    validateNativeTranscriptTimeline,
  };
});
