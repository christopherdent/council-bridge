# Council Bridge

Council Bridge is a tiny Chrome and Edge extension for manually moving highlighted text between ChatGPT and Gemini browser tabs. It captures selected text, lets you edit it, wraps it in a prompt, inserts the prompt into the other service's visible message box, and clicks the send button.

The extension includes a popup and a persistent side panel. Existing ChatGPT and Gemini tabs receive prompts in the background when possible, so you can keep working in the current tab instead of switching back and forth.

It does not use OpenAI or Gemini APIs and does not scrape full conversations.

## Load the Extension

1. Go to `chrome://extensions` or `edge://extensions`
2. Turn on Developer Mode
3. Click Load unpacked
4. Select this repo folder

## Use the Extension

1. Open ChatGPT and Gemini
2. Click the extension icon
3. Click Open side panel
4. Highlight a response in ChatGPT or Gemini
5. Click Pass selection to other AI
6. Council Bridge captures the selected text, inserts the wrapped prompt into the other tab, and clicks the send button

You can also use the popup directly:

1. Highlight a response
2. Click Capture selected text
3. Click Send to Gemini or Send to ChatGPT

## Known Limitations

- Does not scrape full conversations
- Auto-send depends on finding an enabled send button
- Background send may fall back to focusing the destination tab if the inactive page does not accept insertion or submit events
- Prompt box selectors may need updates if ChatGPT or Gemini changes their UI

## Files

- `manifest.json` defines the Manifest V3 extension, permissions, target hosts, popup, and content script.
- `popup.html` provides the popup UI.
- `popup.js` handles capture, local storage, side panel opening, tab targeting, prompt wrapping, and send requests.
- `sidepanel.html` provides the persistent side panel UI.
- `content.js` reads selected text, inserts text into visible prompt boxes, and clicks the send button.
