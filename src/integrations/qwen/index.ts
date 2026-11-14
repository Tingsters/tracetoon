/**
 * Qwen Code (QwenLM): ~/.qwen (QWEN_DATA_DIR for Tracetoon). Hooks follow
 * Claude Code's protocol under `hooks` in ~/.qwen/settings.json, with the shell
 * tool named `run_shell_command`. Skills are read from ~/.qwen/skills.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyClaudeStyle,
  denyClaudeStyle,
  installedClaudeStyle,
  parseClaudeStyle,
} from '../../hook/claudeStyle.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, Integration } from '../types.ts';
import { qwenAdapter } from './trace.ts';

const home = (h: string, env: Env) => env.QWEN_DATA_DIR || join(h, '.qwen');
const present = (h: string, env: Env) =>
  existsSync(home(h, env)) || !!onPath('qwen', env);

export const integration: Integration = {
  id: 'qwen',
  label: 'Qwen Code',
  status: 'supported',
  variants: 'CLI',
  traces: [qwenAdapter],
  hook: {
    file: (h, env) => join(home(h, env), 'settings.json'),
    present,
    apply: (data, commands) => applyClaudeStyle(data, commands, 'run_shell_command'),
    installedCommand: installedClaudeStyle,
    parse: parseClaudeStyle,
    deny: denyClaudeStyle,
  },
  skill: (h, env) => ({
    present: present(h, env),
    dir: join(home(h, env), 'skills', 'tracetoon'),
  }),
  sessionEnv: [],
};
