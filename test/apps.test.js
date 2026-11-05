import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFromAncestry, describeApp } from '../src/apps.js';

test('names the app from the nearest recognisable parent process', () => {
  const app = (...commands) => appFromAncestry(commands);
  assert.equal(app('-zsh', 'login -pf k', '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'), 'terminal');
  assert.equal(app('/bin/zsh', 'Cursor Helper: terminal pty-host', '/Applications/Cursor.app/Contents/MacOS/Cursor'), 'cursor');
  assert.equal(app('/bin/zsh', 'Code Helper: terminal pty-host'), 'vscode');
  assert.equal(app('-zsh', '/Applications/iTerm.app/Contents/MacOS/iTerm2'), 'iterm');
  assert.equal(app('-zsh', '/Applications/Warp.app/Contents/MacOS/stable'), 'warp');
  assert.equal(app('-zsh', '/Applications/Ghostty.app/Contents/MacOS/ghostty'), 'ghostty');
  assert.equal(app('/Users/k/.local/bin/claude daemon run --origin transient'), 'background');
  assert.equal(app('tmux: server', '/sbin/launchd'), 'other');
  // A Cursor terminal opened inside Terminal's tmux still reads as Cursor: nearest wins.
  assert.equal(app('Cursor Helper: terminal pty-host', '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'), 'cursor');
});

test('each app says what to call it and whether its window can be brought forward', () => {
  assert.deepEqual(describeApp({ app: 'terminal', tty: 'ttys001' }), { appLabel: 'Terminal', cannotFocus: null });
  assert.deepEqual(describeApp({ app: 'terminal', tty: null }), { appLabel: 'Terminal', cannotFocus: 'This chat has no Terminal tab attached.' });
  assert.deepEqual(describeApp({ app: 'cursor', tty: 'ttys020' }), { appLabel: 'Cursor', cannotFocus: null });
  assert.deepEqual(describeApp({ app: 'ghostty', tty: null }), { appLabel: 'Ghostty', cannotFocus: null });
  assert.match(describeApp({ app: 'background', tty: null }).cannotFocus, /claude agents/);
  assert.match(describeApp({ app: 'other', tty: 'ttys009' }).cannotFocus, /which app/);
  assert.equal(describeApp({ app: 'other', tty: null }).appLabel, 'Other app');
});
