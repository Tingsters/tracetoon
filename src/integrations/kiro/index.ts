/**
 * Kiro (AWS): the Kiro IDE and Kiro CLI, which share ~/.kiro (KIRO_HOME for
 * Tracetoon). Skills are read from ~/.kiro/skills.
 *
 * Hooks: Kiro loads every file in ~/.kiro/hooks/, so Tracetoon owns one,
 * tracetoon.json: `{ version: "v1", hooks: [{ name, trigger, matcher, action:
 * { type: "command", command }, timeout, enabled }] }`. The `shell` matcher
 * covers execute_pwsh and execute_bash. Payloads are Claude-style
 * (`session_id`, `hook_event_name`, `cwd`, `tool_name`, `tool_input`), but Kiro
 * ignores a JSON answer on stdout: a PreToolUse hook blocks the call by exiting
 * with status 2, and its stderr is what the agent is told. Inside tool calls the
 * session id is KIRO_SESSION_ID.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeStyle } from '../../hook/claudeStyle.ts';
import { isOurs } from '../../hook/config.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, Integration, Json } from '../types.ts';
import { kiroAdapter } from './trace.ts';

const home = (h: string, env: Env) => env.KIRO_HOME || join(h, '.kiro');

const entry = (name: string, trigger: string, command: string, matcher?: string) => ({
  name,
  trigger,
  ...(matcher ? { matcher } : {}),
  action: { type: 'command', command },
  timeout: 10,
  enabled: true,
});

const ours = (h: Json) => isOurs(h?.action?.command);

export const integration: Integration = {
  id: 'kiro',
  label: 'Kiro',
  status: 'supported',
  variants: 'IDE and CLI',
  traces: [kiroAdapter],
  hook: {
    file: (h, env) => join(home(h, env), 'hooks', 'tracetoon.json'),
    present: (h, env) =>
      existsSync(home(h, env)) || !!onPath('kiro-cli', env) || !!onPath('kiro', env),
    apply(data, commands) {
      // The file is Tracetoon's, but anything someone added to it is kept.
      const kept: Json[] = (Array.isArray(data.hooks) ? data.hooks : []).filter(
        (h: Json) => !ours(h),
      );
      if (commands)
        kept.push(
          entry('tracetoon-pr', 'PreToolUse', commands.prePr, 'shell'),
          entry('tracetoon-pre-tool', 'PreToolUse', commands.lifecycle('PreToolUse')),
          entry('tracetoon-post-tool', 'PostToolUse', commands.lifecycle('PostToolUse')),
          entry('tracetoon-session', 'SessionStart', commands.lifecycle('SessionStart')),
        );
      const { version: _v, hooks: _h, ...rest } = data;
      if (!kept.length) return rest;
      return { version: 'v1', ...rest, hooks: kept };
    },
    installedCommand: (data) =>
      (Array.isArray(data.hooks) ? data.hooks : [])
        .filter((h: Json) => h?.trigger === 'PreToolUse' && ours(h))
        .map((h: Json) => h.action.command as string)
        .find((c: string) => c.includes('hook pre-pr')),
    parse: parseClaudeStyle,
    deny: (reason) => reason,
    blockExitCode: 2,
  },
  skill: (h, env) => ({
    present:
      existsSync(home(h, env)) || !!onPath('kiro-cli', env) || !!onPath('kiro', env),
    dir: join(home(h, env), 'skills', 'tracetoon'),
  }),
  sessionEnv: ['KIRO_SESSION_ID'],
  hostEnv: /^KIRO_/,
};
