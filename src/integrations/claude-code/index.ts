/** Claude Code (CLI, IDE extensions, desktop): ~/.claude, or CLAUDE_CONFIG_DIR. */
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
import { claudeAdapter } from './trace.ts';

const home = (h: string, env: Env) => env.CLAUDE_CONFIG_DIR || join(h, '.claude');

export const integration: Integration = {
  id: 'claude',
  label: 'Claude Code',
  status: 'supported',
  variants: 'CLI, IDE extensions and desktop app',
  traces: [claudeAdapter],
  hook: {
    file: (h, env) => join(home(h, env), 'settings.json'),
    present: (h, env) => existsSync(home(h, env)),
    apply: (data, commands) => applyClaudeStyle(data, commands, 'Bash|PowerShell'),
    installedCommand: installedClaudeStyle,
    parse: parseClaudeStyle,
    deny: denyClaudeStyle,
  },
  skill: (h, env) => ({
    present: existsSync(home(h, env)) || !!onPath('claude', env),
    dir: join(home(h, env), 'skills', 'tracetoon'),
  }),
  sessionEnv: ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'],
  hostEnv:
    /^(CLAUDE_EFFORT|CLAUDE_PID|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_\w+)$/,
};
