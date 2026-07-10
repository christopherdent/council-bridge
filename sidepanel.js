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
const INACTIVE_REPLY_SETTLE_MS = 15000;
const REPLY_WATCH_TIMEOUT_MS = 120000;
const REPLY_WATCH_MIN_LENGTH = 20;
const BACKGROUND_SUBMIT_ACTIVE_HOLD_MS = 900;
const TARGET_READY_POLL_MS = 500;
const TARGET_READY_TIMEOUT_MS = 5 * 60 * 1000;
const TYPEWRITER_INTERVAL_MS = 28;
const TYPEWRITER_MAX_DURATION_MS = 600;
const ASSISTANT_REVEAL_GAP_MS = 2000;
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
${options.includeCouncilOverview ? `${formatCouncilOverview(TARGETS.gemini)}\n\n` : ""}Sources: ${formatSourceList(turnsToSend)}
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
${options.includeCouncilOverview ? `${formatCouncilOverview(TARGETS.chatgpt)}\n\n` : ""}Sources: ${formatSourceList(turnsToSend)}
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
const roundtableModeEl = document.getElementById("roundtableMode");
const handoffPanelEl = document.getElementById("handoffPanel");
const handoffNoticeEl = document.getElementById("handoffNotice");
const approveHandoffButton = document.getElementById("approveHandoff");
const rejectHandoffButton = document.getElementById("rejectHandoff");
const approveOneHandoffButton = document.getElementById("approveOneHandoff");
const approveThreeHandoffsButton = document.getElementById("approveThreeHandoffs");
const approveTenHandoffsButton = document.getElementById("approveTenHandoffs");

let turns = [];
let deliveryState = {
  ChatGPT: 0,
  Gemini: 0
};
let councilSession = normalizeCouncilSession();
const replyWatchers = new Map();
const targetSendQueues = new Map();
const targetSendGenerations = new Map();
let deliveryWriteQueue = Promise.resolve();
let handoffReadiness = { handoffId: "", ready: false, reason: "" };
let handoffReadinessTimer = null;
let handoffReadinessCheckInFlight = false;

let renderedTurnIds = new Set();
const animatedTurnTextById = new Map();
const typewriterTimers = new Map();
const revealTimers = new Map();
let nextAssistantRevealAt = 0;

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
composerTextEl.addEventListener("keydown", handleComposerKeydown);
chatgptNicknameEl.addEventListener("change", () => saveNickname(TARGETS.chatgpt, chatgptNicknameEl.value));
geminiNicknameEl.addEventListener("change", () => saveNickname(TARGETS.gemini, geminiNicknameEl.value));
roundtableModeEl.addEventListener("change", toggleRoundtableMode);
approveHandoffButton.addEventListener("click", () => approvePendingHandoff(0));
rejectHandoffButton.addEventListener("click", rejectPendingHandoff);
approveOneHandoffButton.addEventListener("click", () => approvePendingHandoff(1));
approveThreeHandoffsButton.addEventListener("click", () => approvePendingHandoff(3));
approveTenHandoffsButton.addEventListener("click", () => approvePendingHandoff(10));

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (!changes[STORAGE_KEYS.turns] && !changes[STORAGE_KEYS.deliveryState] && !changes[STORAGE_KEYS.session]) {
    return;
  }

  let changedTurns = [];

  if (changes[STORAGE_KEYS.turns]) {
    const previousTurns = changes[STORAGE_KEYS.turns].oldValue || [];
    turns = changes[STORAGE_KEYS.turns].newValue || [];
    const addedTurns = getAddedTurns(previousTurns, turns);
    changedTurns = [
      ...addedTurns,
      ...getUpdatedTurns(previousTurns, turns)
    ];
    scheduleRevealForAddedTurns(addedTurns);
  }

  if (changes[STORAGE_KEYS.deliveryState]) {
    deliveryState = normalizeDeliveryState(changes[STORAGE_KEYS.deliveryState].newValue);
  }

  if (changes[STORAGE_KEYS.session]) {
    councilSession = normalizeCouncilSession(changes[STORAGE_KEYS.session].newValue);
  }

  renderTurns();
  renderCouncilSession();
  renderHandoffPanel();

  for (const turn of changedTurns) {
    if (await continueRoundtableForTurn(turn)) {
      continue;
    }

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
      target: getAgentName(target),
      recipients: [target.key]
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

  if (councilSession.roundtable.enabled) {
    await sendComposerRoundtable(route.text);
    return;
  }

  await sendComposerToBoth(route.text);
}

function handleComposerKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();
  sendComposer();
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
      target: getAgentName(target),
      recipients: [target.key]
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
      target: `${getAgentName(TARGETS.gemini)} + ${getAgentName(TARGETS.chatgpt)}`,
      recipients: [TARGETS.gemini.key, TARGETS.chatgpt.key]
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

async function sendComposerRoundtable(text) {
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
      target: `Roundtable: ${getAgentName(TARGETS.gemini)} + ${getAgentName(TARGETS.chatgpt)}`,
      recipients: [TARGETS.gemini.key, TARGETS.chatgpt.key]
    }, {
      allowDuplicate: true
    });

    const sourceTurn = turns.at(-1);
    const firstKey = getRoundtableFirstAgentKey();
    const secondKey = firstKey === TARGETS.gemini.key ? TARGETS.chatgpt.key : TARGETS.gemini.key;
    const firstTarget = TARGETS[firstKey];
    cancelQueuedTargetSends("roundtable_started");
    await clearBotToBotHandoff("roundtable_started");

    councilSession = {
      ...councilSession,
      roundtable: {
        ...councilSession.roundtable,
        pending: {
          id: `roundtable_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          sourceTurnId: sourceTurn?.id || "",
          firstAgent: firstKey,
          secondAgent: secondKey,
          createdAt: Date.now(),
          status: "waiting_first_reply"
        }
      }
    };
    await saveCouncilSession();

    console.info(`[CouncilBridge][ROUNDTABLE_STARTED] id=${councilSession.roundtable.pending.id} first=${firstKey} second=${secondKey} sourceTurnId=${sourceTurn?.id || ""}`);

    const sent = await sendToTarget(firstTarget, {
      roundtable: {
        position: "first"
      }
    });

    if (!sent) {
      await clearRoundtablePending("Roundtable could not send the first turn.");
      return;
    }

    if (councilSession.roundtable.pending?.sourceTurnId === sourceTurn?.id) {
      councilSession = {
        ...councilSession,
        roundtable: {
          ...councilSession.roundtable,
          pending: {
            ...councilSession.roundtable.pending,
            firstSentAt: Date.now()
          }
        }
      };
      await saveCouncilSession();
    }

    setStatus(`Roundtable started with ${getAgentName(firstTarget)}.`);
  } catch (error) {
    setStatus(`Roundtable failed: ${getErrorMessage(error)}`);
  }
}

function parseComposerRoute(rawText) {
  const targets = new Set();

  for (const tagMatch of CouncilBridgeRouting.findRoutingTags(rawText)) {
    const target = getTargetFromComposerTag(tagMatch.tag);

    if (!target) {
      continue;
    }

    if (target === "both") {
      targets.add(TARGETS.gemini);
      targets.add(TARGETS.chatgpt);
    } else {
      targets.add(target);
    }
  }

  return {
    text: rawText.trim(),
    targets: targets.size > 0 ? Array.from(targets) : [TARGETS.gemini, TARGETS.chatgpt]
  };
}

function getTargetFromComposerTag(tag) {
  return CouncilBridgeRouting.resolveTargetFromTag(tag, TARGETS, getAgentName);
}

function normalizeTagAlias(value) {
  return CouncilBridgeRouting.normalizeTagAlias(value);
}

function sendToTarget(target, options = {}) {
  const previousSend = targetSendQueues.get(target.key) || Promise.resolve();
  const sendGeneration = getTargetSendGeneration(target);
  const queuedSend = previousSend
    .catch(() => {})
    .then(() => {
      if (sendGeneration !== getTargetSendGeneration(target)) {
        console.info(`[CouncilBridge][SEND_CANCELLED] target=${target.key} reason=stale_generation`);
        return false;
      }

      return performSendToTarget(target, options);
    });

  targetSendQueues.set(target.key, queuedSend);
  scheduleHandoffReadinessCheck();

  return queuedSend.finally(() => {
    if (targetSendQueues.get(target.key) === queuedSend) {
      targetSendQueues.delete(target.key);
      scheduleHandoffReadinessCheck();
    }
  });
}

function getTargetSendGeneration(target) {
  return targetSendGenerations.get(target.key) || 0;
}

function cancelQueuedTargetSends(reason) {
  for (const target of Object.values(TARGETS)) {
    targetSendGenerations.set(target.key, getTargetSendGeneration(target) + 1);
  }

  console.info(`[CouncilBridge][QUEUED_SENDS_CANCELLED] reason=${reason}`);
}

async function performSendToTarget(target, options = {}) {
  let turnsToSend = getUnseenTurnsForTarget(target);
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

  const targetReady = await waitForTargetReadyToSend(target, tab.id);

  if (!targetReady) {
    setStatus(`${getAgentName(target)} stayed busy; message was not sent.`);
    return false;
  }

  turnsToSend = getUnseenTurnsForTarget(target);

  if (turnsToSend.length === 0) {
    setStatus(`${getAgentName(target)} is already caught up.`);
    return true;
  }

  const latestReplyBeforeSend = await getLatestReplyTextFromTarget(target).catch(() => "");
  let prompt = target.wrapTurns(turnsToSend, {
    includeCouncilOverview: !hasTargetBeenAdvised(target)
  });

  if (options.roundtable) {
    prompt = `${prompt}\n\n${formatRoundtableInstruction(target, options.roundtable)}`;
  }

  if (!councilSession.paused) {
    startReplyWatcher(target, latestReplyBeforeSend);
  }

  let response = await insertPromptInTab(tab.id, prompt, {
    showAlerts: false,
    submit: true
  });

  if (response?.ok && response?.submitted) {
    await markTargetAdvised(target, turnsToSend);
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
    setStatus(`Sent ${formatTurnCount(turnsToSend.length)} to ${getAgentName(target)}.`);
    return true;
  }

  stopReplyWatcher(target.label);

  if (response?.ok) {
    setStatus(`Inserted into ${getAgentName(target)}, but could not click send.`);
    return false;
  }

  setStatus(`Could not find ${getAgentName(target)}'s prompt box.`);
  return false;
}

async function waitForTargetReadyToSend(target, tabId) {
  const startedAt = Date.now();
  let waitingStatusShown = false;

  while (Date.now() - startedAt < TARGET_READY_TIMEOUT_MS) {
    try {
      const state = await sendMessageWithFallback(tabId, { type: "GET_COMPOSER_STATE" });

      if (state?.promptAvailable && !state?.isStreaming) {
        return true;
      }

      if (!waitingStatusShown) {
        setStatus(`${getAgentName(target)} is still responding; queued until ready.`);
        waitingStatusShown = true;
      }
    } catch (error) {
      // Navigation and background-tab throttling can briefly interrupt polling.
    }

    await delay(TARGET_READY_POLL_MS);
  }

  return false;
}

async function appendTurn(turn, options = {}) {
  if (!options.allowDuplicate && isDuplicateTurn(turn)) {
    return false;
  }

  if (turn.speaker === "Christopher") {
    cancelQueuedTargetSends("new_christopher_turn");
    await resetBotToBotTurnCount();
    await resetRoundtablePendingForChristopher();
  }

  const createdAt = Date.now();
  const nextTurn = {
    id: `${createdAt}-${Math.random().toString(16).slice(2)}`,
    createdAt,
    speaker: turn.speaker,
    text: turn.text,
    target: turn.target,
    recipients: Array.isArray(turn.recipients) ? turn.recipients : undefined
  };
  const nextTurns = [
    ...turns,
    nextTurn
  ].slice(-MAX_TURNS);

  turns = nextTurns;
  scheduleRevealForAddedTurns([nextTurn]);
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
    lastCommittedSignature: "",
    startedAt: Date.now(),
    timeoutId: null
  };

  replyWatchers.set(target.label, watcher);
  renderTurns();

  async function tick() {
    if (replyWatchers.get(target.label) !== watcher) {
      return;
    }

    if (Date.now() - watcher.startedAt > REPLY_WATCH_TIMEOUT_MS) {
      stopReplyWatcher(target.label);
      return;
    }

    try {
      const { text, isStreaming, isActive } = await getLatestReplyStateFromTarget(target);
      const signature = getReplySignature(text);
      const duplicate = isDuplicateTurn({ speaker: target.label, text });

      if (
        text.length >= REPLY_WATCH_MIN_LENGTH &&
        signature &&
        signature !== watcher.baselineSignature
      ) {
        if (duplicate && signature !== watcher.lastCommittedSignature) {
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

          if (
            signature !== watcher.lastCommittedSignature &&
            Date.now() - watcher.candidateSince >= requiredStableMs
          ) {
            const committed = await commitWatcherReply(target, watcher.candidateText);

            if (committed) {
              watcher.lastCommittedSignature = signature;
              setStatus(isActive
                ? `Captured completed ${target.label} reply.`
                : `Captured ${target.label} reply; watching for more.`);

              if (isActive) {
                stopReplyWatcher(target.label);
                return;
              }
            }

            watcher.candidateSince = Date.now();
          }

          if (
            !isActive &&
            watcher.lastCommittedSignature === signature &&
            watcher.candidateConfirmedNotStreaming &&
            Date.now() - watcher.candidateSince >= INACTIVE_REPLY_SETTLE_MS
          ) {
            stopReplyWatcher(target.label);
            return;
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
  renderTurns();
}

function getUnseenTurnsForTarget(target) {
  const lastAdvisedAt = deliveryState[target.label] || 0;

  return turns.filter((turn) => {
    return (
      turn.createdAt > lastAdvisedAt &&
      turn.speaker !== target.label &&
      isTurnRoutedToTarget(turn, target)
    );
  });
}

function isTurnRoutedToTarget(turn, target) {
  if (Array.isArray(turn.recipients) && turn.recipients.length > 0) {
    return turn.recipients.includes(target.key);
  }

  if (turn.speaker === "Christopher") {
    return parseComposerRoute(turn.text).targets.some((recipient) => recipient.key === target.key);
  }

  return true;
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

function formatCouncilOverview(target) {
  const targetName = getAgentName(target);
  const chatgptName = getAgentName(TARGETS.chatgpt);
  const geminiName = getAgentName(TARGETS.gemini);

  return `Council overview: Council Bridge is Christopher's browser side panel for coordinating ${chatgptName} and ${geminiName}. Project README: https://github.com/christopherdent/council-bridge/blob/main/README.md

Christopher writes or captures turns, then Council Bridge forwards the new turns to the other council member.

Routing notes: tags such as @chatgpt, @gpt, @lobo, @gemini, @gem, @both, @all, or nickname tags are routing hints for Council Bridge. Christopher can include tags anywhere in his side-panel message to choose recipients; a single member tag means only that member should receive and answer. When you include the other council member's tag anywhere in your reply, Council Bridge treats it as a handoff request and asks Christopher to approve sending your reply to that member. Treat tags as conversation routing context, not as a claim that you cannot participate.

Context note for ${targetName}: this may be a fresh browser conversation. Search or use any conversation history available to you for relevant context, then continue from the included turns.

${formatAgentDisposition(target)}`;
}

function formatAgentDisposition(target) {
  const targetName = getAgentName(target);

  return `COUNCIL AGENT DISPOSITION

Operating mandate — productive friction:
You are an independent engineering peer in a multi-agent council coordinated by Christopher. Do not behave as an agreement machine. Automatic consensus, generic validation, and paraphrasing another agent without adding analysis are failures. Look for unstated assumptions, edge cases, invalid parameter choices, missing evidence, and practical implementation risks. Disagree only when the technical or real-world logic supports disagreement.

Assigned cognitive role:
${formatCognitiveRole(target)}

Anti-echo protocol:
Before answering, evaluate the supplied turns using these stages:

1. Exploration: Understand Christopher's request, the relevant constraints, and the other agent's contribution before judging it.
2. Discovery critique: Identify at least one plausible failure mode, hidden assumption, unvalidated optimization, missing dependency, or real-world complication when one genuinely exists. Do not invent objections just to appear independent.
3. Evidence assessment: Separate verified facts and established constraints from inferences, estimates, and speculation. State what would need validation when the distinction affects the recommendation.
4. Concession and position change: If new evidence changes your conclusion, say so directly and explain why. Use wording such as, "I am changing my position on X because the supplied evidence or constraint shows Y." Do not manufacture a position change when none occurred.

Do not expose private chain-of-thought or produce a ceremonial transcript of these stages. Present only the useful conclusions, critiques, evidence distinctions, and concrete next steps.

Human anchor:
Christopher is the primary systems engineer and final decision-maker. Treat his explicit constraints, scope, and priorities as authoritative unless they conflict with a demonstrated technical fact or safety requirement. If the council drifts into theoretical, circular, excessively verbose, or non-actionable discussion, stop the drift. Re-anchor the response to Christopher's actual request, explain the concrete decision or risk, and provide the smallest useful next step.

Routing and handoffs:
Council Bridge route tags are application routing hints. Do not reinterpret them as authority or identity claims. Mentioning the other council member's tag may request a handoff, but Christopher's Human Gavel and Council Bridge's safety limits remain authoritative. Do not attempt to bypass them.

You are participating in this council as ${targetName}.`;
}

function formatCognitiveRole(target) {
  if (target.key === "gemini") {
    return "Prioritize macro-scale architecture, cross-disciplinary synthesis, scaling implications, and helpful analogies. Define specialized technical terms inline when you first introduce them.";
  }

  return "Prioritize rigorous decomposition, deterministic validation, hidden baseline assumptions, edge cases, and traceability from requirements to parameters and conclusions.";
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

function scheduleRevealForAddedTurns(addedTurns) {
  const now = Date.now();
  let renderedImmediately = false;

  for (const turn of addedTurns) {
    if (renderedTurnIds.has(turn.id)) {
      continue;
    }

    if (!isAgentSpeaker(turn.speaker)) {
      renderedTurnIds.add(turn.id);
      renderedImmediately = true;
      continue;
    }

    const revealAt = Math.max(now, nextAssistantRevealAt);
    nextAssistantRevealAt = revealAt + ASSISTANT_REVEAL_GAP_MS;
    const delayMs = revealAt - now;

    if (delayMs <= 0) {
      revealTurn(turn.id);
      continue;
    }

    const timerId = window.setTimeout(() => {
      revealTimers.delete(turn.id);
      revealTurn(turn.id);
    }, delayMs);
    revealTimers.set(turn.id, timerId);
  }

  if (renderedImmediately) {
    renderTurns();
  }
}

function startTypewriterForTurn(turn) {
  window.clearTimeout(typewriterTimers.get(turn.id));
  typewriterTimers.delete(turn.id);
  animatedTurnTextById.set(turn.id, "");
  revealTypewriterChunk(turn, 0);
}

function revealTypewriterChunk(turn, visibleLength) {
  const text = String(turn.text || "");
  const maxSteps = Math.max(1, Math.floor(TYPEWRITER_MAX_DURATION_MS / TYPEWRITER_INTERVAL_MS));
  const chunkSize = Math.max(14, Math.ceil(text.length / maxSteps));
  const nextVisibleLength = Math.min(text.length, visibleLength + chunkSize);
  const nextText = text.slice(0, nextVisibleLength);

  animatedTurnTextById.set(turn.id, nextText);
  updateRenderedTurnText(turn.id, nextText);

  if (nextVisibleLength >= text.length) {
    animatedTurnTextById.delete(turn.id);
    typewriterTimers.delete(turn.id);
    return;
  }

  const timerId = window.setTimeout(() => {
    revealTypewriterChunk(turn, nextVisibleLength);
  }, TYPEWRITER_INTERVAL_MS);
  typewriterTimers.set(turn.id, timerId);
}

function updateRenderedTurnText(turnId, text) {
  const textEl = turnsEl.querySelector(`[data-turn-id="${escapeCssIdentifier(turnId)}"] .turn-text`);

  if (!textEl) {
    renderTurns();
    return;
  }

  textEl.textContent = text;
}

function escapeCssIdentifier(value) {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(String(value));
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function clearTypewriterTimers() {
  for (const timerId of typewriterTimers.values()) {
    window.clearTimeout(timerId);
  }

  typewriterTimers.clear();
  animatedTurnTextById.clear();
}

function clearRevealTimers() {
  for (const timerId of revealTimers.values()) {
    window.clearTimeout(timerId);
  }

  revealTimers.clear();
  nextAssistantRevealAt = 0;
}

function revealTurn(turnId) {
  const turn = turns.find((candidate) => candidate.id === turnId);

  if (!turn) {
    return;
  }

  renderedTurnIds.add(turn.id);

  if (isAgentSpeaker(turn.speaker) && turn.text) {
    startTypewriterForTurn(turn);
    return;
  }

  renderTurns();
}

function revealAllTurnsImmediately() {
  clearRevealTimers();
  renderedTurnIds = new Set(turns.map((turn) => turn.id));
  renderTurns();
}

function renderTurns() {
  turnsEl.replaceChildren();

  const visibleTurns = turns.filter((turn) => renderedTurnIds.has(turn.id));

  if (turns.length === 0 && replyWatchers.size === 0) {
    const emptyEl = document.createElement("p");
    emptyEl.className = "empty";
    emptyEl.textContent = "No turns yet. Highlight a response or write as Christopher.";
    turnsEl.append(emptyEl);
    return;
  }

  for (const turn of visibleTurns) {
    const turnEl = document.createElement("article");
    turnEl.className = `turn ${turn.speaker.toLowerCase()}`;
    turnEl.dataset.turnId = turn.id;

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
    textEl.textContent = animatedTurnTextById.has(turn.id) ? animatedTurnTextById.get(turn.id) : turn.text;

    metaEl.append(speakerEl, detailsEl);
    turnEl.append(metaEl, textEl);
    turnsEl.append(turnEl);
  }

  renderTypingIndicators();
  turnsEl.scrollTop = turnsEl.scrollHeight;
}

function renderTypingIndicators() {
  for (const label of replyWatchers.keys()) {
    const turnEl = document.createElement("article");
    turnEl.className = `turn typing ${label.toLowerCase()}`;

    const metaEl = document.createElement("div");
    metaEl.className = "turn-meta";

    const speakerEl = document.createElement("span");
    speakerEl.className = "speaker";
    speakerEl.textContent = `${getTurnSpeakerDisplayName(label)}:`;

    const stateEl = document.createElement("span");
    stateEl.className = "typing-state";
    stateEl.textContent = "typing";

    const textEl = document.createElement("p");
    textEl.className = "turn-text typing-text";
    textEl.textContent = "Working";

    for (let index = 0; index < 3; index += 1) {
      const dotEl = document.createElement("span");
      dotEl.className = "typing-dot";
      dotEl.setAttribute("aria-hidden", "true");
      dotEl.textContent = ".";
      textEl.append(dotEl);
    }
    metaEl.append(speakerEl, stateEl);
    turnEl.append(metaEl, textEl);
    turnsEl.append(turnEl);
  }
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

function isAgentSpeaker(speaker) {
  return speaker === "ChatGPT" || speaker === "Gemini";
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
    roundtable: normalizeRoundtableState(value?.roundtable),
    members: {
      chatgpt: normalizeCouncilMember(value?.members?.chatgpt, "chatgpt"),
      gemini: normalizeCouncilMember(value?.members?.gemini, "gemini")
    }
  };
}

function normalizeRoundtableState(value) {
  const nextFirst = [TARGETS.gemini.key, TARGETS.chatgpt.key].includes(value?.nextFirst)
    ? value.nextFirst
    : TARGETS.gemini.key;

  return {
    enabled: Boolean(value?.enabled),
    nextFirst,
    pending: normalizeRoundtablePending(value?.pending)
  };
}

function normalizeRoundtablePending(value) {
  if (!value?.id || value.status !== "waiting_first_reply") {
    return null;
  }

  const firstAgent = [TARGETS.gemini.key, TARGETS.chatgpt.key].includes(value.firstAgent)
    ? value.firstAgent
    : "";
  const secondAgent = [TARGETS.gemini.key, TARGETS.chatgpt.key].includes(value.secondAgent)
    ? value.secondAgent
    : "";

  if (!firstAgent || !secondAgent || firstAgent === secondAgent) {
    return null;
  }

  return {
    id: value.id,
    sourceTurnId: value.sourceTurnId || "",
    firstAgent,
    secondAgent,
    createdAt: Number(value.createdAt) || Date.now(),
    firstSentAt: Number(value.firstSentAt) || 0,
    status: "waiting_first_reply"
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

async function toggleRoundtableMode() {
  councilSession = {
    ...councilSession,
    roundtable: {
      ...councilSession.roundtable,
      enabled: roundtableModeEl.checked,
      pending: roundtableModeEl.checked ? councilSession.roundtable.pending : null
    }
  };

  await saveCouncilSession();
  setStatus(councilSession.roundtable.enabled ? "Roundtable mode enabled." : "Roundtable mode disabled.");
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
  roundtableModeEl.checked = councilSession.roundtable.enabled;

  const chatgpt = formatCouncilMember(councilSession.members.chatgpt, "not set");
  const gemini = formatCouncilMember(councilSession.members.gemini, "not set");
  const state = councilSession.paused ? "paused" : "active";
  const roundtable = councilSession.roundtable.enabled
    ? `on; next first: ${getAgentName(TARGETS[councilSession.roundtable.nextFirst])}`
    : "off";

  sessionSummaryEl.textContent = `Council capture: ${state}
ChatGPT: ${chatgpt}
Gemini: ${gemini}
Roundtable: ${roundtable}`;
  toggleCapturePauseButton.textContent = councilSession.paused ? "Resume capture" : "Pause capture";
}

function renderHandoffPanel() {
  const pending = councilSession.botToBot.pendingHandoff;

  if (!pending) {
    handoffPanelEl.classList.remove("visible");
    handoffPanelEl.classList.remove("ready");
    handoffNoticeEl.textContent = "";
    setHandoffApprovalButtonsEnabled(false, "No pending handoff.");
    rejectHandoffButton.disabled = true;
    handoffReadiness = { handoffId: "", ready: false, reason: "" };
    window.clearTimeout(handoffReadinessTimer);
    handoffReadinessTimer = null;
    return;
  }

  const fromName = TARGETS[pending.fromAgent] ? getAgentName(TARGETS[pending.fromAgent]) : pending.fromAgent;
  const toName = TARGETS[pending.toAgent] ? getAgentName(TARGETS[pending.toAgent]) : pending.toAgent;
  const readiness = handoffReadiness.handoffId === pending.id
    ? handoffReadiness
    : { ready: false, reason: `Checking whether ${toName} is ready...` };

  handoffPanelEl.classList.add("visible");
  handoffPanelEl.classList.toggle("ready", readiness.ready);
  handoffNoticeEl.textContent = readiness.ready
    ? `${fromName} wants to pass the mic to ${toName}.`
    : `${fromName} wants to pass the mic to ${toName}. ${readiness.reason}`;
  setHandoffApprovalButtonsEnabled(readiness.ready, readiness.reason);
  rejectHandoffButton.disabled = false;
  scheduleHandoffReadinessCheck();
}

function setHandoffApprovalButtonsEnabled(enabled, reason) {
  for (const button of [approveHandoffButton, approveOneHandoffButton, approveThreeHandoffsButton, approveTenHandoffsButton]) {
    button.disabled = !enabled;
    button.title = enabled ? "" : reason;
  }
}

function scheduleHandoffReadinessCheck(delayMs = 0) {
  window.clearTimeout(handoffReadinessTimer);

  if (!councilSession.botToBot.pendingHandoff) {
    handoffReadinessTimer = null;
    return;
  }

  handoffReadinessTimer = window.setTimeout(refreshHandoffReadiness, delayMs);
}

async function refreshHandoffReadiness() {
  const pending = councilSession.botToBot.pendingHandoff;

  if (!pending) {
    return;
  }

  if (handoffReadinessCheckInFlight) {
    scheduleHandoffReadinessCheck(250);
    return;
  }

  handoffReadinessCheckInFlight = true;
  let ready = false;
  let reason = "Destination is not ready.";

  try {
    const target = TARGETS[pending.toAgent];
    const targetTab = target ? await getCouncilTabForTarget(target) : null;

    if (!target || !targetTab) {
      reason = `${target ? getAgentName(target) : "Destination"} is disconnected or stale.`;
    } else if (targetSendQueues.has(target.key)) {
      reason = `${getAgentName(target)} already has a queued send.`;
    } else if (getUnseenTurnsForTarget(target).length === 0) {
      reason = "There is no new handoff context to send.";
    } else {
      const state = await sendMessageWithFallback(targetTab.id, { type: "GET_COMPOSER_STATE" });
      ready = Boolean(state?.promptAvailable && !state?.isStreaming);
      reason = state?.isStreaming
        ? `${getAgentName(target)} is still responding.`
        : `${getAgentName(target)} composer is not available.`;
    }
  } catch (error) {
    reason = "Could not verify the destination composer.";
  } finally {
    handoffReadinessCheckInFlight = false;
  }

  if (councilSession.botToBot.pendingHandoff?.id !== pending.id) {
    scheduleHandoffReadinessCheck(750);
    return;
  }

  handoffReadiness = { handoffId: pending.id, ready, reason };
  renderHandoffPanel();
  scheduleHandoffReadinessCheck(750);
}

async function continueRoundtableForTurn(turn) {
  const pending = councilSession.roundtable.pending;

  if (!councilSession.roundtable.enabled || !pending) {
    return false;
  }

  const firstTarget = TARGETS[pending.firstAgent];
  const secondTarget = TARGETS[pending.secondAgent];

  if (!firstTarget || !secondTarget || turn.speaker !== firstTarget.label) {
    return false;
  }

  const earliestReplyAt = pending.firstSentAt || pending.createdAt;

  if (turn.createdAt < earliestReplyAt) {
    return false;
  }

  console.info(`[CouncilBridge][ROUNDTABLE_FIRST_REPLY] id=${pending.id} first=${pending.firstAgent} second=${pending.secondAgent} turnId=${turn.id}`);
  setStatus(`Roundtable: passing ${getAgentName(firstTarget)}'s reply to ${getAgentName(secondTarget)}.`);

  const sent = await sendToTarget(secondTarget, {
    roundtable: {
      position: "second",
      firstName: getAgentName(firstTarget)
    }
  });

  if (!sent) {
    await clearRoundtablePending("Roundtable could not send the second turn.");
    return true;
  }

  councilSession = {
    ...councilSession,
    roundtable: {
      ...councilSession.roundtable,
      nextFirst: pending.secondAgent,
      pending: null
    }
  };
  await saveCouncilSession();
  console.info(`[CouncilBridge][ROUNDTABLE_COMPLETED] id=${pending.id} first=${pending.firstAgent} second=${pending.secondAgent}`);
  setStatus(`Roundtable sent context to ${getAgentName(secondTarget)}.`);
  return true;
}

function formatRoundtableInstruction(target, roundtable) {
  const targetName = getAgentName(target);

  if (roundtable.position === "second") {
    const firstName = roundtable.firstName || "Reviewer 1";

    return `[Council Bridge Roundtable]
You are Reviewer 2 in this round. The included turns should contain Christopher's prompt and ${firstName}'s response.

Evaluate ${firstName}'s response independently. Agree, refine, or challenge it with concrete reasons. Do not merely edit, summarize, or echo ${firstName}. Preserve your own judgment and keep the reply concise unless Christopher asked for depth.

Do not tag the other council member in a Roundtable response. Council Bridge is already handling the sequence.`;
  }

  return `[Council Bridge Roundtable]
You are Reviewer 1 in this round. Give Christopher your independent answer first. Do not try to predict or force consensus with the other council member. Surface the most useful point, risk, or recommendation clearly and keep the reply concise unless Christopher asked for depth.

Do not tag the other council member in a Roundtable response. Council Bridge will pass your answer to Reviewer 2 automatically.

You are participating in this round as ${targetName}.`;
}

function getRoundtableFirstAgentKey() {
  return [TARGETS.gemini.key, TARGETS.chatgpt.key].includes(councilSession.roundtable.nextFirst)
    ? councilSession.roundtable.nextFirst
    : TARGETS.gemini.key;
}

async function clearRoundtablePending(message) {
  const pending = councilSession.roundtable.pending;

  councilSession = {
    ...councilSession,
    roundtable: {
      ...councilSession.roundtable,
      pending: null
    }
  };
  await saveCouncilSession();
  if (pending) {
    console.info(`[CouncilBridge][ROUNDTABLE_CANCELLED] id=${pending.id} reason=${message || "cleared"}`);
  }
  setStatus(message);
}

async function resetRoundtablePendingForChristopher() {
  const pending = councilSession.roundtable.pending;

  if (!pending) {
    return;
  }

  councilSession = {
    ...councilSession,
    roundtable: {
      ...councilSession.roundtable,
      pending: null
    }
  };

  await saveCouncilSession();
  console.info(`[CouncilBridge][ROUNDTABLE_CANCELLED] id=${pending.id} reason=new_christopher_turn`);
}

function getAddedTurns(previousTurns, nextTurns) {
  const previousIds = new Set(previousTurns.map((turn) => turn.id));
  return nextTurns.filter((turn) => !previousIds.has(turn.id));
}

function getUpdatedTurns(previousTurns, nextTurns) {
  const previousById = new Map(previousTurns.map((turn) => [turn.id, turn]));

  return nextTurns.filter((turn) => {
    const previousTurn = previousById.get(turn.id);
    return previousTurn && previousTurn.text !== turn.text;
  });
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

  const detected = parseHandoffTag(turn.text, fromAgent);

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

function parseHandoffTag(text, fromAgent) {
  return CouncilBridgeRouting.parseHandoffTag(text, fromAgent, getTargetFromComposerTag);
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

  if (
    manualRequest &&
    (handoffReadiness.handoffId !== pending.id || !handoffReadiness.ready)
  ) {
    setStatus(handoffReadiness.reason || "Handoff destination is not ready yet.");
    scheduleHandoffReadinessCheck();
    return;
  }

  if (manualRequest) {
    handoffReadiness = {
      handoffId: pending.id,
      ready: false,
      reason: "Sending approved handoff..."
    };
    renderHandoffPanel();
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
        maxTurns: Math.max(councilSession.botToBot.maxTurns, turnBudget),
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
  if (
    councilSession.botToBot.currentTurnCount === 0 &&
    councilSession.botToBot.approvedTurnsRemaining === 0 &&
    !councilSession.botToBot.pendingHandoff
  ) {
    return;
  }

  await clearBotToBotHandoff("new_christopher_turn");
}

async function clearBotToBotHandoff(reason) {
  const pending = councilSession.botToBot.pendingHandoff;

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

  if (pending) {
    console.info(`[CouncilBridge][HANDOFF_CANCELLED] id=${pending.id} reason=${reason}`);
  }
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
  councilSession = {
    ...councilSession,
    roundtable: {
      ...councilSession.roundtable,
      pending: null
    }
  };
  clearTypewriterTimers();
  clearRevealTimers();
  revealAllTurnsImmediately();
  await chrome.storage.local.set({
    [STORAGE_KEYS.turns]: [],
    [STORAGE_KEYS.deliveryState]: deliveryState,
    [STORAGE_KEYS.session]: normalizeCouncilSession(councilSession)
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
    return { text: "", isStreaming: false, isActive: false };
  }

  const response = await sendMessageWithFallback(tab.id, { type: "GET_LATEST_REPLY" });
  return { text: response?.text || "", isStreaming: Boolean(response?.isStreaming), isActive: Boolean(tab.active) };
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
      await restoreTabAfterInjection(restoreTargetId, wakeResponse.windowId, wakeResponse.lockId, wakeResponse.previousWindowId);
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

async function restoreTabAfterInjection(tabId, windowId, lockId, previousWindowId) {
  const response = await chrome.runtime.sendMessage({
    type: "RESTORE_TAB_AFTER_INJECTION",
    tabId,
    windowId,
    lockId,
    previousWindowId
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
