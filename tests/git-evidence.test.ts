import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  commitMoments,
  formerRootsOf,
  matchSession,
  prLineIndex,
  windowFor,
} from '../src/correlate/correlate.ts';
import type { PrTruth } from '../src/git/pr.ts';
import type { TraceRecord, TraceSession } from '../src/trace/types.ts';

const root = resolve('/work/target');
const other = resolve('/work/starting-repo');
const own = { sha: 'bbbbbbb0123456789', subject: 'Add the current feature' };
const base = { sha: 'aaaaaaa0123456789', subject: 'Start the older project' };
const command = (
  cmd: string,
  output = '',
  cwd = root,
): Extract<TraceRecord, { kind: 'command' }> => ({
  kind: 'command',
  cmd,
  output,
  cwd,
  ts: '2026-10-30T12:00:00Z',
});
const truth: PrTruth = {
  toplevel: root,
  gitDir: join(root, '.git'),
  roots: [root],
  head: 'feature',
  base: 'main',
  mergeBase: base.sha,
  commits: [
    {
      ...own,
      authorTime: Date.parse('2026-10-30T12:00:01Z'),
      commitTime: Date.parse('2026-10-30T12:00:01Z'),
      trailers: {},
    },
  ],
  files: [
    { path: 'src/value.ts', added: ['export const currentFeature = 42;'], removed: [] },
  ],
  usedWorkingTree: false,
  dirty: false,
};

describe('commit creation versus history inspection', () => {
  test('an unbounded log after quiet commits cannot credit the older base commit', () => {
    const records = [
      command(
        `git commit -qm "${own.subject}" && git log --oneline`,
        `${own.sha} ${own.subject}\n${base.sha} ${base.subject}`,
      ),
    ];
    expect([...commitMoments(records, [base, own], [root]).keys()]).toEqual([own.sha]);
  });

  test('a subject in the message body or another command is not a commit message', () => {
    for (const cmd of [
      `git commit -qm "${own.subject}\n\nAfter ${base.subject}"`,
      `git commit -qm "${own.subject}" && echo "${base.subject}"`,
    ])
      expect([...commitMoments([command(cmd)], [base, own], [root]).keys()]).toEqual([
        own.sha,
      ]);
  });

  test('unbounded output with no literal message leaves ownership unknown', () => {
    const record = command(
      'git commit -q -F message.txt && git log --oneline',
      `${own.sha} new\n${base.sha} old`,
    );
    expect(commitMoments([record], [own, base], [root]).size).toBe(0);
  });

  test('a single HEAD confirmation after a quiet commit still counts', () => {
    for (const read of [
      'git log --oneline -1',
      'git log --oneline --max-count=1 HEAD',
      'git rev-parse HEAD',
    ]) {
      expect(
        commitMoments(
          [command(`git commit -q -F message.txt && ${read}`, own.sha)],
          [own],
          [root],
        ).size,
      ).toBe(1);
    }
    for (const read of ['git log --oneline -1 main', 'git log --oneline --all -1']) {
      expect(
        commitMoments(
          [command(`git commit -q -F message.txt && ${read}`, base.sha)],
          [base],
          [root],
        ).size,
      ).toBe(0);
    }
    expect(
      commitMoments(
        [command('git commit -q -F message.txt; git log --oneline -1', base.sha)],
        [base],
        [root],
      ).size,
    ).toBe(0);
  });

  test('native commit output proves creation even if a later check fails', () => {
    expect(
      commitMoments(
        [
          {
            ...command(
              'git commit -F message.txt && bun test',
              `[feature ${own.sha}] new`,
            ),
            isError: true,
          },
        ],
        [own],
        [root],
      ).size,
    ).toBe(1);
  });

  test('pulling or fast-forwarding existing commits does not create them', () => {
    for (const cmd of ['git pull --ff-only', 'git merge --ff-only origin/main']) {
      expect(
        commitMoments(
          [command(cmd, `Updating 1234567..${own.sha}\nFast-forward`)],
          [own],
          [root],
        ).size,
      ).toBe(0);
    }
  });

  test('output from multiple repositories is ambiguous, while literal messages stay scoped', () => {
    const record = command(
      `git -C "${root}" commit -q -F msg && git -C "${other}" log --oneline -1`,
      own.sha,
    );
    expect(commitMoments([record], [own], [root]).size).toBe(0);
    const literal = command(
      `git -C "${other}" commit -qm "${own.subject}" && git -C "${root}" status`,
    );
    expect(commitMoments([literal], [own], [root]).size).toBe(0);
  });

  test('dynamic or alternative directories do not establish commit ownership', () => {
    for (const cmd of [
      `cd "$project" && git commit -qm "${own.subject}"`,
      `cd "${root}" || cd "${other}"; git commit -qm "${own.subject}"`,
    ]) {
      const record = command(cmd, `[feature ${own.sha}] new`);
      expect(commitMoments([record], [own], [root]).size).toBe(0);
      expect(formerRootsOf([record], truth)).toEqual([]);
    }
  });
});

describe('repository ownership', () => {
  test('Git targets do not turn the starting repository into a former worktree', () => {
    for (const cmd of [
      `cd "${root}" && git commit -qm "${own.subject}" && git log --oneline`,
      `mkdir -p "${root}" && cd "${root}" && git commit -qm "${own.subject}"`,
      `git -C "${root}" commit -qm "${own.subject}"`,
      `Set-Location -LiteralPath "${root}"; git log --oneline -1`,
      `pushd "${root}" && git log --oneline -1 && popd`,
    ])
      expect(formerRootsOf([command(cmd, `${own.sha} new`, other)], truth)).toEqual([]);
  });

  test('a quoted, removed worktree is recovered from the effective Git directory', () => {
    const gone = resolve('/work/gone worktree');
    for (const cmd of [
      `cd "${gone}" && git log --oneline -1`,
      `git -C "${gone}" log --oneline -1`,
    ]) {
      expect(formerRootsOf([command(cmd, `${own.sha} new`, other)], truth)).toEqual([
        gone,
      ]);
    }
    expect(formerRootsOf([command('echo ' + own.sha, own.sha, gone)], truth)).toEqual([]);
    expect(formerRootsOf([command('git status', own.sha, gone)], truth)).toEqual([]);
  });

  test('tilde and Git Bash drive spellings resolve to the Git target', () => {
    const homeRoot = join(homedir(), 'matching-target');
    expect(
      formerRootsOf(
        [command('cd ~/matching-target && git log --oneline -1', own.sha, other)],
        { ...truth, roots: [homeRoot] },
      ),
    ).toEqual([]);
    if (process.platform === 'win32') {
      const msys = root
        .replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase());
      expect(
        formerRootsOf(
          [command(`cd "${msys}" && git log --oneline -1`, own.sha, other)],
          truth,
        ),
      ).toEqual([]);
    }
  });

  test('absolute edit targets win over a conflicting cwd and identical branch names', () => {
    const records: TraceRecord[] = [
      {
        kind: 'edit',
        file: join(root, 'src/value.ts'),
        added: truth.files[0]!.added,
        removed: [],
        cwd: other,
        branch: 'feature',
      },
      {
        kind: 'edit',
        file: join(other, 'src/value.ts'),
        added: truth.files[0]!.added,
        removed: [],
        cwd: root,
        branch: 'feature',
      },
    ];
    const session: TraceSession = {
      agent: 'claude-code',
      sessionId: 'test',
      source: 'synthetic',
      records,
      unknownTypes: {},
      warnings: [],
    };
    const result = matchSession(session, truth, windowFor(truth), prLineIndex(truth));
    expect(result.kept).toEqual([records[0]!]);
    expect(result.signals.matchedLines).toBe(1);
    expect(result.roots).toEqual([root]);
  });

  test('a branch command quoted in a commit message is not branch activity', () => {
    const session: TraceSession = {
      agent: 'claude-code',
      sessionId: 'quoted-branch',
      source: 'synthetic',
      records: [
        command('git commit -qm "Explain this example:\ngit push origin feature"'),
      ],
      unknownTypes: {},
      warnings: [],
    };
    expect(
      matchSession(session, truth, windowFor(truth), prLineIndex(truth)).signals.branch,
    ).toBe(false);
  });
});
