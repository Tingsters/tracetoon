import { expect, test } from 'bun:test';
import { buildDigest, buildDigestPair, compactDigest } from '../src/digest/build.ts';
import { prTruth } from '../src/git/pr.ts';
import { makeRepo } from './helpers.ts';
import type { SessionMatch } from '../src/correlate/correlate.ts';

test('paired projections retain redacted full evidence and never share mutable arrays', () => {
  const repo = makeRepo();
  repo.commit(
    'feature.ts',
    'export const added = true;\n',
    'Add feature\n\n' +
      'context '.repeat(300) +
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  );
  const truth = prTruth(repo.root, { base: 'main', noGh: true });
  const pair = buildDigestPair(truth, [], {
    interop: { sources: [] } as any,
    budgetTokens: 1000,
  });
  const saved = JSON.stringify(pair.full);
  expect(pair.digest.pr.commits[0]!.body!.length).toBeLessThan(
    pair.full.pr.commits[0]!.body!.length,
  );
  expect(pair.full.pr.commits[0]!.sha.length).toBe(40);
  expect(JSON.stringify(pair.full)).not.toContain(
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  );
  pair.digest.pr.commits.length = 0;
  compactDigest(pair.full, 50);
  expect(JSON.stringify(pair.full)).toBe(saved);
  const separate = buildDigest(truth, [], { full: true, interop: pair.full.interop });
  expect({ ...separate, generatedAt: '' }).toEqual({ ...pair.full, generatedAt: '' });
});

test('one paired build reads prompt evidence once while two independent builds read twice', () => {
  const repo = makeRepo();
  repo.commit('feature.ts', 'export const n = 1;\n', 'Add feature');
  const truth = prTruth(repo.root, { base: 'main', noGh: true });
  let reads = 0;
  const match = {
    session: { agent: 'claude-code', sessionId: 'synthetic' },
    kept: [
      {
        kind: 'prompt',
        ts: '2026-01-01T00:00:00Z',
        get text() {
          reads++;
          return 'Explain the new feature';
        },
      },
    ],
    droppedForeign: 0,
    score: 1,
    band: 'included',
    reasons: [],
    roots: [repo.root],
    addedByFile: new Map(),
    discardedEdits: 0,
    commitsMade: [],
    signals: {},
  } as unknown as SessionMatch;
  const interop = { sources: [] } as any;
  buildDigestPair(truth, [match], { interop });
  expect(reads).toBe(1);
  reads = 0;
  buildDigest(truth, [match], { interop });
  buildDigest(truth, [match], { interop, full: true });
  expect(reads).toBe(2);
});
