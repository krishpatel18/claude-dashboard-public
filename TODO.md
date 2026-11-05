# To do

Ideas and follow-ups, not started. Newest first.

## One-click sharing between chats (2026-10-21)

**Context.** Passing a finding from one chat to another already works without the dashboard: in chat A, type `send your latest finding to @<chat name>` (typing `@` lists open chats). A summarizes and sends it; B starts a turn with it if idle, or reads it between steps if busy. B knows it came from another chat, not from you, so it can't approve permissions or change settings because of it. Messages can be *held* for your OK in B's terminal (expires after 5 minutes) depending on permission modes; `/config` → "Messages from your other sessions" sets accept / hold / refuse. Docs: https://code.claude.com/docs/en/cross-session-messaging.md

Decided against a standalone "connector" agent: it would spend tokens re-reading A's conversation to guess the finding, which A already knows, and it duplicates a built-in feature.

**Build only if typing into A keeps feeling like friction.** Two options:

1. **"Share with group" on a tile (preferred).** One click asks chat A to summarize its latest finding and send it to the other chats in the same dashboard group (A doesn't know about groups; the dashboard does). Costs one turn of A's tokens per share.
2. **"Send this reply to…".** Copies A's last reply word for word into B, editable first. Free and instant, but raw text, not a summary.

**Both need** the dashboard to post a message into a chat through its inbox socket (the session record's `messagingSocketPath`, token in `CLAUDE_CODE_MESSAGING_TOKEN`). The docs say it's meant for scripts and hooks, but don't document the message format after the optional auth line. Test that first in a scratch chat, the way the approval hook was tested.

## Code health follow-ups (from the review passes)

- **One refresh scheduler with a seam at the file watcher** (Strong). `refresh`, `schedule`, the startup re-check, the 30 s sweep and re-arming are five ways into one behaviour, and `fs.watch` can't be swapped in tests. Two timing tests pass for the wrong reason because of it: "a chat that never stops writing…" passes without the max-wait rule, and "a chat that opens the moment the dashboard starts…" never needs the startup re-check.
- **One chat-status module shared by server and page.** "Working = busy or shell", "needs you" and their labels are spelled separately in `src/chats.js`, `public/app.js` and `public/style.css`.
- **Page logic in importable modules so it can be tested:** markdown and escaping, the conversation append/reset handling, number and time formatting.
- **"400 messages" is written in three places** (`src/chats.js`, `src/transcript.js`, `public/app.js`).
- **Deny from the dashboard** is covered by tests but hasn't been tried live.
