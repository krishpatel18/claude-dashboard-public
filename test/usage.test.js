import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openUsage } from '../src/usage.js';
import { makeHome, waitFor } from './fixtures.js';

const NOW = Date.parse('2026-10-20T14:00:00.000Z');
const ago = (hours) => new Date(NOW - hours * 3600_000).toISOString();

// One reply as Claude Code writes it: a line per content block, each repeating
// the same message id and usage.
function reply(id, hoursAgo, { input = 10, cacheWrite = 100, cacheRead = 5000, output = 50 } = {}) {
  const usage = { input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output };
  const line = (content) => JSON.stringify({ type: 'assistant', timestamp: ago(hoursAgo), message: { id, role: 'assistant', content: [content], usage } });
  return `${line({ type: 'text', text: 'hi' })}\n${line({ type: 'tool_use', name: 'Bash', input: {} })}\n`;
}

let home;
let usage;
afterEach(() => {
  usage?.close();
  usage = undefined;
  home?.cleanup();
  home = undefined;
});

async function open(extra = {}) {
  home ??= makeHome();
  usage = await openUsage({
    usageFile: join(home.root, 'dashboard', 'usage.json'),
    projectsDir: home.projectsDir,
    now: () => NOW,
    debounceMs: 20,
    ...extra,
  });
  return usage;
}

test('plan limits come from the saved status-line figures, with when they were saved', async () => {
  home = makeHome();
  mkdirSync(join(home.root, 'dashboard'));
  writeFileSync(join(home.root, 'dashboard', 'usage.json'), JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 40, resets_at: 1792518600 }, seven_day: { used_percentage: 27.5, resets_at: 1792900800 } },
    at: 1792504358.06,
  }));

  const { plan } = (await open()).snapshot();

  assert.deepEqual(plan, {
    fiveHour: { percent: 40, resetsAt: new Date(1792518600_000).toISOString() },
    sevenDay: { percent: 27.5, resetsAt: new Date(1792900800_000).toISOString() },
    asOf: new Date(1792504358_060).toISOString(),
  });
});

test('no saved figures, or unreadable ones, means no plan section rather than an error', async () => {
  assert.equal((await open()).snapshot().plan, null);
  usage.close();
  mkdirSync(join(home.root, 'dashboard'));
  writeFileSync(join(home.root, 'dashboard', 'usage.json'), '{"rate_limits": {"five_hour": {"used_percentage": "lots"}}}');
  assert.equal((await open()).snapshot().plan, null);
});

test('tokens are counted once per reply, cache reads left out, in 5-hour and 7-day windows', async () => {
  home = makeHome();
  const dir = join(home.projectsDir, '-Users-krish');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'aaa.jsonl'), reply('m1', 1) + reply('m2', 30) + reply('m3', 24 * 8));

  const { tokens } = (await open()).snapshot();

  // Each reply: 10 + 100 + 50 = 160, written twice but counted once.
  assert.deepEqual(tokens.total, { fiveHour: 160, sevenDay: 320 });
  assert.deepEqual(tokens.bySession.aaa, { fiveHour: 160, sevenDay: 320 });
});

test('a chat\'s subagents count toward that chat', async () => {
  home = makeHome();
  const dir = join(home.projectsDir, '-Users-krish');
  mkdirSync(join(dir, 'aaa', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'aaa.jsonl'), reply('m1', 1));
  writeFileSync(join(dir, 'aaa', 'subagents', 'agent-1.jsonl'), reply('s1', 2, { output: 840 }));

  const { tokens } = (await open()).snapshot();

  assert.deepEqual(tokens.bySession.aaa, { fiveHour: 160 + 950, sevenDay: 160 + 950 });
  assert.deepEqual(tokens.total, { fiveHour: 1110, sevenDay: 1110 });
});

test('new figures and new replies are pushed to subscribers as they land', async () => {
  home = makeHome();
  const dir = join(home.projectsDir, '-Users-krish');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home.root, 'dashboard'));
  writeFileSync(join(dir, 'aaa.jsonl'), reply('m1', 1));
  await open();
  const seen = [];
  usage.subscribe((snapshot) => seen.push(snapshot));

  appendFileSync(join(dir, 'aaa.jsonl'), reply('m2', 0.5));
  await waitFor(() => seen.at(-1)?.tokens.total.fiveHour === 320);

  writeFileSync(join(home.root, 'dashboard', 'usage.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 41, resets_at: 1 } }, at: 2 }));
  await waitFor(() => seen.at(-1)?.plan?.fiveHour.percent === 41);
});

// ---- Recent sessions: paused (bye-bye) and ended ----

const userLine = (text, hoursAgo, extra = {}) => JSON.stringify({ type: 'user', timestamp: ago(hoursAgo), cwd: '/Users/k/proj', message: { role: 'user', content: text }, ...extra }) + '\n';
const byeBye = (hoursAgo) => JSON.stringify({ type: 'assistant', timestamp: ago(hoursAgo), message: { id: `bb${hoursAgo}`, role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'bye-bye' } }] } }) + '\n';
const title = (t) => JSON.stringify({ type: 'ai-title', aiTitle: t }) + '\n';

test('each recent chat says its title, folder, last activity, and whether bye-bye paused it', async () => {
  home = makeHome();
  const dir = join(home.projectsDir, '-Users-k-proj');
  mkdirSync(join(dir, 'paused', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'paused.jsonl'), userLine('fix the bug', 3) + title('Bug fix') + userLine('bye bye', 2) + byeBye(1.9));
  writeFileSync(join(dir, 'paused', 'subagents', 'agent-1.jsonl'), reply('s1', 1));
  writeFileSync(join(dir, 'resumed.jsonl'), userLine('start', 5) + byeBye(4) + userLine('continue', 3) + reply('m9', 2.5));
  writeFileSync(join(dir, 'ended.jsonl'), userLine('quick question', 6) + reply('m8', 5.5));

  const { sessions } = (await open()).snapshot();

  assert.deepEqual(Object.keys(sessions).sort(), ['ended', 'paused', 'resumed']);
  // Paused from when you typed bye-bye, not when the skill started a moment later.
  assert.deepEqual(sessions.paused, { title: 'Bug fix', folder: '/Users/k/proj', lastAt: ago(1.9), pausedAt: ago(2) });
  assert.equal(sessions.resumed.pausedAt, null);
  assert.equal(sessions.ended.pausedAt, null);
  assert.equal(sessions.ended.title, 'quick question');
  assert.equal(sessions.ended.lastAt, ago(5.5));
});

test('typing bye-bye pauses a chat even when the skill was already loaded and isn\'t called again', async () => {
  home = makeHome();
  const dir = join(home.projectsDir, '-Users-k-proj');
  mkdirSync(dir, { recursive: true });
  const wrapUp = JSON.stringify({ type: 'assistant', timestamp: ago(1.9), message: { id: 'w1', role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'write handoff' } }] } }) + '\n';
  writeFileSync(join(dir, 'typed.jsonl'), userLine('work', 3) + userLine('bye-bye', 2) + wrapUp);
  writeFileSync(join(dir, 'spaced.jsonl'), userLine('work', 3) + userLine('Bye bye', 2));
  writeFileSync(join(dir, 'command.jsonl'), userLine('work', 3) + userLine('<command-name>/bye-bye</command-name>', 2));
  writeFileSync(join(dir, 'chatter.jsonl'), userLine('say bye-bye to the old parser', 2));
  writeFileSync(join(dir, 'back.jsonl'), userLine('bye bye', 4) + userLine('continue', 3));

  const { sessions } = (await open()).snapshot();

  assert.equal(sessions.typed.pausedAt, ago(2));
  assert.equal(sessions.spaced.pausedAt, ago(2));
  assert.equal(sessions.command.pausedAt, ago(2));
  assert.equal(sessions.chatter.pausedAt, null);
  assert.equal(sessions.back.pausedAt, null);
});
