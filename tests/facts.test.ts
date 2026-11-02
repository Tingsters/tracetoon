import { expect, test } from 'bun:test';
import { digestFact } from '../src/digest/facts.ts';
import type { TraceDigest } from '../src/digest/build.ts';
import { commandRun } from '../src/digest/build.ts';

test('fact lookup supports legacy session refs, all fact kinds and commit prefixes', () => {
  const d = {
    pr: {
      commits: [
        {
          sha: 'abcdef123456' + 'a'.repeat(28),
          subject: 'fix: output',
          body: 'Explains #42.',
        },
      ],
    },
    verification: [{ id: 'V1', cmd: 'bun test' }],
    sessions: [
      {
        ref: 'h:session',
        prompts: [{ id: 'S1', text: 'Fix blank output.' }],
        plans: [{ id: 'P1', excerpt: 'Plan' }],
        decisions: [{ id: 'D1', text: 'Keep the fallback.' }],
        runs: [{ id: 'R1', cmd: 'bun test tests/output.test.ts' }],
      },
    ],
  } as TraceDigest;
  for (const id of ['S1', 'D1', 'P1', 'R1', 'V1']) {
    expect(digestFact(d, id)).toBeDefined();
    expect(digestFact(d, `digest:${id}`)).toEqual(digestFact(d, id));
  }
  expect(digestFact(d, 'h:session')).toBe(d.sessions[0]);
  expect(digestFact(d, 'commit:abcdef1')).toBe(d.pr.commits[0]);
  expect(digestFact(d, 'commit:abcdef123456' + 'a'.repeat(28))).toBe(d.pr.commits[0]);
  expect(digestFact(d, 'commit:abcdef123456' + 'b'.repeat(28))).toBeUndefined();
  expect(digestFact(d, 'D999')).toBeUndefined();
  expect(digestFact(d, 'commit:fffffff')).toBeUndefined();
  d.pr.commits.push({ sha: 'abcdef123459', subject: 'Another commit', trailers: {} });
  expect(digestFact(d, 'commit:abcdef1')).toBeUndefined();
});

test('missing exit status and silent piped checks are unknown, not passes', () => {
  expect(commandRun('bun test', undefined, undefined)?.outcome).toBe('unknown');
  expect(commandRun('bun x tsc --noEmit | tail -3', false, '')?.outcome).toBe('unknown');
  expect(commandRun('bun x tsc --noEmit', false, '')?.outcome).toBe('passed');
  expect(commandRun('bun test | tail -3', undefined, '12 pass\n0 fail')?.outcome).toBe(
    'passed',
  );
});
