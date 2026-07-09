const STORAGE_KEYS = {
  capturedText: "capturedText",
  turns: "conversationTurns",
  draft: "composerDraft",
  deliveryState: "deliveryState"
};

const MAX_TURNS = 80;

const TARGETS = {
  gemini: {
    urlPattern: "https://gemini.google.com/*",
    openUrl: "https://gemini.google.com/",
    label: "Gemini",
    defaultSourceLabel: "ChatGPT / Lobo",
    instruction: "Gemini, please respond to Christopher and Lobo with an independent second opinion. Challenge assumptions, catch gaps, and suggest practical improvements.",
    wrapTurns: (turnsToSend) => `[Council Bridge]
Sources: ${formatSourceList(turnsToSend)}
Target: Gemini

The following turns happened since Gemini was last advised.

${formatTurnsForPrompt(turnsToSend)}

Gemini, please respond to Christopher and Lobo with an independent second opinion. Challenge assumptions, catch gaps, and suggest practical improvements.`
  },
  chatgpt: {
    urlPattern: "https://chatgpt.com/*",
    openUrl: "https://chatgpt.com/",
    label: "ChatGPT",
    defaultSourceLabel: "Gemini",
    instruction: "Lobo, please respond to Christopher and Gemini. Agree, disagree, refine the plan, and turn it into concrete next steps.",
    wrapTurns: (turnsToSend) => `[Council Bridge]
Sources: ${formatSourceList(turnsToSend)}
Target: ChatGPT / Lobo

The following turns happened since ChatGPT / Lobo was last advised.

${formatTurnsForPrompt(turnsToSend)}

Lobo, please respond to Christopher and Gemini. Agree, disagree, refine the plan, and turn it into concrete next steps.`
  }
};

const turnsEl = document.getElementById("turns");
const statusEl = document.getElementById("status");
const composerTextEl = document.getElementById("composerText");
const passSelectionButton = document.getElementById("passSelection");
const addSelectionButton = document.getElementById("addSelection");
const refreshRepliesButton = document.getElementById("refreshReplies");
const sendComposerToGeminiButton = document.getElementById("sendComposerToGemini");
const sendComposerToBothButton = document.getElementById("sendComposerToBoth");
const sendComposerToChatGPTButton = document.getElementById("sendComposerToChatGPT");
const clearConversationButton = document.getElementById("clearConversation");

let turns = [];
let deliveryState = {
  ChatGPT: 0,
  Gemini: 0
};

document.addEventListener("DOMContentLoaded", loadPanelState);
passSelectionButton.addEventListener("click", passSelectionToOtherAi);
addSelectionButton.addEventListener("click", addSelectionToConversation);
refreshRepliesButton.addEventListener("click", refreshLatestReplies);
sendComposerToGeminiButton.addEventListener("click", () => sendComposerToTarget(TARGETS.gemini));
sendComposerToBothButton.addEventListener("click", sendComposerToBoth);
sendComposerToChatGPTButton.addEventListener("click", () => sendComposerToTarget(TARGETS.chatgpt));
clearConversationButton.addEventListener("click", clearConversation);
composerTextEl.addEventListener("input", saveDraft);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEYS.turns]) {
    if (!changes[STORAGE_KEYS.deliveryState]) {
      return;
    }
  }

  if (changes[STORAGE_KEYS.turns]) {
    turns = changes[STORAGE_KEYS.turns].newValue || [];
  }

  if (changes[STORAGE_KEYS.deliveryState]) {
    deliveryState = normalizeDeliveryState(changes[STORAGE_KEYS.deliveryState].newValue);
  }

  renderTurns();
});

async function loadPanelState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.turns,
    STORAGE_KEYS.draft,
    STORAGE_KEYS.deliveryState
  ]);

  turns = stored[STORAGE_KEYS.turns] || [];
  deliveryState = normalizeDeliveryState(stored[STORAGE_KEYS.deliveryState]);
  composerTextEl.value = stored[STORAGE_KEYS.draft] || "";
  renderTurns();
}

async function passSelectionToOtherAi() {
  try {
    const activeTab = await getActiveTab();
    const source = getSourceFromUrl(activeTab?.url || "");

    if (!source) {
      setStatus("Open ChatGPT or Gemini first.");
      return;
    }

    const selectedText = await captureTextFromTab(activeTab);

    if (!selectedText.trim()) {
      setStatus("No selected text found.");
      return;
    }

    const target = source.label === "ChatGPT" ? TARGETS.gemini : TARGETS.chatgpt;
    await chrome.storage.local.set({ [STORAGE_KEYS.capturedText]: selectedText });
    await appendTurn({
      speaker: source.label,
      text: selectedText,
      target: target.label
    });
    await sendToTarget(target);
  } catch (error) {
    setStatus(`Pass failed: ${getErrorMessage(error)}`);
  }
}

async function addSelectionToConversation() {
  try {
    const activeTab = await getActiveTab();
    const source = getSourceFromUrl(activeTab?.url || "");

    if (!source) {
      setStatus("Open ChatGPT or Gemini first.");
      return;
    }

    const selectedText = await captureTextFromTab(activeTab);

    if (!selectedText.trim()) {
      setStatus("No selected text found.");
      return;
    }

    const added = await appendTurn({
      speaker: source.label,
      text: selectedText,
      target: ""
    });

    setStatus(added ? `Added ${source.label} selection.` : "That reply is already in the conversation.");
  } catch (error) {
    setStatus(`Capture failed: ${getErrorMessage(error)}`);
  }
}

async function refreshLatestReplies() {
  try {
    const results = await Promise.all([
      captureLatestReplyFromTarget(TARGETS.chatgpt),
      captureLatestReplyFromTarget(TARGETS.gemini)
    ]);
    const addedCount = results.filter(Boolean).length;

    if (addedCount === 0) {
      setStatus("No new replies found.");
      return;
    }

    setStatus(`Added ${addedCount} latest repl${addedCount === 1 ? "y" : "ies"}.`);
  } catch (error) {
    setStatus(`Refresh failed: ${getErrorMessage(error)}`);
  }
}

async function captureLatestReplyFromTarget(target) {
  const tabs = await chrome.tabs.query({ url: target.urlPattern });

  if (tabs.length === 0) {
    return false;
  }

  const response = await sendMessageWithFallback(tabs[0].id, { type: "GET_LATEST_REPLY" });
  const text = response?.text || "";

  if (!text.trim()) {
    return false;
  }

  return appendTurn({
    speaker: target.label,
    text,
    target: ""
  });
}

async function sendComposerToTarget(target) {
  const text = composerTextEl.value.trim();

  if (!text) {
    setStatus("Write something first.");
    return;
  }

  try {
    await captureLatestReplyFromTarget(getCounterpartTarget(target));
    await chrome.storage.local.set({
      [STORAGE_KEYS.capturedText]: text,
      [STORAGE_KEYS.draft]: ""
    });
    composerTextEl.value = "";
    await appendTurn({
      speaker: "Christopher",
      text,
      target: target.label
    }, {
      allowDuplicate: true
    });
    await sendToTarget(target);
  } catch (error) {
    setStatus(`Send failed: ${getErrorMessage(error)}`);
  }
}

async function sendComposerToBoth() {
  const text = composerTextEl.value.trim();

  if (!text) {
    setStatus("Write something first.");
    return;
  }

  try {
    await Promise.all([
      captureLatestReplyFromTarget(TARGETS.chatgpt),
      captureLatestReplyFromTarget(TARGETS.gemini)
    ]);
    await chrome.storage.local.set({
      [STORAGE_KEYS.capturedText]: text,
      [STORAGE_KEYS.draft]: ""
    });
    composerTextEl.value = "";
    await appendTurn({
      speaker: "Christopher",
      text,
      target: "Gemini + ChatGPT"
    }, {
      allowDuplicate: true
    });

    const geminiSent = await sendToTarget(TARGETS.gemini);
    const chatgptSent = await sendToTarget(TARGETS.chatgpt);

    if (geminiSent && chatgptSent) {
      setStatus("Sent updates to Gemini and ChatGPT.");
      return;
    }

    if (geminiSent || chatgptSent) {
      setStatus("Sent to one target; check the other tab.");
      return;
    }

    setStatus("Could not send to either target.");
  } catch (error) {
    setStatus(`Send failed: ${getErrorMessage(error)}`);
  }
}

async function sendToTarget(target) {
  const turnsToSend = getUnseenTurnsForTarget(target);

  if (turnsToSend.length === 0) {
    setStatus(`${target.label} is already caught up.`);
    return true;
  }

  const tab = await findOrCreateTab(target);
  await waitForTabReady(tab.id);

  const prompt = target.wrapTurns(turnsToSend);
  let response = await insertPromptInTab(tab.id, prompt, {
    showAlerts: false,
    submit: true
  });

  if (response?.ok && response?.submitted) {
    await markTargetAdvised(target, turnsToSend);
    setStatus(`Sent ${formatTurnCount(turnsToSend.length)} to ${target.label}.`);
    return true;
  }

  await focusTab(tab);
  response = await insertPromptInTab(tab.id, prompt, {
    showAlerts: true,
    submit: true
  });

  if (response?.ok && response?.submitted) {
    await markTargetAdvised(target, turnsToSend);
    setStatus(`Sent ${formatTurnCount(turnsToSend.length)} to ${target.label}.`);
    return true;
  }

  if (response?.ok) {
    setStatus(`Inserted into ${target.label}, but could not click send.`);
    return false;
  }

  setStatus(`Could not find ${target.label}'s prompt box.`);
  return false;
}

async function appendTurn(turn, options = {}) {
  if (!options.allowDuplicate && isDuplicateTurn(turn)) {
    return false;
  }

  const nextTurns = [
    ...turns,
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
      speaker: turn.speaker,
      text: turn.text,
      target: turn.target
    }
  ].slice(-MAX_TURNS);

  turns = nextTurns;
  renderTurns();
  await chrome.storage.local.set({ [STORAGE_KEYS.turns]: nextTurns });
  return true;
}

function getUnseenTurnsForTarget(target) {
  const lastAdvisedAt = deliveryState[target.label] || 0;

  return turns.filter((turn) => {
    return turn.createdAt > lastAdvisedAt && turn.speaker !== target.label;
  });
}

async function markTargetAdvised(target, turnsToSend) {
  const newestTurnAt = Math.max(...turnsToSend.map((turn) => turn.createdAt));
  deliveryState = {
    ...deliveryState,
    [target.label]: newestTurnAt
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.deliveryState]: deliveryState });
}

function normalizeDeliveryState(value) {
  return {
    ChatGPT: Number(value?.ChatGPT) || 0,
    Gemini: Number(value?.Gemini) || 0
  };
}

function getCounterpartTarget(target) {
  return target.label === "Gemini" ? TARGETS.chatgpt : TARGETS.gemini;
}

function formatTurnCount(count) {
  return `${count} update${count === 1 ? "" : "s"}`;
}

function formatSourceList(turnsToSend) {
  const sourceLabels = Array.from(new Set(turnsToSend.map((turn) => getPromptSpeaker(turn.speaker).source)));
  return sourceLabels.join(", ");
}

function formatTurnsForPrompt(turnsToSend) {
  return turnsToSend.map(formatTurnForPrompt).join("\n\n");
}

function formatTurnForPrompt(turn) {
  const speaker = getPromptSpeaker(turn.speaker);

  return `${speaker.saidLine}:

--- BEGIN ${speaker.blockLabel} MESSAGE ---
${turn.text}
--- END ${speaker.blockLabel} MESSAGE ---`;
}

function getPromptSpeaker(speaker) {
  if (speaker === "ChatGPT") {
    return {
      source: "ChatGPT / Lobo",
      saidLine: "Lobo said",
      blockLabel: "LOBO"
    };
  }

  if (speaker === "Gemini") {
    return {
      source: "Gemini",
      saidLine: "Gemini said",
      blockLabel: "GEMINI"
    };
  }

  return {
    source: "Christopher",
    saidLine: "Christopher said",
    blockLabel: "CHRISTOPHER"
  };
}

function isDuplicateTurn(turn) {
  const normalizedText = normalizeText(turn.text);

  return turns.some((existingTurn) => {
    return existingTurn.speaker === turn.speaker && normalizeText(existingTurn.text) === normalizedText;
  });
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function renderTurns() {
  turnsEl.replaceChildren();

  if (turns.length === 0) {
    const emptyEl = document.createElement("p");
    emptyEl.className = "empty";
    emptyEl.textContent = "No turns yet. Highlight a response or write as Christopher.";
    turnsEl.append(emptyEl);
    return;
  }

  for (const turn of turns) {
    const turnEl = document.createElement("article");
    turnEl.className = `turn ${turn.speaker.toLowerCase()}`;

    const metaEl = document.createElement("div");
    metaEl.className = "turn-meta";

    const speakerEl = document.createElement("span");
    speakerEl.className = "speaker";
    speakerEl.textContent = `${turn.speaker}:`;

    const targetEl = document.createElement("span");
    targetEl.textContent = turn.target ? `to ${turn.target}` : "";

    const textEl = document.createElement("p");
    textEl.className = "turn-text";
    textEl.textContent = turn.text;

    metaEl.append(speakerEl, targetEl);
    turnEl.append(metaEl, textEl);
    turnsEl.append(turnEl);
  }

  turnsEl.scrollTop = turnsEl.scrollHeight;
}

async function clearConversation() {
  if (!window.confirm("Clear the Council Bridge conversation view?")) {
    return;
  }

  turns = [];
  deliveryState = normalizeDeliveryState();
  renderTurns();
  await chrome.storage.local.set({
    [STORAGE_KEYS.turns]: [],
    [STORAGE_KEYS.deliveryState]: deliveryState
  });
  setStatus("Conversation cleared.");
}

async function saveDraft() {
  await chrome.storage.local.set({ [STORAGE_KEYS.draft]: composerTextEl.value });
}

async function getActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab || null;
}

async function captureTextFromTab(tab) {
  const response = await sendMessageWithFallback(tab.id, { type: "GET_SELECTION" });
  return response?.text || "";
}

function getSourceFromUrl(url) {
  if (url.startsWith("https://chatgpt.com/")) {
    return { label: "ChatGPT", promptLabel: "ChatGPT / Lobo" };
  }

  if (url.startsWith("https://gemini.google.com/")) {
    return { label: "Gemini", promptLabel: "Gemini" };
  }

  return null;
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

function insertPromptInTab(tabId, text, options) {
  return sendMessageWithFallback(tabId, {
    type: "INSERT_TEXT",
    text,
    showAlerts: options?.showAlerts !== false,
    submit: options?.submit === true
  });
}

function setStatus(message) {
  statusEl.textContent = message;
}

function getErrorMessage(error) {
  return error?.message || "Unknown error";
}
