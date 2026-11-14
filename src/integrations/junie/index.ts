/**
 * JetBrains Junie (CLI): ~/.junie (JUNIE_HOME for Tracetoon). Skills are read
 * from ~/.junie/skills.
 *
 * Hooks sit under `hooks` in ~/.junie/config.json in Claude Code's layout
 * (`PreToolUse` groups with a regex `matcher`). The shell tool is `Bash`, or
 * `powershell` on Windows. Payloads are Claude-style, but `cwd` is Junie's own
 * folder: the repository is `project_path`. Junie ignores a JSON answer from a
 * PreToolUse hook in practice; exiting with status 2 blocks the call, and the
 * agent is shown stderr.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyClaudeStyle,
  installedClaudeStyle,
  parseClaudeStyle,
} from '../../hook/claudeStyle.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, HookPayload, Integration, Json } from '../types.ts';
import { junieAdapter } from './trace.ts';

const home = (h: string, env: Env) => env.JUNIE_HOME || join(h, '.junie');

function parse(raw: unknown): HookPayload | undefined {
  const p = parseClaudeStyle(raw);
  if (!p) return undefined;
  const project = (raw as Json).project_path;
  if (typeof project !== 'string' || !project.length) return p;
  // Junie runs hooks from its own folder; the work happens in the project.
  const own = p.toolInput.cwd ?? p.toolInput.workdir;
  return {
    ...p,
    cwd: typeof own === 'string' && own.length ? own : project,
    workspaceRoots: [project, ...p.workspaceRoots.filter((r) => r !== project)],
  };
}

const present = (h: string, env: Env) =>
  existsSync(home(h, env)) || !!onPath('junie', env);

export const integration: Integration = {
  id: 'junie',
  label: 'Junie',
  status: 'supported',
  traces: [junieAdapter],
  hook: {
    file: (h, env) => join(home(h, env), 'config.json'),
    present,
    apply: (data, commands) => applyClaudeStyle(data, commands, 'Bash|powershell'),
    installedCommand: installedClaudeStyle,
    parse,
    deny: (reason) => reason,
    blockExitCode: 2,
  },
  skill: (h, env) => ({
    present: present(h, env),
    dir: join(home(h, env), 'skills', 'tracetoon'),
  }),
};
