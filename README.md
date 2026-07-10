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

Council Bridge only works with the exact ChatGPT and Gemini conversations you assign to the active council. Random ChatGPT or Gemini tabs are ignored.

### Start a Council

1. Open the ChatGPT conversation you want to use in the council.
2. Open the Gemini conversation you want to use as Gemini.
3. Click the Council Bridge extension icon to open the side panel.
4. While the ChatGPT conversation is the active browser tab, click `Set as ChatGPT`.
5. While the Gemini conversation is the active browser tab, click `Set as Gemini`.
6. Confirm the side panel shows both members as connected.

Council membership is anchored to the conversation ID in the URL when one exists:

- ChatGPT: `chatgpt.com/c/...`
- Gemini: `gemini.google.com/app/...`

Brand-new ChatGPT or Gemini conversations can be assigned before the service creates a real conversation ID. Council Bridge stores a temporary pending ID pinned to that exact tab, then promotes the council member automatically when the tab URL changes to the real conversation URL.

The current tab ID is only a routing address. If Chrome reloads or reopens the same council conversation with a new tab ID, Council Bridge auto-heals the route. If an assigned tab navigates to a different conversation URL, that member is marked stale until you switch back or explicitly reassign it.

### Send a Message

Type in the side panel composer and click `Send`.

Default behavior sends to both ChatGPT and Gemini. Include a routing tag anywhere in the message to send to one agent:

```text
@gemini What do you think?
@gem Same thing, shorter tag.
@lobo Turn this into implementation steps.
@chatgpt Same as @lobo.
@gpt Same as @lobo.
Can you sanity check this, @gemini?
This looks ready for @lobo to review.
```

Use these tags to explicitly send to both:

```text
@both Review this together.
@all Review this together.
@council Review this together.
```

Routing tags can appear anywhere in the message and are case-insensitive. A single member tag routes only to that member. Multiple member tags or an explicit both-tag route to both. Tags are not stripped; they stay in the stored and sent message text. Recipient metadata remains attached to the stored turn, so a send that was already queued for the other agent cannot pick up a later single-agent message.

### Nicknames

ChatGPT and Gemini are the default names. Use the nickname fields in the side panel to rename either council member for transcript display and prompt wording.

Nicknames can also be used as route tags. For example, if ChatGPT is nicknamed `Lobo`, then `@lobo` routes only to ChatGPT. Built-in aliases still work:

- ChatGPT: `@chatgpt`, `@gpt`, `@lobo`
- Gemini: `@gemini`, `@gem`
- Both: `@both`, `@all`, `@council`

When Council Bridge sends to an agent, it includes every transcript turn that agent has not seen since it was last advised. It does not resend the whole transcript every time.

If an agent is still responding, Council Bridge queues that agent's next send for up to five minutes. It waits in the side panel without holding the browser on the target tab, then batches all still-unseen turns and submits them when the composer becomes available. Sends to the same agent run one at a time so rapid messages cannot race in the target composer.

The first send to an agent also includes a short Council Bridge overview and a link to this README, so a fresh conversation knows that Christopher is coordinating ChatGPT and Gemini through the side panel. The first send bundles three things:

- the Council Bridge overview,
- routing and handoff context (`@chatgpt`, `@gemini`, `@both`, and nickname tags are Council Bridge routing hints, and how bot-to-bot handoffs are gated by the Human Gavel),
- a target-specific Council Agent Disposition.

The disposition sets each agent up as an independent engineering peer rather than an agreement machine: it asks for productive friction, an anti-echo protocol (explore, critique, separate evidence from speculation, and openly concede when new evidence changes a conclusion), and keeps Christopher as the primary systems engineer and final decision-maker. The cognitive role differs by agent — Gemini is pointed at macro-scale architecture, cross-disciplinary synthesis, and scaling; ChatGPT is pointed at rigorous decomposition, deterministic validation, hidden assumptions, and edge cases. Role selection is keyed to the actual target (ChatGPT vs. Gemini), not its nickname. The disposition ships only with the first-send overview; later incremental sends do not repeat it.

### Bot-to-Bot Handoffs

Assistant replies can request a controlled handoff by including a route tag for the other council member anywhere in the reply.

Examples that create a pending handoff:

```text
@lobo can you review this?
@gemini what do you think?
I think this is ready for @gemini to critique.
The implementation looks reasonable; @lobo should check the edge cases.
```

Examples that do not create a handoff:

```text
@both please review this.
@all should see the final summary.
I am @gemini, so I should not hand this to myself.
```

The first valid tag for the other council member creates a pending handoff. `@both`, `@all`, `@council`, unknown tags, and self-tags are ignored for bot-to-bot handoffs. Council Bridge creates a pending handoff instead of sending automatically. The side panel shows a Human Gavel notice with:

- `Approve handoff`
- `Reject handoff`
- `Approve next 1 turn`
- `Approve next 3 turns`

`Approve handoff` sends only the current pending handoff. `Approve next 1 turn` and `Approve next 3 turns` grant a short bot-to-bot budget so the next tagged assistant replies can continue automatically until the budget or safety limit is reached.

The approval actions remain disabled while the destination agent is responding, disconnected, stale, already has a queued send, or has no new handoff context. The panel checks readiness continuously and enables and flashes the approval action only when the handoff can be sent. Reject remains available whenever a handoff is pending.

The default bot-to-bot safety limit is 3 turns. When the limit is reached, Council Bridge stops routing and waits for the Human Gavel. Any new Christopher message resets the bot-to-bot turn count.

Handoffs are blocked if the target member is stale, disconnected, or not assigned to the current council session.

### Capture Replies

Completed ChatGPT and Gemini replies are added automatically after their visible response text stops changing.

Use `Refresh replies` to manually pull the latest visible reply from both registered council agents. It refreshes ChatGPT and Gemini, not random tabs.

Use `Add selection` to add highlighted text from the active council tab to the side panel without sending it anywhere.

Use `Pass selected reply to other AI` to capture highlighted text from the active council tab and send it to the other registered council agent.

### Pause and Reset

Use `Pause capture` if you want to inspect an unrelated tab or conversation without collecting new AI replies. While paused, automatic reply capture and manual reply refresh do not add turns.

Use `Remove tab` while a council tab is active to remove that member from the current council session.

Use `Clear` to clear the side panel transcript and delivery cursors. This does not clear the real ChatGPT or Gemini conversations.

### Timestamps and Transcript

Every side panel turn shows a millisecond timestamp. Prompt payloads sent to ChatGPT or Gemini include those timestamps too, so test runs can be traced precisely.

The side panel transcript stores only text Council Bridge captures, refreshes, or sends. It does not scrape full conversations.

The Gemini-to-ChatGPT wrapped prompt uses this format:

```text
[Council Bridge]
Source: Gemini
Target: ChatGPT

Gemini said:

--- BEGIN GEMINI MESSAGE ---
Selected text
--- END GEMINI MESSAGE ---

ChatGPT, please respond to Christopher and Gemini. Agree, disagree, refine the plan, and turn it into concrete next steps.
```

## Known Limitations

- Does not scrape full conversations
- The side panel conversation view only stores snippets you explicitly pass or type
- Only conversations assigned as ChatGPT or Gemini in the active council session participate
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
