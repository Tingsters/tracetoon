import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../run.ts';
import { readJson } from '../run.ts';
import type { Approval } from '../commands/publish.ts';
import { snapshotProblem } from '../review/snapshot.ts';
import { checkReport, receipts } from './checks.ts';
import { readTask, workFingerprint } from './state.ts';
import { git } from '../util/exec.ts';
const originHash = (root: string) =>
  createHash('sha256')
    .update(git(root, ['remote', 'get-url', 'origin']).stdout.trim())
    .digest('hex');

export const fileHash = (run: Run, name: string) =>
  createHash('sha256')
    .update(readFileSync(join(run.dir, name)))
    .digest('hex');

function renderProblem(run: Run, approval: Approval): string | undefined {
  try {
    if (fileHash(run, 'final-body.md') !== approval.bodySha)
      return 'The rendered description changed; render and review it again.';
    const packet = readJson<{ title: string; body: string }>(run, 'review-input.json');
    if (
      !packet ||
      packet.title !== approval.title ||
      createHash('sha256').update(packet.body).digest('hex') !== approval.bodySha
    )
      return 'The reviewed title or description does not match this render.';
    if (
      approval.comicFile &&
      createHash('sha256').update(readFileSync(approval.comicFile)).digest('hex') !==
        approval.comicSha
    )
      return 'The comic changed; render and review it again.';
  } catch {
    return 'A rendered artifact is missing; refresh this preview.';
  }
}

export function readiness(root: string, run: Run, approval: Approval) {
  if (existsSync(join(run.dir, 'checks.lock')))
    throw new Error('Validation is still running; finish it before the review handoff.');
  const integrity = renderProblem(run, approval);
  if (integrity) throw new Error(integrity);
  const task = readTask(run);
  if (!task)
    throw new Error(
      'Register this work with tracetoon task begin --run, then complete it before marking it ready.',
    );
  if (!['preparing', 'ready', 'blocked'].includes(task.state))
    throw new Error('Run tracetoon task complete before marking this task ready.');
  const problem = snapshotProblem(root, approval.submission);
  if (problem) throw new Error(problem);
  if (
    approval.workspaceFingerprint &&
    approval.workspaceFingerprint !== workFingerprint(root)
  )
    throw new Error('Working content changed; refresh the digest and preview.');
  if (approval.originSha !== originHash(root))
    throw new Error('The publication remote changed; refresh the preview and approval.');
  const review = readJson<{ status: string }>(run, 'review-result.json');
  if (!review || !['current', 'incomplete'].includes(review.status))
    throw new Error(
      'Finish review and re-render the current review-input.json before the user handoff.',
    );
  const input = readJson<{ fingerprint: string }>(run, 'review-input.json');
  const submitted = readJson<{ inputFingerprint: string }>(run, 'review.json');
  if (!input || input.fingerprint !== submitted?.inputFingerprint)
    throw new Error('The independent review is missing or stale.');
  const checks = checkReport(root, run);
  if (checks.some((c) => c.outcome === 'running'))
    throw new Error(
      'A validation command is still running or was interrupted. Finish or rerun it before the review handoff.',
    );
  if (!task.checks?.length && !task.noChecksReason)
    throw new Error(
      'Declare applicable checks with task complete --checks, or record --no-checks <reason>.',
    );
  for (const name of task.checks ?? []) {
    const receipt = checks.find((c) => c.name === name);
    if (!receipt?.current)
      throw new Error(
        `Check ${name} is missing or stale. Complete it before the review handoff.`,
      );
  }
  if (receipts(run).length && approval.checksSha !== fileHash(run, 'checks.json'))
    throw new Error('Check evidence changed; refresh the digest, review and preview.');
  return {
    previewSha: fileHash(run, 'preview.html'),
    checks,
    reviewSha: fileHash(run, 'review.json'),
    checksSha: receipts(run).length ? fileHash(run, 'checks.json') : '',
  };
}

/** Cheap publication guard: no tests, models, research or rendering after approval. */
export function readyProblem(
  root: string,
  run: Run,
  approval: Approval,
): string | undefined {
  if (existsSync(join(run.dir, 'checks.lock')))
    return 'Validation is still running; wait for it before publishing.';
  const task = readTask(run);
  if (!task) return; // Legacy/manual workflows retain their existing approval contract.
  const integrity = renderProblem(run, approval);
  if (integrity) return integrity;
  if (task.state !== 'ready' && task.state !== 'published')
    return 'This task has not completed preparation. Run tracetoon ready before publishing.';
  if (task.readyCode !== approval.code)
    return 'This task approval is stale. Refresh its review handoff.';
  try {
    if (task.readyReviewSha !== fileHash(run, 'review.json'))
      return 'Review changed after the handoff; refresh it before publishing.';
    if (task.readyPreviewSha !== fileHash(run, 'preview.html'))
      return 'The preview changed after the handoff; refresh its approval.';
    const checksSha = receipts(run).length ? fileHash(run, 'checks.json') : '';
    if (task.readyChecksSha !== checksSha)
      return 'Validation evidence changed after the handoff; refresh it before publishing.';
    if (approval.workspaceFingerprint !== workFingerprint(root))
      return 'Working content changed after the handoff; refresh it before publishing.';
    if (approval.originSha !== originHash(root))
      return 'The publication remote changed after the handoff; refresh its approval.';
  } catch {
    return 'Preparation artifacts are missing; refresh this task.';
  }
}
