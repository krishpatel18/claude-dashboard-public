import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/selection.js': ['selection.js', 'text/javascript; charset=utf-8'],
  '/saved.js': ['saved.js', 'text/javascript; charset=utf-8'],
};
const HEARTBEAT_MS = 25_000;
// A page that stops reading its stream is dropped before it can make the
// server buffer without limit; EventSource reconnects on its own.
const MAX_STREAM_BACKLOG = 1024 * 1024;

// Every response: only this server's own scripts and styles run, and no
// other page may frame this one.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// HTTP over the chat list: the page, JSON reads, a server-sent event stream
// of changes, and bring-to-front. Transcripts are private, so chat data
// needs `key` (sent by the page as a header, or as ?k= on the event stream,
// which can't send headers), and any data request a browser marks as coming
// from another site or address is refused. The page and its assets need
// neither.
//
// `pairingCode` is printed in the start-up link instead of the key: the page
// trades it once for the key (POST /api/pair), after which it is spent, so a
// link left in browser history or a log unlocks nothing.
// `usage` (optional) is the plan and token usage module (src/usage.js).
// `groups` (optional) is the chat groups and names store (src/groups.js).
// `approvals` (optional) holds permission requests from the hook (src/approvals.js).
export function createDashboardServer({ chats, focus, key, pairingCode, usage, groups, approvals }) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('createDashboardServer needs a key of at least 32 characters');
  const expected = Buffer.from(key);
  let pairing = typeof pairingCode === 'string' && pairingCode.length >= 32 ? Buffer.from(pairingCode) : null;
  const streams = new Set();

  const unsubscribe = chats.subscribe(({ listChanged, conversations }) => {
    const list = listChanged ? JSON.stringify(chats.list()) : null;
    for (const res of streams) {
      for (const id of conversations) send(res, 'conversation', JSON.stringify({ id }));
      if (list) send(res, 'chats', list);
    }
  });

  const unsubscribeApprovals = approvals?.subscribe((list) => {
    const data = JSON.stringify(list);
    for (const res of streams) send(res, 'approvals', data);
  });

  const unsubscribeGroups = groups?.subscribe((snapshot) => {
    const data = JSON.stringify(snapshot);
    for (const res of streams) send(res, 'groups', data);
  });

  const unsubscribeUsage = usage?.subscribe((snapshot) => {
    const data = JSON.stringify(snapshot);
    for (const res of streams) send(res, 'usage', data);
  });

  const heartbeat = setInterval(() => {
    for (const res of streams) write(res, ': keep-alive\n\n');
  }, HEARTBEAT_MS);

  function write(res, text) {
    if (res.writableLength > MAX_STREAM_BACKLOG) {
      streams.delete(res);
      res.destroy();
      return;
    }
    res.write(text);
  }

  function send(res, event, data) {
    write(res, `event: ${event}\ndata: ${data}\n\n`);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!toThisServer(req, server)) return reply(res, 403, { error: 'forbidden' });
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && ASSETS[path]) {
        const [file, type] = ASSETS[path];
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
        return res.end(await readFile(PUBLIC_DIR + file));
      }
      if (path.startsWith('/api/')) {
        if (!fromThisPage(req, server)) return reply(res, 403, { error: 'forbidden' });
        if (path === '/api/pair' && req.method === 'POST') {
          if (!pairing || !sameSecret(req.headers['x-pairing-code'], pairing)) return reply(res, 401, { error: 'pairing link already used or wrong' });
          pairing = null;
          return reply(res, 200, { key });
        }
        const given = req.headers['x-dashboard-key'] ?? (path === '/api/events' ? url.searchParams.get('k') : null);
        if (!keyMatches(given)) return reply(res, 401, { error: 'missing or wrong key' });
      }
      if (req.method === 'GET' && path === '/api/chats') return reply(res, 200, chats.list());
      if (req.method === 'GET' && path === '/api/usage') return usage ? reply(res, 200, usage.snapshot()) : reply(res, 404, { error: 'not found' });
      if (req.method === 'GET' && path === '/api/events') return openStream(req, res);

      const m = /^\/api\/chats\/(\d+)\/(conversation|focus)$/.exec(path);
      if (m && m[2] === 'conversation' && req.method === 'GET') {
        const conversation = chats.conversation(m[1], {
          after: wholeNumber(url.searchParams.get('after')),
          epoch: wholeNumber(url.searchParams.get('epoch')),
        });
        return conversation ? reply(res, 200, conversation) : reply(res, 404, { error: 'no such chat' });
      }
      if (m && m[2] === 'focus' && req.method === 'POST') {
        const chat = chats.find(m[1]);
        if (!chat) return reply(res, 404, { error: 'no such chat' });
        return reply(res, 200, await focus.bringToFront(chat));
      }
      if (approvals && path === '/api/approvals' && req.method === 'POST') return holdApproval(req, res);
      const resume = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/resume$/.exec(path);
      if (resume && req.method === 'POST' && focus.resume) {
        const sessionId = resume[1];
        if (chats.list().some((c) => c.sessionId === sessionId)) return reply(res, 409, { error: 'That chat is already open.' });
        const known = usage?.snapshot().sessions?.[sessionId];
        if (!known?.folder) return reply(res, 404, { error: 'No recent chat with that session.' });
        return reply(res, 200, await focus.resume({ sessionId, folder: known.folder }));
      }
      const decide = /^\/api\/approvals\/([0-9a-f]+)\/decide$/.exec(path);
      if (approvals && decide && req.method === 'POST') {
        const body = await readJson(req, res);
        if (body === undefined) return;
        try {
          approvals.decide(decide[1], body.choice);
          return reply(res, 200, { ok: true });
        } catch (err) {
          return reply(res, 400, { error: err.message });
        }
      }
      if (groups && (path.startsWith('/api/groups') || path.startsWith('/api/sessions/'))) {
        const handled = await groupRoute(req, res, path);
        if (handled) return;
      }
      reply(res, 404, { error: 'not found' });
    } catch (err) {
      console.error(`[claude-dashboard] ${err?.stack ?? err}`);
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  // Group and chat-name changes. A refusal from the store comes back as 400
  // with its reason. Returns false for paths that aren't group routes.
  async function groupRoute(req, res, path) {
    if (req.method === 'GET' && path === '/api/groups') return reply(res, 200, groups.snapshot()), true;
    if (req.method !== 'POST') return false;
    const routes = [
      [/^\/api\/groups$/, (_, body) => groups.createGroup(body.name)],
      [/^\/api\/groups\/([0-9a-f]+)\/rename$/, ([id], body) => groups.renameGroup(id, body.name)],
      [/^\/api\/groups\/([0-9a-z-]+)\/delete$/, ([id]) => groups.deleteGroup(id)],
      [/^\/api\/sessions\/([A-Za-z0-9_-]+)\/group$/, ([sid], body) => groups.assign(sid, body.group ?? null)],
      [/^\/api\/sessions\/([A-Za-z0-9_-]+)\/name$/, ([sid], body) => groups.rename(sid, body.name ?? '')],
    ];
    const route = routes.find(([pattern]) => pattern.test(path));
    if (!route) return false;
    const body = await readJson(req, res);
    if (body === undefined) return true;
    try {
      const result = route[1](route[0].exec(path).slice(1), body);
      reply(res, 200, result ?? { ok: true });
    } catch (err) {
      reply(res, 400, { error: err.message });
    }
    return true;
  }

  // From the PermissionRequest hook: with no dashboard page open, hand the
  // request straight back (204, so the terminal decides); otherwise hold the
  // request open until it's answered on the page. If the hook goes away
  // first (the terminal was answered), the request is dropped.
  async function holdApproval(req, res) {
    const body = await readJson(req, res, 256 * 1024);
    if (body === undefined) return;
    if (!streams.size) {
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }
    const pending = approvals.request(body);
    res.on('close', () => {
      if (!res.writableEnded) pending.cancel();
    });
    const decision = await pending.decision;
    if (res.destroyed || res.writableEnded) return;
    if (decision) return reply(res, 200, decision);
    // Dropped (its chat moved on): tell the hook to stand down now.
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
  }

  function keyMatches(given) {
    return sameSecret(given, expected);
  }

  function openStream(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    });
    send(res, 'chats', JSON.stringify(chats.list()));
    if (usage) send(res, 'usage', JSON.stringify(usage.snapshot()));
    if (groups) send(res, 'groups', JSON.stringify(groups.snapshot()));
    if (approvals) send(res, 'approvals', JSON.stringify(approvals.list()));
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  server.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeUsage?.();
    unsubscribeGroups?.();
    unsubscribeApprovals?.();
  });
  return server;
}

function sameSecret(given, expected) {
  if (typeof given !== 'string') return false;
  const buf = Buffer.from(given);
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

function localAddresses(server) {
  const port = server.address()?.port;
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

// Every request must name this machine and port in Host, which stops
// DNS-rebinding pages. The page and its assets hold no data, so that is all
// they need (and a link from anywhere can open the dashboard).
function toThisServer(req, server) {
  return localAddresses(server).includes(req.headers.host);
}

// Chat data also needs: Origin, when a browser sends one, to be this same
// server, and the browser's Sec-Fetch-Site label not to say another site,
// which for localhost includes dev servers on other ports.
function fromThisPage(req, server) {
  const allowed = localAddresses(server);
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  return !origin || allowed.some((h) => origin === `http://${h}`);
}

const MAX_BODY = 4096;

// The request body as JSON, or undefined after replying 415/413/400.
async function readJson(req, res, limit = MAX_BODY) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
    reply(res, 415, { error: 'send JSON' });
    return undefined;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      reply(res, 413, { error: 'request too large' });
      return undefined;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Falls through to the refusal below.
  }
  reply(res, 400, { error: 'send a JSON object' });
  return undefined;
}

function wholeNumber(text) {
  return text !== null && /^\d+$/.test(text) ? Number(text) : undefined;
}

function reply(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
