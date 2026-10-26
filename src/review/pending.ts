/** Local draft lifecycle. Reading status never contacts GitHub or changes drafts. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Approval } from '../commands/publish.ts';
import type { Run } from '../run.ts';
import { git } from '../util/exec.ts';
import { snapshotProblem } from './snapshot.ts';
import { readTask } from '../workflow/state.ts';
import { readyProblem } from '../workflow/readiness.ts';
import { activeBrowserPreview } from './browser.ts';

export const RUN_NAME = /^\d{8}-\d{6}(-\d+)?$/;
type ReviewState = {
  status: 'pending' | 'published' | 'dismissed' | 'superseded';
  code: string;
};
type Draft = { run: Run; approval: Approval };
export interface PendingDraft {
  run: string;
  code: string;
  branch: string;
  base: string;
  title: string;
  previewUrl: string;
  browserUrl?: string;
  freshness: 'current' | 'stale' | 'needs-refresh' | 'other-branch';
  problem?: string;
}

function json<T>(dir: string, name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return undefined;
  }
}

function drafts(gitDir: string): Draft[] {
  const base = join(gitDir, 'tracetoon', 'runs');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && RUN_NAME.test(d.name))
    .flatMap((d) => {
      const run = { id: d.name, dir: join(base, d.name) };
      const approval = json<Approval>(run.dir, 'approval.json');
      return approval?.head &&
        approval.base &&
        approval.code &&
        existsSync(join(run.dir, 'preview.html'))
        ? [{ run, approval }]
        : [];
    })
    .sort(
      (a, b) =>
        (a.approval.renderedAt || a.run.id).localeCompare(
          b.approval.renderedAt || b.run.id,
        ) || a.run.id.localeCompare(b.run.id),
    );
}

const target = (a: Approval) => JSON.stringify([a.head, a.base, a.mode, a.prNumber]);

export function activePendingRuns(gitDir: string): Draft[] {
  const latest = new Map<string, Draft>();
  for (const draft of drafts(gitDir)) latest.set(target(draft.approval), draft);
  return [...latest.values()].filter(({ run, approval }) => {
    const task = readTask(run);
    if (task && task.state !== 'ready' && !task.readyAt) return false;
    const state = json<ReviewState>(run.dir, 'review-state.json');
    if (state?.code === approval.code && state.status !== 'pending') return false;
    return json<{ code?: string }>(run.dir, 'published.json')?.code !== approval.code;
  });
}

export function setReviewState(
  run: Run,
  approval: Approval,
  status: ReviewState['status'],
): void {
  writeFileSync(
    join(run.dir, 'review-state.json'),
    JSON.stringify({ status, code: approval.code }) + '\n',
  );
}

export function recordRendered(gitDir: string, run: Run, approval: Approval): void {
  // Managed renders can be internal reviewer artifacts. `ready` registers their handoff.
  if (readTask(run)) return;
  for (const older of drafts(gitDir)) {
    if (older.run.id !== run.id && target(older.approval) === target(approval))
      setReviewState(older.run, older.approval, 'superseded');
  }
  const state = json<ReviewState>(run.dir, 'review-state.json');
  if (state?.code === approval.code && ['published', 'dismissed'].includes(state.status))
    return;
  setReviewState(run, approval, 'pending');
}

export function pendingDrafts(root: string, gitDir: string): PendingDraft[] {
  const active = activePendingRuns(gitDir);
  if (!active.length) return [];
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  return active
    .map(({ run, approval }): PendingDraft => {
      const other = branch !== approval.head;
      const task = readTask(run);
      const problem = other
        ? `Switch to branch ${approval.head} to resume this preview.`
        : task && task.state !== 'ready'
          ? 'This task is being refreshed; its previous preview is not ready for publication.'
          : (snapshotProblem(root, approval.submission) ??
            (task ? readyProblem(root, run, approval) : undefined));
      return {
        run: run.id,
        code: approval.code,
        branch: approval.head,
        base: approval.base,
        title: approval.title,
        previewUrl: pathToFileURL(join(run.dir, 'preview.html')).href,
        browserUrl: activeBrowserPreview(run.dir)?.url,
        freshness: other
          ? 'other-branch'
          : !approval.submission
            ? 'needs-refresh'
            : problem
              ? 'stale'
              : 'current',
        ...(problem ? { problem } : {}),
      };
    })
    .sort(
      (a, b) =>
        Number(a.freshness === 'other-branch') - Number(b.freshness === 'other-branch'),
    );
}
