import { defaultBase } from '../git/pr.ts';
import { findRun, readJson } from '../run.ts';
import { beginTask, readTask, repository, saveTask } from '../workflow/state.ts';
import { executeCheck, receipts } from '../workflow/checks.ts';
import { readiness } from '../workflow/readiness.ts';
import { emit, UserError, type OutOpts } from './output.ts';
import { previewCmd, type Approval } from './publish.ts';
import { setReviewState } from '../review/pending.ts';
import { rememberRepository } from '../workflow/hostSession.ts';

interface TaskOpts extends OutOpts {
  run?: string;
  base?: string;
  session?: string;
  transcript?: string;
  reason?: string;
  checks?: string;
  noChecks?: string;
}
export function taskCmd(
  cwd: string,
  action: 'begin' | 'complete' | 'defer' | 'block',
  opts: TaskOpts,
) {
  const info = beginTask(cwd, {
    ...opts,
    session: opts.session ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_SESSION_ID,
  });
  const { run, task } = info;
  if (action === 'begin' && ['deferred', 'blocked'].includes(task.state)) {
    task.recoveryGeneration = (task.recoveryGeneration ?? 0) + 1;
    task.state = 'working';
    task.reason = undefined;
    saveTask(run, task);
  }
  if (task.session)
    rememberRepository(task.session, info.root, task.baseline, task.transcript);
  if (action !== 'begin') {
    if ((action === 'defer' || action === 'block') && !opts.reason?.trim())
      throw new UserError('Record a reason for unfinished or blocked work.');
    task.state =
      action === 'complete' ? 'preparing' : action === 'block' ? 'blocked' : 'deferred';
    task.reason = opts.reason;
    task.readyCode = undefined;
    if (opts.checks !== undefined) {
      task.checks = opts.checks
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      task.noChecksReason = undefined;
    } else if (!task.checks?.length && receipts(run).length)
      task.checks = receipts(run).map((c) => c.name);
    if (opts.noChecks) {
      task.noChecksReason = opts.noChecks;
      task.checks = [];
    }
    saveTask(run, task);
  }
  const next =
    task.state === 'preparing'
      ? `${info.branch === task.base ? `Create a local feature branch first (PR head and base cannot both be ${task.base}), then adopt it with task begin --run ${run.id}. ` : ''}Finish applicable checks, then use the tracetoon skill with digest --run ${run.id}, context, research, drafting, comic and independent review. End with ready --run ${run.id} --serve and its exact handoff.`
      : `Resume this task with --run ${run.id}; complete it when the cohesive change is finished.`;
  emit(
    opts,
    { run: run.id, runDir: run.dir, state: task.state, nextAction: next },
    () => `Task ${run.id}: ${task.state}. ${next}`,
  );
}

export function checkCmd(
  cwd: string,
  command: string[],
  opts: OutOpts & {
    run: string;
    name?: string;
    cwd?: string;
    skip?: string;
    force?: boolean;
    input?: string[];
  },
) {
  const repo = repository(cwd);
  const run = findRun(repo.gitDir, opts.run);
  const task = readTask(run);
  if (task && (task.branch !== repo.branch || task.root !== repo.root))
    throw new UserError('Run checks in this task worktree and branch.');
  const receipt = executeCheck(repo.root, run, {
    ...opts,
    name: opts.name ?? command.join(' '),
    command,
    onStart: () => {
      if (task?.state === 'ready') {
        task.state = 'preparing';
        task.readyCode = undefined;
        saveTask(run, task);
      }
    },
  });
  if (task && task.state === 'ready' && !receipt.reused) {
    task.state = 'preparing';
    task.readyCode = undefined;
    saveTask(run, task);
  }
  emit(
    opts,
    receipt,
    () =>
      `${receipt.name}: ${receipt.outcome}${receipt.reused ? ' (reused unchanged inputs)' : ''}; ${receipt.durationMs}ms${receipt.reason ? `; ${receipt.reason}` : ''}`,
  );
  if (receipt.outcome === 'failed')
    process.exitCode = receipt.exitCode && receipt.exitCode > 0 ? receipt.exitCode : 1;
}

export async function readyCmd(
  cwd: string,
  opts: OutOpts & { run: string; serve?: boolean; open?: boolean },
) {
  const { root, gitDir, branch } = repository(cwd);
  const run = findRun(gitDir, opts.run);
  const task = readTask(run);
  const approval = readJson<Approval>(run, 'approval.json');
  if (!task || !approval)
    throw new UserError('Complete this task and render its reviewed preview first.');
  if (task.root !== root || task.branch !== branch)
    throw new UserError('Switch to the task worktree and branch.');
  const report = readiness(root, run, approval);
  task.state = 'ready';
  task.readyCode = approval.code;
  task.readyReviewSha = report.reviewSha;
  task.readyChecksSha = report.checksSha;
  task.readyPreviewSha = report.previewSha;
  task.readyAt = new Date().toISOString();
  task.reason = undefined;
  saveTask(run, task);
  setReviewState(run, approval, 'pending');
  // Return the standard branded handoff; the host Stop hook records actual presentation.
  await previewCmd(cwd, opts);
}
