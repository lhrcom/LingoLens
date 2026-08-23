(function initYtdPageTranslationContent() {
  "use strict";

  if (globalThis.__YTD_PAGE_TRANSLATION_CONTENT_LOADED__) return;
  globalThis.__YTD_PAGE_TRANSLATION_CONTENT_LOADED__ = true;

  const Core = globalThis.YTD_PAGE_TRANSLATION_CORE;
  const MAX_SELECTION_CHARS = 12_000;
  const pageInstanceId = `page-instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const CANDIDATE_SELECTOR =
    "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th";
  const EXCLUDED_SELECTOR = [
    "script", "style", "noscript", "svg", "canvas", "pre",
    "input", "textarea", "select", "option", "button", "nav", "footer", "aside",
    "[contenteditable]", "[aria-hidden=\"true\"]", "[hidden]",
    "[data-ytdpt-ui]", "[data-ytdpt-generated]",
  ].join(",");

  let sourceCounter = 0;
  let pagePort = null;
  let pageGeneration = 0;
  let targetMap = new Map();
  const generatedNodes = new Set();
  let removalObserver = null;
  let removalTimer = null;
  let selectionHost = null;
  let selectionShadow = null;
  let selectedText = "";
  let selectedRect = null;
  let selectionTranslation = "";
  let pageState = createPageState();

  function createPageState() {
    return {
      status: "idle",
      jobId: null,
      total: 0,
      completed: 0,
      success: 0,
      failed: 0,
      rendered: 0,
      message: "Page translation has not started.",
    };
  }

  function renderedNodeCount() {
    return document.querySelectorAll("[data-ytdpt-generated]").length;
  }

  const publicStatus = () => ({
    ...pageState,
    rendered: renderedNodeCount(),
    pageInstanceId,
  });

  function stopRemovalGuard() {
    removalObserver?.disconnect();
    removalObserver = null;
    clearTimeout(removalTimer);
    removalTimer = null;
  }

  function notifySidePanel(action, payload) {
    chrome.runtime.sendMessage({ action, ...payload }).catch(() => {});
  }

  function notifyStatus() {
    notifySidePanel("ytdPageTranslationStatusChanged", {
      status: publicStatus(),
    });
  }

  function ensureSelectionUi() {
    if (selectionHost?.isConnected) return;
    selectionHost = document.createElement("div");
    selectionHost.dataset.ytdptUi = "selection";
    selectionHost.style.cssText =
      "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646";
    selectionShadow = selectionHost.attachShadow({ mode: "closed" });
    selectionShadow.innerHTML = `
      <style>
        *{box-sizing:border-box}
        [hidden]{display:none!important}
        .trigger{display:none;position:fixed;pointer-events:auto;width:34px;height:34px;padding:0;border:0;border-radius:10px;background:#c8674f;color:#fff;box-shadow:0 6px 20px rgba(50,42,32,.28);font:700 15px/34px system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;cursor:pointer}
        .trigger:hover,.trigger:focus-visible{background:#b25742;transform:translateY(-1px);outline:2px solid #fff;outline-offset:2px}
        .card{display:none;position:fixed;pointer-events:auto;width:min(380px,calc(100vw - 24px));padding:14px;border:1px solid rgba(200,103,79,.28);border-radius:13px;background:rgba(255,255,255,.98);color:#2e2a24;box-shadow:0 14px 42px rgba(50,42,32,.24);font:14px/1.65 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;backdrop-filter:blur(9px)}
        .title{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;color:#b25742;font-size:12px;font-weight:750}
        .text{max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word}
        .actions{display:flex;justify-content:flex-end;gap:7px;margin-top:10px}
        .actions button{border:0;border-radius:999px;padding:6px 10px;background:#f8eee9;color:#9d4938;font:650 12px/1.2 inherit;cursor:pointer}
        .actions button:hover,.actions button:focus-visible{background:#f2e3dc;outline:2px solid rgba(200,103,79,.35)}
        .spinner{display:inline-block;width:13px;height:13px;margin-right:7px;border:2px solid #ecd8ce;border-top-color:#c8674f;border-radius:50%;vertical-align:-2px;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        @media(prefers-color-scheme:dark){.card{background:rgba(46,42,36,.98);color:#fffaf3;border-color:rgba(217,154,91,.4)}.title{color:#e8a88f}.actions button{background:#5b3930;color:#ffe9df}}
      </style>
      <button class="trigger" type="button" title="翻译所选文本" aria-label="翻译所选文本">译</button>
      <div class="card" role="dialog" aria-label="划词翻译">
        <div class="title"><span>DeepSeek 翻译</span><span class="state" aria-live="polite"></span></div>
        <div class="text"></div>
        <div class="actions">
          <button data-action="copy" type="button">复制</button>
          <button data-action="retry" type="button">重试</button>
          <button data-action="close" type="button">关闭</button>
        </div>
      </div>`;
    selectionShadow.querySelector(".trigger").addEventListener("click", translateCurrentSelection);
    selectionShadow.querySelector('[data-action="copy"]').addEventListener("click", copySelectionTranslation);
    selectionShadow.querySelector('[data-action="retry"]').addEventListener("click", translateCurrentSelection);
    selectionShadow.querySelector('[data-action="close"]').addEventListener("click", hideSelectionUi);
    document.documentElement.appendChild(selectionHost);
  }

  function positionSelectionElement(element) {
    if (!selectedRect) return;
    const width = element.classList.contains("card")
      ? Math.min(380, window.innerWidth - 24)
      : 34;
    const measuredHeight = element.getBoundingClientRect().height;
    const height = measuredHeight || (element.classList.contains("card") ? 190 : 34);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, selectedRect.left));
    const below = selectedRect.bottom + 8;
    const top = below + height <= window.innerHeight - 8
      ? below
      : Math.max(8, selectedRect.top - height - 8);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  function showSelectionTrigger(text, rect) {
    ensureSelectionUi();
    selectedText = text;
    selectedRect = rect;
    selectionTranslation = "";
    const trigger = selectionShadow.querySelector(".trigger");
    selectionShadow.querySelector(".card").style.display = "none";
    trigger.style.display = "block";
    positionSelectionElement(trigger);
  }

  function hideSelectionUi() {
    if (!selectionShadow) return;
    selectionShadow.querySelector(".trigger").style.display = "none";
    selectionShadow.querySelector(".card").style.display = "none";
    selectedText = "";
    selectedRect = null;
    selectionTranslation = "";
  }

  function showSelectionCard(content, options = {}) {
    ensureSelectionUi();
    const card = selectionShadow.querySelector(".card");
    selectionShadow.querySelector(".trigger").style.display = "none";
    card.style.display = "block";
    const textNode = selectionShadow.querySelector(".text");
    textNode.textContent = "";
    if (options.loading) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      textNode.append(spinner, document.createTextNode(content));
    } else {
      textNode.textContent = content;
    }
    selectionShadow.querySelector(".state").textContent = options.error
      ? "失败"
      : options.loading
        ? "处理中"
        : "完成";
    selectionShadow.querySelector('[data-action="copy"]').hidden =
      options.loading || options.error || !selectionTranslation;
    selectionShadow.querySelector('[data-action="retry"]').hidden =
      options.loading || !options.error || options.retryable === false;
    positionSelectionElement(card);
    requestAnimationFrame(() => positionSelectionElement(card));
  }

  async function translateCurrentSelection() {
    if (!Core.hasEnglish(selectedText)) return;
    if (selectedText.length > MAX_SELECTION_CHARS) {
      showSelectionCard("选择内容超过 12,000 个字符，请缩短后重试。", {
        error: true,
        retryable: false,
      });
      return;
    }
    selectionTranslation = "";
    showSelectionCard("正在翻译…", { loading: true });
    try {
      const response = await chrome.runtime.sendMessage({
        action: "ytdPageTranslationTranslateSelection",
        text: selectedText,
      });
      if (!response?.ok) throw new Error(response?.error?.message || "翻译失败");
      selectionTranslation = response.translation;
      showSelectionCard(selectionTranslation);
    } catch (error) {
      showSelectionCard(error.message || "翻译失败，请稍后重试。", { error: true });
    }
  }

  async function copySelectionTranslation() {
    if (!selectionTranslation) return;
    try {
      await navigator.clipboard.writeText(selectionTranslation);
      selectionShadow.querySelector(".state").textContent = "已复制";
    } catch (_error) {
      selectionShadow.querySelector(".state").textContent = "复制失败";
    }
  }

  function inspectCurrentSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      hideSelectionUi();
      return;
    }
    const text = Core.normalizeText(selection.toString());
    if (!Core.hasEnglish(text)) {
      hideSelectionUi();
      return;
    }
    const range = selection.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) rect = range.getClientRects()[0];
    if (!rect) return;
    const plainRect = {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
    };
    if (text.length > MAX_SELECTION_CHARS) {
      selectedText = text;
      selectedRect = plainRect;
      selectionTranslation = "";
      showSelectionCard("选择内容超过 12,000 个字符，请缩短后重试。", {
        error: true,
        retryable: false,
      });
      return;
    }
    showSelectionTrigger(text, plainRect);
  }

  function nextSourceId() {
    sourceCounter += 1;
    return `ytdpt-${Date.now().toString(36)}-${sourceCounter.toString(36)}`;
  }

  function sourceIdFor(element) {
    if (!element.dataset.ytdptSourceId) {
      element.dataset.ytdptSourceId = nextSourceId();
    }
    return element.dataset.ytdptSourceId;
  }

  function isVisible(element) {
    if (!element || !element.isConnected || element.getClientRects().length === 0) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0;
  }

  function isExcluded(element) {
    if (!element || element.closest(EXCLUDED_SELECTOR)) return true;
    const descriptor = {
      generated: Boolean(element.closest("[data-ytdpt-generated], [data-ytdpt-ui]")),
      hidden: !isVisible(element),
      ariaHidden: element.closest('[aria-hidden="true"]') !== null,
      contentEditable: element.isContentEditable,
      ancestorTags: [],
    };
    let current = element;
    while (current) {
      descriptor.ancestorTags.push(current.tagName);
      current = current.parentElement;
    }
    return Core.shouldExcludeElementDescriptor(descriptor);
  }

  function extractReadableText(element) {
    const pieces = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(EXCLUDED_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(CANDIDATE_SELECTOR) !== element) return NodeFilter.FILTER_REJECT;
        return Core.normalizeText(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) pieces.push(node.nodeValue);
    return Core.normalizeText(pieces.join(" "));
  }

  function chooseContentRoot() {
    const article = document.querySelector("article");
    if (article && isVisible(article) && Core.hasEnglish(article.innerText)) return article;
    const main = document.querySelector("main");
    if (main && isVisible(main) && Core.hasEnglish(main.innerText)) return main;
    return document.body;
  }

  function generatedNodeFor(sourceId) {
    return document.querySelector(`[data-ytdpt-for="${CSS.escape(sourceId)}"]`);
  }

  function insertGenerated(element, node) {
    if (["LI", "TD", "TH"].includes(element.tagName)) element.appendChild(node);
    else element.insertAdjacentElement("afterend", node);
  }

  function removeGeneratedFor(sourceId) {
    document
      .querySelectorAll(`[data-ytdpt-for="${CSS.escape(sourceId)}"]`)
      .forEach((node) => {
        generatedNodes.delete(node);
        node.remove();
      });
  }

  function renderTranslation(item, translation) {
    removeGeneratedFor(item.sourceId);
    if (!item.element.isConnected) return;
    const node = document.createElement("div");
    node.dataset.ytdptGenerated = "translation";
    node.dataset.ytdptFor = item.sourceId;
    node.lang = "zh-CN";
    node.textContent = translation;
    generatedNodes.add(node);
    insertGenerated(item.element, node);
  }

  function renderError(item, target, message) {
    removeGeneratedFor(item.sourceId);
    if (!item.element.isConnected) return;
    const node = document.createElement("div");
    node.dataset.ytdptGenerated = "error";
    node.dataset.ytdptFor = item.sourceId;
    const label = document.createElement("span");
    label.textContent = message || "Translation failed.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Retry";
    button.addEventListener("click", () => retryTarget(target));
    node.append(label, button);
    generatedNodes.add(node);
    insertGenerated(item.element, node);
  }

  function collectPageSegments() {
    const root = chooseContentRoot();
    const candidates = [...root.querySelectorAll(CANDIDATE_SELECTOR)];
    const byText = new Map();
    const segments = [];
    targetMap = new Map();
    let total = 0;
    let existing = 0;

    for (const element of candidates) {
      if (isExcluded(element)) continue;
      const text = extractReadableText(element);
      if (!Core.hasEnglish(text) || text.length < 2) continue;
      const sourceId = sourceIdFor(element);
      total += 1;
      const generated = generatedNodeFor(sourceId);
      if (generated?.dataset.ytdptGenerated === "translation") {
        existing += 1;
        continue;
      }
      let apiId = byText.get(text);
      if (!apiId) {
        apiId = sourceId;
        byText.set(text, apiId);
        targetMap.set(apiId, { id: apiId, text, items: [], status: "pending" });
        segments.push({ id: apiId, text });
      }
      targetMap.get(apiId).items.push({ element, sourceId });
    }
    return { segments, total, existing };
  }

  async function startPageTranslation() {
    if (["running", "stopping"].includes(pageState.status)) {
      return {
        ok: false,
        error: { message: "A page translation is already running." },
        status: publicStatus(),
      };
    }
    stopRemovalGuard();
    pageGeneration += 1;
    const generation = pageGeneration;
    const { segments, total, existing } = collectPageSegments();
    pageState = {
      status: segments.length ? "running" : "completed",
      jobId: `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      total,
      completed: existing,
      success: existing,
      failed: 0,
      message: segments.length
        ? "Translating page..."
        : total
          ? "Page translation is complete."
          : "No translatable English body text was found.",
    };
    notifyStatus();
    if (!segments.length) return { ok: true, status: publicStatus() };

    try {
      pagePort?.disconnect();
      const port = chrome.runtime.connect({ name: "ytd-page-translation" });
      pagePort = port;
      port.onMessage.addListener((message) => {
        if (message.action === "ytdPageTranslationProgress") {
          handleProgress(message, generation);
        }
      });
      port.onDisconnect.addListener(() => {
        if (pagePort !== port || generation !== pageGeneration) return;
        pagePort = null;
        if (pageState.status === "running") {
          pageState.status = "failed";
          pageState.message = "The background connection closed. Try again.";
          notifyStatus();
        }
      });
      port.postMessage({
        action: "ytdPageTranslationStartJob",
        jobId: pageState.jobId,
        segments,
      });
      return { ok: true, status: publicStatus() };
    } catch (_error) {
      pageState.status = "failed";
      pageState.message = "The extension background did not respond.";
      notifyStatus();
      return { ok: false, error: { message: pageState.message }, status: publicStatus() };
    }
  }

  async function cancelPageTranslation() {
    if (!pageState.jobId || !["running", "stopping"].includes(pageState.status)) {
      return { ok: true, status: publicStatus() };
    }
    pageState.status = "stopping";
    pageState.message = "Stopping translation...";
    notifyStatus();
    try {
      if (pagePort) {
        pagePort.postMessage({ action: "ytdPageTranslationCancelJob", jobId: pageState.jobId });
      } else {
        await chrome.runtime.sendMessage({
          action: "ytdPageTranslationCancelJob",
          jobId: pageState.jobId,
        });
      }
    } catch (_error) {
      pageState.status = "cancelled";
      pageState.message = "Translation stopped.";
      notifyStatus();
    }
    return { ok: true, status: publicStatus() };
  }

  function sweepGeneratedNodes() {
    let removed = 0;
    for (const node of [...generatedNodes]) {
      generatedNodes.delete(node);
      if (!node?.isConnected) continue;
      node.remove();
      removed += 1;
    }
    document.querySelectorAll("[data-ytdpt-generated]").forEach((node) => {
      generatedNodes.delete(node);
      if (!node.isConnected) return;
      node.remove();
      removed += 1;
    });
    document.querySelectorAll("[data-ytdpt-source-id]").forEach((element) => {
      delete element.dataset.ytdptSourceId;
    });
    return removed;
  }

  function startRemovalGuard() {
    stopRemovalGuard();
    const removeReinserted = (root) => {
      if (!(root instanceof Element)) return;
      if (root.matches("[data-ytdpt-generated]")) root.remove();
      root
        .querySelectorAll?.("[data-ytdpt-generated]")
        .forEach((node) => node.remove());
    };
    removalObserver = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach(removeReinserted);
      }
    });
    removalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    requestAnimationFrame(() => sweepGeneratedNodes());
    setTimeout(() => sweepGeneratedNodes(), 120);
    removalTimer = setTimeout(() => {
      sweepGeneratedNodes();
      stopRemovalGuard();
    }, 1500);
  }

  async function removePageTranslations() {
    const activeJobId = pageState.jobId;
    const activePort = pagePort;
    pageGeneration += 1;
    pagePort = null;
    targetMap.clear();
    pageState = createPageState();
    if (activePort && activeJobId) {
      try {
        activePort.postMessage({
          action: "ytdPageTranslationCancelJob",
          jobId: activeJobId,
        });
      } catch (_error) {
        // Disconnecting the port below also aborts its background jobs.
      }
    } else if (activeJobId) {
      await chrome.runtime
        .sendMessage({
          action: "ytdPageTranslationCancelJob",
          jobId: activeJobId,
        })
        .catch(() => {});
    }
    activePort?.disconnect();
    const removedCount = sweepGeneratedNodes();
    startRemovalGuard();
    notifyStatus();
    return { ok: true, removedCount, status: publicStatus() };
  }

  async function retryTarget(target) {
    if (!target || target.status === "retrying") return;
    const previousFailedCount = target.status === "failed" ? target.items.length : 0;
    target.status = "retrying";
    for (const item of target.items) {
      const node = generatedNodeFor(item.sourceId);
      if (node) node.textContent = "Retrying...";
    }
    try {
      const response = await chrome.runtime.sendMessage({
        action: "ytdPageTranslationTranslateSelection",
        text: target.text,
      });
      if (!response?.ok) throw new Error(response?.error?.message || "Retry failed.");
      target.status = "success";
      target.items.forEach((item) => renderTranslation(item, response.translation));
      pageState.failed = Math.max(0, pageState.failed - previousFailedCount);
      pageState.success += previousFailedCount;
      pageState.message = pageState.failed
        ? "Page translation completed with errors."
        : "Page translation is complete.";
    } catch (error) {
      target.status = "failed";
      target.items.forEach((item) => renderError(item, target, error.message));
    }
    notifyStatus();
  }

  function handleProgress(message, generation = pageGeneration) {
    if (
      !message ||
      generation !== pageGeneration ||
      message.jobId !== pageState.jobId
    ) {
      return;
    }
    if (message.fatalError) {
      pageState.status = "failed";
      pageState.message = message.fatalError.message || "Page translation failed.";
      const failedPort = pagePort;
      pagePort = null;
      failedPort?.disconnect();
      notifyStatus();
      return;
    }
    for (const result of message.results || []) {
      const target = targetMap.get(result.id);
      if (!target || target.status === "success") continue;
      target.status = "success";
      target.items.forEach((item) => renderTranslation(item, result.text));
      pageState.success += target.items.length;
      pageState.completed += target.items.length;
    }
    for (const failure of message.errors || []) {
      const target = targetMap.get(failure.id);
      if (!target || ["success", "failed"].includes(target.status)) continue;
      target.status = "failed";
      const errorMessage = failure.error?.message || "Translation failed.";
      target.items.forEach((item) => renderError(item, target, errorMessage));
      pageState.failed += target.items.length;
      pageState.completed += target.items.length;
    }
    if (message.done) {
      if (message.cancelled) {
        pageState.status = "cancelled";
        pageState.message = "Translation stopped; completed translations were kept.";
      } else {
        pageState.status = "completed";
        pageState.message = pageState.failed
          ? "Page translation completed with errors."
          : "Page translation is complete.";
      }
      const completedPort = pagePort;
      pagePort = null;
      completedPort?.disconnect();
    } else {
      pageState.message = `Translating page: ${Math.min(pageState.completed, pageState.total)} / ${pageState.total}`;
    }
    notifyStatus();
  }

  document.addEventListener("mouseup", (event) => {
    if (selectionHost && event.composedPath().includes(selectionHost)) return;
    setTimeout(inspectCurrentSelection, 0);
  }, true);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      hideSelectionUi();
      return;
    }
    if (selectionHost && event.composedPath().includes(selectionHost)) return;
    setTimeout(inspectCurrentSelection, 0);
  }, true);
  document.addEventListener("mousedown", (event) => {
    if (selectionHost && event.composedPath().includes(selectionHost)) return;
    hideSelectionUi();
  }, true);
  window.addEventListener("scroll", hideSelectionUi, { passive: true });
  window.addEventListener("resize", hideSelectionUi, { passive: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.action?.startsWith("ytdPageTranslation")) return false;
    if (message.action === "ytdPageTranslationGetStatus") {
      sendResponse({ ok: true, status: publicStatus() });
      return false;
    }
    if (
      message.pageInstanceId &&
      message.pageInstanceId !== pageInstanceId
    ) {
      sendResponse({
        ok: false,
        error: { message: "The page changed before this action could run." },
        status: publicStatus(),
      });
      return false;
    }
    if (message.action === "ytdPageTranslationStart") {
      startPageTranslation().then(sendResponse);
      return true;
    }
    if (message.action === "ytdPageTranslationCancel") {
      cancelPageTranslation().then(sendResponse);
      return true;
    }
    if (message.action === "ytdPageTranslationRemove") {
      removePageTranslations().then(sendResponse);
      return true;
    }
    return false;
  });
})();
