/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for LingoLens: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTranscriptSource = "supadata";
let currentTranscriptSourceLabel = "Supadata";
let currentTranscriptRecord = null;
let currentSourceHash = "";
let currentAiModel = "deepseek-v4-flash";
let generationPrimaryAction = null;
let generationPollingToken = 0;
const youtubeCaptionRetryContexts = new Set();
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;
let youtubePageContext = {
  generation: 0,
  tabId: null,
  videoId: "",
  url: "",
  key: "",
};
const VIDEO_INFO_RETRY_DELAYS_MS = Object.freeze([0, 150, 350, 700, 1200]);
const YOUTUBE_TRANSCRIPT_SOURCE_VERSION = 2;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
let lastPlaybackTime = 0;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// --- Page-agnostic live / prefetched captions ---
let preparedCaptionPage = null;
let activeLiveCaptionSession = null;
let liveCaptionTabId = null;
let liveCaptionContext = { generation: 0, tabId: null, url: "", key: "" };
let liveCaptionRefreshTimer = null;
let liveCaptionCardContextKey = "";

// --- Page translation state ---
let pageTranslationTabId = null;
let pageTranslationAvailable = false;
let pageTranslationSupported = false;
let pageTranslationConnecting = false;
let pageTranslationActionPending = false;
let pageTranslationReconcileTimer = null;
let pageTranslationContext = {
  generation: 0,
  tabId: null,
  url: "",
  key: "",
  pageInstanceId: "",
};
const PAGE_TRANSLATION_RETRY_DELAYS_MS = Object.freeze([
  0, 100, 250, 500, 1000, 2000, 4000, 8000,
]);

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          end: start + duration,
          sourceSegmentIds: Array.isArray(entry.sourceSegmentIds)
            ? entry.sourceSegmentIds
            : [entry.id || `raw-${entryIndex}`],
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      duration: Math.max(0.001, current.end - current.start),
      text,
      texts: [text],
      sourceSegmentIds: [...current.sourceSegmentIds],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) {
      current = {
        start: piece.start,
        end: piece.end,
        text: "",
        sourceSegmentIds: new Set(),
      };
    }
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    current.end = Math.max(current.end, piece.end);
    piece.sourceSegmentIds.forEach((id) => current.sourceSegmentIds.add(id));
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

function setPageTranslationAvailability(label, isError = false) {
  const badge = document.getElementById("pageTranslationAvailability");
  if (!badge) return;
  badge.textContent = label;
  badge.classList.toggle("is-error", isError);
}

function renderPageTranslationStatus(status) {
  const state = status || {
    status: "idle",
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    message: "Page translation has not started.",
  };
  const statusNode = document.getElementById("pageTranslationStatus");
  const countNode = document.getElementById("pageTranslationCounts");
  const progress = document.getElementById("pageTranslationProgress");
  if (!statusNode || !countNode || !progress) return;
  statusNode.textContent = state.message || "Page translation has not started.";
  countNode.textContent = state.total
    ? `${state.success || 0} done · ${state.failed || 0} failed`
    : "";
  const percent = state.total
    ? Math.round(((state.completed || 0) / state.total) * 100)
    : 0;
  progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const running = state.status === "running" || state.status === "stopping";
  const rendered = Math.max(0, Number(state.rendered || 0));
  document.getElementById("translatePageBtn").disabled =
    !pageTranslationSupported || pageTranslationConnecting || running;
  document.getElementById("stopPageTranslationBtn").disabled =
    !pageTranslationAvailable || !running || state.status === "stopping";
  document.getElementById("removePageTranslationsBtn").disabled =
    !pageTranslationAvailable || (!running && rendered === 0);
}

function setPageTranslationControlsEnabled(
  enabled,
  { supported = pageTranslationSupported, connecting = false } = {},
) {
  pageTranslationAvailable = enabled;
  pageTranslationSupported = supported;
  pageTranslationConnecting = connecting;
  document.getElementById("translatePageBtn").disabled =
    !supported || connecting;
  document.getElementById("removePageTranslationsBtn").disabled = !enabled;
  if (!enabled) {
    document.getElementById("stopPageTranslationBtn").disabled = true;
  }
}

async function activePanelTab() {
  const query = { active: true };
  if (panelWindowId !== null) query.windowId = panelWindowId;
  else query.lastFocusedWindow = true;
  const [tab] = await chrome.tabs.query(query);
  if (!tab?.id) throw new Error("Could not identify the active tab.");
  return tab;
}

function pageTranslationContextKey(tabId, url) {
  return `${tabId || "none"}:${YTD_LIVE_CAPTIONS.normalizedPageUrl(url)}`;
}

function isCurrentPageTranslationContext(context) {
  return (
    context?.generation === pageTranslationContext.generation &&
    context?.key === pageTranslationContext.key
  );
}

function beginPageTranslationContext(tabId, url, { force = false } = {}) {
  const key = pageTranslationContextKey(tabId, url);
  const changed = force || key !== pageTranslationContext.key;
  if (!changed) return { ...pageTranslationContext };
  pageTranslationContext = {
    generation: pageTranslationContext.generation + 1,
    tabId,
    url: YTD_LIVE_CAPTIONS.normalizedPageUrl(url),
    key,
    pageInstanceId: "",
  };
  pageTranslationTabId = tabId;
  const supported = /^https?:\/\//.test(url || "");
  setPageTranslationControlsEnabled(false, {
    supported,
    connecting: supported,
  });
  setPageTranslationAvailability("Connecting");
  renderPageTranslationStatus({ message: "Waiting for this page…" });
  return { ...pageTranslationContext };
}

async function connectPageTranslationContext(context) {
  const outcome = await YTD_LIVE_CAPTIONS.retryWithDelays(
    PAGE_TRANSLATION_RETRY_DELAYS_MS,
    async () => {
      const tab = await chrome.tabs.get(context.tabId);
      const tabUrl = tab.url || tab.pendingUrl || "";
      if (pageTranslationContextKey(tab.id, tabUrl) !== context.key) {
        throw new Error("Waiting for the new page URL to commit.");
      }
      const statusResult = await chrome.tabs.sendMessage(context.tabId, {
        action: "ytdPageTranslationGetStatus",
      });
      const pageInstanceId = statusResult?.status?.pageInstanceId || "";
      if (!statusResult?.ok || !pageInstanceId) {
        throw new Error("The page translation script is not ready.");
      }
      return statusResult;
    },
    { isCurrent: () => isCurrentPageTranslationContext(context) },
  );
  if (outcome.cancelled || !isCurrentPageTranslationContext(context)) return null;
  if (outcome.value) {
    pageTranslationContext.pageInstanceId =
      outcome.value.status.pageInstanceId;
    setPageTranslationControlsEnabled(true, { supported: true });
    setPageTranslationAvailability("Ready");
    renderPageTranslationStatus(outcome.value.status);
    return outcome.value;
  }
  setPageTranslationControlsEnabled(false, { supported: true });
  setPageTranslationAvailability("Reload page", true);
  renderPageTranslationStatus({
    message:
      outcome.error?.message ||
      "Could not connect to this page. Reload it and try again.",
  });
  return null;
}

async function sendPageTranslationToTab(action, { reconnect = true } = {}) {
  let context = { ...pageTranslationContext };
  if (!/^https?:\/\//.test(context.url || "")) {
    throw new Error("Web translation works on normal HTTP and HTTPS pages.");
  }
  if (!pageTranslationAvailable || !context.pageInstanceId) {
    if (!reconnect || !(await initializePageTranslation("", null, { force: true }))) {
      throw new Error("Could not reconnect to this page. Reload it and try again.");
    }
    context = { ...pageTranslationContext };
  }
  try {
    const response = await chrome.tabs.sendMessage(context.tabId, {
      action,
      pageInstanceId: context.pageInstanceId,
    });
    if (!isCurrentPageTranslationContext(context)) {
      throw new Error("The active page changed before this action completed.");
    }
    if (
      response?.status?.pageInstanceId &&
      response.status.pageInstanceId !== context.pageInstanceId
    ) {
      throw new Error("The page changed before this action completed.");
    }
    return response;
  } catch (error) {
    if (reconnect) {
      const activeTab = await activePanelTab().catch(() => null);
      const activeUrl = activeTab?.url || activeTab?.pendingUrl || "";
      if (
        !activeTab ||
        pageTranslationContextKey(activeTab.id, activeUrl) !== context.key
      ) {
        throw new Error("The active page changed before this action completed.");
      }
      const connection = await initializePageTranslation("", null, {
        force: true,
      });
      if (connection) {
        return sendPageTranslationToTab(action, { reconnect: false });
      }
    }
    throw new Error(error?.message || "Could not connect to this page.");
  }
}

async function initializePageTranslation(
  knownUrl = "",
  knownTabId = null,
  { force = false } = {},
) {
  const card = document.getElementById("pageTranslationCard");
  try {
    const tab = knownTabId
      ? await chrome.tabs.get(knownTabId)
      : await activePanelTab();
    const url = knownUrl || tab.url || tab.pendingUrl || "";
    const previousKey = pageTranslationContext.key;
    const context = beginPageTranslationContext(tab.id, url, { force });
    if (context.key !== previousKey || force) {
      card.open = !url.startsWith("https://www.youtube.com");
    }
    if (!/^https?:\/\//.test(url)) {
      pageTranslationTabId = null;
      pageTranslationContext.pageInstanceId = "";
      setPageTranslationControlsEnabled(false, { supported: false });
      setPageTranslationAvailability("Unavailable", true);
      renderPageTranslationStatus({
        message: "Open a normal HTTP or HTTPS page.",
      });
      return null;
    }
    return await connectPageTranslationContext(context);
  } catch (error) {
    if (knownTabId && knownTabId !== pageTranslationContext.tabId) return;
    setPageTranslationControlsEnabled(false, {
      supported: /^https?:\/\//.test(pageTranslationContext.url || ""),
    });
    setPageTranslationAvailability("Reload page", true);
    renderPageTranslationStatus({ message: error.message });
    return null;
  }
}

async function runPageTranslationAction(action) {
  pageTranslationActionPending = true;
  try {
    const connection = await initializePageTranslation("", null, {
      force: true,
    });
    if (!connection) {
      throw new Error("Could not reconnect to this page. Reload it and try again.");
    }
    const response = await sendPageTranslationToTab(action);
    if (!response?.ok) throw new Error(response?.error?.message || "Page action failed.");
    renderPageTranslationStatus(response.status);
  } catch (error) {
    renderPageTranslationStatus({ message: error.message });
  } finally {
    pageTranslationActionPending = false;
  }
}

function schedulePageTranslationReconcile() {
  clearTimeout(pageTranslationReconcileTimer);
  pageTranslationReconcileTimer = setTimeout(() => {
    pageTranslationReconcileTimer = null;
    if (document.visibilityState === "hidden" || pageTranslationActionPending) return;
    void initializePageTranslation("", null, { force: true });
  }, 180);
}

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  const storedSettings = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  currentAiModel = YTD_SETTINGS.normalize(
    storedSettings[YTD_SETTINGS.STORAGE_KEY],
  ).aiModel;
  await evictOldCacheEntries(20);
  await initializePageTranslation();
  await initializeLiveCaptions();
  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ytdPageTranslationStatusChanged") {
    if (
      sender.tab?.id === pageTranslationContext.tabId &&
      message.status?.pageInstanceId === pageTranslationContext.pageInstanceId
    ) {
      renderPageTranslationStatus(message.status);
    }
  }
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  if (message.action === "captionSessionSnapshot") {
    if (!captionSessionMatchesCurrentContext(message.session)) {
      sendResponse({ success: false, ignored: true });
      return false;
    }
    activeLiveCaptionSession = message.session;
    renderLiveCaptionSession();
    sendResponse({ success: true });
  }
  if (message.action === "captionSegmentUpsert") {
    if (
      activeLiveCaptionSession &&
      captionSessionMatchesCurrentContext(activeLiveCaptionSession)
    ) {
      activeLiveCaptionSession.segments = YTD_LIVE_CAPTIONS.upsertSegment(
        activeLiveCaptionSession.segments,
        message.segment,
      );
      renderLiveCaptionSession();
    }
    sendResponse({ success: true });
  }
  if (message.action === "captionSessionStopped") {
    if (!captionSessionMatchesCurrentContext(message.session)) {
      sendResponse({ success: false, ignored: true });
      return false;
    }
    activeLiveCaptionSession = message.session;
    renderLiveCaptionSession(true);
    sendResponse({ success: true });
  }
  if (message.action === "captionCapturePermissionRequired") {
    document.getElementById("liveCaptionStatus").textContent =
      "Click the LingoLens icon in the Chrome toolbar to authorize this video. Subtitles will start automatically.";
    sendResponse({ success: true });
  }
  if (message.action === "captionPendingStartResolved" && !message.success) {
    document.getElementById("liveCaptionStatus").textContent = message.error;
    document.getElementById("startLiveCaptionBtn").disabled = false;
    sendResponse({ success: true });
  }
  if (message.action === "captionPendingStartCancelled") {
    document.getElementById("liveCaptionStatus").textContent = message.reason;
    document.getElementById("startLiveCaptionBtn").disabled = false;
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function youtubePageContextKey(tabId, videoId) {
  return `${tabId || "none"}:${videoId || "none"}`;
}

function isCurrentYoutubeContext(context) {
  return (
    context?.generation === youtubePageContext.generation &&
    context?.key === youtubePageContext.key
  );
}

function clearVideoHeader({ webPageMode = false } = {}) {
  currentVideoTitle = "";
  currentChannelName = "";
  currentVideoDescription = "";
  currentVideoDuration = 0;
  const header = document.querySelector(".header");
  const videoInfo = document.getElementById("videoInfo");
  header?.classList.toggle("web-page-mode", webPageMode);
  document.getElementById("videoTitle").textContent = "";
  document.getElementById("videoChannel").textContent = "";
  if (videoInfo) videoInfo.style.display = "none";
  document.getElementById("tabsNav").style.display = "none";
}

function renderVideoHeader(info) {
  if (!info?.title && !info?.channelName) return;
  currentVideoTitle = info.title || "";
  currentChannelName = info.channelName || "";
  currentVideoDescription = info.description || "";
  currentVideoDuration = Number(info.duration) || 0;
  document.querySelector(".header")?.classList.remove("web-page-mode");
  document.getElementById("videoTitle").textContent = currentVideoTitle;
  document.getElementById("videoChannel").textContent = currentChannelName;
  document.getElementById("videoInfo").style.display = "block";
}

function adoptYoutubePageContext(tabId, url, { force = false } = {}) {
  const videoId = YTD_LIVE_CAPTIONS.youtubeVideoId(url);
  const key = youtubePageContextKey(tabId, videoId);
  if (!force && key === youtubePageContext.key) return { ...youtubePageContext };
  youtubePageContext = {
    generation: youtubePageContext.generation + 1,
    tabId,
    videoId,
    url: YTD_LIVE_CAPTIONS.normalizedPageUrl(url),
    key,
  };
  youtubeTabId = videoId ? tabId : null;
  currentVideoId = null;
  clearVideoHeader({ webPageMode: !videoId });
  return { ...youtubePageContext };
}

function scheduleDigestRefresh(tabId = youtubePageContext.tabId, url = youtubePageContext.url) {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  const context = { ...youtubePageContext };
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    if (!isCurrentYoutubeContext(context)) return;
    checkCurrentTab({ tabId, url, generation: context.generation });
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

function captionPageKey(tabId, url) {
  return YTD_LIVE_CAPTIONS.pageContextKey(tabId, url);
}

function captionSessionMatchesCurrentContext(session) {
  if (!session || !liveCaptionContext.key) return false;
  return captionPageKey(session.tabId, session.url) === liveCaptionContext.key;
}

function setLiveCaptionCardContext(tabId, url) {
  const key = captionPageKey(tabId, url);
  if (key === liveCaptionCardContextKey) return;
  liveCaptionCardContextKey = key;
  const card = document.getElementById("liveCaptionCard");
  if (card) card.open = !YTD_LIVE_CAPTIONS.youtubeVideoId(url);
}

function clearLiveCaptionUi(message = "Inspecting this page…") {
  preparedCaptionPage = null;
  activeLiveCaptionSession = null;
  const status = document.getElementById("liveCaptionStatus");
  const mode = document.getElementById("liveCaptionMode");
  const select = document.getElementById("liveVideoSelect");
  const warning = document.getElementById("liveCaptionWarning");
  const exports = document.getElementById("liveExportControls");
  if (status) status.textContent = message;
  if (mode) mode.textContent = "Ready";
  if (select) {
    select.innerHTML = "<option>Looking for video…</option>";
    select.disabled = true;
  }
  if (warning) {
    warning.hidden = true;
    warning.textContent = "";
  }
  document.getElementById("startLiveCaptionBtn").disabled = true;
  document.getElementById("stopLiveCaptionBtn").disabled = true;
  if (exports) exports.hidden = true;
}

function adoptLiveCaptionContext(tabId, url, { stopOldSession = false } = {}) {
  const key = captionPageKey(tabId, url);
  setLiveCaptionCardContext(tabId, url);
  if (key === liveCaptionContext.key) return false;
  const hadSession = !!activeLiveCaptionSession;
  liveCaptionContext = {
    generation: liveCaptionContext.generation + 1,
    tabId,
    url: YTD_LIVE_CAPTIONS.normalizedPageUrl(url),
    key,
  };
  liveCaptionTabId = tabId;
  clearTimeout(liveCaptionRefreshTimer);
  liveCaptionRefreshTimer = null;
  clearLiveCaptionUi("Waiting for the current page video…");
  if (stopOldSession && hadSession) {
    chrome.runtime.sendMessage({ action: "stopCaptionSession" }).catch(() => {});
  }
  return true;
}

function scheduleLiveCaptionRefresh(tabId, url) {
  const expectedKey = captionPageKey(tabId, url);
  const expectedGeneration = liveCaptionContext.generation;
  clearTimeout(liveCaptionRefreshTimer);
  liveCaptionRefreshTimer = setTimeout(async () => {
    liveCaptionRefreshTimer = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url || tab.pendingUrl || "";
      if (
        expectedGeneration !== liveCaptionContext.generation ||
        expectedKey !== liveCaptionContext.key ||
        captionPageKey(tab.id, currentUrl) !== expectedKey
      ) {
        return;
      }
      await prepareLiveCaptionPage("", { ...liveCaptionContext });
    } catch (_error) {
      // A later tab/navigation event will retry with its own context.
    }
  }, 700);
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url, tabId = null) {
  void initializePageTranslation(url, tabId, { force: true });
  const previousYoutubeKey = youtubePageContext.key;
  const youtubeContext = adoptYoutubePageContext(tabId, url);
  const changed = adoptLiveCaptionContext(tabId, url, {
    stopOldSession: true,
  });
  if (changed && tabId) scheduleLiveCaptionRefresh(tabId, url);
  if (!youtubeContext.videoId) {
    showState("welcome");
    return;
  }

  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (
    youtubeContext.key !== previousYoutubeKey ||
    youtubeContext.videoId !== currentVideoId ||
    !panelIsShowingResults()
  ) {
    scheduleDigestRefresh(tabId, url);
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  const url = changeInfo.url || tab.url || tab.pendingUrl || "";
  if (changeInfo.url) {
    handleFrontTabUrl(url, tabId);
    return;
  }
  if (changeInfo.status === "loading") {
    void initializePageTranslation(url, tabId, { force: true });
    if (YTD_LIVE_CAPTIONS.youtubeVideoId(url)) {
      adoptYoutubePageContext(tabId, url, { force: true });
    }
    return;
  }
  if (changeInfo.status === "complete") {
    void initializePageTranslation(url, tabId, { force: true });
    if (YTD_LIVE_CAPTIONS.youtubeVideoId(url)) scheduleDigestRefresh(tabId, url);
  }
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "", tabId);
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

window.addEventListener?.("focus", schedulePageTranslationReconcile);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") schedulePageTranslationReconcile();
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });
  document.getElementById("generateTranscriptBtn")?.addEventListener("click", () => {
    generationPrimaryAction?.();
  });
  document.getElementById("useLiveAiBtn")?.addEventListener("click", offerLiveAi);

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  document
    .getElementById("translatePageBtn")
    ?.addEventListener("click", () =>
      runPageTranslationAction("ytdPageTranslationStart"),
    );
  document
    .getElementById("stopPageTranslationBtn")
    ?.addEventListener("click", () =>
      runPageTranslationAction("ytdPageTranslationCancel"),
    );
  document
    .getElementById("removePageTranslationsBtn")
    ?.addEventListener("click", () =>
      runPageTranslationAction("ytdPageTranslationRemove"),
    );

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
  document
    .getElementById("startLiveCaptionBtn")
    ?.addEventListener("click", startLiveCaptions);
  document
    .getElementById("stopLiveCaptionBtn")
    ?.addEventListener("click", stopLiveCaptions);
  document
    .getElementById("openLiveSettingsBtn")
    ?.addEventListener("click", () =>
      chrome.runtime.sendMessage({ action: "openOptions" }),
    );
  document
    .getElementById("liveVideoSelect")
    ?.addEventListener("change", async (event) => {
      const selectedVideoId = event.target.value;
      const running =
        activeLiveCaptionSession &&
        !/stopped|ended|closed|error|navigated/.test(
          activeLiveCaptionSession.status,
        );
      if (running) {
        await chrome.runtime
          .sendMessage({ action: "stopCaptionSession" })
          .catch(() => null);
      }
      clearLiveCaptionUi("Inspecting the selected video…");
      await prepareLiveCaptionPage(selectedVideoId);
    });
  document.querySelectorAll("[data-live-export]").forEach((button) => {
    button.addEventListener("click", () =>
      exportLiveCaptionSession(button.dataset.liveExport),
    );
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function fetchVideoInfoForContext(context) {
  const outcome = await YTD_LIVE_CAPTIONS.retryWithDelays(
    VIDEO_INFO_RETRY_DELAYS_MS,
    async () => {
      const result = await chrome.runtime.sendMessage({
        action: "relayToContent",
        tabId: context.tabId,
        expectedVideoId: context.videoId,
        payload: { action: "getVideoInfo" },
      });
      if (!result?.success) throw new Error(result?.error || "Video info unavailable.");
      if (result.response?.videoId !== context.videoId) {
        throw new Error("YouTube is still updating the player metadata.");
      }
      return result.response;
    },
    { isCurrent: () => isCurrentYoutubeContext(context) },
  );
  if (outcome.cancelled || !isCurrentYoutubeContext(context)) return null;
  if (outcome.value) return outcome.value;
  debugLog(
    "[LingoLens Panel] Video info retries exhausted:",
    outcome.error?.message,
  );
  return null;
}

async function checkCurrentTab(expectedContext = null) {
  try {
    const tab = expectedContext?.tabId
      ? await chrome.tabs.get(expectedContext.tabId)
      : await activePanelTab();

    debugLog("[LingoLens Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      adoptYoutubePageContext(tab?.id || null, "", { force: true });
      showState("welcome");
      return;
    }

    const videoId = YTD_LIVE_CAPTIONS.youtubeVideoId(tab.url);
    if (!videoId) {
      adoptYoutubePageContext(tab.id, tab.url);
      showState("welcome");
      return;
    }

    const context = adoptYoutubePageContext(tab.id, tab.url);
    if (
      expectedContext?.generation &&
      expectedContext.generation !== context.generation
    ) {
      return;
    }
    if (!isCurrentYoutubeContext(context)) return;
    youtubeTabId = tab.id;
    currentVideoUrl = tab.url;

    const info = await fetchVideoInfoForContext(context);
    if (info && isCurrentYoutubeContext(context)) renderVideoHeader(info);
    if (!isCurrentYoutubeContext(context)) return;
    void startDigest(videoId, tab.url, context.generation).catch((error) => {
      if (isCurrentYoutubeContext(context)) {
        console.error("[LingoLens Panel] Digest refresh failed:", error);
      }
    });
  } catch (error) {
    console.error("Tab check error:", error);
    if (!expectedContext || isCurrentYoutubeContext(expectedContext)) {
      clearVideoHeader({ webPageMode: true });
      showState("welcome");
    }
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(
  videoId,
  videoUrl,
  contextGeneration = youtubePageContext.generation,
) {
  const context = { ...youtubePageContext, generation: contextGeneration };
  if (!isCurrentYoutubeContext(context) || context.videoId !== videoId) return;
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  // Every video change invalidates observer work and in-flight translations.
  if (videoId !== currentVideoId) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (!isCurrentYoutubeContext(context)) return;
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    const legacySource = cached.transcriptSource || "supadata";
    currentTranscriptSource =
      legacySource === "youtube-captions"
        ? "youtube-manual"
        : legacySource === "supadata"
          ? "supadata-ai"
          : legacySource;
    currentTranscriptSourceLabel = cached.transcriptRecord
      ? cached.transcriptSourceLabel || "Video subtitles"
      : legacySource === "youtube-auto"
        ? "YouTube Auto"
        : legacySource === "youtube-captions"
          ? "YouTube CC"
          : "Supadata AI";
    currentTranscriptRecord = cached.transcriptRecord || {
      videoId,
      language: currentTranscriptLanguage,
      source: currentTranscriptSource,
      sourceVersion: 1,
      segments: currentTranscript,
    };
    currentSourceHash = cached.sourceHash || stableTranscriptHash(currentTranscriptRecord);
    isAnalysisLoading = false;

    // Versioned translation caches never cross transcript hashes or models.
    const translationStore = await chrome.storage.local.get(
      translationCacheStorageKey(videoId, currentSourceHash, currentAiModel),
    );
    const storedTranslations =
      translationStore[
        translationCacheStorageKey(videoId, currentSourceHash, currentAiModel)
      ]?.translations || {};
    if (cached.sourceHash) {
      for (const [key, value] of Object.entries(storedTranslations)) {
        transcriptParagraphCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    if (!cached.transcriptRecord) void saveToCache(videoId);
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptSource = "supadata";
  currentTranscriptSourceLabel = "Supadata";
  currentTranscriptRecord = null;
  currentSourceHash = "";
  isAnalysisLoading = false;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
    tabId: context.tabId,
    videoDuration: currentVideoDuration,
    pageGeneration: context.generation,
  });
  if (!isCurrentYoutubeContext(context)) return;

  if (transcriptResult.pending) {
    resumeSupadataGeneration(transcriptResult, context);
    return;
  }
  if (transcriptResult.requiresGenerationConfirmation || transcriptResult.liveAiAvailable) {
    showSupadataDecision(transcriptResult, context);
    return;
  }
  if (!transcriptResult.success) {
    showError("No transcript found", transcriptResult.message || transcriptResult.error);
    return;
  }
  await acceptTranscriptResult(transcriptResult, videoId, context);
}

function stableTranscriptHash(record) {
  const text = JSON.stringify({
    source: record?.source || "",
    sourceVersion: record?.sourceVersion || 1,
    segments: (record?.segments || []).map(({ text, start, duration }) => [text, start, duration]),
  });
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ code, 3266489917) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function transcriptTranslationPriority(start, currentTime, inViewport = false) {
  const safeStart = Math.max(0, Number(start) || 0);
  const safeCurrent = Math.max(0, Number(currentTime) || 0);
  if (inViewport) return -1_000_000 + safeStart;
  if (safeStart >= Math.max(0, safeCurrent - 30) && safeStart <= safeCurrent + 180) {
    return safeStart - safeCurrent;
  }
  if (safeStart > safeCurrent + 180) return 1_000_000 + safeStart;
  return 2_000_000 + (safeCurrent - safeStart);
}

async function acceptTranscriptResult(result, videoId, context) {
  if (!isCurrentYoutubeContext(context) || context.videoId !== videoId) return;
  currentTranscript = result.transcript;
  currentTranscriptText = result.transcriptText;
  currentTranscriptTimestamped = result.transcriptTextTimestamped;
  currentTranscriptLanguage = result.language || null;
  currentTranscriptSource = result.source || "youtube-manual";
  currentTranscriptSourceLabel = result.sourceLabel || "Video subtitles";
  currentTranscriptRecord = result.record || {
    videoId,
    language: currentTranscriptLanguage,
    source: currentTranscriptSource,
    sourceVersion: result.sourceVersion || 1,
    segments: currentTranscript,
  };
  currentSourceHash = stableTranscriptHash(currentTranscriptRecord);
  renderTranscript();
  showState("results");
  loadNotes(videoId);
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();
  await saveToCache(videoId);
}

function showGenerationPanel({ title, message, status = "", primaryLabel, primaryAction, hidePrimary = false }) {
  showState("generation");
  document.getElementById("generationTitle").textContent = title;
  document.getElementById("generationMessage").textContent = message;
  document.getElementById("generationStatus").textContent = status;
  const primary = document.getElementById("generateTranscriptBtn");
  primary.textContent = primaryLabel || "Generate transcript";
  primary.hidden = hidePrimary;
  generationPrimaryAction = primaryAction || null;
}

function youtubeAttemptSummary(attempts) {
  const latest = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!attempt?.stage) continue;
    latest.set(attempt.stage, attempt);
  }
  return Array.from(latest.values()).map((attempt) => {
    const label =
      attempt.stage === "timed-text" ? "timed-text" :
      attempt.stage === "transcript-api" ? "Transcript API" :
      attempt.stage === "native-panel" ? "native panel" :
      attempt.stage;
    if (attempt.success) return `${label}: success`;
    if (attempt.httpStatus) return `${label}: HTTP ${attempt.httpStatus}`;
    const error = String(attempt.error || "failed")
      .replace(/^YOUTUBE_(?:CAPTION|TRANSCRIPT|NATIVE_PANEL)_?/, "")
      .replaceAll("_", " ")
      .toLowerCase();
    return `${label}: ${error}`;
  }).join(" · ");
}

function showSupadataDecision(result, context, { skipYoutubeRetry = false } = {}) {
  generationPollingToken += 1;
  const retryKey = `${context.key}:${context.generation}`;
  const freeAttemptStatus = youtubeAttemptSummary(result.youtubeAttempts);
  if (
    result.youtubeRetryAvailable &&
    !skipYoutubeRetry &&
    !youtubeCaptionRetryContexts.has(retryKey)
  ) {
    showGenerationPanel({
      title: result.captionsDetected
        ? "YouTube CC detected"
        : "YouTube captions are still loading",
      message:
        result.youtubeMessage ||
        "YouTube caption data could not be read from the current player session.",
      status: [
        freeAttemptStatus ? `Free sources: ${freeAttemptStatus}.` : "",
        "Retry the free YouTube captions before using a paid transcript source.",
      ].filter(Boolean).join(" "),
      primaryLabel: "Retry YouTube CC",
      primaryAction: () => retryYouTubeCaptions(result, context, retryKey),
    });
    return;
  }
  const estimate = Number(result.estimatedCredits);
  const cost = estimate
    ? `Estimated cost: about ${estimate} credits (${Math.ceil((result.videoDuration || 0) / 60)} min × 2).`
    : "Supadata charges 2 credits per generated transcript minute; the exact estimate is unavailable.";
  if (!result.hasSupadataKey) {
    showGenerationPanel({
      title: "No free English captions",
      message: `${result.message} ${cost}`,
      status: [
        freeAttemptStatus ? `Free sources: ${freeAttemptStatus}.` : "",
        "Live AI can create subtitles while the video plays.",
      ].filter(Boolean).join(" "),
      primaryLabel: "Open Settings",
      primaryAction: () => chrome.runtime.sendMessage({ action: "openOptions" }),
    });
    return;
  }
  showGenerationPanel({
    title: "Generate full transcript?",
    message: `${result.message} ${cost} Submitted jobs cannot be cancelled or refunded.`,
    status: [
      freeAttemptStatus ? `Free sources: ${freeAttemptStatus}.` : "",
      "You must confirm separately for each video.",
    ].filter(Boolean).join(" "),
    primaryLabel: estimate ? `Generate transcript (~${estimate} credits)` : "Generate transcript",
    primaryAction: () => startConfirmedSupadataGeneration(context),
  });
}

async function retryYouTubeCaptions(previousResult, context, retryKey) {
  if (!isCurrentYoutubeContext(context)) return;
  youtubeCaptionRetryContexts.add(retryKey);
  showGenerationPanel({
    title: "Retrying YouTube CC",
    message: "Refreshing the current player's caption tracks and signed URLs…",
    status: "No Supadata request is being made.",
    primaryLabel: "Retrying…",
    primaryAction: null,
  });
  const primary = document.getElementById("generateTranscriptBtn");
  primary.disabled = true;
  const result = await chrome.runtime
    .sendMessage({
      action: "fetchTranscript",
      videoId: context.videoId,
      tabId: context.tabId,
      videoDuration:
        currentVideoDuration || Number(previousResult.videoDuration) || 0,
      pageGeneration: context.generation,
      forceYoutubeRetry: true,
    })
    .catch((error) => ({
      success: false,
      error: "YOUTUBE_CAPTION_FETCH_FAILED",
      message: error.message,
    }));
  primary.disabled = false;
  if (!isCurrentYoutubeContext(context)) return;
  if (result.success) {
    await acceptTranscriptResult(result, context.videoId, context);
    return;
  }
  if (result.pending) {
    resumeSupadataGeneration(result, context);
    return;
  }
  if (result.requiresGenerationConfirmation || result.liveAiAvailable) {
    showSupadataDecision(result, context, { skipYoutubeRetry: true });
    return;
  }
  showError(
    "YouTube captions unavailable",
    result.message || result.error || "YouTube caption data could not be read.",
  );
}

async function startConfirmedSupadataGeneration(context) {
  if (!isCurrentYoutubeContext(context)) return;
  showGenerationPanel({
    title: "Generating transcript",
    message: "Submitting this video to Supadata AI…",
    status: "Please keep this panel open until a job ID is saved.",
    primaryLabel: "Submitting…",
    primaryAction: null,
  });
  document.getElementById("generateTranscriptBtn").disabled = true;
  const result = await chrome.runtime.sendMessage({
    action: "startSupadataGeneration",
    videoId: context.videoId,
  }).catch((error) => ({ success: false, error: error.message }));
  document.getElementById("generateTranscriptBtn").disabled = false;
  if (!isCurrentYoutubeContext(context)) return;
  if (result.success) {
    await acceptTranscriptResult(result, context.videoId, context);
  } else if (result.pending) {
    resumeSupadataGeneration(result, context);
  } else {
    showGenerationPanel({
      title: "Full transcript unavailable",
      message: result.message || result.error || "Supadata AI transcription failed.",
      status: "Use Live AI to generate subtitles as the video plays.",
      hidePrimary: true,
    });
  }
}

async function resumeSupadataGeneration(job, context) {
  const token = ++generationPollingToken;
  const startedAt = Number(job.createdAt) || Date.now();
  const renderPending = (status) => {
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    showGenerationPanel({
      title: "Generating transcript",
      message: `Supadata AI job is ${status}. You can close the side panel and resume later.`,
      status: `Waiting ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`,
      primaryLabel: "Stop polling",
      primaryAction: () => {
        generationPollingToken += 1;
        document.getElementById("generationStatus").textContent = "Polling paused. Reopen this video to resume checking the saved job.";
      },
    });
  };
  renderPending(job.status || "queued");
  while (token === generationPollingToken && isCurrentYoutubeContext(context)) {
    if (Date.now() - startedAt > 15 * 60 * 1000) {
      showGenerationPanel({
        title: "Transcript is still processing",
        message: "Local polling paused after 15 minutes. The Supadata job remains saved and can be checked when you reopen this video.",
        status: "Live AI is available while the job continues.",
        primaryLabel: "Resume polling",
        primaryAction: () => resumeSupadataGeneration(job, context),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (token !== generationPollingToken || !isCurrentYoutubeContext(context)) return;
    const result = await chrome.runtime.sendMessage({
      action: "pollSupadataGeneration",
      videoId: context.videoId,
      jobId: job.jobId,
    }).catch((error) => ({ success: false, error: error.message }));
    if (result.success) {
      await acceptTranscriptResult(result, context.videoId, context);
      return;
    }
    if (result.pending) {
      job = result;
      renderPending(result.status || "queued");
      continue;
    }
    showGenerationPanel({
      title: "Full transcript unavailable",
      message: result.message || result.error || "Supadata AI transcription failed.",
      status: "Use Live AI to generate subtitles as the video plays.",
      hidePrimary: true,
    });
    return;
  }
}

function offerLiveAi() {
  generationPollingToken += 1;
  const card = document.getElementById("liveCaptionCard");
  if (card) {
    card.open = true;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const status = document.getElementById("liveCaptionStatus");
  if (status) status.textContent = "Source: Deepgram. Click Start subtitles to create live subtitles while the video plays.";
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[LingoLens Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="Save this quote as a note">📝 Note</button>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[LingoLens Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = "✓ Copied";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ Copy";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "✓ Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[LingoLens] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[LingoLens] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> Source: ${escapeHtml(currentTranscriptSourceLabel)} · ${escapeHtml(getOriginalTranscriptLabel())}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function copyTranscript() {
  copyToClipboardWithFeedback(currentTranscriptText || "", "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = currentTranscriptText || "";
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by LingoLens\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("generationState").style.display =
    state === "generation" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in LingoLens Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// PAGE-AGNOSTIC BILINGUAL CAPTIONS
// ============================================================

async function initializeLiveCaptions() {
  let tab;
  try {
    tab = await activePanelTab();
  } catch (error) {
    clearLiveCaptionUi(error.message);
    return;
  }
  const url = tab.url || tab.pendingUrl || "";
  adoptLiveCaptionContext(tab.id, url);
  const snapshot = await chrome.runtime
    .sendMessage({ action: "getCaptionSessionSnapshot" })
    .catch(() => null);
  if (snapshot?.session && captionSessionMatchesCurrentContext(snapshot.session)) {
    activeLiveCaptionSession = snapshot.session;
    renderLiveCaptionSession();
  } else if (snapshot?.session) {
    chrome.runtime.sendMessage({ action: "stopCaptionSession" }).catch(() => {});
  }
  await prepareLiveCaptionPage("", { ...liveCaptionContext });
}

async function prepareLiveCaptionPage(
  videoId = "",
  expectedContext = { ...liveCaptionContext },
) {
  const status = document.getElementById("liveCaptionStatus");
  const startButton = document.getElementById("startLiveCaptionBtn");
  const select = document.getElementById("liveVideoSelect");
  status.textContent = "Inspecting videos and complete subtitle tracks…";
  startButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) {
      throw new Error("Open a normal web page with a video.");
    }
    if (
      expectedContext.generation !== liveCaptionContext.generation ||
      captionPageKey(tab.id, tab.url) !== expectedContext.key
    ) {
      return;
    }
    liveCaptionTabId = tab.id;
    const result = await chrome.runtime.sendMessage({
      action: "prepareCaptionPage",
      tabId: tab.id,
      videoId,
    });
    if (!result?.success) throw new Error(result?.error || "Page inspection failed.");
    if (
      expectedContext.generation !== liveCaptionContext.generation ||
      captionPageKey(tab.id, result.page?.url || tab.url) !== expectedContext.key
    ) {
      return;
    }
    preparedCaptionPage = result;
    select.innerHTML = "";
    for (const video of result.page.videos || []) {
      const option = document.createElement("option");
      option.value = video.id;
      option.textContent = `${video.label} · ${video.duration ? Math.round(video.duration / 60) + " min" : "live"}`;
      option.selected = video.id === result.page.selectedVideoId;
      select.appendChild(option);
    }
    select.disabled = (result.page.videos || []).length < 2;
    const warning = document.getElementById("liveCaptionWarning");
    warning.hidden = !result.page.multipleAudibleVideos;
    warning.textContent = result.page.multipleAudibleVideos
      ? "More than one audible video is playing. Live recognition may mix their audio."
      : "";
    if (!(result.page.videos || []).length) {
      status.textContent = "No HTML5 video was found on this page.";
      return;
    }
    const youtubeTrackSegments = currentVideoId ? youtubePrefetchedSegments() : [];
    const hasTrack = !!result.transcript?.segments?.length || youtubeTrackSegments.length > 0;
    const detectedSource = youtubeTrackSegments.length
      ? currentTranscriptSourceLabel
      : result.transcript?.language || "video";
    status.textContent = hasTrack
      ? `Complete ${detectedSource} subtitles found. Full-context translation will be used.`
      : "No complete subtitle track found. Start will use live speech recognition.";
    document.getElementById("liveCaptionMode").textContent = hasTrack
      ? "Full transcript"
      : "Live fallback";
    startButton.disabled = !!activeLiveCaptionSession && !/stopped|ended|closed|error/.test(activeLiveCaptionSession.status);
  } catch (error) {
    preparedCaptionPage = null;
    status.textContent = error.message;
    select.innerHTML = "<option>Unavailable</option>";
    select.disabled = true;
  }
}

function youtubePrefetchedSegments() {
  const grouped = groupTranscriptEntries(currentTranscript || []);
  return grouped.map((segment, index) => ({
    id: `youtube-${segment.id}`,
    transcriptId: segment.id,
    startMs: Math.round(segment.start * 1000),
    endMs: (() => {
      const startMs = Math.round(segment.start * 1000);
      const naturalEndMs = Math.max(
        startMs + 250,
        Math.round((segment.start + Math.max(0.25, Number(segment.duration) || 0)) * 1000),
      );
      const nextStartMs = Number.isFinite(Number(grouped[index + 1]?.start))
        ? Math.round(Number(grouped[index + 1].start) * 1000)
        : null;
      return nextStartMs !== null && nextStartMs > startMs
        ? Math.max(startMs + 250, Math.min(naturalEndMs, nextStartMs))
        : naturalEndMs;
    })(),
    sourceText: segment.text,
    recognitionState: "final",
    translationState: "queued",
    source: currentTranscriptSource,
  }));
}

async function startLiveCaptions() {
  const button = document.getElementById("startLiveCaptionBtn");
  const status = document.getElementById("liveCaptionStatus");
  if (!preparedCaptionPage || !liveCaptionTabId) return;
  button.disabled = true;
  const requestedVideoId = document.getElementById("liveVideoSelect").value;
  await prepareLiveCaptionPage(requestedVideoId, { ...liveCaptionContext });
  if (!preparedCaptionPage || !liveCaptionTabId) return;
  button.disabled = true;
  status.textContent = "Starting subtitles…";
  const genericSegments = preparedCaptionPage.transcript?.segments || [];
  const youtubeSegments = currentVideoId ? youtubePrefetchedSegments() : [];
  // Any complete normalized transcript is preferred over live ASR.
  const prefetchedSegments = youtubeSegments.length
    ? youtubeSegments
    : genericSegments;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "startCaptionSession",
      tabId: liveCaptionTabId,
      videoId: preparedCaptionPage.page.selectedVideoId,
      currentTime: preparedCaptionPage.page.currentTime || 0,
      prefetchedSegments,
      sourceLabel: prefetchedSegments.length ? currentTranscriptSourceLabel : "Deepgram",
      sourceLanguage: prefetchedSegments.length
        ? currentTranscriptLanguage || "auto-detected"
        : "en",
      youtubeVideoId: currentVideoId || "",
      transcriptVideoId: youtubeSegments.length ? currentVideoId : "",
      transcriptSourceHash: youtubeSegments.length ? currentSourceHash : "",
    });
    if (result?.requiresActionClick) {
      status.textContent = result.error;
      return;
    }
    if (!result?.success) throw new Error(result?.error || "Could not start subtitles.");
    activeLiveCaptionSession = result.session;
    renderLiveCaptionSession();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

async function stopLiveCaptions() {
  const result = await chrome.runtime.sendMessage({ action: "stopCaptionSession" });
  if (result?.session) activeLiveCaptionSession = result.session;
  renderLiveCaptionSession(true);
}

function renderLiveCaptionSession(stopped = false) {
  const session = activeLiveCaptionSession;
  const status = document.getElementById("liveCaptionStatus");
  const mode = document.getElementById("liveCaptionMode");
  const start = document.getElementById("startLiveCaptionBtn");
  const stop = document.getElementById("stopLiveCaptionBtn");
  const exports = document.getElementById("liveExportControls");
  if (!session) return;
  status.textContent = session.error
    ? `${session.status}: ${session.error}`
    : `Source: ${session.source} · ${session.status}`;
  mode.textContent = session.mode === "prefetched" ? "Full transcript" : "Live AI";
  const running = !stopped && !/stopped|ended|closed|error|navigated/.test(session.status);
  start.disabled = running;
  stop.disabled = !running;
  const segments = session.segments || [];
  exports.hidden = !segments.some((segment) => segment.recognitionState === "final");
}

function exportLiveCaptionSession(format) {
  const session = activeLiveCaptionSession;
  if (!session) return;
  const safeName = sanitizeFilename(session.title || "live-captions");
  if (format === "srt") {
    downloadTextFile(YTD_LIVE_CAPTIONS.exportSrt(session), `${safeName}.srt`);
  } else if (format === "vtt") {
    downloadTextFile(YTD_LIVE_CAPTIONS.exportVtt(session), `${safeName}.vtt`);
  } else {
    downloadTextFile(YTD_LIVE_CAPTIONS.exportMarkdown(session), `${safeName}.md`);
  }
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (tabName === "overview" && !currentAnalysis && !isAnalysisLoading) {
    triggerAnalysis();
  }
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  isAnalysisLoading = true;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters...</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes...</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (!analysisResult.success) {
      if (chapterList)
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Analysis failed: ${escapeHtml(analysisResult.error || "Unknown error")}</li>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    console.error("[LingoLens Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Error: ${escapeHtml(error.message)}</li>`;
  }

  isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[LingoLens Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[LingoLens Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[LingoLens Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[LingoLens Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: youtubeTabId,
      expectedVideoId: currentVideoId,
      payload,
    });
    debugLog("[LingoLens Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[LingoLens Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "✓ Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    const translationPrefix = `${videoId}:${currentSourceHash}:zh:${currentAiModel}:`;
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(translationPrefix)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptSource: currentTranscriptSource,
      transcriptSourceLabel: currentTranscriptSourceLabel,
      transcriptRecord: currentTranscriptRecord,
      sourceHash: currentSourceHash,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      timestamp: Date.now(),
    };

    const transcriptKey = transcriptCacheStorageKey(currentTranscriptRecord);
    const transcriptIndexKey = `ytd_transcript_index_v2_${videoId}`;
    await chrome.storage.local.set({
      [`digest_${videoId}`]: cacheData,
      [transcriptKey]: {
        record: currentTranscriptRecord,
        transcriptText: currentTranscriptText,
        transcriptTimestamped: currentTranscriptTimestamped,
        sourceLabel: currentTranscriptSourceLabel,
        sourceHash: currentSourceHash,
        timestamp: Date.now(),
      },
      [transcriptIndexKey]: { key: transcriptKey, timestamp: Date.now() },
    });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      const expiredVideos = expired.map((key) => key.slice("digest_".length));
      const related = Object.keys(allData).filter((key) =>
        expiredVideos.some(
          (videoId) =>
            key === `ytd_transcript_index_v2_${videoId}` ||
            key.startsWith(`ytd_transcript_v2_${videoId}_`) ||
            key.startsWith(`ytd_translation_v2_${videoId}_`) ||
            key === `supadata_result_${videoId}`,
        ),
      );
      await chrome.storage.local.remove([...expired, ...related]);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      const removedVideos = toRemove.map((key) => key.slice("digest_".length));
      const related = Object.keys(allData).filter((key) =>
        removedVideos.some(
          (videoId) =>
            key === `ytd_transcript_index_v2_${videoId}` ||
            key.startsWith(`ytd_transcript_v2_${videoId}_`) ||
            key.startsWith(`ytd_translation_v2_${videoId}_`) ||
            key === `supadata_result_${videoId}`,
        ),
      );
      await chrome.storage.local.remove([...toRemove, ...related]);
      debugLog(`[LingoLens] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const indexKey = `ytd_transcript_index_v2_${videoId}`;
    const indexResult = await chrome.storage.local.get([
      `digest_${videoId}`,
      indexKey,
    ]);
    let cached = indexResult[`digest_${videoId}`];
    const index = indexResult[indexKey];
    if (index?.key) {
      const recordResult = await chrome.storage.local.get(index.key);
      const storedTranscript = recordResult[index.key];
      if (storedTranscript?.record && Date.now() - storedTranscript.timestamp <= 30 * 24 * 60 * 60 * 1000) {
        cached = {
          ...(cached || {}),
          transcript: storedTranscript.record.segments,
          transcriptText: storedTranscript.transcriptText,
          transcriptTimestamped: storedTranscript.transcriptTimestamped,
          transcriptLanguage: storedTranscript.record.language,
          transcriptSource: storedTranscript.record.source,
          transcriptSourceLabel: storedTranscript.sourceLabel,
          transcriptRecord: storedTranscript.record,
          sourceHash: storedTranscript.sourceHash,
          timestamp: storedTranscript.timestamp,
        };
      }
    }

    if (!cached) return null;

    if (isLegacyYoutubeTranscriptCache(cached)) {
      const allData = await chrome.storage.local.get(null);
      const sourceHash = String(cached.sourceHash || "");
      const related = Object.keys(allData).filter((key) =>
        key === `digest_${videoId}` ||
        key === indexKey ||
        key === index?.key ||
        (sourceHash && key.startsWith(`ytd_translation_v2_${videoId}_${sourceHash}_`)),
      );
      if (related.length) await chrome.storage.local.remove(related);
      return null;
    }

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

function isLegacyYoutubeTranscriptCache(cached) {
  const legacySource = String(
    cached?.transcriptRecord?.source || cached?.transcriptSource || "",
  );
  const source = legacySource === "youtube-captions" ? "youtube-manual" : legacySource;
  if (!["youtube-manual", "youtube-auto"].includes(source)) return false;
  return Number(cached?.transcriptRecord?.sourceVersion || 1) <
    YOUTUBE_TRANSCRIPT_SOURCE_VERSION;
}

function transcriptCacheStorageKey(record) {
  const safe = (value) => String(value || "unknown").replace(/[^a-z0-9_-]/gi, "_");
  return `ytd_transcript_v2_${safe(record?.videoId)}_${safe(record?.language)}_${safe(record?.source)}_${safe(record?.sourceVersion || 1)}`;
}

function translationCacheStorageKey(videoId, sourceHash, model) {
  return YTD_TRANSCRIPT_TRANSLATION.translationStorageKey(
    videoId,
    sourceHash,
    model,
  );
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[LingoLens Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "⧉ Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "🔗 Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[LingoLens Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      tabId: youtubeTabId,
      expectedVideoId: currentVideoId,
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    if (Math.abs(currentTime - lastPlaybackTime) >= 3) {
      lastPlaybackTime = currentTime;
      activeTranslationQueue?.reprioritize?.();
    }
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) {
    entries.forEach((entry) => entry.classList.remove("active-playback"));
    return;
  }

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return YTD_TRANSCRIPT_TRANSLATION.translationItemKey(
    currentVideoId,
    currentSourceHash,
    currentAiModel,
    segment.id,
  );
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> Source: ${escapeHtml(currentTranscriptSourceLabel)} · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateTranscriptBatch",
      profile: "semantic",
      videoId: currentVideoId,
      sourceHash: currentSourceHash,
      segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      videoTitle: currentVideoTitle,
      sourceLanguage: currentTranscriptLanguage || "auto-detected",
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const aligned = result?.success ? result.segments : sourceBatch.map((segment) => ({
      id: segment.id,
      text: "",
      error: result?.error || "Translation failed.",
      cached: false,
    }));
    aligned.forEach((item, batchIndex) => {
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  // Settings may have changed while this persistent side panel stayed open.
  // Refresh the selected model before reading or writing model-scoped caches.
  const storedSettings = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  currentAiModel = YTD_SETTINGS.normalize(
    storedSettings[YTD_SETTINGS.STORAGE_KEY],
  ).aiModel;
  if (currentVideoId && currentSourceHash) {
    const key = translationCacheStorageKey(
      currentVideoId,
      currentSourceHash,
      currentAiModel,
    );
    const storedTranslations = (await chrome.storage.local.get(key))[key]
      ?.translations || {};
    for (const [cacheKey, value] of Object.entries(storedTranslations)) {
      transcriptParagraphCache.set(cacheKey, value);
    }
  }

  const playback = await chrome.runtime.sendMessage({
    action: "relayToContent",
    tabId: youtubeTabId,
    expectedVideoId: currentVideoId,
    payload: { action: "getCurrentTime" },
  }).catch(() => null);
  if (playback?.success && playback.response) {
    lastPlaybackTime = Number(playback.response.currentTime) || 0;
  }

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  const viewportPriority = new Set();
  let processing = false;

  const queuePriority = (index) => {
    const start = Number(segments[index]?.start) || 0;
    return transcriptTranslationPriority(
      start,
      lastPlaybackTime,
      viewportPriority.has(index),
    );
  };

  const reprioritize = () => queue.sort((a, b) => queuePriority(a) - queuePriority(b));

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    reprioritize();
    const indices = queue.splice(0, 3);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    reprioritize();
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue, reprioritize };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => {
          const index = Number(entry.target.dataset.segmentIndex);
          viewportPriority.add(index);
          enqueue(index);
        });
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  renderSubtitleInlineMarkup,
  stableTranscriptHash,
  transcriptCacheStorageKey,
  translationCacheStorageKey,
  transcriptTranslationPriority,
  renderTranscriptSegmentContent,
  isLegacyYoutubeTranscriptCache,
};
