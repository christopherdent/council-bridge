const STORAGE_KEYS = {
  turns: "conversationTurns"
};

const MAX_TURNS = 80;

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

async function appendAutomaticReply(message, sender) {
  const speaker = getSpeaker(message, sender);
  const text = normalizeReplyText(message.text || "");

  if (!speaker || text.length === 0) {
    return { ok: false, added: false };
  }

  const stored = await chrome.storage.local.get(STORAGE_KEYS.turns);
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

function getSpeaker(message, sender) {
  const url = sender?.tab?.url || sender?.url || "";

  if (url.startsWith("https://chatgpt.com/")) {
    return "ChatGPT";
  }

  if (url.startsWith("https://gemini.google.com/")) {
    return "Gemini";
  }

  return ["ChatGPT", "Gemini"].includes(message.speaker) ? message.speaker : "";
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
