# Council Bridge

Council Bridge is a tiny Chrome and Edge extension for manually moving highlighted text between ChatGPT and Gemini browser tabs. It captures selected text, tracks the snippets you explicitly add, wraps unseen turns in a direction-specific prompt, inserts them into the target service, and clicks send from the side panel.

The extension uses a persistent side panel instead of a toolbar dropdown. Existing ChatGPT and Gemini tabs receive prompts in the background when possible, so you can keep working in the current tab instead of switching back and forth. The side panel shows snippets you explicitly pass, selected replies you add, latest replies you refresh, automatically captured completed AI replies, and text you write as Christopher. Every side panel turn shows a millisecond timestamp, and prompts include the same turn timestamp for testing and traceability.

It does not use OpenAI or Gemini APIs and does not scrape full conversations.

## Load the Extension

1. Go to `chrome://extensions` or `edge://extensions`
2. Turn on Developer Mode
3. Click Load unpacked
4. Select this repo folder

## Use the Extension

1. Open ChatGPT and Gemini
2. Click the extension icon to open the side panel
3. Open the ChatGPT tab you want in the council and click Set as Lobo
4. Open the Gemini tab you want in the council and click Set as Gemini
5. Highlight a response in a council tab
6. Click Pass selection to other AI
7. Council Bridge captures the selected text, inserts the wrapped prompt into the other registered council tab, and clicks send

Only explicitly assigned council conversations are captured or used as send targets. Other ChatGPT or Gemini tabs are ignored. Council membership is anchored to the conversation ID in the URL (`chatgpt.com/c/...` or `gemini.google.com/app/...`), while the current tab ID is treated as a recoverable routing address. If Chrome reloads or reopens the same council conversation with a new tab ID, Council Bridge auto-heals the route. If an assigned tab navigates to another conversation URL, the member is marked stale until you switch back or explicitly reassign it.

Use Add selection to add highlighted ChatGPT or Gemini text to the side panel without passing it to the other AI.

Use Refresh replies to pull the latest visible ChatGPT and Gemini replies into the side panel conversation view.

Completed ChatGPT and Gemini replies are also added automatically after their visible response text stops changing.

Use Pause capture if an unrelated tab or conversation should not be collected while you inspect it.

Typed messages in the side panel use one Send button. By default, Council Bridge sends to both agents. Add a leading `@gemini`, `@gem`, `@lobo`, `@chatgpt`, or `@gpt` tag to route only to that agent. Use `@both`, `@all`, or `@council` to explicitly route to both. Council Bridge strips recognized leading routing tags before storing and sending the message, and sends every transcript turn that target has not seen since it was last advised.

The Gemini-to-ChatGPT wrapped prompt uses this format:

```text
[Council Bridge]
Source: Gemini
Target: ChatGPT / Lobo

Gemini said:

--- BEGIN GEMINI MESSAGE ---
Selected text
--- END GEMINI MESSAGE ---

Lobo, please respond to Christopher and Gemini. Agree, disagree, refine the plan, and turn it into concrete next steps.
```

## Known Limitations

- Does not scrape full conversations
- The side panel conversation view only stores snippets you explicitly pass or type
- Only conversations assigned as Lobo or Gemini in the active council session participate
- Side panel send/pass actions try to click send
- Auto-submit depends on finding an enabled send button
- Refresh replies uses best-effort selectors for the latest visible ChatGPT and Gemini response
- Automatic reply capture waits for best-effort response stability and stop-button detection
- Background send may fall back to focusing the destination tab if the inactive page does not accept insertion or submit events
- Prompt box selectors may need updates if ChatGPT or Gemini changes their UI

## Files

- `manifest.json` defines the Manifest V3 extension, permissions, target hosts, side panel, background worker, and content script.
- `background.js` opens the side panel when the extension icon is clicked.
- `sidepanel.html` provides the persistent side panel UI.
- `sidepanel.js` handles the side panel transcript, unseen-turn batching, typed composer, latest-reply capture, and one-click pass flow.
- `content.js` reads selected text, captures the latest visible reply, and inserts text into visible prompt boxes.
