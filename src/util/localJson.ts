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

/**
 * Windows refuses to replace a file that another process is replacing at the
 * same moment (EPERM, EACCES, EBUSY). Hooks from several hosts fire together,
 * so retry briefly instead of failing.
 */
function renameWithRetry(from: string, to: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw e;
      Atomics.wait(pause, 0, 0, 10 + attempt * 5);
    }
  }
}

export function writeLocal(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const scratch = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(scratch, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameWithRetry(scratch, path);
  } finally {
    rmSync(scratch, { force: true });
  }
}
