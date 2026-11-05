import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFocus } from '../src/focus.js';

function recorder(output = 'ok') {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    return output;
  };
  return { calls, run };
}

function cursorStorage(folders) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-storage-'));
  const path = join(dir, 'storage.json');
  writeFileSync(path, JSON.stringify({
    windowsState: {
      lastActiveWindow: { folder: `file://${folders[0]}` },
      openedWindows: folders.slice(1).map((f) => ({ folder: f && `file://${encodeURI(f)}` })),
    },
  }));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const chat = (overrides) => ({ id: '1', app: 'terminal', tty: 'ttys011', folder: '/Users/krish/proj', ...overrides });

test('a Terminal chat selects the tab on its tty, passing the tty as an argument rather than in the script', async () => {
  const { calls, run } = recorder('ok');
  const result = await createFocus({ run }).bringToFront(chat({}));

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  const [file, ...args] = calls[0];
  assert.equal(file, 'osascript');
  assert.equal(args.at(-1), '/dev/ttys011');
  assert.ok(!args.slice(0, -1).join(' ').includes('ttys011'));
});

test('a Terminal chat whose tab is gone reports that plainly', async () => {
  const { run } = recorder('missing');
  const result = await createFocus({ run }).bringToFront(chat({}));
  assert.equal(result.ok, false);
  assert.match(result.reason, /Terminal tab/);
});

test('a Cursor chat opens the open workspace that contains its folder, the deepest match winning', async () => {
  const storage = cursorStorage(['/Users/krish/other', '/Users/krish', null, '/Users/krish/my proj', '/Users/krish/my project']);
  const { calls, run } = recorder('');
  const result = await createFocus({ run, cursorStoragePath: storage.path })
    .bringToFront(chat({ app: 'cursor', folder: '/Users/krish/my proj/src' }));
  storage.cleanup();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [['open', '-a', 'Cursor', '/Users/krish/my proj']]);
});

test('a Cursor chat with no matching workspace only brings Cursor forward, never opening a new window', async () => {
  const storage = cursorStorage(['/Users/krish/other']);
  const { calls, run } = recorder('');
  const result = await createFocus({ run, cursorStoragePath: storage.path })
    .bringToFront(chat({ app: 'cursor', folder: '/Users/krish/proj' }));
  storage.cleanup();

  assert.equal(result.ok, true);
  assert.match(result.note, /couldn.t tell which/i);
  assert.deepEqual(calls, [['open', '-a', 'Cursor']]);
});

test('a workspace whose name is only the start of the chat\'s folder name does not count', async () => {
  const storage = cursorStorage(['/Users/krish/my proj']);
  const { calls, run } = recorder('');
  await createFocus({ run, cursorStoragePath: storage.path }).bringToFront(chat({ app: 'cursor', folder: '/Users/krish/my project/src' }));
  storage.cleanup();
  assert.deepEqual(calls, [['open', '-a', 'Cursor']]);
});

test('Cursor\'s last active window counts as open', async () => {
  const storage = cursorStorage(['/Users/krish/proj']);
  const { calls, run } = recorder('');
  await createFocus({ run, cursorStoragePath: storage.path }).bringToFront(chat({ app: 'cursor', folder: '/Users/krish/proj' }));
  storage.cleanup();
  assert.deepEqual(calls, [['open', '-a', 'Cursor', '/Users/krish/proj']]);
});

test('a Cursor chat still brings Cursor forward when its window list cannot be read', async () => {
  const { calls, run } = recorder('');
  await createFocus({ run, cursorStoragePath: '/nonexistent/storage.json' })
    .bringToFront(chat({ app: 'cursor' }));
  assert.deepEqual(calls, [['open', '-a', 'Cursor']]);
});

test('other known apps are brought forward by name, saying the tab could not be picked', async () => {
  const { calls, run } = recorder('');
  const result = await createFocus({ run }).bringToFront(chat({ app: 'ghostty' }));
  assert.deepEqual(calls, [['open', '-a', 'Ghostty']]);
  assert.equal(result.ok, true);
  assert.match(result.note, /Ghostty/);
});

test('background chats and unknown apps have no window to bring forward', async () => {
  const { calls, run } = recorder('');
  const focus = createFocus({ run });
  const bg = await focus.bringToFront(chat({ app: 'background' }));
  const other = await focus.bringToFront(chat({ app: 'other' }));

  assert.equal(bg.ok, false);
  assert.match(bg.reason, /claude agents/);
  assert.equal(other.ok, false);
  assert.deepEqual(calls, []);
});

test('macOS refusing control of Terminal says where to allow it', async () => {
  const run = async () => {
    throw Object.assign(new Error('Command failed'), { stderr: '12:40: execution error: Not authorized to send Apple events to Terminal. (-1743)' });
  };
  const result = await createFocus({ run }).bringToFront(chat({}));
  assert.equal(result.ok, false);
  assert.match(result.reason, /Privacy & Security/);
  assert.match(result.reason, /Automation/);
});

test('a command that times out says what is probably waiting, without dumping the script', async () => {
  const run = async () => {
    throw Object.assign(new Error('Command failed: osascript -e on run argv ... end run'), { killed: true, signal: 'SIGTERM', stderr: '' });
  };
  const result = await createFocus({ run }).bringToFront(chat({}));
  assert.equal(result.ok, false);
  assert.match(result.reason, /didn.t answer/);
  assert.doesNotMatch(result.reason, /on run argv/);
});

test('any other failure gives its first line of error output, briefly', async () => {
  const run = async () => { throw Object.assign(new Error('x'), { stderr: 'something broke\nmore detail\n' }); };
  const result = await createFocus({ run }).bringToFront(chat({}));
  assert.equal(result.reason, 'Couldn\u2019t bring it forward: something broke');
});

test('resuming a paused chat opens Terminal in its folder, passing folder and session as arguments, never in the script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-'));
  const { calls, run } = recorder('');
  const result = await createFocus({ run }).resume({ sessionId: 'abc-123', folder: dir });
  rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(result, { ok: true });
  const [file, ...args] = calls[0];
  assert.equal(file, 'osascript');
  assert.deepEqual(args.slice(-2), [dir, 'abc-123']);
  assert.ok(!args.slice(0, -2).join(' ').includes('abc-123'));
  assert.match(args.slice(0, -2).join(' '), /quoted form of/);
});

test('resume refuses a folder that is gone or a session id with odd characters', async () => {
  const { calls, run } = recorder('');
  const focus = createFocus({ run });
  assert.match((await focus.resume({ sessionId: 'abc', folder: '/nonexistent/place' })).reason, /folder/);
  assert.match((await focus.resume({ sessionId: 'abc; rm -rf ~', folder: tmpdir() })).reason, /session/);
  assert.deepEqual(calls, []);
});
