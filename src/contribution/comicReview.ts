import { nonempty, requireThat } from './guidance.ts';
import { COMIC_REVIEW_CHECKS, type ComicReview, type ReviewInput } from './types.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate reported evidence, never whether an image is objectively funny. */
export function parseComicReview(value: unknown): ComicReview {
  requireThat(record(value), 'comicReview must be an object.');
  requireThat(
    typeof value.imageSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.imageSha256),
    'comicReview needs the inspected image SHA-256.',
  );
  requireThat(
    Array.isArray(value.observedPanels) &&
      value.observedPanels.length >= 1 &&
      value.observedPanels.length <= 6 &&
      value.observedPanels.every(nonempty),
    'comicReview needs 1–6 nonempty image-first panel observations.',
  );
  const panelCount = value.observedPanels.length;
  requireThat(
    nonempty(value.inferredStory) && nonempty(value.perceivedJoke),
    'Separate the inferred story and perceived joke; explicitly report when no joke is identifiable.',
  );
  requireThat(record(value.checks), 'comicReview needs separate content checks.');
  for (const name of COMIC_REVIEW_CHECKS) {
    const check = value.checks[name];
    requireThat(
      record(check) &&
        typeof check.state === 'string' &&
        ['satisfied', 'needs-revision', 'uncertain', 'inapplicable'].includes(
          check.state,
        ) &&
        nonempty(check.reason),
      `Invalid comicReview ${name} assessment.`,
    );
    requireThat(
      Array.isArray(check.panels) &&
        check.panels.every((n) => Number.isInteger(n) && n >= 1 && n <= panelCount),
      `comicReview ${name} references an unobserved panel.`,
    );
    requireThat(
      check.state !== 'satisfied' || check.panels.length > 0,
      `Satisfied comicReview ${name} needs observed panel evidence.`,
    );
    requireThat(
      check.state !== 'inapplicable' || name === 'continuity',
      `Only comic continuity can be inapplicable, for example in a static cartoon.`,
    );
  }
  if (value.correction !== undefined)
    requireThat(
      record(value.correction) &&
        typeof value.correction.target === 'string' &&
        ['premise', 'script', 'art', 'lettering'].includes(value.correction.target) &&
        nonempty(value.correction.instruction),
      'comicReview correction needs a target and concrete instruction.',
    );
  return value as unknown as ComicReview;
}

/** This small first-pass packet deliberately excludes the intended story. */
export function comicObservationInput(input: ReviewInput) {
  return input.comic
    ? { v: 1, imagePath: input.comic.imagePath, imageSha256: input.comicSha256 }
    : undefined;
}

export function comicReviewLines(review: ComicReview): string[] {
  return [
    'Comic content review (advisory; reported image-first reading):',
    ...review.observedPanels.map((p, i) => `  Panel ${i + 1} observed: ${p}`),
    `  Inferred story: ${review.inferredStory}`,
    `  Perceived joke: ${review.perceivedJoke}`,
    ...COMIC_REVIEW_CHECKS.map(
      (name) => `  ${name}: ${review.checks[name].state} — ${review.checks[name].reason}`,
    ),
    ...(review.correction
      ? [`  Correct ${review.correction.target}: ${review.correction.instruction}`]
      : []),
  ];
}
