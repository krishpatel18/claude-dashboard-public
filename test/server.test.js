import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createDashboardServer } from '../src/server.js';
import { openGroups } from '../src/groups.js';
import { openApprovals } from '../src/approvals.js';
import { spawn } from 'node:child_process';
import { writeFileSync as writeFile, mkdirSync as makeDir } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The chat list adapter, held still so the server is tested on its own.
function fakeChats(initial) {
  let list = initial;
  const listeners = new Set();
  return {
    list: () => list,
    find: (id) => list.find((c) => c.id === id) ?? null,
    asked: [],
    conversation(id, options) {
      this.asked.push([id, options]);
      return list.some((c) => c.id === id) ? { epoch: 7, total: 1, messages: [{ seq: 1, role: 'user', text: `hi ${id}`, at: null }] } : null;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(next, conversations = []) {
      const listChanged = next !== list;
      list = next;
      for (const fn of listeners) fn({ listChanged, conversations });
    },
  };
}

let server;
let port;
let chats;
let focused;
let resumed;
let usage;
let groups;
let approvals;

function fakeUsage(initial) {
  let current = initial;
  const listeners = new Set();
  return {
    snapshot: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(next) {
      current = next;
      for (const fn of listeners) fn(current);
    },
  };
}

beforeEach(async () => {
  chats = fakeChats([{ id: '1000', title: 'One', app: 'terminal', tty: 'ttys011' }]);
  focused = [];
  resumed = [];
  usage = fakeUsage({ plan: { fiveHour: { percent: 40, resetsAt: null }, sevenDay: null, asOf: null }, tokens: { total: { fiveHour: 1, sevenDay: 2 }, bySession: {} }, sessions: { 'closed-1': { title: 'Old', folder: '/tmp', lastAt: null, pausedAt: '2026-10-20T10:00:00Z' } } });
  groups = await openGroups({ file: join(mkdtempSync(join(tmpdir(), 'srv-groups-')), 'groups.json') });
  approvals = openApprovals();
  server = createDashboardServer({
    approvals,
    groups,
    usage,
    key: KEY,
    pairingCode: PAIRING_CODE,
    chats,
    focus: {
      bringToFront: async (chat) => { focused.push(chat.id); return { ok: true }; },
      resume: async (session) => { resumed.push(session); return { ok: true }; },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const KEY = 'k'.repeat(64);
const PAIRING_CODE = 'p'.repeat(32);

// A request as the dashboard's own page makes it: right host, its key.
function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = { host: `127.0.0.1:${port}`, 'x-dashboard-key': KEY, ...headers };
    for (const name of Object.keys(all)) if (all[name] === undefined) delete all[name];
    const req = request({ host: '127.0.0.1', port, path, method, headers: all }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const post = (path, body) => call(path, { method: 'POST', body, headers: { 'content-type': 'application/json' } });

test('serves the page and its assets, and nothing outside them', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal((await call('/app.js')).status, 200);
  assert.equal((await call('/style.css')).status, 200);
  assert.equal((await call('/../package.json')).status, 404);
  assert.equal((await call('/%2e%2e/package.json')).status, 404);
});

test('lists chats and returns one conversation', async () => {
  const list = await call('/api/chats');
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body), chats.list());

  const convo = await call('/api/chats/1000/conversation');
  assert.deepEqual(JSON.parse(convo.body), { epoch: 7, total: 1, messages: [{ seq: 1, role: 'user', text: 'hi 1000', at: null }] });
  assert.equal((await call('/api/chats/9999/conversation')).status, 404);

  await call('/api/chats/1000/conversation?after=12&epoch=7');
  await call('/api/chats/1000/conversation?after=x&epoch=');
  assert.deepEqual(chats.asked, [
    ['1000', { after: undefined, epoch: undefined }],
    ['9999', { after: undefined, epoch: undefined }],
    ['1000', { after: 12, epoch: 7 }],
    ['1000', { after: undefined, epoch: undefined }],
  ]);
});

test('chat data needs the key; the page and its assets do not', async () => {
  for (const path of ['/api/chats', '/api/chats/1000/conversation', '/api/events']) {
    assert.equal((await call(path, { headers: { 'x-dashboard-key': undefined } })).status, 401, path);
    assert.equal((await call(path, { headers: { 'x-dashboard-key': 'wrong' } })).status, 401, path);
    assert.equal((await call(path, { headers: { 'x-dashboard-key': 'j'.repeat(64) } })).status, 401, path);
  }
  assert.equal((await call('/api/events?k=wrong', { headers: { 'x-dashboard-key': undefined } })).status, 401);
  // The key in the address is only for the event stream, which can't send headers.
  assert.equal((await call(`/api/chats?k=${KEY}`, { headers: { 'x-dashboard-key': undefined } })).status, 401);
  assert.equal((await call('/', { headers: { 'x-dashboard-key': undefined } })).status, 200);
  assert.equal((await call('/app.js', { headers: { 'x-dashboard-key': undefined } })).status, 200);
});

test('answers the page at either local address, and requests from that same page', async () => {
  assert.equal((await call('/api/chats', { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await call('/api/chats', { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call('/api/chats', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('refuses requests a browser marks as coming from another site, including other localhost ports', async () => {
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await call('/api/chats', { headers: { 'sec-fetch-site': site } })).status, 403, site);
  }
  assert.equal((await call('/api/chats', { headers: { host: `127.0.0.1:${port + 1}` } })).status, 403);
  assert.equal((await call('/api/chats', { headers: { origin: 'null' } })).status, 403);
});

test('the page itself still opens from a link on another site; only chat data is refused', async () => {
  const headers = { 'sec-fetch-site': 'cross-site', 'x-dashboard-key': undefined };
  assert.equal((await call('/', { headers })).status, 200);
  assert.equal((await call('/app.js', { headers })).status, 200);
  assert.equal((await call('/api/chats', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('tells the browser not to frame the page or run anything but its own scripts', async () => {
  const page = await call('/');
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call('/api/chats')).headers['x-content-type-options'], 'nosniff');
});

test('refuses requests addressed to another host name, so other websites cannot read chats', async () => {
  const res = await call('/api/chats', { headers: { host: `evil.example:${port}` } });
  assert.equal(res.status, 403);
});

test('refuses requests that come from another website', async () => {
  const res = await call('/api/chats', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('bring-to-front needs the key, and refuses another website even with it', async () => {
  const bare = await call('/api/chats/1000/focus', { method: 'POST', headers: { 'x-dashboard-key': undefined } });
  assert.equal(bare.status, 401);
  const foreign = await call('/api/chats/1000/focus', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(focused, []);

  const ok = await call('/api/chats/1000/focus', { method: 'POST', headers: { origin: `http://localhost:${port}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true });
  assert.deepEqual(focused, ['1000']);

  const missing = await call('/api/chats/9999/focus', { method: 'POST' });
  assert.equal(missing.status, 404);
});

test('streams the chat list on connect and again only when it changes', { timeout: 3000 }, async () => {
  const received = [];
  let emitted = false;
  const req = request({ host: '127.0.0.1', port, path: `/api/events?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } });
  const done = new Promise((resolve) => {
    req.on('response', (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && !['usage', 'groups', 'approvals'].includes(event)) received.push([event, JSON.parse(data)]);
          if (received.length === 1 && !emitted) {
            emitted = true;
            chats.emit(chats.list(), ['1000']); // a new message, list unchanged
            chats.emit([], []); // the chat closed
          }
          if (received.length === 3) resolve();
        }
      });
    });
  });
  req.end();
  await done;
  req.destroy();

  assert.deepEqual(received, [
    ['chats', [{ id: '1000', title: 'One', app: 'terminal', tty: 'ttys011' }]],
    ['conversation', { id: '1000' }],
    ['chats', []],
  ]);
});

test('the printed link pairs a browser once: the code gives the key one time, then never again', async () => {
  const pair = (code, headers = {}) => call('/api/pair', { method: 'POST', headers: { 'x-dashboard-key': undefined, 'x-pairing-code': code, ...headers } });

  assert.equal((await pair('q'.repeat(32))).status, 401);
  assert.equal((await pair(PAIRING_CODE, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const first = await pair(PAIRING_CODE);
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), { key: KEY });
  assert.equal((await pair(PAIRING_CODE)).status, 401);
});

test('usage is served with the key, and streamed on connect and whenever it changes', { timeout: 3000 }, async () => {
  assert.equal((await call('/api/usage', { headers: { 'x-dashboard-key': undefined } })).status, 401);
  assert.deepEqual(JSON.parse((await call('/api/usage')).body), usage.snapshot());

  const events = [];
  const req = request({ host: '127.0.0.1', port, path: `/api/events?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } });
  await new Promise((resolve) => {
    req.on('response', (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          if (event === 'usage') events.push(JSON.parse(/^data: (.*)$/m.exec(block)[1]));
          if (events.length === 1 && event === 'usage') usage.emit({ plan: null, tokens: { total: { fiveHour: 9, sevenDay: 9 }, bySession: {} } });
          if (events.length === 2) resolve();
        }
      });
    });
    req.end();
  });
  req.destroy();
  assert.equal(events[0].plan.fiveHour.percent, 40);
  assert.equal(events[1].tokens.total.fiveHour, 9);
});

test('groups and chat names are changed through the server, which says why it refuses', async () => {
  const created = await post('/api/groups', { name: 'Work' });
  assert.equal(created.status, 200);
  const { id } = JSON.parse(created.body);

  assert.equal((await post(`/api/sessions/sess-1/group`, { group: id })).status, 200);
  assert.equal((await post(`/api/sessions/sess-1/name`, { name: 'Webhook fix' })).status, 200);
  assert.equal((await post(`/api/groups/${id}/rename`, { name: 'Side Projects' })).status, 200);
  assert.deepEqual(JSON.parse((await call('/api/groups')).body).groups, [{ id, name: 'Side Projects' }]);
  assert.equal(groups.snapshot().chats['sess-1'].name, 'Webhook fix');

  const bad = await post('/api/groups', { name: '' });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /name/);
  assert.equal((await post('/api/sessions/sess-1/group', { group: 'nope' })).status, 400);
  assert.equal((await post('/api/groups/nope/delete', {})).status, 400);

  assert.equal((await post(`/api/groups/${id}/delete`, {})).status, 200);
  assert.deepEqual(groups.snapshot().groups, []);
});

test('group changes need the key, JSON, and a small body', async () => {
  assert.equal((await call('/api/groups', { method: 'POST', body: { name: 'A' }, headers: { 'content-type': 'application/json', 'x-dashboard-key': undefined } })).status, 401);
  assert.equal((await call('/api/groups', { method: 'POST', body: { name: 'A' }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post('/api/groups', { name: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await call('/api/groups', { method: 'POST', body: { name: 'A' }, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })).status, 403);
  assert.deepEqual(groups.snapshot().groups, []);
});

test('group changes are streamed to open pages', { timeout: 3000 }, async () => {
  const seen = [];
  const req = request({ host: '127.0.0.1', port, path: `/api/events?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } });
  await new Promise((resolve) => {
    req.on('response', (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^event: groups$/m.test(block)) {
            seen.push(JSON.parse(/^data: (.*)$/m.exec(block)[1]));
            if (seen.length === 1) groups.createGroup('Live');
            if (seen.length === 2) resolve();
          }
        }
      });
    });
    req.end();
  });
  req.destroy();
  assert.deepEqual(seen.map((s) => s.groups.length), [0, 1]);
});

// Waits for a condition, failing (not hanging) after 3 seconds.
async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Opens the page's event stream, so the server knows someone is watching.
function watch() {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: `/api/events?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } });
    req.on('response', (res) => { res.on('data', () => {}); resolve(req); });
    req.end();
  });
}

const BASH_REQUEST = { session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'touch a.txt' }, permission_suggestions: [] };

test('with no dashboard page open, a permission request is handed straight back to the terminal', async () => {
  const res = await call('/api/approvals', { method: 'POST', body: BASH_REQUEST, headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 204);
  assert.deepEqual(approvals.list(), []);
});

test('with a page open, a permission request waits for the answer given on the page', { timeout: 5000 }, async () => {
  const page = await watch();
  const answer = call('/api/approvals', { method: 'POST', body: BASH_REQUEST, headers: { 'content-type': 'application/json' } });
  await until(() => approvals.list().length);
  const { id } = approvals.list()[0];

  assert.equal((await post(`/api/approvals/${id}/decide`, { choice: 'deny' })).status, 200);
  const res = await answer;
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal((await post(`/api/approvals/${id}/decide`, { choice: 'once' })).status, 400);
  page.destroy();
});

test('a request dropped on the server (its chat moved on) tells the waiting hook to stand down', { timeout: 5000 }, async () => {
  const page = await watch();
  const answer = call('/api/approvals', { method: 'POST', body: BASH_REQUEST, headers: { 'content-type': 'application/json' } });
  await until(() => approvals.list().length);
  approvals.keepOnly(new Set(), { graceMs: 0 });
  const res = await answer;
  assert.equal(res.status, 204);
  page.destroy();
});

test('a request whose hook goes away (terminal answered first) disappears', { timeout: 5000 }, async () => {
  const page = await watch();
  const req = request({ host: '127.0.0.1', port, path: '/api/approvals', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'x-dashboard-key': KEY, 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify(BASH_REQUEST));
  await until(() => approvals.list().length);
  req.destroy();
  await until(() => !approvals.list().length);
  page.destroy();
});

test('answering needs the key and the page itself', async () => {
  const res = await call('/api/approvals', { method: 'POST', body: BASH_REQUEST, headers: { 'content-type': 'application/json', 'x-dashboard-key': undefined } });
  assert.equal(res.status, 401);
  const foreign = await call('/api/approvals/x/decide', { method: 'POST', body: { choice: 'once' }, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
});

test('the real hook script prints the dashboard\'s answer, and nothing when no page is open; the key never appears on its command line', { timeout: 8000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  writeFile(join(dir, 'curl-config'), `header = "x-dashboard-key: ${KEY}"\n`);
  writeFile(join(dir, 'url'), `http://127.0.0.1:${port}\n`);
  const runHook = () => new Promise((resolve) => {
    const child = spawn('sh', [new URL('../hooks/permission-request.sh', import.meta.url).pathname], { env: { ...process.env, CLAUDE_DASHBOARD_DIR: dir } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(BASH_REQUEST));
  });

  assert.deepEqual(await runHook(), { code: 0, out: '' });

  const page = await watch();
  const result = runHook();
  await until(() => approvals.list().length);
  approvals.decide(approvals.list()[0].id, 'once');
  const { code, out } = await result;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  page.destroy();
});

test('resume opens a recent chat by session, using the folder the dashboard knows, and refuses open or unknown chats', async () => {
  assert.equal((await post('/api/sessions/closed-1/resume', {})).status, 200);
  assert.deepEqual(resumed, [{ sessionId: 'closed-1', folder: '/tmp' }]);
  assert.equal((await post('/api/sessions/unknown/resume', {})).status, 404);
  chats.emit([{ id: '1000', sessionId: 'closed-1', title: 'Now open' }]);
  assert.equal((await post('/api/sessions/closed-1/resume', {})).status, 409);
  assert.equal(resumed.length, 1);
});
