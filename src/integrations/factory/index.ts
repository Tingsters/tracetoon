/**
 * Factory Droid: ~/.factory (FACTORY_HOME overrides it for Tracetoon).
 *
 * Hooks follow Claude Code's protocol (`PreToolUse` groups, `tool_input.command`,
 * `hookSpecificOutput.permissionDecision`); the shell tool is `Execute`. They
 * live in ~/.factory/hooks.json as a bare event map. Droid reads the `hooks` key
 * of ~/.factory/settings.json only when hooks.json is absent, so when a user's
 * hooks are already there, Tracetoon adds its own there too rather than
 * creating a hooks.json that would hide them. Skills are read from
 * ~/.agents/skills (shared with Codex) as well as ~/.factory/skills.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyClaudeStyle,
  denyClaudeStyle,
  installedClaudeStyle,
  parseClaudeStyle,
} from '../../hook/claudeStyle.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, HookPayload, Integration, Json } from '../types.ts';
import { factoryAdapter } from './trace.ts';

const home = (h: string, env: Env) => env.FACTORY_HOME || join(h, '.factory');

function settingsHaveHooks(file: string): boolean {
  try {
    const hooks = JSON.parse(readFileSync(file, 'utf8'))?.hooks;
    return !!hooks && typeof hooks === 'object' && Object.keys(hooks).length > 0;
  } catch {
    return false;
  }
}

/** settings.json carries a `hooks` object; hooks.json is the event map itself. */
const layoutOf = (data: Json) =>
  data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)
    ? 'nested'
    : 'top';

function parse(raw: unknown): HookPayload | undefined {
  const p = parseClaudeStyle(raw);
  // Droid's "spec" mode plans before it acts, like plan mode elsewhere.
  if (p && (raw as Json).permission_mode === 'spec') p.planMode = true;
  return p;
}

export const integration: Integration = {
  id: 'factory',
  label: 'Factory Droid',
  status: 'supported',
  traces: [factoryAdapter],
  hook: {
    file(h, env) {
      const hooksJson = join(home(h, env), 'hooks.json');
      const settings = join(home(h, env), 'settings.json');
      return !existsSync(hooksJson) && settingsHaveHooks(settings) ? settings : hooksJson;
    },
    present: (h, env) => existsSync(home(h, env)),
    apply: (data, commands) =>
      applyClaudeStyle(data, commands, 'Execute', layoutOf(data)),
    installedCommand: (data) => installedClaudeStyle(data, layoutOf(data)),
    parse,
    deny: denyClaudeStyle,
  },
  skill: (h, env) => ({
    present: existsSync(home(h, env)) || !!onPath('droid', env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
  sessionEnv: ['FACTORY_SESSION_ID'],
  hostEnv: /^(FACTORY_SESSION_ID|DROID_PROTECTED_PID)$/,
};
