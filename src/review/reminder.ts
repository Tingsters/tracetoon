/** Hook reminders are advisory and deduplicated locally, never a permission gate. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { objectHash } from '../contribution/guidance.ts';
import { repoRoot } from '../hook/switches.ts';
import { git } from '../util/exec.ts';
import { userCommand } from '../util/userCommand.ts';
import { activePendingRuns, pendingDrafts } from './pending.ts';
import { previewHandoff } from './handoff.ts';

export function pendingReminder(
  agent: string,
  payload: Record<string, any>,
  cwd: string,
  now = Date.now(),
): string | undefined {
  const root = repoRoot(cwd);
  if (!root) return;
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  if (!gitDir || !activePendingRuns(gitDir).length) return;
  const drafts = pendingDrafts(root, gitDir);
  const session = [
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
    payload.trajectory_id,
  ].find((value) => typeof value === 'string' && value.length > 0);
  const path = join(gitDir, 'tracetoon', 'review-reminders.json');
  let shown: Record<string, number> = {};
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) shown = stored;
  } catch {
    /* first reminder */
  }
  const command = userCommand().run;
  const messages: string[] = [];
  for (const draft of drafts) {
    const key = objectHash({
      agent,
      session: session ?? 'fallback',
      run: draft.run,
      code: draft.code,
      freshness: draft.freshness,
    });
    if (typeof shown[key] === 'number' && (session || now - shown[key]! < 30 * 60_000))
      continue;
    shown[key] = now;
    messages.push(
      `Branch: ${draft.branch}. Resume: ${command} preview --run ${draft.run} --serve. Dismiss: ${command} pending dismiss --run ${draft.run}.\n${previewHandoff({ root, command, url: draft.browserUrl ?? draft.previewUrl, run: draft.run, pending: true, problem: draft.problem }).markdown}`,
    );
  }
  if (!messages.length) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(shown)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 400),
      ),
    ) + '\n',
  );
  return `Show the user this pending-review reminder once, then continue their requested work. It does not authorize publication or require them to stop.\n\n${messages.join('\n\n')}`;
}
