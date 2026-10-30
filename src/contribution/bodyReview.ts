import { nonempty, requireThat, strings } from './guidance.ts';
import { CLAIM_VERDICTS, type BodyReview } from './types.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate the reviewer's reported accuracy read. Evidence references must
 * exist; whether a verdict is right is the reviewer's judgment, not the CLI's.
 */
export function parseBodyReview(
  value: unknown,
  refExists: (ref: string) => boolean,
): BodyReview {
  requireThat(record(value), 'bodyReview must be an object.');
  requireThat(
    nonempty(value.inferredChange) && nonempty(value.inferredStart),
    'Before reading the diff, state what the body alone says changed (inferredChange) and where you would start reviewing (inferredStart).',
  );
  requireThat(
    record(value.transfer) &&
      ['satisfied', 'needs-revision'].includes(value.transfer.state as string) &&
      nonempty(value.transfer.reason),
    'bodyReview.transfer needs a state (satisfied or needs-revision) and a reason comparing the cold read with the diff.',
  );
  requireThat(
    Array.isArray(value.claims) && value.claims.length > 0,
    'bodyReview needs at least one checked claim.',
  );
  for (const claim of value.claims) {
    requireThat(
      record(claim) &&
        typeof claim.at === 'string' &&
        /^body:\d+(-\d+)?$/.test(claim.at) &&
        refExists(claim.at) &&
        nonempty(claim.claim) &&
        (CLAIM_VERDICTS as readonly string[]).includes(claim.verdict as string) &&
        strings(claim.evidence) &&
        (claim.correction === undefined || nonempty(claim.correction)),
      'Each bodyReview claim needs an existing body line (at), the claim, a verdict and evidence.',
    );
    requireThat(
      claim.verdict === 'unsupported' || (claim.evidence as string[]).length > 0,
      `The ${String(claim.verdict)} claim at ${String(claim.at)} needs evidence.`,
    );
    for (const ref of claim.evidence as string[])
      requireThat(refExists(ref), `Unknown evidence reference: ${ref}`);
  }
  requireThat(Array.isArray(value.omissions), 'bodyReview needs an omissions array.');
  for (const gap of value.omissions) {
    requireThat(
      record(gap) &&
        nonempty(gap.behavior) &&
        strings(gap.evidence) &&
        gap.evidence.some((ref) => ref.startsWith('diff:')) &&
        (gap.correction === undefined || nonempty(gap.correction)),
      'Each bodyReview omission needs the behavior and diff evidence.',
    );
    for (const ref of gap.evidence as string[])
      requireThat(refExists(ref), `Unknown evidence reference: ${ref}`);
  }
  return value as unknown as BodyReview;
}

/** Claims that need the drafter's attention, most serious first. */
export function claimsNeedingWork(review: BodyReview) {
  const rank = { contradicted: 0, unsupported: 1, overstated: 2, supported: 3 };
  return review.claims
    .filter((c) => c.verdict !== 'supported')
    .sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}

export function bodyReviewLines(review: BodyReview): string[] {
  const flagged = claimsNeedingWork(review);
  return [
    `Description accuracy review (advisory): ${review.claims.length - flagged.length} of ${review.claims.length} claim(s) supported; ${review.omissions.length} omission(s); cold read ${review.transfer.state}.`,
    `  Read from the text alone: ${review.inferredChange}`,
    `  Would start reviewing at: ${review.inferredStart}`,
    ...(review.transfer.state === 'needs-revision'
      ? [`  Gap between the text and the diff: ${review.transfer.reason}`]
      : []),
    ...flagged.map(
      (c) =>
        `  ${c.verdict} (${c.at}): ${c.claim}${c.correction ? ` Suggested correction: ${c.correction}` : ''}`,
    ),
    ...review.omissions.map(
      (o) =>
        `  omitted: ${o.behavior}${o.correction ? ` Suggested correction: ${o.correction}` : ''}`,
    ),
  ];
}
