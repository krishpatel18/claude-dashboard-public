import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGroups } from '../src/groups.js';

let dir;
let file;
let clock;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'groups-'));
  file = join(dir, 'groups.json');
  clock = Date.parse('2026-10-20T12:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = () => openGroups({ file, now: () => clock });

test('groups are created, renamed and deleted, in creation order, and saved privately', async () => {
  const g = await open();
  const work = g.createGroup('Work');
  const research = g.createGroup('  Research  ');
  g.renameGroup(work.id, 'Side Projects');

  assert.deepEqual(g.snapshot().groups.map((x) => x.name), ['Side Projects', 'Research']);
  assert.equal(research.name, 'Research');
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const reopened = await open();
  assert.deepEqual(reopened.snapshot().groups.map((x) => x.name), ['Side Projects', 'Research']);

  reopened.deleteGroup(work.id);
  assert.deepEqual(reopened.snapshot().groups.map((x) => x.name), ['Research']);
});

test('a chat is put in a group and given its own name by session, and deleting the group ungroups it', async () => {
  const g = await open();
  const work = g.createGroup('Work');
  g.assign('sess-1', work.id);
  g.rename('sess-1', 'Webhook fix');
  g.rename('sess-2', 'Other');

  assert.deepEqual(g.snapshot().chats['sess-1'], { group: work.id, name: 'Webhook fix', seenAt: clock });

  g.assign('sess-1', null);
  g.rename('sess-2', '   ');
  assert.equal(g.snapshot().chats['sess-1'].group, undefined);
  assert.equal(g.snapshot().chats['sess-2'], undefined); // nothing left to remember

  g.assign('sess-1', work.id);
  g.deleteGroup(work.id);
  assert.equal(g.snapshot().chats['sess-1'].group, undefined);
  assert.equal(g.snapshot().chats['sess-1'].name, 'Webhook fix');
});

test('bad input is refused with a reason, and nothing is saved', async () => {
  const g = await open();
  assert.throws(() => g.createGroup(''), /name/);
  assert.throws(() => g.createGroup('x'.repeat(61)), /60/);
  assert.throws(() => g.renameGroup('nope', 'A'), /no such group/);
  assert.throws(() => g.assign('sess-1', 'nope'), /no such group/);
  assert.throws(() => g.assign('../evil', null), /session/);
  assert.throws(() => g.rename('sess-1', 'x'.repeat(121)), /120/);
  assert.deepEqual(g.snapshot(), { groups: [], chats: {} });
});

test('chats unseen for 30 days are forgotten; seen ones are kept', async () => {
  const g = await open();
  const work = g.createGroup('Work');
  g.assign('old', work.id);
  g.assign('live', work.id);

  clock += 31 * 24 * 3600_000;
  g.seen(['live']);

  assert.deepEqual(Object.keys(g.snapshot().chats), ['live']);
});

test('a missing or damaged file starts empty instead of failing', async () => {
  writeFileSync(file, '{not json');
  const g = await open();
  assert.deepEqual(g.snapshot(), { groups: [], chats: {} });
  g.createGroup('Fresh');
  assert.match(readFileSync(file, 'utf8'), /Fresh/);
});

test('subscribers hear every change', async () => {
  const g = await open();
  const seen = [];
  g.subscribe((s) => seen.push(s.groups.length));
  g.createGroup('A');
  g.createGroup('B');
  assert.deepEqual(seen, [1, 2]);
});
