chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_SELECTION") {
    sendResponse({ text: window.getSelection()?.toString() || "" });
    return;
  }

  if (message?.type === "GET_LATEST_REPLY") {
    sendResponse({ text: getLatestVisibleReply() });
    return;
  }

  if (message?.type === "INSERT_TEXT") {
    const ok = insertTextIntoPrompt(message.text || "", {
      showAlerts: message.showAlerts !== false
    });

    if (!ok || !message.submit) {
      sendResponse({ ok: Boolean(ok), submitted: false });
      return;
    }

    submitPrompt(ok).then((submitted) => {
      if (!submitted && message.showAlerts !== false) {
        alert("Council Bridge inserted the prompt, but could not find an enabled send button.");
      }

      sendResponse({ ok: true, submitted });
    });
    return true;
  }
});

function insertTextIntoPrompt(text, options) {
  const promptBox = findVisiblePromptBox();

  if (!promptBox) {
    if (options?.showAlerts) {
      alert("Council Bridge could not find a visible prompt box on this page.");
    }

    return null;
  }

  promptBox.focus();

  if (promptBox.tagName.toLowerCase() === "textarea") {
    setTextareaValue(promptBox, text);
    dispatchTextEvents(promptBox);
    return promptBox;
  }

  insertIntoEditableElement(promptBox, text);
  return promptBox;
}

function findVisiblePromptBox() {
  const selectors = [
    "#prompt-textarea",
    "rich-textarea [contenteditable='true']",
    ".ql-editor[contenteditable='true']",
    "textarea",
    '[contenteditable="true"]',
    '[role="textbox"]'
  ];

  for (const selector of selectors) {
    const candidate = Array.from(document.querySelectorAll(selector)).find(isVisiblePromptCandidate);

    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function getLatestVisibleReply() {
  const selectors = [
    '[data-message-author-role="assistant"]',
    'article [data-message-author-role="assistant"]',
    "message-content",
    ".model-response-text",
    ".response-content",
    ".markdown"
  ];

  const candidates = Array.from(new Set(
    selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
  ));
  const replies = candidates
    .filter(isVisibleReplyCandidate)
    .map((element) => ({
      text: normalizeReplyText(element.innerText || element.textContent || ""),
      element
    }))
    .filter((reply) => reply.text.length > 0);
  replies.sort((first, second) => {
    if (first.element === second.element) {
      return 0;
    }

    return first.element.compareDocumentPosition(second.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  return replies.at(-1)?.text || "";
}

function isVisibleReplyCandidate(element) {
  if (!isVisiblePromptCandidate(element) || findVisiblePromptBox()?.contains(element)) {
    return false;
  }

  const text = normalizeReplyText(element.innerText || element.textContent || "");
  return text.length >= 20;
}

function normalizeReplyText(text) {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function isVisiblePromptCandidate(element) {
  if (!element || element.matches("[disabled], [aria-disabled='true']")) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) > 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function insertIntoEditableElement(element, text) {
  const selection = window.getSelection();
  const range = document.createRange();

  element.focus();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  const inserted = document.execCommand("insertText", false, text);

  if (!inserted) {
    element.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    }));
  }

  if (!editableTextReflectsInput(element, text)) {
    element.innerHTML = `<p>${formatTextAsHtml(text)}</p>`;
  }

  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: text
  }));
  element.dispatchEvent(new Event("change", { bubbles: true }));

  return true;
}

async function submitPrompt(promptBox) {
  const button = await waitForSendButton(promptBox);

  if (!button) {
    return false;
  }

  button.click();
  return true;
}

function waitForSendButton(promptBox) {
  const timeoutMs = 2500;
  const intervalMs = 100;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const intervalId = setInterval(() => {
      const button = findSendButton(promptBox);

      if (button) {
        clearInterval(intervalId);
        resolve(button);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(intervalId);
        resolve(null);
      }
    }, intervalMs);
  });
}

function findSendButton(promptBox) {
  const prioritySelectors = [
    "#composer-submit-button",
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    'button[title="Send"]',
    'button[type="submit"]'
  ];

  for (const selector of prioritySelectors) {
    const button = Array.from(document.querySelectorAll(selector)).find(isUsableSendButton);

    if (button) {
      return button;
    }
  }

  const nearbyButton = findNearbySendButton(promptBox);

  if (nearbyButton) {
    return nearbyButton;
  }

  return Array.from(document.querySelectorAll("button")).find((button) => {
    if (!isUsableSendButton(button)) {
      return false;
    }

    return /\bsend\b/i.test(getButtonLabel(button));
  }) || null;
}

function findNearbySendButton(promptBox) {
  const containers = [
    promptBox.closest("form"),
    promptBox.closest('[role="form"]'),
    promptBox.closest("footer"),
    promptBox.parentElement,
    promptBox.parentElement?.parentElement,
    promptBox.parentElement?.parentElement?.parentElement
  ].filter(Boolean);

  for (const container of containers) {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => {
      if (!isUsableSendButton(candidate)) {
        return false;
      }

      return /\bsend\b/i.test(getButtonLabel(candidate)) || candidate.type === "submit";
    });

    if (button) {
      return button;
    }
  }

  return null;
}

function isUsableSendButton(button) {
  return (
    button instanceof HTMLButtonElement &&
    isVisiblePromptCandidate(button) &&
    !button.disabled &&
    button.getAttribute("aria-disabled") !== "true" &&
    button.getAttribute("data-disabled") !== "true"
  );
}

function getButtonLabel(button) {
  return [
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
    button.textContent
  ].filter(Boolean).join(" ");
}

function setTextareaValue(element, text) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

  if (valueSetter) {
    valueSetter.call(element, text);
    return;
  }

  element.value = text;
}

function editableTextReflectsInput(element, text) {
  return element.innerText === text || element.textContent === text;
}

function formatTextAsHtml(text) {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function dispatchTextEvents(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
