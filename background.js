const STORAGE_KEYS = {
  turns: "conversationTurns",
  session: "councilSession"
};

const MAX_TURNS = 80;
const TARGETS = {
  chatgpt: {
    label: "ChatGPT",
    defaultNickname: "ChatGPT",
    openUrl: "https://chatgpt.com/"
  },
  gemini: {
    label: "Gemini",
    defaultNickname: "Gemini",
    openUrl: "https://gemini.google.com/"
  }
};

let appendQueue = Promise.resolve();
const windowInjectionLocks = new Map();
const pendingLockReleases = new Map();
let injectionLockIdCounter = 0;

chrome.runtime.onInstalled.addListener(() => {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!chrome.sidePanel?.open || !tab?.windowId) {
    return;
  }

  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  reconcileCouncilTab(tab).catch((error) => {
    console.warn(`[CouncilBridge][SESSION_RECOVERY_FAILED] error=${error?.message || "Unknown error"}`);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WAKE_TAB_FOR_INJECTION") {
    wakeTabForInjection(message.tabId)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Unknown error" });
      });
    return true;
  }

  if (message?.type === "RESTORE_TAB_AFTER_INJECTION") {
    restoreTabAfterInjection(message.tabId, message.windowId, message.lockId)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Unknown error" });
      });
    return true;
  }

  if (message?.type === "AI_REPLY_READY") {
    appendQueue = appendQueue
      .then(() => appendAutomaticReply(message, sender))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Unknown error" });
      });
    return true;
  }

  if (message?.type === "WATCHER_REPLY_READY") {
    appendQueue = appendQueue
      .then(() => appendWatcherReply(message))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Unknown error" });
      });
    return true;
  }
});

async function wakeTabForInjection(tabId) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: "Missing tabId" };
  }

  const targetTab = await chrome.tabs.get(tabId);

  if (targetTab.active) {
    return { ok: true, activated: false };
  }

  const windowId = targetTab.windowId;

  // Only one tab activation cycle may run at a time per window, so two concurrent
  // sends targeting tabs in the same window don't stomp on each other's
  // "which tab was active before we started" bookkeeping. Different windows proceed
  // fully in parallel since chrome.tabs.update({active:true}) is per-window. Each
  // acquisition gets its own lockId so a later acquire for the same window can never
  // release a lock it doesn't own.
  const lockId = await acquireWindowInjectionLock(windowId);

  try {
    const [previousActiveTab] = await chrome.tabs.query({
      active: true,
      windowId
    });

    await chrome.tabs.update(tabId, { active: true });
    await waitForTabReady(tabId);
    console.info(`[CouncilBridge][TAB_WOKEN_FOR_INJECTION] tabId=${tabId} previousTabId=${previousActiveTab?.id || ""}`);

    return {
      ok: true,
      activated: true,
      previousTabId: previousActiveTab?.id,
      windowId,
      lockId
    };
  } catch (error) {
    releaseWindowInjectionLock(windowId, lockId);
    throw error;
  }
}

async function restoreTabAfterInjection(tabId, windowId, lockId) {
  try {
    if (!Number.isInteger(tabId)) {
      return { ok: false, error: "Missing tabId" };
    }

    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    console.info(`[CouncilBridge][TAB_RESTORED_AFTER_INJECTION] tabId=${tabId}`);
    return { ok: true, windowId: tab.windowId };
  } catch (error) {
    return { ok: false, error: error?.message || "Unknown error" };
  } finally {
    if (Number.isInteger(windowId) && Number.isInteger(lockId)) {
      releaseWindowInjectionLock(windowId, lockId);
    }
  }
}

function acquireWindowInjectionLock(windowId) {
  const previous = windowInjectionLocks.get(windowId) || Promise.resolve();
  const lockId = ++injectionLockIdCounter;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  windowInjectionLocks.set(windowId, previous.then(() => held));
  pendingLockReleases.set(lockId, release);

  return previous.then(() => lockId);
}

function releaseWindowInjectionLock(windowId, lockId) {
  const release = pendingLockReleases.get(lockId);

  if (release) {
    pendingLockReleases.delete(lockId);
    release();
  }
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

async function appendAutomaticReply(message, sender) {
  const text = normalizeReplyText(message.text || "");

  if (text.length === 0) {
    return { ok: false, added: false };
  }

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.turns,
    STORAGE_KEYS.session
  ]);
  const session = await reconcileCouncilTab(sender?.tab, stored[STORAGE_KEYS.session]);
  const membership = getCouncilMembership(session, sender);

  if (!membership.ok) {
    console.info(`[CouncilBridge][IGNORED_NON_COUNCIL_TAB] reason=${membership.reason}`);
    return { ok: true, added: false, reason: membership.reason };
  }

  const turns = Array.isArray(stored[STORAGE_KEYS.turns]) ? stored[STORAGE_KEYS.turns] : [];

  return commitReply({
    turns,
    session: membership.session,
    speaker: membership.speaker,
    text,
    completedAt: message.completedAt
  });
}

async function appendWatcherReply(message) {
  const text = normalizeReplyText(message.text || "");
  const target = TARGETS[message.targetKey];

  if (text.length === 0 || !target) {
    return { ok: false, added: false };
  }

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.turns,
    STORAGE_KEYS.session
  ]);
  const session = normalizeCouncilSession(stored[STORAGE_KEYS.session]);
  const member = session.members[message.targetKey];

  if (!member || member.status === "stale") {
    console.info(`[CouncilBridge][IGNORED_WATCHER_REPLY] reason=no-council-member targetKey=${message.targetKey}`);
    return { ok: true, added: false, reason: "no-council-member" };
  }

  const turns = Array.isArray(stored[STORAGE_KEYS.turns]) ? stored[STORAGE_KEYS.turns] : [];

  return commitReply({
    turns,
    session,
    speaker: target.label,
    text,
    completedAt: message.completedAt
  });
}

async function commitReply({ turns, session, speaker, text, completedAt }) {
  if (session.paused) {
    console.info("[CouncilBridge][IGNORED_CAPTURE_PAUSED]");
    return { ok: true, added: false, reason: "paused" };
  }

  if (isDuplicateTurn(turns, speaker, text)) {
    return { ok: true, added: false };
  }

  const createdAt = normalizeTimestamp(completedAt);
  const nextTurns = [
    ...turns,
    {
      id: `${createdAt}-${Math.random().toString(16).slice(2)}`,
      createdAt,
      speaker,
      text,
      target: ""
    }
  ].slice(-MAX_TURNS);

  await chrome.storage.local.set({ [STORAGE_KEYS.turns]: nextTurns });
  return { ok: true, added: true };
}

function getCouncilMembership(rawSession, sender) {
  const session = normalizeCouncilSession(rawSession);
  const tabId = sender?.tab?.id;

  if (!Number.isInteger(tabId)) {
    return { ok: false, reason: "missing-tab", session };
  }

  for (const [key, target] of Object.entries(TARGETS)) {
    const member = session.members[key];

    if (member?.currentTabId === tabId && member.status !== "stale") {
      return { ok: true, speaker: target.label, session };
    }
  }

  return { ok: false, reason: `tab-${tabId}-not-in-council`, session };
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
    assignedAt: Number(member.assignedAt) || Date.now(),
    status: member.status || "connected"
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

async function reconcileCouncilTab(tab, rawSession) {
  if (!tab?.url) {
    return normalizeCouncilSession(rawSession);
  }

  const stored = rawSession === undefined
    ? await chrome.storage.local.get(STORAGE_KEYS.session)
    : { [STORAGE_KEYS.session]: rawSession };
  const session = normalizeCouncilSession(stored[STORAGE_KEYS.session]);
  const nextSession = reconcileCouncilTabInSession(session, tab);

  if (nextSession !== session) {
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: nextSession });
    return nextSession;
  }

  return session;
}

function reconcileCouncilTabInSession(session, tab) {
  let changed = false;
  const nextMembers = { ...session.members };

  for (const [key, target] of Object.entries(TARGETS)) {
    const member = session.members[key];

    if (!member || !tab.url?.startsWith(target.openUrl)) {
      continue;
    }

    const conversationId = extractConversationId(tab.url, key);

    if (conversationId === member.conversationId) {
      if (
        member.currentTabId !== tab.id ||
        member.currentWindowId !== tab.windowId ||
        member.status !== "connected" ||
        member.url !== tab.url
      ) {
        nextMembers[key] = {
          ...member,
          currentTabId: tab.id,
          currentWindowId: tab.windowId,
          url: tab.url,
          status: "connected"
        };
        changed = true;
        console.info(`[CouncilBridge][SESSION_AUTO_HEALED] role=${key} newTabId=${tab.id}`);
      }

      continue;
    }

    if (member.currentTabId === tab.id && member.status !== "stale") {
      nextMembers[key] = {
        ...member,
        currentTabId: tab.id,
        currentWindowId: tab.windowId,
        url: tab.url,
        status: "stale"
      };
      changed = true;
      console.info(`[CouncilBridge][TAB_NAVIGATED_OUT] role=${key} tabId=${tab.id}`);
    }
  }

  return changed ? { ...session, members: nextMembers } : session;
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

function isDuplicateTurn(turns, speaker, text) {
  const normalizedText = normalizeForDuplicate(text);

  return turns.some((turn) => {
    return turn.speaker === speaker && normalizeForDuplicate(turn.text || "") === normalizedText;
  });
}

function normalizeReplyText(text) {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeForDuplicate(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeNickname(value) {
  return String(value || "").trim().slice(0, 40);
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}
