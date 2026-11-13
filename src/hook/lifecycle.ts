/** Passive host observations and PR creation routing. Hooks never run models or checks. */
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readLocal, writeLocal } from '../util/localJson.ts';
import {
  beginTask,
  repository,
  saveTask,
  tasks,
  workFingerprint,
} from '../workflow/state.ts';
import { readHost, rememberRepository } from '../workflow/hostSession.ts';
import { readStdin, type HookAgent, BYPASS_RE } from './prHook.ts';
import { integration, resolveHookHost } from '../integrations/registry.ts';
import type { HookPayload } from '../integrations/types.ts';
import { switchState } from './switches.ts';
import { leadingCd } from '../trace/pathMatch.ts';
import type { Approval } from '../commands/publish.ts';
import { BUILD_INFO } from '../version.ts';
import { userConfigPath } from '../config.ts';
import { publicationTargets } from './publicationTarget.ts';
import { updateNotice } from '../update/state.ts';

// Stop remains accepted for installed hooks from older releases, but is inert.
export type LifecycleEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop';

const EMPTY_PAYLOAD: HookPayload = {
  toolInput: {},
  workspaceRoots: [],
  planMode: false,
  subagent: false,
};

function payloadRoots(p: HookPayload): string[] {
  const input = p.toolInput;
  const { command, cwd } = p;
  const base =
    input.workdir ??
    input.cwd ??
    input.Cwd ??
    cwd ??
    p.workspaceRoots[0] ??
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

export function lifecycle(
  agent: HookAgent,
  event: LifecycleEvent,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (event === 'Stop') return;
  // A payload no host recognizes is observed as empty under the registered host:
  // it can't name a session or a command, but SessionStart still gets the notice.
  const registered = integration(agent);
  const resolved =
    resolveHookHost(agent, raw) ??
    (registered?.hook ? { host: registered, payload: EMPTY_PAYLOAD } : undefined);
  if (!resolved) return;
  const { host: sender, payload: p } = resolved;
  const deny = (reason: string) => sender.hook!.deny(reason);
  const cwd = p.cwd ?? p.workspaceRoots[0] ?? process.cwd();
  const state = switchState(cwd, env);
  if (
    (!state.enabled && !['repo', 'local'].includes(state.decidedBy)) ||
    p.planMode ||
    p.subagent
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
  // Said at the end of the session start; reads only local files.
  const notice = event === 'SessionStart' ? updateNotice(agent, env) : undefined;
  const id = p.sessionId;
  const command = p.command;
  if (command && BYPASS_RE.test(command)) return;
  if (!id) return notice; // No shared anonymous registry.
  const transcript = p.transcript;
  let host = readHost(id);
  const allRoots = payloadRoots(p);
  for (const root of allRoots.filter((r) => switchState(r, env).enabled)) {
    const observed = host.repos.find((r) => r.root === root);
    if (!observed || (transcript && transcript !== host.transcript))
      rememberRepository(
        id,
        root,
        observed?.baseline ?? workFingerprint(root),
        transcript,
      );
  }
  if (event !== 'PreToolUse') return notice;
  host = readHost(id);
  const targets = publicationTargets(p, [...allRoots, ...host.repos.map((r) => r.root)]);
  if (targets?.kind !== 'pr') return;
  if (!targets.roots.length)
    return deny(
      'Resolve the actual repository/worktree for this PR and create it with Tracetoon. No local target could be checked.',
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
          readLocal<Approval>(join(t.run.dir, 'approval.json'))?.workspaceFingerprint ===
            fingerprint,
      );
      if (published)
        return deny(
          `This snapshot already has a PR. Use tracetoon publish --run ${published.run.id} to retrieve or reconcile it, then continue the user's task.`,
        );
      const started = beginTask(root, {
        session: id,
        transcript: transcript ?? host.transcript,
      });
      started.task.baseline =
        host.repos.find((r) => r.root === root)?.baseline ?? 'unclassified-publication';
      saveTask(started.run, started.task);
      active = started;
    }
    const task = active.task;
    task.prRequestedAt ??= new Date().toISOString();
    task.prRequestedBy = id;
    if (task.state === 'blocked' || task.state === 'deferred') {
      task.state = 'preparing';
      task.reason = undefined;
    }
    saveTask(active.run, task);
    return deny(
      `Task ${active.run.id}: make this PR with the tracetoon skill, using tracetoon publish --run ${active.run.id}; it writes the description and comic, then creates the PR without a routine approval step. Preserve the requested repository, branches, draft status and metadata. Report the result, then continue the user's task. Only PR creation is intercepted.`,
    );
  }
}

export async function runLifecycle(agent: HookAgent, event: LifecycleEvent) {
  try {
    const raw = await readStdin();
    const answer = raw ? lifecycle(agent, event, JSON.parse(raw)) : undefined;
    if (answer) process.stdout.write(answer + '\n');
  } catch (e) {
    // Observation failures never interrupt work; diagnostics are available in doctor.
    try {
      writeLocal(join(dirname(userConfigPath()), 'last-hook-error.json'), {
        agent,
        event,
        at: new Date().toISOString(),
        error: (e as Error).message,
      });
    } catch {
      /* best effort */
    }
  }
}
