# claude-dashboard

One browser page showing every Claude Code chat open on this Mac, as a grid of tiles. Click a tile to read its conversation; press "Go to" to bring that chat's Terminal tab or Cursor window to the front. Tiles appear and disappear as chats open and close.

```sh
npm start            # prints the link to open
PORT=5000 npm start  # another port
npm test
```

Node 22 or newer, no dependencies.

**macOS only.** It reads Claude Code's own files and uses Terminal/Cursor to bring windows forward.

## Setup

1. Clone this repo and run `npm start`. That alone gives you the tiles, the conversations, Go to, groups and alerts.
2. **Plan usage (optional).** Copy the status-line wrapper and make it runnable:
   ```sh
   cp hooks/statusline-with-usage.sh ~/.claude/statusline-with-usage
   chmod +x ~/.claude/statusline-with-usage
   ```
   Then in `~/.claude/settings.json` set (put your own status-line command after the wrapper, or leave it off for none):
   ```json
   "statusLine": { "type": "command", "command": "$HOME/.claude/statusline-with-usage ~/.claude/my-statusline.sh" }
   ```
   Needs `jq` (`which jq` shows whether you have it; otherwise `brew install jq`). To undo, set `statusLine.command` back to your own status-line command.
3. **Approving from the dashboard (optional).** Copy the permission hook:
   ```sh
   cp hooks/permission-request.sh ~/.claude/dashboard-permission-hook
   chmod +x ~/.claude/dashboard-permission-hook
   ```
   Then add to `~/.claude/settings.json`:
   ```json
   "hooks": { "PermissionRequest": [ { "matcher": "*", "hooks": [
     { "type": "command", "command": "$HOME/.claude/dashboard-permission-hook", "timeout": 600 } ] } ] }
   ```
   (Merge it into your existing `hooks` block if you have one.) Start a new Claude Code chat for settings changes to apply.

**First visit in a browser:** `npm start` prints a link like `http://localhost:4317/#pair=…`. Open it once: the page trades that one-time code for the dashboard's key and keeps the key, so from then on plain `http://localhost:4317` works in that browser. Each printed link works once, so it's useless if it lingers in browser history or a log; restart the dashboard to get a new one for another browser. The key itself lives in `~/.config/claude-dashboard/key` (readable only by you) and stays the same across restarts; delete that file to make a new one, which signs out every browser.

**Who can read it:** it listens on 127.0.0.1 only. Chat data needs the key, so other programs on the Mac, containers, and other websites open in your browser can't read your conversations or move your windows.

## Usage and alerts

**Plan usage** (top right): how much of your 5-hour and weekly Claude limits is used, the same figures `/usage` shows, plus the tokens chats on this Mac used in the last 5 hours. Each tile shows what that chat (and its subagents) used in the last 5 hours; hover for the 7-day figure. Tokens count input + cache writes + output, not cache reads.

The plan figures come from Claude Code's status line, which receives them on every redraw. A small wrapper, `~/.claude/statusline-with-usage` (from `hooks/statusline-with-usage.sh`, see Setup), saves them to `~/.claude/dashboard/usage.json` (readable only by you) and passes everything on to your own status line unchanged. They are as fresh as the last time any Claude chat redrew its status line; when that's more than 15 minutes ago the header says "as of …". Without the wrapper the header shows only this Mac's token counts.

**Done alerts:** when a chat stops working, its tile gets a **Done** badge until you open it, the header counts finished chats, and the tab title shows ✓ and the count. Press **Turn on alerts** once to also get a Mac notification when a chat finishes or starts needing you, while the dashboard tab isn't in front; clicking the notification opens that chat.

## Views

Under the header: **All** or **Active** (chats that need you, are working, or finished and haven't been opened yet), and **Per screen**: All, or 4, 6, 8, 10, 12 or 16 tiles filling the window like a video-call gallery, with ‹ › (or the arrow keys) to page through. The choice is remembered in the browser.

## Approving from the dashboard

When a chat asks for permission, its tile turns amber and shows what it wants to do (the command, file or tool input) with **Allow once**, **Always allow** and **Deny**; the same panel shows in the open-chat view, and with alerts on you get a notification. The terminal still shows its usual prompt at the same time, and **whichever you answer first wins; if you answer in the terminal, the dashboard's request disappears**. **Always allow** applies the same lasting rule the terminal's "Yes, and always allow…" option would (a rule or a folder), never a permission-mode change, and only appears when Claude Code offers one.

How: Claude Code runs a `PermissionRequest` hook, `~/.claude/dashboard-permission-hook` (a copy of `hooks/permission-request.sh`), set in `~/.claude/settings.json` under `hooks.PermissionRequest`. It sends the request to the dashboard (address in `~/.config/claude-dashboard/url`, using the key) and waits for your answer; if the dashboard isn't running or no dashboard page is open, it steps aside at once and only the terminal prompt applies. To turn it off, remove that `PermissionRequest` entry.

## Paused and ended chats

**Closed** (next to All and Active) lists chats closed in the last 7 days, newest first, in two groups: **Paused**, the ones you wrapped up by typing bye-bye and haven't continued, and **Ended**, everything else. **Resume** opens a new Terminal window in the chat's folder running `claude --resume`, back in that conversation. A chat that used bye-bye but is still open gets a **Paused** badge until you type in it again. Paused lists open chats too, marked "still open" with Go to. Detection reads the transcripts: you typed bye-bye ("bye-bye", "bye bye", "byebye" or `/bye-bye`, alone in a message) or a skill named bye-bye ran, and nothing was typed after it.

## Messaging between chats

Each tile (and the open-chat header) shows the chat's **@name**, the name Claude Code uses for messaging between chats. Click it to copy, then in another chat type something like `send your latest finding to @subkonshis-c8`. To get shorter names, run `/rename <name>` inside a chat (this is separate from the name you give a chat on the dashboard). See TODO.md for the one-click sharing ideas.

## Groups and names

Press **+ New group** to make a group, then drag tiles onto it (or use the group menu in each tile's title row). Each group is a section you can collapse; double-click or use **Rename** to rename it, and **Delete** moves its chats back to Ungrouped. Double-click a chat's title to give it your own name (empty brings back Claude's). With a fixed number per screen, a group picker pages through one group at a time. The side list and `[`/`]` follow the same groups and order.

Groups and names live in `~/.config/claude-dashboard/groups.json` (readable only by you), remembered per Claude session: a chat that's cleared or restarted as a new session goes back to Ungrouped. Chats not seen open for 30 days are forgotten.

## Keys

| Key | Does |
|---|---|
| `1`–`9` | Open that tile (on the current page) |
| `←` / `→` | Previous / next page, when showing a fixed number per screen |
| `[` / `]` | Previous / next chat |
| `G` | Bring the open chat's window to the front |
| `/` | Filter by title or folder |
| `Esc` | Back to the grid |

## How it knows

- **Which chats are open:** Claude Code writes one record per running chat to `~/.claude/sessions/<pid>.json`. A record counts only while its process is alive and started at the recorded time (so a reused pid doesn't count).
- **What they say:** each chat's transcript, `~/.claude/projects/<folder>/<sessionId>.jsonl`, read as it grows. Titles are the name you gave the chat, else Claude's AI title, else the first prompt. The conversation view shows the latest 400 messages.
- **Order:** chats that need you first, then ones that are working, then the rest; within each, the most recent activity first. Tiles move as chats start and stop working.
- **Where they run:** the chat's parent processes (Terminal, Cursor, Ghostty, iTerm, VS Code, Warp, or a background agent).
- **When things change:** file-system events on both folders, pushed to the page over server-sent events. A full re-check every 30 seconds catches chats that crashed without removing their record.

## Limits

- **Cursor:** "Go to" opens the Cursor window whose workspace contains the chat's folder, using Cursor's own list of open windows. It can't pick the terminal panel inside that window. If no workspace matches, it only brings Cursor forward.
- **Background chats** (started from `claude agents`) have no window; open them from `claude agents`.
- **No replying from the page** and no live terminal mirroring (macOS doesn't allow reading another app's screen).
- `CLAUDE_CONFIG_DIR` is honoured if you've moved `~/.claude`.
