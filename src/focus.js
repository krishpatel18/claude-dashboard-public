import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appInfo, describeApp } from './apps.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CURSOR_STORAGE = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/storage.json');

// Selects the Terminal tab on the tty given as the script's argument.
const TERMINAL_SCRIPT = `
on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

// Opens a Terminal window in a folder and resumes a chat there; both come in
// as arguments and are quoted by AppleScript, never pasted into the script.
const RESUME_SCRIPT = `
on run argv
  set dir to item 1 of argv
  set sid to item 2 of argv
  tell application "Terminal"
    do script "cd " & quoted form of dir & " && claude --resume " & quoted form of sid
    activate
  end tell
end run`;

async function runCommand(file, args) {
  const { stdout } = await execFileAsync(file, args, { timeout: 10_000 });
  return stdout.trim();
}

// Brings a chat's window to the front: Terminal by tab, Cursor by workspace
// window, other terminal apps by name. For Cursor it trusts Cursor's own record
// of its open windows, which Cursor rewrites while running; with no match it
// only activates Cursor. `run(file, args)` is the command adapter; it resolves
// to stdout.
export function createFocus({ run = runCommand, cursorStoragePath = DEFAULT_CURSOR_STORAGE } = {}) {
  return {
    async bringToFront(chat) {
      const { cannotFocus } = describeApp(chat);
      if (cannotFocus) return { ok: false, reason: cannotFocus };
      const app = appInfo(chat.app);
      try {
        if (app.id === 'terminal') {
          const out = await run('osascript', ['-e', TERMINAL_SCRIPT, `/dev/${chat.tty}`]);
          return out === 'ok' ? { ok: true } : { ok: false, reason: 'Its Terminal tab is no longer open.' };
        }
        if (app.id === 'cursor') {
          const workspace = await cursorWorkspaceFor(chat.folder, cursorStoragePath);
          await run('open', workspace ? ['-a', 'Cursor', workspace] : ['-a', 'Cursor']);
          return workspace ? { ok: true } : { ok: true, note: 'Brought Cursor forward, but couldn\u2019t tell which of its windows this chat is in.' };
        }
        await run('open', ['-a', app.openName]);
        return { ok: true, note: `Brought ${app.label} forward; it can\u2019t be told which tab or window to show.` };
      } catch (err) {
        return { ok: false, reason: explain(err, app.label) };
      }
    },
    // Reopens a closed chat (e.g. one paused with bye-bye) in a new Terminal window.
    async resume({ sessionId, folder }) {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return { ok: false, reason: 'That session id doesn\u2019t look right.' };
      try {
        if (typeof folder !== 'string' || !folder.startsWith('/') || !(await stat(folder)).isDirectory()) throw new Error();
      } catch {
        return { ok: false, reason: `Its folder ${folder ?? ''} is no longer there.` };
      }
      try {
        await run('osascript', ['-e', RESUME_SCRIPT, folder, sessionId]);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: explain(err, 'Terminal') };
      }
    },
  };
}

// A failed osascript/open as something a person can act on.
function explain(err, label) {
  const stderr = String(err?.stderr ?? '').trim();
  if (/-1743|Not authorized to send Apple events/i.test(stderr)) {
    return `macOS blocked the dashboard from controlling ${label}. Allow it in System Settings → Privacy & Security → Automation, under the app you started the dashboard from.`;
  }
  if (err?.killed || err?.signal === 'SIGTERM') {
    return `${label} didn\u2019t answer within 10 seconds. If macOS is asking whether to allow control of ${label}, answer that and try again.`;
  }
  const first = (stderr || String(err?.message ?? err)).split('\n')[0].slice(0, 200);
  return `Couldn\u2019t bring it forward: ${first}`;
}

// The open Cursor workspace folder containing `folder`, the deepest one if
// several do. Reopening a folder Cursor already has open focuses that window.
async function cursorWorkspaceFor(folder, storagePath) {
  if (!folder) return null;
  let state;
  try {
    state = JSON.parse(await readFile(storagePath, 'utf8')).windowsState ?? {};
  } catch {
    return null;
  }
  const windows = [state.lastActiveWindow, ...(state.openedWindows ?? [])];
  const folders = windows.map((w) => toPath(w?.folder)).filter(Boolean);
  const containing = folders.filter((f) => folder === f || folder.startsWith(f.endsWith(sep) ? f : f + sep));
  return containing.sort((a, b) => b.length - a.length)[0] ?? null;
}

function toPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
