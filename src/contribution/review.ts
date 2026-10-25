/** A review describes one exact render. It is advisory, never a publish gate. */
import type { TraceDigest } from '../digest/build.ts';
import { readText, type Run } from '../run.ts';
import {
  checkRole,
  nonempty,
  objectHash,
  requireThat,
  strings,
  textHash,
} from './guidance.ts';
import type {
  ContributionReview,
  GuidanceResult,
  ReviewInput,
  ReviewResult,
} from './types.ts';

export function reviewInput(input: {
  title: string;
  body: string;
  guidance: GuidanceResult;
  digest: TraceDigest;
  diffSha256: string;
  headSha: string;
  authorText?: string;
  comicSha256?: string;
}): ReviewInput {
  const { generatedAt: _time, ...digest } = input.digest;
  const stable = {
    title: input.title,
    body: input.body,
    guidanceSha256: input.guidance.sha256,
    guidanceStatus: input.guidance.status,
    guidanceIssues: input.guidance.issues,
    digestSha256: objectHash(digest),
    diffSha256: input.diffSha256,
    headSha: input.headSha,
    authorSha256: textHash(input.authorText ?? ''),
    comicSha256: input.comicSha256 ?? '',
  };
  return {
    v: 1,
    fingerprint: objectHash(stable),
    ...stable,
    artifacts: [
      'guidance-request.json',
      'guidance.json',
      'changes.patch',
      'digest.json',
      'context.json',
      'author.md',
      'final-body.md',
      'preview.html',
      'approval.json',
    ],
  };
}

const STATES = [
  'satisfied',
  'violated',
  'inapplicable',
  'missing-evidence',
  'unresolved-conflict',
];
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function evidenceExists(
  ref: string,
  input: ReviewInput,
  guidance: GuidanceResult,
  digest: TraceDigest,
  patch: string,
  author: string,
): boolean {
  if (ref === 'title') return true;
  const fact = /^digest:([^:]+)$/.exec(ref);
  if (fact)
    return digest.sessions.some((s) =>
      [
        ...(s.prompts ?? []),
        ...(s.plans ?? []),
        ...(s.decisions ?? []),
        ...(s.runs ?? []),
      ].some((f) => f.id === fact[1]),
    );
  const range = /^(body|diff|author|source:([^:]+)):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!range) return false;
  const text =
    range[1] === 'body'
      ? input.body
      : range[1] === 'diff'
        ? patch
        : range[1] === 'author'
          ? author
          : guidance.guidance?.sources.find((s) => s.id === range[2])?.content;
  const start = Number(range[3]);
  const end = Number(range[4] ?? range[3]);
  return (
    typeof text === 'string' &&
    !!text &&
    start >= 1 &&
    end >= start &&
    end <= text.split(/\r?\n/).length
  );
}

export function loadReview(
  run: Run,
  input: ReviewInput,
  guidance: GuidanceResult,
  digest: TraceDigest,
  patch: string,
  extraIssues: string[] = [],
): ReviewResult {
  const base: ReviewResult = {
    status: 'missing',
    issues: [...guidance.issues, ...extraIssues],
    guidanceStatus: guidance.status,
    assessments: [],
    requirements: guidance.guidance?.requirements ?? [],
    sources: guidance.guidance?.sources ?? [],
  };
  let raw: string | undefined;
  try {
    raw = readText(run, 'review.json');
  } catch {
    return {
      ...base,
      status: 'invalid',
      issues: [...base.issues, 'review.json could not be read.'],
    };
  }
  if (raw === undefined)
    return {
      ...base,
      issues: [...base.issues, 'The rendered PR has not been reviewed.'],
    };
  try {
    const value: unknown = JSON.parse(raw);
    requireThat(
      isRecord(value) && value.v === 1 && nonempty(value.inputFingerprint),
      'review.json needs v: 1 and inputFingerprint.',
    );
    checkRole(value.drafter);
    checkRole(value.reviewer);
    requireThat(Array.isArray(value.assessments), 'Review needs an assessments array.');
    const roles = [guidance.guidance?.researcher, value.drafter, value.reviewer].filter(
      (r) => r !== undefined,
    );
    const mode = roles.some((r) => r.mode === 'inline') ? 'inline' : 'delegated';
    const ids = roles.filter((r) => r.mode === 'delegated').map((r) => r.agentId);
    requireThat(
      new Set(ids).size === ids.length,
      'Researcher, drafter and reviewer must be distinct host agents; label sequential fallback as inline.',
    );
    if (value.inputFingerprint !== input.fingerprint)
      return {
        ...base,
        mode,
        status: 'stale',
        issues: [
          ...base.issues,
          'The PR, code, evidence, guidance or comic changed after this review. Review the new review-input.json.',
        ],
      };
    const review = value as unknown as ContributionReview;
    const seen = new Set<string>();
    const author = readText(run, 'author.md') ?? '';
    for (const finding of review.assessments) {
      requireThat(
        isRecord(finding) &&
          nonempty(finding.requirement) &&
          !seen.has(finding.requirement) &&
          base.requirements.some((r) => r.id === finding.requirement),
        'Assessments must reference unique, known requirement ids.',
      );
      seen.add(finding.requirement);
      requireThat(
        STATES.includes(finding.state) &&
          nonempty(finding.reason) &&
          strings(finding.evidence) &&
          (finding.correction === undefined || typeof finding.correction === 'string'),
        `Invalid assessment for ${finding.requirement}.`,
      );
      requireThat(
        finding.state !== 'satisfied' || finding.evidence.length > 0,
        `Satisfied requirement ${finding.requirement} needs evidence.`,
      );
      for (const ref of finding.evidence)
        requireThat(
          evidenceExists(ref, input, guidance, digest, patch, author),
          `Unknown evidence reference: ${ref}`,
        );
      const rule = base.requirements.find((r) => r.id === finding.requirement)!;
      requireThat(
        rule.applicability !== 'unknown' || finding.state !== 'satisfied',
        `Applicability is unknown for ${rule.id}; do not claim satisfaction.`,
      );
      requireThat(
        rule.applicability !== 'applicable' || finding.state !== 'inapplicable',
        `Research and review disagree about applicability for ${rule.id}; update guidance or report an unresolved conflict.`,
      );
      requireThat(
        rule.applicability !== 'inapplicable' || finding.state !== 'satisfied',
        `${rule.id} was declared inapplicable; do not claim satisfaction.`,
      );
    }
    const assessments = [...review.assessments];
    for (const rule of base.requirements)
      if (!seen.has(rule.id)) {
        assessments.push({
          requirement: rule.id,
          state: 'missing-evidence',
          reason: 'The reviewer did not assess this requirement.',
          evidence: [],
        });
        base.issues.push(`Requirement not assessed: ${rule.id}`);
      }
    if (mode === 'inline')
      base.issues.push(
        'Inline fallback: drafting or review was performed without three independent host agents.',
      );
    const incomplete =
      !guidance.guidance ||
      guidance.status !== 'current' ||
      seen.size !== base.requirements.length ||
      extraIssues.length > 0;
    return { ...base, mode, status: incomplete ? 'incomplete' : 'current', assessments };
  } catch (e) {
    return { ...base, status: 'invalid', issues: [...base.issues, (e as Error).message] };
  }
}

export function reviewLine(review: ReviewResult): string {
  const attention = review.assessments.filter(
    (a) =>
      a.state === 'violated' ||
      a.state === 'missing-evidence' ||
      a.state === 'unresolved-conflict',
  );
  return [
    `Contribution review (advisory): ${review.status}${review.mode === 'inline' ? ' (inline draft / self-review)' : review.mode === 'delegated' ? ' (independent host agents)' : ''}; guidance ${review.guidanceStatus}; ${attention.length} finding(s).`,
    ...review.issues.map((i) => `  - ${i}`),
    ...attention.map(
      (a) =>
        `  - ${a.state} (${a.requirement}): ${a.reason}${a.correction ? ` Suggested correction: ${a.correction}` : ''}`,
    ),
  ].join('\n');
}

/** Keep full source snapshots in the run, rather than echoing them to terminals. */
export function reviewSummary(review: ReviewResult) {
  return {
    ...review,
    sources: review.sources.map(({ id, location }) => ({ id, location })),
  };
}
