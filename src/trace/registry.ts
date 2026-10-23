import { antigravityCliAdapter, antigravityIdeAdapter } from './antigravity.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import type { TraceAdapter } from './types.ts';

/** Adapters for the agents Tracetoon can read. */
export const ADAPTERS: TraceAdapter[] = [
  claudeAdapter,
  codexAdapter,
  antigravityCliAdapter,
  antigravityIdeAdapter,
];

/** Agents we know about but can't read yet, for `doctor`. */
export const PLANNED: { id: string; label: string; envVar: string; dir: string }[] = [
  { id: 'copilot-cli', label: 'Copilot CLI', envVar: 'COPILOT_HOME', dir: '.copilot' },
];
