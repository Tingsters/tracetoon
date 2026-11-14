/**
 * Cline's file hooks: one script per event in ~/.cline/hooks, named after the
 * event (PreToolUse.mjs, PostToolUse.mjs, TaskStart.mjs). Cline runs a `.mjs`
 * file with Node, which the Cline CLI always has, passes the event as JSON on
 * stdin and reads a JSON object from stdout.
 *
 * A hook can't skip just one tool call: `cancel` stops the whole run. So a
 * blocked PR command is replaced instead (`overrideInput`) with an `echo` of
 * the reason, and the reason is also added to the agent's next turn
 * (`errorMessage` without `cancel`). Failures to run Tracetoon let the call
 * through unchanged.
 */
import type { HookCommands } from '../types.ts';

export const CLINE_MARKER = '// tracetoon:cline-hook';

const header = (commands: HookCommands) => `${CLINE_MARKER} ${commands.prePr}
// Routes PR creation through Tracetoon. Written by \`tracetoon hook install\`;
// \`tracetoon hook uninstall\` removes it. Edits are overwritten.
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {}

function tell(argv) {
  try {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      detached: true,
    });
    child.on('error', () => {});
    child.stdin.end(input);
    child.unref();
  } catch {}
}
`;

/** The PreToolUse script: PR routing and the lifecycle observer on shell tools. */
export function renderClinePre(commands: HookCommands): string {
  const a = commands.argv!;
  return `${header(commands)}
const ARGV = ${JSON.stringify({ prePr: a.prePr, pre: a.lifecycle('PreToolUse') })};
const SHELL = new Set(['run_commands', 'execute_command']);

function ask(argv) {
  try {
    const r = spawnSync(argv[0], argv.slice(1), {
      input,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const answer = JSON.parse((r.stdout || '').trim() || 'null');
    return answer && typeof answer === 'object' ? answer : undefined;
  } catch {
    return undefined; // never get in the way when Tracetoon can't run
  }
}

let out = {};
try {
  const tool = JSON.parse(input || '{}')?.tool_call?.name;
  if (SHELL.has(tool)) {
    out = ask(ARGV.prePr) || ask(ARGV.pre) || {};
    // execute_command takes one command, run_commands a list.
    if (tool === 'execute_command' && out.overrideInput?.commands)
      out.overrideInput = { command: out.overrideInput.commands.join('\\n') };
  } else tell(ARGV.pre);
} catch {}
process.stdout.write(JSON.stringify(out));
`;
}

/** A script that only reports the event to Tracetoon and lets Cline continue. */
export function renderClineObserver(commands: HookCommands, event: string): string {
  return `${header(commands)}
tell(${JSON.stringify(commands.argv!.lifecycle(event))});
process.stdout.write('{}');
`;
}

/** The pre-pr command line a written hook runs, from its first line. */
export function clineHookCommand(text: string): string | undefined {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return first.startsWith(CLINE_MARKER)
    ? first.slice(CLINE_MARKER.length).trim()
    : undefined;
}

/**
 * The answer that blocks a shell call: the command is replaced by an echo of
 * the reason (quotes made safe for PowerShell, cmd and sh alike), and the reason
 * is added to the agent's next turn.
 */
export function denyCline(reason: string): string {
  // PowerShell treats curly quotes as quotes too, so all of them become ".
  const said = reason
    .replace(/['‘’‚‛]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return JSON.stringify({
    overrideInput: { commands: [`echo 'Blocked by Tracetoon. ${said}'`] },
    errorMessage: reason,
  });
}
