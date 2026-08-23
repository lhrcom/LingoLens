/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");
importScripts("live-caption-shared.js");
importScripts("ai-provider-core.js");
importScripts("transcript-translation-core.js");
importScripts("transcript-translation-background.js");
importScripts("youtube-caption-core.js");
importScripts("page-translation-core.js");
importScripts("page-translation-background.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[LingoLens] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function withAiProviderResponse({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  stream = false,
  signal,
}, consume) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "DeepSeek API key not configured. Open LingoLens Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  if (stream) body.stream = true;
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

  const lifecycle = YTD_AI_PROVIDER.createLifecycle({
    signal,
    idleTimeoutMs: AI_PROVIDER_IDLE_TIMEOUT_MS,
    hardTimeoutMs: AI_PROVIDER_HARD_TIMEOUT_MS,
  });
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    lifecycle.activity();

    if (!response.ok) {
      let data = {};
      try {
        data = await readBoundedAiResponse(response, lifecycle.activity);
      } catch (error) {
        if (error.code === "AI_RESPONSE_TOO_LARGE") throw error;
      }
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      error.code = response.status === 429
        ? "RATE_LIMITED"
        : response.status === 401
          ? "INVALID_AI_KEY"
          : response.status >= 500
            ? "AI_PROVIDER_UNAVAILABLE"
            : "AI_PROVIDER_ERROR";
      throw error;
    }
    return { value: await consume(response, lifecycle.activity), settings };
  } catch (error) {
    throw lifecycle.normalizeError(error);
  } finally {
    lifecycle.finish();
  }
}

async function requestAiCompletion(options) {
  const { value: text, settings } = await withAiProviderResponse(
    options,
    async (response, onActivity) => {
      const data = await readBoundedAiResponse(response, onActivity);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        const error = new Error("DeepSeek returned an empty response.");
        error.code = "EMPTY_AI_RESPONSE";
        throw error;
      }
      return content;
    },
  );
  return { text, settings };
}

async function readBoundedAiResponse(response, onActivity) {
  return YTD_AI_PROVIDER.readJson(response, {
    maxBytes: AI_PROVIDER_MAX_RESPONSE_BYTES,
    onActivity,
  });
}

async function requestAiCompletionStream({ messages, onDelta, signal }) {
  const { value } = await withAiProviderResponse(
    {
      messages,
      maxTokens: 1000,
      temperature: 0.1,
      stream: true,
      signal,
    },
    async (response, onActivity) => {
      return YTD_AI_PROVIDER.readSse(response, {
        maxBytes: AI_PROVIDER_MAX_RESPONSE_BYTES,
        onActivity,
        onDelta,
      });
    },
  );
  if (!value) {
    const error = new Error("DeepSeek returned an empty response.");
    error.code = "EMPTY_AI_RESPONSE";
    throw error;
  }
  return value;
}

const transcriptTranslationService =
  YTD_TRANSCRIPT_TRANSLATION_BACKGROUND.createService({
    getSettings,
    getTranslationBaseRules,
    loadPromptSection,
    requestAiCompletion,
    storage: chrome.storage.local,
  });

async function translateTranscriptBatch(message, options) {
  return transcriptTranslationService.translateTranscriptBatch(message, options);
}

// Page translation shares the same validated ytd_settings record and the same
// bounded DeepSeek request path as every existing Digest AI feature.
globalThis.YTD_PAGE_TRANSLATION_BACKGROUND?.register({ requestAiCompletion });

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // tabCapture can only redeem activeTab while this toolbar click's user
  // gesture is still active. Resume any pending Live AI request first.
  globalThis.YTD_LIVE_CAPTION_BACKGROUND?.resumePendingFromAction?.(tab);
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel available on normal web pages and unavailable on
 * privileged browser pages where active-tab capture cannot run.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. We enable the panel on HTTP(S) tabs and disable it on
 * privileged pages. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
function updatePanelForTab(tabId, url) {
  const supportedPage = /^https?:\/\//.test(url || "");
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: supportedPage })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId, message.tabId, message.videoDuration)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "startSupadataGeneration") {
    startSupadataGeneration(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "pollSupadataGeneration") {
    pollSupadataGeneration(message.videoId, message.jobId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "translateTranscriptBatch") {
    translateTranscriptBatch(message)
      .then((segments) => sendResponse({ success: true, segments }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[LingoLens BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[LingoLens BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[LingoLens BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[LingoLens BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Side-panel callers can pin the request to the exact tab/video.
        // Legacy callers without a tabId retain the older discovery fallback.
        let tabs = message.tabId
          ? [await chrome.tabs.get(message.tabId)]
          : await chrome.tabs.query({
              active: true,
              lastFocusedWindow: true,
            });
        debugLog(
          "[LingoLens BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!message.tabId && (!tabs[0] || !tabs[0].url?.includes("youtube.com"))) {
          tabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          debugLog("[LingoLens BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!message.tabId && !tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
          debugLog("[LingoLens BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          const targetVideoId = YTD_LIVE_CAPTIONS.youtubeVideoId(tabs[0].url);
          if (
            message.expectedVideoId &&
            targetVideoId !== message.expectedVideoId
          ) {
            throw new Error("The requested YouTube video is no longer active.");
          }
          debugLog(
            "[LingoLens BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (
              message.expectedVideoId &&
              playerInfo?.videoId !== message.expectedVideoId
            ) {
              throw new Error("YouTube is still loading the requested video.");
            }
            if (
              playerInfo &&
              (!message.expectedVideoId ||
                playerInfo.videoId === message.expectedVideoId)
            ) {
              response = {
                videoId: playerInfo.videoId || response?.videoId || targetVideoId,
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          if (
            message.expectedVideoId &&
            response?.videoId !== message.expectedVideoId
          ) {
            throw new Error("YouTube is still loading the requested video.");
          }

          debugLog("[LingoLens BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[LingoLens BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[LingoLens BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            videoId: details.videoId || "",
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[LingoLens BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
const SUPADATA_JOB_PREFIX = "supadata_job_";
const SUPADATA_RESULT_PREFIX = "supadata_result_";

function supadataJobKey(videoId) {
  return `${SUPADATA_JOB_PREFIX}${videoId}`;
}

function supadataResultKey(videoId) {
  return `${SUPADATA_RESULT_PREFIX}${videoId}`;
}

async function persistGeneratedResult(videoId, result) {
  if (result?.success) {
    await chrome.storage.local.set({
      [supadataResultKey(videoId)]: { result, timestamp: Date.now() },
    });
  }
  return result;
}

function normalizeProviderTranscript(videoId, data, source = "supadata-ai") {
  const result = YTD_YOUTUBE_CAPTIONS.normalizeTranscript(data?.content, {
    videoId,
    language: typeof data?.lang === "string" ? data.lang : null,
    source,
    sourceVersion: 1,
  });
  if (!result.success) {
    return {
      success: false,
      error: "EMPTY_TRANSCRIPT",
      message: "Supadata returned an empty generated transcript.",
      liveAiAvailable: true,
    };
  }
  return result;
}

async function supadataFailure(response) {
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    return { success: false, error: "INVALID_SUPADATA_KEY", message: "Your Supadata API key is invalid.", liveAiAvailable: true };
  }
  if (response.status === 402) {
    return { success: false, error: "SUPADATA_PAYMENT_REQUIRED", message: "Supadata requires a plan upgrade or payment for AI transcription.", liveAiAvailable: true };
  }
  const classified = YTD_YOUTUBE_CAPTIONS.classifySupadataFailure(response.status, data);
  if (classified) return { success: false, ...classified, liveAiAvailable: true };
  return {
    success: false,
    error: `SUPADATA_HTTP_${response.status}`,
    message: data.message || `Supadata AI transcription failed (${response.status}).`,
    liveAiAvailable: true,
  };
}

async function startSupadataGeneration(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Add a Supadata API key in LingoLens Settings, or use Live AI.",
        liveAiAvailable: true,
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    // YouTube captions were already checked, so explicitly request AI ASR.
    // Supadata ignores lang in generate mode and detects the spoken language.
    apiUrl.searchParams.set("mode", "generate");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    if (response.status === 202) {
      const jobData = await response.json();
      if (!jobData?.jobId) throw new Error("Supadata returned no job ID.");
      const job = {
        videoId,
        jobId: jobData.jobId,
        status: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ [supadataJobKey(videoId)]: job });
      return { success: false, pending: true, ...job, source: "supadata-ai", sourceLabel: "Supadata AI" };
    }

    if (!response.ok) return await supadataFailure(response);
    return await persistGeneratedResult(
      videoId,
      normalizeProviderTranscript(videoId, await response.json()),
    );
  } catch (error) {
    console.error("Supadata generation error:", error);
    return {
      success: false,
      error: "SUPADATA_UNAVAILABLE",
      message: error.message || "Supadata AI transcription is unavailable.",
      liveAiAvailable: true,
    };
  }
}

async function pollSupadataGeneration(videoId, requestedJobId) {
  try {
    const stored = await chrome.storage.local.get(supadataJobKey(videoId));
    const job = stored[supadataJobKey(videoId)];
    if (!job || job.jobId !== requestedJobId) {
      return { success: false, error: "SUPADATA_JOB_NOT_FOUND", message: "The saved Supadata job was not found.", liveAiAvailable: true };
    }
    const settings = await getSettings();
    if (!settings.supadataApiKey) return { success: false, error: "NO_SUPADATA_KEY", message: "Add your Supadata API key to resume this job.", liveAiAvailable: true };
    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(job.jobId)}`,
      {
        headers: { "x-api-key": settings.supadataApiKey },
      },
    );
    if (!response.ok) return await supadataFailure(response);
    const data = await response.json();
    if (data.status === "completed") {
      await chrome.storage.local.remove(supadataJobKey(videoId));
      return await persistGeneratedResult(
        videoId,
        normalizeProviderTranscript(videoId, data),
      );
    }
    if (data.status === "failed") {
      await chrome.storage.local.remove(supadataJobKey(videoId));
      return { success: false, error: "SUPADATA_JOB_FAILED", message: data.error?.details || data.error?.message || "Supadata AI transcription failed.", liveAiAvailable: true };
    }
    const nextJob = { ...job, status: data.status === "active" ? "active" : "queued", updatedAt: Date.now() };
    await chrome.storage.local.set({ [supadataJobKey(videoId)]: nextJob });
    return { success: false, pending: true, ...nextJob, source: "supadata-ai", sourceLabel: "Supadata AI" };
  } catch (error) {
    return { success: false, error: "SUPADATA_UNAVAILABLE", message: error.message || "Could not check the Supadata job.", liveAiAvailable: true };
  }
}

const youtubeCaptionCache = new Map();
const YOUTUBE_CAPTION_SOURCE_VERSION = 2;
const YOUTUBE_CAPTION_RETRY_DELAYS_MS = [0, 150, 350, 700, 1200];
const YOUTUBE_CAPTION_DOWNLOAD_RETRY_DELAYS_MS = [0, 400];
const MAX_YOUTUBE_CAPTION_RESPONSE_BYTES = 8 * 1024 * 1024;

async function resolveYouTubeTranscriptTab(videoId, requestedTabId) {
  if (requestedTabId) {
    const tab = await chrome.tabs.get(requestedTabId);
    if (YTD_LIVE_CAPTIONS.youtubeVideoId(tab.url || tab.pendingUrl) === videoId) return tab;
    throw new Error("The YouTube video changed before captions could be read.");
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.find((candidate) => YTD_LIVE_CAPTIONS.youtubeVideoId(candidate.url) === videoId);
  if (!tab?.id) throw new Error("The current YouTube tab could not be identified.");
  return tab;
}

async function readYouTubeCaptionTracks(tabId, videoId) {
  let lastMatchingResponse = null;
  let sawDifferentVideo = false;
  for (const delay of YOUTUBE_CAPTION_RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [videoId],
      func: (expectedVideoId) => {
        try {
          const readInlinePlayerResponse = () => {
            const marker = "var ytInitialPlayerResponse = ";
            for (const script of document.scripts) {
              const text = script.textContent || "";
              const markerIndex = text.indexOf(marker);
              if (markerIndex < 0) continue;
              const start = markerIndex + marker.length;
              let depth = 0;
              let inString = false;
              let escaped = false;
              for (let index = start; index < text.length; index += 1) {
                const character = text[index];
                if (inString) {
                  if (escaped) escaped = false;
                  else if (character === "\\") escaped = true;
                  else if (character === '"') inString = false;
                  continue;
                }
                if (character === '"') inString = true;
                else if (character === "{") depth += 1;
                else if (character === "}") {
                  depth -= 1;
                  if (depth === 0) return JSON.parse(text.slice(start, index + 1));
                }
              }
            }
            return null;
          };
          const candidates = [
            document.getElementById("movie_player")?.getPlayerResponse?.(),
            globalThis.ytInitialPlayerResponse,
            readInlinePlayerResponse(),
          ].filter(Boolean);
          const response =
            candidates.find(
              (candidate) => candidate?.videoDetails?.videoId === expectedVideoId,
            ) || candidates[0];
          const actualVideoId = response?.videoDetails?.videoId || "";
          const captionTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          return {
            videoDetails: {
              videoId: actualVideoId,
              lengthSeconds: response?.videoDetails?.lengthSeconds || "0",
            },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: captionTracks.map((track) => ({
                  baseUrl: track.baseUrl || "",
                  languageCode: track.languageCode || "",
                  kind: track.kind || "",
                  name: track.name || {},
                  isTranslatable: !!track.isTranslatable,
                })),
              },
            },
            expectedVideoId,
          };
        } catch (_error) {
          return null;
        }
      },
    });
    const extracted = YTD_YOUTUBE_CAPTIONS.extractTracks(
      results?.[0]?.result,
      videoId,
    );
    if (extracted.success && extracted.tracks.length) return extracted;
    if (extracted.success) lastMatchingResponse = extracted;
    if (extracted.error === "VIDEO_CONTEXT_CHANGED" && extracted.videoId) {
      sawDifferentVideo = true;
    }
  }
  if (lastMatchingResponse) return lastMatchingResponse;
  return {
    success: false,
    error: sawDifferentVideo ? "VIDEO_CONTEXT_CHANGED" : "YOUTUBE_PLAYER_NOT_READY",
    tracks: [],
    duration: 0,
  };
}

function validateTimedTextUrl(rawUrl, videoId) {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      !/(^|\.)youtube\.com$/i.test(url.hostname) ||
      url.pathname !== "/api/timedtext" ||
      url.searchParams.get("v") !== videoId
    ) {
      return null;
    }
    url.searchParams.set("fmt", "json3");
    return url;
  } catch (_error) {
    return null;
  }
}

async function fetchCaptionTrackInPage(tabId, videoId, track) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [videoId, track.languageCode, track.kind || "", track.baseUrl],
      func: async (expectedVideoId, languageCode, kind, discoveredBaseUrl) => {
        const currentVideoId = () =>
          new URLSearchParams(location.search).get("v") || "";
        if (currentVideoId() !== expectedVideoId) {
          return { success: false, error: "VIDEO_CONTEXT_CHANGED" };
        }
        try {
          const responseCandidate =
            document.getElementById("movie_player")?.getPlayerResponse?.() ||
            globalThis.ytInitialPlayerResponse;
          const response =
            responseCandidate?.videoDetails?.videoId === expectedVideoId
              ? responseCandidate
              : null;
          const tracks =
            response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const freshTrack = tracks.find(
            (candidate) =>
              candidate?.languageCode === languageCode &&
              String(candidate?.kind || "") === kind,
          );
          const freshBaseUrl = freshTrack?.baseUrl || discoveredBaseUrl;
          if (!freshBaseUrl) {
            return { success: false, error: "YOUTUBE_TRACK_NOT_FOUND" };
          }
          const url = new URL(freshBaseUrl, location.href);
          if (
            url.protocol !== "https:" ||
            !/(^|\.)youtube\.com$/i.test(url.hostname) ||
            url.pathname !== "/api/timedtext" ||
            url.searchParams.get("v") !== expectedVideoId
          ) {
            return { success: false, error: "YOUTUBE_TRACK_URL_REJECTED" };
          }
          url.searchParams.set("fmt", "json3");
          const timedTextResponse = await globalThis.fetch(url.toString(), {
            method: "GET",
            credentials: "include",
            cache: "no-store",
          });
          if (!timedTextResponse.ok) {
            return {
              success: false,
              error: "YOUTUBE_CAPTION_HTTP_ERROR",
              status: timedTextResponse.status,
            };
          }
          const body = await timedTextResponse.text();
          if (!body.trim()) {
            return { success: false, error: "YOUTUBE_CAPTION_EMPTY" };
          }
          if (body.length > 8 * 1024 * 1024) {
            return { success: false, error: "YOUTUBE_CAPTION_TOO_LARGE" };
          }
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (_error) {
            return { success: false, error: "YOUTUBE_CAPTION_INVALID_JSON" };
          }
          if (!Array.isArray(payload?.events) || !payload.events.length) {
            return { success: false, error: "YOUTUBE_CAPTION_EMPTY" };
          }
          if (currentVideoId() !== expectedVideoId) {
            return { success: false, error: "VIDEO_CONTEXT_CHANGED" };
          }
          return { success: true, payload: { events: payload.events } };
        } catch (_error) {
          return { success: false, error: "YOUTUBE_CAPTION_FETCH_FAILED" };
        }
      },
    });
    return results?.[0]?.result || {
      success: false,
      error: "YOUTUBE_CAPTION_FETCH_FAILED",
    };
  } catch (_error) {
    return { success: false, error: "YOUTUBE_CAPTION_FETCH_FAILED" };
  }
}

async function fetchCaptionTrackInBackground(videoId, track) {
  const timedTextUrl = validateTimedTextUrl(track.baseUrl, videoId);
  if (!timedTextUrl) {
    return { success: false, error: "YOUTUBE_TRACK_URL_REJECTED" };
  }
  try {
    const response = await fetch(timedTextUrl.toString(), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        success: false,
        error: "YOUTUBE_CAPTION_HTTP_ERROR",
        status: response.status,
      };
    }
    const body = await response.text();
    if (!body.trim()) return { success: false, error: "YOUTUBE_CAPTION_EMPTY" };
    if (body.length > MAX_YOUTUBE_CAPTION_RESPONSE_BYTES) {
      return { success: false, error: "YOUTUBE_CAPTION_TOO_LARGE" };
    }
    try {
      const payload = JSON.parse(body);
      if (!Array.isArray(payload?.events) || !payload.events.length) {
        return { success: false, error: "YOUTUBE_CAPTION_EMPTY" };
      }
      return { success: true, payload };
    } catch (_error) {
      return { success: false, error: "YOUTUBE_CAPTION_INVALID_JSON" };
    }
  } catch (_error) {
    return { success: false, error: "YOUTUBE_CAPTION_FETCH_FAILED" };
  }
}

async function fetchTranscriptViaYouTubeApiInPage(tabId, videoId, tracks) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [
        videoId,
        (Array.isArray(tracks) ? tracks : []).map((track) => ({
          languageCode: String(track.languageCode || ""),
          kind: String(track.kind || ""),
          name: String(track.name || ""),
        })),
      ],
      func: async (expectedVideoId, preferredTracks) => {
        const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
        const MAX_PAGES = 12;
        const MAX_SEGMENTS = 50_000;
        const currentVideoId = () =>
          new URLSearchParams(location.search).get("v") || "";
        const cleanText = (value) => String(value || "")
          .replace(/\n+/g, " ")
          .replace(/>> ?/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const rendererText = (value) => {
          if (typeof value === "string") return cleanText(value);
          if (!value || typeof value !== "object") return "";
          if (typeof value.simpleText === "string") {
            return cleanText(value.simpleText);
          }
          if (Array.isArray(value.runs)) {
            return cleanText(value.runs.map((run) => run?.text || "").join(""));
          }
          return "";
        };
        const walk = (root, visitor, maxNodes = 100_000) => {
          const stack = [root];
          const seen = new Set();
          let visited = 0;
          while (stack.length && visited < maxNodes) {
            const value = stack.pop();
            if (!value || typeof value !== "object" || seen.has(value)) continue;
            seen.add(value);
            visited += 1;
            visitor(value);
            const values = Array.isArray(value) ? value : Object.values(value);
            for (let index = values.length - 1; index >= 0; index -= 1) {
              stack.push(values[index]);
            }
          }
        };
        const parseJsonAfterMarker = (text, marker) => {
          const markerIndex = text.indexOf(marker);
          if (markerIndex < 0) return null;
          const start = markerIndex + marker.length;
          let depth = 0;
          let inString = false;
          let escaped = false;
          for (let index = start; index < text.length; index += 1) {
            const character = text[index];
            if (inString) {
              if (escaped) escaped = false;
              else if (character === "\\") escaped = true;
              else if (character === '"') inString = false;
              continue;
            }
            if (character === '"') inString = true;
            else if (character === "{") depth += 1;
            else if (character === "}") {
              depth -= 1;
              if (depth === 0) {
                try {
                  return JSON.parse(text.slice(start, index + 1));
                } catch (_error) {
                  return null;
                }
              }
            }
          }
          return null;
        };
        const readInlineJson = (markers) => {
          for (const script of document.scripts) {
            const text = script.textContent || "";
            for (const marker of markers) {
              const parsed = parseJsonAfterMarker(text, marker);
              if (parsed) return parsed;
            }
          }
          return null;
        };
        const descriptorFrom = (value) => {
          if (!value || typeof value !== "object") return null;
          const endpoint =
            value.continuationEndpoint ||
            value.serviceEndpoint ||
            value.navigationEndpoint ||
            value;
          const params = endpoint?.getTranscriptEndpoint?.params;
          if (typeof params === "string" && params) return { params };
          const continuation =
            endpoint?.continuationCommand?.token ||
            endpoint?.reloadContinuationData?.continuation ||
            value?.continuation?.reloadContinuationData?.continuation;
          return typeof continuation === "string" && continuation
            ? { continuation }
            : null;
        };
        const findInitialDescriptor = (payload) => {
          let found = null;
          walk(payload, (value) => {
            if (found) return;
            const descriptor = descriptorFrom(value);
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
        };
        const languageOptions = (payload) => {
          const options = [];
          const keys = new Set();
          walk(payload, (value) => {
            const items = Array.isArray(value?.subMenuItems)
              ? value.subMenuItems
              : Array.isArray(value?.dropdownItems)
                ? value.dropdownItems
                : null;
            if (!items) return;
            for (const rawItem of items) {
              const item = rawItem?.dropdownItemRenderer || rawItem;
              const label = rendererText(item?.title || item?.label || item?.text);
              const descriptor = descriptorFrom(item);
              if (!label || !descriptor) continue;
              const key = `${label}:${descriptor.params || descriptor.continuation || ""}`;
              if (keys.has(key)) continue;
              keys.add(key);
              options.push({
                label,
                selected: !!item?.selected,
                languageCode: String(item?.languageCode || ""),
                descriptor,
              });
            }
          });
          return options;
        };
        const automaticLabel = (value) =>
          /(auto(?:matically)?[- ]generated|automatic captions?|\basr\b|自动生成)/i.test(
            String(value || ""),
          );
        const chooseEnglishOption = (options) => {
          const normalizedTracks = preferredTracks.map((track) => ({
            track,
            name: cleanText(track.name).toLowerCase(),
            languageCode: String(track.languageCode || "").toLowerCase(),
          }));
          return options
            .map((option, index) => {
              const label = cleanText(option.label).toLowerCase();
              const languageCode = String(option.languageCode || "").toLowerCase();
              const match = normalizedTracks.find(({ name }) =>
                name && (name === label || name.includes(label) || label.includes(name)),
              ) || normalizedTracks.find(({ languageCode: code }) =>
                languageCode && code === languageCode,
              );
              const english =
                !!match ||
                languageCode === "en" ||
                languageCode.startsWith("en-") ||
                /(^|\W)english(\W|$)/i.test(label);
              if (!english) return null;
              const automatic = match
                ? match.track.kind === "asr"
                : automaticLabel(label);
              return {
                option,
                track: match?.track || null,
                score: automatic ? 300 : 400,
                index,
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score || a.index - b.index)[0] || null;
        };
        const parsePayload = (payload, language) => {
          const segments = [];
          const keys = new Set();
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
            if (keys.has(key)) return;
            keys.add(key);
            segments.push({ text, offset, duration, lang: language || null });
          };
          walk(payload, (value) => {
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
              const descriptor = descriptorFrom(item?.continuationItemRenderer);
              if (!descriptor) continue;
              const key = descriptor.params || descriptor.continuation;
              if (!key || continuationKeys.has(key)) continue;
              continuationKeys.add(key);
              continuations.push(descriptor);
            }
          });
          segments.sort((a, b) => a.offset - b.offset);
          return { segments, continuations };
        };

        if (currentVideoId() !== expectedVideoId) {
          return { success: false, error: "VIDEO_CONTEXT_CHANGED" };
        }
        const playerResponse =
          document.getElementById("movie_player")?.getPlayerResponse?.() ||
          window.ytInitialPlayerResponse ||
          readInlineJson(["var ytInitialPlayerResponse = "]);
        if (
          playerResponse?.videoDetails?.videoId &&
          playerResponse.videoDetails.videoId !== expectedVideoId
        ) {
          return { success: false, error: "VIDEO_CONTEXT_CHANGED" };
        }

        const liveData = document.querySelector("ytd-watch-flexy")?.data || null;
        const inlineData = readInlineJson([
          "var ytInitialData = ",
          'window["ytInitialData"] = ',
          "window['ytInitialData'] = ",
        ]);
        const initialDataCandidates = [liveData, window.ytInitialData, inlineData].filter(Boolean);
        let initialDescriptor = null;
        for (const candidate of initialDataCandidates) {
          initialDescriptor = findInitialDescriptor(candidate);
          if (initialDescriptor) break;
        }
        if (!initialDescriptor) {
          return { success: false, error: "YOUTUBE_TRANSCRIPT_ENDPOINT_NOT_FOUND" };
        }

        const configObjects = [];
        if (window.ytcfg?.get) {
          configObjects.push({
            INNERTUBE_API_KEY: window.ytcfg.get("INNERTUBE_API_KEY"),
            INNERTUBE_CONTEXT: window.ytcfg.get("INNERTUBE_CONTEXT"),
            INNERTUBE_CONTEXT_CLIENT_NAME: window.ytcfg.get("INNERTUBE_CONTEXT_CLIENT_NAME"),
            INNERTUBE_CONTEXT_CLIENT_VERSION: window.ytcfg.get("INNERTUBE_CONTEXT_CLIENT_VERSION"),
            VISITOR_DATA: window.ytcfg.get("VISITOR_DATA"),
          });
        }
        for (const script of document.scripts) {
          const parsed = parseJsonAfterMarker(script.textContent || "", "ytcfg.set(");
          if (parsed) configObjects.push(parsed);
        }
        const config = Object.assign({}, ...configObjects);
        const apiKey = String(config.INNERTUBE_API_KEY || "");
        const context = config.INNERTUBE_CONTEXT;
        if (!apiKey || !context?.client) {
          return { success: false, error: "YOUTUBE_TRANSCRIPT_CONFIG_MISSING" };
        }
        const requestJson = async (descriptor) => {
          if (currentVideoId() !== expectedVideoId) {
            return { success: false, error: "VIDEO_CONTEXT_CHANGED" };
          }
          const url = new URL("/youtubei/v1/get_transcript", location.origin);
          if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/i.test(url.hostname)) {
            return { success: false, error: "YOUTUBE_TRANSCRIPT_URL_REJECTED" };
          }
          url.searchParams.set("key", apiKey);
          url.searchParams.set("prettyPrint", "false");
          const headers = { "Content-Type": "application/json" };
          const clientName = config.INNERTUBE_CONTEXT_CLIENT_NAME;
          const clientVersion =
            config.INNERTUBE_CONTEXT_CLIENT_VERSION || context.client.clientVersion;
          const visitorData = config.VISITOR_DATA || context.client.visitorData;
          if (clientName != null) headers["X-YouTube-Client-Name"] = String(clientName);
          if (clientVersion) headers["X-YouTube-Client-Version"] = String(clientVersion);
          if (visitorData) headers["X-Goog-Visitor-Id"] = String(visitorData);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          try {
            const response = await window.fetch(url.toString(), {
              method: "POST",
              credentials: "include",
              cache: "no-store",
              headers,
              body: JSON.stringify({ context, ...descriptor }),
              signal: controller.signal,
            });
            if (!response.ok) {
              return {
                success: false,
                error: "YOUTUBE_TRANSCRIPT_HTTP_ERROR",
                status: response.status,
              };
            }
            const body = await response.text();
            if (!body.trim()) {
              return { success: false, error: "YOUTUBE_TRANSCRIPT_EMPTY" };
            }
            if (body.length > MAX_RESPONSE_BYTES) {
              return { success: false, error: "YOUTUBE_TRANSCRIPT_TOO_LARGE" };
            }
            try {
              return { success: true, payload: JSON.parse(body) };
            } catch (_error) {
              return { success: false, error: "YOUTUBE_TRANSCRIPT_INVALID_JSON" };
            }
          } catch (error) {
            return {
              success: false,
              error: error?.name === "AbortError"
                ? "YOUTUBE_TRANSCRIPT_TIMEOUT"
                : "YOUTUBE_TRANSCRIPT_FETCH_FAILED",
            };
          } finally {
            clearTimeout(timer);
          }
        };

        let first = await requestJson(initialDescriptor);
        if (!first.success) return first;
        let selectedPayload = first.payload;
        const availableOptions = languageOptions(first.payload);
        let selectedOption = availableOptions.find((option) => option.selected) || null;
        let selectedEnglishMatch = selectedOption
          ? chooseEnglishOption([selectedOption])
          : null;
        const preferredOption = chooseEnglishOption(availableOptions);
        if (
          preferredOption &&
          (!selectedOption || preferredOption.option.label !== selectedOption.label)
        ) {
          const preferredResponse = await requestJson(preferredOption.option.descriptor);
          if (preferredResponse.success) {
            selectedPayload = preferredResponse.payload;
            selectedOption = preferredOption.option;
            selectedEnglishMatch = preferredOption;
          } else if (!selectedEnglishMatch) {
            return preferredResponse;
          }
        }

        if (availableOptions.length && !selectedEnglishMatch && !preferredOption) {
          return { success: false, error: "YOUTUBE_TRANSCRIPT_NO_ENGLISH_OPTION" };
        }

        const selectedLabel = selectedOption?.label || preferredOption?.option?.label || "";
        const selectedTrack =
          selectedEnglishMatch?.track ||
          preferredTracks.find((track) =>
            cleanText(track.name).toLowerCase() === cleanText(selectedLabel).toLowerCase(),
          ) ||
          preferredTracks[0] ||
          null;
        const language = selectedTrack?.languageCode || selectedOption?.languageCode || "en";
        const source =
          selectedTrack?.kind === "asr" || automaticLabel(selectedLabel)
            ? "youtube-auto"
            : "youtube-manual";
        const allSegments = [];
        const segmentKeys = new Set();
        const queue = [];
        const queued = new Set();
        const appendPayload = (payload) => {
          const parsed = parsePayload(payload, language);
          for (const segment of parsed.segments) {
            const key = `${segment.offset}:${segment.duration}:${segment.text}`;
            if (segmentKeys.has(key) || allSegments.length >= MAX_SEGMENTS) continue;
            segmentKeys.add(key);
            allSegments.push(segment);
          }
          for (const descriptor of parsed.continuations) {
            const key = descriptor.params || descriptor.continuation;
            if (!key || queued.has(key)) continue;
            queued.add(key);
            queue.push(descriptor);
          }
        };
        appendPayload(selectedPayload);
        let pageCount = 1;
        while (queue.length && pageCount < MAX_PAGES && allSegments.length < MAX_SEGMENTS) {
          const next = await requestJson(queue.shift());
          if (!next.success) {
            if (next.error === "VIDEO_CONTEXT_CHANGED") return next;
            break;
          }
          appendPayload(next.payload);
          pageCount += 1;
        }
        if (currentVideoId() !== expectedVideoId) {
          return { success: false, error: "VIDEO_CONTEXT_CHANGED" };
        }
        allSegments.sort((a, b) => a.offset - b.offset);
        if (!allSegments.length) {
          return { success: false, error: "YOUTUBE_TRANSCRIPT_EMPTY" };
        }
        return {
          success: true,
          segments: allSegments,
          language,
          source,
          captionTrackName: selectedLabel || selectedTrack?.name || "",
        };
      },
    });
    return results?.[0]?.result || {
      success: false,
      error: "YOUTUBE_TRANSCRIPT_FETCH_FAILED",
    };
  } catch (_error) {
    return { success: false, error: "YOUTUBE_TRANSCRIPT_FETCH_FAILED" };
  }
}

function youtubeCaptionAttempt(stage, outcome, trackName = "") {
  const status = Number(outcome?.status);
  return {
    stage,
    success: !!outcome?.success,
    error: outcome?.success ? "" : String(outcome?.error || "UNKNOWN"),
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
    ...(trackName ? { track: String(trackName).slice(0, 120) } : {}),
  };
}

async function fetchTranscriptViaNativePanel(tabId, videoId, tracks) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "readNativeYouTubeTranscript",
      videoId,
      preferredTracks: (Array.isArray(tracks) ? tracks : []).map((track) => ({
        languageCode: String(track.languageCode || ""),
        kind: String(track.kind || ""),
        name: String(track.name || ""),
      })),
    });
    return response || {
      success: false,
      error: "YOUTUBE_NATIVE_PANEL_NO_RESPONSE",
    };
  } catch (_error) {
    return {
      success: false,
      error: "YOUTUBE_NATIVE_PANEL_UNAVAILABLE",
    };
  }
}

async function fetchYouTubeTranscript(videoId, requestedTabId) {
  try {
    const tab = await resolveYouTubeTranscriptTab(videoId, requestedTabId);
    let videoDuration = 0;
    let detectedEnglishTracks = 0;
    let lastError = "YOUTUBE_CAPTION_FETCH_FAILED";
    let sawEmptyResponse = false;
    let latestEnglishTracks = [];
    const youtubeAttempts = [];

    for (const delay of YOUTUBE_CAPTION_DOWNLOAD_RETRY_DELAYS_MS) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const extracted = await readYouTubeCaptionTracks(tab.id, videoId);
      videoDuration = Math.max(videoDuration, Number(extracted.duration) || 0);
      if (!extracted.success) {
        lastError = extracted.error || "YOUTUBE_PLAYER_NOT_READY";
        continue;
      }
      const tracks = YTD_YOUTUBE_CAPTIONS.orderedEnglishTracks(extracted.tracks);
      if (tracks.length) latestEnglishTracks = tracks;
      detectedEnglishTracks = Math.max(detectedEnglishTracks, tracks.length);
      if (!tracks.length) {
        return {
          success: false,
          error: "YOUTUBE_NO_ENGLISH_TRACK",
          message: "YouTube has no English manual or auto-generated caption track for this video.",
          videoDuration,
          captionsDetected: false,
          youtubeAttempts,
        };
      }

      const attempt = await YTD_YOUTUBE_CAPTIONS.tryEnglishTracksInOrder(
        tracks,
        async (track) => {
        const cacheKey = `${videoId}:${track.languageCode}:${track.kind || "manual"}`;
        if (youtubeCaptionCache.has(cacheKey)) {
          return { success: true, value: youtubeCaptionCache.get(cacheKey) };
        }
        let fetched = await fetchCaptionTrackInPage(tab.id, videoId, track);
        if (!fetched.success && fetched.error !== "VIDEO_CONTEXT_CHANGED") {
          const fallback = await fetchCaptionTrackInBackground(videoId, track);
          if (fallback.success) fetched = fallback;
        }
        if (!fetched.success) {
          return fetched;
        }
        const chunks = YTD_YOUTUBE_CAPTIONS.parseJson3(
          fetched.payload,
          track.languageCode,
        );
        const source = track.kind === "asr" ? "youtube-auto" : "youtube-manual";
        const result = YTD_YOUTUBE_CAPTIONS.normalizeTranscript(chunks, {
          videoId,
          language: track.languageCode || null,
          source,
          sourceVersion: YOUTUBE_CAPTION_SOURCE_VERSION,
        });
        if (!result.success) {
          return { success: false, error: "YOUTUBE_CAPTION_EMPTY" };
        }
        result.captionKind = track.kind || "manual";
        result.captionTrackName = track.name || "";
        result.videoDuration = videoDuration;
        youtubeCaptionCache.set(cacheKey, result);
        return { success: true, value: result };
        },
      );
      for (const item of attempt.attempts) {
        if (item.error) lastError = item.error;
        sawEmptyResponse ||= item.error === "YOUTUBE_CAPTION_EMPTY";
        youtubeAttempts.push(
          youtubeCaptionAttempt(
            "timed-text",
            { success: !item.error, error: item.error },
            item.track?.name || "",
          ),
        );
      }
      if (attempt.success) {
        if (!attempt.attempts.some((item) => !item.error)) {
          youtubeAttempts.push(
            youtubeCaptionAttempt("timed-text", { success: true }, attempt.track?.name || ""),
          );
        }
        const currentTab = await chrome.tabs.get(tab.id);
        if (YTD_LIVE_CAPTIONS.youtubeVideoId(currentTab.url || currentTab.pendingUrl) !== videoId) {
          return {
            success: false,
            error: "VIDEO_CONTEXT_CHANGED",
            message: "The YouTube video changed while captions were loading.",
            videoDuration,
            youtubeAttempts,
          };
        }
        return { ...attempt.value, youtubeAttempts };
      }
      if (attempt.error === "VIDEO_CONTEXT_CHANGED") lastError = attempt.error;
    }

    if (detectedEnglishTracks > 0 && lastError !== "VIDEO_CONTEXT_CHANGED") {
      const refreshed = await readYouTubeCaptionTracks(tab.id, videoId);
      videoDuration = Math.max(videoDuration, Number(refreshed.duration) || 0);
      const refreshedTracks = refreshed.success
        ? YTD_YOUTUBE_CAPTIONS.orderedEnglishTracks(refreshed.tracks)
        : [];
      if (refreshedTracks.length) latestEnglishTracks = refreshedTracks;
      if (refreshedTracks.length) {
        const transcriptApi = await fetchTranscriptViaYouTubeApiInPage(
          tab.id,
          videoId,
          refreshedTracks,
        );
        youtubeAttempts.push(youtubeCaptionAttempt("transcript-api", transcriptApi));
        if (transcriptApi.success) {
          const result = YTD_YOUTUBE_CAPTIONS.normalizeTranscript(
            transcriptApi.segments,
            {
              videoId,
              language: transcriptApi.language || null,
              source: transcriptApi.source || "youtube-manual",
              sourceVersion: YOUTUBE_CAPTION_SOURCE_VERSION,
            },
          );
          if (result.success) {
            result.captionKind = result.source === "youtube-auto" ? "asr" : "manual";
            result.captionTrackName = transcriptApi.captionTrackName || "";
            result.videoDuration = videoDuration;
            const cacheKey = `${videoId}:${result.language || "en"}:${result.captionKind}`;
            youtubeCaptionCache.set(cacheKey, result);
            const currentTab = await chrome.tabs.get(tab.id);
            if (YTD_LIVE_CAPTIONS.youtubeVideoId(currentTab.url || currentTab.pendingUrl) !== videoId) {
              return {
                success: false,
                error: "VIDEO_CONTEXT_CHANGED",
                message: "The YouTube video changed while captions were loading.",
                videoDuration,
                youtubeAttempts,
              };
            }
            return { ...result, youtubeAttempts };
          }
          lastError = "YOUTUBE_TRANSCRIPT_EMPTY";
        } else {
          lastError = transcriptApi.error || "YOUTUBE_TRANSCRIPT_FETCH_FAILED";
        }
      }
    }

    if (latestEnglishTracks.length && lastError !== "VIDEO_CONTEXT_CHANGED") {
      const nativePanel = await fetchTranscriptViaNativePanel(
        tab.id,
        videoId,
        latestEnglishTracks,
      );
      if (nativePanel.success) {
        const chunks = YTD_YOUTUBE_CAPTIONS.normalizeNativeTranscriptRows(
          nativePanel.rows,
          nativePanel.language || "en",
          { videoDuration },
        );
        const timeline = YTD_YOUTUBE_CAPTIONS.validateNativeTranscriptTimeline(
          chunks,
          videoDuration,
        );
        if (!timeline.success) {
          youtubeAttempts.push(youtubeCaptionAttempt("native-panel", timeline));
          lastError = timeline.error;
        } else {
          youtubeAttempts.push(youtubeCaptionAttempt("native-panel", nativePanel));
          const result = YTD_YOUTUBE_CAPTIONS.normalizeTranscript(chunks, {
            videoId,
            language: nativePanel.language || "en",
            source: nativePanel.source || "youtube-manual",
            sourceVersion: YOUTUBE_CAPTION_SOURCE_VERSION,
          });
          if (result.success) {
            result.captionKind = result.source === "youtube-auto" ? "asr" : "manual";
            result.captionTrackName = nativePanel.captionTrackName || "";
            result.videoDuration = videoDuration;
            const cacheKey = `${videoId}:${result.language || "en"}:${result.captionKind}`;
            youtubeCaptionCache.set(cacheKey, result);
            const currentTab = await chrome.tabs.get(tab.id);
            if (YTD_LIVE_CAPTIONS.youtubeVideoId(currentTab.url || currentTab.pendingUrl) !== videoId) {
              return {
                success: false,
                error: "VIDEO_CONTEXT_CHANGED",
                message: "The YouTube video changed while captions were loading.",
                videoDuration,
                youtubeAttempts,
              };
            }
            return { ...result, youtubeAttempts };
          }
          lastError = "YOUTUBE_NATIVE_PANEL_EMPTY";
        }
      } else {
        youtubeAttempts.push(youtubeCaptionAttempt("native-panel", nativePanel));
        lastError = nativePanel.error || "YOUTUBE_NATIVE_PANEL_FAILED";
      }
    }

    const contextChanged = lastError === "VIDEO_CONTEXT_CHANGED";
    return {
      success: false,
      error: contextChanged
        ? "VIDEO_CONTEXT_CHANGED"
        : sawEmptyResponse
          ? "YOUTUBE_CAPTION_EMPTY"
          : lastError,
      message: contextChanged
        ? "The YouTube video changed while captions were loading."
        : detectedEnglishTracks
          ? "YouTube English captions were detected, but their caption data could not be read."
          : "The YouTube player is still preparing its caption data.",
      videoDuration,
      captionsDetected: detectedEnglishTracks > 0,
      youtubeAttempts,
    };
  } catch (error) {
    return {
      success: false,
      error: "YOUTUBE_CAPTION_FETCH_FAILED",
      message: error.message || "YouTube captions could not be read.",
      videoDuration: 0,
      captionsDetected: false,
      youtubeAttempts: [],
    };
  }
}

async function handleFetchTranscript(videoId, tabId, videoDuration = 0) {
  const localResult = await chrome.storage.local.get(supadataResultKey(videoId));
  const generated = localResult[supadataResultKey(videoId)];
  if (
    generated?.result?.success &&
    Date.now() - Number(generated.timestamp || 0) <= 30 * 24 * 60 * 60 * 1000
  ) {
    return generated.result;
  }
  if (generated) await chrome.storage.local.remove(supadataResultKey(videoId));
  const youtube = await fetchYouTubeTranscript(videoId, tabId);
  if (youtube.success) return youtube;
  if (youtube.error === "VIDEO_CONTEXT_CHANGED") {
    return {
      ...youtube,
      liveAiAvailable: false,
      requiresGenerationConfirmation: false,
    };
  }

  const stored = await chrome.storage.local.get(supadataJobKey(videoId));
  const job = stored[supadataJobKey(videoId)];
  if (job?.jobId) {
    return { success: false, pending: true, ...job, source: "supadata-ai", sourceLabel: "Supadata AI" };
  }

  const settings = await getSettings();
  const duration = Math.max(
    0,
    Number(videoDuration) || Number(youtube.videoDuration) || 0,
  );
  const youtubeRetryAvailable =
    youtube.captionsDetected ||
    youtube.error === "YOUTUBE_PLAYER_NOT_READY" ||
    youtube.error === "YOUTUBE_CAPTION_FETCH_FAILED" ||
    youtube.error === "YOUTUBE_CAPTION_EMPTY";
  const youtubeMessage = youtube.captionsDetected
    ? "YouTube English captions were detected, but their caption data could not be read."
    : "YouTube has no readable English captions.";

  return {
    success: false,
    error: "SUPADATA_GENERATION_CONFIRMATION_REQUIRED",
    message: settings.supadataApiKey
      ? `${youtubeMessage} Supadata AI can generate a full transcript.`
      : `${youtubeMessage} Add a Supadata key to generate a full transcript, or use Live AI.`,
    requiresGenerationConfirmation: !!settings.supadataApiKey,
    hasSupadataKey: !!settings.supadataApiKey,
    estimatedCredits: YTD_YOUTUBE_CAPTIONS.estimateSupadataCredits(duration),
    videoDuration: duration,
    youtubeError: youtube.error,
    youtubeMessage: youtube.message,
    youtubeRetryAvailable,
    captionsDetected: !!youtube.captionsDetected,
    youtubeAttempts: Array.isArray(youtube.youtubeAttempts)
      ? youtube.youtubeAttempts
      : [],
    liveAiAvailable: true,
  };
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured. Open LingoLens Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[LingoLens] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "DeepSeek rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  return { chapters, keyQuotes };
}

// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[LingoLens] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[LingoLens] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[LingoLens] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[LingoLens] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[LingoLens] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[LingoLens] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[LingoLens] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

// Provider readers and the shared service are exposed for repository tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  requestAiCompletionStream,
  translateTranscriptBatch,
};

importScripts("live-caption-background.js");
