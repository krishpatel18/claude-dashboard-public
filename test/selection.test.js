import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select, titleOf, neighbor } from '../public/selection.js';

const chat = (id, status = 'idle', extra = {}) => ({ id, sessionId: `s${id}`, title: `Chat ${id}`, folder: '/Users/k', appLabel: 'Terminal', status, ...extra });
const CHATS = [chat('1', 'waiting'), chat('2', 'busy'), chat('3'), chat('4'), chat('5'), chat('6')];
const GROUPS = {
  groups: [{ id: 'g1', name: 'Work' }, { id: 'g2', name: 'Empty' }],
  chats: { s2: { group: 'g1' }, s4: { group: 'g1', name: 'Webhook fix' }, s5: { name: 'Renamed only' }, s9: { group: 'g1' } },
};
const view = (extra = {}) => ({ show: 'all', perScreen: 0, page: 0, group: 'all', collapsed: [], ...extra });
const base = (extra = {}) => ({ chats: CHATS, groups: GROUPS, finished: new Set(), filter: '', view: view(), ...extra });
const ids = (list) => list.map((c) => c.id);

test('with no groups made, everything is one untitled section in the server\'s order', () => {
  const result = select(base({ groups: { groups: [], chats: {} } }));
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].id, 'ungrouped');
  assert.deepEqual(ids(result.sections[0].chats), ['1', '2', '3', '4', '5', '6']);
});

test('groups are sections in creation order, empty ones included, Ungrouped last', () => {
  const { sections } = select(base());
  assert.deepEqual(sections.map((s) => [s.id, s.name, ids(s.chats)]), [
    ['g1', 'Work', ['2', '4']],
    ['g2', 'Empty', []],
    ['ungrouped', 'Ungrouped', ['1', '3', '5', '6']],
  ]);
});

test('your own chat name replaces Claude\'s title, and the filter searches it', () => {
  assert.equal(titleOf(CHATS[3], GROUPS), 'Webhook fix');
  assert.equal(titleOf(CHATS[2], GROUPS), 'Chat 3');
  const { sections } = select(base({ filter: 'webhook' }));
  assert.deepEqual(sections.map((s) => ids(s.chats)), [['4'], [], []]);
});

test('Active keeps chats that need you, are working or just finished; groups stay as headers with their active count', () => {
  const { sections } = select(base({ view: view({ show: 'active' }), finished: new Set(['3']) }));
  assert.deepEqual(sections.map((s) => [s.id, ids(s.chats), s.activeCount]), [
    ['g1', ['2'], 1],
    ['g2', [], 0],
    ['ungrouped', ['1', '3'], 2],
  ]);
});

test('collapsed sections keep their header but show no tiles, and their chats get no number keys', () => {
  const result = select(base({ view: view({ collapsed: ['g1'] }) }));
  assert.equal(result.sections[0].collapsed, true);
  assert.deepEqual(result.sections[0].chats, []);
  assert.equal(result.sections[0].total, 2);
  assert.deepEqual(result.keys, ['1', '3', '5', '6']);
});

test('number keys follow the tiles on screen, top section first', () => {
  assert.deepEqual(select(base()).keys, ['2', '4', '1', '3', '5', '6']);
});

test('a fixed number per screen pages through one group, or all of them in group order', () => {
  const all = select(base({ view: view({ perScreen: 4, page: 1 }) }));
  assert.equal(all.sections.length, 1);
  assert.deepEqual(ids(all.sections[0].chats), ['5', '6']);
  assert.deepEqual(all.page, { index: 1, count: 2 });

  const work = select(base({ view: view({ perScreen: 4, group: 'g1' }) }));
  assert.deepEqual(ids(work.sections[0].chats), ['2', '4']);
  assert.deepEqual(work.page, { index: 0, count: 1 });
});

test('a page past the end shows the last page instead of nothing, without changing the view', () => {
  const v = view({ perScreen: 4, page: 9 });
  const result = select(base({ view: v }));
  assert.deepEqual(result.page, { index: 1, count: 2 });
  assert.equal(v.page, 9);
});

test('a group picked for paging that was deleted falls back to all groups', () => {
  const result = select(base({ view: view({ perScreen: 4, group: 'gone' }) }));
  assert.deepEqual(ids(result.sections[0].chats), ['2', '4', '1', '3']);
});

test('next and previous follow the visible order across sections and pages, wrapping around', () => {
  const { sequence } = select(base({ view: view({ perScreen: 4 }) }));
  assert.deepEqual(sequence, ['2', '4', '1', '3', '5', '6']);
  assert.equal(neighbor(sequence, '4', 1), '1');
  assert.equal(neighbor(sequence, '2', -1), '6');
  assert.equal(neighbor(sequence, 'closed', 1), '2');
  assert.equal(neighbor(sequence, 'closed', -1), '6');
  assert.equal(neighbor([], '1', 1), null);
});

test('assignments to groups that no longer exist count as ungrouped', () => {
  const stale = { groups: [], chats: { s2: { group: 'deleted' } } };
  assert.deepEqual(ids(select(base({ groups: stale })).sections[0].chats), ['1', '2', '3', '4', '5', '6']);
});
