/** Native host lifecycle adapters. Hooks inspect local state; they never run models or checks. */
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handoffShown } from '../review/handoff.ts';
import { activeBrowserPreview } from '../review/browser.ts';
import { closeSync, openSync, readSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readLocal, writeLocal } from '../util/localJson.ts';
import {
  beginTask,
  readTask,
  repository,
  saveTask,
  tasks,
  workFingerprint,
} from '../workflow/state.ts';
import { readHost, saveHost, rememberRepository } from '../workflow/hostSession.ts';
import { commandFrom, readStdin, type HookAgent, BYPASS_RE } from './prHook.ts';
import { switchState } from './switches.ts';
import { leadingCd } from '../trace/pathMatch.ts';
import { snapshotProblem } from '../review/snapshot.ts';
import type { Approval } from '../commands/publish.ts';
import { BUILD_INFO } from '../version.ts';
import { userConfigPath } from '../config.ts';
import { parseCodexLines } from '../trace/codex.ts';
import { parseClaudeLines } from '../trace/claude.ts';
import { parseAntigravityLines } from '../trace/antigravity.ts';
import type { TraceSession } from '../trace/types.ts';
import { publicationTargets } from './publicationTarget.ts';

type Payload = Record<string, any>;
export type LifecycleEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop';
const instructions =
  'Tracetoon is enabled. Before changing a repository, register the cohesive task with tracetoon task begin (actual session id and transcript path). Finish applicable local checks using tracetoon check. When the requested change is finished, use task complete and the tracetoon skill automatically, even without a PR request; finish with ready and its exact branded local handoff before publishing the PR. Record defer/block with a reason for unfinished work. Planning and questions are not completed changes. Approval publishes the reviewed PR, never merges it. Use the same contract for shell and GitHub connector writes.';

export function sessionId(p: Payload): string | undefined {
  return [p.session_id, p.sessionId, p.conversationId, p.conversation_id].find(
    (v) => typeof v === 'string' && v.length,
  );
}

function payloadRoots(p: Payload): string[] {
  const raw = p.tool_input ?? p.toolCall?.args ?? p.tool_call?.args ?? {};
  const input = typeof raw === 'string' ? { input: raw } : raw;
  const { command, cwd } = commandFrom(p);
  const base =
    input.workdir ??
    input.cwd ??
    input.Cwd ??
    cwd ??
    p.workspacePaths?.[0] ??
    process.cwd();
  const candidates: string[] = [base];
  const moved = command ? leadingCd(command, base) : undefined;
  if (moved) candidates.unshift(moved);
  const gitAt =
    command && /\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(command);
  if (gitAt) candidates.unshift(resolve(base, gitAt[1] ?? gitAt[2] ?? gitAt[3]!));
  for (const field of [
    'file_path',
    'path',
    'TargetFile',
    'AbsolutePath',
    'target_file',
  ]) {
    if (typeof input[field] === 'string')
      candidates.unshift(dirname(resolve(base, input[field])));
  }
  const patch = input.patch ?? input.input;
  if (typeof patch === 'string')
    for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      candidates.unshift(dirname(resolve(base, match[1]!.trim())));
    }
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    let folder = candidate;
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    try {
      const { root } = repository(folder);
      if (!roots.includes(root)) roots.push(root);
    } catch {
      /* parent workspace */
    }
  }
  return roots;
}

/** Tail-only fallback when the host omitted task registration or tool working directories. */
function transcriptTail(
  file: string | undefined,
  agent: HookAgent,
): TraceSession | undefined {
  if (!file || !isAbsolute(file)) return;
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const session: TraceSession = {
      agent:
        agent === 'claude'
          ? 'claude-code'
          : agent === 'antigravity'
            ? 'antigravity-cli'
            : 'codex',
      sessionId: '',
      source: file,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    const text = buffer.toString('utf8');
    if (agent === 'codex') parseCodexLines(text, session);
    else if (agent === 'claude') parseClaudeLines(text, session);
    else parseAntigravityLines(text, session, { history: [] });
    return session;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function context(agent: HookAgent, event: LifecycleEvent, message: string): string {
  if (agent === 'antigravity')
    return JSON.stringify(
      event === 'SessionStart'
        ? { injectSteps: [{ systemMessage: { systemMessage: message } }] }
        : { decision: 'allow', reason: message },
    );
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: message },
  });
}

function continuation(agent: HookAgent, reason: string): string {
  return JSON.stringify(
    agent === 'antigravity'
      ? { decision: 'continue', reason }
      : { decision: 'block', reason },
  );
}

function denyPublication(agent: HookAgent, reason: string): string {
  return JSON.stringify(
    agent === 'antigravity'
      ? { decision: 'deny', reason }
      : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        },
  );
}

export function lifecycle(
  agent: HookAgent,
  event: LifecycleEvent,
  p: Payload,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const cwd = commandFrom(p).cwd ?? p.workspacePaths?.[0] ?? process.cwd();
  if (
    (!switchState(cwd, env).enabled &&
      !['repo', 'local'].includes(switchState(cwd, env).decidedBy)) ||
    p.permission_mode === 'plan' ||
    p.permissionMode === 'plan' ||
    p.is_subagent ||
    p.parent_session_id
  )
    return;
  const healthPath = join(dirname(userConfigPath()), 'hook-health.json');
  const health =
    readLocal<Record<string, { at: string; buildId: string }>>(healthPath) ?? {};
  const previous = health[`${agent}:${event}`];
  if (
    previous?.buildId !== BUILD_INFO.buildId ||
    Date.now() - Date.parse(previous.at) > 60_000
  ) {
    health[`${agent}:${event}`] = {
      at: new Date().toISOString(),
      buildId: BUILD_INFO.buildId,
    };
    writeLocal(healthPath, health);
  }
  const id = sessionId(p);
  const command = commandFrom(p).command;
  if (command && BYPASS_RE.test(command)) return;
  const transcript = p.transcript_path ?? p.transcriptPath;
  if (event === 'SessionStart')
    return switchState(cwd, env).enabled
      ? context(
          agent,
          event,
          `${instructions}\nHost session: ${id ?? 'not exposed'}; transcript: ${transcript ?? 'not exposed'}.`,
        )
      : undefined;
  if (!id) return; // No shared anonymous registry: unrelated sessions must not collide.
  let host = readHost(id);
  const allRoots = payloadRoots(p);
  const roots = allRoots.filter((root) => switchState(root, env).enabled);
  for (const root of roots)
    if (!host.repos.some((r) => r.root === root))
      rememberRepository(id, root, workFingerprint(root), transcript);
  host = readHost(id);
  if (event !== 'Stop') {
    const targets =
      event === 'PreToolUse'
        ? publicationTargets(p, [...allRoots, ...host.repos.map((r) => r.root)])
        : undefined;
    // Tracetoon improves PRs; pushing code is the developer's own workflow.
    // A command that also writes a PR is still classified as `pr`.
    if (targets?.kind === 'pr') {
      if (!targets.roots.length)
        return denyPublication(
          agent,
          'Resolve the actual repository/worktree for this PR and write it with Tracetoon. No local target could be checked.',
        );
      for (const root of targets.roots.filter((r) => switchState(r, env).enabled)) {
        const repo = repository(root);
        let active = tasks(repo.gitDir).find(
          (t) => t.task.branch === repo.branch && t.task.state !== 'published',
        );
        if (!active) {
          const fingerprint = workFingerprint(root);
          const published = tasks(repo.gitDir).find(
            (t) =>
              t.task.branch === repo.branch &&
              t.task.state === 'published' &&
              readLocal<Approval>(join(t.run.dir, 'approval.json'))
                ?.workspaceFingerprint === fingerprint,
          );
          if (published)
            return denyPublication(
              agent,
              `This snapshot is already published. Use tracetoon publish --run ${published.run.id} to retrieve or reconcile its approved PR; a direct write can change code or PR text outside the handoff.`,
            );
          // An agent writing a PR outside Tracetoon starts a task so the PR gets prepared.
          const started = beginTask(root, { session: id, transcript });
          started.task.baseline =
            host.repos.find((r) => r.root === root)?.baseline ??
            'unclassified-publication';
          saveTask(started.run, started.task);
          active = started;
        }
        const reason = `Task ${active.run.id}: write this PR with tracetoon publish after the author approves its ready preview, so it gets the reviewed description and comic. Pushing branches is fine; only PR creation and title/body edits go through Tracetoon.`;
        return denyPublication(agent, reason);
      }
    }
    return;
  }
  if (
    p.fullyIdle === false ||
    p.background_tasks?.length ||
    p.backgroundTasks?.length ||
    (p.terminationReason && p.terminationReason !== 'model_stop')
  )
    return;
  const tail = transcriptTail(transcript ?? host.transcript, agent);
  const discoveredRoots = new Set<string>();
  for (const record of tail?.records ?? []) {
    // A read-only command in a transcript is not evidence of changed work.
    const path =
      record.kind === 'edit'
        ? dirname(record.file)
        : record.kind === 'command' && /\bgit\s+commit\b/.test(record.cmd)
          ? record.cwd
          : undefined;
    if (path)
      try {
        discoveredRoots.add(repository(path).root);
      } catch {
        /* not a repo */
      }
  }
  for (const root of discoveredRoots) {
    if (!host.repos.some((r) => r.root === root) && switchState(root, env).enabled) {
      // Unknown baseline is never treated as evidence that the work was unchanged.
      rememberRepository(id, root, 'unclassified-transcript', transcript);
    }
  }
  host = readHost(id);
  for (const observed of host.repos) {
    if (!switchState(observed.root, env).enabled) continue;
    let repo;
    try {
      repo = repository(observed.root);
    } catch {
      continue;
    } // removed worktree
    let active = tasks(repo.gitDir).find(
      (t) =>
        t.task.branch === repo.branch &&
        (t.task.session === id || !t.task.session) &&
        t.task.state !== 'published',
    );
    const fingerprint = workFingerprint(repo.root);
    if (!active && observed.baseline !== fingerprint) {
      const started = beginTask(repo.root, { session: id, transcript });
      started.task.baseline = observed.baseline;
      saveTask(started.run, started.task);
      active = started;
    }
    if (!active) continue;
    const { run, task } = active;
    if (task.state === 'deferred' || task.state === 'blocked') continue;
    if (task.state === 'working' && task.baseline === fingerprint) continue;
    let reason: string | undefined;
    if (task.state === 'ready') {
      const approval = readLocal<Approval>(join(run.dir, 'approval.json'));
      const problem = approval
        ? snapshotProblem(repo.root, approval.submission)
        : 'Missing approval';
      if (problem || approval?.workspaceFingerprint !== fingerprint) {
        task.state = 'working';
        task.readyCode = undefined;
        saveTask(run, task);
        reason = `Task ${run.id} changed after its preview. Classify the current work and refresh its checks, digest, review and handoff when finished.`;
      } else {
        const url = pathToFileURL(join(run.dir, 'preview.html')).href;
        const browserUrl = activeBrowserPreview(run.dir)?.url;
        const replies = tail?.records.filter((r) => r.kind === 'assistant') ?? [];
        const last = replies[replies.length - 1];
        const message =
          p.last_assistant_message ??
          p.lastAssistantMessage ??
          (last?.kind === 'assistant' ? last.text : '');
        if (
          handoffShown(message, {
            fileUrl: url,
            filePath: join(run.dir, 'preview.html'),
            browserUrl,
          })
        ) {
          task.presentedCode = task.readyCode;
          task.presentedAt = new Date().toISOString();
          saveTask(run, task);
          continue;
        }
        if (task.presentedCode === task.readyCode) continue;
        reason = `The ready Tracetoon ${run.id} has not been shown to the user. Run tracetoon ready --run ${run.id} --serve, keep that local preview process running, and end your response with its exact previewHandoff.markdown. Do not publish before approval.`;
      }
    } else if (task.state === 'working')
      reason = `Changed task ${run.id} has no completion disposition. If the requested cohesive change is finished, run task complete --run ${run.id} and prepare its Tracetoon automatically. If work remains or you need user input, record task defer/block --run ${run.id} --reason <actual reason>. Do not treat a commit as a user review.`;
    else
      reason = `Task ${run.id} is finished but its Tracetoon preparation is incomplete. Resume the tracetoon skill with explicit --run ${run.id}, finish checks, draft, comic and review, then ready and the author handoff. If preparation is unavailable, record task block with the actual reason and tell the user.`;
    const key = createHash('sha256')
      .update(
        `${run.id}:${fingerprint}:${task.readyCode ?? ''}:${task.recoveryGeneration ?? 0}`,
      )
      .digest('hex');
    const attempts = host.recoveries[key] ?? 0;
    if (attempts >= 2) {
      task.state = 'blocked';
      task.reason =
        'Automatic completion recovery exhausted; resume this task explicitly.';
      saveTask(run, task);
      return continuation(
        agent,
        `Automatic completion recovery for ${run.id} is exhausted. Tell the user that Tracetoon preparation is blocked, give the actual remaining issue and the resume command, and do not claim a PR was published. The next stop is allowed.`,
      );
    }
    host.recoveries[key] = attempts + 1;
    host.recoveries = Object.fromEntries(Object.entries(host.recoveries).slice(-100));
    saveHost(id, host);
    return continuation(agent, reason!);
  }
}

export async function runLifecycle(agent: HookAgent, event: LifecycleEvent) {
  try {
    const raw = await readStdin();
    const answer = raw ? lifecycle(agent, event, JSON.parse(raw)) : undefined;
    if (answer) process.stdout.write(answer + '\n');
  } catch (e) {
    // Do not stop ordinary coding on hook failures; retain a visible diagnostic.
    try {
      writeLocal(
        join(
          dirname((await import('../config.ts')).userConfigPath()),
          'last-hook-error.json',
        ),
        { agent, event, at: new Date().toISOString(), error: (e as Error).message },
      );
    } catch {
      /* best effort */
    }
    process.stderr.write(
      `Tracetoon ${event} hook could not inspect completion; run tracetoon doctor.\n`,
    );
  }
}
