/** `tracetoon guide`: how an agent should use Tracetoon, from AGENTS.md. */
import { GUIDE } from './guideText.ts';
import { emit, type OutOpts } from './output.ts';

export function guideCmd(opts: OutOpts): void {
  emit(opts, { source: 'AGENTS.md#using-tracetoon', guide: GUIDE }, () => GUIDE);
}
