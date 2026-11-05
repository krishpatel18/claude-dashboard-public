import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const GROUP_NAME_MAX = 60;
const CHAT_NAME_MAX = 120;
const FORGET_AFTER = 30 * 24 * 3600_000;
const SEEN_GRANULARITY = 24 * 3600_000; // don't rewrite the file more than daily for "seen"

// Your chat groups and chat names, saved in one private file.
//
// { groups: [{ id, name }] in creation order,
//   chats: { [sessionId]: { group?, name?, seenAt } } }
//
// Chats are remembered by Claude's session ID. One a chat hasn't been seen
// open for 30 days is forgotten. Every change is saved at once (written to a
// private temporary file, then renamed into place); bad input throws with a
// reason and changes nothing.
export async function openGroups({ file, now = Date.now }) {
  let state = load(file);
  const listeners = new Set();

  function commit(next) {
    state = next;
    save(file, state);
    for (const fn of listeners) fn(state);
  }

  function groupExists(id) {
    return state.groups.some((g) => g.id === id);
  }

  // A chat entry with nothing left to remember is dropped.
  function withChat(sessionId, change) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('invalid session id');
    const chats = { ...state.chats };
    const entry = change({ ...(chats[sessionId] ?? {}) });
    if (entry.group === undefined && entry.name === undefined) delete chats[sessionId];
    else chats[sessionId] = { ...entry, seenAt: now() };
    return chats;
  }

  return {
    snapshot: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    createGroup(name) {
      const group = { id: randomBytes(6).toString('hex'), name: cleanName(name, GROUP_NAME_MAX, 'group name') };
      commit({ ...state, groups: [...state.groups, group] });
      return group;
    },
    renameGroup(id, name) {
      if (!groupExists(id)) throw new Error('no such group');
      const clean = cleanName(name, GROUP_NAME_MAX, 'group name');
      commit({ ...state, groups: state.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) });
    },
    deleteGroup(id) {
      if (!groupExists(id)) throw new Error('no such group');
      const chats = {};
      for (const [sid, entry] of Object.entries(state.chats)) {
        const { group, ...rest } = entry;
        if (group !== id) chats[sid] = entry;
        else if (rest.name !== undefined) chats[sid] = rest;
      }
      commit({ groups: state.groups.filter((g) => g.id !== id), chats });
    },
    // groupId null takes the chat out of its group.
    assign(sessionId, groupId) {
      if (groupId !== null && !groupExists(groupId)) throw new Error('no such group');
      commit({ ...state, chats: withChat(sessionId, (e) => ({ ...e, group: groupId ?? undefined })) });
    },
    // A blank name brings back Claude's own title.
    rename(sessionId, name) {
      const clean = typeof name === 'string' && name.trim() ? cleanName(name, CHAT_NAME_MAX, 'chat name') : undefined;
      commit({ ...state, chats: withChat(sessionId, (e) => ({ ...e, name: clean })) });
    },
    // Marks open chats as seen (at most daily) and forgets old ones.
    seen(sessionIds) {
      const at = now();
      const open = new Set(sessionIds);
      let changed = false;
      const chats = {};
      for (const [sid, entry] of Object.entries(state.chats)) {
        if (open.has(sid) && at - entry.seenAt >= SEEN_GRANULARITY) {
          chats[sid] = { ...entry, seenAt: at };
          changed = true;
        } else if (!open.has(sid) && at - entry.seenAt > FORGET_AFTER) {
          changed = true;
        } else {
          chats[sid] = entry;
        }
      }
      if (changed) commit({ ...state, chats });
    },
  };
}

function cleanName(name, max, what) {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!clean) throw new Error(`a ${what} is needed`);
  if (clean.length > max) throw new Error(`a ${what} can be at most ${max} characters`);
  return clean;
}

function load(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const groups = Array.isArray(data.groups)
      ? data.groups.filter((g) => typeof g?.id === 'string' && typeof g.name === 'string')
      : [];
    const ids = new Set(groups.map((g) => g.id));
    const chats = {};
    for (const [sid, e] of Object.entries(data.chats ?? {})) {
      if (!SESSION_ID.test(sid) || !e || !Number.isFinite(e.seenAt)) continue;
      const entry = { seenAt: e.seenAt };
      if (ids.has(e.group)) entry.group = e.group;
      if (typeof e.name === 'string' && e.name) entry.name = e.name.slice(0, CHAT_NAME_MAX);
      if (entry.group !== undefined || entry.name !== undefined) chats[sid] = entry;
    }
    return { groups, chats };
  } catch {
    return { groups: [], chats: {} };
  }
}

function save(file, state) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.groups-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}
