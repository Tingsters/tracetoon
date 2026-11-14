/**
 * The PR hook. Each agent calls `tracetoon hook pre-pr --agent <id>` before it
 * runs a shell command. If the command creates a PR, the hook stops it and tells the agent to use the Tracetoon
 * skill instead, which writes the description and comic and then creates the
 * PR. Any error lets the command through: the hook must never get in the way of
 * normal work.
 */
import { switchState } from './switches.ts';
import { leadingCd } from '../trace/pathMatch.ts';
import { splitCommands } from '../util/shell.ts';
import { otherPrWrite, commandWords, ghCreatesPr } from './prCommands.ts';
import { resolveHookHost } from '../integrations/registry.ts';
import type { Integration } from '../integrations/types.ts';

/** The id a host's hook passes as `--agent` (see src/integrations). */
export type HookAgent = string;

export const BYPASS_RE =
  /(^|[\s;&|(])TRACETOON=0\b|\$env:TRACETOON\s*=\s*['"]?0\b|\bset\s+"?TRACETOON=0\b/i;

/** Only actual PR creation is intercepted. Quoted examples are not commands. */
export function writesPr(command: string): boolean {
  return splitCommands(command).some((segment) => {
    const { program, args } = commandWords(segment);
    return (program === 'gh' && ghCreatesPr(args)) || !!otherPrWrite(segment);
  });
}

export const DENY_REASON =
  'Tracetoon handles PR creation on this machine: it writes the description from your session logs (and a comic, when enabled), then creates the PR. ' +
  "Instead of creating the PR directly (gh, hub, git pull-request, Git Town or the GitHub API), use the tracetoon skill and publish with tracetoon publish. Preserve the requested PR options, report the result, then continue the user's task. " +
  'Only if the user explicitly asked for a plain PR without Tracetoon, re-run the command with TRACETOON=0 in front ' +
  "(PowerShell: $env:TRACETOON='0'; ...).";

/**
 * The answer that blocks the command, in the format of the host that sent the
 * payload, or undefined to allow it.
 */
export function decide(
  agent: HookAgent,
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  /** Told which host the answer blocks for, so it can be written the way that host reads it. */
  onDeny?: (host: Integration) => void,
): string | undefined {
  const resolved = resolveHookHost(agent, payload);
  if (!resolved) return undefined;
  const { command, cwd } = resolved.payload;
  if (!command || BYPASS_RE.test(command)) return undefined;
  const effectiveCwd = leadingCd(command, cwd ?? process.cwd()) ?? cwd ?? process.cwd();
  if (!switchState(effectiveCwd, env).enabled) return undefined;
  if (!writesPr(command)) return undefined;
  onDeny?.(resolved.host);
  return resolved.host.hook!.deny(DENY_REASON);
}

/**
 * Write a hook's answer. A block for a host that reads exit status (Kiro) goes
 * to stderr with that status; everything else is printed for the host to parse.
 */
export function writeAnswer(answer: string, blockedFor?: Integration): void {
  const code = blockedFor?.hook?.blockExitCode;
  if (code === undefined) {
    process.stdout.write(answer + '\n');
    return;
  }
  process.stderr.write(answer + '\n');
  process.exitCode = code;
}

/** Read stdin with a time limit; an empty result means "allow". */
export async function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

export async function runPrHook(agent: HookAgent): Promise<void> {
  try {
    const raw = await readStdin();
    let blockedFor: Integration | undefined;
    const answer = raw
      ? decide(agent, JSON.parse(raw), process.env, (h) => (blockedFor = h))
      : undefined;
    if (answer) writeAnswer(answer, blockedFor);
  } catch {
    /* fail open */
  }
}
