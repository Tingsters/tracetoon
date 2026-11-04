/** Resolve shared source from a locked checkout, never a mutable sibling repo. */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const root = resolve(import.meta.dir, '..');
export function treeDigest(dir: string): string {
  const hash = createHash('sha256');
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Dependency contains a symlink: ${file}`);
      if (entry.isDirectory()) walk(file);
      else
        hash
          .update(relative(dir, file).replace(/\\/g, '/'))
          .update('\0')
          .update(readFileSync(file))
          .update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex');
}
function git(args: string[], cwd = root): string {
  const result = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(
      `Pinned dependency Git operation failed: ${result.stderr || result.error?.message}`,
    );
  return result.stdout.trim();
}
export function prepareDependencies(source?: string) {
  const lock = JSON.parse(readFileSync(join(root, 'build-dependencies.json'), 'utf8'));
  if (
    lock.schema !== 'tracetoon.build-dependencies/v1' ||
    !/^[a-f0-9]{40}$/.test(lock.showtail?.revision) ||
    !/^[a-f0-9]{40}$/.test(lock.showtail?.packageTree)
  )
    throw new Error('Invalid build dependency lock.');
  const target = join(root, '.tracetoon-deps', 'Showtail');
  if (!existsSync(target)) {
    mkdirSync(join(root, '.tracetoon-deps'), { recursive: true });
    git([
      'clone',
      '--quiet',
      '--no-checkout',
      '--no-hardlinks',
      source ?? lock.showtail.repository,
      target,
    ]);
    git(['config', 'core.autocrlf', 'false'], target);
    git(['sparse-checkout', 'set', 'packages/agent-traces'], target);
    git(
      [
        '-c',
        'core.autocrlf=false',
        'checkout',
        '--quiet',
        '--detach',
        lock.showtail.revision,
      ],
      target,
    );
  }
  // Keep dependency bytes stable across developer machines and release hosts.
  if (git(['config', '--get', 'core.autocrlf'], target) !== 'false')
    git(['config', 'core.autocrlf', 'false'], target);
  if (
    git(['rev-parse', 'HEAD'], target) !== lock.showtail.revision ||
    git(['rev-parse', 'HEAD:packages/agent-traces'], target) !==
      lock.showtail.packageTree ||
    git(['status', '--porcelain', '--untracked-files=all'], target)
  )
    throw new Error(
      'Pinned Showtail checkout differs from build-dependencies.json. Preserve it for inspection and recreate the dependency checkout.',
    );
  return {
    name: '@showtail/agent-traces',
    revision: lock.showtail.revision as string,
    packageTree: lock.showtail.packageTree as string,
    sha256: treeDigest(join(target, 'packages', 'agent-traces')),
  };
}
if (import.meta.main) {
  const index = process.argv.indexOf('--source');
  console.log(
    JSON.stringify(
      prepareDependencies(index < 0 ? undefined : process.argv[index + 1]),
      null,
      2,
    ),
  );
}
