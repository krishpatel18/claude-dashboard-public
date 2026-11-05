import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway ~/.claude: sessions/ for the registry, projects/ for transcripts.
export function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'claude-dashboard-'));
  const sessionsDir = join(root, 'sessions');
  const projectsDir = join(root, 'projects');
  mkdirSync(sessionsDir);
  mkdirSync(projectsDir);
  return {
    root,
    sessionsDir,
    projectsDir,
    writeSession(record) {
      writeFileSync(join(sessionsDir, `${record.pid}.json`), JSON.stringify(record));
    },
    removeSession(pid) {
      rmSync(join(sessionsDir, `${pid}.json`));
    },
    transcriptPath(cwd, sessionId) {
      const dir = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      return join(dir, `${sessionId}.jsonl`);
    },
    writeTranscript(cwd, sessionId, entries) {
      writeFileSync(this.transcriptPath(cwd, sessionId), entries.map((e) => JSON.stringify(e) + '\n').join(''));
    },
    appendTranscript(cwd, sessionId, entries) {
      appendFileSync(this.transcriptPath(cwd, sessionId), entries.map((e) => JSON.stringify(e) + '\n').join(''));
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
export const CURSOR_PTY = '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper --type=utility --utility-sub-type=node.mojom.NodeService';

// The process adapter: a fixed table standing in for `ps`.
export function fakeProcesses(rows) {
  const table = new Map();
  const add = (row) => table.set(row.pid, { ppid: 1, tty: '??', started: '', command: '', ...row });
  add({ pid: 1, ppid: 0, command: '/sbin/launchd' });
  rows.forEach(add);
  return {
    table,
    add,
    remove: (pid) => table.delete(pid),
    snapshot: async () => new Map(table),
  };
}

// A claude process inside a Terminal tab, with its login shell between.
export function terminalChat(procs, { pid, tty = `ttys0${pid % 100}`, started = 'Mon Oct  5 14:40:41 2026' }) {
  procs.add({ pid: 500, ppid: 1, command: TERMINAL });
  procs.add({ pid: pid - 2, ppid: 500, command: 'login -pf krish', tty });
  procs.add({ pid: pid - 1, ppid: pid - 2, command: '-zsh', tty });
  procs.add({ pid, ppid: pid - 1, command: 'claude', tty, started });
}

export function session(overrides) {
  return {
    pid: 1000,
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
    cwd: '/Users/krish',
    startedAt: 1791211249570,
    procStart: 'Mon Oct  5 14:40:41 2026',
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'krish-61',
    nameSource: 'derived',
    status: 'idle',
    updatedAt: 1791212226035,
    statusUpdatedAt: 1791212226035,
    ...overrides,
  };
}

export const user = (text, extra = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  timestamp: '2026-10-19T15:00:00.000Z',
  ...extra,
});

export const assistantText = (text, extra = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  timestamp: '2026-10-19T15:00:05.000Z',
  ...extra,
});

export const toolUse = (name, input) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
  timestamp: '2026-10-19T15:00:06.000Z',
});

export const toolResult = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
  timestamp: '2026-10-19T15:00:07.000Z',
});

export const aiTitle = (title) => ({ type: 'ai-title', aiTitle: title });

export function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        return reject(err);
      }
      if (value) return resolve(value);
      if (Date.now() - start > timeout) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, interval);
    };
    tick();
  });
}
