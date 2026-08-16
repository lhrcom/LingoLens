/* global YTD_LIVE_CAPTIONS */
/**
 * Dynamically injected into the active page after a user gesture.
 * It probes HTML5 text tracks and renders an isolated bilingual overlay.
 */
(() => {
  if (globalThis.__YTD_PAGE_CAPTIONS__) return;
  globalThis.__YTD_PAGE_CAPTIONS__ = true;

  let selectedVideoId = "";
  let session = null;
  let hidden = false;
  let host = null;
  let englishLine = null;
  let chineseLine = null;
  let statusLine = null;
  let overlayPreferences = YTD_LIVE_CAPTIONS.normalizeOverlayPreferences();
  let preferencesLoaded = false;
  let positionFrame = null;
  let dragState = null;

  function videoId(video, index) {
    if (!video.dataset.ytdCaptionVideoId) {
      video.dataset.ytdCaptionVideoId = `video-${Date.now()}-${index}`;
    }
    return video.dataset.ytdCaptionVideoId;
  }

  function visibleArea(element) {
    const rect = element.getBoundingClientRect();
    const width = Math.max(
      0,
      Math.min(innerWidth, rect.right) - Math.max(0, rect.left),
    );
    const height = Math.max(
      0,
      Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top),
    );
    return Math.round(width * height);
  }

  function listVideos() {
    return [...document.querySelectorAll("video")]
      .map((video, index) => ({
        id: videoId(video, index),
        label:
          video.getAttribute("aria-label") ||
          video.getAttribute("title") ||
          `Video ${index + 1}`,
        currentTime: Number(video.currentTime || 0),
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        paused: video.paused,
        muted: video.muted || video.volume === 0,
        visibleArea: visibleArea(video),
      }))
      .sort(
        (a, b) =>
          Number(a.paused) - Number(b.paused) ||
          b.visibleArea - a.visibleArea,
      );
  }

  function selectedVideo() {
    const videos = [...document.querySelectorAll("video")];
    return (
      videos.find((video) => video.dataset.ytdCaptionVideoId === selectedVideoId) ||
      videos
        .map((video, index) => ({ video, id: videoId(video, index) }))
        .sort(
          (a, b) =>
            Number(a.video.paused) - Number(b.video.paused) ||
            visibleArea(b.video) - visibleArea(a.video),
        )[0]?.video ||
      null
    );
  }

  function cueText(cue) {
    return String(cue?.text || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function readTextTracks(video) {
    const tracks = [...(video?.textTracks || [])];
    let best = null;
    for (const track of tracks) {
      const language = String(track.language || "").toLowerCase();
      // The first release intentionally supports English speech only. An
      // explicitly non-English track must fall back to live English capture
      // instead of being mislabeled and mistranslated as English.
      if (language && !language.startsWith("en")) continue;
      const score = language.startsWith("en") ? 2 : 1;
      try {
        if (track.mode === "disabled") track.mode = "hidden";
      } catch (_error) {
        // Some players own the track mode. Cues may still be readable.
      }
      const cues = [...(track.cues || [])]
        .map((cue, index) => ({
          id: `track-${index}-${Math.round(cue.startTime * 1000)}`,
          startMs: Math.round(cue.startTime * 1000),
          endMs: Math.max(
            Math.round(cue.endTime * 1000),
            Math.round(cue.startTime * 1000) + 1,
          ),
          sourceText: cueText(cue),
          recognitionState: "final",
          translationState: "queued",
          source: "text-track",
        }))
        .filter((cue) => cue.sourceText);
      if (cues.length && (!best || score > best.score)) {
        best = {
          score,
          language: track.language || "unknown",
          label: track.label || track.language || "Video subtitles",
          segments: cues,
        };
      }
    }
    return best;
  }

  async function persistOverlayPreferences() {
    if (!preferencesLoaded) return;
    await chrome.storage.local
      .set({
        [YTD_LIVE_CAPTIONS.OVERLAY_PREFERENCES_KEY]: overlayPreferences,
      })
      .catch(() => {});
  }

  function scheduleOverlayPosition() {
    cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      if (!host?.isConnected) return;
      const root = host.shadowRoot;
      const wrap = root.querySelector(".wrap");
      const caption = root.querySelector(".caption");
      if (!caption.classList.contains("visible")) return;
      const resolved = YTD_LIVE_CAPTIONS.resolveOverlayPosition(
        overlayPreferences,
        innerWidth,
        innerHeight,
        caption.offsetWidth,
        caption.offsetHeight,
      );
      wrap.style.left = `${resolved.left}px`;
      wrap.style.top = `${resolved.top}px`;
    });
  }

  function updateOverlayControls() {
    if (!host) return;
    const root = host.shadowRoot;
    const decrease = root.querySelector(".font-decrease");
    const increase = root.querySelector(".font-increase");
    const width = root.querySelector(".width-toggle");
    decrease.disabled = overlayPreferences.fontScale <= 0.7;
    increase.disabled = overlayPreferences.fontScale >= 1.3;
    const widthName = overlayPreferences.widthPreset;
    width.title = `Caption width: ${widthName}`;
    width.setAttribute("aria-label", `Caption width: ${widthName}; activate to change`);
  }

  function applyOverlayPreferences({ persist = false } = {}) {
    if (!host) return;
    overlayPreferences = YTD_LIVE_CAPTIONS.normalizeOverlayPreferences(
      overlayPreferences,
    );
    const wrap = host.shadowRoot.querySelector(".wrap");
    const widthRatio =
      YTD_LIVE_CAPTIONS.OVERLAY_WIDTH_PRESETS[overlayPreferences.widthPreset];
    const widthPixels =
      YTD_LIVE_CAPTIONS.OVERLAY_WIDTH_MAX_PIXELS[overlayPreferences.widthPreset];
    wrap.style.setProperty("--caption-font-scale", overlayPreferences.fontScale);
    wrap.style.setProperty("--caption-max-width", `${widthRatio * 100}vw`);
    wrap.style.setProperty("--caption-max-pixels", `${widthPixels}px`);
    updateOverlayControls();
    scheduleOverlayPosition();
    if (persist) void persistOverlayPreferences();
  }

  async function loadOverlayPreferences() {
    try {
      const stored = await chrome.storage.local.get(
        YTD_LIVE_CAPTIONS.OVERLAY_PREFERENCES_KEY,
      );
      overlayPreferences = YTD_LIVE_CAPTIONS.normalizeOverlayPreferences(
        stored[YTD_LIVE_CAPTIONS.OVERLAY_PREFERENCES_KEY],
      );
    } catch (_error) {
      overlayPreferences = YTD_LIVE_CAPTIONS.normalizeOverlayPreferences();
    }
    preferencesLoaded = true;
    applyOverlayPreferences();
  }

  function beginOverlayDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const caption = event.currentTarget;
    const wrap = host.shadowRoot.querySelector(".wrap");
    const rect = caption.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: Number.parseFloat(wrap.style.left) || rect.left + rect.width / 2,
      startTop: Number.parseFloat(wrap.style.top) || rect.top + rect.height / 2,
    };
    caption.setPointerCapture(event.pointerId);
    caption.classList.add("dragging");
    event.preventDefault();
  }

  function moveOverlay(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const caption = event.currentTarget;
    const wrap = host.shadowRoot.querySelector(".wrap");
    const candidate = {
      ...overlayPreferences,
      xRatio: (dragState.startLeft + event.clientX - dragState.startX) / innerWidth,
      yRatio: (dragState.startTop + event.clientY - dragState.startY) / innerHeight,
    };
    const resolved = YTD_LIVE_CAPTIONS.resolveOverlayPosition(
      candidate,
      innerWidth,
      innerHeight,
      caption.offsetWidth,
      caption.offsetHeight,
    );
    wrap.style.left = `${resolved.left}px`;
    wrap.style.top = `${resolved.top}px`;
    overlayPreferences = {
      ...overlayPreferences,
      xRatio: resolved.xRatio,
      yRatio: resolved.yRatio,
    };
  }

  function endOverlayDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const caption = event.currentTarget;
    if (caption.hasPointerCapture(event.pointerId)) {
      caption.releasePointerCapture(event.pointerId);
    }
    caption.classList.remove("dragging");
    dragState = null;
    void persistOverlayPreferences();
  }

  function ensureOverlay() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "ytd-live-caption-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          --caption-font-scale: 1;
          --caption-max-width: 72vw;
          --caption-max-pixels: 720px;
          position: fixed; left: 50%; top: 86%; transform: translate(-50%, -50%);
          z-index: 2147483647; width: max-content;
          max-width: min(var(--caption-max-pixels), var(--caption-max-width), calc(100vw - 16px));
          color: white; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          text-align: center; pointer-events: auto;
        }
        .caption {
          display: none; position: relative; box-sizing: border-box;
          width: max-content; max-width: 100%; padding: 9px 14px 10px;
          border-radius: 10px; background: rgba(12, 12, 14, .82);
          box-shadow: 0 6px 24px rgba(0,0,0,.32); backdrop-filter: blur(7px);
          cursor: grab; touch-action: none;
        }
        .caption.visible { display: block; }
        .caption.dragging { cursor: grabbing; user-select: none; }
        .caption:focus-visible { outline: 2px solid #ffe0a8; outline-offset: 3px; }
        .english, .chinese { max-width: 100%; overflow-wrap: anywhere; white-space: normal; }
        .english { font-size: calc(18px * var(--caption-font-scale)); line-height: 1.3; font-weight: 650;
          text-shadow: 0 1px 3px #000; }
        .english.interim { opacity: .68; font-style: italic; }
        .chinese { margin-top: 3px; color: #ffe0a8;
          font-size: calc(17px * var(--caption-font-scale)); line-height: 1.3;
          font-weight: 650; text-shadow: 0 1px 3px #000; }
        .status { margin-top: 3px; color: #c7c7cb; font-size: 10px; line-height: 1.25; }
        .status[hidden] { display: none; }
        .tools {
          position: absolute; right: 4px; bottom: calc(100% - 2px); display: flex; gap: 3px;
          padding: 3px; border-radius: 9px; background: rgba(12,12,14,.88);
          box-shadow: 0 3px 12px rgba(0,0,0,.3); opacity: 0;
          pointer-events: none; transform: translateY(2px);
          transition: opacity .14s ease, transform .14s ease;
        }
        .caption:hover .tools, .caption:focus-within .tools {
          opacity: 1; pointer-events: auto; transform: translateY(0);
        }
        button {
          position: static; box-sizing: border-box; border: 0; border-radius: 7px;
          background: rgba(255,255,255,.13); color: white; cursor: pointer;
          min-width: 27px; height: 27px; padding: 0 6px; font: 600 12px/27px system-ui, sans-serif;
        }
        button:hover, button:focus-visible { background: rgba(255,255,255,.25); outline: none; }
        button:disabled { cursor: default; opacity: .38; }
        .stop { color: #ffb8b8; }
        .restore {
          display: none; position: fixed; right: 18px; bottom: 18px;
          width: auto; height: auto; padding: 7px 11px;
          background: rgba(12,12,14,.82);
        }
        .restore.visible { display: block; }
      </style>
      <div class="wrap">
        <div class="caption" tabindex="0" aria-label="Bilingual subtitles; drag to move">
          <div class="tools" role="toolbar" aria-label="Subtitle display controls">
            <button class="font-decrease" type="button" title="Smaller subtitles" aria-label="Smaller subtitles">A−</button>
            <button class="font-increase" type="button" title="Larger subtitles" aria-label="Larger subtitles">A+</button>
            <button class="width-toggle" type="button">↔</button>
            <button class="reset" type="button" title="Reset subtitle layout" aria-label="Reset subtitle layout">↺</button>
            <button class="hide" type="button" title="Hide subtitles" aria-label="Hide subtitles">−</button>
            <button class="stop" type="button" title="Stop subtitles" aria-label="Stop subtitles">×</button>
          </div>
          <div class="english"></div>
          <div class="chinese"></div>
          <div class="status" hidden></div>
        </div>
        <button class="restore" type="button">Show subtitles</button>
      </div>`;
    englishLine = root.querySelector(".english");
    chineseLine = root.querySelector(".chinese");
    statusLine = root.querySelector(".status");
    const caption = root.querySelector(".caption");
    caption.addEventListener("pointerdown", beginOverlayDrag);
    caption.addEventListener("pointermove", moveOverlay);
    caption.addEventListener("pointerup", endOverlayDrag);
    caption.addEventListener("pointercancel", endOverlayDrag);
    root.querySelector(".font-decrease").addEventListener("click", () => {
      overlayPreferences.fontScale -= 0.1;
      applyOverlayPreferences({ persist: true });
    });
    root.querySelector(".font-increase").addEventListener("click", () => {
      overlayPreferences.fontScale += 0.1;
      applyOverlayPreferences({ persist: true });
    });
    root.querySelector(".width-toggle").addEventListener("click", () => {
      overlayPreferences.widthPreset = YTD_LIVE_CAPTIONS.nextOverlayWidthPreset(
        overlayPreferences.widthPreset,
      );
      applyOverlayPreferences({ persist: true });
    });
    root.querySelector(".reset").addEventListener("click", () => {
      overlayPreferences = YTD_LIVE_CAPTIONS.normalizeOverlayPreferences();
      applyOverlayPreferences({ persist: true });
    });
    root.querySelector(".hide").addEventListener("click", () => {
      hidden = true;
      render();
    });
    root.querySelector(".restore").addEventListener("click", () => {
      hidden = false;
      render();
    });
    root.querySelector(".stop").addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "stopCaptionSession" }).catch(() => {});
    });
    (document.fullscreenElement || document.documentElement).appendChild(host);
    void loadOverlayPreferences();
  }

  function activeSegment() {
    const segments = session?.segments || [];
    if (session?.mode === "live") {
      return [...segments].reverse().find((segment) => segment.sourceText) || null;
    }
    const currentMs = Number(selectedVideo()?.currentTime || 0) * 1000;
    return (
      segments.find(
        (segment) => segment.startMs <= currentMs && currentMs < segment.endMs,
      ) || null
    );
  }

  function render() {
    ensureOverlay();
    const root = host.shadowRoot;
    const caption = root.querySelector(".caption");
    const restore = root.querySelector(".restore");
    const segment = activeSegment();
    caption.classList.toggle("visible", !!session && !hidden && !!segment);
    restore.classList.toggle("visible", !!session && hidden);
    if (!segment) return;
    englishLine.textContent = segment.sourceText || "";
    englishLine.classList.toggle(
      "interim",
      segment.recognitionState === "interim",
    );
    chineseLine.textContent = segment.translationText || "";
    let statusText = "";
    if (
      segment.translationState === "streaming" ||
      (segment.recognitionState === "final" &&
        segment.translationState === "queued" &&
        !segment.translationText)
    ) {
      statusText = "AI translating…";
    } else if (segment.translationState === "error") {
      statusText = "Translation failed; English remains available";
    } else if (["connecting", "reconnecting", "error"].includes(session.status)) {
      statusText = session.error || session.status;
    }
    statusLine.textContent = statusText;
    statusLine.hidden = !statusText;
    scheduleOverlayPosition();
  }

  function setSession(snapshot) {
    session = snapshot
      ? { ...snapshot, segments: [...(snapshot.segments || [])] }
      : null;
    selectedVideoId = snapshot?.videoId || selectedVideoId;
    hidden = false;
    render();
  }

  function upsertSegment(segment) {
    if (!session) return;
    const index = session.segments.findIndex((item) => item.id === segment.id);
    if (index === -1) session.segments.push(segment);
    else session.segments[index] = { ...session.segments[index], ...segment };
    session.segments.sort((a, b) => a.startMs - b.startMs);
    render();
  }

  document.addEventListener("fullscreenchange", () => {
    if (!host) return;
    (document.fullscreenElement || document.documentElement).appendChild(host);
    scheduleOverlayPosition();
  });
  window.addEventListener("resize", scheduleOverlayPosition);
  document.addEventListener(
    "seeking",
    (event) => {
      if (event.target !== selectedVideo()) return;
      chrome.runtime
        .sendMessage({
          action: "captionPlaybackPositionChanged",
          currentTime: Number(event.target.currentTime || 0),
        })
        .catch(() => {});
    },
    true,
  );
  setInterval(render, 250);

  async function probePage(message) {
    const videos = listVideos();
    selectedVideoId = message.videoId || selectedVideoId || videos[0]?.id || "";
    const video = selectedVideo();
    let track = readTextTracks(video);
    // Setting a disabled TextTrack to hidden starts loading it. Give the
    // browser a short opportunity to populate cues before choosing live ASR.
    for (let attempt = 0; !track && attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      track = readTextTracks(video);
    }
    return {
      success: true,
      page: {
        title: document.title,
        url: location.href,
        videos,
        selectedVideoId,
        currentTime: Number(video?.currentTime || 0),
        multipleAudibleVideos:
          videos.filter((item) => !item.paused && !item.muted).length > 1,
      },
      transcript: track,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "probeCaptionPage") {
      probePage(message).then(sendResponse);
      return true;
    }
    if (message.action === "captionSessionSnapshot") {
      setSession(message.session);
      sendResponse({ success: true });
      return false;
    }
    if (message.action === "captionSegmentUpsert") {
      upsertSegment(message.segment);
      sendResponse({ success: true });
      return false;
    }
    if (message.action === "captionSessionStopped") {
      session = null;
      render();
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  ensureOverlay();
})();
