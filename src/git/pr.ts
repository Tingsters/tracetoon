/**
 * Ground truth for a PR from git: which repo, which branches, which commits, and
 * exactly which lines the PR adds. Everything else is matched against this.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gh, git } from '../util/exec.ts';

export interface Commit {
  sha: string;
  subject: string;
  authorTime: number;
  commitTime: number;
  trailers: Record<string, string[]>;
}

export interface FileChange {
  /** Repo-relative, forward slashes. */
  path: string;
  added: string[];
  removed: string[];
  /** Line number (in the new file) of each entry in `added`, when known. */
  addedAt?: number[];
}

export interface ExistingPr {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  state: string;
}

export interface PrTruth {
  toplevel: string;
  gitDir: string;
  /** The checkout plus every worktree of the same repo. */
  roots: string[];
  head: string;
  base: string;
  mergeBase: string;
  /** Commit time of the merge base (ms), when it resolves to a commit. */
  mergeBaseTime?: number;
  commits: Commit[];
  files: FileChange[];
  /** True when there were no commits ahead of base and the working tree was used. */
  usedWorkingTree: boolean;
  dirty: boolean;
  remote?: { owner: string; name: string; url: string };
  pr?: ExistingPr;
}

function must(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (!r.ok)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.code}`);
  return r.stdout.trim();
}

export function worktreeRoots(cwd: string): string[] {
  const r = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => resolve(l.slice('worktree '.length)));
}

function parseRemote(url: string): { owner: string; name: string } | undefined {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

/** The branch PRs normally target: origin/HEAD, else main, else master. */
export function defaultBase(cwd: string): string {
  const sym = git(cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master', 'trunk', 'develop']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', b]).ok) return b;
  }
  return 'main';
}

/** The ref to diff against: the remote-tracking base when it exists, else the local one. */
function baseRef(cwd: string, base: string): string {
  if (git(cwd, ['rev-parse', '--verify', '--quiet', `origin/${base}`]).ok)
    return `origin/${base}`;
  return base;
}

export function existingPr(cwd: string, head: string): ExistingPr | undefined {
  const r = gh(cwd, [
    'pr',
    'view',
    head,
    '--json',
    'number,url,title,body,baseRefName,headRefName,state',
  ]);
  if (!r.ok) return undefined;
  try {
    const pr = JSON.parse(r.stdout) as ExistingPr;
    return pr.state === 'OPEN' || pr.state === 'DRAFT' ? pr : undefined;
  } catch {
    return undefined;
  }
}

function parseTrailers(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    (out[m[1]!] ??= []).push(m[2]!.trim());
  }
  return out;
}

export function commitsBetween(cwd: string, from: string, to: string): Commit[] {
  const r = git(cwd, [
    'log',
    '--reverse',
    '--format=%H%x1f%s%x1f%at%x1f%ct%x1f%(trailers:unfold,only)%x1e',
    `${from}..${to}`,
  ]);
  if (!r.ok) return [];
  return r.stdout
    .split('\x1e')
    .map((rec) => rec.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject, at, ct, trailers] = rec.split('\x1f');
      return {
        sha: sha!,
        subject: subject ?? '',
        authorTime: Number(at) * 1000,
        commitTime: Number(ct) * 1000,
        trailers: parseTrailers(trailers ?? ''),
      };
    });
}

/** Parse `git diff -U0` output into per-file added/removed lines. */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | undefined;
  let oldPath: string | undefined;
  let inHunk = false;
  let newLine = 0;
  const hunkStart = (l: string) => Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      cur = undefined;
      oldPath = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        oldPath = p === '/dev/null' ? undefined : p.replace(/^a\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        // A deleted file has `+++ /dev/null`: record it under its old path.
        const path = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
        if (path) {
          cur = { path, added: [], removed: [], addedAt: [] };
          files.push(cur);
        }
      } else if (line.startsWith('@@')) {
        inHunk = true;
        newLine = hunkStart(line);
      }
      continue;
    }
    if (line.startsWith('@@')) {
      newLine = hunkStart(line);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) {
      cur.added.push(line.slice(1));
      cur.addedAt?.push(newLine++);
    } else if (line.startsWith('-')) cur.removed.push(line.slice(1));
    else if (line.startsWith(' ')) newLine++;
  }
  return files;
}

function untrackedAsAdded(cwd: string): FileChange[] {
  const r = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!r.ok) return [];
  const out: FileChange[] = [];
  for (const p of r.stdout.split('\0').filter(Boolean)) {
    const abs = join(cwd, p);
    try {
      const text = readFileSync(abs, 'utf8');
      if (text.includes('\0')) continue; // binary
      out.push({ path: p, added: text.split(/\r?\n/), removed: [] });
    } catch {
      /* unreadable */
    }
  }
  return out;
}

export interface TruthOptions {
  base?: string;
  /** Skip the `gh pr view` lookup (tests, offline). */
  noGh?: boolean;
}

export function prTruth(cwd: string, opts: TruthOptions = {}): PrTruth {
  const toplevel = resolve(must(cwd, ['rev-parse', '--show-toplevel']));
  const gitDir = resolve(toplevel, must(toplevel, ['rev-parse', '--git-dir']));
  const head = must(toplevel, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const pr = opts.noGh ? undefined : existingPr(toplevel, head);
  const base = opts.base ?? pr?.baseRefName ?? defaultBase(toplevel);
  const ref = baseRef(toplevel, base);
  const mergeBase = git(toplevel, ['merge-base', ref, 'HEAD']).stdout.trim() || ref;
  const mbt = Number(
    git(toplevel, ['show', '-s', '--format=%ct', mergeBase]).stdout.trim(),
  );
  const mergeBaseTime = Number.isFinite(mbt) && mbt > 0 ? mbt * 1000 : undefined;
  const commits = commitsBetween(toplevel, mergeBase, 'HEAD');
  const dirty = git(toplevel, ['status', '--porcelain']).stdout.trim().length > 0;
  const usedWorkingTree = commits.length === 0;
  const diffArgs = usedWorkingTree
    ? ['diff', '-U0', '--no-color', '--no-ext-diff', mergeBase]
    : ['diff', '-U0', '--no-color', '--no-ext-diff', mergeBase, 'HEAD'];
  let files = parseUnifiedDiff(git(toplevel, diffArgs).stdout);
  if (usedWorkingTree) files = files.concat(untrackedAsAdded(toplevel));
  const roots = [...new Set([toplevel, ...worktreeRoots(toplevel)])];
  const url = git(toplevel, ['remote', 'get-url', 'origin']).stdout.trim();
  const parsed = url ? parseRemote(url) : undefined;
  return {
    toplevel,
    gitDir,
    roots,
    head,
    base,
    mergeBase,
    mergeBaseTime,
    commits,
    files,
    usedWorkingTree,
    dirty,
    remote: parsed ? { ...parsed, url } : undefined,
    pr,
  };
}

export function hasFile(toplevel: string, rel: string): boolean {
  return existsSync(join(toplevel, rel));
}
