/**
 * The `tracetoon-assets` branch: an orphan branch in the repo that holds the
 * comic images linked from PRs. Nothing is read back from it. It is written with git plumbing only (blobs,
 * trees, commits, push), so the user's working tree and branch never change.
 * Images are linked by commit, so a published PR always shows the exact file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../util/exec.ts';

export const ASSETS_BRANCH = 'tracetoon-assets';
const LOCAL_REF = 'refs/tracetoon/assets';

export interface AssetFile {
  /** Path inside the assets branch, forward slashes. */
  path: string;
  data: Uint8Array | string;
}

/** Bring the remote assets branch into a private local ref. False if it doesn't exist yet. */
export function fetchAssets(root: string, remote = 'origin'): boolean {
  const r = git(root, [
    'fetch',
    '--quiet',
    '--no-tags',
    remote,
    `+refs/heads/${ASSETS_BRANCH}:${LOCAL_REF}`,
  ]);
  return r.ok;
}

export function assetsHead(root: string): string | undefined {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${LOCAL_REF}^{commit}`]);
  return r.ok ? r.stdout.trim() : undefined;
}

/** Add files on top of the assets branch and push. Returns the new commit. */
export function publishAssets(
  root: string,
  files: AssetFile[],
  message: string,
  remote = 'origin',
): string {
  fetchAssets(root, remote);
  const parent = assetsHead(root);
  const dir = mkdtempSync(join(tmpdir(), 'tracetoon-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    if (parent) {
      const rt = git(root, ['read-tree', parent], undefined, env);
      if (!rt.ok) throw new Error(`git read-tree failed: ${rt.stderr.trim()}`);
    }
    for (const f of files) {
      const blob = git(
        root,
        ['hash-object', '-w', '--stdin'],
        typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data,
      );
      if (!blob.ok) throw new Error(`git hash-object failed: ${blob.stderr.trim()}`);
      const add = git(
        root,
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${blob.stdout.trim()},${f.path}`,
        ],
        undefined,
        env,
      );
      if (!add.ok) throw new Error(`git update-index failed: ${add.stderr.trim()}`);
    }
    const tree = git(root, ['write-tree'], undefined, env);
    if (!tree.ok) throw new Error(`git write-tree failed: ${tree.stderr.trim()}`);
    const args = ['commit-tree', tree.stdout.trim(), '-m', message];
    if (parent) args.push('-p', parent);
    const commit = git(root, args);
    if (!commit.ok) throw new Error(`git commit-tree failed: ${commit.stderr.trim()}`);
    const sha = commit.stdout.trim();
    const push = git(root, [
      'push',
      '--quiet',
      remote,
      `${sha}:refs/heads/${ASSETS_BRANCH}`,
    ]);
    if (!push.ok)
      throw new Error(`could not push ${ASSETS_BRANCH}: ${push.stderr.trim()}`);
    git(root, ['update-ref', LOCAL_REF, sha]);
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Web URL for a file at a specific assets commit. */
export function assetUrl(web: string, commit: string, path: string): string {
  return `${web.replace(/\/$/, '')}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}?raw=true`;
}
