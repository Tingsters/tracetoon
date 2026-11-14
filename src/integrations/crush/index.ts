/**
 * Crush (Charm). Hooks are read from the global config, crush.json in
 * $XDG_CONFIG_HOME/crush or ~/.config/crush (on Windows too), next to the
 * crushrc that overrides it. Tracetoon writes its entries to crush.json:
 * `hooks: { PreToolUse: [{ name, matcher, command, timeout }] }`, one flat
 * list per event. Payloads are Claude-style (`session_id`, `cwd`, `tool_name`,
 * `tool_input`); the shell tool is `bash`. `{ "decision": "deny", "reason" }`
 * on stdout blocks the call. Hooks run in Crush's embedded POSIX shell, on
 * Windows too. Skills are read from ~/.agents/skills.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeStyle } from '../../hook/claudeStyle.ts';
import { isOurs } from '../../hook/config.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, Integration, Json } from '../types.ts';
import { crushAdapter, crushDataDir } from './trace.ts';

const configDir = (h: string, env: Env) =>
  join(env.XDG_CONFIG_HOME || join(h, '.config'), 'crush');

const entry = (name: string, command: string, matcher?: string) => ({
  name,
  ...(matcher ? { matcher } : {}),
  command,
  timeout: 10,
});

const present = (h: string, env: Env) =>
  existsSync(crushDataDir(env, h)) ||
  existsSync(configDir(h, env)) ||
  !!onPath('crush', env);

export const integration: Integration = {
  id: 'crush',
  label: 'Crush',
  status: 'supported',
  traces: [crushAdapter],
  hook: {
    file: (h, env) => join(configDir(h, env), 'crush.json'),
    present,
    apply(data, commands) {
      const hooks: Json = {};
      for (const [event, list] of Object.entries<unknown>(data.hooks ?? {})) {
        const kept = Array.isArray(list)
          ? list.filter((h: Json) => !isOurs(h?.command))
          : list;
        if (!Array.isArray(kept) || kept.length) hooks[event] = kept;
      }
      if (commands) {
        const add = (event: string, h: Json) =>
          (hooks[event] = [...(hooks[event] ?? []), h]);
        add('PreToolUse', entry('tracetoon-pr', commands.prePr, '^bash$'));
        add('PreToolUse', entry('tracetoon-pre-tool', commands.lifecycle('PreToolUse')));
        add(
          'PostToolUse',
          entry('tracetoon-post-tool', commands.lifecycle('PostToolUse')),
        );
        add(
          'SessionStart',
          entry('tracetoon-session', commands.lifecycle('SessionStart')),
        );
      }
      const { hooks: _h, ...rest } = data;
      return Object.keys(hooks).length ? { ...rest, hooks } : rest;
    },
    installedCommand: (data) =>
      (Array.isArray(data.hooks?.PreToolUse) ? data.hooks.PreToolUse : [])
        .map((h: Json) => h?.command)
        .find((c: unknown) => isOurs(c) && (c as string).includes('hook pre-pr')),
    parse: parseClaudeStyle,
    deny: (reason) => JSON.stringify({ decision: 'deny', reason }),
  },
  skill: (h, env) => ({
    present: present(h, env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
};
