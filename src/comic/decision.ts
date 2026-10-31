/** Whether this PR gets a comic, from the user's setting and the repo's rules. */
import type { ComicMode } from '../config.ts';

export interface ComicDecision {
  include: boolean;
  reason?: string;
  /** Why not: the user's setting, or the repo's policy. */
  state?: 'off' | 'policy';
}

export function comicDecision(
  mode: ComicMode,
  policy: { media?: string; mediaSource?: { file: string; line: number } },
): ComicDecision {
  if (mode === 'off')
    return { include: false, state: 'off', reason: 'comic is off in your settings' };
  if (mode === 'allowed' && policy.media === 'prohibited') {
    const src = policy.mediaSource;
    return {
      include: false,
      state: 'policy',
      reason: `this repo's contributing rules forbid images in PRs${src ? ` (${src.file}:${src.line})` : ''}`,
    };
  }
  return { include: true };
}
