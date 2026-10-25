/** The code a preview describes, independent of local trace and run artifacts. */
import { objectHash, submission } from '../contribution/guidance.ts';
import { prTruth, type PrTruth } from '../git/pr.ts';

export interface SubmissionSnapshot {
  head: string;
  base: string;
  headSha: string;
  diffSha256: string;
  usedWorkingTree: boolean;
}

export function submissionSnapshot(truth: PrTruth): SubmissionSnapshot {
  const diff = submission(truth);
  return {
    head: truth.head,
    base: truth.base,
    headSha: diff.headSha,
    diffSha256: diff.sha256,
    usedWorkingTree: truth.usedWorkingTree,
  };
}

export function sameSubmission(a: SubmissionSnapshot, b: SubmissionSnapshot): boolean {
  return objectHash(a) === objectHash(b);
}

export function snapshotProblem(
  root: string,
  snapshot?: SubmissionSnapshot,
): string | undefined {
  if (!snapshot)
    return 'This preview predates code freshness checks and needs refreshing.';
  try {
    const truth = prTruth(root, { base: snapshot.base, noGh: true });
    if (truth.head !== snapshot.head)
      return `This preview belongs to branch ${snapshot.head}; the current branch is ${truth.head}.`;
    if (!sameSubmission(snapshot, submissionSnapshot(truth)))
      return 'The submitted code changed after this preview was prepared.';
  } catch {
    return 'The submitted code could not be checked; refresh the preview before publishing.';
  }
}
