import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultBase, gitIdentity, prTruth } from '../src/git/pr.ts';
import { repository } from '../src/workflow/state.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';
import { submission } from '../src/contribution/guidance.ts';

// These build real repos and run many git processes; Windows CI runners are slow.
setDefaultTimeout(60_000);

const g = (cwd: string, ...args: string[]) => {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

describe('repository identity in one git call', () => {
  test('from a subdirectory: top level, absolute git dir and branch', () => {
    const repo = makeRepo();
    mkdirSync(join(repo.root, 'deep', 'er'), { recursive: true });
    const id = gitIdentity(join(repo.root, 'deep', 'er'))!;
    expect(id).toEqual({
      toplevel: resolve(repo.root),
      gitDir: resolve(repo.root, '.git'),
      branch: 'feature',
      headSha: g(repo.root, 'rev-parse', 'HEAD'),
      ok: true,
    });
    expect(repository(join(repo.root, 'deep'))).toEqual({
      root: resolve(repo.root),
      gitDir: resolve(repo.root, '.git'),
      branch: 'feature',
    });
  });

  test('detached and unborn HEADs keep their previous answers', () => {
    const repo = makeRepo();
    g(repo.root, 'checkout', '-q', '--detach');
    expect(gitIdentity(repo.root)).toMatchObject({ branch: 'HEAD', ok: true });
    expect(repository(repo.root).branch).toBe('HEAD');
    const unborn = tempDir('tracetoon-unborn-');
    g(unborn, 'init', '-q', '-b', 'main');
    // `rev-parse --abbrev-ref HEAD` printed HEAD and failed; repository() kept it.
    expect(gitIdentity(unborn)).toMatchObject({ branch: 'HEAD', ok: false });
    expect(repository(unborn).branch).toBe('HEAD');
    // prTruth required a commit and still does.
    expect(() => prTruth(unborn, { noGh: true })).toThrow();
  });

  test('outside a repository there is no identity', () => {
    const plain = tempDir('tracetoon-plain-');
    expect(gitIdentity(plain)).toBeUndefined();
    expect(() => repository(plain)).toThrow('Not inside a git repository.');
  });
});

describe('base branch detection from one ref listing', () => {
  test('committed submissions stay pinned while working-tree submissions stay fresh', () => {
    const repo = makeRepo();
    const first = repo.commit('a.ts', 'first\n', 'first change');
    const truth = prTruth(repo.root, { noGh: true });
    repo.commit('a.ts', 'second\n', 'second change');
    const pinned = submission(truth);
    expect(pinned.headSha).toBe(first);
    expect(pinned.patch).toContain('+first');
    expect(pinned.patch).not.toContain('+second');
    pinned.patch = 'caller mutation';
    expect(submission(truth).patch).toContain('+first');
    const working = { ...prTruth(repo.root, { noGh: true }), usedWorkingTree: true };
    const before = submission(working);
    writeFileSync(join(repo.root, 'a.ts'), 'uncommitted\n');
    const after = submission(working);
    expect(after.patch).toContain('+uncommitted');
    expect(after.sha256).not.toBe(before.sha256);
  });
  test('origin/HEAD wins, then main, master, trunk, develop, then main by default', () => {
    const repo = makeRepo(); // main + feature
    expect(defaultBase(repo.root)).toBe('main');
    g(repo.root, 'branch', '-m', 'main', 'master');
    expect(defaultBase(repo.root)).toBe('master');
    g(repo.root, 'branch', '-m', 'master', 'release');
    expect(defaultBase(repo.root)).toBe('main');
    const head = g(repo.root, 'rev-parse', 'HEAD');
    g(repo.root, 'update-ref', 'refs/remotes/origin/develop', head);
    g(
      repo.root,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/develop',
    );
    expect(defaultBase(repo.root)).toBe('develop');
  });

  test('each local candidate in order; origin/HEAD beats them; tags and dangling refs do not count', () => {
    const repo = makeRepo();
    const head = g(repo.root, 'rev-parse', 'HEAD');
    g(repo.root, 'branch', '-m', 'main', 'scratch');
    // Only branches count: a tag named like a candidate is not a base.
    g(repo.root, 'tag', 'main', head);
    g(repo.root, 'branch', 'develop', head);
    expect(defaultBase(repo.root)).toBe('develop');
    g(repo.root, 'branch', 'trunk', head);
    expect(defaultBase(repo.root)).toBe('trunk');
    g(repo.root, 'branch', 'main', head);
    expect(defaultBase(repo.root)).toBe('main');
    // origin/HEAD wins over an existing local main.
    g(repo.root, 'update-ref', 'refs/remotes/origin/trunk', head);
    g(repo.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(defaultBase(repo.root)).toBe('trunk');
    // An origin/HEAD pointing at a deleted branch is skipped, not returned.
    g(repo.root, 'update-ref', '-d', 'refs/remotes/origin/trunk');
    expect(defaultBase(repo.root)).toBe('main');
  });

  test('the diff base is the remote-tracking branch when it exists, else the local one', () => {
    const repo = makeRepo();
    const base = g(repo.root, 'rev-parse', 'main');
    repo.commit('a.ts', 'a', 'feature work');
    const first = prTruth(repo.root, { noGh: true });
    expect(first.mergeBase).toBe(base);
    // The merge base's commit time now comes from the base log's first entry.
    expect(first.mergeBaseTime).toBe(
      Number(g(repo.root, 'show', '-s', '--format=%ct', base)) * 1000,
    );
    expect(first.baseCommits?.[0]).toEqual({ sha: base, subject: 'base' });
    // origin/main moves ahead to include the feature's first commit.
    const ahead = g(repo.root, 'rev-parse', 'HEAD');
    g(repo.root, 'update-ref', 'refs/remotes/origin/main', ahead);
    repo.commit('b.ts', 'b', 'more work');
    const truth = prTruth(repo.root, { noGh: true });
    expect(truth.base).toBe('main');
    expect(truth.mergeBase).toBe(ahead);
    expect(truth.commits.map((c) => c.subject)).toEqual(['more work']);
    // An explicit base uses its own remote-tracking ref when one exists.
    g(repo.root, 'branch', 'stable', base);
    expect(prTruth(repo.root, { noGh: true, base: 'stable' }).mergeBase).toBe(base);
    g(repo.root, 'update-ref', 'refs/remotes/origin/stable', ahead);
    expect(prTruth(repo.root, { noGh: true, base: 'stable' }).mergeBase).toBe(ahead);
  });

  test('a base that only another remote has: remote/branch or the bare branch', () => {
    // A fork clone: the site branch exists only as upstream/gh-pages.
    const repo = makeRepo();
    const base = g(repo.root, 'rev-parse', 'main');
    g(repo.root, 'remote', 'add', 'upstream', 'https://github.com/up/proj.git');
    g(repo.root, 'update-ref', 'refs/remotes/upstream/gh-pages', base);
    repo.commit('index.html', '<p>new</p>', 'site work');
    for (const given of ['upstream/gh-pages', 'gh-pages']) {
      const truth = prTruth(repo.root, { noGh: true, base: given });
      // Kept as given, so a later command resolving it again gets the same diff.
      expect(truth.base).toBe(given);
      expect(prTruth(repo.root, { noGh: true, base: truth.base }).mergeBase).toBe(base);
      expect(truth.mergeBase).toBe(base);
      expect(truth.commits.map((c) => c.subject)).toEqual(['site work']);
    }
    // origin's copy still wins over another remote's.
    const ahead = g(repo.root, 'rev-parse', 'HEAD');
    g(repo.root, 'update-ref', 'refs/remotes/origin/gh-pages', ahead);
    expect(prTruth(repo.root, { noGh: true, base: 'gh-pages' }).mergeBase).toBe(ahead);
    // An explicit remote is honored even when origin also has the branch.
    expect(prTruth(repo.root, { noGh: true, base: 'upstream/gh-pages' }).mergeBase).toBe(
      base,
    );
  });
});
