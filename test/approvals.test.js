import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApprovals } from '../src/approvals.js';

const BASH = { session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'touch a.txt', description: 'Create a file' }, permission_suggestions: [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
] };

test('a request waits until you answer, then gives the hook its decision', async () => {
  const approvals = openApprovals();
  const pending = approvals.request(BASH);
  const [item] = approvals.list();
  assert.equal(item.sessionId, 'sess-1');
  assert.equal(item.tool, 'Bash');
  assert.equal(item.detail, 'touch a.txt');
  assert.equal(item.canAlwaysAllow, true);
  assert.match(item.alwaysLabel, /touch/);

  approvals.decide(item.id, 'once');
  assert.deepEqual(await pending.decision, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(approvals.list(), []);
});

test('Always allow applies the rule Claude Code itself suggested, never a mode change', async () => {
  const approvals = openApprovals();
  const pending = approvals.request(BASH);
  approvals.decide(approvals.list()[0].id, 'always');
  const { decision } = (await pending.decision).hookSpecificOutput;
  assert.equal(decision.behavior, 'allow');
  assert.deepEqual(decision.updatedPermissions, [BASH.permission_suggestions[0]]);
});

test('Deny tells Claude it was denied from the dashboard', async () => {
  const approvals = openApprovals();
  const pending = approvals.request(BASH);
  approvals.decide(approvals.list()[0].id, 'deny');
  const { decision } = (await pending.decision).hookSpecificOutput;
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message, /dashboard/);
});

test('when the hook goes away (the terminal answered first), the request disappears unanswered', async () => {
  const approvals = openApprovals();
  const pending = approvals.request(BASH);
  const seen = [];
  approvals.subscribe((list) => seen.push(list.length));
  pending.cancel();
  assert.equal(await pending.decision, null);
  assert.deepEqual(approvals.list(), []);
  assert.deepEqual(seen, [0]);
  assert.throws(() => approvals.decide('anything', 'once'), /no longer waiting/);
});

test('no Always allow when Claude Code offered no rule for it', () => {
  const approvals = openApprovals();
  approvals.request({ ...BASH, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  assert.equal(approvals.list()[0].canAlwaysAllow, false);
});

test('what is shown: the command, the file, or a short summary for other tools', () => {
  const approvals = openApprovals();
  approvals.request({ session_id: 's', tool_name: 'Write', tool_input: { file_path: '/tmp/x.txt', content: 'secret stuff' } });
  approvals.request({ session_id: 's', tool_name: 'mcp__slack__send_message', tool_input: { channel: 'C1', text: 'hi' } });
  const [write, mcp] = approvals.list();
  assert.equal(write.detail, '/tmp/x.txt');
  assert.match(mcp.tool, /send_message/);
  assert.match(mcp.detail, /"channel":"C1"/);
});

test('bad answers and unknown requests are refused', () => {
  const approvals = openApprovals();
  approvals.request(BASH);
  assert.throws(() => approvals.decide(approvals.list()[0].id, 'maybe'), /choice/);
  assert.throws(() => approvals.decide('nope', 'once'), /no longer waiting/);
});

test('a request is dropped once its chat no longer needs you, after a short grace, and the hook is told to stand down', async () => {
  let clock = 1_000_000;
  const approvals = openApprovals({ now: () => clock, graceMs: 3000 });
  const settled = approvals.request(BASH);
  const waiting = approvals.request({ ...BASH, session_id: 'sess-2' });
  const young = approvals.request({ ...BASH, session_id: 'sess-3' });
  clock += 4000;
  const newer = approvals.request({ ...BASH, session_id: 'sess-3' });

  approvals.keepOnly(new Set(['sess-2']));

  assert.equal(await settled.decision, null);
  assert.equal(await young.decision, null);
  assert.deepEqual(approvals.list().map((a) => a.sessionId), ['sess-2', 'sess-3']);
  approvals.decide(approvals.list()[0].id, 'once');
  assert.ok(await waiting.decision);
  newer.cancel();
});
