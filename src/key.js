import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The dashboard's key, kept across restarts so a browser set up once keeps
// working. The folder is 0700 and the file 0600 on every start; a new key is
// written to a private temporary file and renamed into place, so it is never
// readable by anyone else, even for a moment.
export function loadKey(path) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      chmodSync(path, 0o600);
      return existing;
    }
  } catch {
    // First run, or unreadable: make a new one.
  }
  const key = randomBytes(32).toString('hex');
  const temp = join(dir, `.key-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(temp, `${key}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  return key;
}
