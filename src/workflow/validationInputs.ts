import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readSubmittedFile } from '../util/repoFiles.ts';
/** Known locked build source lives inside this checkout and cannot drift invisibly. */
export function dependencyFingerprint(root: string): string | null {
  const file = join(root, 'build-dependencies.json');
  if (!existsSync(file)) return null;
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  if (lock.schema !== 'tracetoon.build-dependencies/v1') return null;
  const hash = createHash('sha256').update(JSON.stringify(lock));
  const dir = join(root, '.tracetoon-deps', 'Showtail', 'packages', 'agent-traces');
  if (!existsSync(dir)) return hash.update('\0missing').digest('hex');
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const target = join(path, entry.name),
        name = relative(root, target).replace(/\\/g, '/');
      if (entry.isSymbolicLink())
        throw new Error('Locked validation dependency contains a symlink.');
      if (entry.isDirectory()) walk(target);
      else
        hash.update(name).update('\0').update(readSubmittedFile(root, name)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex');
}
