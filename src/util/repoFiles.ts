/** Read repository data without following directory links into another project. */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function privateRepoPath(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .some((p) => ['.git', '.showtail'].includes(p.toLowerCase()));
}

export function repoPath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !/[:\x00-\x1f\x7f]/.test(path) &&
    !privateRepoPath(path) &&
    !path.split('/').some((p) => !p || p === '..' || p === '.')
  );
}

function contained(root: string, target: string): void {
  const rel = relative(realpathSync.native(root), target).replace(/\\/g, '/');
  if (rel !== '' && !repoPath(rel))
    throw new Error('Path is outside the repository or private.');
}

export function readRepoFile(root: string, location: string): Buffer {
  if (!repoPath(location)) throw new Error(`Unsafe repository source: ${location}`);
  const target = realpathSync.native(resolve(root, location));
  contained(root, target);
  return readFileSync(target);
}

/** Git stores file symlinks as link text; never read their target's contents. */
export function readSubmittedFile(root: string, location: string): Buffer {
  if (!repoPath(location)) throw new Error(`Unsafe submitted path: ${location}`);
  const target = resolve(root, location);
  contained(root, realpathSync.native(dirname(target)));
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return Buffer.from(readlinkSync(target), 'utf8');
  if (!info.isFile()) throw new Error('Submitted path is not a regular file.');
  return readRepoFile(root, location);
}
