import { activePendingRuns, pendingDrafts, setReviewState } from '../review/pending.ts';
import { previewHandoff } from '../review/handoff.ts';
import { userCommand } from '../util/userCommand.ts';
import { prTruth } from '../git/pr.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export function pendingNotice(root: string, gitDir: string) {
  const pending = pendingDrafts(root, gitDir);
  const command = userCommand().run;
  return {
    pendingDrafts: pending,
    text: pending
      .map((draft) =>
        [
          `Branch: ${draft.branch} -> ${draft.base} | ${draft.title}`,
          `Resume: ${command} preview --run ${draft.run}`,
          `Dismiss: ${command} pending dismiss --run ${draft.run}`,
          previewHandoff({
            root,
            command,
            url: draft.previewUrl,
            run: draft.run,
            pending: true,
            problem: draft.problem,
          }).terminal,
        ].join('\n'),
      )
      .join('\n\n'),
  };
}

export function dismissPendingCmd(cwd: string, opts: OutOpts & { run: string }): void {
  const truth = prTruth(cwd, { noGh: true });
  const draft = activePendingRuns(truth.gitDir).find((d) => d.run.id === opts.run);
  if (!draft)
    throw new UserError(
      `Run ${opts.run} is not awaiting review. Check tracetoon status.`,
    );
  setReviewState(draft.run, draft.approval, 'dismissed');
  emit(
    opts,
    { run: opts.run, dismissed: true },
    () =>
      `Dismissed the review reminder for run ${opts.run}. Your code and branches are unchanged.`,
  );
}
