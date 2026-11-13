/**
 * Cursor: the IDE's agent and the `agent` CLI. ~/.cursor (CURSOR_HOME overrides
 * it for Tracetoon).
 *
 * Hooks: ~/.cursor/hooks.json, `{ version: 1, hooks: { <event>: [{ command,
 * matcher?, timeout? }] } }`, shared with other tools, so only Tracetoon's
 * entries are touched. On Windows Cursor runs a hook command through
 * PowerShell, so the command starts with `&` and a quoted program path; a hook
 * that errors lets the action through (Cursor fails open by default).
 * `beforeShellExecution` gets `{ command, cwd }` and is the PR route; the
 * lifecycle observes `sessionStart`, `preToolUse` and `postToolUse`, whose
 * payloads are snake_case (`conversation_id`, `tool_name`, `tool_input`,
 * `workspace_roots`). The answer is `{ permission: "deny", agent_message }`.
 *
 * Cursor also runs Claude Code's hooks from ~/.claude/settings.json; those
 * answer in Claude Code's format, which Cursor reads for imported hooks.
 * Inside tool calls the session id is CURSOR_CONVERSATION_ID. Skills are read
 * from ~/.agents/skills (shared with Codex, Factory Droid and Copilot).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOurs, withoutOurGroups } from '../../hook/config.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, HookCommands, HookPayload, Integration, Json } from '../types.ts';
import { cursorAdapter } from './trace.ts';

const home = (h: string, env: Env) => env.CURSOR_HOME || join(h, '.cursor');
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);

/** A hook command line Cursor's shell runs: PowerShell on Windows, sh elsewhere. */
function line(argv: string[]): string {
  const [program, ...args] = argv;
  if (process.platform === 'win32') return `& "${program}" ${args.join(' ')}`;
  return [/\s/.test(program!) ? `"${program}"` : program, ...args].join(' ');
}

/** Entries with Tracetoon's taken out, whether listed directly or in Claude-style groups. */
function withoutOurs(entries: unknown): Json[] {
  if (!Array.isArray(entries)) return [];
  return withoutOurGroups(entries.filter((e) => !isOurs(e?.command)));
}

/** The program path and arguments, without the PowerShell call operator and quotes. */
const plain = (command: string) => command.replace(/^&\s+"([^"]+)"/, '$1');

function ours(commands: HookCommands): Record<string, Json[]> {
  const a = commands.argv!;
  const entry = (argv: string[], extra: Json = {}) => ({
    command: line(argv),
    timeout: 10,
    ...extra,
  });
  return {
    beforeShellExecution: [entry(a.prePr)],
    preToolUse: [entry(a.lifecycle('PreToolUse'))],
    postToolUse: [entry(a.lifecycle('PostToolUse'))],
    sessionStart: [entry(a.lifecycle('SessionStart'))],
  };
}

function parse(raw: unknown): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  if (!('conversation_id' in p) && !('cursor_version' in p)) return undefined;
  const input: Json =
    p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const roots = Array.isArray(p.workspace_roots)
    ? p.workspace_roots.filter((r: unknown) => typeof r === 'string')
    : [];
  return {
    command: str(p.command) ?? str(input.command),
    cwd: str(p.cwd) ?? str(input.cwd) ?? str(input.working_directory),
    sessionId: str(p.conversation_id) ?? str(p.session_id),
    transcript: str(p.transcript_path),
    toolName: str(p.tool_name),
    toolInput: input,
    workspaceRoots: roots,
    planMode: false,
    subagent: !!p.is_subagent,
  };
}

export const integration: Integration = {
  id: 'cursor',
  label: 'Cursor',
  status: 'supported',
  traces: [cursorAdapter],
  hook: {
    file: (h, env) => join(home(h, env), 'hooks.json'),
    present: (h, env) => existsSync(home(h, env)),
    apply(data, commands) {
      const add = commands?.argv ? ours(commands) : {};
      const hooks: Json = {};
      for (const [event, entries] of Object.entries<unknown>(data.hooks ?? {})) {
        const kept = withoutOurs(entries);
        if (kept.length) hooks[event] = kept;
      }
      for (const [event, entries] of Object.entries(add))
        hooks[event] = [...(hooks[event] ?? []), ...entries];
      const { hooks: _h, version, ...rest } = data;
      if (!Object.keys(hooks).length)
        return Object.keys(rest).length ? { version, ...rest } : rest;
      return { version: version ?? 1, ...rest, hooks };
    },
    installedCommand: (data) =>
      (Array.isArray(data.hooks?.beforeShellExecution)
        ? data.hooks.beforeShellExecution
        : []
      )
        .map((e: Json) => e?.command)
        .filter((c: unknown): c is string => isOurs(c) && c.includes('hook pre-pr'))
        .map(plain)[0],
    parse,
    deny: (reason) =>
      JSON.stringify({
        permission: 'deny',
        agent_message: reason,
        user_message: 'Tracetoon creates this PR.',
      }),
  },
  skill: (h, env) => ({
    present:
      existsSync(home(h, env)) || !!onPath('agent', env) || !!onPath('cursor', env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
  sessionEnv: ['CURSOR_CONVERSATION_ID'],
  hostEnv:
    /^(CURSOR_CONVERSATION_ID|CURSOR_REQUEST_ID|CURSOR_AGENT|CURSOR_INVOKED_AS|__CURSOR_SANDBOX_ENV_RESTORE)$/,
};
