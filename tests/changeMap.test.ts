/** The drafter's local change map: advisory coverage and grouping checks. */
import { describe, expect, test } from 'bun:test';
import { checkChangeMap, refPath } from '../src/digest/changeMap.ts';

const file = (path: string, role = 'behavior', added = 10) => ({ path, role, added });
const group = (paths: string[], kind = 'behavior', idea = 'Quote-aware splitting') => ({
  idea,
  behavior: 'Commands with quoted spaces stay one argument.',
  kind,
  paths,
});
const files = [
  file('src/split.ts'),
  file('src/run.ts'),
  file('tests/split.test.ts', 'tests'),
];
const changedPaths = files.map((f) => f.path);
const check = (raw: unknown, exists = (_: string) => false) =>
  checkChangeMap({ raw, files, changedPaths, exists });
const kinds = (raw: unknown, exists?: (p: string) => boolean) =>
  check(raw, exists).map((f) => f.kind);

describe('change map checks', () => {
  test('several behaviors within one file can carry separate patch evidence', () => {
    const map = {
      groups: [
        {
          ...group(['src/split.ts', 'src/run.ts']),
          behaviorChecks: [
            { behavior: 'Skip quoted separators.', evidence: ['diff:1'] },
            { behavior: 'Resume after a heredoc.', evidence: ['diff:2-3'] },
          ],
        },
      ],
    };
    const input = {
      raw: map,
      files,
      changedPaths,
      exists: () => false,
      patch: '+quoted\n+heredoc\n+resume',
    };
    expect(checkChangeMap(input)).toEqual([]);
    map.groups[0]!.behaviorChecks[1]!.evidence = ['diff:99'];
    expect(checkChangeMap(input)[0]?.kind).toBe('invalid');
    map.groups[0]!.behaviorChecks[1]!.evidence = ['digest:R1'];
    expect(checkChangeMap(input)[0]?.kind).toBe('invalid');
  });

  test('a map covering every behavior file is clean', () => {
    expect(
      check({
        groups: [
          group(['src/split.ts', 'src/run.ts']),
          group(['tests/split.test.ts'], 'test', 'Regression test'),
        ],
      }),
    ).toEqual([]);
  });

  test('a behavior file left out is named, so the description can be checked for it', () => {
    const findings = check({ groups: [group(['src/split.ts'])] });
    expect(findings.map((f) => f.kind)).toEqual(['uncovered']);
    expect(findings[0]!.text).toContain('src/run.ts');
  });

  test('paths outside the diff are flagged; example refs may cite unchanged code that exists', () => {
    expect(
      kinds({ groups: [group(['src/split.ts', 'src/run.ts', 'src/old.ts'])] }),
    ).toEqual(['unknown-path']);
    const map = {
      groups: [group(['src/split.ts', 'src/run.ts'])],
      example: { refs: ['src/split.ts:4-9', 'src/caller.ts:12', 'src/gone.ts:3'] },
    };
    const findings = check(map, (p) => p === 'src/caller.ts');
    expect(findings.map((f) => f.kind)).toEqual(['unknown-path']);
    expect(findings[0]!.text).toContain('src/gone.ts:3');
  });

  test('many separate behavior ideas suggest splitting the PR', () => {
    const groups = ['a', 'b', 'c', 'd'].map((x) =>
      group(['src/split.ts', 'src/run.ts'], 'behavior', x),
    );
    expect(kinds({ groups })).toEqual(['split']);
    expect(kinds({ groups: groups.slice(0, 3) })).toEqual([]);
  });

  test('a malformed or unreadable map is reported, not thrown', () => {
    expect(kinds({ groups: [] })).toEqual(['invalid']);
    expect(
      kinds({ groups: [{ idea: 'x', kind: 'other', paths: ['src/a.ts'] }] }),
    ).toEqual(['invalid']);
    expect(kinds(null)).toEqual(['invalid']);
  });

  test('no map: suggested only for a change large enough to need grouping', () => {
    expect(check(undefined)).toEqual([]);
    const large = checkChangeMap({
      raw: undefined,
      files: [file('src/a.ts', 'behavior', 400)],
      changedPaths: ['src/a.ts'],
      exists: () => false,
    });
    expect(large.map((f) => f.kind)).toEqual(['missing']);
  });
});

describe('change map refs', () => {
  test.each([
    ['src/split.ts:4-9', 'src/split.ts'],
    ['src/split.ts:4,12-20', 'src/split.ts'],
    ['src/split.ts', 'src/split.ts'],
    ['origin/main:src/split.ts:121', 'src/split.ts'],
    ['feat/comic-setting:src/split.ts:36-41', 'src/split.ts'],
    ['main:src/split.ts:3', 'src/split.ts'],
    ['3f303e3:src/split.ts', 'src/split.ts'],
    ['fix-x:src/split.ts:5', 'src/split.ts'],
    ['v1.2.0:src/split.ts', 'src/split.ts'],
    ['origin/release-1.2:src/split.ts:7', 'src/split.ts'],
    ['origin/main~1:src/split.ts', 'src/split.ts'],
    ['src/split.ts:300-310 (old behavior)', 'src/split.ts'],
  ])('%s names %s', (ref, path) => {
    expect(refPath(ref)).toBe(path);
  });

  test('refs in any of those forms count as found, and docs groups are accepted', () => {
    const map = {
      groups: [
        group(['src/split.ts', 'src/run.ts']),
        group(['README.md'], 'docs', 'Docs'),
      ],
      example: {
        refs: ['origin/main:src/split.ts:4,12-20', 'src/run.ts:300-310 (head)'],
      },
    };
    expect(
      checkChangeMap({
        raw: map,
        files,
        changedPaths: [...changedPaths, 'README.md'],
        exists: () => false,
      }),
    ).toEqual([]);
  });
});
