import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKey } from '../src/key.js';

const mode = (path) => statSync(path).mode & 0o777;

test('keeps the same key across starts, readable only by this user', () => {
  const root = mkdtempSync(join(tmpdir(), 'key-'));
  const path = join(root, 'cfg', 'key');
  const first = loadKey(path);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(loadKey(path), first);
  assert.equal(mode(path), 0o600);
  assert.equal(mode(join(root, 'cfg')), 0o700);
  rmSync(root, { recursive: true, force: true });
});

test('a replaced key is never written into a file or folder others can read', () => {
  const root = mkdtempSync(join(tmpdir(), 'key-'));
  const dir = join(root, 'cfg');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const path = join(dir, 'key');
  writeFileSync(path, 'not a key\n', { mode: 0o644 });
  chmodSync(path, 0o644);

  const key = loadKey(path);

  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(path, 'utf8').trim(), key);
  assert.equal(mode(path), 0o600);
  assert.equal(mode(dir), 0o700);
  rmSync(root, { recursive: true, force: true });
});
