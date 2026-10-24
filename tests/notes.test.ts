/** Optional notes beside the draft, and the outline for authors who write it themselves. */
import { describe, expect, test } from 'bun:test';
import type { Run, TraceDigest } from '../src/digest/build.ts';
import { contextNotes, evidenceNotes } from '../src/digest/notes.ts';

const run = (over: Partial<Run> = {}): Run => ({
  id: 'R1',
  cmd: 'bun test',
  kind: 'test',
  outcome: 'passed',
  basis: 'exit status',
  summary: ['12 pass', '0 fail'],
  revision: 'no later edits seen',
  ...over,
});

function digest(
  over: {
    runs?: Run[];
    files?: TraceDigest['files'];
    unmatched?: number;
    decided?: boolean;
  } = {},
) {
  return {
    pr: { base: 'main', head: 'f', mergeBase: 'a', usedWorkingTree: false, commits: [] },
    stats: {
      filesChanged: 1,
      added: 10,
      removed: 0,
      evidenceLines: 10,
      agentMatchedPct: 100 - (over.unmatched ?? 0),
      unmatchedPct: over.unmatched ?? 0,
      commitsMadeInSessions: 1,
      commits: 1,
    },
    files: over.files ?? [
      {
        path: 'src/a.ts',
        role: 'behavior',
        added: 10,
        removed: 0,
        sessions: [],
        unmatchedLines: 0,
      },
    ],
    sessions: [
      {
        band: 'included',
        prompts: [{ id: 'S1', text: 'Keep headers on empty exports', ledToEdits: true }],
        decisions: over.decided
          ? [
              {
                id: 'D1',
                text: 'q',
                questions: [
                  {
                    question: 'Write the header first?',
                    options: ['Yes', 'No'],
                    answer: 'Yes',
                    ownWords: false,
                  },
                ],
              },
            ]
          : [],
        plans: [],
        runs: over.runs ?? [],
      },
    ],
  } as unknown as TraceDigest;
}

const topics = (n: ReturnType<typeof contextNotes>) => n.map((x) => x.topic);

describe('optional context notes', () => {
  test('nothing captured: a validation note that never says "not tested"', () => {
    const n = contextNotes(
      digest(),
      'Writes the header first so that empty exports keep their columns.',
    );
    expect(topics(n)).toEqual(['validation']);
    expect(n[0]!.text).toContain('If you ran checks elsewhere');
    expect(n[0]!.text).not.toMatch(/\bnot (been )?tested\b/i);
  });

  test('a passing run before the final edits: suggest re-running or saying so', () => {
    const n = contextNotes(
      digest({ runs: [run({ revision: 'before later edits' })] }),
      'Fixes it, so the header stays.',
    );
    expect(n[0]!.text).toContain('before the final edits');
  });

  test('no notes when the draft already covers it', () => {
    expect(
      contextNotes(
        digest({ runs: [run()], decided: true }),
        'Fixes the export so the header stays.',
      ),
    ).toEqual([]);
  });

  test('UI files with no visual check captured', () => {
    const files = [
      {
        path: 'web/Button.tsx',
        role: 'behavior' as const,
        added: 5,
        removed: 0,
        sessions: [],
        unmatchedLines: 0,
      },
    ];
    expect(
      topics(
        contextNotes(
          digest({ runs: [run()], files, decided: true }),
          'Fixes the button so it aligns.',
        ),
      ),
    ).toEqual(['ui']);
  });

  test('missing rationale is offered, not demanded; high unmatched share is described neutrally', () => {
    const n = contextNotes(
      digest({ runs: [run()], unmatched: 70 }),
      'Writes the header first.',
    );
    expect(topics(n)).toEqual(['rationale', 'attribution']);
    expect(n[1]!.text).not.toMatch(/hand-written/i);
  });
});

describe('evidence notes outline', () => {
  test('facts grouped for someone writing it themselves', () => {
    const md = evidenceNotes(digest({ runs: [run()], decided: true }));
    expect(md).toContain('## What was asked');
    expect(md).toContain('Write the header first? → Yes');
    expect(md).toContain('`bun test`: passed (12 pass, 0 fail); no later edits seen');
    expect(md).toContain('- behavior: src/a.ts');
  });
});
