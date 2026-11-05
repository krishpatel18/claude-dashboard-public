#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openChats } from './chats.js';
import { createFocus } from './focus.js';
import { loadKey } from './key.js';
import { systemProcesses } from './processes.js';
import { openUsage } from './usage.js';
import { openGroups } from './groups.js';
import { openApprovals } from './approvals.js';
import { createDashboardServer } from './server.js';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a number from 1 to 65535 (got "${process.env.PORT}").`);
  process.exit(1);
}
const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const keyFile = join(homedir(), '.config', 'claude-dashboard', 'key');

const key = loadKey(keyFile);
// Single-use: the printed link carries this, never the key itself.
const pairingCode = randomBytes(16).toString('hex');

const chats = await openChats({
  sessionsDir: join(claudeDir, 'sessions'),
  projectsDir: join(claudeDir, 'projects'),
  processes: systemProcesses(),
});
// Plan figures are saved here by the status-line wrapper (see README).
const usage = await openUsage({
  usageFile: join(claudeDir, 'dashboard', 'usage.json'),
  projectsDir: join(claudeDir, 'projects'),
});
// Your chat groups and chat names; open chats count as seen, so their
// entries aren't forgotten after 30 days.
const groups = await openGroups({ file: join(homedir(), '.config', 'claude-dashboard', 'groups.json') });
const markSeen = () => groups.seen(chats.list().map((c) => c.sessionId));
markSeen();
chats.subscribe(markSeen);
const approvals = openApprovals();
// Requests whose chat no longer needs you are dropped (see approvals.js).
const dropSettled = () => approvals.keepOnly(new Set(chats.list().filter((c) => c.status === 'waiting').map((c) => c.sessionId)));
chats.subscribe(dropSettled);
setInterval(dropSettled, 5000).unref();
const server = createDashboardServer({ chats, focus: createFocus(), key, pairingCode, usage, groups, approvals });

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Is the dashboard already running? Set PORT to use another.` : err.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  // Where the permission hook (hooks/permission-request.sh) finds the dashboard.
  const configDir = join(homedir(), '.config', 'claude-dashboard');
  writeFileSync(join(configDir, 'url'), `http://127.0.0.1:${port}\n`, { mode: 0o600 });
  // The hook hands this to curl as a config file, so the key never shows in
  // a process list.
  writeFileSync(join(configDir, 'curl-config'), `header = "x-dashboard-key: ${key}"\n`, { mode: 0o600 });
  console.log(`Claude dashboard (${chats.list().length} chats open). To use it in a new browser, open this link once (it works one time):\n  http://localhost:${port}/#pair=${pairingCode}\nBrowsers already set up just use http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    chats.close();
    usage.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
