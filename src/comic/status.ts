/** `comic-status.json` in a run: why the last `comic art` drew nothing, for publish to say so. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../run.ts';

/** Why the last `comic art` drew nothing, for publish to say so. */
export interface ComicStatus {
  state: 'no-route' | 'failed';
  detail: string;
  at: string;
}

const STATUS_FILE = 'comic-status.json';

export function writeComicStatus(
  run: Run,
  status: Omit<ComicStatus, 'at'> & { at?: string },
): void {
  const record: ComicStatus = {
    state: status.state,
    detail: status.detail.replace(/\s+/g, ' ').trim().slice(0, 120),
    at: status.at ?? new Date().toISOString(),
  };
  writeFileSync(
    join(run.dir, STATUS_FILE),
    JSON.stringify(record, null, 2) + '\n',
    'utf8',
  );
}

export function readComicStatus(run: Run): ComicStatus | undefined {
  try {
    const s = JSON.parse(readFileSync(join(run.dir, STATUS_FILE), 'utf8')) as ComicStatus;
    return s && (s.state === 'no-route' || s.state === 'failed') ? s : undefined;
  } catch {
    return undefined;
  }
}

export function clearComicStatus(run: Run): void {
  rmSync(join(run.dir, STATUS_FILE), { force: true });
}
