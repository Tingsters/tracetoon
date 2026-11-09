import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyBrief } from '../src/graph/briefRender.ts';
import {
  capLimits,
  entryRow,
  failedPublishRows,
  noPassAfterCommitRow,
  remotePathRows,
} from '../src/graph/briefExtras.ts';
import { splitScriptUnits, unitRole, type PatchHunk } from '../src/graph/build.ts';
import { withGraph } from '../src/graph/engine.ts';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import { briefParts } from '../src/graph/queries.ts';

const N = (label: any, id: string, props: Record<string, any>) => ({ label, id, props });
const R = (type: any, from: [any, string], to: [any, string], props?: any) => ({
  type,
  from: { label: from[0], id: from[1] },
  to: { label: to[0], id: to[1] },
  ...(props ? { props } : {}),
});
const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const graphOf = (nodes: any[], rels: any[] = []): EvidenceGraph => ({
  schema: GRAPH_SCHEMA,
  nodes,
  rels,
  stats: { nodes: 0, rels: 0, hunks: 0, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
});
const hunkNode = (id: string, file: string, props: Record<string, any> = {}) =>
  N('Hunk', id, {
    file,
    start: 1,
    end: 9,
    added: 5,
    removed: 1,
    diff: `diff:${id.slice(1)}0-${id.slice(1)}9`,
    scope: null,
    symbols: [],
    touched: [],
    fresh: [],
    branches: 0,
    pairs: [],
    conds: [],
    tests: [],
    words: [],
    code: [],
    ...props,
  });
const fileNode = (id: string, role = 'behavior') =>
  N('File', id, { role, inPr: true, added: 5, removed: 1, unmatched: 0 });

describe('open points promoted into limits', () => {
  test('no pass after the last commit: a limit when every pass came before it', () => {
    const g = graphOf([
      N('Commit', 'abc123def4567', { subject: 's', body: null, t: t(5) }),
    ]);
    const runs = [
      { id: 'R1', kind: 'test', outcome: 'passed', t: t(3) },
      { id: 'R2', kind: 'lint', outcome: 'passed', t: t(4) },
    ];
    expect(withGraph(g, (e) => noPassAfterCommitRow(e, runs))).toEqual({
      change: null,
      kind: 'open',
      limit:
        'No passing check run was recorded after the last commit (abc123def456); the last pass (R1, test) came before it.',
    });
    // A pass after the commit closes it; no runs or no commit say nothing.
    expect(
      withGraph(g, (e) =>
        noPassAfterCommitRow(e, [
          ...runs,
          { id: 'R3', kind: 'test', outcome: 'passed', t: t(6) },
        ]),
      ),
    ).toBeUndefined();
    expect(withGraph(g, (e) => noPassAfterCommitRow(e, []))).toBeUndefined();
    expect(withGraph(graphOf([]), (e) => noPassAfterCommitRow(e, runs))).toBeUndefined();
  });

  test('a failed publishing command is an open point; other failures are not', () => {
    const g = graphOf([
      N('Session', 'h:a', {
        band: 'included',
        agent: 'Claude Code',
        failedCommands: 4,
        failedCommand: 'python',
        failedCmds: [
          'python (failed 2 of 5)',
          'gh pr (failed 1 of 1)',
          'git push (failed 1 of 3)',
          'gh auth (failed 1 of 1)',
        ],
      }),
      N('Session', 'h:b', {
        band: 'ambiguous',
        agent: 'Codex',
        failedCmds: ['npm publish (failed 1 of 1)'],
      }),
    ]);
    expect(withGraph(g, (e) => failedPublishRows(e)).map((r) => r.limit)).toEqual([
      "`gh pr` failed in the Claude Code session; whether or how the work was then published or pushed isn't recorded.",
      "`git push` failed 1 of 3 times in the Claude Code session; which attempt published or pushed what isn't recorded.",
    ]);
    // Older graphs carry only the most frequent failure.
    const old = graphOf([
      N('Session', 'h:a', {
        band: 'included',
        agent: 'Codex',
        failedCommand: 'git push',
      }),
    ]);
    expect(withGraph(old, (e) => failedPublishRows(e))).toHaveLength(1);
  });

  test('added branches in remote-call code no run names are open; local code is not', () => {
    const roles = new Map([
      ['src/net/providers.ts', 'behavior'],
      ['src/util/shell.ts', 'behavior'],
      ['scripts/upload.ts', 'behavior'],
    ]);
    const hunks = [
      {
        change: 'CH1',
        file: 'src/net/providers.ts',
        branches: 3,
        symbols: ['callOpenai', 'run'],
        words: ['fetch', 'json', 'openai'],
      },
      // Branches but no remote call.
      {
        change: 'CH2',
        file: 'src/util/shell.ts',
        branches: 4,
        symbols: ['splitCommands'],
        words: ['quote'],
      },
      // A script, not shipped source.
      {
        change: 'CH3',
        file: 'scripts/upload.ts',
        branches: 2,
        symbols: [],
        words: ['fetch'],
      },
    ];
    expect(remotePathRows(hunks, roles, [])).toEqual([
      {
        change: 'CH1',
        kind: 'open',
        limit:
          'src/net/providers.ts adds branches that call a remote service (`callOpenai`); no recorded check run shows those paths running against the real service.',
      },
    ]);
    // A run whose command names the file covers it.
    expect(
      remotePathRows(hunks, roles, [{ cmd: 'bun test tests/providers.test.ts' }]),
    ).toEqual([]);
  });

  test('at most six limits: remote rows, then the no-request row give way first', () => {
    const row = (limit: string) => ({ change: null, kind: 'open', limit });
    const existing = [1, 2, 3, 4].map((i) => row(`existing ${i}`));
    existing.splice(2, 0, row('No user request was recorded for CH2.'));
    const extra = [row('no pass'), row('gh failed')];
    const remote = [row('remote')];
    const out = capLimits(existing, extra, remote);
    expect(out.map((r) => r.limit)).toEqual([
      'existing 1',
      'existing 2',
      'existing 3',
      'existing 4',
      'no pass',
      'gh failed',
    ]);
    expect(capLimits([row('a')], [row('b')], remote)).toHaveLength(3);
  });
});

describe('the entry point', () => {
  const files = [
    fileNode('src/commands/comic.ts'),
    fileNode('src/comic/providers.ts'),
    fileNode('tests/comic.test.ts', 'tests'),
  ];
  const hunks = [
    hunkNode('H1', 'src/comic/providers.ts', {
      symbols: ['providerInfo', 'providerAvailable', 'generateImages', 'ProviderId'],
      fresh: ['providerInfo', 'generateImages'],
      touched: ['providerInfo', 'providerAvailable', 'generateImages'],
      code: ['+ export function providerInfo(id: ProviderId) {', '+ return castLine(x);'],
      branches: 9,
    }),
    hunkNode('H2', 'src/commands/comic.ts', {
      scope: 'chooseProvider',
      touched: ['castRefs'],
      code: [
        '+ const ready = PROVIDERS.filter(providerAvailable).map(providerInfo);',
        '- if (!providerAvailable(x))',
        '+ const id: ProviderId = pick(ready);',
      ],
      branches: 3,
    }),
    hunkNode('H3', 'tests/comic.test.ts', {
      code: ['+ providerInfo(a); providerAvailable(b); generateImages(c);'],
    }),
  ];
  const rels = [
    ...hunks.map((h) => R('OF', ['Hunk', h.id], ['File', String(h.props.file)])),
    ...hunks.map((h) =>
      R('HAS', ['Change', h.id === 'H2' ? 'CH2' : 'CH1'], ['Hunk', h.id]),
    ),
  ];
  const changes = [
    N('Change', 'CH1', {
      key: 'dir:src',
      files: [],
      roles: [],
      symbols: [],
      added: 1,
      removed: 0,
      branches: 0,
    }),
    N('Change', 'CH2', {
      key: 'dir:cmd',
      files: [],
      roles: [],
      symbols: [],
      added: 1,
      removed: 0,
      branches: 0,
    }),
  ];
  const headRef = N('HeadRef', 'HR1', {
    kind: 'most referenced',
    term: 'providerInfo',
    fresh: true,
    definedIn: ['src/comic/providers.ts'],
    refs: ['src/commands/comic.ts', 'src/commands/doctor.ts'],
    files: 2,
    count: 6,
  });

  test("the source function calling other files' changed functions, not the most referenced helper", () => {
    const row = withGraph(graphOf([...files, ...hunks, ...changes, headRef], rels), (g) =>
      entryRow(g),
    );
    // Types (`ProviderId`), constants and removed lines are not calls; tests are not entries.
    expect(row).toEqual({
      kind: 'entry',
      fact: 'Start at `chooseProvider` in src/commands/comic.ts: its changed lines call `providerAvailable`, `providerInfo` (from src/comic/providers.ts).',
      cites: ['CH2', 'diff:20-29'],
    });
  });

  test('with no function calling across files, the most-referenced source symbol', () => {
    const lone = hunks.filter((h) => h.id !== 'H2');
    const row = withGraph(
      graphOf(
        [...files, ...lone, ...changes, headRef],
        rels.filter((r) => !JSON.stringify(r).includes('"H2"')),
      ),
      (g) => entryRow(g),
    );
    expect(row?.fact).toBe(
      'Start at `providerInfo` in src/comic/providers.ts: the changed symbol most named elsewhere (2 other file(s)).',
    );
  });

  test('the brief carries it as a process row and the head scan stops calling itself the place to start', () => {
    const b = withGraph(graphOf([...files, ...hunks, ...changes, headRef], rels), (g) =>
      briefParts(g),
    );
    const process = b.sections.find((s) => s.title === 'process')!.rows;
    expect(process.find((r) => r.kind === 'entry')?.fact).toContain('`chooseProvider`');
    expect(b.sections.find((s) => s.title === 'headScan')!.rows[0]!.kind).toBe(
      'most referenced',
    );
  });
});

describe('change units split by file role', () => {
  const h = (id: string, file: string, p: Partial<PatchHunk> = {}): PatchHunk => ({
    id,
    file,
    start: 1,
    end: 2,
    added: 2,
    removed: 0,
    diff: `diff:${id}`,
    symbols: [],
    touched: [],
    branches: 0,
    fresh: [],
    pairs: [],
    dropped: [],
    conds: [],
    tests: [],
    words: [],
    code: [],
    lines: new Set(),
    gone: new Set(),
    ...p,
  });
  const role = (f: string) =>
    f.startsWith('tests/') ? 'tests' : f.endsWith('.json') ? 'config' : 'behavior';

  test('roles: shipped source, scripts, tests, other', () => {
    expect(unitRole('src/a.ts', 'behavior')).toBe('src');
    expect(unitRole('scripts/eval.ts', 'behavior')).toBe('scripts');
    expect(unitRole('tests/a.test.ts', 'tests')).toBe('tests');
    expect(unitRole('README.md', 'docs')).toBe('other');
  });

  test('an unrelated script leaves the unit; each test goes with the code it names', () => {
    const groups = new Map([
      [
        'commit:abc',
        [
          h('H1', 'src/correlate.ts', {
            touched: ['makesCommit', 'commitMoments'],
            lines: new Set(['return makesCommit(cmd)']),
          }),
          h('H2', 'scripts/eval-summaries.ts', {
            lines: new Set(["base: 'c62818f^1',"]),
            words: ['base', 'head'],
          }),
          h('H3', 'tests/units.test.ts', {
            tests: ['commit detection'],
            words: ['commit', 'moments', 'detection'],
          }),
          h('H4', 'tests/eval.test.ts', {
            tests: ['eval summaries pin cases'],
            words: ['eval', 'summaries'],
          }),
          h('H5', 'tests/other.test.ts', { words: ['report', 'html'] }),
          h('H6', 'package.json'),
        ],
      ],
    ]);
    splitScriptUnits(groups, role);
    expect([...groups.keys()]).toEqual(['commit:abc', 'commit:abc|scripts']);
    expect(groups.get('commit:abc')!.map((x) => x.file)).toEqual([
      'src/correlate.ts',
      'tests/units.test.ts',
      'tests/other.test.ts', // a tie stays with the source
      'package.json',
    ]);
    expect(groups.get('commit:abc|scripts')!.map((x) => x.file)).toEqual([
      'scripts/eval-summaries.ts',
      'tests/eval.test.ts',
    ]);
  });

  test('a script that calls the changed source stays in the unit', () => {
    const groups = new Map([
      [
        'prompt:S1',
        [
          h('H1', 'src/shell.ts', { fresh: ['splitCommands'] }),
          h('H2', 'scripts/check.ts', {
            lines: new Set(['const parts = splitCommands(line);']),
          }),
        ],
      ],
    ]);
    splitScriptUnits(groups, role);
    expect([...groups.keys()]).toEqual(['prompt:S1']);
  });
});

describe('published bodies carry no brief refs', () => {
  const b = {
    sections: [
      { title: 'changes', columns: ['change'], rows: [{ change: 'CH1', where: [] }] },
      {
        title: 'requests',
        columns: ['ref'],
        rows: [{ ref: 'S2', kind: 'user request' }],
      },
    ],
  } as any;
  test('diff ranges, sessions, space-separated and single refs are stripped', () => {
    const body = [
      'Commands are split before matching. [CH1, diff:660-684]',
      'The user asked for it. [S2]',
      'Both rows say so. [CH1 S2]',
      'A session ref too. [S2; h:9b263cce4191]',
      'A [link](https://example.com) stays, as does [a note].',
    ].join('\n');
    const r = applyBrief(body, b);
    expect(r.text).not.toMatch(/\[(CH1|S2|diff:|h:)/);
    expect(r.text).toContain('Commands are split before matching.\n');
    expect(r.text).toContain('[link](https://example.com)');
    expect(r.text).toContain('[a note]');
    // Patch ranges and session ids are citable, not unknown refs.
    expect(r.unknownRefs).toEqual([]);
  });
  test('without a brief, tags are still stripped', () => {
    expect(applyBrief('It works. [CH1, diff:1-2]\n', undefined).text).toBe('It works.\n');
  });
});

test('drafting guidance: word target, one motive sentence, the entry row', () => {
  const drafting = readFileSync(
    resolve(import.meta.dir, '../plugin/skills/tracetoon/references/drafting.md'),
    'utf8',
  );
  expect(drafting).toContain('target 250–400 words');
  expect(drafting).toMatch(/one motive sentence at most: never a list/);
  expect(drafting).toMatch(/`entry` process row names/);
});
