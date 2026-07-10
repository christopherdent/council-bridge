const STORAGE_KEYS = {
  capturedText: "capturedText",
  turns: "conversationTurns",
  draft: "composerDraft",
  deliveryState: "deliveryState",
  session: "councilSession"
};

const MAX_TURNS = 80;
const REPLY_WATCH_INTERVAL_MS = 1000;
const REPLY_WATCH_STABLE_MS = 2000;
const REPLY_WATCH_TIMEOUT_MS = 120000;
const REPLY_WATCH_MIN_LENGTH = 20;

const TARGETS = {
  gemini: {
    key: "gemini",
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
    key: "chatgpt",
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
const sendComposerButton = document.getElementById("sendComposer");
const clearConversationButton = document.getElementById("clearConversation");
const sessionSummaryEl = document.getElementById("sessionSummary");
const setActiveAsChatGPTButton = document.getElementById("setActiveAsChatGPT");
const setActiveAsGeminiButton = document.getElementById("setActiveAsGemini");
const removeActiveFromCouncilButton = document.getElementById("removeActiveFromCouncil");
const toggleCapturePauseButton = document.getElementById("toggleCapturePause");

let turns = [];
let deliveryState = {
  ChatGPT: 0,
  Gemini: 0
};
let councilSession = normalizeCouncilSession();
const replyWatchers = new Map();

document.addEventListener("DOMContentLoaded", loadPanelState);
passSelectionButton.addEventListener("click", passSelectionToOtherAi);
addSelectionButton.addEventListener("click", addSelectionToConversation);
refreshRepliesButton.addEventListener("click", refreshLatestReplies);
sendComposerButton.addEventListener("click", sendComposer);
clearConversationButton.addEventListener("click", clearConversation);
setActiveAsChatGPTButton.addEventListener("click", () => setActiveTabAsCouncilMember(TARGETS.chatgpt));
setActiveAsGeminiButton.addEventListener("click", () => setActiveTabAsCouncilMember(TARGETS.gemini));
removeActiveFromCouncilButton.addEventListener("click", removeActiveTabFromCouncil);
toggleCapturePauseButton.addEventListener("click", toggleCapturePause);
composerTextEl.addEventListener("input", saveDraft);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (!changes[STORAGE_KEYS.turns] && !changes[STORAGE_KEYS.deliveryState] && !changes[STORAGE_KEYS.session]) {
    return;
  }

  if (changes[STORAGE_KEYS.turns]) {
    turns = changes[STORAGE_KEYS.turns].newValue || [];
  }

  if (changes[STORAGE_KEYS.deliveryState]) {
    deliveryState = normalizeDeliveryState(changes[STORAGE_KEYS.deliveryState].newValue);
  }

  if (changes[STORAGE_KEYS.session]) {
    councilSession = normalizeCouncilSession(changes[STORAGE_KEYS.session].newValue);
  }

  renderTurns();
  renderCouncilSession();
});

async function loadPanelState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.turns,
    STORAGE_KEYS.draft,
    STORAGE_KEYS.deliveryState,
    STORAGE_KEYS.session
  ]);

  turns = stored[STORAGE_KEYS.turns] || [];
  deliveryState = normalizeDeliveryState(stored[STORAGE_KEYS.deliveryState]);
  councilSession = normalizeCouncilSession(stored[STORAGE_KEYS.session]);
  composerTextEl.value = stored[STORAGE_KEYS.draft] || "";
  renderTurns();
  renderCouncilSession();
}

async function passSelectionToOtherAi() {
  try {
    const activeTab = await getActiveTab();
    const source = getCouncilSourceFromTab(activeTab);

    if (!source) {
      setStatus("Assign this ChatGPT or Gemini tab to the council first.");
      return;
    }

    const selectedText = await captureTextFromTab(activeTab);

    if (!selectedText.trim()) {
      setStatus("No selected text found.");
      return;
    }

    const target = source.key === "chatgpt" ? TARGETS.gemini : TARGETS.chatgpt;
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
    const source = getCouncilSourceFromTab(activeTab);

    if (!source) {
      setStatus("Assign this ChatGPT or Gemini tab to the council first.");
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
  if (councilSession.paused) {
    return false;
  }

  const text = await getLatestReplyTextFromTarget(target);

  if (!text.trim()) {
    return false;
  }

  return appendTurn({
    speaker: target.label,
    text,
    target: ""
  });
}

async function sendComposer() {
  const route = parseComposerRoute(composerTextEl.value);

  if (!route.text) {
    setStatus("Write something first.");
    return;
  }

  if (route.targets.length === 1) {
    await sendComposerToTarget(route.targets[0], route.text);
    return;
  }

  await sendComposerToBoth(route.text);
}

async function sendComposerToTarget(target, text) {
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

async function sendComposerToBoth(text) {
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

function parseComposerRoute(rawText) {
  let remainingText = rawText.trimStart();
  const targets = new Set();

  while (true) {
    const tagMatch = remainingText.match(/^@([a-z0-9_-]+)[,:;.!?]?(?=\s|$)/i);

    if (!tagMatch) {
      break;
    }

    const target = getTargetFromComposerTag(tagMatch[0]);

    if (!target) {
      break;
    }

    if (target === "both") {
      targets.add(TARGETS.gemini);
      targets.add(TARGETS.chatgpt);
    } else {
      targets.add(target);
    }

    remainingText = remainingText.slice(tagMatch[0].length).trimStart();
  }

  return {
    text: targets.size > 0 ? remainingText.trim() : rawText.trim(),
    targets: targets.size > 0 ? Array.from(targets) : [TARGETS.gemini, TARGETS.chatgpt]
  };
}

function getTargetFromComposerTag(tag) {
  const normalized = tag.toLowerCase().replace(/[,:;.!?]+$/g, "");

  if (["@gemini", "@gem"].includes(normalized)) {
    return TARGETS.gemini;
  }

  if (["@lobo", "@chatgpt", "@gpt"].includes(normalized)) {
    return TARGETS.chatgpt;
  }

  if (["@both", "@council", "@all"].includes(normalized)) {
    return "both";
  }

  return null;
}

async function sendToTarget(target) {
  const turnsToSend = getUnseenTurnsForTarget(target);
  const tab = await getCouncilTabForTarget(target);

  if (!tab) {
    setStatus(`Set a council tab for ${target.label} first.`);
    return false;
  }

  if (turnsToSend.length === 0) {
    setStatus(`${target.label} is already caught up.`);
    return true;
  }

  const latestReplyBeforeSend = await getLatestReplyTextFromTarget(target).catch(() => "");
  await waitForTabReady(tab.id);

  const prompt = target.wrapTurns(turnsToSend);
  let response = await insertPromptInTab(tab.id, prompt, {
    showAlerts: false,
    submit: true
  });

  if (response?.ok && response?.submitted) {
    await markTargetAdvised(target, turnsToSend);
    if (!councilSession.paused) {
      startReplyWatcher(target, latestReplyBeforeSend);
    }
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
    if (!councilSession.paused) {
      startReplyWatcher(target, latestReplyBeforeSend);
    }
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

  const createdAt = Date.now();
  const nextTurns = [
    ...turns,
    {
      id: `${createdAt}-${Math.random().toString(16).slice(2)}`,
      createdAt,
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

function startReplyWatcher(target, baselineText) {
  stopReplyWatcher(target.label);

  const watcher = {
    baselineSignature: getReplySignature(baselineText),
    candidateSignature: "",
    candidateText: "",
    candidateSince: 0,
    startedAt: Date.now(),
    timeoutId: null
  };

  replyWatchers.set(target.label, watcher);

  async function tick() {
    if (replyWatchers.get(target.label) !== watcher) {
      return;
    }

    if (Date.now() - watcher.startedAt > REPLY_WATCH_TIMEOUT_MS) {
      stopReplyWatcher(target.label);
      return;
    }

    try {
      const text = await getLatestReplyTextFromTarget(target);
      const signature = getReplySignature(text);
      const duplicate = isDuplicateTurn({ speaker: target.label, text });

      if (
        text.length >= REPLY_WATCH_MIN_LENGTH &&
        signature &&
        signature !== watcher.baselineSignature
      ) {
        if (duplicate) {
          stopReplyWatcher(target.label);
          return;
        }

        if (signature !== watcher.candidateSignature) {
          watcher.candidateSignature = signature;
          watcher.candidateText = text;
          watcher.candidateSince = Date.now();
        } else if (Date.now() - watcher.candidateSince >= REPLY_WATCH_STABLE_MS) {
          const added = await appendTurn({
            speaker: target.label,
            text: watcher.candidateText,
            target: ""
          });
          stopReplyWatcher(target.label);

          if (added) {
            setStatus(`Added completed ${target.label} reply.`);
          }
          return;
        }
      }
    } catch (error) {
      // The target tab may still be loading or throttled; keep watching until timeout.
    }

    watcher.timeoutId = window.setTimeout(tick, REPLY_WATCH_INTERVAL_MS);
  }

  watcher.timeoutId = window.setTimeout(tick, REPLY_WATCH_INTERVAL_MS);
}

function stopReplyWatcher(label) {
  const watcher = replyWatchers.get(label);

  if (watcher?.timeoutId) {
    window.clearTimeout(watcher.timeoutId);
  }

  replyWatchers.delete(label);
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

  return `Timestamp: ${formatTimestampForPrompt(turn.createdAt)}
${speaker.saidLine}:

--- BEGIN ${speaker.blockLabel} MESSAGE ---
${turn.text}
--- END ${speaker.blockLabel} MESSAGE ---`;
}

function formatTimestampForPrompt(value) {
  return new Date(normalizeTimestamp(value)).toISOString();
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

function getReplySignature(text) {
  return normalizeText(text);
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

    const timeEl = document.createElement("time");
    timeEl.className = "timestamp";
    timeEl.dateTime = formatTimestampForPrompt(turn.createdAt);
    timeEl.title = timeEl.dateTime;
    timeEl.textContent = formatTimestampForDisplay(turn.createdAt);

    const detailsEl = document.createElement("span");
    detailsEl.className = "turn-details";
    if (turn.target) {
      detailsEl.append(targetEl);
    }
    detailsEl.append(timeEl);

    const textEl = document.createElement("p");
    textEl.className = "turn-text";
    textEl.textContent = turn.text;

    metaEl.append(speakerEl, detailsEl);
    turnEl.append(metaEl, textEl);
    turnsEl.append(turnEl);
  }

  turnsEl.scrollTop = turnsEl.scrollHeight;
}

function formatTimestampForDisplay(value) {
  const date = new Date(normalizeTimestamp(value));
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1, 2);
  const day = padDatePart(date.getDate(), 2);
  const hours = padDatePart(date.getHours(), 2);
  const minutes = padDatePart(date.getMinutes(), 2);
  const seconds = padDatePart(date.getSeconds(), 2);
  const milliseconds = padDatePart(date.getMilliseconds(), 3);

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

function padDatePart(value, length) {
  return String(value).padStart(length, "0");
}

function normalizeCouncilSession(value) {
  const createdAt = normalizeTimestamp(value?.createdAt);

  return {
    sessionId: value?.sessionId || `council_${createdAt}`,
    title: value?.title || "Council Bridge",
    createdAt,
    paused: Boolean(value?.paused),
    members: {
      chatgpt: normalizeCouncilMember(value?.members?.chatgpt, "chatgpt"),
      gemini: normalizeCouncilMember(value?.members?.gemini, "gemini")
    }
  };
}

function normalizeCouncilMember(member, key) {
  const conversationId = member?.conversationId || extractConversationId(member?.url || "", key);

  if (!member || !conversationId) {
    return null;
  }

  return {
    conversationId,
    currentTabId: Number.isInteger(member.currentTabId) ? member.currentTabId : member.tabId,
    currentWindowId: Number.isInteger(member.currentWindowId) ? member.currentWindowId : member.windowId,
    url: member.url || "",
    displayName: member.displayName || "",
    role: member.role || "agent",
    status: member.status || "connected",
    assignedAt: Number(member.assignedAt) || Date.now()
  };
}

async function setActiveTabAsCouncilMember(target) {
  const activeTab = await getActiveTab();

  if (!activeTab?.id || !activeTab.url?.startsWith(target.openUrl)) {
    setStatus(`Open the ${target.label} tab you want in the council first.`);
    return;
  }

  const conversationId = extractConversationId(activeTab.url, target.key);

  if (!conversationId) {
    setStatus(`${target.label} needs an active conversation URL before it can join the council.`);
    return;
  }

  councilSession = {
    ...councilSession,
    members: {
      ...councilSession.members,
      [target.key]: {
        conversationId,
        currentTabId: activeTab.id,
        currentWindowId: activeTab.windowId,
        url: activeTab.url,
        displayName: target.label,
        role: "agent",
        status: "connected",
        assignedAt: Date.now()
      }
    }
  };

  await saveCouncilSession();
  setStatus(`Set this tab as ${target.label}.`);
}

async function removeActiveTabFromCouncil() {
  const activeTab = await getActiveTab();
  const memberKey = getCouncilMemberKeyForTab(activeTab, { allowStale: true });

  if (!memberKey) {
    setStatus("This tab is not in the active council.");
    return;
  }

  stopReplyWatcher(TARGETS[memberKey].label);
  councilSession = {
    ...councilSession,
    members: {
      ...councilSession.members,
      [memberKey]: null
    }
  };

  await saveCouncilSession();
  setStatus(`Removed ${TARGETS[memberKey].label} from the council.`);
}

async function toggleCapturePause() {
  councilSession = {
    ...councilSession,
    paused: !councilSession.paused
  };

  if (councilSession.paused) {
    for (const label of Array.from(replyWatchers.keys())) {
      stopReplyWatcher(label);
    }
  }

  await saveCouncilSession();
  setStatus(councilSession.paused ? "Capture paused." : "Capture resumed.");
}

async function saveCouncilSession() {
  councilSession = normalizeCouncilSession(councilSession);
  await chrome.storage.local.set({ [STORAGE_KEYS.session]: councilSession });
  renderCouncilSession();
}

function renderCouncilSession() {
  const lobo = formatCouncilMember(councilSession.members.chatgpt, "not set");
  const gemini = formatCouncilMember(councilSession.members.gemini, "not set");
  const state = councilSession.paused ? "paused" : "active";

  sessionSummaryEl.textContent = `Council capture: ${state}
Lobo: ${lobo}
Gemini: ${gemini}`;
  toggleCapturePauseButton.textContent = councilSession.paused ? "Resume capture" : "Pause capture";
}

function formatCouncilMember(member, fallback) {
  if (!member) {
    return fallback;
  }

  return `${member.status}; ${shortenId(member.conversationId)}; tab ${member.currentTabId || "?"}`;
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

async function getLatestReplyTextFromTarget(target) {
  const tab = await getCouncilTabForTarget(target);

  if (!tab) {
    return "";
  }

  const response = await sendMessageWithFallback(tab.id, { type: "GET_LATEST_REPLY" });
  return response?.text || "";
}

function getCouncilSourceFromTab(tab) {
  const memberKey = getCouncilMemberKeyForTab(tab);

  if (!memberKey) {
    return null;
  }

  const target = TARGETS[memberKey];
  return { key: target.key, label: target.label };
}

function getCouncilMemberKeyForTab(tab, options = {}) {
  if (!tab?.id || !tab.url) {
    return "";
  }

  return Object.keys(TARGETS).find((key) => {
    const member = councilSession.members[key];
    return tabMatchesCouncilMember(tab, member, TARGETS[key], {
      allowRoutingMismatch: true,
      allowStale: options.allowStale === true
    });
  }) || "";
}

async function getCouncilTabForTarget(target) {
  const member = councilSession.members[target.key];

  if (!member) {
    return null;
  }

  try {
    if (member.status !== "stale" && Number.isInteger(member.currentTabId)) {
      const tab = await chrome.tabs.get(member.currentTabId);

      if (tabMatchesCouncilMember(tab, member, target)) {
        return tab;
      }

      await markMemberStaleIfNavigatedOut(target, tab);
    }
  } catch (error) {
    // The stored routing tab may be gone; scan open tabs below and auto-heal if possible.
  }

  return healCouncilMemberFromOpenTabs(target, member);
}

function tabMatchesCouncilMember(tab, member, target, options = {}) {
  const conversationId = extractConversationId(tab?.url || "", target.key);

  return (
    Boolean(tab?.id) &&
    Boolean(member) &&
    (options.allowStale || member.status !== "stale") &&
    tab.url?.startsWith(target.openUrl) &&
    conversationId &&
    conversationId === member.conversationId &&
    (
      options.allowRoutingMismatch ||
      (tab.id === member.currentTabId && tab.windowId === member.currentWindowId)
    )
  );
}

async function healCouncilMemberFromOpenTabs(target, member) {
  const tabs = await chrome.tabs.query({ url: target.urlPattern });
  const matchingTab = tabs.find((tab) => tabMatchesCouncilMember(tab, member, target, {
    allowRoutingMismatch: true,
    allowStale: true
  }));

  if (!matchingTab) {
    return null;
  }

  councilSession = {
    ...councilSession,
    members: {
      ...councilSession.members,
      [target.key]: {
        ...member,
        currentTabId: matchingTab.id,
        currentWindowId: matchingTab.windowId,
        url: matchingTab.url,
        status: "connected"
      }
    }
  };
  await saveCouncilSession();
  console.info(`[CouncilBridge][SESSION_AUTO_HEALED] role=${target.key} newTabId=${matchingTab.id}`);

  return matchingTab;
}

async function markMemberStaleIfNavigatedOut(target, tab) {
  const member = councilSession.members[target.key];

  if (!member || !tab?.url?.startsWith(target.openUrl)) {
    return;
  }

  const conversationId = extractConversationId(tab.url, target.key);

  if (conversationId !== member.conversationId) {
    councilSession = {
      ...councilSession,
      members: {
        ...councilSession.members,
        [target.key]: {
          ...member,
          status: "stale",
          url: tab.url,
          currentTabId: tab.id,
          currentWindowId: tab.windowId
        }
      }
    };
    await saveCouncilSession();
    console.info(`[CouncilBridge][TAB_NAVIGATED_OUT] role=${target.key} tabId=${tab.id}`);
  }
}

function extractConversationId(url, key) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (key === "chatgpt" && pathParts[0] === "c" && pathParts[1]) {
      return pathParts[1];
    }

    if (key === "gemini" && pathParts[0] === "app" && pathParts[1]) {
      return pathParts[1];
    }

    return "";
  } catch (error) {
    return "";
  }
}

function shortenId(value) {
  if (!value) {
    return "no conversation";
  }

  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
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

async function insertPromptInTab(tabId, text, options) {
  const wakeResponse = await wakeTabForInjection(tabId);

  try {
    let response = await sendMessageWithFallback(tabId, {
      type: "INSERT_TEXT",
      text,
      showAlerts: options?.showAlerts !== false,
      submit: options?.submit === true
    });

    if (response?.ok) {
      return response;
    }

    await delay(250);
    return sendMessageWithFallback(tabId, {
      type: "INSERT_TEXT",
      text,
      showAlerts: options?.showAlerts !== false,
      submit: options?.submit === true
    });
  } finally {
    if (wakeResponse?.previousTabId && wakeResponse.previousTabId !== tabId) {
      await restoreTabAfterInjection(wakeResponse.previousTabId);
    }
  }
}

async function wakeTabForInjection(tabId) {
  const response = await chrome.runtime.sendMessage({
    type: "WAKE_TAB_FOR_INJECTION",
    tabId
  });

  if (response?.ok === false) {
    console.warn(`[CouncilBridge][WAKE_TAB_FAILED] tabId=${tabId} error=${response.error || "Unknown error"}`);
  }

  return response;
}

async function restoreTabAfterInjection(tabId) {
  const response = await chrome.runtime.sendMessage({
    type: "RESTORE_TAB_AFTER_INJECTION",
    tabId
  });

  if (response?.ok === false) {
    console.warn(`[CouncilBridge][RESTORE_TAB_FAILED] tabId=${tabId} error=${response.error || "Unknown error"}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function setStatus(message) {
  statusEl.textContent = message;
}

function getErrorMessage(error) {
  return error?.message || "Unknown error";
}
