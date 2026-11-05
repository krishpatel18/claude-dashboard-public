import { select, titleOf, neighbor } from '/selection.js';
import { readText, writeText, readJson, writeJson } from '/saved.js';

const STATUS_LABELS = { waiting: 'Needs you', busy: 'Working', shell: 'Running shell', idle: 'Idle', unknown: 'Status unknown' };
const statusLabel = (status) => STATUS_LABELS[status] ?? STATUS_LABELS.unknown;
const MAX_ROWS = 400; // matches how many messages the server keeps per chat

const $ = (id) => document.getElementById(id);
const gallery = $('gallery');
const tiles = new Map(); // chat id → tile element
const tileState = new Map(); // chat id → what the tile was last drawn from

let chats = [];
let haveList = false; // until the first list arrives, a missing chat isn't "closed"
const knownTitles = new Map(); // chat id → last title seen, for chats that close
let lastSummary = '';
let usage = null; // plan limits and token counts, from the server
const lastStatus = new Map(); // chat id → status in the previous list
const finished = new Set(); // chats that finished since you last opened them
const WORKING = new Set(['busy', 'shell']);
let filter = '';
let openId = null;
let conversationTimer = null;
// What the conversation list shows: which chat, which read of its transcript
// (epoch) and the last message number, so updates only append.
let shownConversation = null;
let conversationRequest = null;

// ---- Key and live connection ---------------------------------------------

// The server prints a single-use link ending in #pair=<code>. The page
// trades the code for the key once and keeps the key in this browser's
// storage for this address, so later visits need no link. The link is
// removed from the address bar straight away, whatever happens next.
const KEY_STORE = 'claude-dashboard-key';
let key = readText(KEY_STORE);
let locked = false;

// Takes a #pair= (or old #k=) link out of the address bar and returns its code.
function takePairingCode() {
  if (!/^#(pair|k)=/.test(location.hash)) return null;
  const code = /^#pair=([0-9a-f]{32})$/.exec(location.hash)?.[1] ?? null;
  history.replaceState(null, '', location.pathname);
  return code;
}

// A pairing link opened in this tab, at load or pasted in later.
async function usePairingLink(code) {
  if (await pair(code)) {
    if (locked) location.reload(); // start clean with the new key
    return;
  }
  if (!key) showLocked('That setup link didn\u2019t work; each one works only once. Restart the dashboard to print a new one, then open it here.');
}

// Another tab finished setting this browser up.
window.addEventListener('storage', (e) => {
  if (e.key === KEY_STORE && e.newValue && locked) location.reload();
});

async function pair(code) {
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'x-pairing-code': code } });
    if (!res.ok) return false;
    key = (await res.json()).key;
    writeText(KEY_STORE, key); // if storage is blocked, the key lasts this visit
    return true;
  } catch {
    return false;
  }
}

function api(path, options = {}) {
  return fetch(path, { ...options, headers: { ...options.headers, 'x-dashboard-key': key ?? '' } });
}

// Nothing about chats is shown while locked: the list is cleared, and
// renders are skipped until the page is set up again.
function showLocked(message) {
  locked = true;
  setIndicator('off', 'Locked');
  if (openId) closeChat();
  chats = [];
  for (const el of tiles.values()) el.remove();
  tiles.clear();
  tileState.clear();
  $('summary').textContent = '';
  lastSummary = '';
  const empty = $('empty');
  empty.hidden = false;
  empty.textContent = message ?? 'This page needs setting up. Open the link printed when you started the dashboard (it ends in #pair=\u2026), here or in a new tab. Each link works once; restarting the dashboard prints a new one.';
}

let retryDelay = 1000;

async function connect() {
  // EventSource can't report a refused key, so check it with one plain request first.
  try {
    const res = await api('/api/chats');
    if (res.status === 401) return showLocked();
  } catch {
    // Server not up yet; the stream below retries and the indicator says so.
  }
  const events = new EventSource(`/api/events?k=${encodeURIComponent(key ?? '')}`);
  events.addEventListener('open', () => {
    locked = false;
    retryDelay = 1000;
    setLive(true);
    // Messages that arrived while disconnected were never announced.
    if (openId) loadConversation(openId);
  });
  events.addEventListener('error', () => {
    setLive(false);
    // A refused or odd answer closes the stream for good; start over, which
    // also notices a key that no longer works.
    if (events.readyState === EventSource.CLOSED) {
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  });
  events.addEventListener('chats', (e) => {
    chats = JSON.parse(e.data);
    noticeFinished(chats, haveList);
    haveList = true;
    for (const c of chats) knownTitles.set(c.id, titleFor(c));
    render();
  });
  events.addEventListener('approvals', (e) => {
    const before = new Set(approvals.map((a) => a.id));
    approvals = JSON.parse(e.data);
    for (const a of approvals) {
      if (before.has(a.id)) continue;
      const chat = chats.find((c) => c.sessionId === a.sessionId);
      if (chat && !(chat.id === openId && document.hasFocus())) alertMac(`Approve? ${titleFor(chat)}`, `${a.tool}: ${a.detail}`, chat.id);
    }
    render();
  });
  events.addEventListener('groups', (e) => {
    groups = JSON.parse(e.data);
    for (const c of chats) knownTitles.set(c.id, titleFor(c));
    render();
  });
  events.addEventListener('usage', (e) => {
    usage = JSON.parse(e.data);
    renderUsage();
    render();
  });
  events.addEventListener('conversation', (e) => {
    const { id } = JSON.parse(e.data);
    if (id !== openId) return;
    clearTimeout(conversationTimer);
    conversationTimer = setTimeout(() => loadConversation(id), 150);
  });
}

function setLive(on) {
  setIndicator(on ? 'on' : 'off', on ? 'Live' : 'Reconnecting… (is the dashboard server running?)');
  // Tiles stop looking live while what they show may be out of date.
  document.body.classList.toggle('offline', !on);
}

// The connection state, shown in the header and inside an open chat.
function setIndicator(state, text) {
  for (const el of [$('live'), $('stage-live')]) {
    el.className = `live ${state}`;
    el.textContent = text;
  }
}

// Moving an element that holds focus drops the focus; put it back.
function place(parent, el, before) {
  const focused = el.contains(document.activeElement) ? document.activeElement : null;
  parent.insertBefore(el, before);
  if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

// ---- View: which chats, grouped how, how many per screen ------------------

// Columns × rows for each "per screen" choice, like a video-call gallery.
const LAYOUTS = { 4: [2, 2], 6: [3, 2], 8: [4, 2], 10: [5, 2], 12: [4, 3], 16: [4, 4] };
const VIEW_STORE = 'claude-dashboard-view';
const view = (() => {
  const saved = readJson(VIEW_STORE, {}) ?? {};
  return {
    show: ['active', 'closed'].includes(saved.show) ? saved.show : 'all',
    perScreen: LAYOUTS[saved.perScreen] ? saved.perScreen : 0,
    page: 0,
    group: typeof saved.group === 'string' ? saved.group : 'all',
    collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter((x) => typeof x === 'string') : [],
  };
})();

function saveView() {
  writeJson(VIEW_STORE, { show: view.show, perScreen: view.perScreen, group: view.group, collapsed: view.collapsed });
}

let groups = { groups: [], chats: {} }; // your groups and chat names, from the server
let approvals = []; // permission requests waiting for an answer here
const approvalFor = (chat) => approvals.find((a) => a.sessionId === chat.sessionId) ?? null;
let selection = null; // what select() last decided is on screen

const titleFor = (chat) => titleOf(chat, groups);
const groupIdOf = (chat) => groups.chats[chat.sessionId]?.group ?? '';

function renderViewBar(sel) {
  for (const btn of document.querySelectorAll('[data-show]')) btn.setAttribute('aria-pressed', String(btn.dataset.show === view.show));
  $('per-screen').value = String(view.perScreen);
  const pick = $('group-pick');
  pick.hidden = !view.perScreen || !groups.groups.length;
  pick.innerHTML = `<option value="all">All groups</option>${groups.groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}`;
  pick.value = groups.groups.some((g) => g.id === view.group) ? view.group : 'all';
  const [cols, rows] = LAYOUTS[view.perScreen] ?? [0, 0];
  gallery.classList.toggle('paged', Boolean(view.perScreen));
  gallery.classList.toggle('grouped', !view.perScreen && groups.groups.length > 0);
  gallery.style.setProperty('--cols', cols);
  gallery.style.setProperty('--rows', rows);
  $('pager').hidden = sel.page.count <= 1;
  $('page-label').textContent = `${sel.page.index + 1} / ${sel.page.count}`;
  $('page-prev').disabled = sel.page.index === 0;
  $('page-next').disabled = sel.page.index >= sel.page.count - 1;
}

function turnPage(step) {
  view.page = Math.max(0, (selection?.page.index ?? 0) + step);
  render();
}

document.querySelector('.viewbar').addEventListener('click', (e) => {
  const show = e.target.closest('[data-show]')?.dataset.show;
  if (show) {
    view.show = show;
    view.page = 0;
    saveView();
    render();
  }
  if (e.target.closest('#new-group')) startNewGroup();
});
$('per-screen').addEventListener('change', (e) => {
  view.perScreen = Number(e.target.value);
  view.page = 0;
  saveView();
  render();
});
$('group-pick').addEventListener('change', (e) => {
  view.group = e.target.value;
  view.page = 0;
  saveView();
  render();
});
$('page-prev').addEventListener('click', () => turnPage(-1));
$('page-next').addEventListener('click', () => turnPage(1));

function render() {
  if (locked) return;
  const showClosed = view.show === 'closed';
  gallery.hidden = showClosed;
  $('closed-view').hidden = !showClosed;
  for (const id of ['per-screen-label', 'new-group-slot']) $(id).hidden = showClosed;
  selection = select({ chats, groups, finished, filter, view: showClosed ? { ...view, show: 'all' } : view });
  renderViewBar(selection);
  const needs = chats.filter((c) => c.status === 'waiting').length;
  const working = chats.filter((c) => c.status === 'busy' || c.status === 'shell').length;

  const done = chats.filter((c) => finished.has(c.id)).length;
  document.title = [needs ? `(${needs})` : null, done ? `✓${done}` : null, 'Claude chats'].filter(Boolean).join(' ');
  const summary = [
    `${chats.length} open`,
    `${working} working`,
    done ? `<span class="done">${done} done</span>` : null,
    needs ? `<span class="needs">${needs} need${needs === 1 ? 's' : ''} you</span>` : null,
  ].filter(Boolean).join(' · ');
  if (summary !== lastSummary) {
    $('summary').innerHTML = summary;
    lastSummary = summary;
  }
  // Screen readers hear only when the number needing you changes.
  // One announcer outside the open chat, one inside it (the rest of the page
  // is hidden from screen readers while a chat is open).
  const announce = needs ? `${needs} chat${needs === 1 ? '' : 's'} need${needs === 1 ? 's' : ''} you` : '';
  for (const el of document.querySelectorAll('.needs-announcer')) if (el.textContent !== announce) el.textContent = announce;

  if (showClosed) {
    for (const btn of document.querySelectorAll('[data-show]')) btn.setAttribute('aria-pressed', String(btn.dataset.show === view.show));
    $('pager').hidden = true;
    $('group-pick').hidden = true;
    $('empty').hidden = true;
    renderClosed();
    if (openId) renderSpotlightChrome();
    return;
  }
  renderSections(selection);

  const tilesShown = selection.sections.some((s) => s.chats.length);
  const empty = $('empty');
  empty.hidden = tilesShown || (groups.groups.length && !view.perScreen && chats.length);
  empty.textContent = !chats.length ? 'No Claude chats are open right now. Start one and it will appear here.'
    : filter ? 'No chats match the filter.'
      : view.show === 'active' ? 'Nothing active right now: no chat is working, needs you, or has just finished. Choose All to see every chat.'
        : 'No chats in this group.';

  if (openId) renderSpotlightChrome();
}

// ---- Sections and tiles ----------------------------------------------------

const sectionEls = new Map(); // section id → its element

function buildSection(id) {
  const el = document.createElement('section');
  el.className = 'group';
  el.dataset.group = id;
  el.innerHTML = `
    <header class="group-head">
      <button class="group-toggle" aria-expanded="true"><span class="chev" aria-hidden="true">▾</span><span class="group-name"></span></button>
      <span class="group-count"></span>
      <span class="group-actions"></span>
    </header>
    <div class="section-grid"></div>`;
  return el;
}

function fillSection(el, section) {
  const head = el.querySelector('.group-head');
  head.hidden = !section.name;
  el.classList.toggle('collapsed', section.collapsed);
  el.querySelector('.group-toggle').setAttribute('aria-expanded', String(!section.collapsed));
  el.querySelector('.group-name').textContent = section.name;
  const active = section.activeCount ? ` · ${section.activeCount} active` : '';
  el.querySelector('.group-count').textContent = `${section.total} chat${section.total === 1 ? '' : 's'}${active}`;
  const actions = el.querySelector('.group-actions');
  const deletable = section.id !== 'ungrouped';
  if (!actions.dataset.confirming) {
    actions.innerHTML = deletable ? '<button class="link-btn" data-act="rename-group">Rename</button><button class="link-btn" data-act="delete-group">Delete</button>' : '';
  }
}

function renderSections(sel) {
  const keepSections = new Set(sel.sections.map((s) => s.id));
  for (const [id, el] of sectionEls) {
    if (!keepSections.has(id)) {
      el.remove();
      sectionEls.delete(id);
    }
  }
  const onScreen = new Set(sel.sections.flatMap((s) => s.chats.map((c) => c.id)));
  for (const [id, el] of tiles) {
    if (!onScreen.has(id)) {
      el.remove();
      tiles.delete(id);
      tileState.delete(id);
    }
  }
  const options = groupOptions();
  sel.sections.forEach((section, i) => {
    let el = sectionEls.get(section.id);
    if (!el) sectionEls.set(section.id, (el = buildSection(section.id)));
    fillSection(el, section);
    if (gallery.children[i] !== el) place(gallery, el, gallery.children[i] ?? null);
    const grid = el.querySelector('.section-grid');
    section.chats.forEach((chat, j) => {
      let tile = tiles.get(chat.id);
      if (!tile) {
        tile = document.createElement('article');
        tile.className = 'tile';
        tile.dataset.id = chat.id;
        tile.draggable = true;
        buildTile(tile, chat.id);
        tiles.set(chat.id, tile);
      }
      const keyIndex = sel.keys.indexOf(chat.id);
      const drawnFrom = `${keyIndex}|${usage?.sessions?.[chat.sessionId]?.pausedAt ?? ''}|${JSON.stringify(approvalFor(chat))}|${finished.has(chat.id)}|${titleFor(chat)}|${groupIdOf(chat)}|${options}|${JSON.stringify(tokensFor(chat))}|${JSON.stringify(chat)}`;
      if (tileState.get(chat.id) !== drawnFrom) {
        fillTile(tile, chat, keyIndex, options);
        tileState.set(chat.id, drawnFrom);
      }
      if (grid.children[j] !== tile) place(grid, tile, grid.children[j] ?? null);
    });
  });
}

// The "Move to…" menu's choices: Ungrouped, each group, then actions.
function groupOptions() {
  return `<option value="">Ungrouped</option>${groups.groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}`
    + '<option value="__new">New group…</option><option value="__rename">Rename chat…</option>';
}

// A tile is an article holding two real buttons: its title opens the chat
// (and, stretched, covers the tile for mouse clicks), and "Go to" brings its
// window forward. No control sits inside another. The tile is built once and
// later updates change only text and attributes, so its buttons, and any
// keyboard focus or half-finished click on them, survive.
function buildTile(el, id) {
  el.innerHTML = `
    <div class="tile-head">
      <span class="dot"></span>
      <button class="tile-open" data-open="${id}">
        <span class="tile-title"></span>
        <span class="visually-hidden"></span>
      </button>
      <select class="move" aria-label="Group for this chat" title="Move to a group, or rename"></select>
      <span class="key" aria-hidden="true"></span>
    </div>
    <div class="pane" aria-hidden="true"></div>
    <div class="approval" hidden></div>
    <div class="tile-handle"><button class="handle" title="Click to copy: type this in another chat to message this one"></button></div>
    <div class="tile-foot">
      <span class="chip waiting">Needs you</span>
      <span class="chip app"></span>
      <span class="folder"></span>
      <span class="chip done">Done</span>
      <span class="chip paused" title="Paused with bye-bye; type continue in the chat to pick it up">Paused</span>
      <span class="tokens"></span>
      <span class="ago"></span>
      <button class="raise-btn" data-raise="${id}">Go to ↗</button>
    </div>`;
}

function fillTile(el, chat, index, options) {
  const part = (selector) => el.querySelector(selector);
  const label = chat.appLabel ?? 'Other app';
  el.classList.toggle('waiting', chat.status === 'waiting');
  part('.dot').className = `dot ${chat.status}`;
  part('.dot').title = statusLabel(chat.status);
  el.dataset.session = chat.sessionId;
  fillApproval(el.querySelector('.approval'), approvalFor(chat));
  el.classList.toggle('asking', Boolean(approvalFor(chat)));
  part('.tile-title').textContent = titleFor(chat);
  part('.tile-open .visually-hidden').textContent = `, ${statusLabel(chat.status)}, in ${label}`;
  const key = part('.key');
  key.hidden = index < 0 || index >= 9;
  key.textContent = String(index + 1);
  key.title = `Press ${index + 1} to open`;
  part('.pane').innerHTML = chat.recent.length
    ? chat.recent.map((m) => `<div class="line ${m.role}">${escapeHtml(plain(m.text))}</div>`).join('')
    : '<div class="line none">No messages yet</div>';
  part('.chip.waiting').hidden = chat.status !== 'waiting';
  part('.chip.app').textContent = label;
  const handle = part('.handle');
  handle.hidden = !chat.handle;
  handle.textContent = chat.handle ? `@${chat.handle}` : '';
  handle.dataset.handle = chat.handle ?? '';
  const folder = part('.folder');
  folder.title = chat.folder ?? '';
  folder.textContent = `\u200e${shortFolder(chat.folder)}\u200e`;
  part('.chip.done').hidden = !finished.has(chat.id);
  part('.chip.paused').hidden = !usage?.sessions?.[chat.sessionId]?.pausedAt;
  const tokens = tokensFor(chat);
  const tokenLabel = part('.tokens');
  tokenLabel.hidden = !tokens?.fiveHour;
  tokenLabel.textContent = tokens ? `${compact(tokens.fiveHour)} tok` : '';
  tokenLabel.title = tokens ? `Tokens used by this chat and its subagents: ${compact(tokens.fiveHour)} in the last 5 hours, ${compact(tokens.sevenDay)} in the last 7 days` : '';
  const ago = part('.ago');
  ago.dataset.at = lastActivity(chat) ?? '';
  ago.textContent = agoText(lastActivity(chat));
  const raise = part('.raise-btn');
  raise.setAttribute('aria-disabled', String(Boolean(chat.cannotFocus)));
  raise.setAttribute('aria-label', `Go to ${titleFor(chat)}`);
  const move = part('.move');
  if (move.dataset.options !== options) {
    move.innerHTML = options;
    move.dataset.options = options;
  }
  move.value = groupIdOf(chat);
  raise.title = chat.cannotFocus ?? `Bring its ${label} window to the front`;
}

let openTimer = null;
gallery.addEventListener('click', (e) => {
  if (e.target.closest('select, input, .editing')) return;
  const approve = e.target.closest('[data-choice]');
  if (approve) return answerApproval(approve.closest('[data-approval]').dataset.approval, approve.dataset.choice);
  const handle = e.target.closest('.handle');
  if (handle) return copyHandle(handle.dataset.handle);
  const raise = e.target.closest('[data-raise]');
  if (raise) return bringToFront(raise.dataset.raise);
  const head = e.target.closest('.group-head');
  if (head) return groupHeadClick(e, head.closest('.group').dataset.group);
  const tile = e.target.closest('.tile');
  if (!tile) return;
  // A click on the title waits a moment, in case it's the start of a
  // double-click to rename.
  clearTimeout(openTimer);
  if (e.target.closest('.tile-title') && e.detail === 1) openTimer = setTimeout(() => openChat(tile.dataset.id), 250);
  else if (e.detail <= 1) openChat(tile.dataset.id);
});
gallery.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.tile');
  if (tile && e.target.closest('.tile-title')) {
    clearTimeout(openTimer);
    renameChat(tile.dataset.id, tile.querySelector('.tile-head'));
  }
  const name = e.target.closest('.group-name');
  if (name) renameGroup(name.closest('.group').dataset.group);
});
gallery.addEventListener('change', (e) => {
  const move = e.target.closest('.move');
  if (!move) return;
  const tile = move.closest('.tile');
  const chat = chats.find((c) => c.id === tile.dataset.id);
  const choice = move.value;
  move.value = chat ? groupIdOf(chat) : '';
  if (!chat) return;
  if (choice === '__new') startNewGroup(chat.sessionId);
  else if (choice === '__rename') renameChat(chat.id, tile.querySelector('.tile-head'));
  else assignGroup(chat.sessionId, choice || null);
});

// Drag a tile onto a group's section to move it there.
gallery.addEventListener('dragstart', (e) => {
  const tile = e.target.closest?.('.tile');
  if (!tile) return;
  e.dataTransfer.setData('application/x-claude-session', tile.dataset.session);
  e.dataTransfer.effectAllowed = 'move';
  tile.classList.add('dragging');
});
gallery.addEventListener('dragend', (e) => {
  e.target.closest?.('.tile')?.classList.remove('dragging');
  for (const el of gallery.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
});
gallery.addEventListener('dragover', (e) => {
  const section = e.target.closest('.group');
  if (!section || !e.dataTransfer.types.includes('application/x-claude-session') || view.perScreen) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  for (const el of gallery.querySelectorAll('.drop-target')) if (el !== section) el.classList.remove('drop-target');
  section.classList.add('drop-target');
});
gallery.addEventListener('dragleave', (e) => {
  const section = e.target.closest('.group');
  if (section && !section.contains(e.relatedTarget)) section.classList.remove('drop-target');
});
gallery.addEventListener('drop', (e) => {
  const section = e.target.closest('.group');
  const sessionId = e.dataTransfer.getData('application/x-claude-session');
  if (!section || !sessionId) return;
  e.preventDefault();
  section.classList.remove('drop-target');
  const target = section.dataset.group === 'ungrouped' ? null : section.dataset.group;
  assignGroup(sessionId, target);
});

// The @name another chat uses to message this one, copied for pasting.
async function copyHandle(name) {
  if (!name) return;
  try {
    await navigator.clipboard.writeText(`@${name}`);
    toast(`Copied @${name}. In another chat, type something like: send your latest finding to @${name}`);
  } catch {
    toast(`Couldn\u2019t copy. The name is @${name}.`, { sticky: true });
  }
}
$('stage-handle').addEventListener('click', (e) => copyHandle(e.currentTarget.dataset.handle));

// ---- Closed chats: paused with bye-bye, or ended --------------------------

// Chats from the last 7 days that aren't open now, newest first, in two
// groups. Either can be reopened in a new Terminal window.
function renderClosed() {
  const open = new Set(chats.map((c) => c.sessionId));
  const q = filter.trim().toLowerCase();
  const rows = Object.entries(usage?.sessions ?? {})
    .filter(([sid, s]) => !open.has(sid) && s.lastAt)
    .map(([sid, s]) => ({ sid, ...s, title: groups.chats[sid]?.name ?? s.title ?? 'Untitled chat' }))
    .filter((r) => !q || `${r.title} ${r.folder ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));
  // Paused includes chats whose window is still open: you wrapped them up all the same.
  const openPaused = chats
    .filter((c) => usage?.sessions?.[c.sessionId]?.pausedAt)
    .map((c) => ({ sid: c.sessionId, chatId: c.id, title: titleFor(c), folder: c.folder, pausedAt: usage.sessions[c.sessionId].pausedAt, cannotFocus: c.cannotFocus }))
    .filter((r) => !q || `${r.title} ${r.folder ?? ''}`.toLowerCase().includes(q));
  const paused = [...openPaused, ...rows.filter((r) => r.pausedAt)].sort((a, b) => (b.pausedAt > a.pausedAt ? 1 : -1));
  const ended = rows.filter((r) => !r.pausedAt);
  const row = (r, kind) => `
    <li class="closed-row">
      <span class="dot ${kind === 'paused' ? 'paused' : 'idle'}" aria-hidden="true"></span>
      <span class="closed-title">${escapeHtml(r.title)}${r.chatId ? ' <span class="chip">still open</span>' : ''}</span>
      <span class="folder" title="${escapeHtml(r.folder ?? '')}">\u200e${escapeHtml(shortFolder(r.folder))}\u200e</span>
      <span class="closed-when">${kind === 'paused' ? 'paused' : 'last active'} ${escapeHtml(whenText(kind === 'paused' ? r.pausedAt : r.lastAt))}</span>
      ${r.chatId
    ? `<button class="ghost small" data-raise="${r.chatId}" title="${escapeHtml(r.cannotFocus ?? 'Bring its window to the front')}">Go to ↗</button>`
    : `<button class="${kind === 'paused' ? 'primary' : 'ghost'} small" data-resume="${r.sid}" title="Open it again in a new Terminal window">Resume</button>`}
    </li>`;
  const block = (title, list, kind, emptyText) => `
    <section class="closed-group">
      <h2>${title} <span class="group-count">${list.length}</span></h2>
      ${list.length ? `<ul>${list.map((r) => row(r, kind)).join('')}</ul>` : `<p class="note">${emptyText}</p>`}
    </section>`;
  $('closed-view').innerHTML = block('Paused', paused, 'paused', 'No paused chats. Chats you close with bye-bye show up here until you continue them.')
    + block('Ended', ended, 'ended', 'No other chats closed in the last 7 days.');
}

function whenText(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

$('closed-view').addEventListener('click', async (e) => {
  const raise = e.target.closest('[data-raise]');
  if (raise) return bringToFront(raise.dataset.raise);
  const btn = e.target.closest('[data-resume]');
  if (!btn) return;
  btn.disabled = true;
  const result = await post(`/api/sessions/${btn.dataset.resume}/resume`, {});
  btn.disabled = false;
  if (result?.ok) toast('Opened in a new Terminal window.');
  else if (result) toast(result.reason ?? 'Couldn\u2019t reopen it.', { sticky: true });
});

// ---- Approvals ------------------------------------------------------------

// A permission request waiting on a chat: what it wants to do, and buttons.
// Answering in the terminal instead always wins; the request then vanishes.
function fillApproval(el, approval) {
  el.hidden = !approval;
  if (!approval) {
    el.removeAttribute('data-approval');
    el.innerHTML = '';
    return;
  }
  if (el.dataset.approval === approval.id) return;
  el.dataset.approval = approval.id;
  el.innerHTML = `
    <p class="approval-ask">Wants to use <b>${escapeHtml(approval.tool)}</b></p>
    <code class="approval-detail" title="${escapeHtml(approval.detail)}">${escapeHtml(approval.detail)}</code>
    <div class="approval-actions">
      <button class="approve" data-choice="once">Allow once</button>
      ${approval.canAlwaysAllow ? `<button class="approve-always" data-choice="always" title="${escapeHtml(approval.alwaysLabel)}">Always allow</button>` : ''}
      <button class="deny" data-choice="deny">Deny</button>
    </div>`;
}

async function answerApproval(id, choice) {
  const result = await post(`/api/approvals/${id}/decide`, { choice });
  if (result) toast(choice === 'deny' ? 'Denied.' : choice === 'always' ? 'Allowed, and it won\u2019t ask again for this.' : 'Allowed.');
}

$('stage-approval').addEventListener('click', (e) => {
  const approve = e.target.closest('[data-choice]');
  if (approve) answerApproval(approve.closest('[data-approval]').dataset.approval, approve.dataset.choice);
});

// ---- Groups and names: changes go to the server, which streams them back --

async function post(path, body) {
  try {
    const res = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 401) return showLocked();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ? `Couldn\u2019t save: ${data.error}.` : 'Couldn\u2019t save that change.', { sticky: true });
      return null;
    }
    return data;
  } catch {
    toast('The dashboard server is not reachable.', { sticky: true });
    return null;
  }
}

function assignGroup(sessionId, groupId) {
  return post(`/api/sessions/${sessionId}/group`, { group: groupId });
}

function groupHeadClick(e, id) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'rename-group') return renameGroup(id);
  if (act === 'delete-group') return confirmDelete(id);
  if (act === 'confirm-delete') return post(`/api/groups/${id}/delete`, {});
  if (act === 'cancel-delete') {
    const actions = sectionEls.get(id)?.querySelector('.group-actions');
    if (actions) delete actions.dataset.confirming;
    return render();
  }
  if (e.target.closest('.group-toggle') && !e.target.closest('.editing')) {
    view.collapsed = view.collapsed.includes(id) ? view.collapsed.filter((x) => x !== id) : [...view.collapsed, id];
    saveView();
    render();
  }
}

function confirmDelete(id) {
  const group = groups.groups.find((g) => g.id === id);
  const actions = sectionEls.get(id)?.querySelector('.group-actions');
  if (!group || !actions) return;
  actions.dataset.confirming = '1';
  actions.innerHTML = `<span>Delete \u201c${escapeHtml(group.name)}\u201d? Its chats move to Ungrouped.</span>
    <button class="link-btn danger" data-act="confirm-delete">Delete</button><button class="link-btn" data-act="cancel-delete">Cancel</button>`;
  actions.querySelector('[data-act="cancel-delete"]').focus();
}

// Edits text in place: Enter or leaving the field saves, Esc cancels.
function editInline(container, { initial, label, placeholder = '', onSave, hide = [] }) {
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = initial;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.maxLength = 120;
  for (const el of hide) el.hidden = true;
  container.classList.add('editing');
  container.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.remove();
    container.classList.remove('editing');
    for (const el of hide) el.hidden = false;
    if (save && input.value.trim() !== initial.trim()) onSave(input.value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function renameChat(id, container) {
  const chat = chats.find((c) => c.id === id);
  if (!chat || container.classList.contains('editing')) return;
  editInline(container, {
    initial: groups.chats[chat.sessionId]?.name ?? '',
    placeholder: chat.title,
    label: 'Chat name (leave empty to use Claude\u2019s title)',
    hide: [...container.children],
    onSave: (name) => post(`/api/sessions/${chat.sessionId}/name`, { name }),
  });
}

function renameGroup(id) {
  const group = groups.groups.find((g) => g.id === id);
  const head = sectionEls.get(id)?.querySelector('.group-head');
  if (!group || !head || head.classList.contains('editing')) return;
  editInline(head, {
    initial: group.name,
    label: 'Group name',
    hide: [...head.children],
    onSave: (name) => post(`/api/groups/${id}/rename`, { name }),
  });
}

// "+ New group": type a name; if started from a chat's menu, that chat moves in.
function startNewGroup(sessionId = null) {
  const slot = $('new-group-slot');
  if (slot.classList.contains('editing')) return;
  editInline(slot, {
    initial: '',
    placeholder: 'Group name',
    label: 'New group name',
    hide: [$('new-group')],
    onSave: async (name) => {
      const group = await post('/api/groups', { name });
      if (group && sessionId) await assignGroup(sessionId, group.id);
    },
  });
}



// ---- Spotlight ----------------------------------------------------------

// Grid → chat adds one history entry, so Back returns to the grid; moving
// between chats replaces it, so Back never walks through chats you passed.
function openChat(id) {
  const url = `#chat=${id}`;
  if (openId) history.replaceState(history.state, '', url);
  else history.pushState({ fromGrid: true }, '', url);
  showFromHash();
}

function closeChat() {
  if (history.state?.fromGrid) return history.back(); // fires hashchange
  history.replaceState(null, '', location.pathname);
  showFromHash();
}

let lastOpened = null;
let afterClose = null; // runs once the grid is usable again after closing a chat
const stripButtons = new Map(); // chat id → side-list button

function showFromHash() {
  const id = /^#chat=(\d+)$/.exec(location.hash)?.[1] ?? null;
  const wasOpen = openId;
  openId = id;
  $('spotlight').hidden = !id;
  // Everything behind the open chat is out of reach of Tab and screen readers.
  gallery.inert = Boolean(id);
  document.querySelector('.bar').inert = Boolean(id);
  document.body.style.overflow = id ? 'hidden' : '';
  clearTimeout(conversationTimer);
  if (!id) {
    shownConversation = null;
    conversationRequest?.abort();
    const next = afterClose;
    afterClose = null;
    if (next) next();
    else if (wasOpen) (tiles.get(lastOpened)?.querySelector('.tile-open') ?? gallery.querySelector('.tile-open') ?? $('filter')).focus();
    return;
  }
  lastOpened = id;
  if (finished.delete(id)) render();
  renderSpotlightChrome();
  if (shownConversation?.id !== id) {
    shownConversation = null;
    $('conversation').innerHTML = '<li class="note">Loading…</li>';
  }
  if (!wasOpen) $('conversation').focus();
  loadConversation(id);
}

function renderSpotlightChrome() {
  const chat = chats.find((c) => c.id === openId);
  renderStrip();

  const raise = $('raise');
  if (!chat) {
    $('stage-title').textContent = knownTitles.get(openId) ?? 'Chat';
    $('stage-meta').textContent = haveList ? 'This chat has closed.' : 'Loading…';
    raise.setAttribute('aria-disabled', 'true');
    raise.title = haveList ? 'This chat has closed.' : '';
    return;
  }
  $('stage-title').textContent = titleFor(chat);
  fillApproval($('stage-approval'), approvalFor(chat));
  $('stage-meta').textContent = [statusLabel(chat.status), chat.appLabel, shortFolder(chat.folder)].filter(Boolean).join(' · ');
  const handle = $('stage-handle');
  handle.hidden = !chat.handle;
  handle.textContent = chat.handle ? `@${chat.handle}` : '';
  handle.dataset.handle = chat.handle ?? '';
  raise.setAttribute('aria-disabled', String(Boolean(chat.cannotFocus)));
  raise.title = chat.cannotFocus ?? `Bring its ${chat.appLabel} window to the front (G)`;
}

// The side list follows the grid: same groups, filter and Active, in the same
// order (ignoring paging and collapsed sections). Like the tiles, each entry
// is made once and updated in place, so focus and clicks survive updates.
function renderStrip() {
  const strip = $('strip');
  const listing = select({ chats, groups, finished, filter, view: { ...view, perScreen: 0, collapsed: [] } });
  const entries = listing.sections.flatMap((section) => [
    ...(section.name ? [{ key: `h:${section.id}`, heading: section.name }] : []),
    ...section.chats.map((c) => ({ key: c.id, chat: c })),
  ]);
  const keep = new Set(entries.map((e) => e.key));
  for (const [key, el] of stripButtons) {
    if (!keep.has(key)) {
      el.remove();
      stripButtons.delete(key);
    }
  }
  entries.forEach((entry, index) => {
    let el = stripButtons.get(entry.key);
    if (!el && entry.heading !== undefined) {
      el = document.createElement('p');
      el.className = 'strip-heading';
      stripButtons.set(entry.key, el);
    } else if (!el) {
      el = document.createElement('button');
      el.dataset.open = entry.key;
      el.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="name"></span><span class="visually-hidden"></span>';
      stripButtons.set(entry.key, el);
    }
    if (entry.heading !== undefined) {
      el.textContent = entry.heading;
    } else {
      const c = entry.chat;
      el.setAttribute('aria-current', String(c.id === openId));
      el.querySelector('.dot').className = `dot ${c.status}`;
      el.querySelector('.name').textContent = titleFor(c);
      el.querySelector('.visually-hidden').textContent = c.status === 'waiting' ? ', needs you' : '';
    }
    if (strip.children[index] !== el) place(strip, el, strip.children[index] ?? null);
  });
}

$('stage-title').addEventListener('dblclick', () => {
  const head = document.querySelector('.stage-title');
  if (openId) renameChat(openId, head);
});

$('strip').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-open]');
  if (btn) openChat(btn.dataset.open);
});
$('back').addEventListener('click', closeChat);
$('raise').addEventListener('click', () => openId && bringToFront(openId));

// Fetches only messages newer than the ones shown and appends them, so the
// rows already on screen (and any selection or scroll in them) stay put. A
// new epoch means the server read the transcript again from the start.
async function loadConversation(id) {
  conversationRequest?.abort();
  const request = new AbortController();
  conversationRequest = request;
  const known = shownConversation?.id === id ? shownConversation : null;
  const query = known ? `?after=${known.lastSeq}&epoch=${known.epoch}` : '';
  let data;
  try {
    const res = await api(`/api/chats/${id}/conversation${query}`, { signal: request.signal });
    if (id !== openId) return;
    if (res.status === 404) {
      if (!known && haveList) $('conversation').innerHTML = '<li class="note">This chat has closed.</li>';
      return;
    }
    if (res.status === 401) return showLocked();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    if (err.name === 'AbortError' || id !== openId) return;
    if (!known) $('conversation').innerHTML = '<li class="note">Couldn\u2019t load this conversation. It will retry when the chat changes or the dashboard reconnects.</li>';
    return;
  }
  if (id !== openId || conversationRequest !== request) return;

  const list = $('conversation');
  const pinnedToBottom = !known || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const replacing = !known || data.reset;
  // On a reset the numbering starts again, so the old position means nothing.
  const lastSeq = data.messages.at(-1)?.seq ?? (replacing ? 0 : known.lastSeq);
  if (replacing) {
    list.innerHTML = `<li class="note" id="conversation-note"></li>`
      + (data.messages.length ? data.messages.map(messageHtml).join('') : '<li class="note" id="no-messages">No messages yet.</li>');
    shownConversation = { id, epoch: data.epoch, lastSeq };
  } else if (data.messages.length) {
    document.getElementById('no-messages')?.remove();
    list.insertAdjacentHTML('beforeend', data.messages.map(messageHtml).join(''));
    shownConversation.lastSeq = lastSeq;
    // Keep the list as long as the server's, dropping the oldest rows only
    // while reading at the bottom, so nothing moves under someone scrolled up.
    if (pinnedToBottom) {
      const rows = list.querySelectorAll('li[data-seq]');
      for (let n = 0; n < rows.length - MAX_ROWS; n++) rows[n].remove();
    }
  }
  const firstSeq = Number(list.querySelector('li[data-seq]')?.dataset.seq ?? 1);
  const hidden = firstSeq - 1;
  const note = document.getElementById('conversation-note');
  note.hidden = hidden <= 0;
  note.textContent = hidden > 0 ? `Showing the latest messages; ${hidden} earlier ${hidden === 1 ? 'one isn\u2019t' : 'ones aren\u2019t'} shown.` : '';
  if (pinnedToBottom) list.scrollTop = list.scrollHeight;
}

function messageHtml(m) {
  if (m.role === 'tool') return `<li class="msg tool" data-seq="${m.seq}" title="${escapeHtml(m.text)}">${escapeHtml(m.text)}</li>`;
  const who = m.role === 'user' ? 'You' : 'Claude';
  const body = m.role === 'user' ? escapeHtml(m.text) : markdown(m.text);
  return `<li class="msg ${m.role}" data-seq="${m.seq}"><div class="who">${who}${m.at ? ` · ${clock(m.at)}` : ''}</div><div class="body">${body}</div></li>`;
}

// ---- Bring to front -----------------------------------------------------

async function bringToFront(id) {
  const chat = chats.find((c) => c.id === id);
  if (!chat) return toast('This chat has closed.');
  if (chat.cannotFocus) return toast(chat.cannotFocus);
  try {
    const res = await api(`/api/chats/${id}/focus`, { method: 'POST' });
    if (res.status === 401) return showLocked();
    if (res.status === 404) return toast('This chat has closed.');
    const result = res.ok ? await res.json() : null;
    if (!result) toast('Something went wrong in the dashboard. Its terminal window shows the details.', { sticky: true });
    else if (!result.ok) toast(result.reason, { sticky: true });
    else if (result.note) toast(result.note);
  } catch {
    toast('The dashboard server is not reachable.', { sticky: true });
  }
}

// Notes fade after a few seconds; a failure stays until clicked, Esc, or the
// next message, since it may need acting on (e.g. in System Settings).
let toastTimer = null;
function toast(text, { sticky = false } = {}) {
  const el = $('toast');
  el.textContent = sticky ? `${text}  (click to dismiss)` : text;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() {
  $('toast').hidden = true;
}
$('toast').addEventListener('click', hideToast);

// ---- Keyboard -----------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target.matches('input, textarea');
  if (e.key === 'Escape') {
    if (!$('toast').hidden) return hideToast();
    if (typing) return e.target.blur();
    if (openId) closeChat();
    return;
  }
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    if (!openId) return $('filter').focus();
    // Closing may finish later (via history), once the header is usable again.
    afterClose = () => $('filter').focus();
    closeChat();
    return;
  }
  if (!openId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && view.perScreen) {
    e.preventDefault();
    turnPage(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (!openId && /^[1-9]$/.test(e.key)) {
    const id = selection?.keys[Number(e.key) - 1];
    if (id) openChat(id);
    return;
  }
  // Holding a key down doesn't repeat these.
  if (e.repeat && (e.key === '[' || e.key === ']' || e.key.toLowerCase() === 'g')) return;
  if (openId && (e.key === '[' || e.key === ']')) {
    // Next/previous in on-screen order: groups, filter and Active applied.
    const next = neighbor(selection?.sequence ?? [], openId, e.key === ']' ? 1 : -1);
    if (next) openChat(next);
    return;
  }
  if (openId && e.key.toLowerCase() === 'g') bringToFront(openId);
});

$('filter').addEventListener('input', (e) => {
  filter = e.target.value.trim();
  render();
});

// ---- Done alerts --------------------------------------------------------

// A chat that stops working is marked Done until you open it, and the tab
// title counts them. With alerts on, a Mac notification says so too, and one
// says when a chat starts needing you. Nothing fires for the first list after
// the page loads, only for changes seen while it's open.
function noticeFinished(list, seenBefore) {
  const ids = new Set(list.map((c) => c.id));
  for (const id of [...lastStatus.keys()]) if (!ids.has(id)) lastStatus.delete(id);
  for (const id of [...finished]) if (!ids.has(id)) finished.delete(id);
  for (const chat of list) {
    const before = lastStatus.get(chat.id);
    lastStatus.set(chat.id, chat.status);
    if (!seenBefore || before === undefined || before === chat.status) continue;
    const reading = chat.id === openId && document.hasFocus();
    if (WORKING.has(chat.status)) {
      finished.delete(chat.id);
    } else if (chat.status === 'waiting') {
      if (!reading) alertMac(`Needs you: ${titleFor(chat)}`, lastLine(chat), chat.id);
    } else if (WORKING.has(before)) {
      if (!reading) {
        finished.add(chat.id);
        alertMac(`Done: ${titleFor(chat)}`, lastLine(chat), chat.id);
      }
    }
  }
}

function lastLine(chat) {
  return [...chat.recent].reverse().find((m) => m.role === 'assistant')?.text ?? '';
}

function alertMac(title, body, id) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
  const note = new Notification(title, { body: body.slice(0, 180), tag: `chat-${id}` });
  note.onclick = () => {
    window.focus();
    openChat(id);
    note.close();
  };
}

function setUpAlertsButton() {
  const button = $('alerts');
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    const answer = await Notification.requestPermission();
    button.hidden = true;
    if (answer === 'granted') toast('Alerts on: you\u2019ll get a notification when a chat finishes or needs you, while this tab is in the background.');
    else toast('Alerts are off. The tab title and Done badges still show finished chats; to change your mind, allow notifications for this site in Chrome\u2019s settings.', { sticky: true });
  });
}

// ---- Usage ---------------------------------------------------------------

function tokensFor(chat) {
  return usage?.tokens.bySession[chat.sessionId] ?? null;
}

// Plan limits as two small meters, plus this machine's token total.
function renderUsage() {
  const el = $('usage');
  const plan = usage?.plan;
  const total = usage?.tokens.total;
  el.hidden = !plan && !total?.fiveHour;
  const meter = (label, limit, resetFormat) => {
    if (!limit) return '';
    const pct = Math.max(0, Math.min(100, Math.round(limit.percent)));
    const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : '';
    const resets = limit.resetsAt ? ` \u00b7 resets ${resetFormat(limit.resetsAt)}` : '';
    return `<span class="meter ${level}" title="${label} limit: ${pct}% used${resets}">
      <span class="meter-label">${label}</span>
      <span class="meter-bar"><span data-pct="${pct}"></span></span>
      <span class="meter-pct">${pct}%</span>
    </span>`;
  };
  const stale = plan?.asOf && Date.now() - Date.parse(plan.asOf) > 15 * 60_000
    ? `<span class="usage-asof" title="Plan figures update when a Claude chat redraws its status line">as of ${clock(plan.asOf)}</span>` : '';
  el.innerHTML = meter('5h', plan?.fiveHour, (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
    + meter('Week', plan?.sevenDay, (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' }))
    + stale
    + (total?.fiveHour ? `<span class="usage-tokens" title="Tokens used by chats on this Mac: ${compact(total.fiveHour)} in 5 hours, ${compact(total.sevenDay)} in 7 days (input + cache writes + output)">${compact(total.fiveHour)} tok / 5h</span>` : '');
  // Widths set from script: the page's security policy blocks inline styles.
  for (const bar of el.querySelectorAll('[data-pct]')) bar.style.width = `${bar.dataset.pct}%`;
}

function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// ---- Helpers ------------------------------------------------------------

function lastActivity(chat) {
  return chat.activeAt ?? null;
}

function agoText(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function clock(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Tiles show text as a terminal would: no Markdown markers.
function plain(text) {
  return text.replace(/\*\*|`|(^|\s)#{2,4}\s+/g, '$1');
}

function shortFolder(folder) {
  if (!folder) return '';
  return folder.replace(/^\/Users\/[^/]+/, '~');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Enough Markdown for Claude's replies: fenced code, inline code, bold,
// headings, bullet lists and links. Everything is escaped first.
function markdown(text) {
  const blocks = [];
  const withoutFences = text.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  // Links first (as placeholders), so code or bold markers inside a URL can't
  // reshape it; code blocks that started mid-line are put back wherever they land.
  const inline = (s) => {
    const links = [];
    return escapeHtml(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)`*\u0000\u0001]+)\)/g, (_, label, url) => {
        links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
        return `\u0001${links.length - 1}\u0001`;
      })
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)])
      .replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)] ?? '');
  };

  return withoutFences.split(/\n{2,}/).map((para) => {
    const fence = /^\u0000(\d+)\u0000$/.exec(para.trim());
    if (fence) return blocks[Number(fence[1])];
    const heading = /^(#{1,4})\s+(.*)$/.exec(para.trim());
    if (heading && !para.trim().includes('\n')) return `<h4>${inline(heading[2])}</h4>`;
    const lines = para.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      const start = Number(/^\s*(\d+)/.exec(lines[0])[1]);
      return `<ol start="${start}">${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

setInterval(() => {
  for (const el of document.querySelectorAll('.ago')) el.textContent = agoText(el.dataset.at || null);
}, 30_000);

setUpAlertsButton();
window.addEventListener('hashchange', () => {
  const code = takePairingCode();
  if (code) return usePairingLink(code);
  showFromHash();
});
(async () => {
  const code = takePairingCode();
  showFromHash();
  if (code) await usePairingLink(code);
  if (!locked) connect();
})();
