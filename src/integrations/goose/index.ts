/**
 * Goose (AAIF, formerly Block): the goose CLI and desktop app.
 *
 * Hooks come from plugins in ~/.agents/plugins/<name>/: a plugin.json manifest
 * and hooks/hooks.json in Claude Code's layout. Tracetoon owns the
 * ~/.agents/plugins/tracetoon folder outright. Payloads carry `event`,
 * `session_id`, `tool_name` (the shell tool is `shell`), `tool_input` and
 * `working_dir`; `{ "decision": "block", "reason" }` on stdout blocks the call
 * and the agent is told the reason. Skills are read from ~/.agents/skills.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyClaudeStyle } from '../../hook/claudeStyle.ts';
import { prePrIn } from '../../hook/config.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, HookCommands, HookPayload, Integration, Json } from '../types.ts';
import { gooseAdapter, gooseDataDir } from './trace.ts';

const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);
const PLUGIN = { name: 'tracetoon', version: '1.0.0' };

function parse(raw: unknown): HookPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Json;
  if (typeof p.event !== 'string' || !('working_dir' in p || 'session_id' in p))
    return undefined;
  const toolInput: Json =
    p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const dir = str(p.working_dir);
  return {
    command: str(toolInput.command),
    cwd: str(toolInput.cwd) ?? dir,
    sessionId: str(p.session_id),
    toolName: str(p.tool_name),
    toolInput,
    workspaceRoots: dir ? [dir] : [],
    planMode: false,
    subagent: false,
  };
}

/** The pre-pr command in a hooks.json Tracetoon wrote, or that it is the manifest. */
function command(text: string): string | undefined {
  try {
    const data = JSON.parse(text);
    if (data?.name === PLUGIN.name && typeof data.description === 'string')
      return data.description.startsWith('Tracetoon')
        ? 'tracetoon plugin manifest'
        : undefined;
    return prePrIn(data?.hooks?.PreToolUse);
  } catch {
    return undefined;
  }
}

const render = (commands: HookCommands) =>
  JSON.stringify(applyClaudeStyle({}, commands, '^shell$'), null, 2) + '\n';

const NO_SH =
  "Goose runs plugin hooks with `sh`, which isn't on PATH: add Git for Windows' usr\\bin folder to PATH so the hook can run.";
const needsSh = (env: Env = process.env) =>
  process.platform === 'win32' && !onPath('sh', env);

const present = (h: string, env: Env) =>
  existsSync(gooseDataDir(env, h)) || !!onPath('goose', env);

export const integration: Integration = {
  id: 'goose',
  label: 'Goose',
  status: 'supported',
  traces: [gooseAdapter],
  hook: {
    file: (h) => join(h, '.agents', 'plugins', 'tracetoon', 'hooks', 'hooks.json'),
    present,
    apply: (data) => data,
    installedCommand: () => undefined,
    text: {
      render,
      command,
      siblings: {
        '../plugin.json': () =>
          JSON.stringify(
            {
              ...PLUGIN,
              description:
                'Tracetoon: routes PR creation through Tracetoon. Written by `tracetoon hook install`.',
            },
            null,
            2,
          ) + '\n',
      },
    },
    parse,
    deny: (reason) => JSON.stringify({ decision: 'block', reason }),
    // Goose starts every hook with `sh -c`, Windows included.
    installNote: () => (needsSh() ? NO_SH : undefined),
    problem: () => (needsSh() ? NO_SH : undefined),
  },
  skill: (h, env) => ({
    present: present(h, env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
};
