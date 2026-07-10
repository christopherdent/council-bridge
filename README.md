# Council Bridge

Council Bridge is a tiny Chrome and Edge extension for coordinating assigned ChatGPT and Gemini browser tabs from a persistent side panel. It tracks typed human turns and captured assistant replies, wraps unseen turns in direction-specific prompts, inserts them into the target service, and clicks send from the side panel.

The extension uses a persistent side panel instead of a toolbar dropdown. Existing ChatGPT and Gemini tabs receive prompts through the assigned Council conversations. While a reply is outstanding, Council Bridge keeps the expected responder active and selectively reactivates only responders whose output has stopped progressing. When the replies finish, it restores the prior non-Council tab when doing so will not override a tab you selected yourself. The side panel shows text you write as yourself, latest replies you refresh, and automatically captured completed AI replies. Every side panel turn shows a millisecond timestamp, and prompts include the same turn timestamp for testing and traceability.

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

`User`, `ChatGPT`, and `Gemini` are the default names. Use the nickname fields in the side panel to rename yourself or either council member for transcript display and prompt wording.

Nicknames can also be used as route tags. For example, if ChatGPT is nicknamed `Lobo`, then `@lobo` routes only to ChatGPT. Built-in aliases still work:

- ChatGPT: `@chatgpt`, `@gpt`, `@lobo`
- Gemini: `@gemini`, `@gem`
- Both: `@both`, `@all`, `@council`

When Council Bridge sends to an agent, it includes every transcript turn that agent has not seen since it was last advised. It does not resend the whole transcript every time.

If an agent is still responding, Council Bridge queues that agent's next send for up to five minutes. It waits in the side panel without holding the browser on the target tab, then batches all still-unseen turns and submits them when the composer becomes available. Sends to the same agent run one at a time so rapid messages cannot race in the target composer.

After a prompt is submitted, the destination becomes an expected responder. Council Bridge keeps that tab active in its window while the reply is being generated. If multiple expected responders share one window, it rotates attention only when an inactive responder has stopped making progress; it does not cycle unrelated tabs. This is a best-effort workaround for browser background-page throttling.

The first send to an agent also includes a short Council Bridge overview and a link to this README, so a fresh conversation knows that the configured human user is coordinating ChatGPT and Gemini through the side panel. The first send bundles three things:

- the Council Bridge overview,
- routing and handoff context (`@chatgpt`, `@gemini`, `@both`, and nickname tags are Council Bridge routing hints, and how bot-to-bot handoffs are gated by the Human Gavel),
- a target-specific Council Agent Disposition.

The disposition sets each agent up as an independent engineering peer rather than an agreement machine: it asks for productive friction, an anti-echo protocol (explore, critique, separate evidence from speculation, and openly concede when new evidence changes a conclusion), and keeps the configured human user as the primary systems engineer and final decision-maker. The cognitive role differs by agent — Gemini is pointed at macro-scale architecture, cross-disciplinary synthesis, and scaling; ChatGPT is pointed at rigorous decomposition, deterministic validation, hidden assumptions, and edge cases. Role selection is keyed to the actual target (ChatGPT vs. Gemini), not its nickname. The disposition ships only with the first-send overview; later incremental sends do not repeat it.

### Roundtable Mode

Enable `Roundtable mode` in Council setup when you want a group message to run sequentially instead of in parallel.

With Roundtable mode off, Council Bridge is in Fluid mode: group messages are submitted to both members without imposing a response order, and whichever completed reply is captured first appears first.

In Roundtable mode, a group send goes to one council member first. When that reply is captured, Council Bridge sends the still-unseen context to the other member, so the second response includes the human user's message plus the first agent's answer. The starting member alternates each round.

Single-member route tags still send directly to that member. Bot-to-bot Human Gavel handoffs still work for normal assistant replies outside the active Roundtable pass.

Enable `Have at it` under Roundtable mode to let the two agents continue the same topic for a bounded number of alternating turns without requiring tags or Human Gavel approval between turns. Set the turn count from 2 through 10. The starting member still alternates between separate Roundtables, each transaction has one deterministic expected responder at a time, and the final autonomous turn is instructed to synthesize the strongest conclusion, remaining disagreement, and next step for the human user.

Typing a new human message, turning Roundtable mode off, or clearing the conversation stops an in-progress autonomous Roundtable. `Have at it` is separate from ordinary bot-to-bot tagged handoffs and does not consume their approval budget.

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
- `Approve next 10 turns`

`Approve handoff` sends only the current pending handoff. `Approve next 1 turn`, `Approve next 3 turns`, and `Approve next 10 turns` grant a bot-to-bot budget so the next tagged assistant replies can continue automatically until the budget or safety limit is reached.

The approval actions remain disabled while the destination agent is responding, disconnected, stale, already has a queued send, or has no new handoff context. The panel checks readiness continuously and enables and flashes the approval action only when the handoff can be sent. Reject remains available whenever a handoff is pending.

The default bot-to-bot safety limit is 3 turns. When the limit is reached, Council Bridge stops routing and waits for the Human Gavel. Any new human message resets the bot-to-bot turn count.

Handoffs are blocked if the target member is stale, disconnected, or not assigned to the current council session.

### Capture Replies

Completed ChatGPT and Gemini replies are added automatically after their visible response text stops changing.

Use `Refresh replies` to manually pull the latest visible reply from both registered council agents. It refreshes ChatGPT and Gemini, not random tabs.

Use `New GPT` or `New Gem` in Council setup when a ChatGPT or Gemini tab gets slow. Council Bridge opens a fresh tab, assigns it as that council member, and seeds it with a bounded recent-context packet so it can rejoin the wider discussion. The seed prompt is intentionally compact; it asks the agent to acknowledge that it is caught up rather than replaying the whole transcript.

`Recover stalled replies` performs the same replacement automatically when an expected responder produces no captured reply for the selected 5, 7, or 10 minute timeout. Recovery makes one attempt for that outstanding reply: it opens a fresh inactive tab, replaces only the stalled member's routing address, seeds recent Council context, and asks the replacement to answer the latest outstanding request. If the replacement also stalls, Council Bridge stops after the hard timeout instead of opening tabs indefinitely.

### Active Page Context

Use the paperclip button above the composer to attach the currently active non-chat web page to your next message. Council Bridge asks for access to that site's origin when needed, then captures the page title, URL, selected text, and a bounded visible-text excerpt. The attachment appears beside the button and can be removed before sending.

Page context is explicit and one-shot: it is attached only after you click the button, it is sent only with the next human turn, and it is then cleared from the composer. ChatGPT and Gemini conversation tabs cannot be attached this way because their messages already flow through the Council transcript. Browser internal pages such as `chrome://` cannot be captured.

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

ChatGPT, please respond to the user and Gemini. Agree, disagree, refine the plan, and turn it into concrete next steps.
```

## Known Limitations

- Does not scrape full conversations
- The side panel conversation view only stores typed turns, sent prompts, manually refreshed replies, and automatically captured completed replies
- Only conversations assigned as ChatGPT or Gemini in the active council session participate
- Side panel send actions try to click send
- Auto-submit depends on finding an enabled send button
- Refresh replies uses best-effort selectors for the latest visible ChatGPT and Gemini response
- Automatic reply capture waits for best-effort response stability and stop-button detection
- Expected-responder activation changes the visible tab when Council agents share the current browser window; this is intentional and the prior tab is restored after replies finish when safe
- Browser throttling is controlled by Chrome and cannot be disabled by an extension; targeted activation substantially reduces stalls but remains a best-effort workaround
- Automatic stalled-reply recovery requires the side panel to remain open because its reply watcher owns the timeout
- Active-page context is limited to normal HTTP(S) pages for which the user grants site access
- Prompt box selectors may need updates if ChatGPT or Gemini changes their UI

## Files

- `manifest.json` defines the Manifest V3 extension, permissions, target hosts, side panel, background worker, and content script.
- `background.js` opens the side panel, reconciles Council membership, and performs short tab activation and focus operations.
- `sidepanel.html` provides the persistent side panel UI.
- `sidepanel.js` handles the transcript, unseen-turn batching, typed composer, expected-responder attention, stalled-chat recovery, page-context attachments, handoffs, and UI orchestration.
- `orchestration.js` contains the deterministic, bounded Roundtable transaction strategy shared by the side panel, background worker, and tests.
- `routing.js` contains the shared routing-tag parser used by the side panel and regression tests.
- `content.js` captures the latest visible reply and inserts text into visible prompt boxes.

## Tests

Run routing parser regressions with:

```bash
node --test test/routing.test.js
```

Run Roundtable orchestration regressions with:

```bash
node --test test/orchestration.test.js
```
