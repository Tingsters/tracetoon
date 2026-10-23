import { claudeAdapter } from './claude.ts';
import type { TraceAdapter } from './types.ts';

/** Adapters for the agents Tracetoon can read. Codex and Antigravity arrive in M2. */
export const ADAPTERS: TraceAdapter[] = [claudeAdapter];

/** Agents we know about but can't read yet, for `doctor`. */
export const PLANNED: { id: string; label: string; envVar: string; dir: string }[] = [
  { id: 'codex', label: 'Codex', envVar: 'CODEX_HOME', dir: '.codex' },
  { id: 'antigravity', label: 'Antigravity', envVar: 'GEMINI_HOME', dir: '.gemini' },
];
