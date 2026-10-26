/** Worktree-local task state. A rendered artifact and a delivered handoff are distinct. */
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from '../util/exec.ts';
import { readSubmittedFile, repoPath } from '../util/repoFiles.ts';
import { readLocal, writeLocal } from '../util/localJson.ts';
import { findRun, newRun, type Run } from '../run.ts';
import { defaultBase } from '../git/pr.ts';

export type TaskState =
  'working' | 'preparing' | 'ready' | 'blocked' | 'deferred' | 'published';
export interface Task {
  v: 1;
  run: string;
  root: string;
  branch: string;
  base: string;
  session?: string;
  transcript?: string;
  baseline: string;
  state: TaskState;
  reason?: string;
  checks?: string[];
  noChecksReason?: string;
  readyCode?: string;
  readyReviewSha?: string;
  readyChecksSha?: string;
  readyPreviewSha?: string;
  presentedCode?: string;
  startedAt: string;
  updatedAt: string;
  readyAt?: string;
  presentedAt?: string;
  recoveryGeneration?: number;
}

export function repository(cwd: string): {
  root: string;
  gitDir: string;
  branch: string;
} {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error('Not inside a git repository.');
  const root = resolve(top.stdout.trim());
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  return { root, gitDir, branch };
}

/** Includes committed progress and all public working changes, but no private trails. */
export function workFingerprint(root: string): string {
  const hash = createHash('sha256');
  for (const args of [
    ['rev-parse', 'HEAD'],
    [
      'diff',
      '--binary',
      '--no-ext-diff',
      'HEAD',
      '--',
      '.',
      ':(exclude,icase).showtail',
      ':(exclude,icase,glob)**/.showtail',
      ':(exclude,icase,glob)**/.showtail/**',
    ],
  ]) {
    const result = git(root, args);
    if (!result.ok) throw new Error('Cannot fingerprint repository state.');
    hash.update(result.stdout).update('\0');
  }
  const files = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!files.ok) throw new Error('Cannot inspect untracked files.');
  for (const file of files.stdout.split('\0').filter(repoPath).sort()) {
    hash.update(file).update('\0').update(readSubmittedFile(root, file)).update('\0');
  }
  return hash.digest('hex');
}

/** Test identity follows content, not commit time or SHA. Includes nonignored new files. */
export function contentFingerprint(root: string): string {
  const files = git(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (!files.ok) throw new Error('Cannot fingerprint validation inputs.');
  const hash = createHash('sha256');
  for (const file of [...new Set(files.stdout.split('\0').filter(repoPath))].sort()) {
    const path = join(root, file);
    let info;
    try {
      info = lstatSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    hash.update(file).update('\0');
    if (info.isDirectory())
      hash.update(contentFingerprint(path)); // checked-out git submodule
    else hash.update(String(info.mode & 0o111)).update(readSubmittedFile(root, file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export const taskPath = (run: Run) => join(run.dir, 'task.json');
export const readTask = (run: Run) => readLocal<Task>(taskPath(run));
export function saveTask(run: Run, task: Task): Task {
  task.updatedAt = new Date().toISOString();
  writeLocal(taskPath(run), task);
  return task;
}

export function tasks(gitDir: string): { run: Run; task: Task }[] {
  const dir = join(gitDir, 'tracetoon', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && !d.isSymbolicLink() && /^\d{8}-\d{6}(-\d+)?$/.test(d.name),
    )
    .flatMap((d) => {
      const run = { id: d.name, dir: join(dir, d.name) };
      const task = readTask(run);
      return task?.v === 1 && task.run === run.id ? [{ run, task }] : [];
    })
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
}

export function beginTask(
  cwd: string,
  options: { run?: string; base?: string; session?: string; transcript?: string } = {},
) {
  const repo = repository(cwd);
  const existing = options.run
    ? {
        run: findRun(repo.gitDir, options.run),
        task: readTask(findRun(repo.gitDir, options.run)),
      }
    : tasks(repo.gitDir).find(
        (t) => t.task.branch === repo.branch && t.task.state !== 'published',
      );
  if (existing?.task) {
    if (existing.task.root !== repo.root)
      throw new Error('Switch to the task worktree before resuming it.');
    if (existing.task.branch !== repo.branch) {
      const oldHead = git(repo.root, ['rev-parse', existing.task.branch]).stdout.trim();
      const currentHead = git(repo.root, ['rev-parse', 'HEAD']).stdout.trim();
      if (!options.run || !oldHead || oldHead !== currentHead)
        throw new Error(
          'Switch to the task branch before resuming it. To adopt a new branch explicitly, branch from the same commit and pass --run.',
        );
      existing.task.branch = repo.branch;
      existing.task.state = 'working';
      existing.task.readyCode = undefined;
    }
    if (options.session) existing.task.session = options.session;
    if (options.transcript) existing.task.transcript = options.transcript;
    if (options.base && options.base !== existing.task.base) {
      existing.task.base = options.base;
      existing.task.readyCode = undefined;
      existing.task.state = 'working';
    }
    saveTask(existing.run, existing.task);
    return { ...repo, run: existing.run, task: existing.task };
  }
  const run = existing?.run ?? newRun(repo.gitDir);
  const task: Task = {
    v: 1,
    run: run.id,
    root: repo.root,
    branch: repo.branch,
    base: options.base ?? defaultBase(repo.root),
    session: options.session,
    transcript: options.transcript,
    baseline: workFingerprint(repo.root),
    state: 'working',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTask(run, task);
  return { ...repo, run, task };
}

export function taskSummary(gitDir: string) {
  return tasks(gitDir).map(({ run, task }) => ({
    run: run.id,
    state: task.state,
    branch: task.branch,
    root: task.root,
    reason: task.reason,
    presented: !!task.readyCode && task.presentedCode === task.readyCode,
    nextAction:
      task.state === 'preparing' || task.state === 'blocked'
        ? `Resume preparation with --run ${run.id}`
        : undefined,
  }));
}
