/**
 * A run's scratch folder: `<git dir>/tracetoon/runs/<id>/`. Git never tracks it and
 * each run is self-contained. Pending previews are retained until publication,
 * dismissal or replacement; other runs are disposable scratch.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { activePendingRuns } from './review/pending.ts';

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
  const name = dir.split(/[\\/]/).pop()!;
  writeFileSync(join(runsDir(gitDir), 'latest'), name, 'utf8');
  pruneRuns(gitDir, name);
  return { id: name, dir };
}

/** How many scratch runs to keep in addition to active pending previews. */
export const KEEP_RUNS = 20;

/** Delete all but the newest run folders (never `keep`). */
export function pruneRuns(gitDir: string, keep?: string): void {
  const base = runsDir(gitDir);
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const pending = new Set(activePendingRuns(gitDir).map((d) => d.run.id));
  const scratch = runs.filter((name) => !pending.has(name));
  for (const name of scratch.slice(0, Math.max(0, scratch.length - KEEP_RUNS)))
    if (name !== keep) rmSync(join(base, name), { recursive: true, force: true });
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
