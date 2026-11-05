import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*?)\s*$/;

// `ps -axo pid=,ppid=,tty=,lstart=,command=` output → Map<pid, row>.
export function parsePs(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const m = ROW.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, { pid, ppid: Number(m[2]), tty: m[3], started: m[4].replace(/\s+/g, ' '), command: m[5] });
  }
  return table;
}

// The live process table. Start times come out in UTC and the C locale, the
// format Claude Code writes as `procStart` in its session records.
export function systemProcesses() {
  return {
    // `signal` stops a ps that has hung, rather than leaving it running.
    async snapshot({ signal } = {}) {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,tty=,lstart=,command='], {
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
        killSignal: 'SIGKILL',
        signal,
      });
      return parsePs(stdout);
    },
  };
}
