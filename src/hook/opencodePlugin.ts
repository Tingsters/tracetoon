/**
 * The hook for hosts with OpenCode's plugin system (OpenCode, Kilo CLI): a small
 * JavaScript plugin, written into the host's plugins folder, that runs
 * Tracetoon's hook commands and throws when one denies the tool call (the host
 * shows the error to the agent). A failure to run Tracetoon lets the call
 * through. Payloads are `{ source: "tracetoon-plugin", host, sessionID, tool,
 * callID, args, directory }`.
 */
import type { HookCommands, HookPayload, Json } from '../integrations/types.ts';

export const PLUGIN_MARKER = '// tracetoon:plugin';

/** The plugin source for `host`, running the given commands. */
export function renderOpencodePlugin(host: string, commands: HookCommands): string {
  const a = commands.argv!;
  const argv = {
    prePr: a.prePr,
    pre: a.lifecycle('PreToolUse'),
    post: a.lifecycle('PostToolUse'),
    start: a.lifecycle('SessionStart'),
  };
  return `${PLUGIN_MARKER} ${commands.prePr}
// Routes PR creation through Tracetoon. Written by \`tracetoon hook install\`;
// \`tracetoon hook uninstall\` removes it. Edits are overwritten.
import { spawn, spawnSync } from 'node:child_process';

const HOST = ${JSON.stringify(host)};
const ARGV = ${JSON.stringify(argv)};
// Shell tools, and GitHub tools that could open a PR through a connector.
const GUARDED = /^(bash|shell)$|github|pull_request/i;

function ask(argv, payload) {
  try {
    const r = spawnSync(argv[0], argv.slice(1), {
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

function tell(argv, payload) {
  try {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      detached: true,
    });
    child.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch {}
}

export const Tracetoon = async ({ directory }) => {
  const payload = (input, args) => ({
    source: 'tracetoon-plugin',
    host: HOST,
    sessionID: input?.sessionID,
    tool: input?.tool,
    callID: input?.callID,
    args: args || {},
    directory,
  });
  return {
    'tool.execute.before': async (input, output) => {
      if (!GUARDED.test(String(input?.tool || ''))) return;
      const p = payload(input, output?.args);
      const reason = ask(ARGV.prePr, p) || ask(ARGV.pre, p);
      if (reason) throw new Error(reason);
    },
    'tool.execute.after': async (input, output) => tell(ARGV.post, payload(input, output?.args)),
    event: async ({ event }) => {
      if (event?.type === 'session.created')
        tell(ARGV.start, payload({ sessionID: event.properties?.sessionID }, {}));
    },
  };
};
`;
}

/** The pre-pr command line a written plugin runs, from its first line. */
export function opencodePluginCommand(text: string): string | undefined {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return first.startsWith(PLUGIN_MARKER)
    ? first.slice(PLUGIN_MARKER.length).trim()
    : undefined;
}

const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);

/** A payload the plugin sent for `host`, or undefined. */
export function parseOpencodePayload(
  raw: unknown,
  host: string,
): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  if (p.source !== 'tracetoon-plugin' || p.host !== host) return undefined;
  const args: Json = p.args && typeof p.args === 'object' ? p.args : {};
  return {
    command: str(args.command),
    cwd: str(args.workdir) ?? str(args.cwd) ?? str(p.directory),
    sessionId: str(p.sessionID),
    toolName: str(p.tool),
    toolInput: args,
    workspaceRoots: str(p.directory) ? [p.directory] : [],
    planMode: false,
    subagent: false,
  };
}

export const denyOpencode = (reason: string) =>
  JSON.stringify({ permission: 'deny', reason });
