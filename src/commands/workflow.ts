import { defaultBase } from '../git/pr.ts';
import { findRun } from '../run.ts';
import { beginTask, readTask, repository, saveTask } from '../workflow/state.ts';
import { executeCheck, receipts } from '../workflow/checks.ts';
import { emit, UserError, type OutOpts } from './output.ts';
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
    session:
      opts.session ??
      (process.env.CODEX_THREAD_ID ||
        process.env.CLAUDE_CODE_SESSION_ID ||
        process.env.CLAUDE_SESSION_ID ||
        undefined),
    // complete/defer/block keep the task's branch; only begin adopts another one.
    adopt: action === 'begin',
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
      ? `${info.branch === task.base ? `Create a local feature branch first (PR head and base cannot both be ${task.base}), then adopt it with task begin --run ${run.id}. ` : ''}When the user wants a PR, use the tracetoon skill with digest --run ${run.id}, context, research, drafting, comic and independent review, then tracetoon publish --run ${run.id}.`
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
  });
  emit(
    opts,
    receipt,
    () =>
      `${receipt.name}: ${receipt.outcome}${receipt.reused ? ' (reused unchanged inputs)' : ''}; ${receipt.durationMs}ms${receipt.reason ? `; ${receipt.reason}` : ''}`,
  );
  if (receipt.outcome === 'failed')
    process.exitCode = receipt.exitCode && receipt.exitCode > 0 ? receipt.exitCode : 1;
}
