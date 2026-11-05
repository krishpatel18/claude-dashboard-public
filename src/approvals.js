import { randomBytes } from 'node:crypto';

const DETAIL_MAX = 600;

// Permission requests waiting for an answer from the dashboard.
//
// request(hookInput) is called with what Claude Code's PermissionRequest hook
// received; it returns { decision, cancel }. `decision` resolves to the JSON
// the hook should print, or null when nobody answered here (the hook went
// away, usually because the terminal was answered first; the terminal always
// wins). decide(id, 'once' | 'always' | 'deny') answers one. "Always" applies
// only the allow rules Claude Code itself suggested for that request, never a
// permission-mode change.
export function openApprovals({ now = Date.now, graceMs = 3000 } = {}) {
  const pending = new Map(); // id → { item, settle }
  const listeners = new Set();

  const list = () => [...pending.values()].map((p) => p.item);
  const changed = () => {
    const items = list();
    for (const fn of listeners) fn(items);
  };

  return {
    list,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    request(input) {
      const id = randomBytes(8).toString('hex');
      const rules = alwaysRules(input.permission_suggestions);
      const item = {
        id,
        sessionId: typeof input.session_id === 'string' ? input.session_id : '',
        tool: toolLabel(input.tool_name),
        detail: describe(input.tool_name, input.tool_input),
        canAlwaysAllow: rules.length > 0,
        alwaysLabel: rules.length ? `Always allow ${describeRules(rules)}` : null,
        askedAt: new Date().toISOString(),
      };
      let settle;
      const decision = new Promise((resolve) => {
        settle = (value) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve(value);
          changed();
        };
      });
      pending.set(id, { item, settle, rules, at: now() });
      changed();
      return { decision, cancel: () => settle(null) };
    },
    // Claude Code doesn't always end the hook when a request is settled some
    // other way (in auto mode, for one). So once a request's chat no longer
    // needs you, or has closed, the request is dropped; requests younger than
    // the grace period stay, since a chat's status catches up a moment late.
    keepOnly(waitingSessions, { graceMs: grace = graceMs } = {}) {
      const cutoff = now() - grace;
      for (const entry of [...pending.values()]) {
        if (!waitingSessions.has(entry.item.sessionId) && entry.at <= cutoff) entry.settle(null);
      }
    },
    decide(id, choice) {
      const entry = pending.get(id);
      if (!entry) throw new Error('that request is no longer waiting (it was answered in the terminal, or the chat moved on)');
      if (!['once', 'always', 'deny'].includes(choice)) throw new Error('choice must be once, always or deny');
      if (choice === 'always' && !entry.rules.length) throw new Error('Claude Code offered no always-allow rule for this request');
      const decision = choice === 'deny'
        ? { behavior: 'deny', message: 'Denied from the Claude dashboard.' }
        : { behavior: 'allow', ...(choice === 'always' ? { updatedPermissions: entry.rules } : {}) };
      entry.settle({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
    },
  };
}

// The suggestions that grant something lasting (a rule or a folder), the
// same as the terminal's "Yes, and always allow…"; mode switches are left out.
function alwaysRules(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((s) => s && typeof s === 'object'
    && ((s.type === 'addRules' && s.behavior !== 'deny' && Array.isArray(s.rules)) || s.type === 'addDirectories'));
}

function describeRules(rules) {
  return rules.map((r) => {
    if (r.type === 'addDirectories') return `access to ${(r.directories ?? []).join(', ')}`;
    return r.rules.map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)).join(', ');
  }).join('; ');
}

function toolLabel(name) {
  if (typeof name !== 'string' || !name) return 'tool';
  const parts = name.split('__');
  return parts[0] === 'mcp' && parts.length >= 3 ? `${parts.slice(2).join('__')} (${parts[1]})` : name;
}

// What the request would do, in a line: the command, the file, or the input.
function describe(name, input) {
  if (!input || typeof input !== 'object') return '';
  const text = typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
      : typeof input.url === 'string' ? input.url
        : JSON.stringify(input);
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}
