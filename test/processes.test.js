import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, systemProcesses } from '../src/processes.js';

test('parses ps rows, keeping commands with spaces whole', () => {
  const table = parsePs([
    '    1     0 ??       Thu Sep  3 16:50:35 2026     /sbin/launchd',
    '31368 31180 ??       Tue Oct 13 18:05:50 2026     Cursor Helper: terminal pty-host                    ',
    '17743 17700 ttys011  Mon Oct  5 14:40:41 2026     claude',
    'garbage line',
    '',
  ].join('\n'));

  assert.deepEqual([...table.keys()], [1, 31368, 17743]);
  assert.deepEqual(table.get(31368), {
    pid: 31368, ppid: 31180, tty: '??', started: 'Tue Oct 13 18:05:50 2026', command: 'Cursor Helper: terminal pty-host',
  });
  assert.equal(table.get(17743).tty, 'ttys011');
});

test('the real process table includes this test process with a UTC, C-locale start time', async () => {
  const table = await systemProcesses().snapshot();
  const me = table.get(process.pid);
  assert.ok(me, 'own pid present');
  assert.equal(me.ppid, process.ppid);
  assert.match(me.started, /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d \d{4}$/);
  // Claude Code writes procStart in UTC; read as UTC, this must be when this process started.
  const startedMs = Date.parse(`${me.started} UTC`);
  const expectedMs = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(startedMs - expectedMs) < 3000, `${me.started} is not this process's start time in UTC`);
});
