/**
 * Cline: the Cline CLI (3.x) and the VS Code extension (4.x), which share
 * ~/.cline. Skills are read from ~/.agents/skills (shared with Codex). The CLI's
 * hooks are event-named scripts in ~/.cline/hooks (see ./hook.ts); the
 * extension runs PreToolUse(.ps1 on Windows) from ~/Documents/Cline/Hooks
 * instead, with the older payload (`preToolUse: { toolName, parameters }`).
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
  renderClinePowerShell,
  renderClinePre,
  renderClineShell,
} from './hook.ts';
import { clineAdapter } from './trace.ts';

const home = (h: string) => join(h, '.cline');
/** From ~/.cline/hooks to the VS Code extension's ~/Documents/Cline/Hooks. */
const EXTENSION_HOOKS = '../../Documents/Cline/Hooks';
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);

function parse(raw: unknown): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  if (typeof p.hookName !== 'string' || !('taskId' in p || 'sessionContext' in p))
    return undefined;
  // The VS Code extension's PowerShell hooks get the older shape instead.
  const legacy: Json | undefined = p.preToolUse ?? p.postToolUse;
  const call: Json =
    p.tool_call ??
    p.tool_result ??
    (legacy ? { name: legacy.toolName, input: legacy.parameters } : {});
  const toolInput: Json = call.input && typeof call.input === 'object' ? call.input : {};
  // Cline 3.x sends a list; 4.x (the VS Code extension) sends one string.
  const commands: string[] = Array.isArray(toolInput.commands)
    ? toolInput.commands.filter((c: unknown) => typeof c === 'string')
    : typeof toolInput.commands === 'string'
      ? [toolInput.commands]
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
  variants: 'CLI and VS Code extension',
  limits: [
    'PRs opened through GitHub connector or MCP tools are not redirected; `gh` and other shell commands are.',
    'In the VS Code extension, a blocked PR command stops the task, since its hooks cannot skip a single command.',
  ],
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
        // The VS Code extension reads hooks from ~/Documents/Cline/Hooks only:
        // PreToolUse.ps1 on Windows, an executable PreToolUse elsewhere.
        ...(process.platform === 'win32'
          ? { [`${EXTENSION_HOOKS}/PreToolUse.ps1`]: renderClinePowerShell }
          : { [`${EXTENSION_HOOKS}/PreToolUse`]: renderClineShell }),
      },
      executable: [`${EXTENSION_HOOKS}/PreToolUse`],
    },
    parse,
    deny: denyCline,
  },
  skill: (h, env) => ({
    present: present(h, env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
};
