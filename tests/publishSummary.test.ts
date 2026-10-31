/** The short message an agent relays after Tracetoon creates the PR. */
import { describe, expect, test } from 'bun:test';
import { publishSummary, type Approval } from '../src/commands/publish.ts';

const approval = (over: Partial<Approval> = {}): Approval => ({
  code: 'abc12345',
  title: 'Add a greeting',
  bodySha: 'x',
  findings: [],
  allowFindings: false,
  mode: 'create',
  base: 'main',
  head: 'feat/greeting',
  policy: 'none',
  ambiguousSessions: [],
  comicMode: 'allowed',
  comicStatus: { state: 'included' },
  renderedAt: 'now',
  ...over,
});
const URL = 'https://github.com/o/r/pull/34';

describe('post-PR message', () => {
  test('says Tracetoon created the PR, that it has a comic, and how to change comics', () => {
    expect(publishSummary(approval(), URL).split('\n')).toEqual([
      `Tracetoon created PR #34: ${URL}`,
      'Comic: included.',
      'Comics: tracetoon config set comic off|allowed|always (now: allowed)',
    ]);
  });

  test.each([
    [{ state: 'off', detail: 'comic is off in your settings' }, 'off'],
    [
      {
        state: 'policy',
        detail:
          "this repo's contributing rules forbid images in PRs (CONTRIBUTING.md:12)",
      },
      'allowed',
    ],
    [{ state: 'no-route', detail: 'no image route set up' }, 'always'],
    [{ state: 'failed', detail: 'the image service timed out' }, 'allowed'],
  ] as const)('explains why there is no comic: %o', (status, mode) => {
    const message = publishSummary(
      approval({ comicStatus: status, comicMode: mode }),
      URL,
    );
    expect(message).toContain(`Comic: none — ${status.detail}.`);
    expect(message).toContain(`(now: ${mode})`);
  });

  test('an update says so, and left-out sessions are mentioned', () => {
    const message = publishSummary(
      approval({ mode: 'edit', prNumber: 34, ambiguousSessions: ['h:1', 'h:2'] }),
      URL,
    );
    expect(message).toStartWith(`Tracetoon updated PR #34: ${URL}`);
    expect(message).toContain('Left out: 2 sessions that may not belong to this PR.');
  });

  test('renders from before comic status was recorded still produce a message', () => {
    const message = publishSummary(
      approval({ comicStatus: undefined, comicMode: undefined }),
      URL,
    );
    expect(message).not.toContain('Comic:');
    expect(message).toContain('(now: allowed)');
  });
});
