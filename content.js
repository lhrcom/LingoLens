/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;
let nativeTranscriptRequestToken = 0;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[LingoLens Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[LingoLens Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[LingoLens Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video.html5-main-video");
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[LingoLens Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "readNativeYouTubeTranscript") {
    const token = ++nativeTranscriptRequestToken;
    readNativeYouTubeTranscript(message, token)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          success: false,
          error: "YOUTUBE_NATIVE_PANEL_FAILED",
          message: error?.message || "YouTube's native transcript panel could not be read.",
        }),
      );
    return true;
  }

  // These messages belong to the dynamically injected, page-agnostic caption
  // controller. Do not race it with an "unknown action" reply on YouTube.
  if (
    message.action === "probeCaptionPage" ||
    message.action === "captionSessionSnapshot" ||
    message.action === "captionSegmentUpsert" ||
    message.action === "captionSessionStopped"
  ) {
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[LingoLens Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the LingoLens side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "Open LingoLens");
  digestButton.innerHTML = `
    <span class="ytd-digest-icon" style="font-size: 11px;">▶</span>
    <span class="ytd-digest-label">Digest</span>
  `;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among YouTube's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
    box-shadow: 0 2px 8px rgba(200, 103, 79, 0.3);
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[LingoLens] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[LingoLens] openSidePanel response:", result);
    } catch (err) {
      console.error("[LingoLens] Failed to open side panel:", err);
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!window.location.pathname.includes("/watch")) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[LingoLens Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[LingoLens Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[LingoLens Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[LingoLens Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#b25742";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#c8674f";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[LingoLens Content] Note button injected");
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/watch")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[LingoLens] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[LingoLens] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = new URLSearchParams(window.location.search).get("v");

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      console.error("[LingoLens] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[LingoLens] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">📝 Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">🔗 Copy link</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "✓ Copied!";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  const videoId = new URLSearchParams(window.location.search).get("v") || "";
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    videoId,
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[LingoLens Content] No video element found for seek");
    return;
  }

  debugLog("[LingoLens Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// NATIVE YOUTUBE TRANSCRIPT PANEL
// ============================================================

function nativeTranscriptVideoId() {
  return new URLSearchParams(window.location.search).get("v") || "";
}

function nativeTranscriptCleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function nativeTranscriptVisible(element) {
  if (!element || !element.isConnected || element.hidden) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function nativeTranscriptSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nativeTranscriptAssertContext(expectedVideoId, token) {
  if (
    token !== nativeTranscriptRequestToken ||
    nativeTranscriptVideoId() !== expectedVideoId
  ) {
    const error = new Error("The YouTube video changed while its transcript was loading.");
    error.code = "VIDEO_CONTEXT_CHANGED";
    throw error;
  }
}

function nativeTranscriptButtonLabel(element) {
  return nativeTranscriptCleanText(
    element?.getAttribute?.("aria-label") ||
      element?.getAttribute?.("title") ||
      element?.textContent ||
      "",
  );
}

function nativeTranscriptFindSelectedTab() {
  const tabs = Array.from(
    document.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer [role="tab"][aria-selected="true"], ' +
        "ytd-engagement-panel-section-list-renderer tp-yt-paper-tab.iron-selected, " +
        "ytd-engagement-panel-section-list-renderer tp-yt-paper-tab[selected]",
    ),
  ).filter(nativeTranscriptVisible);
  return tabs[0] || null;
}

function nativeTranscriptFindShowButton() {
  const scoped = Array.from(
    document.querySelectorAll(
      'ytd-video-description-transcript-section-renderer button, ' +
        'ytd-video-description-transcript-section-renderer yt-button-shape, ' +
        'button[aria-label*="Show transcript" i], ' +
        'button[aria-label*="显示文字稿"], ' +
        'button[aria-label*="文字稿"]',
    ),
  );
  const normalizedScoped = scoped.map((element) =>
    element.matches?.("button") ? element : element.querySelector?.("button") || element,
  );
  const allButtons = normalizedScoped.length
    ? normalizedScoped
    : Array.from(document.querySelectorAll("button, yt-button-shape button"));
  return allButtons.find((button) => {
    const label = nativeTranscriptButtonLabel(button);
    return /(show transcript|显示文字稿|展开文字稿|查看文字稿)/i.test(label);
  }) || null;
}

function nativeTranscriptFindDescriptionToggle(expand) {
  const selectors = expand
    ? "ytd-watch-metadata #expand, ytd-text-inline-expander #expand, #description #expand"
    : "ytd-watch-metadata #collapse, ytd-text-inline-expander #collapse, #description #collapse";
  const direct = Array.from(document.querySelectorAll(selectors)).find(
    nativeTranscriptVisible,
  );
  if (direct) return direct.matches?.("button")
    ? direct
    : direct.querySelector?.("button") || direct;
  const pattern = expand ? /^(\.\.\.)?more$|显示更多|展开/i : /show less|收起|显示较少/i;
  return Array.from(document.querySelectorAll("button")).find((button) =>
    nativeTranscriptVisible(button) && pattern.test(nativeTranscriptButtonLabel(button)),
  ) || null;
}

function nativeTranscriptFindRoot() {
  const rows = Array.from(
    document.querySelectorAll(
      "ytd-transcript-segment-renderer, transcript-segment-view-model",
    ),
  ).find(nativeTranscriptVisible);
  if (rows) {
    return rows.closest(
      "ytd-engagement-panel-section-list-renderer, ytd-transcript-renderer, #secondary",
    ) || rows.parentElement;
  }
  const selectedTranscriptTab = Array.from(
    document.querySelectorAll('[role="tab"][aria-selected="true"], tp-yt-paper-tab.iron-selected'),
  ).find((tab) => /transcript|文字稿/i.test(nativeTranscriptButtonLabel(tab)));
  if (selectedTranscriptTab) {
    return selectedTranscriptTab.closest(
      "ytd-engagement-panel-section-list-renderer, #secondary",
    );
  }
  return Array.from(
    document.querySelectorAll("ytd-engagement-panel-section-list-renderer"),
  ).find((panel) =>
    /transcript/i.test(panel.getAttribute("target-id") || "") &&
    nativeTranscriptVisible(panel),
  ) || null;
}

function nativeTranscriptRendererFromData(root) {
  const candidates = [];
  try {
    candidates.push(root?.data, root?.__data?.data, root?.__data);
  } catch (_error) {
    // Custom-element state may be isolated from content scripts.
  }
  const stack = candidates.filter(Boolean);
  const seen = new Set();
  while (stack.length && seen.size < 2000) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (value.transcriptSegmentRenderer) return value.transcriptSegmentRenderer;
    if (value.transcriptCueRenderer) return value.transcriptCueRenderer;
    const values = Array.isArray(value) ? value : Object.values(value);
    for (const item of values) stack.push(item);
  }
  return null;
}

function nativeTranscriptTextFromRenderer(renderer) {
  const value = renderer?.snippet || renderer?.cue || renderer?.text;
  if (typeof value === "string") return nativeTranscriptCleanText(value);
  if (typeof value?.simpleText === "string") {
    return nativeTranscriptCleanText(value.simpleText);
  }
  if (Array.isArray(value?.runs)) {
    return nativeTranscriptCleanText(value.runs.map((run) => run?.text || "").join(""));
  }
  return "";
}

function nativeTranscriptVisibleLines(element) {
  return String(element?.innerText || "")
    .split(/\r?\n/)
    .map(nativeTranscriptCleanText)
    .filter(Boolean);
}

function nativeTranscriptIsAuxiliaryTimestampText(value) {
  const text = nativeTranscriptCleanText(value);
  if (!/(?:hours?|minutes?|seconds?|小时|分钟|秒)/i.test(text)) return false;
  return /^(?:\d+\s*(?:hours?|minutes?|seconds?|小时|分钟|秒)(?:\s*[,，]\s*|\s*))+$/i.test(
    text,
  );
}

function nativeTranscriptRowFromElement(element) {
  const renderer = nativeTranscriptRendererFromData(element);
  const textElement = element.querySelector?.(
    "#segment-text, .segment-text, yt-formatted-string.segment-text, " +
      ':scope > [role="text"], [class*="segment-text" i], [class*="cue-text" i]',
  );
  const timestampElement = element.querySelector?.(
    '#segment-timestamp, .segment-timestamp, ' +
      '.ytwTranscriptSegmentViewModelTimestamp, [class*="timestamp" i]',
  );
  const visibleLines = nativeTranscriptVisibleLines(element);
  const fallbackTimestamp = visibleLines.find((line) =>
    /^\d{1,3}:\d{2}(?::\d{2})?$/.test(line),
  ) || "";
  const timestamp = nativeTranscriptCleanText(
    timestampElement?.textContent || fallbackTimestamp,
  );
  let text = nativeTranscriptTextFromRenderer(renderer) ||
    nativeTranscriptCleanText(textElement?.textContent || "");
  if (!text) {
    const contentLines = visibleLines.filter(
      (line) => line !== timestamp && !nativeTranscriptIsAuxiliaryTimestampText(line),
    );
    text = nativeTranscriptCleanText(contentLines.join(" "));
  }
  if (!text) {
    const combined = nativeTranscriptCleanText(element.textContent || "");
    text = timestamp && combined.startsWith(timestamp)
      ? nativeTranscriptCleanText(combined.slice(timestamp.length))
      : combined;
  }
  const attributeNumber = (...names) => {
    for (const name of names) {
      const raw = element.getAttribute?.(name);
      if (raw !== null && raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
    }
    return null;
  };
  const startRaw =
    renderer?.startMs ??
      renderer?.startOffsetMs ??
      renderer?.startTimeMs ??
      attributeNumber("data-start-ms", "start-ms");
  const endRaw =
    renderer?.endMs ??
      renderer?.endTimeMs ??
      attributeNumber("data-end-ms", "end-ms");
  const durationRaw =
    renderer?.durationMs ??
      renderer?.duration ??
      attributeNumber("data-duration-ms", "duration-ms");
  const startMs = startRaw === null || startRaw === undefined ? null : Number(startRaw);
  const endMs = endRaw === null || endRaw === undefined ? null : Number(endRaw);
  const durationMs = durationRaw === null || durationRaw === undefined
    ? null
    : Number(durationRaw);
  return {
    text,
    timestamp,
    startMs: Number.isFinite(startMs) && startMs >= 0 ? startMs : null,
    endMs: Number.isFinite(endMs) && endMs > 0 ? endMs : null,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
  };
}

function nativeTranscriptRows(root) {
  if (!root) return [];
  let elements = Array.from(
    root.querySelectorAll(
      "ytd-transcript-segment-renderer, transcript-segment-view-model, " +
        '[data-start-ms][class*="segment"]',
    ),
  );
  if (!elements.length) {
    const timestamps = Array.from(
      root.querySelectorAll(
        '.segment-timestamp, #segment-timestamp, [class*="timestamp"]',
      ),
    );
    elements = timestamps
      .map((timestamp) =>
        timestamp.closest(
          "ytd-transcript-segment-renderer, transcript-segment-view-model, " +
            '[role="button"], [class*="segment"]',
        ),
      )
      .filter(Boolean);
  }
  return elements.map(nativeTranscriptRowFromElement).filter((row) => row.text);
}

function nativeTranscriptFindScroller(root) {
  if (!root) return null;
  const candidates = [root, ...root.querySelectorAll("*")].filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    return (
      /(auto|scroll)/.test(style.overflowY) &&
      element.clientHeight >= 80 &&
      element.scrollHeight > element.clientHeight + 20
    );
  });
  return candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
}

async function nativeTranscriptSelectEnglish(root, preferredTracks, expectedVideoId, token) {
  const ordered = (Array.isArray(preferredTracks) ? preferredTracks : [])
    .filter((track) => /^en(?:-|$)/i.test(track?.languageCode || ""))
    .sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
  const menuButtons = Array.from(
    root?.querySelectorAll?.(
      "ytd-transcript-footer-renderer button, #language-menu-button, " +
        'button[aria-label*="language" i], button[aria-haspopup="menu"]',
    ) || [],
  ).filter(nativeTranscriptVisible);
  const currentButton = menuButtons.find((button) => {
    const label = nativeTranscriptButtonLabel(button);
    return ordered.some((track) =>
      nativeTranscriptCleanText(track.name).toLowerCase() === label.toLowerCase(),
    ) || /english|auto-generated/i.test(label);
  });
  let selectedLabel = nativeTranscriptButtonLabel(currentButton);
  const preferred = ordered[0] || null;
  if (
    currentButton &&
    preferred &&
    nativeTranscriptCleanText(preferred.name).toLowerCase() !== selectedLabel.toLowerCase()
  ) {
    currentButton.click();
    await nativeTranscriptSleep(200);
    nativeTranscriptAssertContext(expectedVideoId, token);
    const choices = Array.from(
      document.querySelectorAll(
        'tp-yt-paper-item, ytd-menu-service-item-renderer, [role="menuitemradio"], ' +
          "yt-list-item-view-model",
      ),
    ).filter(nativeTranscriptVisible);
    let choice = null;
    for (const track of ordered) {
      const expected = nativeTranscriptCleanText(track.name).toLowerCase();
      choice = choices.find((item) =>
        nativeTranscriptButtonLabel(item).toLowerCase() === expected,
      );
      if (choice) break;
    }
    if (choice) {
      selectedLabel = nativeTranscriptButtonLabel(choice);
      choice.click();
      await nativeTranscriptSleep(500);
      nativeTranscriptAssertContext(expectedVideoId, token);
    } else {
      document.body.click();
    }
  }
  const selectedTrack = ordered.find((track) =>
    nativeTranscriptCleanText(track.name).toLowerCase() === selectedLabel.toLowerCase(),
  ) || preferred;
  return {
    language: selectedTrack?.languageCode || "en",
    source: selectedTrack?.kind === "asr" || /auto-generated/i.test(selectedLabel)
      ? "youtube-auto"
      : "youtube-manual",
    captionTrackName: selectedLabel || selectedTrack?.name || "",
  };
}

async function nativeTranscriptCollectRows(root, expectedVideoId, token) {
  const scroller = nativeTranscriptFindScroller(root);
  const originalScrollTop = scroller?.scrollTop || 0;
  const collected = new Map();
  let stableBottomPasses = 0;
  try {
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await nativeTranscriptSleep(120);
    }
    for (let step = 0; step < 180; step += 1) {
      nativeTranscriptAssertContext(expectedVideoId, token);
      for (const row of nativeTranscriptRows(root)) {
        const key = `${row.startMs ?? row.timestamp}:${row.text}`;
        if (!collected.has(key)) collected.set(key, row);
      }
      if (!scroller) break;
      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom) {
        stableBottomPasses += 1;
        if (stableBottomPasses >= 3) break;
      } else {
        stableBottomPasses = 0;
        const next = Math.min(
          scroller.scrollHeight - scroller.clientHeight,
          scroller.scrollTop + Math.max(320, Math.floor(scroller.clientHeight * 0.8)),
        );
        scroller.scrollTop = next;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      await nativeTranscriptSleep(120);
    }
  } finally {
    if (scroller?.isConnected) {
      scroller.scrollTop = originalScrollTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  }
  return Array.from(collected.values());
}

async function readNativeYouTubeTranscript(message, token) {
  const expectedVideoId = String(message.videoId || "");
  nativeTranscriptAssertContext(expectedVideoId, token);
  const previousSelectedTab = nativeTranscriptFindSelectedTab();
  const previousSelectedLabel = nativeTranscriptButtonLabel(previousSelectedTab);
  const transcriptWasSelected = /transcript|文字稿/i.test(previousSelectedLabel);
  let openedByExtension = false;
  let descriptionExpandedByExtension = false;
  let root = nativeTranscriptFindRoot();

  try {
    if (!transcriptWasSelected || !nativeTranscriptRows(root).length) {
      const showButton = nativeTranscriptFindShowButton();
      if (!showButton) {
        return {
          success: false,
          error: "YOUTUBE_NATIVE_PANEL_BUTTON_NOT_FOUND",
        };
      }
      let effectiveShowButton = showButton;
      if (!nativeTranscriptVisible(effectiveShowButton)) {
        const expandButton = nativeTranscriptFindDescriptionToggle(true);
        if (expandButton) {
          expandButton.click();
          descriptionExpandedByExtension = true;
          await nativeTranscriptSleep(200);
          nativeTranscriptAssertContext(expectedVideoId, token);
          effectiveShowButton = nativeTranscriptFindShowButton() || effectiveShowButton;
        }
      }
      effectiveShowButton.click();
      openedByExtension = !transcriptWasSelected;
      const deadline = Date.now() + 15_000;
      do {
        await nativeTranscriptSleep(150);
        nativeTranscriptAssertContext(expectedVideoId, token);
        root = nativeTranscriptFindRoot();
        if (nativeTranscriptRows(root).length) break;
      } while (Date.now() < deadline);
    }

    nativeTranscriptAssertContext(expectedVideoId, token);
    root = nativeTranscriptFindRoot();
    if (!root || !nativeTranscriptRows(root).length) {
      return {
        success: false,
        error: "YOUTUBE_NATIVE_PANEL_TIMEOUT",
      };
    }
    const language = await nativeTranscriptSelectEnglish(
      root,
      message.preferredTracks,
      expectedVideoId,
      token,
    );
    root = nativeTranscriptFindRoot() || root;
    const rows = await nativeTranscriptCollectRows(root, expectedVideoId, token);
    if (!rows.length) {
      return { success: false, error: "YOUTUBE_NATIVE_PANEL_EMPTY" };
    }
    return {
      success: true,
      rows,
      ...language,
      openedByExtension,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code || "YOUTUBE_NATIVE_PANEL_FAILED",
      message: error?.message || "YouTube's native transcript panel could not be read.",
    };
  } finally {
    if (openedByExtension && token === nativeTranscriptRequestToken) {
      if (previousSelectedTab?.isConnected && previousSelectedLabel) {
        previousSelectedTab.click();
      } else {
        const currentRoot = nativeTranscriptFindRoot();
        const replacementTab = Array.from(
          currentRoot?.querySelectorAll?.('[role="tab"], tp-yt-paper-tab') || [],
        ).find((tab) =>
          nativeTranscriptButtonLabel(tab) === previousSelectedLabel,
        );
        if (replacementTab) {
          replacementTab.click();
        } else {
          const closeButton = Array.from(
            currentRoot?.querySelectorAll?.("button") || [],
          ).find((button) => /^(close|关闭)$/i.test(nativeTranscriptButtonLabel(button)));
          closeButton?.click();
        }
      }
    }
    if (descriptionExpandedByExtension && token === nativeTranscriptRequestToken) {
      nativeTranscriptFindDescriptionToggle(false)?.click();
    }
  }
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  nativeTranscriptRequestToken += 1;
  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});
