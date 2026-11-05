import { watch } from 'node:fs';
import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { appFromAncestry, describeApp } from './apps.js';
import { TranscriptFollower } from './transcript.js';

const LINE_MAX = 280;
const TITLE_MAX = 120;
const WATCH_SETTLE_MS = 250;
const STATUSES = new Set(['waiting', 'busy', 'shell', 'idle']);
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

// The set of Claude Code chats open on this machine, kept current.
//
// Reads Claude Code's session records (one JSON file per running chat) and
// each chat's transcript. A record whose process is gone, or whose pid now
// belongs to a newer process, is treated as closed. Changes arrive through
// file-system events; a periodic re-check catches chats that died without
// removing their record.
//
// `processes` is the process-table adapter: { snapshot(): Promise<Map<pid, { ppid, tty, started, command }>> }.
export async function openChats({
  sessionsDir, projectsDir, processes,
  sweepMs = 30_000, debounceMs = 150, maxWaitMs = 1_000, snapshotTimeoutMs = 10_000, historySize = 400,
  recentSize = 12, // last messages per tile; small tiles show the newest few that fit
  settleMs = WATCH_SETTLE_MS,
}) {
  let chats = [];
  let byId = new Map();
  let listJson = '[]';
  let liveSessionIds = new Set();
  const followers = new Map(); // transcript path → TranscriptFollower
  let chatFollowers = new Map(); // chat id → its TranscriptFollower
  let lastTable = null;
  const listeners = new Set();
  const watchers = new Map(); // dir → FSWatcher
  let timer = null;
  let firstScheduledAt = 0;

  // Rebuilds run one at a time; calls made while one waits share it. A full
  // refresh lists processes again; a transcript-only one reuses the last list.
  let queue = Promise.resolve();
  let pending = null;
  let wantFull = false;
  function refresh(full = true) {
    if (full) wantFull = true;
    if (pending) return pending;
    pending = queue.then(() => {
      pending = null;
      const listProcesses = wantFull || !lastTable;
      wantFull = false;
      return rebuild(listProcesses);
    });
    queue = pending.catch(() => {});
    return pending;
  }

  // Trailing debounce, but never later than maxWaitMs after the first event,
  // so one chat writing nonstop can't hold back everyone else's updates.
  let scheduledFull = false;
  function schedule(full) {
    const now = Date.now();
    if (!timer) firstScheduledAt = now;
    scheduledFull ||= full;
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, firstScheduledAt + maxWaitMs - now));
    timer = setTimeout(() => {
      timer = null;
      const f = scheduledFull;
      scheduledFull = false;
      refresh(f).catch(report);
    }, wait);
  }

  async function rebuild(listProcesses) {
    const [records, table] = await Promise.all([
      readRecords(sessionsDir),
      listProcesses ? withTimeout((signal) => processes.snapshot({ signal }), snapshotTimeoutMs, 'listing processes') : lastTable,
    ]);
    lastTable = table;
    const next = [];
    const nextFollowers = new Map();
    const changed = [];
    const seenPaths = new Set();

    for (const record of records) {
      const proc = table.get(record.pid);
      if (!proc) continue;
      if (record.procStart && sameMoment(record.procStart, proc.started) === false) continue;

      // One unreadable transcript costs only its own tile's messages.
      let follower = null;
      try {
        const path = await locateTranscript(projectsDir, record);
        if (path) {
          seenPaths.add(path);
          follower = followers.get(path);
          if (!follower) followers.set(path, (follower = new TranscriptFollower(path, { keep: recentSize, history: historySize })));
          if (await follower.update()) changed.push(String(record.pid));
          nextFollowers.set(String(record.pid), follower);
        }
      } catch (err) {
        report(err);
      }
      next.push(toChat(record, proc, table, follower));
    }

    for (const path of followers.keys()) if (!seenPaths.has(path)) followers.delete(path);

    next.sort(byAttentionThenRecent);
    const json = JSON.stringify(next);
    chats = next;
    byId = new Map(next.map((c) => [c.id, c]));
    chatFollowers = nextFollowers;
    liveSessionIds = new Set(next.map((c) => c.sessionId));
    const listChanged = json !== listJson;
    listJson = json;
    if (listChanged || changed.length) {
      for (const fn of listeners) fn({ listChanged, conversations: changed });
    }
  }

  const watchSpecs = [
    [sessionsDir, {}, () => schedule(true)],
    [projectsDir, { recursive: true }, (_event, filename) => {
      if (!filename) return schedule(false);
      // Subagent transcripts live a level deeper and don't belong to a tile.
      if (filename.endsWith('.jsonl') && !dirname(filename).includes('/') && liveSessionIds.has(basename(filename, '.jsonl'))) {
        schedule(false);
      }
    }],
  ];
  // Watches any folder not yet watched: at start, and on each re-check, so a
  // folder that didn't exist yet or a watcher that failed comes back.
  function arm() {
    for (const [dir, options, onEvent] of watchSpecs) {
      if (watchers.has(dir)) continue;
      try {
        const w = watch(dir, options, onEvent);
        w.on('error', (err) => {
          report(err);
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch {
        // Not there yet; the next re-check tries again.
      }
    }
  }

  arm();
  // macOS drops events for the first moments of a new watch; one more look
  // once the watchers are surely live covers changes made in that gap.
  const settle = setTimeout(() => refresh().catch(report), settleMs);
  await refresh().catch(report);
  const sweep = setInterval(() => {
    arm();
    refresh().catch(report);
  }, sweepMs);

  return {
    list: () => chats,
    find: (id) => byId.get(String(id)) ?? null,
    // { epoch, total, reset, messages } from memory. With { after, epoch } from
    // an earlier answer, only messages newer than `after`; `reset` says the
    // reader must instead replace what it has (see TranscriptFollower).
    conversation(id, options) {
      if (!byId.has(String(id))) return null;
      const follower = chatFollowers.get(String(id));
      return follower ? follower.conversation(options) : { epoch: 0, total: 0, reset: true, messages: [] };
    },
    refresh: () => refresh(true),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      clearTimeout(settle);
      clearInterval(sweep);
      clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      listeners.clear();
    },
  };
}

function toChat(record, proc, table, follower) {
  const userNamed = record.name && record.nameSource && !['derived', 'auto'].includes(record.nameSource);
  const title = (userNamed && record.name) || follower?.aiTitle || follower?.firstPrompt || record.name || record.sessionId;
  const app = record.kind === 'bg' ? 'background' : appFromAncestry(ancestors(proc, table));
  const tty = proc.tty && proc.tty !== '??' ? proc.tty : null;
  return {
    id: String(record.pid),
    pid: record.pid,
    sessionId: record.sessionId,
    // The name other chats use to message this one (@name).
    handle: record.name ?? null,
    title: oneLine(title, TITLE_MAX),
    folder: record.cwd ?? null,
    app,
    ...describeApp({ app, tty }),
    status: STATUSES.has(record.status) ? record.status : 'unknown',
    startedAt: record.startedAt ?? null,
    updatedAt: record.updatedAt ?? null,
    recent: (follower?.recent ?? []).map((m) => ({ role: m.role, text: oneLine(m.text, LINE_MAX), at: m.at })),
    activeAt: activeAt(follower?.recent.at(-1)?.at, record),
    tty,
  };
}

// Commands of a process's parents, nearest first.
function ancestors(proc, table) {
  const commands = [];
  let current = table.get(proc.ppid);
  for (let hops = 0; current && hops < 32; hops++) {
    commands.push(current.command);
    current = table.get(current.ppid);
  }
  return commands;
}

async function readRecords(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (name) => {
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8'));
      return isChatRecord(record) ? record : null;
    } catch {
      return null; // Missing or mid-write; the next change event brings it back.
    }
  }));
  return records.filter(Boolean);
}

const optional = (value, type) => value === undefined || value === null || typeof value === type;

// The fields this module reads, with the types it relies on. Spare and parked
// processes are Claude Code's own bookkeeping, not chats.
function isChatRecord(r) {
  return Boolean(r) && typeof r === 'object'
    && Number.isInteger(r.pid) && r.pid > 0
    && typeof r.sessionId === 'string' && SESSION_ID.test(r.sessionId)
    && ['cwd', 'procStart', 'name', 'nameSource', 'kind', 'status'].every((k) => optional(r[k], 'string'))
    && ['startedAt', 'updatedAt'].every((k) => r[k] === undefined || r[k] === null || Number.isFinite(r[k]))
    && r.spare !== true && r.parkedJobId === undefined;
}

// Runs `start(signal)`, giving up after `ms` and aborting the signal so the
// work itself stops too.
// The timeout is decided before the abort, so it is what gets reported; a
// `start` that throws at once is just a failed attempt.
function withTimeout(start, ms, what) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} took longer than ${ms} ms`));
      controller.abort();
    }, ms);
  });
  const work = Promise.resolve().then(() => start(controller.signal));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Transcripts live at <projects>/<cwd with non-alphanumerics as '-'>/<sessionId>.jsonl.
// If that guess misses, look in every project folder.
async function locateTranscript(projectsDir, { cwd, sessionId }) {
  const file = `${sessionId}.jsonl`;
  if (cwd) {
    const guess = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), file);
    if (await exists(guess)) return guess;
  }
  let dirs;
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, file);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// null when the process table gave no start time to compare.
function sameMoment(a, b) {
  if (!a || !b) return null;
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

// Needs you, then working, then everything else; most recent activity first
// within each group.
const ATTENTION = { waiting: 0, busy: 1, shell: 1 };

function byAttentionThenRecent(a, b) {
  return (ATTENTION[a.status] ?? 2) - (ATTENTION[b.status] ?? 2)
    || Date.parse(b.activeAt ?? 0) - Date.parse(a.activeAt ?? 0)
    || a.pid - b.pid;
}

// When a chat last did anything: the latest of its newest message, its last
// status change and its start. Tiles show this time and are sorted by it.
function activeAt(lastMessageAt, record) {
  const message = Date.parse(lastMessageAt ?? '');
  const ms = Math.max(Number.isNaN(message) ? 0 : message, record.updatedAt ?? 0, record.startedAt ?? 0);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function report(err) {
  console.error(`[claude-dashboard] ${err?.message ?? err}`);
}
