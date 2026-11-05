import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openChats } from '../src/chats.js';
import {
  makeHome, fakeProcesses, terminalChat, session, user, assistantText, toolUse, toolResult, aiTitle,
  waitFor, CURSOR_PTY,
} from './fixtures.js';

let home;
let procs;
let chats;

beforeEach(() => {
  home = makeHome();
  procs = fakeProcesses([]);
});

afterEach(() => {
  chats?.close();
  chats = undefined;
  home.cleanup();
});

const open = async (opts = {}) => {
  chats = await openChats({
    sessionsDir: home.sessionsDir,
    projectsDir: home.projectsDir,
    processes: procs,
    sweepMs: 60_000,
    debounceMs: 20,
    settleMs: 30,
    ...opts,
  });
  return chats;
};

test('lists a live Terminal chat with its title, folder, status and last message', async () => {
  terminalChat(procs, { pid: 1000, tty: 'ttys011' });
  home.writeSession(session({ pid: 1000, cwd: '/Users/krish/proj', status: 'busy' }));
  home.writeTranscript('/Users/krish/proj', session().sessionId, [
    user('fix the login bug'),
    aiTitle('Fix login bug'),
    assistantText('Looking at the login form now.'),
  ]);

  const [chat, ...rest] = (await open()).list();

  assert.equal(rest.length, 0);
  assert.equal(chat.id, '1000');
  assert.equal(chat.title, 'Fix login bug');
  assert.equal(chat.folder, '/Users/krish/proj');
  assert.equal(chat.app, 'terminal');
  assert.equal(chat.tty, 'ttys011');
  assert.equal(chat.status, 'busy');
  assert.deepEqual(chat.recent, [
    { role: 'user', text: 'fix the login bug', at: '2026-10-19T15:00:00.000Z' },
    { role: 'assistant', text: 'Looking at the login form now.', at: '2026-10-19T15:00:05.000Z' },
  ]);
});

test('leaves out a chat whose process has exited, even though its record file remains', async () => {
  home.writeSession(session({ pid: 1000 }));
  assert.deepEqual((await open()).list(), []);
});

test('leaves out a chat whose pid now belongs to a different, newer process', async () => {
  terminalChat(procs, { pid: 1000, started: 'Tue Oct 20 09:00:00 2026' });
  home.writeSession(session({ pid: 1000, procStart: 'Mon Oct  5 14:40:41 2026' }));
  assert.deepEqual((await open()).list(), []);
});

test('matches start times regardless of how the day is padded', async () => {
  terminalChat(procs, { pid: 1000, started: 'Mon Oct  5 14:40:41 2026' });
  home.writeSession(session({ pid: 1000, procStart: 'Mon Oct 5 14:40:41 2026' }));
  assert.equal((await open()).list().length, 1);
});

test('each chat says what its app is called and, if its window can\'t be brought forward, why', async () => {
  terminalChat(procs, { pid: 1000, tty: 'ttys011' });
  procs.add({ pid: 3000, ppid: 1, command: 'claude', tty: 'ttys030' });
  home.writeSession(session({ pid: 1000, sessionId: 'a', startedAt: 2 }));
  home.writeSession(session({ pid: 3000, sessionId: 'b', kind: 'bg', procStart: undefined, startedAt: 1 }));

  const [terminal, background] = (await open()).list();

  assert.equal(terminal.appLabel, 'Terminal');
  assert.equal(terminal.cannotFocus, null);
  assert.equal(background.appLabel, 'Background');
  assert.match(background.cannotFocus, /claude agents/);
});

test('a background chat is recognised from its record alone, and from its parent process alone', async () => {
  procs.add({ pid: 700, ppid: 1, command: '/Users/krish/.local/bin/claude daemon run' });
  procs.add({ pid: 3000, ppid: 1, command: 'claude', tty: 'ttys030' });
  procs.add({ pid: 4000, ppid: 700, command: 'claude', tty: 'ttys040' });
  home.writeSession(session({ pid: 3000, sessionId: 'a', kind: 'bg', procStart: undefined }));
  home.writeSession(session({ pid: 4000, sessionId: 'b', kind: 'interactive', procStart: undefined }));

  const apps = Object.fromEntries((await open()).list().map((c) => [c.id, c.app]));

  assert.deepEqual(apps, { 3000: 'background', 4000: 'background' });
});

test('says which app a chat lives in', async () => {
  procs.add({ pid: 600, ppid: 1, command: '/Applications/Cursor.app/Contents/MacOS/Cursor' });
  procs.add({ pid: 601, ppid: 600, command: CURSOR_PTY });
  procs.add({ pid: 602, ppid: 601, command: '/bin/zsh -il', tty: 'ttys020' });
  procs.add({ pid: 2000, ppid: 602, command: 'claude', tty: 'ttys020' });
  procs.add({ pid: 700, ppid: 1, command: '/Users/krish/.local/bin/claude daemon run --origin transient' });
  procs.add({ pid: 3000, ppid: 700, command: 'claude bg-spare --bg-spare /tmp/x.sock', tty: 'ttys030' });
  procs.add({ pid: 800, ppid: 1, command: '/Applications/Ghostty.app/Contents/MacOS/ghostty' });
  procs.add({ pid: 4000, ppid: 800, command: 'claude', tty: 'ttys040' });
  procs.add({ pid: 5000, ppid: 1, command: 'claude', tty: 'ttys050' });
  home.writeSession(session({ pid: 2000, procStart: undefined, startedAt: 5 }));
  home.writeSession(session({ pid: 3000, procStart: undefined, kind: 'bg', startedAt: 4 }));
  home.writeSession(session({ pid: 4000, procStart: undefined, startedAt: 3 }));
  home.writeSession(session({ pid: 5000, procStart: undefined, startedAt: 2 }));

  const apps = Object.fromEntries((await open()).list().map((c) => [c.id, c.app]));

  assert.deepEqual(apps, { 2000: 'cursor', 3000: 'background', 4000: 'ghostty', 5000: 'other' });
});

test('each chat carries the name other chats use to message it', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000, name: 'subkonshis-outlook-fixes-f4' }));
  const [chat] = (await open()).list();
  assert.equal(chat.handle, 'subkonshis-outlook-fixes-f4');
});

test('titles fall back from a name the user set, to the AI title, to the first prompt, to the registry name', async () => {
  for (const pid of [1000, 2000, 3000, 4000]) terminalChat(procs, { pid });
  const ids = { 1000: 'a', 2000: 'b', 3000: 'c', 4000: 'd' };
  for (const [pid, sid] of Object.entries(ids)) {
    home.writeSession(session({ pid: Number(pid), sessionId: sid, name: `name-${pid}`, startedAt: Number(pid) }));
  }
  home.writeSession(session({ pid: 1000, sessionId: 'a', name: 'My renamed chat', nameSource: 'user', startedAt: 1000 }));
  home.writeTranscript('/Users/krish', 'a', [aiTitle('AI title A')]);
  home.writeTranscript('/Users/krish', 'b', [user('first prompt B'), aiTitle('old title'), aiTitle('AI title B')]);
  home.writeTranscript('/Users/krish', 'c', [
    user('<command-name>/clear</command-name>', { isMeta: true }),
    user('<system-reminder>ignore me</system-reminder>  '),
    user('  what is   the plan?  '),
  ]);

  const titles = Object.fromEntries((await open()).list().map((c) => [c.id, c.title]));

  assert.deepEqual(titles, {
    1000: 'My renamed chat', 2000: 'AI title B', 3000: 'what is the plan?', 4000: 'name-4000',
  });
});

test('a tile keeps only the last twelve messages, newest last', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  const texts = Array.from({ length: 14 }, (_, i) => `m${i + 1}`);
  home.writeTranscript('/Users/krish', session().sessionId, texts.map((t) => assistantText(t)));

  const [chat] = (await open()).list();

  assert.deepEqual(chat.recent.map((m) => m.text), texts.slice(2));
});

test('a tool call shows as the latest line, a tool result does not', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [
    user('run the tests'),
    toolUse('Bash', { command: 'npm test', description: 'Run the test suite' }),
    toolResult('42 passing'),
  ]);

  const [chat] = (await open()).list();

  assert.deepEqual(chat.recent.at(-1), { role: 'tool', text: 'Bash: Run the test suite', at: '2026-10-19T15:00:06.000Z' });
});

test('slash commands read as the command the user typed', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [
    user('<command-message>autonomous</command-message>\n<command-name>/autonomous</command-name>\n<command-args>go and push</command-args>'),
  ]);

  const [chat] = (await open()).list();

  assert.equal(chat.title, '/autonomous go and push');
  assert.equal(chat.recent.at(-1).text, '/autonomous go and push');
});

test('reads only what was appended, including a line that was half-written last time', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  const path = home.transcriptPath('/Users/krish', session().sessionId);
  const line = JSON.stringify(assistantText('second reply'));
  writeFileSync(path, JSON.stringify(assistantText('first reply')) + '\n' + line.slice(0, 20));

  await open();
  assert.equal(chats.list()[0].recent.at(-1).text, 'first reply');

  appendFileSync(path, line.slice(20) + '\n');
  await chats.refresh();
  assert.equal(chats.list()[0].recent.at(-1).text, 'second reply');
});

test('rereads a transcript that was rewritten shorter', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [assistantText('a long first reply '.repeat(20))]);
  await open();

  home.writeTranscript('/Users/krish', session().sessionId, [assistantText('short')]);
  await chats.refresh();

  assert.equal(chats.list()[0].recent.at(-1).text, 'short');
});

test('skips a record file that is mid-write instead of failing', async () => {
  terminalChat(procs, { pid: 1000 });
  writeFileSync(join(home.sessionsDir, '1000.json'), '{"pid": 1000, "sessi');
  assert.deepEqual((await open()).list(), []);
});

test('chats needing you come first, then working ones, then the rest; most recent activity first within each', async () => {
  for (const pid of [1000, 2000, 3000, 4000, 5000, 6000]) terminalChat(procs, { pid });
  const at = (minute) => `2026-10-20T09:${String(minute).padStart(2, '0')}:00.000Z`;
  const ms = (minute) => Date.parse(at(minute));
  const chat = (pid, sid, status, extra = {}) => home.writeSession(session({ pid, sessionId: sid, status, startedAt: ms(0), updatedAt: ms(1), ...extra }));
  chat(1000, 'a', 'idle');
  chat(2000, 'b', 'waiting');
  chat(3000, 'c', 'busy');
  chat(4000, 'd', 'idle');
  chat(5000, 'e', 'shell');
  chat(6000, 'f', 'idle', { updatedAt: ms(30) }); // no messages, but its status changed recently
  home.writeTranscript('/Users/krish', 'a', [assistantText('old', { timestamp: at(5) })]);
  home.writeTranscript('/Users/krish', 'c', [assistantText('busy', { timestamp: at(10) })]);
  home.writeTranscript('/Users/krish', 'd', [assistantText('recent', { timestamp: at(40) })]);
  home.writeTranscript('/Users/krish', 'e', [assistantText('shell', { timestamp: at(50) })]);

  const list = (await open()).list();
  assert.deepEqual(list.map((c) => c.id), ['2000', '5000', '3000', '4000', '6000', '1000']);
  // The time each tile shows is the one it was sorted by.
  assert.deepEqual(list.filter((c) => c.status === 'idle').map((c) => c.activeAt), [at(40), at(30), at(5)]);
});

test('conversation returns the readable messages in order, and null for an unknown chat', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [
    { type: 'permission-mode', permissionMode: 'auto' },
    user('run the tests'),
    { ...assistantText('thinking'), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
    toolUse('Bash', { command: 'npm test' }),
    toolResult('42 passing'),
    assistantText('All 42 pass.'),
    { ...assistantText('side'), isSidechain: true },
    'not json',
  ]);
  await open();

  const { messages } = chats.conversation('1000');

  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ['user', 'run the tests'],
    ['tool', 'Bash: npm test'],
    ['assistant', 'All 42 pass.'],
  ]);
  assert.equal(chats.conversation('9999'), null);
});

test('messages Claude Code injects read as what they are, not as markup the user typed', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [
    user('<task-notification>\n<task-id>b1</task-id>\n<output-file>/tmp/x</output-file>\n<status>completed</status>\n<summary>Background command "Run tests" completed (exit code 0)</summary>\n</task-notification>'),
    user('look at this <pasted_content id="67fb">\nsome pasted log\n</pasted_content> please'),
    user('<artifact-content-authored-by-others/> The summarized conversation included content by others'),
  ]);
  await open();

  const { messages } = chats.conversation('1000');

  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ['tool', 'Background command "Run tests" completed (exit code 0)'],
    ['user', 'look at this \nsome pasted log\n please'],
  ]);
});

test('messages from other Claude sessions and job notices inside other text read as notices', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [
    user('<cross-session-message from="reviewer-a">\nFound two bugs in chats.js\n</cross-session-message>'),
    user('<teammate-message teammate_id="t1">\nDone with the tests\n</teammate-message>'),
    user('carry on\n<task-notification>\n<summary>Agent "Review" finished</summary>\n</task-notification>'),
  ]);
  await open();

  const { messages } = chats.conversation('1000');

  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ['tool', 'Message from reviewer-a: Found two bugs in chats.js'],
    ['tool', 'Message from a teammate: Done with the tests'],
    ['user', 'carry on'],
    ['tool', 'Agent "Review" finished'],
  ]);
});

test('notices chats opening and closing, and new messages, without being asked', async () => {
  terminalChat(procs, { pid: 1000 });
  await open();
  const events = [];
  chats.subscribe((change) => events.push(change));

  home.writeSession(session({ pid: 1000 }));
  await waitFor(() => chats.list().length === 1);

  home.writeTranscript('/Users/krish', session().sessionId, [assistantText('hello')]);
  await waitFor(() => chats.list()[0]?.recent.at(-1)?.text === 'hello');
  assert.ok(events.some((e) => e.conversations.includes('1000')));

  home.removeSession(1000);
  await waitFor(() => chats.list().length === 0);
});

// macOS drops file events in the first moments after a watch starts, so a
// chat opening while the dashboard starts up could wait for the 30 s re-check.
test('a chat that opens the moment the dashboard starts still shows up promptly', async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const h = makeHome();
    const p = fakeProcesses([]);
    terminalChat(p, { pid: 1000 });
    const opening = openChats({ sessionsDir: h.sessionsDir, projectsDir: h.projectsDir, processes: p, sweepMs: 60_000, debounceMs: 20, settleMs: 100 });
    h.writeSession(session({ pid: 1000 }));
    const c = await opening;
    try {
      await waitFor(() => c.list().length === 1, { timeout: 1000 });
    } finally {
      c.close();
      h.cleanup();
    }
  }
});

test('the periodic re-check drops a chat whose process died without removing its record', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  // Debounced refreshes pushed far out, so only the re-check can notice.
  await open({ sweepMs: 50, debounceMs: 60_000, maxWaitMs: 60_000 });
  assert.equal(chats.list().length, 1);
  await new Promise((resolve) => setTimeout(resolve, 80)); // past the startup re-check (settleMs 30)

  procs.remove(1000);
  await waitFor(() => chats.list().length === 0);
});

test('a chat that restarts its conversation follows the new transcript', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000, sessionId: 'old' }));
  home.writeTranscript('/Users/krish', 'old', [assistantText('old reply')]);
  home.writeTranscript('/Users/krish', 'new', [assistantText('new reply')]);
  await open();

  home.writeSession(session({ pid: 1000, sessionId: 'new' }));
  await chats.refresh();

  assert.equal(chats.list()[0].recent.at(-1).text, 'new reply');
});

// ---- Records and transcripts written by other versions, or corrupted ----

test('a record with fields of the wrong type is skipped and the others still show', async () => {
  for (const pid of [1000, 2000, 3000, 4000, 5000, 6000]) terminalChat(procs, { pid });
  home.writeSession(session({ pid: 1000, sessionId: 'a', cwd: 42 }));
  home.writeSession(session({ pid: 2000, sessionId: 'b', procStart: 1791211249 }));
  home.writeSession(session({ pid: 3000, sessionId: '../../outside/secret' }));
  home.writeSession(session({ pid: 4000, sessionId: 'd', name: { evil: true } }));
  home.writeSession(session({ pid: 5000, sessionId: 'e' }));
  writeFileSync(join(home.sessionsDir, '6000.json'), '{"pid": 6000, "sessionId": "f", "updatedAt": 1e999}');

  const ids = (await open()).list().map((c) => c.id);

  assert.deepEqual(ids, ['5000']);
});

test('status is one of a fixed set, so nothing else reaches the page', async () => {
  for (const pid of [1000, 2000, 3000]) terminalChat(procs, { pid });
  home.writeSession(session({ pid: 1000, sessionId: 'a', startedAt: 3, status: 'idle"><img src=x onerror=alert(1)>' }));
  home.writeSession(session({ pid: 2000, sessionId: 'b', startedAt: 2, status: 'waiting' }));
  home.writeSession(session({ pid: 3000, sessionId: 'c', startedAt: 1 }));
  writeFileSync(join(home.sessionsDir, '3000.json'), JSON.stringify({ ...session({ pid: 3000, sessionId: 'c', startedAt: 1 }), status: undefined }));

  const statuses = Object.fromEntries((await open()).list().map((c) => [c.id, c.status]));

  assert.deepEqual(statuses, { 1000: 'unknown', 2000: 'waiting', 3000: 'unknown' });
});

test('spare and parked processes, which Claude Code itself does not count as chats, are left out', async () => {
  for (const pid of [1000, 2000, 3000]) terminalChat(procs, { pid });
  home.writeSession(session({ pid: 1000, sessionId: 'a', kind: 'bg', spare: true }));
  home.writeSession(session({ pid: 2000, sessionId: 'b', parkedJobId: 'j1' }));
  home.writeSession(session({ pid: 3000, sessionId: 'c' }));

  assert.deepEqual((await open()).list().map((c) => c.id), ['3000']);
});

test('a transcript line of an unexpected shape is skipped and the lines after it still count', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [
    user('first'),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 42 }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: null, input: null }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: { nested: true } }] } },
    aiTitle('Title after the odd lines'),
    assistantText('still read'),
  ]);
  await open();

  const [chat] = chats.list();
  assert.equal(chat.title, 'Title after the odd lines');
  assert.equal(chat.recent.at(-1).text, 'still read');
  const { messages } = chats.conversation('1000');
  assert.deepEqual(messages.map((m) => m.text), ['first', 'tool', 'still read']);
});

test('the dashboard starts with an empty list when the process table fails, and recovers on the next look', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  const real = procs.snapshot;
  let calls = 0;
  procs.snapshot = async () => {
    if (calls++ === 0) throw new Error('ps failed');
    return real();
  };

  await open();
  assert.deepEqual(chats.list(), []);

  await chats.refresh();
  assert.equal(chats.list().length, 1);
});

test('a process-table call that never returns is stopped, and does not stop later updates', async () => {
  terminalChat(procs, { pid: 1000 });
  const real = procs.snapshot;
  let hang = true;
  let stopped = 0;
  procs.snapshot = ({ signal } = {}) => {
    if (!hang) return real();
    return new Promise((_, reject) => signal?.addEventListener('abort', () => { stopped++; reject(new Error('killed')); }));
  };

  await open({ snapshotTimeoutMs: 50 });
  hang = false;
  home.writeSession(session({ pid: 1000 }));
  await chats.refresh();

  assert.equal(chats.list().length, 1);
  assert.ok(stopped >= 1, 'the hung call was told to stop');
});

test('a chat that never stops writing does not hold back updates for everyone else', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000, sessionId: 'busy' }));
  home.writeTranscript('/Users/krish', 'busy', [assistantText('0')]);
  await open({ debounceMs: 80, maxWaitMs: 250 });
  await new Promise((resolve) => setTimeout(resolve, 80)); // past the startup re-check (settleMs 30)

  let n = 0;
  const writer = setInterval(() => home.appendTranscript('/Users/krish', 'busy', [assistantText(String(++n))]), 20);
  try {
    // A new process: only a refresh that lists processes again can show it,
    // even while the writer keeps asking for transcript-only ones.
    terminalChat(procs, { pid: 2000 });
    home.writeSession(session({ pid: 2000, sessionId: 'quiet' }));
    await waitFor(() => chats.list().length === 2, { timeout: 1500 });
  } finally {
    clearInterval(writer);
  }
});

// ---- Only what changed ----

test('a conversation can be fetched from a point on, and says when it had to start over', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [user('one'), assistantText('two')]);
  await open();

  const first = chats.conversation('1000');
  assert.deepEqual(first.messages.map((m) => [m.seq, m.text]), [[1, 'one'], [2, 'two']]);
  assert.equal(first.total, 2);

  home.appendTranscript('/Users/krish', session().sessionId, [assistantText('three')]);
  await chats.refresh();
  const next = chats.conversation('1000', { after: 2, epoch: first.epoch });
  assert.equal(next.epoch, first.epoch);
  assert.deepEqual(next.messages.map((m) => [m.seq, m.text]), [[3, 'three']]);

  home.writeTranscript('/Users/krish', session().sessionId, [assistantText('rewritten')]);
  await chats.refresh();
  const after = chats.conversation('1000', { after: 3, epoch: first.epoch });
  assert.notEqual(after.epoch, first.epoch);
  assert.deepEqual(after.messages.map((m) => m.text), ['rewritten']);
});

test('a reader that fell further behind than the kept messages is told to start over', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, ['a', 'b'].map((t) => assistantText(t)));
  await open({ historySize: 4, recentSize: 4 });
  const first = chats.conversation('1000');
  assert.equal(first.reset, true);

  home.appendTranscript('/Users/krish', session().sessionId, ['c', 'd', 'e', 'f', 'g', 'h'].map((t) => assistantText(t)));
  await chats.refresh();

  const behind = chats.conversation('1000', { after: 2, epoch: first.epoch });
  assert.equal(behind.reset, true);
  assert.deepEqual(behind.messages.map((m) => m.seq), [5, 6, 7, 8]);

  const caughtUp = chats.conversation('1000', { after: 7, epoch: first.epoch });
  assert.equal(caughtUp.reset, false);
  assert.deepEqual(caughtUp.messages.map((m) => m.seq), [8]);
});

test('a reader whose last message is past the end of a restarted transcript is told to start over', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [assistantText('only one')]);
  await open();
  const { epoch } = chats.conversation('1000');

  // A page that held 5 messages of an earlier read, with this read's epoch.
  const answer = chats.conversation('1000', { after: 5, epoch });

  assert.equal(answer.reset, true);
  assert.deepEqual(answer.messages.map((m) => m.text), ['only one']);
});

test('the reset rule is exact: one message behind the kept window appends, two resets', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t) => assistantText(t)));
  await open({ historySize: 4, recentSize: 4 });
  const { epoch } = chats.conversation('1000');

  assert.equal(chats.conversation('1000', { after: 4, epoch }).reset, false); // has 4, kept 5..8
  assert.equal(chats.conversation('1000', { after: 3, epoch }).reset, true); // would miss 4
});

test('a process-table adapter that throws straight away fails that refresh only, with no crash later', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  const real = procs.snapshot;
  let broken = true;
  procs.snapshot = (...args) => {
    if (broken) throw new Error('adapter broke');
    return real(...args);
  };
  await open({ snapshotTimeoutMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 80)); // past where a leftover timer would fire

  broken = false;
  await chats.refresh();
  assert.equal(chats.list().length, 1);
});

test('a process-table call that times out is reported as a timeout', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  procs.snapshot = ({ signal } = {}) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
  await open({ snapshotTimeoutMs: 30 });

  await assert.rejects(chats.refresh(), /took longer than 30 ms/);
});

test('only the latest messages of a long conversation are kept', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => assistantText(t)));
  await open({ historySize: 4, recentSize: 4 });

  const { messages, total } = chats.conversation('1000');

  assert.equal(total, 6);
  assert.deepEqual(messages.map((m) => [m.seq, m.text]), [[3, 'c'], [4, 'd'], [5, 'e'], [6, 'f']]);
});

test('bookkeeping lines that change nothing on screen notify no one', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [assistantText('hello')]);
  await open();
  const events = [];
  chats.subscribe((e) => events.push(e));

  home.appendTranscript('/Users/krish', session().sessionId, [{ type: 'permission-mode', permissionMode: 'auto' }, toolResult('ok')]);
  await chats.refresh();
  assert.deepEqual(events, []);

  home.appendTranscript('/Users/krish', session().sessionId, [assistantText('visible')]);
  await chats.refresh();
  assert.deepEqual(events, [{ listChanged: true, conversations: ['1000'] }]);
});

test('a new message in a transcript is picked up without listing processes again', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  home.writeTranscript('/Users/krish', session().sessionId, [assistantText('hello')]);
  const real = procs.snapshot;
  let calls = 0;
  procs.snapshot = () => { calls++; return real(); };
  await open();
  await new Promise((resolve) => setTimeout(resolve, 80)); // past the startup re-check (settleMs 30)
  const before = calls;

  home.appendTranscript('/Users/krish', session().sessionId, [assistantText('again')]);
  await waitFor(() => chats.list()[0].recent.at(-1).text === 'again');
  assert.equal(calls, before);

  home.writeSession(session({ pid: 1000, status: 'busy' }));
  await waitFor(() => chats.list()[0].status === 'busy');
  assert.ok(calls > before, 'a change to the chat records lists processes again');
});

test('after the first read, only appended bytes are read', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  const path = home.transcriptPath('/Users/krish', session().sessionId);
  writeFileSync(path, JSON.stringify(assistantText('AAAA')) + '\n');
  await open();

  // Same length, same file: a reader that went back to the start would see BBBB.
  writeFileSync(path, JSON.stringify(assistantText('BBBB')) + '\n', { flag: 'r+' });
  appendFileSync(path, JSON.stringify(assistantText('appended')) + '\n');
  await chats.refresh();

  assert.deepEqual(chats.list()[0].recent.map((m) => m.text), ['AAAA', 'appended']);
});

test('a complete line that is not JSON is skipped', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  const path = home.transcriptPath('/Users/krish', session().sessionId);
  writeFileSync(path, `${JSON.stringify(user('before'))}\n{"type":"assistant","mess\n${JSON.stringify(assistantText('after'))}\n`);
  await open();

  assert.deepEqual(chats.conversation('1000').messages.map((m) => m.text), ['before', 'after']);
});

test('refreshes asked for while one is waiting share it', async () => {
  terminalChat(procs, { pid: 1000 });
  home.writeSession(session({ pid: 1000 }));
  const real = procs.snapshot;
  let calls = 0;
  procs.snapshot = () => { calls++; return real(); };
  await open({ debounceMs: 60_000, maxWaitMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 80)); // past the startup re-check (settleMs 30)
  const before = calls;

  await Promise.all([chats.refresh(), chats.refresh(), chats.refresh()]);

  assert.equal(calls - before, 1);
});
