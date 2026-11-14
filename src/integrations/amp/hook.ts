/**
 * Amp's hook is a plugin: a TypeScript file in ~/.config/amp/plugins that Amp
 * runs with Bun. Its `tool.call` handler asks Tracetoon about shell commands
 * (found with Amp's own `shellCommandFromToolCall`) and returns
 * `{ action: 'reject-and-continue', message }` to block one; the agent is told
 * the message and carries on. It sends the OpenCode plugin's payload shape
 * (`source: "tracetoon-plugin"`, `host: "amp"`), so Tracetoon parses and
 * answers it the same way. A failure to run Tracetoon lets the call through.
 */
import type { HookCommands } from '../types.ts';

export const AMP_MARKER = '// tracetoon:amp-plugin';

export function renderAmpPlugin(commands: HookCommands): string {
  const a = commands.argv!;
  const argv = { prePr: a.prePr, pre: a.lifecycle('PreToolUse') };
  return `${AMP_MARKER} ${commands.prePr}
// Routes PR creation through Tracetoon. Written by \`tracetoon hook install\`;
// \`tracetoon hook uninstall\` removes it. Edits are overwritten.
import { spawnSync } from 'node:child_process';

const ARGV = ${JSON.stringify(argv)};

function ask(argv: string[], payload: unknown): string | undefined {
  try {
    const r = spawnSync(argv[0]!, argv.slice(1), {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const answer = JSON.parse((r.stdout || '').trim() || '{}');
    return answer.permission === 'deny' ? answer.reason : undefined;
  } catch {
    return undefined; // never get in the way when Tracetoon can't run
  }
}

export default function (amp: any) {
  amp.on('tool.call', async (event: any, ctx: any) => {
    const shell = amp.helpers?.shellCommandFromToolCall?.(event);
    if (!shell?.command) return { action: 'allow' };
    const payload = {
      source: 'tracetoon-plugin',
      host: 'amp',
      sessionID: event?.threadID ?? event?.thread?.id ?? ctx?.thread?.id,
      tool: event?.tool,
      args: { command: shell.command, ...(shell.cwd ? { cwd: shell.cwd } : {}) },
      directory: process.cwd(),
    };
    const reason = ask(ARGV.prePr, payload) || ask(ARGV.pre, payload);
    return reason ? { action: 'reject-and-continue', message: reason } : { action: 'allow' };
  });
}
`;
}

export function ampPluginCommand(text: string): string | undefined {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return first.startsWith(AMP_MARKER) ? first.slice(AMP_MARKER.length).trim() : undefined;
}
