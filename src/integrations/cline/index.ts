/**
 * Cline: the Cline CLI (3.x) and the SDK it shares, in ~/.cline. Skills are read
 * from ~/.agents/skills (shared with Codex). Hooks are event-named scripts in
 * ~/.cline/hooks (see ./hook.ts).
 *
 * Payloads: `{ hookName, taskId, sessionContext: { rootSessionId },
 * workspaceRoots, tool_call: { id, name, input } }` before a tool and
 * `tool_result` after it. Shell tools are `run_commands` (`commands`, a list)
 * and `execute_command` (`command`). The session id that names the log folder
 * is `sessionContext.rootSessionId`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { onPath } from '../../util/onPath.ts';
import type { Env, HookPayload, Integration, Json } from '../types.ts';
import {
  clineHookCommand,
  denyCline,
  renderClineObserver,
  renderClinePre,
} from './hook.ts';
import { clineAdapter } from './trace.ts';

const home = (h: string) => join(h, '.cline');
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);

function parse(raw: unknown): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  if (typeof p.hookName !== 'string' || !('taskId' in p || 'sessionContext' in p))
    return undefined;
  const call: Json = p.tool_call ?? p.tool_result ?? {};
  const toolInput: Json = call.input && typeof call.input === 'object' ? call.input : {};
  const commands = Array.isArray(toolInput.commands)
    ? toolInput.commands.filter((c: unknown) => typeof c === 'string')
    : [];
  const roots: string[] = Array.isArray(p.workspaceRoots)
    ? p.workspaceRoots.filter((r: unknown) => typeof r === 'string' && r.length)
    : [];
  return {
    command: commands.length ? commands.join('\n') : str(toolInput.command),
    cwd: str(toolInput.cwd) ?? roots[0] ?? str(p.workspaceInfo?.rootPath),
    sessionId: str(p.sessionContext?.rootSessionId) ?? str(p.taskId),
    toolName: str(call.name),
    toolInput,
    workspaceRoots: roots,
    planMode: false,
    subagent: !!p.parent_agent_id,
  };
}

const present = (h: string, env: Env) => existsSync(home(h)) || !!onPath('cline', env);

export const integration: Integration = {
  id: 'cline',
  label: 'Cline',
  status: 'supported',
  traces: [clineAdapter],
  hook: {
    file: (h) => join(home(h), 'hooks', 'PreToolUse.mjs'),
    present,
    apply: (data) => data,
    installedCommand: () => undefined,
    text: {
      render: renderClinePre,
      command: clineHookCommand,
      siblings: {
        'PostToolUse.mjs': (c) => renderClineObserver(c, 'PostToolUse'),
        'TaskStart.mjs': (c) => renderClineObserver(c, 'SessionStart'),
      },
    },
    parse,
    deny: denyCline,
  },
  skill: (h, env) => ({
    present: present(h, env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
};
