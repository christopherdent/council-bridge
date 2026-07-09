const STORAGE_KEY = "capturedText";

const TARGETS = {
  gemini: {
    urlPattern: "https://gemini.google.com/*",
    openUrl: "https://gemini.google.com/",
    label: "Gemini",
    responseLabel: "Gemini",
    defaultSourceLabel: "ChatGPT",
    wrap: (capturedText, sourceLabel = "ChatGPT") => `${sourceLabel}:

${capturedText}

Gemini:`
  },
  chatgpt: {
    urlPattern: "https://chatgpt.com/*",
    openUrl: "https://chatgpt.com/",
    label: "ChatGPT",
    responseLabel: "ChatGPT",
    defaultSourceLabel: "Gemini",
    wrap: (capturedText, sourceLabel = "Gemini") => `${sourceLabel}:

${capturedText}

ChatGPT:`
  }
};

const capturedTextEl = document.getElementById("capturedText");
const statusEl = document.getElementById("status");
const captureButton = document.getElementById("captureSelectedText");
const passSelectionButton = document.getElementById("passSelection");
const sendToGeminiButton = document.getElementById("sendToGemini");
const sendToChatGPTButton = document.getElementById("sendToChatGPT");
const openSidePanelButton = document.getElementById("openSidePanel");

document.addEventListener("DOMContentLoaded", loadCapturedText);
capturedTextEl.addEventListener("input", saveCapturedTextFromTextarea);
captureButton.addEventListener("click", captureSelectedText);
passSelectionButton?.addEventListener("click", passSelectionToOtherAi);
sendToGeminiButton.addEventListener("click", () => sendToTarget(TARGETS.gemini));
sendToChatGPTButton.addEventListener("click", () => sendToTarget(TARGETS.chatgpt));
openSidePanelButton?.addEventListener("click", openSidePanel);

async function loadCapturedText() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  capturedTextEl.value = stored[STORAGE_KEY] || "";
}

async function saveCapturedTextFromTextarea() {
  await chrome.storage.local.set({ [STORAGE_KEY]: capturedTextEl.value });
  setStatus("Saved.");
}

async function captureSelectedText() {
  try {
    const activeTab = await getActiveTab();

    if (!activeTab?.id) {
      setStatus("No active tab found.");
      return;
    }

    const selectedText = await captureTextFromTab(activeTab);

    if (!selectedText.trim()) {
      setStatus("No selected text found.");
      return;
    }

    capturedTextEl.value = selectedText;
    await chrome.storage.local.set({ [STORAGE_KEY]: selectedText });
    setStatus("Captured selected text.");
  } catch (error) {
    setStatus(`Capture failed: ${getErrorMessage(error)}`);
  }
}

async function passSelectionToOtherAi() {
  try {
    const activeTab = await getActiveTab();
    const target = getOppositeTarget(activeTab?.url || "");

    if (!target) {
      setStatus("Open ChatGPT or Gemini first.");
      return;
    }

    const selectedText = await captureTextFromTab(activeTab);

    if (!selectedText.trim()) {
      setStatus("No selected text found.");
      return;
    }

    capturedTextEl.value = selectedText;
    await chrome.storage.local.set({ [STORAGE_KEY]: selectedText });
    await sendToTarget(target, {
      capturedText: selectedText,
      sourceLabel: getSourceLabel(activeTab.url)
    });
  } catch (error) {
    setStatus(`Pass failed: ${getErrorMessage(error)}`);
  }
}

async function sendToTarget(target, options) {
  const capturedText = options?.capturedText ?? capturedTextEl.value;

  if (!capturedText.trim()) {
    setStatus("Capture or enter text first.");
    return;
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: capturedText });
    const tab = await findOrCreateTab(target);
    await waitForTabReady(tab.id);

    const wrappedPrompt = target.wrap(capturedText, options?.sourceLabel || target.defaultSourceLabel);
    let response = await insertAndSubmitInTab(tab.id, wrappedPrompt, { showAlerts: false });

    if (response?.ok && response?.submitted) {
      setStatus(`Sent prompt to ${target.label} in the background.`);
      return;
    }

    await focusTab(tab);
    response = await insertAndSubmitInTab(tab.id, wrappedPrompt, { showAlerts: true });

    if (response?.ok && response?.submitted) {
      setStatus(`Sent prompt to ${target.label}.`);
      return;
    }

    if (response?.ok) {
      setStatus(`Inserted prompt into ${target.label}, but could not auto-send.`);
      return;
    }

    setStatus(`Could not find ${target.label}'s prompt box.`);
  } catch (error) {
    setStatus(`Send failed: ${getErrorMessage(error)}`);
  }
}

async function getActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab || null;
}

async function captureTextFromTab(tab) {
  const response = await sendMessageWithFallback(tab.id, { type: "GET_SELECTION" });
  return response?.text || "";
}

function getOppositeTarget(url) {
  if (url.startsWith("https://chatgpt.com/")) {
    return TARGETS.gemini;
  }

  if (url.startsWith("https://gemini.google.com/")) {
    return TARGETS.chatgpt;
  }

  return null;
}

function getSourceLabel(url) {
  if (url.startsWith("https://chatgpt.com/")) {
    return "ChatGPT";
  }

  if (url.startsWith("https://gemini.google.com/")) {
    return "Gemini";
  }

  return "Christopher";
}

async function findOrCreateTab(target) {
  const tabs = await chrome.tabs.query({ url: target.urlPattern });

  if (tabs.length > 0) {
    return tabs[0];
  }

  return chrome.tabs.create({ url: target.openUrl, active: false });
}

async function focusTab(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  return chrome.tabs.update(tab.id, { active: true });
}

async function waitForTabReady(tabId) {
  const tab = await chrome.tabs.get(tabId);

  if (tab.status === "complete") {
    return;
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(done, 10000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        done();
      }
    }

    function done() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendMessageWithFallback(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function insertAndSubmitInTab(tabId, text, options) {
  return sendMessageWithFallback(tabId, {
    type: "INSERT_TEXT",
    text,
    showAlerts: options?.showAlerts !== false
  });
}

async function openSidePanel() {
  if (!chrome.sidePanel?.open) {
    setStatus("Side panel is not available in this browser.");
    return;
  }

  try {
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: currentWindow.id });
    setStatus("Opened side panel.");
  } catch (error) {
    setStatus(`Could not open side panel: ${getErrorMessage(error)}`);
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function getErrorMessage(error) {
  return error?.message || "Unknown error";
}
