/** Native host lifecycle adapters. Hooks inspect local state; they never run models or checks. */
import { dirname, isAbsolute, resolve, join } from 'node:path';
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
import type { Approval } from '../commands/publish.ts';
import { BUILD_INFO } from '../version.ts';
import { userConfigPath } from '../config.ts';
import { parseCodexLines } from '../trace/codex.ts';
import { parseClaudeLines } from '../trace/claude.ts';
import { parseAntigravityLines } from '../trace/antigravity.ts';
import type { TraceSession } from '../trace/types.ts';
import { publicationTargets } from './publicationTarget.ts';
import { leakBlocks, leakNotice } from '../review/leak.ts';

type Payload = Record<string, any>;
export type LifecycleEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop';
const instructions =
  'Tracetoon is enabled. Before changing a repository, register the cohesive task with tracetoon task begin (actual session id and transcript path), and run applicable local checks with tracetoon check. ' +
  'Tracetoon only acts when a pull request is being made: when the user asks for a PR, use the tracetoon skill instead of gh pr create/edit. It writes the description and comic, then creates the PR right away; relay its short message. Never merge. ' +
  'Do not open a PR the user did not ask for. Use the same contract for shell and GitHub connector writes.';

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
              `This snapshot is already published. Use tracetoon publish --run ${published.run.id} to retrieve or reconcile its PR; a direct write would change the PR text outside Tracetoon.`,
            );
          // An agent writing a PR outside Tracetoon starts a task so the PR gets prepared.
          const started = beginTask(root, { session: id, transcript });
          started.task.baseline =
            host.repos.find((r) => r.root === root)?.baseline ??
            'unclassified-publication';
          saveTask(started.run, started.task);
          active = started;
        }
        // The PR was asked for: remember it, and by which session, so that
        // session can't end with it unmade. A fresh request revives a task
        // whose earlier recovery gave up.
        const task = active.task;
        if (!task.prRequestedAt || task.prRequestedBy !== id) {
          task.prRequestedAt ??= new Date().toISOString();
          task.prRequestedBy = id;
          saveTask(active.run, task);
        }
        if (task.state === 'blocked' || task.state === 'deferred') {
          task.state = 'preparing';
          task.reason = undefined;
          task.recoveryGeneration = (task.recoveryGeneration ?? 0) + 1;
          saveTask(active.run, task);
        }
        const reason = `Task ${active.run.id}: make this PR with the tracetoon skill, ending with tracetoon publish --run ${active.run.id}; it writes the description and comic, then creates the PR. Pushing branches is fine; only PR creation and title/body edits go through Tracetoon.`;
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
  // Only a PR that was asked for and redirected to Tracetoon keeps the session
  // open; ordinary finished work never starts a PR on its own.
  for (const observed of host.repos) {
    if (!switchState(observed.root, env).enabled) continue;
    let repo;
    try {
      repo = repository(observed.root);
    } catch {
      continue;
    } // removed worktree
    const active = tasks(repo.gitDir).find(
      (t) =>
        t.task.branch === repo.branch &&
        (t.task.prRequestedBy === id ||
          (!t.task.prRequestedBy && (t.task.session === id || !t.task.session))) &&
        !!t.task.prRequestedAt &&
        t.task.state !== 'published' &&
        t.task.state !== 'deferred' &&
        t.task.state !== 'blocked',
    );
    if (!active) continue;
    const { run, task } = active;
    const fingerprint = workFingerprint(repo.root);
    // A render the leak scan blocked needs the user, not another automatic attempt.
    const rendered = readLocal<Approval>(join(run.dir, 'approval.json'));
    if (leakBlocks(rendered)) {
      task.state = 'blocked';
      task.reason = 'The leak scan found a possible secret in the PR text.';
      saveTask(run, task);
      return continuation(
        agent,
        `${leakNotice(rendered!)} Start your response with that, in plain words, so the user sees the PR was not submitted and why; do not claim a PR exists. A new PR request resumes task ${run.id}.`,
      );
    }
    const reason = `The PR requested in this session (task ${run.id}) has not been created. Finish it with the tracetoon skill: digest --run ${run.id}, context, research, drafting, comic and review, then tracetoon publish --run ${run.id}, and relay its message. If it cannot be made, record task block --run ${run.id} --reason <actual problem> and tell the user.`;
    const key = createHash('sha256')
      .update(`${run.id}:${fingerprint}:${task.recoveryGeneration ?? 0}`)
      .digest('hex');
    const attempts = host.recoveries[key] ?? 0;
    if (attempts >= 2) {
      task.state = 'blocked';
      task.reason = 'Automatic PR recovery exhausted; resume this task explicitly.';
      saveTask(run, task);
      return continuation(
        agent,
        `Automatic recovery for the PR in task ${run.id} is exhausted. Tell the user the PR was not created, give the actual remaining issue and the resume command (tracetoon publish --run ${run.id} after preparing it), and do not claim a PR exists. The next stop is allowed.`,
      );
    }
    host.recoveries[key] = attempts + 1;
    host.recoveries = Object.fromEntries(Object.entries(host.recoveries).slice(-100));
    saveHost(id, host);
    return continuation(agent, reason);
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
