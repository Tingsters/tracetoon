/**
 * The PR hook. Each agent calls `tracetoon hook pre-pr --agent <id>` before it
 * runs a shell command. If the command creates a PR (or rewrites a PR's title or
 * body) with `gh`, the hook stops it and tells the agent to use the Tracetoon
 * skill instead. Everything else passes untouched. Any error lets the command
 * through: the hook must never get in the way of normal work.
 */
import { switchState } from './switches.ts';

export type HookAgent = 'claude' | 'codex' | 'antigravity';

export const BYPASS_RE =
  /(^|[\s;&|(])TRACETOON=0\b|\$env:TRACETOON\s*=\s*['"]?0\b|\bset\s+"?TRACETOON=0\b/i;

const SEGMENT_SPLIT = /&&|\|\||;|\||\r?\n/;
// gh, gh.exe, a path to it, or a quoted path with spaces ("C:/Program Files/GitHub CLI/gh.exe").
const GH_PR_RE =
  /^(?:&\s*)?(?:"[^"]*[\\/]gh(?:\.exe)?"|'[^']*[\\/]gh(?:\.exe)?'|["']?(?:[^\s"']*[\\/])?gh(?:\.exe)?["']?)\s+pr\s+(create|new|edit)\b(.*)$/i;
const EDITS_TEXT_RE = /(^|\s)(--title|-t|--body|-b|--body-file|-F)(\s|=|$)/;

/** Whether a shell command creates a PR or rewrites its title/body with gh. */
export function writesPr(command: string): boolean {
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const seg = raw
      .trim()
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '') // VAR=value prefixes
      .replace(/^(?:sudo|command|exec|time)\s+/, '');
    const m = GH_PR_RE.exec(seg);
    if (!m) continue;
    const verb = m[1]!.toLowerCase();
    const rest = m[2] ?? '';
    if (verb === 'create' || verb === 'new') return true;
    // gh pr edit: only title/body changes, or a bare interactive edit.
    if (EDITS_TEXT_RE.test(rest)) return true;
    if (!/(^|\s)-/.test(rest)) return true;
  }
  return false;
}

export const DENY_REASON =
  'Tracetoon handles pull requests on this machine. Instead of running gh pr create/edit, use the tracetoon skill: ' +
  'it writes the description from your session logs and shows the user a preview before anything is posted. ' +
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
  const cwd = p.cwd ?? p.toolCall?.args?.Cwd ?? p.workspace;
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
  if (!command || !/\bgh(\.exe)?["']?\s+pr\b/i.test(command)) return undefined;
  if (BYPASS_RE.test(command) || !writesPr(command)) return undefined;
  if (!switchState(cwd ?? process.cwd(), env).enabled) return undefined;
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
