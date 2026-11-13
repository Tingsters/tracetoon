import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILT, blockingBranches, releaseCommit } from '../.github/scripts/release-branch.ts';
import { git, run } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';

// The skill archive is made with Python's zipfile, as in the update tests.
const canRun = process.platform !== 'win32' && run('python3', ['--version']).ok;

const g = (cwd: string, ...args: string[]) => {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A tagged source commit with VERSION, as main carries it (no build outputs). */
function tagRelease(repo: ReturnType<typeof makeRepo>, version: string, note: string) {
  repo.commit('plugin/skills/tracetoon/VERSION', `${version}\n`, `Prepare ${version}`);
  repo.commit('src/cli.ts', `// ${note}\n`, note);
  g(repo.root, 'tag', `v${version}`);
}

/** A verified skill archive, as the release workflow downloads it. */
function skillZip(version: string, buildId: string): string {
  const dir = tempDir('tracetoon-skill-');
  const skill = join(dir, 'tracetoon');
  mkdirSync(join(skill, 'dist'), { recursive: true });
  writeFileSync(join(skill, 'VERSION'), `${version}\n`);
  writeFileSync(join(skill, 'build.json'), JSON.stringify({ buildId }) + '\n');
  writeFileSync(join(skill, 'dist', 'tracetoon.mjs'), `// bundle ${version}\n`);
  const zip = join(dir, 'tracetoon-skill.zip');
  expect(run('python3', ['-m', 'zipfile', '-c', zip, 'tracetoon'], { cwd: dir }).ok).toBe(true);
  return zip;
}

describe.skipIf(!canRun)('release branch commits', () => {
  test('each release adds only the bundle on top of its tag and fast-forwards the branch', () => {
    const repo = makeRepo();
    tagRelease(repo, '1.0.0', 'first');
    const first = releaseCommit({
      repo: repo.root,
      zip: skillZip('1.0.0', 'build-1'),
      tag: 'v1.0.0',
      version: '1.0.0',
      buildId: 'build-1',
    });
    expect(first.created).toBe(true);
    // The first release has the tag as its only parent.
    expect(g(repo.root, 'rev-list', '--parents', '-n', '1', first.commit).split(' ')).toEqual([
      first.commit,
      g(repo.root, 'rev-parse', 'v1.0.0'),
    ]);
    expect(g(repo.root, 'diff', '--name-only', 'v1.0.0', first.commit).split('\n')).toEqual([
      ...BUILT,
    ]);
    expect(g(repo.root, 'show', `${first.commit}:${BUILT[0]}`)).toContain('build-1');

    tagRelease(repo, '1.0.1', 'second');
    const second = releaseCommit({
      repo: repo.root,
      zip: skillZip('1.0.1', 'build-2'),
      tag: 'v1.0.1',
      version: '1.0.1',
      buildId: 'build-2',
      previous: first.commit,
    });
    // Previous release head first, then the tag: a plain push fast-forwards.
    const [, p1, p2] = g(repo.root, 'rev-list', '--parents', '-n', '1', second.commit).split(' ');
    expect([p1, p2]).toEqual([first.commit, g(repo.root, 'rev-parse', 'v1.0.1')]);
    expect(git(repo.root, ['merge-base', '--is-ancestor', first.commit, second.commit]).ok).toBe(true);
    expect(git(repo.root, ['merge-base', '--is-ancestor', 'v1.0.1', second.commit]).ok).toBe(true);
    expect(g(repo.root, 'diff', '--name-only', 'v1.0.1', second.commit).split('\n')).toEqual([
      ...BUILT,
    ]);
    // The tag's own tree (main) never gains the bundle.
    expect(git(repo.root, ['cat-file', '-e', `v1.0.1:${BUILT[1]}`]).ok).toBe(false);

    // Re-running the workflow for the same release changes nothing.
    const again = releaseCommit({
      repo: repo.root,
      zip: skillZip('1.0.1', 'build-2'),
      tag: 'v1.0.1',
      version: '1.0.1',
      buildId: 'build-2',
      previous: second.commit,
    });
    expect(again).toEqual({ commit: second.commit, created: false });
  });

  test('refuses an archive from another build or version', () => {
    const repo = makeRepo();
    tagRelease(repo, '1.0.0', 'first');
    const args = { repo: repo.root, tag: 'v1.0.0', version: '1.0.0', buildId: 'build-1' };
    expect(() => releaseCommit({ ...args, zip: skillZip('1.0.0', 'other-build') })).toThrow(
      /not the promoted build-1/,
    );
    expect(() => releaseCommit({ ...args, zip: skillZip('1.0.9', 'build-1') })).toThrow(
      /archive is 1.0.9/,
    );
    expect(() =>
      releaseCommit({ ...args, version: '2.0.0', zip: skillZip('2.0.0', 'build-1') }),
    ).toThrow(/carries VERSION 1.0.0/);
  });

  test('refuses a tag that still commits the build outputs', () => {
    // An old-style main tracked the bundle; the release commit must add exactly the two files.
    const repo = makeRepo();
    repo.commit(BUILT[1], '// bundle 1.0.0\n', 'committed bundle');
    tagRelease(repo, '1.0.0', 'first');
    expect(() =>
      releaseCommit({
        repo: repo.root,
        zip: skillZip('1.0.0', 'build-1'),
        tag: 'v1.0.0',
        version: '1.0.0',
        buildId: 'build-1',
      }),
    ).toThrow(/may only add/);
  });
});

test('branches under release/ are reported as blocking the release branch', () => {
  // `git ls-remote --heads` output: a candidate branch named release/… blocks `release`.
  const listing = [
    '1b8ffede56a7a0d6224bd44ba98e3e58b4347927\trefs/heads/release/rc22-candidate',
    'a08c5e4925aa74f32e20e6765369e2fb956aba19\trefs/heads/release/rc25-candidate',
    'f0a3cfed946621e38d08a5e49d0cd56a0052a0b6\trefs/heads/release',
    '8ad49fea9817aaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/releases-old',
  ].join('\n');
  expect(blockingBranches(listing)).toEqual(['release/rc22-candidate', 'release/rc25-candidate']);
  expect(blockingBranches('')).toEqual([]);
});
