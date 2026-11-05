import { watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { TranscriptFollower } from './transcript.js';

const HOUR = 3600_000;
const WINDOWS = { fiveHour: 5 * HOUR, sevenDay: 7 * 24 * HOUR };

// How much of the Claude plan is used, what this machine's chats used, and
// which chats from the last 7 days exist (with whether bye-bye paused them).
//
// Plan limits are the figures Claude Code hands its status line, saved to
// `usageFile` by the status-line wrapper (see README); they cover all use of
// the account, and are as fresh as the last status-line redraw. Token counts
// come from every transcript written to in the last 7 days, subagents
// counted toward the chat that started them.
export async function openUsage({ usageFile, projectsDir, now = Date.now, debounceMs = 300, sweepMs = 60_000, settleMs = 250 }) {
  const followers = new Map(); // transcript path → TranscriptFollower
  const listeners = new Set();
  const watchers = new Map();
  let plan = null;
  let timer = null;
  let current = { plan: null, tokens: { total: zero(), bySession: {} }, sessions: {} };

  let queue = Promise.resolve();
  let pending = null;
  function refresh() {
    if (pending) return pending;
    pending = queue.then(() => {
      pending = null;
      return rebuild();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => refresh().catch(report), debounceMs);
  }

  async function rebuild() {
    plan = await readPlan(usageFile);
    const since = now() - WINDOWS.sevenDay;
    const paths = await recentTranscripts(projectsDir, since);
    for (const path of followers.keys()) if (!paths.has(path)) followers.delete(path);
    for (const path of paths) {
      let follower = followers.get(path);
      if (!follower) followers.set(path, (follower = new TranscriptFollower(path, { history: 4 })));
      try {
        await follower.update();
      } catch (err) {
        report(err);
      }
    }
    const next = { plan, tokens: tally(followers, projectsDir, now()), sessions: sessionsOf(followers, projectsDir) };
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next;
      for (const fn of listeners) fn(current);
    }
  }

  function arm() {
    const specs = [
      [dirname(usageFile), {}, (_e, name) => (!name || name === basename(usageFile)) && schedule()],
      [projectsDir, { recursive: true }, (_e, name) => (!name || name.endsWith('.jsonl')) && schedule()],
    ];
    for (const [dir, options, onEvent] of specs) {
      if (watchers.has(dir)) continue;
      try {
        const w = watch(dir, options, onEvent);
        w.on('error', () => {
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch {
        // Not there yet (the wrapper hasn't run); the next re-check tries again.
      }
    }
  }

  arm();
  // macOS drops events for the first moments of a new watch; one more look
  // once the watchers are surely live covers changes made in that gap.
  const settle = setTimeout(() => refresh().catch(report), settleMs);
  await refresh().catch(report);
  // Re-checks: windows slide with the clock, and folders may appear later.
  const sweep = setInterval(() => {
    arm();
    refresh().catch(report);
  }, sweepMs);

  return {
    snapshot: () => current,
    refresh,
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

// Each chat's main transcript (not its subagents'): title, folder, when it
// last did anything, and when bye-bye paused it (null if it didn't, or you
// carried on afterwards).
function sessionsOf(followers, projectsDir) {
  const sessions = {};
  for (const [path, f] of followers) {
    if (path.slice(projectsDir.length + 1).split(sep).length !== 2) continue;
    sessions[basename(path, '.jsonl')] = {
      title: f.aiTitle ?? f.firstPrompt ?? null,
      folder: f.folder,
      lastAt: f.lastAt,
      pausedAt: f.pausedAt,
    };
  }
  return sessions;
}

function zero() {
  return { fiveHour: 0, sevenDay: 0 };
}

function tally(followers, projectsDir, at) {
  const total = zero();
  const bySession = {};
  for (const [path, follower] of followers) {
    const session = sessionOf(path, projectsDir);
    for (const { at: when, tokens } of follower.usage) {
      for (const [name, span] of Object.entries(WINDOWS)) {
        if (when < at - span || when > at + 60_000) continue;
        total[name] += tokens;
        if (session) (bySession[session] ??= zero())[name] += tokens;
      }
    }
  }
  return { total, bySession };
}

// <project>/<session>.jsonl, or <project>/<session>/subagents/<agent>.jsonl.
function sessionOf(path, projectsDir) {
  const parts = path.slice(projectsDir.length + 1).split(sep);
  if (parts.length === 2) return basename(parts[1], '.jsonl');
  if (parts.length === 4 && parts[2] === 'subagents') return parts[1];
  return null;
}

async function recentTranscripts(projectsDir, since) {
  let names;
  try {
    names = await readdir(projectsDir, { recursive: true });
  } catch {
    return new Set();
  }
  const paths = new Set();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(projectsDir, name);
    try {
      if ((await stat(path)).mtimeMs >= since) paths.add(path);
    } catch {
      // Gone since the listing.
    }
  }
  return paths;
}

async function readPlan(file) {
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const limit = (l) => (l && Number.isFinite(l.used_percentage)
    ? { percent: l.used_percentage, resetsAt: Number.isFinite(l.resets_at) ? new Date(l.resets_at * 1000).toISOString() : null }
    : null);
  const fiveHour = limit(data?.rate_limits?.five_hour);
  const sevenDay = limit(data?.rate_limits?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, asOf: Number.isFinite(data.at) ? new Date(Math.round(data.at * 1000)).toISOString() : null };
}

function report(err) {
  console.error(`[claude-dashboard] ${err?.message ?? err}`);
}
