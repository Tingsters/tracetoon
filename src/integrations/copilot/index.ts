/**
 * GitHub Copilot: the CLI (`copilot`) and agent mode in VS Code.
 *
 * Hooks: Copilot loads every file in ~/.copilot/hooks/ (COPILOT_HOME overrides
 * ~/.copilot), so Tracetoon owns one file there, tracetoon.json, and never edits
 * another. Entries use `exec` + `args`, which start the program directly: on
 * Windows a shell `command` would run through PowerShell, where a quoted path
 * followed by arguments is a syntax error. Copilot denies the tool call when a
 * preToolUse hook errors (it fails closed), so the hook must always exit 0;
 * Tracetoon's hook commands do.
 *
 * Payloads are camelCase: `sessionId`, `cwd`, `toolName` (`powershell`, `bash`,
 * `apply_patch`, `view`, ...), `toolArgs` (an object such as `{ command }`, or the
 * raw patch text for apply_patch). The answer is `{ permissionDecision: "deny",
 * permissionDecisionReason }`. Inside tool calls the session id is
 * COPILOT_AGENT_SESSION_ID. Skills are read from ~/.agents/skills (shared with
 * Codex and Factory Droid) as well as ~/.copilot/skills.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOurs } from '../../hook/config.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, HookPayload, Integration, Json } from '../types.ts';
import { copilotCliAdapter, copilotVscodeAdapter } from './trace.ts';

const home = (h: string, env: Env) => env.COPILOT_HOME || join(h, '.copilot');
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);

const entry = (argv: string[]) => ({
  type: 'command',
  exec: argv[0],
  args: argv.slice(1),
  timeoutSec: 10,
});

/** An entry's command line, for display and recognition. */
const commandOf = (h: Json): string | undefined =>
  typeof h?.exec === 'string'
    ? [h.exec, ...(Array.isArray(h.args) ? h.args : [])].join(' ')
    : str(h?.command);

/** Matcher groups with Tracetoon's entries (exec or command form) taken out. */
function withoutOurs(groups: unknown): Json[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => {
    if (!g || !Array.isArray(g.hooks)) return [g];
    const kept = g.hooks.filter((h: Json) => !isOurs(commandOf(h)));
    if (kept.length === g.hooks.length) return [g];
    return kept.length ? [{ ...g, hooks: kept }] : [];
  });
}

function parse(raw: unknown): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  if (!('toolName' in p) && !('toolArgs' in p) && !('sessionId' in p && 'timestamp' in p))
    return undefined;
  let args: unknown = p.toolArgs;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object') args = parsed;
    } catch {
      /* raw text, such as an apply_patch envelope */
    }
  }
  const toolInput: Json =
    typeof args === 'string'
      ? { input: args }
      : args && typeof args === 'object'
        ? (args as Json)
        : {};
  return {
    command: str(toolInput.command),
    cwd: str(toolInput.cwd) ?? str(p.cwd),
    sessionId: str(p.sessionId),
    transcript: str(p.transcriptPath),
    toolName: str(p.toolName),
    toolInput,
    workspaceRoots: [],
    planMode: false,
    subagent: false,
  };
}

export const integration: Integration = {
  id: 'copilot',
  label: 'Copilot',
  status: 'supported',
  traces: [copilotCliAdapter, copilotVscodeAdapter],
  hook: {
    file: (h, env) => join(home(h, env), 'hooks', 'tracetoon.json'),
    present: (h, env) => existsSync(home(h, env)),
    apply(data, commands) {
      // The file is Tracetoon's, but anything someone added to it is kept.
      const a = commands?.argv;
      const ours: Record<string, Json[]> = a
        ? {
            preToolUse: [
              { matcher: 'bash|powershell', hooks: [entry(a.prePr)] },
              { hooks: [entry(a.lifecycle('PreToolUse'))] },
            ],
            postToolUse: [{ hooks: [entry(a.lifecycle('PostToolUse'))] }],
            sessionStart: [{ hooks: [entry(a.lifecycle('SessionStart'))] }],
          }
        : {};
      const hooks: Json = {};
      for (const [event, groups] of Object.entries<unknown>(data.hooks ?? {})) {
        const kept = withoutOurs(groups);
        if (kept.length) hooks[event] = kept;
      }
      for (const [event, groups] of Object.entries(ours))
        hooks[event] = [...(hooks[event] ?? []), ...groups];
      const { version: _v, hooks: _h, ...rest } = data;
      if (!Object.keys(hooks).length) return rest;
      return { version: 1, ...rest, hooks };
    },
    installedCommand: (data) =>
      (Array.isArray(data.hooks?.preToolUse) ? data.hooks.preToolUse : [])
        .flatMap((g: Json) => (Array.isArray(g?.hooks) ? g.hooks : []))
        .map(commandOf)
        .find((c: string | undefined) => isOurs(c) && c!.includes('hook pre-pr')),
    parse,
    deny: (reason) =>
      JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }),
  },
  skill: (h, env) => ({
    present: existsSync(home(h, env)) || !!onPath('copilot', env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
  sessionEnv: ['COPILOT_AGENT_SESSION_ID'],
  hostEnv: /^(COPILOT_AGENT_SESSION_ID|COPILOT_HOOK_DEPTH|COPILOT_HOOK_DIR)$/,
};
