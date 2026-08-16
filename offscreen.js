/* global YTD_LIVE_CAPTIONS */
/** Owns tab audio, PCM conversion, and the Deepgram streaming connection. */
let capture = null;

async function emit(event, data = {}, sessionId = "") {
  try {
    await chrome.runtime.sendMessage({
      action: "offscreenCaptionEvent",
      target: "background",
      event,
      data,
      sessionId,
    });
  } catch (_error) {
    // The service worker may be restarting. The stream remains owned here.
  }
}

function deepgramUrl() {
  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: "500",
    utterance_end_ms: "1000",
  });
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

function connectDeepgram(state) {
  if (!state.active) return;
  state.connectionBaseMs = Math.max(
    0,
    state.audioSentMs - state.pendingAudio.length * 100,
  );
  const socket = new WebSocket(deepgramUrl(), ["token", state.apiKey]);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    emit("connection", { status: "listening" }, state.sessionId);
    if (state.droppedAudioStartMs != null) {
      emit("gap", {
        startMs: state.droppedAudioStartMs,
        endMs: Math.max(state.droppedAudioStartMs + 100, state.audioSentMs - 3000),
        reason: "Audio exceeded the reconnect buffer and could not be transcribed.",
      }, state.sessionId);
      state.droppedAudioStartMs = null;
    }
    while (state.pendingAudio.length && socket.readyState === WebSocket.OPEN) {
      socket.send(state.pendingAudio.shift());
    }
  });

  socket.addEventListener("message", (message) => {
    let payload;
    try {
      payload = JSON.parse(message.data);
    } catch (_error) {
      return;
    }
    if (payload.type !== "Results") return;
    const segment = YTD_LIVE_CAPTIONS.mergeDeepgramResult(
      state.utterance,
      payload,
      state.connectionBaseMs,
    );
    if (segment) emit("transcript", segment, state.sessionId);
  });

  socket.addEventListener("error", () => {
    emit(
      "connection",
      { status: "error", error: "Deepgram connection error." },
      state.sessionId,
    );
  });

  socket.addEventListener("close", (event) => {
    if (!state.active || state.socket !== socket) return;
    const attempt = state.reconnectAttempt++;
    if (attempt >= 4) {
      emit("connection", {
        status: "error",
        error: `Deepgram disconnected (${event.code}). Stop and start captions to retry.`,
      }, state.sessionId);
      return;
    }
    const delay = [1000, 2000, 4000, 8000][attempt];
    emit("connection", {
      status: "reconnecting",
      error: `Deepgram disconnected; reconnecting in ${delay / 1000}s.`,
    }, state.sessionId);
    setTimeout(() => connectDeepgram(state), delay);
  });
}

async function startCapture({ streamId, apiKey, sessionId }) {
  await stopCapture();
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
  const audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("audio-worklet.js");
  const source = audioContext.createMediaStreamSource(media);
  const processor = new AudioWorkletNode(audioContext, "caption-pcm-processor");

  const state = {
    active: true,
    apiKey,
    sessionId,
    media,
    audioContext,
    source,
    processor,
    socket: null,
    pendingAudio: [],
    audioSentMs: 0,
    connectionBaseMs: 0,
    reconnectAttempt: 0,
    droppedAudioStartMs: null,
    utterance: { finalParts: [], utteranceStartMs: null },
  };
  capture = state;

  // Capturing a tab mutes its normal output, so explicitly route it back.
  source.connect(audioContext.destination);
  source.connect(processor);
  processor.port.onmessage = ({ data }) => {
    if (!state.active || !(data instanceof ArrayBuffer)) return;
    state.audioSentMs += 100;
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(data);
    else {
      state.pendingAudio.push(data);
      if (state.pendingAudio.length > 30) {
        state.pendingAudio.shift();
        state.droppedAudioStartMs ??= Math.max(0, state.audioSentMs - 3100);
      }
    }
  };
  media.getAudioTracks()[0]?.addEventListener("ended", () => {
    emit("streamEnded", {}, state.sessionId);
  });
  connectDeepgram(state);
}

async function stopCapture() {
  const state = capture;
  capture = null;
  if (!state) return;
  state.active = false;
  try {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "Finalize" }));
      state.socket.send(JSON.stringify({ type: "CloseStream" }));
    }
    state.socket?.close();
  } catch (_error) {
    // Continue releasing local media resources.
  }
  state.processor?.disconnect();
  state.source?.disconnect();
  state.media?.getTracks().forEach((track) => track.stop());
  await state.audioContext?.close().catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;
  if (message.action === "startOffscreenCapture") {
    startCapture(message)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        emit(
          "connection",
          { status: "error", error: error.message },
          message.sessionId,
        );
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
  if (message.action === "stopOffscreenCapture") {
    stopCapture().then(() => sendResponse({ success: true }));
    return true;
  }
  return false;
});
