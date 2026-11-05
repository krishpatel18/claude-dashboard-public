import { open, stat } from 'node:fs/promises';

const MAX_TEXT = 20_000;
const NEWLINE = 0x0a;

// Everything a person would read in one transcript line, as
// { role: 'user' | 'assistant' | 'tool', text, at } messages. Bookkeeping
// lines, hidden context, thinking and tool output give nothing.
export function messagesOf(entry) {
  if (!entry || typeof entry !== 'object' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return [];
  const at = entry.timestamp ?? null;
  const content = entry.message?.content;
  if (entry.type === 'user') {
    return userMessages(content).map((m) => ({ ...m, text: clip(m.text), at }));
  }
  if (entry.type === 'assistant' && Array.isArray(content)) {
    const out = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ role: 'assistant', text: clip(block.text.trim()), at });
      }
      if (block?.type === 'tool_use') out.push({ role: 'tool', text: toolSummary(block), at });
    }
    return out;
  }
  return [];
}

export function parseLines(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn or foreign line: nothing to show.
    }
  }
  return entries;
}

// A line of a shape no version we know writes gives nothing rather than
// stopping the lines after it.
function safeMessagesOf(entry) {
  try {
    return messagesOf(entry);
  } catch {
    return [];
  }
}

// Seeded from the clock so a restarted server never reuses an epoch a page
// still holds from before.
let nextEpoch = Date.now();

// Follows one transcript file as it grows, reading only appended bytes. Keeps
// what the page shows: the latest AI title, the first prompt, and the latest
// `history` messages, each numbered (`seq`) so a reader can ask for only what
// came after the last one it has. `epoch` changes whenever the file had to be
// read again from the start, which restarts the numbering.
export class TranscriptFollower {
  constructor(path, { keep = 4, history = 400 } = {}) {
    this.path = path;
    this.keep = keep;
    this.historySize = Math.max(history, keep);
    Object.assign(this, blank(null));
  }

  get recent() {
    return this.history.slice(-this.keep);
  }

  // `reset` is true when the reader must replace what it shows rather than
  // append: no earlier answer, a different epoch, it fell further behind than
  // the kept messages reach, or it claims messages this read doesn't have.
  conversation({ after, epoch } = {}) {
    const firstKept = this.history[0]?.seq ?? this.total + 1;
    const reset = epoch !== this.epoch || !Number.isInteger(after) || after < firstKept - 1 || after > this.total;
    return {
      epoch: this.epoch,
      total: this.total,
      reset,
      messages: reset ? this.history : this.history.filter((m) => m.seq > after),
    };
  }

  // Resolves true when something a reader would see changed. A re-read from
  // the start fills a fresh state and swaps it in only when done, so readers
  // never see a half-read transcript.
  async update() {
    let info;
    try {
      info = await stat(this.path);
    } catch {
      return false;
    }
    const restart = info.ino !== this.ino || info.size < this.offset;
    const state = restart ? blank(info.ino) : this;
    let changed = restart && this.ino !== null;

    if (info.size > state.offset) {
      const handle = await open(this.path, 'r');
      let chunk;
      try {
        chunk = Buffer.alloc(info.size - state.offset);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, state.offset);
        chunk = chunk.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      // Only whole lines are parsed; a half-written last line waits for the rest.
      const bytes = Buffer.concat([state.carry, chunk]);
      const cut = bytes.lastIndexOf(NEWLINE) + 1;
      const entries = parseLines(bytes.subarray(0, cut).toString('utf8'));
      state.offset += chunk.length;
      state.carry = Buffer.from(bytes.subarray(cut));
      for (const entry of entries) if (take(state, entry)) changed = true;
      if (state.history.length > this.historySize) state.history = state.history.slice(-this.historySize);
    }
    if (restart) Object.assign(this, state);
    return changed;
  }
}

// Token use per reply, as { at, tokens }. Claude Code writes a reply as one
// line per content block, each repeating the same id and usage, so each id
// counts once. Tokens are input + cache writes + output; cache reads are
// left out.
function countUsage(state, entry) {
  const id = entry?.message?.id;
  const u = entry?.type === 'assistant' ? entry.message?.usage : null;
  if (!u || typeof u !== 'object' || typeof id !== 'string' || state.usageSeen.has(id)) return;
  state.usageSeen.add(id);
  const at = Date.parse(entry.timestamp ?? '');
  const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
  const tokens = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.output_tokens);
  if (!Number.isNaN(at) && tokens > 0) state.usage.push({ at, tokens });
}

const BYE_BYE = 'bye-bye';
// What you type to wrap a chat up: "bye-bye", "bye bye", "byebye" or the
// /bye-bye command, alone in the message.
const TYPED_BYE_BYE = /^\/?bye[\s-]?bye[.!]*$/i;

// Where and when the chat last did anything, and whether bye-bye paused it:
// you typed bye-bye (or Claude started the bye-bye skill) and haven't typed
// anything since. Typing it counts on its own because a chat that already
// loaded the skill follows it without starting it again.
function notePause(state, entry) {
  if (typeof entry?.cwd === 'string' && entry.cwd) state.folder = entry.cwd;
  const at = typeof entry?.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)) ? entry.timestamp : null;
  if (!at) return;
  if (!state.lastAt || at > state.lastAt) state.lastAt = at;
  const content = entry.message?.content;
  const typed = safeMessagesOf(entry).filter((m) => m.role === 'user');
  if (entry.type === 'assistant' && Array.isArray(content)
    && content.some((b) => b?.type === 'tool_use' && b.name === 'Skill' && b.input?.skill === BYE_BYE)) {
    state.pausedAt ??= at;
  } else if (typed.some((m) => TYPED_BYE_BYE.test(m.text.trim()))) {
    state.pausedAt = at;
  } else if (state.pausedAt && at > state.pausedAt && typed.length) {
    state.pausedAt = null;
  }
}

function blank(ino) {
  return {
    offset: 0, ino, carry: Buffer.alloc(0),
    aiTitle: null, firstPrompt: null, history: [], total: 0,
    usage: [], usageSeen: new Set(),
    folder: null, lastAt: null, pausedAt: null,
    epoch: nextEpoch++,
  };
}

function take(state, entry) {
  let changed = false;
  countUsage(state, entry);
  notePause(state, entry);
  if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim() && entry.aiTitle !== state.aiTitle) {
    state.aiTitle = entry.aiTitle;
    changed = true;
  }
  for (const message of safeMessagesOf(entry)) {
    if (!state.firstPrompt && message.role === 'user') state.firstPrompt = message.text;
    state.history.push({ seq: ++state.total, ...message });
    changed = true;
  }
  return changed;
}

// A user-role line holds what the person typed and what Claude Code injected
// in their turn: command echoes, job notices, messages from other sessions.
// Injected parts become 'tool' lines so they never read as typed text.
function userMessages(content) {
  if (typeof content === 'string') return fromUserText(content);
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push(...fromUserText(block.text));
    else if (block?.type === 'image') out.push({ role: 'user', text: '[image]' });
  }
  // Text and images typed together read as one message.
  const merged = [];
  for (const m of out) {
    const prev = merged.at(-1);
    if (prev?.role === 'user' && m.role === 'user') prev.text += `\n${m.text}`;
    else merged.push({ ...m });
  }
  return merged;
}

const INJECTED = /<(task-notification|cross-session-message|teammate-message)\b([^>]*)>([\s\S]*?)<\/\1>/g;

function fromUserText(raw) {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return [];
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '';
    return [{ role: 'user', text: `${command[1].trim()} ${args.trim()}`.trim() }];
  }
  const shell = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (shell) return [{ role: 'user', text: `! ${shell[1].trim()}` }];
  // Output echoed back from local commands and shell escapes, and context
  // markers that were never typed.
  if (/^<(local-command-[a-z]+|bash-std(out|err)|artifact-content-authored-by-others)\b/.test(text)) return [];

  const out = [];
  let rest = '';
  let last = 0;
  for (const m of text.matchAll(INJECTED)) {
    rest += text.slice(last, m.index);
    last = m.index + m[0].length;
    const typed = rest.trim();
    if (typed) out.push(typedMessage(typed));
    rest = '';
    out.push({ role: 'tool', text: injectedText(m[1], m[2], m[3]) });
  }
  const tail = (rest + text.slice(last)).trim();
  if (tail) out.push(typedMessage(tail));
  return out;
}

function typedMessage(text) {
  return { role: 'user', text: text.replace(/<\/?pasted_content\b[^>]*>/g, '') };
}

function injectedText(tag, attributes, body) {
  if (tag === 'task-notification') {
    return /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim() || 'Background task finished';
  }
  const from = tag === 'cross-session-message' ? /from="([^"]*)"/.exec(attributes)?.[1] : null;
  const message = body.trim().replace(/\s+/g, ' ');
  return `Message from ${from || 'a teammate'}: ${message}`;
}

function toolSummary(block) {
  const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const parts = name.split('__');
  const label = parts[0] === 'mcp' && parts.length >= 3 ? `${parts.slice(2).join('__')} (${parts[1]})` : name;
  const detail = [input.description, input.command, input.file_path, input.pattern, input.url, input.query, input.prompt]
    .find((v) => typeof v === 'string' && v.trim());
  return detail ? `${label}: ${clip(detail.trim(), 300)}` : label;
}

function clip(text, max = MAX_TEXT) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
