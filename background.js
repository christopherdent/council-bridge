const STORAGE_KEYS = {
  turns: "conversationTurns",
  session: "councilSession"
};

const MAX_TURNS = 80;
const TARGETS = {
  chatgpt: {
    label: "ChatGPT",
    openUrl: "https://chatgpt.com/"
  },
  gemini: {
    label: "Gemini",
    openUrl: "https://gemini.google.com/"
  }
};

let appendQueue = Promise.resolve();

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
    restoreTabAfterInjection(message.tabId)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Unknown error" });
      });
    return true;
  }

  if (message?.type !== "AI_REPLY_READY") {
    return;
  }

  appendQueue = appendQueue
    .then(() => appendAutomaticReply(message, sender))
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || "Unknown error" });
    });

  return true;
});

async function wakeTabForInjection(tabId) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: "Missing tabId" };
  }

  const targetTab = await chrome.tabs.get(tabId);

  if (targetTab.active) {
    return { ok: true, activated: false };
  }

  const [previousActiveTab] = await chrome.tabs.query({
    active: true,
    windowId: targetTab.windowId
  });

  await chrome.tabs.update(tabId, { active: true });
  await waitForTabReady(tabId);
  console.info(`[CouncilBridge][TAB_WOKEN_FOR_INJECTION] tabId=${tabId} previousTabId=${previousActiveTab?.id || ""}`);

  return {
    ok: true,
    activated: true,
    previousTabId: previousActiveTab?.id
  };
}

async function restoreTabAfterInjection(tabId) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: "Missing tabId" };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    console.info(`[CouncilBridge][TAB_RESTORED_AFTER_INJECTION] tabId=${tabId}`);
    return { ok: true, windowId: tab.windowId };
  } catch (error) {
    return { ok: false, error: error?.message || "Unknown error" };
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

  if (membership.session.paused) {
    console.info("[CouncilBridge][IGNORED_CAPTURE_PAUSED]");
    return { ok: true, added: false, reason: "paused" };
  }

  const speaker = membership.speaker;
  const turns = Array.isArray(stored[STORAGE_KEYS.turns]) ? stored[STORAGE_KEYS.turns] : [];

  if (isDuplicateTurn(turns, speaker, text)) {
    return { ok: true, added: false };
  }

  const createdAt = normalizeTimestamp(message.completedAt);
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
  return {
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
    status: member.status || "connected"
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

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}
