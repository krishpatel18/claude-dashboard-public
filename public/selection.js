// Which chats the page shows, where, and in what order. No page access, so it
// runs (and is tested) anywhere.
//
// select({ chats, groups, finished, filter, view }) →
//   sections  [{ id, name, chats, total, activeCount, collapsed }] to draw
//   keys      chat ids that 1–9 open, in on-screen order
//   sequence  every visible chat id in group order, for next/previous
//   page      { index, count } when showing a fixed number per screen
//
// chats arrive in the server's order (needs you, working, most recent); that
// order is kept inside each section. groups is the groups store's snapshot.
// view is { show: 'all'|'active', perScreen, page, group, collapsed: [ids] }.

const WORKING = new Set(['busy', 'shell']);
const UNGROUPED = 'ungrouped';

export function isActive(chat, finished) {
  return chat.status === 'waiting' || WORKING.has(chat.status) || finished.has(chat.id);
}

// Your own name for a chat if you gave one, else Claude's title.
export function titleOf(chat, groups) {
  return groups?.chats?.[chat.sessionId]?.name ?? chat.title;
}

export function select({ chats, groups, finished = new Set(), filter = '', view }) {
  const known = new Set((groups?.groups ?? []).map((g) => g.id));
  const groupOf = (chat) => {
    const id = groups?.chats?.[chat.sessionId]?.group;
    return known.has(id) ? id : UNGROUPED;
  };
  const q = filter.trim().toLowerCase();
  const matches = (chat) => !q || `${titleOf(chat, groups)} ${chat.title} ${chat.folder ?? ''} ${chat.appLabel ?? ''}`.toLowerCase().includes(q);
  const shown = (chat) => matches(chat) && (view.show !== 'active' || isActive(chat, finished));

  const order = [...(groups?.groups ?? []), { id: UNGROUPED, name: known.size ? 'Ungrouped' : '' }];
  const byGroup = order.map((g) => {
    const members = chats.filter((c) => groupOf(c) === g.id);
    const visible = members.filter(shown);
    return { id: g.id, name: g.name, members, visible };
  });
  const sequence = byGroup.flatMap((g) => g.visible.map((c) => c.id));

  if (view.perScreen > 0) {
    const picked = byGroup.find((g) => g.id === view.group && g.id !== UNGROUPED) ? view.group : 'all';
    const pool = picked === 'all' ? byGroup.flatMap((g) => g.visible) : byGroup.find((g) => g.id === picked).visible;
    const count = Math.max(1, Math.ceil(pool.length / view.perScreen));
    const index = Math.min(Math.max(0, view.page), count - 1);
    const items = pool.slice(index * view.perScreen, (index + 1) * view.perScreen);
    return {
      sections: [{ id: picked, name: '', chats: items, total: pool.length, activeCount: pool.filter((c) => isActive(c, finished)).length, collapsed: false }],
      keys: items.slice(0, 9).map((c) => c.id),
      sequence,
      page: { index, count },
    };
  }

  const collapsed = new Set(view.collapsed ?? []);
  const sections = byGroup
    .filter((g) => g.id !== UNGROUPED || g.members.length || !known.size)
    .map((g) => ({
      id: g.id,
      name: g.name,
      chats: collapsed.has(g.id) ? [] : g.visible,
      total: g.members.length,
      activeCount: g.members.filter((c) => isActive(c, finished)).length,
      collapsed: collapsed.has(g.id),
    }));
  return {
    sections,
    keys: sections.flatMap((s) => s.chats.map((c) => c.id)).slice(0, 9),
    sequence,
    page: { index: 0, count: 1 },
  };
}

// The chat after (step 1) or before (step -1) `id`; from one that isn't
// there any more, the first or the last.
export function neighbor(sequence, id, step) {
  if (!sequence.length) return null;
  const at = sequence.indexOf(id);
  if (at === -1) return step > 0 ? sequence[0] : sequence.at(-1);
  return sequence[(at + step + sequence.length) % sequence.length];
}
