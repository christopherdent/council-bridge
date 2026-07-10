const STORAGE_KEYS = {
  capturedText: "capturedText",
  turns: "conversationTurns",
  draft: "composerDraft",
  deliveryState: "deliveryState",
  session: "councilSession"
};

const MAX_TURNS = 80;
const REPLY_WATCH_INTERVAL_MS = 500;
const REPLY_WATCH_STABLE_MS = 2000;
const STREAM_CONFIRMED_STABLE_MS = 1200;
const REPLY_WATCH_TIMEOUT_MS = 120000;
const REPLY_WATCH_MIN_LENGTH = 20;
const BACKGROUND_SUBMIT_ACTIVE_HOLD_MS = 900;
const PENDING_CONVERSATION_PREFIX = "pending";

const TARGETS = {
  gemini: {
    key: "gemini",
    urlPattern: "https://gemini.google.com/*",
    openUrl: "https://gemini.google.com/",
    label: "Gemini",
    defaultNickname: "Gemini",
    defaultSourceLabel: "ChatGPT",
    instruction: "Gemini, please respond to Christopher and ChatGPT with an independent second opinion. Challenge assumptions, catch gaps, and suggest practical improvements.",
    wrapTurns: (turnsToSend, options = {}) => {
      const targetName = getAgentName(TARGETS.gemini);
      const chatgptName = getAgentName(TARGETS.chatgpt);

      return `[Council Bridge]
${options.includeCouncilOverview ? `${formatCouncilOverview(targetName)}\n\n` : ""}Sources: ${formatSourceList(turnsToSend)}
Target: ${targetName}

The following turns happened since ${targetName} was last advised.

${formatTurnsForPrompt(turnsToSend)}

${targetName}, please respond to Christopher and ${chatgptName} with an independent second opinion. Challenge assumptions, catch gaps, and suggest practical improvements.`;
    }
  },
  chatgpt: {
    key: "chatgpt",
    urlPattern: "https://chatgpt.com/*",
    openUrl: "https://chatgpt.com/",
    label: "ChatGPT",
    defaultNickname: "ChatGPT",
    defaultSourceLabel: "Gemini",
    instruction: "ChatGPT, please respond to Christopher and Gemini. Agree, disagree, refine the plan, and turn it into concrete next steps.",
    wrapTurns: (turnsToSend, options = {}) => {
      const targetName = getAgentName(TARGETS.chatgpt);
      const geminiName = getAgentName(TARGETS.gemini);

      return `[Council Bridge]
${options.includeCouncilOverview ? `${formatCouncilOverview(targetName)}\n\n` : ""}Sources: ${formatSourceList(turnsToSend)}
Target: ${targetName}

The following turns happened since ${targetName} was last advised.

${formatTurnsForPrompt(turnsToSend)}

${targetName}, please respond to Christopher and ${geminiName}. Agree, disagree, refine the plan, and turn it into concrete next steps.`;
    }
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
const chatgptNicknameEl = document.getElementById("chatgptNickname");
const geminiNicknameEl = document.getElementById("geminiNickname");
const handoffPanelEl = document.getElementById("handoffPanel");
const handoffNoticeEl = document.getElementById("handoffNotice");
const approveHandoffButton = document.getElementById("approveHandoff");
const rejectHandoffButton = document.getElementById("rejectHandoff");
const approveOneHandoffButton = document.getElementById("approveOneHandoff");
const approveThreeHandoffsButton = document.getElementById("approveThreeHandoffs");

let turns = [];
let deliveryState = {
  ChatGPT: 0,
  Gemini: 0
};
let councilSession = normalizeCouncilSession();
const replyWatchers = new Map();
let deliveryWriteQueue = Promise.resolve();

let renderedTurnIds = new Set();

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
chatgptNicknameEl.addEventListener("change", () => saveNickname(TARGETS.chatgpt, chatgptNicknameEl.value));
geminiNicknameEl.addEventListener("change", () => saveNickname(TARGETS.gemini, geminiNicknameEl.value));
approveHandoffButton.addEventListener("click", () => approvePendingHandoff(0));
rejectHandoffButton.addEventListener("click", rejectPendingHandoff);
approveOneHandoffButton.addEventListener("click", () => approvePendingHandoff(1));
approveThreeHandoffsButton.addEventListener("click", () => approvePendingHandoff(3));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (!changes[STORAGE_KEYS.turns] && !changes[STORAGE_KEYS.deliveryState] && !changes[STORAGE_KEYS.session]) {
    return;
  }

  let addedTurns = [];

  if (changes[STORAGE_KEYS.turns]) {
    const previousTurns = changes[STORAGE_KEYS.turns].oldValue || [];
    turns = changes[STORAGE_KEYS.turns].newValue || [];
    addedTurns = getAddedTurns(previousTurns, turns);
  }

  if (changes[STORAGE_KEYS.deliveryState]) {
    deliveryState = normalizeDeliveryState(changes[STORAGE_KEYS.deliveryState].newValue);
  }

  if (changes[STORAGE_KEYS.session]) {
    councilSession = normalizeCouncilSession(changes[STORAGE_KEYS.session].newValue);
  }

  reconcileRenderedTurns();
  renderCouncilSession();
  renderHandoffPanel();

  for (const turn of addedTurns) {
    detectBotHandoffForTurn(turn);
  }
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
  revealAllTurnsImmediately();
  renderCouncilSession();
  renderHandoffPanel();
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
      target: getAgentName(target)
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
      target: getAgentName(target)
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
      target: `${getAgentName(TARGETS.gemini)} + ${getAgentName(TARGETS.chatgpt)}`
    }, {
      allowDuplicate: true
    });

    const [geminiSent, chatgptSent] = await Promise.all([
      sendToTarget(TARGETS.gemini),
      sendToTarget(TARGETS.chatgpt)
    ]);

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
    text: rawText.trim(),
    targets: targets.size > 0 ? Array.from(targets) : [TARGETS.gemini, TARGETS.chatgpt]
  };
}

function getTargetFromComposerTag(tag) {
  const normalized = normalizeTagAlias(tag);

  if (["gemini", "gem", normalizeTagAlias(getAgentName(TARGETS.gemini))].includes(normalized)) {
    return TARGETS.gemini;
  }

  if (["lobo", "chatgpt", "gpt", normalizeTagAlias(getAgentName(TARGETS.chatgpt))].includes(normalized)) {
    return TARGETS.chatgpt;
  }

  if (["both", "council", "all"].includes(normalized)) {
    return "both";
  }

  return null;
}

function normalizeTagAlias(value) {
  return String(value || "").toLowerCase().replace(/^@/, "").replace(/[,:;.!?]+$/g, "").replace(/[^a-z0-9_-]+/g, "");
}

async function sendToTarget(target) {
  const turnsToSend = getUnseenTurnsForTarget(target);
  const tab = await getCouncilTabForTarget(target);

  if (!tab) {
    setStatus(`Set a council tab for ${getAgentName(target)} first.`);
    return false;
  }

  if (turnsToSend.length === 0) {
    setStatus(`${getAgentName(target)} is already caught up.`);
    return true;
  }

  await waitForTabReady(tab.id);

  const latestReplyBeforeSend = await getLatestReplyTextFromTarget(target).catch(() => "");
  const prompt = target.wrapTurns(turnsToSend, {
    includeCouncilOverview: !hasTargetBeenAdvised(target)
  });
  let response = await insertPromptInTab(tab.id, prompt, {
    showAlerts: false,
    submit: true
  });

  if (response?.ok && response?.submitted) {
    await markTargetAdvised(target, turnsToSend);
    if (!councilSession.paused) {
      startReplyWatcher(target, latestReplyBeforeSend);
    }
    setStatus(`Sent ${formatTurnCount(turnsToSend.length)} to ${getAgentName(target)}.`);
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
    setStatus(`Sent ${formatTurnCount(turnsToSend.length)} to ${getAgentName(target)}.`);
    return true;
  }

  if (response?.ok) {
    setStatus(`Inserted into ${getAgentName(target)}, but could not click send.`);
    return false;
  }

  setStatus(`Could not find ${getAgentName(target)}'s prompt box.`);
  return false;
}

async function appendTurn(turn, options = {}) {
  if (!options.allowDuplicate && isDuplicateTurn(turn)) {
    return false;
  }

  if (turn.speaker === "Christopher") {
    await resetBotToBotTurnCount();
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
  reconcileRenderedTurns();
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
    candidateConfirmedNotStreaming: false,
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
      const { text, isStreaming } = await getLatestReplyStateFromTarget(target);
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
          watcher.candidateConfirmedNotStreaming = !isStreaming;
        } else {
          if (!isStreaming) {
            watcher.candidateConfirmedNotStreaming = true;
          }

          const requiredStableMs = watcher.candidateConfirmedNotStreaming
            ? STREAM_CONFIRMED_STABLE_MS
            : REPLY_WATCH_STABLE_MS;

          if (Date.now() - watcher.candidateSince >= requiredStableMs) {
            const committed = await commitWatcherReply(target, watcher.candidateText);

            if (committed) {
              stopReplyWatcher(target.label);
              setStatus(`Captured completed ${target.label} reply.`);
              return;
            }

            watcher.candidateSince = Date.now();
          }
        }
      }
    } catch (error) {
      // The target tab may still be loading or throttled; keep watching until timeout.
    }

    watcher.timeoutId = window.setTimeout(tick, REPLY_WATCH_INTERVAL_MS);
  }

  watcher.timeoutId = window.setTimeout(tick, REPLY_WATCH_INTERVAL_MS);
}

async function commitWatcherReply(target, text) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "WATCHER_REPLY_READY",
      targetKey: target.key,
      speaker: target.label,
      text,
      completedAt: Date.now()
    });

    if (response?.ok) {
      return true;
    }

    console.warn(`[CouncilBridge][WATCHER_COMMIT_FAILED] target=${target.key} error=${response?.error || "Unknown error"}`);
    return false;
  } catch (error) {
    console.warn(`[CouncilBridge][WATCHER_COMMIT_FAILED] target=${target.key} error=${getErrorMessage(error)}`);
    return false;
  }
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

function hasTargetBeenAdvised(target) {
  return (deliveryState[target.label] || 0) > 0;
}

async function markTargetAdvised(target, turnsToSend) {
  const newestTurnAt = Math.max(...turnsToSend.map((turn) => turn.createdAt));
  deliveryState = {
    ...deliveryState,
    [target.label]: newestTurnAt
  };

  deliveryWriteQueue = deliveryWriteQueue.then(() =>
    chrome.storage.local.set({ [STORAGE_KEYS.deliveryState]: deliveryState })
  );
  await deliveryWriteQueue;
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

function getAgentName(target) {
  const member = councilSession.members[target.key];
  return member?.nickname || councilSession.nicknames?.[target.key] || member?.displayName || target.defaultNickname || target.label;
}

function formatTurnCount(count) {
  return `${count} update${count === 1 ? "" : "s"}`;
}

function formatSourceList(turnsToSend) {
  const sourceLabels = Array.from(new Set(turnsToSend.map((turn) => getPromptSpeaker(turn.speaker).source)));
  return sourceLabels.join(", ");
}

function formatCouncilOverview(targetName) {
  const chatgptName = getAgentName(TARGETS.chatgpt);
  const geminiName = getAgentName(TARGETS.gemini);

  return `Council overview: Council Bridge is Christopher's browser side panel for coordinating ${chatgptName} and ${geminiName}. Project README: https://github.com/christopherdent/council-bridge/blob/main/README.md

Christopher writes or captures turns, then Council Bridge forwards the new turns to the other council member.

Routing notes: leading tags such as @chatgpt, @gpt, @lobo, @gemini, @gem, @both, @all, or nickname tags are routing hints for Council Bridge. Treat them as conversation context, not as a claim that you cannot participate.

Context note for ${targetName}: this may be a fresh browser conversation. Search or use any conversation history available to you for relevant context, then continue from the included turns.`;
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
    const name = getAgentName(TARGETS.chatgpt);

    return {
      source: name,
      saidLine: `${name} said`,
      blockLabel: normalizeBlockLabel(name)
    };
  }

  if (speaker === "Gemini") {
    const name = getAgentName(TARGETS.gemini);

    return {
      source: name,
      saidLine: `${name} said`,
      blockLabel: normalizeBlockLabel(name)
    };
  }

  return {
    source: "Christopher",
    saidLine: "Christopher said",
    blockLabel: "CHRISTOPHER"
  };
}

function normalizeBlockLabel(value) {
  const label = value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return label || "AGENT";
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

function reconcileRenderedTurns() {
  revealAllTurnsImmediately();
}

function revealAllTurnsImmediately() {
  renderedTurnIds = new Set(turns.map((turn) => turn.id));
  renderTurns();
}

function renderTurns() {
  turnsEl.replaceChildren();

  const visibleTurns = turns.filter((turn) => renderedTurnIds.has(turn.id));

  if (turns.length === 0) {
    const emptyEl = document.createElement("p");
    emptyEl.className = "empty";
    emptyEl.textContent = "No turns yet. Highlight a response or write as Christopher.";
    turnsEl.append(emptyEl);
    return;
  }

  for (const turn of visibleTurns) {
    const turnEl = document.createElement("article");
    turnEl.className = `turn ${turn.speaker.toLowerCase()}`;

    const metaEl = document.createElement("div");
    metaEl.className = "turn-meta";

    const speakerEl = document.createElement("span");
    speakerEl.className = "speaker";
    speakerEl.textContent = `${getTurnSpeakerDisplayName(turn.speaker)}:`;

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

function getTurnSpeakerDisplayName(speaker) {
  if (speaker === "ChatGPT") {
    return getAgentName(TARGETS.chatgpt);
  }

  if (speaker === "Gemini") {
    return getAgentName(TARGETS.gemini);
  }

  return speaker;
}

function getTargetKeyForSpeaker(speaker) {
  if (speaker === "ChatGPT") {
    return "chatgpt";
  }

  if (speaker === "Gemini") {
    return "gemini";
  }

  return "";
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
    nicknames: {
      chatgpt: normalizeNickname(value?.nicknames?.chatgpt) || TARGETS.chatgpt.defaultNickname,
      gemini: normalizeNickname(value?.nicknames?.gemini) || TARGETS.gemini.defaultNickname
    },
    botToBot: normalizeBotToBotState(value?.botToBot),
    members: {
      chatgpt: normalizeCouncilMember(value?.members?.chatgpt, "chatgpt"),
      gemini: normalizeCouncilMember(value?.members?.gemini, "gemini")
    }
  };
}

function normalizeBotToBotState(value) {
  return {
    enabled: value?.enabled !== false,
    mode: value?.mode || "manual_approval",
    maxTurns: Number(value?.maxTurns) > 0 ? Number(value.maxTurns) : 3,
    currentTurnCount: Math.max(0, Number(value?.currentTurnCount) || 0),
    approvedTurnsRemaining: Math.max(0, Number(value?.approvedTurnsRemaining) || 0),
    pendingHandoff: normalizePendingHandoff(value?.pendingHandoff)
  };
}

function normalizePendingHandoff(value) {
  if (!value?.id || value.status !== "pending") {
    return null;
  }

  return {
    id: value.id,
    fromAgent: value.fromAgent || "",
    toAgent: value.toAgent || "",
    sourceMessageId: value.sourceMessageId || "",
    detectedTag: value.detectedTag || "",
    body: value.body || "",
    createdAt: Number(value.createdAt) || Date.now(),
    status: "pending"
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
    nickname: normalizeNickname(member.nickname || ""),
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

  const previousMember = councilSession.members[target.key];
  const existingPendingConversationId = (
    isPendingConversationId(previousMember?.conversationId) &&
    previousMember.currentTabId === activeTab.id &&
    previousMember.currentWindowId === activeTab.windowId
  ) ? previousMember.conversationId : "";
  const conversationId = extractConversationId(activeTab.url, target.key) || existingPendingConversationId || createPendingConversationId(target.key);
  const resetDeliveryCursor = previousMember?.conversationId !== conversationId;

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
        nickname: getAgentName(target),
        role: "agent",
        status: "connected",
        assignedAt: Date.now()
      }
    }
  };

  if (resetDeliveryCursor) {
    deliveryState = {
      ...deliveryState,
      [target.label]: 0
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.deliveryState]: deliveryState });
  }

  await saveCouncilSession();
  setStatus(`Set this tab as ${getAgentName(target)}${isPendingConversationId(conversationId) ? " with a pending conversation ID." : "."}`);
}

async function removeActiveTabFromCouncil() {
  const activeTab = await getActiveTab();
  const memberKey = getCouncilMemberKeyForTab(activeTab, { allowStale: true });

  if (!memberKey) {
    setStatus("This tab is not in the active council.");
    return;
  }

  const removedName = getAgentName(TARGETS[memberKey]);
  stopReplyWatcher(TARGETS[memberKey].label);
  councilSession = {
    ...councilSession,
    members: {
      ...councilSession.members,
      [memberKey]: null
    }
  };

  await saveCouncilSession();
  setStatus(`Removed ${removedName} from the council.`);
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
  renderHandoffPanel();
}

function renderCouncilSession() {
  chatgptNicknameEl.value = getAgentName(TARGETS.chatgpt);
  geminiNicknameEl.value = getAgentName(TARGETS.gemini);

  const chatgpt = formatCouncilMember(councilSession.members.chatgpt, "not set");
  const gemini = formatCouncilMember(councilSession.members.gemini, "not set");
  const state = councilSession.paused ? "paused" : "active";

  sessionSummaryEl.textContent = `Council capture: ${state}
ChatGPT: ${chatgpt}
Gemini: ${gemini}`;
  toggleCapturePauseButton.textContent = councilSession.paused ? "Resume capture" : "Pause capture";
}

function renderHandoffPanel() {
  const pending = councilSession.botToBot.pendingHandoff;

  if (!pending) {
    handoffPanelEl.classList.remove("visible");
    handoffNoticeEl.textContent = "";
    return;
  }

  const fromName = TARGETS[pending.fromAgent] ? getAgentName(TARGETS[pending.fromAgent]) : pending.fromAgent;
  const toName = TARGETS[pending.toAgent] ? getAgentName(TARGETS[pending.toAgent]) : pending.toAgent;
  handoffPanelEl.classList.add("visible");
  handoffNoticeEl.textContent = `${fromName} wants to pass the mic to ${toName}.`;
}

function getAddedTurns(previousTurns, nextTurns) {
  const previousIds = new Set(previousTurns.map((turn) => turn.id));
  return nextTurns.filter((turn) => !previousIds.has(turn.id));
}

async function detectBotHandoffForTurn(turn) {
  if (!councilSession.botToBot.enabled || councilSession.botToBot.pendingHandoff) {
    return;
  }

  const fromAgent = getTargetKeyForSpeaker(turn.speaker);

  if (!fromAgent) {
    return;
  }

  if (String(turn.text || "").trimStart().startsWith("[Council Bridge]")) {
    return;
  }

  const detected = parseLeadingHandoffTag(turn.text, fromAgent);

  if (!detected) {
    return;
  }

  const target = TARGETS[detected.toAgent];
  const targetTab = await getCouncilTabForTarget(target);

  if (!targetTab) {
    console.info(`[CouncilBridge][HANDOFF_BLOCKED] reason=target_stale from=${fromAgent} to=${detected.toAgent}`);
    setStatus(`[CouncilBridge] Handoff blocked: ${getAgentName(target)} is stale or disconnected.`);
    return;
  }

  const handoff = {
    id: `handoff_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    fromAgent,
    toAgent: detected.toAgent,
    sourceMessageId: turn.id,
    detectedTag: detected.tag,
    body: turn.text,
    createdAt: Date.now(),
    status: "pending"
  };

  console.info(`[CouncilBridge][BOT_TAG_DETECTED] from=${fromAgent} to=${detected.toAgent} tag=${detected.tag} messageId=${turn.id}`);
  console.info(`[CouncilBridge][HANDOFF_PENDING] id=${handoff.id} from=${fromAgent} to=${detected.toAgent}`);

  councilSession = {
    ...councilSession,
    botToBot: {
      ...councilSession.botToBot,
      pendingHandoff: handoff
    }
  };

  await saveCouncilSession();

  if (shouldAutoApprovePendingHandoff()) {
    await approvePendingHandoff();
    return;
  }

  if (councilSession.botToBot.currentTurnCount >= councilSession.botToBot.maxTurns) {
    console.info(`[CouncilBridge][BOT_HANDOFF_LIMIT_REACHED] count=${councilSession.botToBot.currentTurnCount}`);
    setStatus("[CouncilBridge] Bot-to-bot handoff limit reached. Waiting for Human Gavel.");
  }
}

function parseLeadingHandoffTag(text, fromAgent) {
  const tagMatch = String(text || "").trimStart().match(/^@([a-z0-9_-]+)[,:;.!?]?(?=\s|$)/i);

  if (!tagMatch) {
    return null;
  }

  const target = getTargetFromComposerTag(tagMatch[0]);

  if (!target || target === "both" || target.key === fromAgent) {
    return null;
  }

  return {
    tag: tagMatch[0],
    toAgent: target.key
  };
}

function shouldAutoApprovePendingHandoff() {
  return (
    councilSession.botToBot.approvedTurnsRemaining > 0 &&
    councilSession.botToBot.currentTurnCount < councilSession.botToBot.maxTurns
  );
}

async function approvePendingHandoff(turnBudget = null) {
  const pending = councilSession.botToBot.pendingHandoff;
  const manualRequest = turnBudget !== null;

  if (!pending) {
    setStatus("No pending handoff.");
    return;
  }

  if (manualRequest && councilSession.botToBot.currentTurnCount >= councilSession.botToBot.maxTurns) {
    councilSession = {
      ...councilSession,
      botToBot: {
        ...councilSession.botToBot,
        currentTurnCount: 0
      }
    };
  }

  if (Number.isInteger(turnBudget) && turnBudget > 0) {
    councilSession = {
      ...councilSession,
      botToBot: {
        ...councilSession.botToBot,
        approvedTurnsRemaining: Math.max(councilSession.botToBot.approvedTurnsRemaining, turnBudget)
      }
    };
  }

  if (councilSession.botToBot.currentTurnCount >= councilSession.botToBot.maxTurns) {
    console.info(`[CouncilBridge][BOT_HANDOFF_LIMIT_REACHED] count=${councilSession.botToBot.currentTurnCount}`);
    setStatus("[CouncilBridge] Bot-to-bot handoff limit reached. Waiting for Human Gavel.");
    councilSession = {
      ...councilSession,
      botToBot: {
        ...councilSession.botToBot,
        approvedTurnsRemaining: 0
      }
    };
    await saveCouncilSession();
    return;
  }

  const target = TARGETS[pending.toAgent];
  const targetTab = await getCouncilTabForTarget(target);

  if (!targetTab) {
    console.info(`[CouncilBridge][HANDOFF_BLOCKED] reason=target_stale from=${pending.fromAgent} to=${pending.toAgent}`);
    setStatus(`[CouncilBridge] Handoff blocked: ${getAgentName(target)} is stale or disconnected.`);
    return;
  }

  console.info(`[CouncilBridge][HANDOFF_APPROVED] id=${pending.id}`);

  const sent = await sendToTarget(target);

  if (!sent) {
    return;
  }

  const nextTurnCount = councilSession.botToBot.currentTurnCount + 1;
  const nextRemaining = Math.max(0, councilSession.botToBot.approvedTurnsRemaining - 1);
  console.info(`[CouncilBridge][BOT_TURN_COUNT] count=${nextTurnCount} max=${councilSession.botToBot.maxTurns}`);

  councilSession = {
    ...councilSession,
    botToBot: {
      ...councilSession.botToBot,
      currentTurnCount: nextTurnCount,
      approvedTurnsRemaining: nextRemaining,
      pendingHandoff: null
    }
  };

  await saveCouncilSession();

  if (nextTurnCount >= councilSession.botToBot.maxTurns) {
    console.info(`[CouncilBridge][BOT_HANDOFF_LIMIT_REACHED] count=${nextTurnCount}`);
    setStatus("[CouncilBridge] Bot-to-bot handoff limit reached. Waiting for Human Gavel.");
  }
}

async function rejectPendingHandoff() {
  const pending = councilSession.botToBot.pendingHandoff;

  if (!pending) {
    setStatus("No pending handoff.");
    return;
  }

  console.info(`[CouncilBridge][HANDOFF_REJECTED] id=${pending.id}`);
  councilSession = {
    ...councilSession,
    botToBot: {
      ...councilSession.botToBot,
      approvedTurnsRemaining: 0,
      pendingHandoff: null
    }
  };

  await saveCouncilSession();
  setStatus("Handoff rejected.");
}

async function resetBotToBotTurnCount() {
  if (councilSession.botToBot.currentTurnCount === 0 && councilSession.botToBot.approvedTurnsRemaining === 0) {
    return;
  }

  councilSession = {
    ...councilSession,
    botToBot: {
      ...councilSession.botToBot,
      currentTurnCount: 0,
      approvedTurnsRemaining: 0,
      pendingHandoff: null
    }
  };

  await saveCouncilSession();
}

function formatCouncilMember(member, fallback) {
  if (!member) {
    return fallback;
  }

  return `${member.status}; ${shortenId(member.conversationId)}; tab ${member.currentTabId || "?"}`;
}

async function saveNickname(target, rawValue) {
  const nickname = normalizeNickname(rawValue) || target.defaultNickname || target.label;
  const currentMember = councilSession.members[target.key];

  councilSession = {
    ...councilSession,
    nicknames: {
      ...councilSession.nicknames,
      [target.key]: nickname
    },
    members: {
      ...councilSession.members,
      [target.key]: currentMember ? { ...currentMember, nickname } : null
    }
  };

  await saveCouncilSession();
  setStatus(`Saved ${target.label} nickname as ${nickname}.`);
}

function normalizeNickname(value) {
  return String(value || "").trim().slice(0, 40);
}

async function clearConversation() {
  if (!window.confirm("Clear the Council Bridge conversation view?")) {
    return;
  }

  turns = [];
  deliveryState = normalizeDeliveryState();
  revealAllTurnsImmediately();
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
  return (await getLatestReplyStateFromTarget(target)).text;
}

async function getLatestReplyStateFromTarget(target) {
  const tab = await getCouncilTabForTarget(target);

  if (!tab) {
    return { text: "", isStreaming: false };
  }

  const response = await sendMessageWithFallback(tab.id, { type: "GET_LATEST_REPLY" });
  return { text: response?.text || "", isStreaming: Boolean(response?.isStreaming) };
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
      const promotedMember = await promotePendingConversationIfReady(target, member, tab);

      if (tabMatchesCouncilMember(tab, promotedMember, target)) {
        return tab;
      }

      await markMemberStaleIfNavigatedOut(target, tab);
    }
  } catch (error) {
    // The stored routing tab may be gone; scan open tabs below and auto-heal if possible.
  }

  return healCouncilMemberFromOpenTabs(target, member);
}

async function promotePendingConversationIfReady(target, member, tab) {
  const conversationId = extractConversationId(tab?.url || "", target.key);

  if (
    !isPendingConversationId(member?.conversationId) ||
    !conversationId ||
    tab.id !== member.currentTabId ||
    tab.windowId !== member.currentWindowId
  ) {
    return member;
  }

  const promotedMember = {
    ...member,
    conversationId,
    currentTabId: tab.id,
    currentWindowId: tab.windowId,
    url: tab.url,
    status: "connected"
  };

  councilSession = {
    ...councilSession,
    members: {
      ...councilSession.members,
      [target.key]: promotedMember
    }
  };
  await saveCouncilSession();
  console.info(`[CouncilBridge][PENDING_CONVERSATION_PROMOTED] role=${target.key} conversationId=${conversationId}`);

  return promotedMember;
}

function tabMatchesCouncilMember(tab, member, target, options = {}) {
  const conversationId = extractConversationId(tab?.url || "", target.key);

  if (isPendingConversationId(member?.conversationId)) {
    return (
      Boolean(tab?.id) &&
      Boolean(member) &&
      (options.allowStale || member.status !== "stale") &&
      tab.url?.startsWith(target.openUrl) &&
      tab.id === member.currentTabId &&
      tab.windowId === member.currentWindowId
    );
  }

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

function createPendingConversationId(key) {
  const randomPart = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${PENDING_CONVERSATION_PREFIX}:${key}:${randomPart}`;
}

function isPendingConversationId(value) {
  return String(value || "").startsWith(`${PENDING_CONVERSATION_PREFIX}:`);
}

function shortenId(value) {
  if (!value) {
    return "no conversation";
  }

  if (isPendingConversationId(value)) {
    return "pending";
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
    if (wakeResponse?.activated) {
      if (options?.submit === true) {
        await delay(BACKGROUND_SUBMIT_ACTIVE_HOLD_MS);
      }

      const restoreTargetId = wakeResponse.previousTabId ?? tabId;
      await restoreTabAfterInjection(restoreTargetId, wakeResponse.windowId, wakeResponse.lockId);
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

async function restoreTabAfterInjection(tabId, windowId, lockId) {
  const response = await chrome.runtime.sendMessage({
    type: "RESTORE_TAB_AFTER_INJECTION",
    tabId,
    windowId,
    lockId
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
