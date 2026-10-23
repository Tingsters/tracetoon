/**
 * A run's scratch folder: `<git dir>/tracetoon/runs/<id>/`. Git never tracks it and
 * it is not a history: each run is self-contained and safe to delete.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Run {
  id: string;
  dir: string;
}

function runsDir(gitDir: string): string {
  return join(gitDir, 'tracetoon', 'runs');
}

export function newRun(gitDir: string): Run {
  const id = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*/, '')
    .replace('T', '-');
  let dir = join(runsDir(gitDir), id);
  let n = 1;
  while (existsSync(dir)) dir = join(runsDir(gitDir), `${id}-${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(runsDir(gitDir), 'latest'), dir.split(/[\\/]/).pop()!, 'utf8');
  return { id: dir.split(/[\\/]/).pop()!, dir };
}

/** The named run, or the latest one. */
export function findRun(gitDir: string, id?: string): Run {
  const base = runsDir(gitDir);
  let name = id;
  if (!name) {
    const latest = join(base, 'latest');
    if (existsSync(latest)) name = readFileSync(latest, 'utf8').trim();
    else {
      const all = existsSync(base)
        ? readdirSync(base)
            .filter((f) => f !== 'latest')
            .sort()
        : [];
      name = all[all.length - 1];
    }
  }
  if (!name || !existsSync(join(base, name))) {
    throw new Error('No Tracetoon run found. Run `tracetoon digest` first.');
  }
  return { id: name, dir: join(base, name) };
}

export function writeJson(run: Run, file: string, data: unknown): string {
  const p = join(run.dir, file);
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return p;
}

export function readJson<T>(run: Run, file: string): T | undefined {
  const p = join(run.dir, file);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

export function readText(run: Run, file: string): string | undefined {
  const p = join(run.dir, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}
