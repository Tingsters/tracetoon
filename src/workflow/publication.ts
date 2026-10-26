import { openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLocal, writeLocal } from '../util/localJson.ts';
import type { Run } from '../run.ts';

/** One publisher per run; a crashed process leaves a recoverable, PID-checked lock. */
export function publicationLock<T>(
  run: Run,
  action: () => T,
  name: 'publish.lock' | 'checks.lock' = 'publish.lock',
): T {
  const label = name === 'checks.lock' ? 'Validation' : 'Publication';
  const path = join(run.dir, name);
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch {
    const old = readLocal<{ pid: number }>(path);
    if (!old?.pid)
      throw new Error(`${label} lock is unreadable. Inspect this run before retrying.`);
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (alive)
      throw new Error(
        `${label} is already running for this Tracetoon. Wait for that attempt to finish.`,
      );
    rmSync(path);
    fd = openSync(path, 'wx');
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return action();
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
}

export function recordTiming(run: Run, stage: string, durationMs: number) {
  const path = join(run.dir, 'timings.json');
  const entries =
    readLocal<{ stage: string; durationMs: number; at: string }[]>(path) ?? [];
  writeLocal(
    path,
    [
      ...entries,
      { stage, durationMs: Math.round(durationMs), at: new Date().toISOString() },
    ].slice(-200),
  );
}
