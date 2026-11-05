// The apps a chat can run in: how to spot each in a process's parents, what
// to call it, and how its window is brought forward. Adding an app is one
// row here.
const APPS = [
  { id: 'cursor', label: 'Cursor', pattern: /Cursor\.app\/|Cursor Helper/, openName: 'Cursor' },
  { id: 'vscode', label: 'VS Code', pattern: /Visual Studio Code\.app\/|Code Helper/, openName: 'Visual Studio Code' },
  { id: 'terminal', label: 'Terminal', pattern: /Terminal\.app\//, openName: 'Terminal' },
  { id: 'ghostty', label: 'Ghostty', pattern: /Ghostty\.app\/|(^|\/)ghostty(\s|$)/, openName: 'Ghostty' },
  { id: 'iterm', label: 'iTerm', pattern: /iTerm\.app\/|iTerm2/, openName: 'iTerm' },
  { id: 'warp', label: 'Warp', pattern: /Warp\.app\//, openName: 'Warp' },
  { id: 'background', label: 'Background', pattern: /claude daemon/, openName: null },
];
const OTHER = { id: 'other', label: 'Other app', openName: null };
const byId = new Map([...APPS, OTHER].map((app) => [app.id, app]));

export function appInfo(id) {
  return byId.get(id) ?? OTHER;
}

// Commands of a process's parents, nearest first → app id. Nearest match wins.
export function appFromAncestry(commands) {
  for (const command of commands) {
    const app = APPS.find((a) => a.pattern.test(command));
    if (app) return app.id;
  }
  return OTHER.id;
}

// What the page needs to know about a chat's app: its name, and why its
// window can't be brought forward (null when it can).
export function describeApp({ app, tty }) {
  const info = appInfo(app);
  let cannotFocus = null;
  if (info.id === 'terminal' && !tty) cannotFocus = 'This chat has no Terminal tab attached.';
  else if (info.id === 'background') cannotFocus = 'Background chat with no window. Open it from claude agents in a terminal.';
  else if (!info.openName) cannotFocus = 'Not sure which app this chat is running in, so there is no window to bring forward.';
  return { appLabel: info.label, cannotFocus };
}
