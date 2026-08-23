/* global YTD_LIVE_CAPTIONS, getSettings, parseLooseJson, requestAiCompletion, requestAiCompletionStream, translateTranscriptBatch */

let activeCaptionSession = null;
const captionContexts = new Map();
let creatingOffscreenDocument = null;
const ACTIVE_CAPTION_SESSION_KEY = "caption_session_active";
const CAPTURE_AUTHORIZATION_TTL_MS = 30_000;
let pendingCaptionStart = null;
let pendingCaptionTimer = null;

function isActiveTabCaptureError(error) {
  return /activeTab|has not been invoked|cannot be captured|not been granted/i.test(
    String(error?.message || error || ""),
  );
}

function clearPendingCaptionStart(reason = "") {
  if (pendingCaptionTimer) clearTimeout(pendingCaptionTimer);
  pendingCaptionTimer = null;
  const pending = pendingCaptionStart;
  pendingCaptionStart = null;
  if (pending && reason) {
    sendRuntime({
      action: "captionPendingStartCancelled",
      tabId: pending.tabId,
      url: pending.url,
      reason,
    });
  }
  return pending;
}

async function queuePendingCaptionStart(message) {
  const tab = await chrome.tabs.get(message.tabId);
  if (
    message.youtubeVideoId &&
    YTD_LIVE_CAPTIONS.youtubeVideoId(tab.url || tab.pendingUrl || "") !== message.youtubeVideoId
  ) {
    throw new Error("The YouTube video changed before authorization could be requested.");
  }
  clearPendingCaptionStart();
  pendingCaptionStart = {
    message: { ...message, tabId: tab.id },
    tabId: tab.id,
    url: YTD_LIVE_CAPTIONS.normalizedPageUrl(tab.url || tab.pendingUrl || ""),
    youtubeVideoId: message.youtubeVideoId || "",
    expiresAt: Date.now() + CAPTURE_AUTHORIZATION_TTL_MS,
  };
  pendingCaptionTimer = setTimeout(() => {
    clearPendingCaptionStart("Authorization request expired. Click Start subtitles again.");
  }, CAPTURE_AUTHORIZATION_TTL_MS);
  sendRuntime({
    action: "captionCapturePermissionRequired",
    tabId: tab.id,
    url: pendingCaptionStart.url,
  });
}

function resumePendingFromAction(tab) {
  const pending = pendingCaptionStart;
  if (!pending) return null;
  const clickedUrl = YTD_LIVE_CAPTIONS.normalizedPageUrl(tab?.url || tab?.pendingUrl || "");
  if (
    !tab?.id ||
    tab.id !== pending.tabId ||
    clickedUrl !== pending.url ||
    Date.now() > pending.expiresAt
  ) {
    clearPendingCaptionStart("The requested video is no longer the active page.");
    return null;
  }

  // This call intentionally occurs before any await. Chrome grants activeTab
  // only for the duration of the toolbar Action click user gesture.
  const streamIdPromise = chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  clearPendingCaptionStart();
  const resumePromise = startCaptionSession(pending.message, streamIdPromise)
    .then((result) => {
      sendRuntime({ action: "captionPendingStartResolved", ...result });
      return result;
    })
    .catch(async (error) => {
      if (activeCaptionSession?.status === "connecting") await stopCaptionSession("error");
      const result = { success: false, error: error.message || "Could not capture this tab." };
      sendRuntime({ action: "captionPendingStartResolved", ...result });
      return result;
    });
  return resumePromise;
}

globalThis.YTD_LIVE_CAPTION_BACKGROUND = { resumePendingFromAction };

const captionRestorePromise = (async () => {
  const stored = await chrome.storage.local.get(ACTIVE_CAPTION_SESSION_KEY);
  const sessionId = stored[ACTIVE_CAPTION_SESSION_KEY];
  if (!sessionId) return;
  const record = await chrome.storage.local.get(
    YTD_LIVE_CAPTIONS.sessionStorageKey(sessionId),
  );
  const session = record[YTD_LIVE_CAPTIONS.sessionStorageKey(sessionId)];
  if (!session || /stopped|ended|closed|error|navigated|interrupted/.test(session.status)) {
    await chrome.storage.local.remove(ACTIVE_CAPTION_SESSION_KEY);
    return;
  }
  activeCaptionSession = session;
  if (session.mode === "prefetched" && session.status !== "ready") {
    session.status = "translating";
    void translatePrefetchedSession(session.id, 0);
  }
})().catch(() => {});

async function activeHttpTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) {
    throw new Error("Open a normal web page with a video first.");
  }
  return tab;
}

async function prepareCaptionPage({ tabId, videoId } = {}) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await activeHttpTab();
  const expectedPageContextKey = YTD_LIVE_CAPTIONS.pageContextKey(
    "page",
    tab.url || tab.pendingUrl || "",
  );
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["live-caption-shared.js", "page-caption.js"],
    });
  } catch (error) {
    throw new Error(`This page does not allow the subtitle overlay: ${error.message}`);
  }
  const result = await chrome.tabs.sendMessage(tab.id, {
    action: "probeCaptionPage",
    videoId: videoId || "",
    expectedPageContextKey,
  });
  if (!result?.success) throw new Error(result?.error || "Could not inspect page videos.");
  if (result.page?.pageContextKey !== expectedPageContextKey) {
    throw new Error("The page video changed during inspection.");
  }
  return { ...result, tabId: tab.id };
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Capture the user-selected tab for live subtitles.",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }
  await creatingOffscreenDocument;
}

async function persistCaptionSession(session = activeCaptionSession) {
  if (!session) return;
  session.updatedAt = Date.now();
  const stored = await chrome.storage.local.get(YTD_LIVE_CAPTIONS.SESSION_INDEX_KEY);
  const oldIndex = stored[YTD_LIVE_CAPTIONS.SESSION_INDEX_KEY] || [];
  const index = YTD_LIVE_CAPTIONS.pruneSessionIndex([session.id, ...oldIndex]);
  const keep = new Set(index);
  const stale = oldIndex
    .filter((id) => !keep.has(id))
    .map(YTD_LIVE_CAPTIONS.sessionStorageKey);
  await chrome.storage.local.set({
    [YTD_LIVE_CAPTIONS.SESSION_INDEX_KEY]: index,
    [YTD_LIVE_CAPTIONS.sessionStorageKey(session.id)]: session,
    ...(session === activeCaptionSession
      ? { [ACTIVE_CAPTION_SESSION_KEY]: session.id }
      : {}),
  });
  if (stale.length) await chrome.storage.local.remove(stale);
}

function sendRuntime(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function sendTab(tabId, message) {
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function broadcastSnapshot() {
  if (!activeCaptionSession) return;
  const message = { action: "captionSessionSnapshot", session: activeCaptionSession };
  sendRuntime(message);
  sendTab(activeCaptionSession.tabId, message);
}

async function upsertCaptionSegment(input) {
  if (!activeCaptionSession) return null;
  activeCaptionSession.segments = YTD_LIVE_CAPTIONS.upsertSegment(
    activeCaptionSession.segments,
    input,
  );
  const segment = activeCaptionSession.segments.find((item) => item.id === input.id);
  if (segment) {
    const message = {
      action: "captionSegmentUpsert",
      sessionId: activeCaptionSession.id,
      sessionUrl: activeCaptionSession.url,
      segment,
    };
    sendRuntime(message);
    sendTab(activeCaptionSession.tabId, message);
  }
  if (
    segment?.recognitionState === "final" &&
    segment.translationState !== "streaming"
  ) {
    await persistCaptionSession();
  }
  return segment;
}

function liveTranslationPrompt() {
  return [
    "You are an expert English-to-Simplified-Chinese subtitle translator.",
    "Return only the Chinese translation of CURRENT.",
    "Preserve names, technical terms, numbers, tone, and meaning.",
    "Use concise natural subtitle Chinese. Never add explanations or quotes.",
    "Use CONTEXT only to disambiguate CURRENT.",
  ].join("\n");
}

async function revisePreviousCaption(previousIndex, nextSegment) {
  const session = activeCaptionSession;
  const previous = session?.segments[previousIndex];
  if (
    !previous ||
    previous.translationState === "revised" ||
    previous.translationState !== "translated"
  )
    return;
  try {
    const { text } = await requestAiCompletion({
      temperature: 0.1,
      maxTokens: 700,
      messages: [
        { role: "system", content: liveTranslationPrompt() },
        {
          role: "user",
          content: `TITLE: ${session.title}\nCONTEXT AFTER CURRENT:\n${nextSegment.sourceText}\nCURRENT:\n${previous.sourceText}`,
        },
      ],
    });
    if (activeCaptionSession?.id !== session.id) return;
    await upsertCaptionSegment({
      ...previous,
      translationText: text.trim(),
      translationState: "revised",
      error: "",
    });
  } catch (_error) {
    // Keep the already usable first-pass translation.
  }
}

async function translateLiveCaption(segmentId, attempt = 0) {
  const session = activeCaptionSession;
  if (!session || session.mode !== "live") return;
  const index = session.segments.findIndex((item) => item.id === segmentId);
  const segment = session.segments[index];
  if (!segment || segment.recognitionState !== "final") return;
  const context = session.segments
    .slice(Math.max(0, index - 6), index)
    .filter((item) => item.recognitionState === "final")
    .map((item) => item.sourceText)
    .join("\n");
  const controller = new AbortController();
  const state = captionContexts.get(session.id) || {};
  state.controllers ||= new Map();
  state.controllers.get(segmentId)?.abort();
  state.controllers.set(segmentId, controller);
  captionContexts.set(session.id, state);
  await upsertCaptionSegment({ ...segment, translationState: "streaming", error: "" });
  try {
    const translated = await requestAiCompletionStream({
      signal: controller.signal,
      messages: [
        { role: "system", content: liveTranslationPrompt() },
        {
          role: "user",
          content: `TITLE: ${session.title}\nCONTEXT:\n${context || "(none)"}\nCURRENT:\n${segment.sourceText}`,
        },
      ],
      onDelta: (translationText) => {
        if (activeCaptionSession?.id !== session.id) return;
        void upsertCaptionSegment({
          ...segment,
          translationText,
          translationState: "streaming",
        });
      },
    });
    if (activeCaptionSession?.id !== session.id) return;
    if (!translated) throw new Error("DeepSeek returned an empty translation.");
    await upsertCaptionSegment({
      ...segment,
      translationText: translated,
      translationState: "translated",
      error: "",
    });
    if (index > 0) void revisePreviousCaption(index - 1, segment);
    const next = activeCaptionSession.segments[index + 1];
    if (next?.recognitionState === "final") {
      // Whichever adjacent request finishes last still gets the promised
      // one-sentence look-ahead correction.
      void revisePreviousCaption(index, next);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    if (attempt < 2) {
      await upsertCaptionSegment({
        ...segment,
        translationState: "queued",
        error: /TIMEOUT/.test(error.code || "")
          ? "Translation timed out; retrying…"
          : "Translation failed; retrying…",
      });
      setTimeout(() => translateLiveCaption(segmentId, attempt + 1), 500 * 2 ** attempt);
      return;
    }
    await upsertCaptionSegment({
      ...segment,
      translationState: "error",
      error: error.message || "Translation failed",
    });
  } finally {
    const currentState = captionContexts.get(session.id);
    if (currentState?.controllers?.get(segmentId) === controller) {
      currentState.controllers.delete(segmentId);
    }
  }
}

async function buildPrefetchedContext(session, signal) {
  let summary = session.title;
  let glossary = [];
  const transcript = session.segments.map((segment) => segment.sourceText).join("\n");
  for (let offset = 0; offset < transcript.length; offset += 12_000) {
    try {
      const { text } = await requestAiCompletion({
        signal,
        temperature: 0.1,
        maxTokens: 1200,
        responseFormat: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `Build compact context for accurate ${session.sourceLanguage || "auto-detected source language"}-to-Simplified-Chinese subtitle translation. Return JSON with summary and glossary, where glossary is an array of {source,target}.`,
          },
          {
            role: "user",
            content: `TITLE: ${session.title}\nPREVIOUS SUMMARY: ${summary}\nKNOWN GLOSSARY: ${JSON.stringify(glossary)}\nTRANSCRIPT CHUNK:\n${transcript.slice(offset, offset + 12_000)}`,
          },
        ],
      });
      const parsed = parseLooseJson(text);
      if (typeof parsed.summary === "string") summary = parsed.summary.slice(0, 2000);
      if (Array.isArray(parsed.glossary)) {
        glossary = parsed.glossary
          .filter((item) => typeof item?.source === "string" && typeof item?.target === "string")
          .slice(-100);
      }
    } catch (_error) {
      // Continue with context gathered from earlier chunks.
    }
  }
  return { summary, glossary };
}

async function translatePrefetchedBatch(
  session,
  indices,
  context,
  { signal, generation = context.generation } = {},
) {
  const targets = indices.map((index) => session.segments[index]);
  const first = Math.max(0, indices[0] - 3);
  const last = Math.min(session.segments.length, indices.at(-1) + 4);
  const nearby = session.segments
    .slice(first, last)
    .map(({ id, sourceText }) => ({ id, text: sourceText }));
  const returned = await translateTranscriptBatch(
    {
      profile: "prefetched",
      videoId: session.transcriptVideoId,
      sourceHash: session.transcriptSourceHash,
      videoTitle: session.title,
      sourceLanguage: session.sourceLanguage,
      context: {
        summary: context.summary,
        glossary: context.glossary,
        nearbyContext: nearby,
      },
      segments: targets.map((item) => ({
        id: item.id,
        transcriptId: item.transcriptId || item.id,
        text: item.sourceText,
      })),
    },
    { signal },
  );
  if (
    activeCaptionSession?.id !== session.id ||
    (generation != null && context.generation !== generation)
  ) {
    return false;
  }
  const byId = new Map(returned.map((item) => [item.id, item]));
  for (const target of targets) {
    const result = byId.get(target.id);
    await upsertCaptionSegment({
      ...target,
      translationText: result?.text || "",
      translationState: result?.text ? "revised" : "error",
      error: result?.text ? "" : result?.error || "Translation unavailable",
    });
  }
  return true;
}

async function translatePrefetchedBatchWithRetry(session, indices, context) {
  if (activeCaptionSession?.id !== session.id) return false;
  const controller = new AbortController();
  const generation = context.generation;
  context.batchController = controller;
  try {
    return await translatePrefetchedBatch(session, indices, context, {
      signal: controller.signal,
      generation,
    });
  } catch (error) {
    if (error.name === "AbortError" && context.generation !== generation) return false;
    throw error;
  } finally {
    if (context.batchController === controller) context.batchController = null;
  }
}

async function translatePrefetchedSession(sessionId, currentMs) {
  const session = activeCaptionSession;
  if (!session || session.id !== sessionId) return;
  const context = {
    summary: session.title,
    glossary: [],
    currentMs,
    generation: 0,
    batchController: null,
    contextController: new AbortController(),
  };
  captionContexts.set(session.id, context);
  const builtContext = await buildPrefetchedContext(
    session,
    context.contextController.signal,
  );
  Object.assign(context, builtContext);
  if (activeCaptionSession?.id !== session.id) return;
  const remaining = new Set(
    session.segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => !["translated", "revised"].includes(segment.translationState))
      .map(({ index }) => index),
  );
  while (remaining.size) {
    if (activeCaptionSession?.id !== session.id) return;
    const order = [...remaining].sort((a, b) => {
      const aTime = session.segments[a].startMs;
      const bTime = session.segments[b].startMs;
      const aPriority = aTime >= context.currentMs && aTime <= context.currentMs + 180_000;
      const bPriority = bTime >= context.currentMs && bTime <= context.currentMs + 180_000;
      return Number(bPriority) - Number(aPriority) || aTime - bTime;
    });
    const batch = order.slice(0, 6).sort((a, b) => a - b);
    try {
      const completed = await translatePrefetchedBatchWithRetry(session, batch, context);
      if (!completed) continue;
    } catch (error) {
      for (const index of batch) {
        await upsertCaptionSegment({
          ...session.segments[index],
          translationState: "error",
          error: error.message || "Translation failed",
        });
      }
    }
    batch.forEach((index) => remaining.delete(index));
  }
  if (activeCaptionSession?.id === session.id) {
    session.status = "ready";
    await persistCaptionSession();
    broadcastSnapshot();
  }
}

async function stopCaptionSession(reason = "stopped") {
  if (reason === "stopped") clearPendingCaptionStart();
  await captionRestorePromise;
  const session = activeCaptionSession;
  if (!session) return { success: true };
  captionContexts.get(session.id)?.liveController?.abort();
  captionContexts.get(session.id)?.contextController?.abort();
  captionContexts.get(session.id)?.batchController?.abort();
  for (const controller of captionContexts.get(session.id)?.controllers?.values?.() || []) {
    controller.abort();
  }
  captionContexts.delete(session.id);
  if (session.mode === "live") {
    await chrome.runtime
      .sendMessage({ action: "stopOffscreenCapture", target: "offscreen" })
      .catch(() => {});
  }
  session.status = reason;
  await persistCaptionSession(session);
  sendRuntime({ action: "captionSessionStopped", session });
  sendTab(session.tabId, { action: "captionSessionStopped", session });
  activeCaptionSession = null;
  await chrome.storage.local.remove(ACTIVE_CAPTION_SESSION_KEY);
  return { success: true, session };
}

async function startCaptionSession(message, streamIdPromise) {
  await captionRestorePromise;
  const tab = message.tabId ? await chrome.tabs.get(message.tabId) : await activeHttpTab();
  const prepared = await prepareCaptionPage({ tabId: tab.id, videoId: message.videoId });
  const prefetched = Array.isArray(message.prefetchedSegments)
    ? message.prefetchedSegments.filter((segment) => segment?.sourceText)
    : [];
  const mode = prefetched.length ? "prefetched" : "live";
  const settings = await getSettings();
  if (!settings.aiApiKey) throw new Error("Add a DeepSeek API key in Settings.");
  if (mode === "live" && !settings.deepgramApiKey) {
    throw new Error("No complete subtitle track was found. Add a Deepgram API key for live transcription.");
  }
  if (activeCaptionSession) await stopCaptionSession("replaced");
  activeCaptionSession = YTD_LIVE_CAPTIONS.createSession({
    tabId: tab.id,
    url: prepared.page.url || tab.url,
    title: prepared.page.title || tab.title,
    mode,
    videoId: prepared.page.selectedVideoId || message.videoId,
    transcriptVideoId: message.transcriptVideoId || message.youtubeVideoId || "",
    transcriptSourceHash: message.transcriptSourceHash || "",
  });
  if (message.sourceLabel) activeCaptionSession.source = message.sourceLabel;
  activeCaptionSession.sourceLanguage =
    message.sourceLanguage || (mode === "live" ? "en" : "auto-detected");
  activeCaptionSession.status = mode === "prefetched" ? "preparing context" : "connecting";
  if (mode === "prefetched") {
    activeCaptionSession.segments = prefetched.map((segment) =>
      YTD_LIVE_CAPTIONS.normalizeSegment(segment, segment.source || "video-subtitles"),
    );
  }
  await persistCaptionSession();
  broadcastSnapshot();

  if (mode === "live") {
    const streamId = await streamIdPromise;
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({
      action: "startOffscreenCapture",
      target: "offscreen",
      streamId,
      apiKey: settings.deepgramApiKey,
      sessionId: activeCaptionSession.id,
    });
    if (!result?.success) throw new Error(result?.error || "Could not start tab audio capture.");
    activeCaptionSession.status = "listening";
  } else {
    activeCaptionSession.status = "translating";
    void translatePrefetchedSession(
      activeCaptionSession.id,
      Math.round(Number(message.currentTime || prepared.page.currentTime || 0) * 1000),
    );
  }
  await persistCaptionSession();
  broadcastSnapshot();
  return { success: true, session: activeCaptionSession };
}

async function handleOffscreenEvent(message) {
  await captionRestorePromise;
  if (!activeCaptionSession || activeCaptionSession.mode !== "live") return;
  if (message.sessionId && message.sessionId !== activeCaptionSession.id) return;
  if (message.event === "transcript") {
    const existing = activeCaptionSession.segments.find(
      (item) => item.id === message.data.id,
    );
    if (
      existing?.recognitionState === "final" &&
      message.data.recognitionState === "final" &&
      existing.sourceText === message.data.sourceText
    ) {
      return;
    }
    const segment = await upsertCaptionSegment({
      ...message.data,
      translationState: "queued",
      source: "deepgram-live",
    });
    if (segment?.recognitionState === "final") {
      void translateLiveCaption(segment.id);
    }
  } else if (message.event === "connection") {
    activeCaptionSession.status = message.data.status || "error";
    activeCaptionSession.error = message.data.error || "";
    await persistCaptionSession();
    broadcastSnapshot();
  } else if (message.event === "gap") {
    activeCaptionSession.gaps.push(message.data);
    await persistCaptionSession();
  } else if (message.event === "streamEnded") {
    await stopCaptionSession("audio stream ended");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "prepareCaptionPage") {
    prepareCaptionPage(message)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.action === "startCaptionSession") {
    const tabId = message.tabId || sender.tab?.id;
    const hasPrefetched = Array.isArray(message.prefetchedSegments) && message.prefetchedSegments.length;
    // Start this promise before any await so the button gesture remains valid.
    const streamIdPromise = hasPrefetched
      ? Promise.resolve("")
      : chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    startCaptionSession({ ...message, tabId }, streamIdPromise)
      .then(sendResponse)
      .catch(async (error) => {
        if (activeCaptionSession?.status === "connecting") await stopCaptionSession("error");
        if (!hasPrefetched && isActiveTabCaptureError(error)) {
          try {
            await queuePendingCaptionStart({ ...message, tabId });
            sendResponse({
              success: false,
              error: "Click the LingoLens icon in the Chrome toolbar to authorize this video. Subtitles will start automatically.",
              errorCode: "ACTIVE_TAB_REQUIRED",
              requiresActionClick: true,
            });
          } catch (contextError) {
            sendResponse({
              success: false,
              error: contextError.message || "The video changed before authorization could be requested.",
            });
          }
          return;
        }
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
  if (message.action === "stopCaptionSession") {
    stopCaptionSession("stopped").then(sendResponse);
    return true;
  }
  if (message.action === "getCaptionSessionSnapshot") {
    captionRestorePromise.then(() =>
      sendResponse({ success: true, session: activeCaptionSession }),
    );
    return true;
  }
  if (message.action === "captionPlaybackPositionChanged") {
    const session = activeCaptionSession;
    if (session?.mode !== "prefetched" || sender.tab?.id !== session.tabId) {
      sendResponse({ success: false });
      return false;
    }
    const context = captionContexts.get(session.id);
    if (context) {
      context.currentMs = Math.max(0, Math.round(Number(message.currentTime || 0) * 1000));
      context.generation += 1;
      context.batchController?.abort();
    }
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "offscreenCaptionEvent" && message.target === "background") {
    handleOffscreenEvent(message).then(() => sendResponse({ success: true }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pendingCaptionStart?.tabId === tabId) clearPendingCaptionStart("The requested tab was closed.");
  if (activeCaptionSession?.tabId === tabId) void stopCaptionSession("tab closed");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && pendingCaptionStart?.tabId === tabId) {
    const nextUrl = YTD_LIVE_CAPTIONS.normalizedPageUrl(changeInfo.url);
    if (nextUrl !== pendingCaptionStart.url) {
      clearPendingCaptionStart("The page changed before authorization.");
    }
  }
  if (changeInfo.url && activeCaptionSession?.tabId === tabId) {
    void stopCaptionSession("page navigated");
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (pendingCaptionStart && pendingCaptionStart.tabId !== tabId) {
    clearPendingCaptionStart("The active tab changed before authorization.");
  }
});

globalThis.__YTD_LIVE_CAPTION_TESTING__ = {
  liveTranslationPrompt,
  prepareCaptionPage,
};
