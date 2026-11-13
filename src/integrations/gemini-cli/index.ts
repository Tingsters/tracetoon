/**
 * Gemini CLI: legacy. Google moved individual users to Antigravity CLI in June
 * 2026; enterprise and API-key users still run it. Tracetoon installs the skill
 * for them but reads no logs and adds no hook.
 */
import { join } from 'node:path';
import { onPath } from '../../util/onPath.ts';
import type { Integration } from '../types.ts';

export const integration: Integration = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  status: 'legacy',
  traces: [],
  skill: (h, env) => ({
    present: !!onPath('gemini', env),
    dir: join(env.GEMINI_HOME || join(h, '.gemini'), 'skills', 'tracetoon'),
  }),
};
