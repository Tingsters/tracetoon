/**
 * The advisory claim check on hard cases: truthful claims it must not flag as
 * problems, and false or unsupported ones it should catch.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, TraceDigest } from '../src/digest/build.ts';
import { checkClaims, sentences, type ClaimInput } from '../src/digest/claims.ts';
import { tempDir } from './helpers.ts';

const run = (over: Partial<Run>): Run => ({
  id: 'R1',
  t: '2026-10-24T01:00:00Z',
  cmd: 'bun test',
  kind: 'test',
  outcome: 'passed',
  basis: 'exit status',
  summary: ['96 pass', '0 fail'],
  revision: 'no later edits seen',
  ...over,
});

function digest(
  runs: Run[],
  extra: Partial<TraceDigest['sessions'][number]> = {},
): ClaimInput['digest'] {
  return {
    pr: {
      base: 'main',
      head: 'feature',
      mergeBase: 'abc',
      usedWorkingTree: false,
      commits: [],
    },
    files: [
      {
        path: 'src/export.ts',
        role: 'behavior',
        added: 5,
        removed: 1,
        sessions: [],
        unmatchedLines: 0,
      },
    ],
    sessions: [
      {
        ref: 'h:1',
        agent: 'Claude Code',
        models: [],
        span: {},
        usage: null,
        score: 0.9,
        band: 'included',
        reasons: [],
        prompts: [],
        delegations: [],
        commitsMade: [],
        plans: [],
        artifacts: [],
        decisions: [],
        commands: [],
        runs,
        milestones: [],
        filesEdited: [],
        discardedEdits: 0,
        unknownRecordTypes: {},
        ...extra,
      },
    ],
  } as ClaimInput['digest'];
}

const check = (body: string, d: ClaimInput['digest'], more: Partial<ClaimInput> = {}) =>
  checkClaims({ title: 'Keep CSV headers on empty exports', body, digest: d, ...more });
const states = (f: ReturnType<typeof check>) => f.map((x) => `${x.kind}:${x.state}`);

describe('sentences', () => {
  test('splits prose but not version numbers, and skips code blocks', () => {
    expect(
      sentences(
        'Bumps to 1.0.0. Adds a test.\n\n```\nbun test\n```\n- `bun test` passed.',
      ),
    ).toEqual(['Bumps to 1.0.0.', 'Adds a test.', '`bun test` passed.']);
  });
});

describe('verification claims', () => {
  test('a failing run on later work (after the PR head and more edits) does not contradict the PR', () => {
    const f = checkClaims({
      title: 't',
      body: 'Before the commit, `bun test` passed (96 pass, 0 fail).',
      digest: digest([
        run({ id: 'R1', revision: 'before later edits' }),
        run({
          id: 'R2',
          t: '2026-10-24T03:00:00Z',
          outcome: 'failed',
          summary: ['5 pass', '1 fail'],
          revision: 'after later work',
        }),
      ]),
    });
    expect(f[0]?.state).toBe('observed');
  });

  test('a passing run with no later edits: observed', () => {
    const f = check('`bun test` passed (96 pass, 0 fail).', digest([run({})]));
    expect(states(f)).toEqual(['verification:observed']);
  });

  test('the last run failed: contradicted, and says which run', () => {
    const f = check(
      'All tests pass.',
      digest([
        run({}),
        run({
          id: 'R2',
          t: '2026-10-24T02:00:00Z',
          outcome: 'failed',
          summary: ['95 pass', '1 fail'],
        }),
      ]),
    );
    expect(f[0]).toMatchObject({ state: 'contradicted' });
    expect(f[0]!.detail).toContain('R2');
  });

  test('a run before later edits is observed, with a note to say so', () => {
    const f = check('Tests pass.', digest([run({ revision: 'before later edits' })]));
    expect(f[0]!.state).toBe('observed');
    expect(f[0]!.detail).toContain('before the final edits');
  });

  test('hard case: a test run, then a metadata-only commit: still observed', () => {
    // Committing doesn't edit files, so the run is the latest evidence.
    const d = digest([run({})]);
    d.pr.commits.push({ sha: 'def', subject: 'chore: bump version', trailers: {} });
    expect(states(check('`bun test` passed.', d))).toEqual(['verification:observed']);
  });

  test('hard case: tests ran on an uncommitted fix: observed, with a note', () => {
    const d = digest([run({})]);
    d.pr.dirty = true;
    expect(check('`bun test` passed.', d)[0]!.detail).toContain('Uncommitted changes');
  });

  test('hard case: a truthful manual check absent from the logs is author-reported, not a problem', () => {
    const f = check(
      'Checked the export in Safari by hand (reported by the author).',
      digest([]),
    );
    expect(f.every((x) => x.state !== 'contradicted')).toBe(true);
    const viaNotes = check('The export was verified in Safari and Firefox.', digest([]), {
      authorText: 'I verified the export in Safari and Firefox myself.',
    });
    expect(states(viaNotes)).toEqual(['verification:author-reported']);
  });

  test('nothing captured: not established, never "false"', () => {
    const f = check('All tests pass.', digest([]));
    expect(f[0]!.state).toBe('not established');
    expect(f[0]!.detail).not.toMatch(/not (run|tested)\b/i);
  });

  test('a count no run shows: not established', () => {
    const f = check('`bun test`: 120 tests pass.', digest([run({})]));
    expect(f[0]!.state).toBe('not established');
    expect(f[0]!.detail).toContain('120');
  });

  test('overreach: "no regressions" is more than any run shows', () => {
    expect(check('No regressions.', digest([run({})]))[0]!.state).toBe('not established');
  });

  test('ordinary sentences are not claims', () => {
    expect(
      check(
        'Writes the header before the rows, so empty exports keep their columns.',
        digest([run({})]),
      ),
    ).toEqual([]);
  });
});

describe('attribution', () => {
  const withDecision = digest([], {
    decisions: [
      {
        id: 'D1',
        text: 'Where should the comic go?',
        questions: [
          {
            question: 'Where should the comic go?',
            options: ['After the description', 'At the top'],
            answer: 'After the description',
            ownWords: false,
          },
        ],
      },
    ],
  });

  test('a recorded choice supports "the user chose…"', () => {
    expect(
      states(
        check('The user chose to put the comic after the description.', withDecision),
      ),
    ).toEqual(['attribution:observed']);
  });

  test('"rejected" needs more than an unpicked option', () => {
    const f = check(
      'The user rejected putting the comic at the top of the description.',
      withDecision,
    );
    expect(f[0]!.state).toBe('not established');
  });

  test('nothing recorded: not established', () => {
    expect(check('The user decided to keep the old API.', digest([]))[0]!.state).toBe(
      'not established',
    );
  });
});

describe('references', () => {
  const root = tempDir('tracetoon-claims-');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'api.ts'), 'export {};\n');

  test('hard case: a correct reference to a rejected alternative is not flagged', () => {
    const f = check(
      'Considered `src/cache/redis.ts`, but kept the in-memory store.',
      digest([]),
      { root },
    );
    expect(f).toEqual([]);
  });

  test('hard case: a false claim using a real filename outside the diff is noted', () => {
    const f = check('Adds rate limiting to `src/api.ts`.', digest([]), { root });
    expect(f[0]).toMatchObject({ kind: 'reference', state: 'not established' });
    expect(f[0]!.detail).toContain("isn't changed in this PR");
  });

  test('a file in the diff is fine; a missing one is a possible stale reference', () => {
    expect(check('The fix is in `src/export.ts`.', digest([]), { root })).toEqual([]);
    expect(
      check('See `src/gone.ts` for details.', digest([]), { root })[0]!.detail,
    ).toContain('stale');
  });
});

describe('false alarms found on real descriptions', () => {
  const root = tempDir('tracetoon-claims2-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'eval-summaries.ts'), '');
  writeFileSync(
    join(root, 'scripts', 'render.ts'),
    "writeFileSync(join(dir, 'evidence-notes.md'), notes);",
  );
  // Bare filenames are looked up among the repository's tracked files.
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });

  test('a field name is not a file', () => {
    expect(
      check(
        'Commits keep their time, and `pr.dirty` flags uncommitted changes.',
        digest([]),
        { root },
      ),
    ).toEqual([]);
  });

  test('mentioning a real file by its bare name, without claiming to change it, is fine', () => {
    expect(
      check('Printing `eval-summaries.ts`, which contains a SHA, did both.', digest([]), {
        root,
      }),
    ).toEqual([]);
  });

  test('a sentence about claims, or a quoted example, is not itself a claim', () => {
    const failed = digest([run({ outcome: 'failed', summary: ['1 fail'] })]);
    expect(
      check(
        'At render, each sentence that claims a check passed is compared with the digest.',
        failed,
        { root },
      ),
    ).toEqual([]);
    expect(
      check(
        'A contradicted claim, such as "tests pass" when the last run failed, is shown.',
        failed,
        { root },
      ),
    ).toEqual([]);
  });

  test('a file the code names, described without a change, gets no note', () => {
    expect(
      check('Context the author adds goes into `evidence-notes.md`.', digest([]), {
        root,
      }),
    ).toEqual([]);
  });

  test("a file the code writes (a run-folder output) isn't a stale reference", () => {
    expect(
      check('Render also writes `evidence-notes.md`, an outline.', digest([]), { root }),
    ).toEqual([]);
  });
});
