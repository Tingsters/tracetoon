import {
  contributionPolicy,
  loadGuidance,
  researchPacket,
} from '../contribution/guidance.ts';
import { detectAiPolicy } from '../github/repoContext.ts';
import { prTruth } from '../git/pr.ts';
import { findRun, readJson } from '../run.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export function guidanceCheckCmd(cwd: string, opts: OutOpts & { run?: string }): void {
  const initial = prTruth(cwd, { noGh: true });
  const run = findRun(initial.gitDir, opts.run);
  const context = readJson<{ base?: string; contribution?: { offline: boolean } }>(
    run,
    'context.json',
  );
  if (!context)
    throw new UserError('Run `tracetoon context` before collecting guidance.');
  const truth =
    context.base && context.base !== initial.base
      ? prTruth(cwd, { noGh: true, base: context.base })
      : initial;
  const { request } = researchPacket(truth, context.contribution?.offline ?? false);
  const result = loadGuidance(run, truth.toplevel, request);
  if (['missing', 'invalid', 'stale'].includes(result.status))
    throw new UserError(`Guidance ${result.status}: ${result.issues.join('; ')}`);
  const composition = contributionPolicy(detectAiPolicy(truth.toplevel), result);
  emit(
    opts,
    {
      run: run.id,
      status: result.status,
      sources: result.guidance?.sources.length,
      requirements: result.guidance?.requirements.length,
      issues: [...result.issues, ...composition.issues],
      aiPolicy: composition.policy,
      disclosure: composition.disclosure,
      note: 'Structure and local snapshots checked; source interpretation and remote authenticity require independent review.',
    },
    () =>
      [
        `Guidance ${result.status}: ${result.guidance?.sources.length} source(s), ${result.guidance?.requirements.length} requirement(s).`,
        ...[...result.issues, ...composition.issues].map((s) => `  - ${s}`),
        `AI policy: ${composition.policy.verdict}; media ${composition.policy.media ?? 'none'}; disclosure ${composition.disclosure ?? 'default'}.`,
        'Structure and local snapshots checked; remote authenticity and interpretation are not certified.',
      ].join('\n'),
  );
}
