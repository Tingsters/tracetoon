import { describe, expect, test } from 'bun:test';
import {
  comicObservationInput,
  comicReviewLines,
  parseComicReview,
} from '../src/contribution/comicReview.ts';
import {
  COMIC_REVIEW_CHECKS,
  type ComicReview,
  type ReviewInput,
} from '../src/contribution/types.ts';

const report = (): ComicReview => ({
  imageSha256: 'a'.repeat(64),
  observedPanels: ['A bright object stands out against its surroundings.'],
  inferredStory: 'Conspicuousness is useful for a link.',
  perceivedJoke: 'Bad camouflage becomes good navigation.',
  inferredChange: 'A PR preview link is made easier to spot.',
  checks: Object.fromEntries(
    COMIC_REVIEW_CHECKS.map((name) => [
      name,
      {
        state: name === 'continuity' ? 'inapplicable' : 'satisfied',
        reason: 'Specific visible evidence in the static scene.',
        panels: [1],
      },
    ]),
  ) as ComicReview['checks'],
});
describe('reported comic content review', () => {
  test('accepts static jokes and keeps literal observation separate from interpretation', () => {
    const value = parseComicReview(report());
    expect(value.checks.continuity.state).toBe('inapplicable');
    expect(comicReviewLines(value).join('\n')).toContain('Inferred story:');
    expect(comicReviewLines(value).join('\n')).toContain('Perceived joke:');
  });
  test.each([
    'clarity',
    'continuity',
    'fidelity',
    'payoff',
    'readability',
    'relevance',
  ] as const)('requires a separate %s assessment', (key) => {
    const value: any = report();
    delete value.checks[key];
    expect(() => parseComicReview(value)).toThrow();
  });
  test('cannot cite panels that were not observed or certify an unobserved payoff', () => {
    const value = report();
    value.checks.payoff.panels = [2];
    expect(() => parseComicReview(value)).toThrow('unobserved panel');
    value.checks.payoff.panels = [];
    expect(() => parseComicReview(value)).toThrow('observed panel evidence');
    value.checks.payoff.state = 'inapplicable';
    expect(() => parseComicReview(value)).toThrow('Only comic continuity');
  });
  test('allows candid uncertainty and targets the cause without scoring humor', () => {
    const value = report();
    value.perceivedJoke = 'No identifiable comic turn.';
    value.checks.payoff = {
      state: 'needs-revision',
      reason: 'The caption only states the lesson.',
      panels: [1],
    };
    value.correction = {
      target: 'premise',
      instruction: 'Find a comic consequence instead of redrawing the same scene.',
    };
    expect(parseComicReview(value).checks.payoff.state).toBe('needs-revision');
    expect(comicReviewLines(value).join('\n')).toContain('Correct premise');
  });
  test('records the change read from the image and judges relevance separately', () => {
    const value = report();
    expect(comicReviewLines(parseComicReview(value)).join('\n')).toContain(
      'Inferred change: A PR preview link is made easier to spot.',
    );
    delete (value as any).inferredChange;
    expect(() => parseComicReview(value)).toThrow('inferredChange');
    value.inferredChange = 'No software change is identifiable.';
    value.checks.relevance = {
      state: 'inapplicable',
      reason: 'Static scene.',
      panels: [1],
    };
    expect(() => parseComicReview(value)).toThrow('Only comic continuity');
    value.checks.relevance = {
      state: 'needs-revision',
      reason: 'A soup gag; nothing names the preview link.',
      panels: [1],
    };
    value.correction = { target: 'script', instruction: 'Label the photo as the link.' };
    expect(parseComicReview(value).checks.relevance?.state).toBe('needs-revision');
  });
  test('older reports without relevance stay readable', () => {
    const value: any = report();
    delete value.inferredChange;
    delete value.checks.relevance;
    const parsed = parseComicReview(value);
    expect(parsed.checks.relevance).toBeUndefined();
    expect(comicReviewLines(parsed).join('\n')).not.toContain('relevance');
  });
  test('first-pass packet excludes the script, synopsis, title and PR explanation', () => {
    const input = {
      title: 'Spoiler',
      body: 'The intended joke explained',
      comicSha256: 'a'.repeat(64),
      comic: { imagePath: 'out/comic.png', scriptPath: 'comic.json', panelCount: 1 },
    } as ReviewInput;
    expect(comicObservationInput(input)).toEqual({
      v: 1,
      imagePath: 'out/comic.png',
      imageSha256: 'a'.repeat(64),
    });
    expect(comicObservationInput({ ...input, comic: undefined })).toBeUndefined();
  });
  test('rejects non-string JSON labels instead of coercing arrays around evidence rules', () => {
    for (const state of [['satisfied'], ['inapplicable'], ['uncertain'], null, 0, {}]) {
      const value: any = report();
      value.checks.payoff = { state, reason: 'Not an actual string state.', panels: [] };
      expect(() => parseComicReview(value)).toThrow('Invalid comicReview payoff');
    }
    const value: any = report();
    value.correction = {
      target: ['premise'],
      instruction: 'A coercible but invalid target.',
    };
    expect(() => parseComicReview(value)).toThrow('correction needs a target');
  });
});
