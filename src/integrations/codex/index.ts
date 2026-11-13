/** Codex (CLI and app): ~/.codex, or CODEX_HOME. Skills live in ~/.agents/skills. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyClaudeStyle,
  denyClaudeStyle,
  installedClaudeStyle,
  parseClaudeStyle,
} from '../../hook/claudeStyle.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, Integration } from '../types.ts';
import { codexAdapter } from './trace.ts';
import { codexTrustProblem } from './trust.ts';

const home = (h: string, env: Env) => env.CODEX_HOME || join(h, '.codex');

export const integration: Integration = {
  id: 'codex',
  label: 'Codex',
  status: 'supported',
  traces: [codexAdapter],
  hook: {
    file: (h, env) => join(home(h, env), 'hooks.json'),
    present: (h, env) => existsSync(home(h, env)),
    apply: (data, commands) => applyClaudeStyle(data, commands, 'Bash'),
    installedCommand: installedClaudeStyle,
    parse: parseClaudeStyle,
    deny: denyClaudeStyle,
    installNote(file) {
      try {
        const toml = readFileSync(join(dirname(file), 'config.toml'), 'utf8');
        if (/^\s*hooks\s*=\s*false/m.test(toml))
          return 'Codex hooks are turned off in config.toml ([features] hooks = false); Tracetoon leaves that alone.';
      } catch {
        /* no config.toml */
      }
      return 'In Codex, run /hooks once and trust the Tracetoon hook.';
    },
    problem: codexTrustProblem,
  },
  skill: (h, env) => ({
    present: existsSync(home(h, env)) || !!onPath('codex', env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
  sessionEnv: ['CODEX_THREAD_ID'],
  hostEnv: /^(CODEX_TOOL_CALL_ID|CODEX_THREAD_ID)$/,
};
