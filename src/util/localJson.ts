/** Atomic local metadata writes. Never replace a file with partially written JSON. */
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readLocal<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeLocal(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const scratch = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(scratch, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(scratch, path);
  } finally {
    rmSync(scratch, { force: true });
  }
}
