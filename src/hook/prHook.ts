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

export type HookAgent = 'claude' | 'codex' | 'antigravity';

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

/** The command string from each agent's hook payload. */
export function commandFrom(payload: unknown): { command?: string; cwd?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const p = payload as Record<string, any>;
  let command: unknown =
    p.tool_input?.command ??
    p.toolCall?.args?.CommandLine ??
    p.tool_call?.args?.CommandLine;
  if (typeof command === 'string' && /^\s*".*"\s*$/s.test(command)) {
    try {
      const unwrapped = JSON.parse(command); // Antigravity IDE double-encodes args
      if (typeof unwrapped === 'string') command = unwrapped;
    } catch {
      /* keep as is */
    }
  }
  const cwd =
    p.tool_input?.workdir ??
    p.tool_input?.cwd ??
    p.toolCall?.args?.Cwd ??
    p.cwd ??
    p.workspace;
  return {
    command: typeof command === 'string' ? command : undefined,
    cwd: typeof cwd === 'string' ? cwd : undefined,
  };
}

/** The agent-specific answer that blocks the command, or undefined to allow it. */
export function decide(
  agent: HookAgent,
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const { command, cwd } = commandFrom(payload);
  if (!command || BYPASS_RE.test(command)) return undefined;
  const effectiveCwd = leadingCd(command, cwd ?? process.cwd()) ?? cwd ?? process.cwd();
  if (!switchState(effectiveCwd, env).enabled) return undefined;
  if (!writesPr(command)) return undefined;
  if (agent === 'antigravity')
    return JSON.stringify({ decision: 'deny', reason: DENY_REASON });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  });
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
    const answer = raw ? decide(agent, JSON.parse(raw)) : undefined;
    if (answer) process.stdout.write(answer + '\n');
  } catch {
    /* fail open */
  }
}
