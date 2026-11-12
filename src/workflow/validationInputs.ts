import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Known locked build source cannot drift invisibly. The gitignored checkout may be
 * shared with another worktree through a link, so it is resolved before walking. Its
 * bytes are only hashed, never published, so the repository containment rule for
 * submitted files does not apply; links inside the package are still refused.
 */
export function dependencyFingerprint(root: string): string | null {
  const file = join(root, 'build-dependencies.json');
  if (!existsSync(file)) return null;
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  if (lock.schema !== 'tracetoon.build-dependencies/v1') return null;
  const hash = createHash('sha256').update(JSON.stringify(lock));
  const name = '.tracetoon-deps/Showtail/packages/agent-traces';
  const dir = join(root, name);
  if (!existsSync(dir)) return hash.update('\0missing').digest('hex');
  const walk = (path: string, rel: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const target = join(path, entry.name),
        relName = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error('Locked validation dependency contains a symlink.');
      if (entry.isDirectory()) walk(target, relName);
      else if (entry.isFile())
        hash.update(relName).update('\0').update(readFileSync(target)).update('\0');
      else throw new Error('Locked validation dependency contains a special file.');
    }
  };
  walk(realpathSync.native(dir), name);
  return hash.digest('hex');
}
