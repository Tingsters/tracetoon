import { createHash } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { buildDigest, type TraceDigest } from '../digest/build.ts';
import { findPrTemplate, detectAiPolicy } from '../github/repoContext.ts';
import { decodeMeta, humanPart, regionContent, regionEdited } from '../github/body.ts';
import { prTruth } from '../git/pr.ts';
import { scan } from '../pipeline.ts';
import { recentStyles } from '../github/history.ts';
import { findRun, newRun, readJson, writeJson } from '../run.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export interface ScanOpts extends OutOpts {
  base?: string;
  offline?: boolean;
}

export function scanCmd(cwd: string, opts: ScanOpts): void {
  const { truth, matches } = scan(cwd, { base: opts.base, noGh: opts.offline });
  const rows = matches.map((m) => ({
    session: m.session.sessionId,
    agent: m.session.agent,
    title: m.session.title,
    score: m.score,
    band: m.band,
    reasons: m.reasons,
    keptRecords: m.kept.length,
  }));
  emit(
    opts,
    { head: truth.head, base: truth.base, commits: truth.commits.length, sessions: rows },
    () => {
      const head = `${truth.head} -> ${truth.base}: ${truth.commits.length} commit(s), ${truth.files.length} file(s)`;
      if (!rows.length) return `${head}\nNo agent sessions found for this repository.`;
      return [
        head,
        ...rows.map(
          (r) =>
            `  ${r.band.padEnd(9)} ${r.score.toFixed(2)}  ${r.agent}  ${r.title ?? r.session.slice(0, 8)}\n` +
            `            ${r.reasons.join('; ')}`,
        ),
      ].join('\n');
    },
  );
}

export interface DigestOpts extends ScanOpts {
  include?: string[];
  exclude?: string[];
  budget?: number;
}

export function digestHash(d: TraceDigest): string {
  const { generatedAt: _ignored, ...stable } = d;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 12);
}

export function digestCmd(cwd: string, opts: DigestOpts): void {
  const { truth, matches } = scan(cwd, { base: opts.base, noGh: opts.offline });
  const config = loadConfig(truth.toplevel);
  const build = { include: opts.include, exclude: opts.exclude };
  const digest = buildDigest(truth, matches, {
    ...build,
    budgetTokens: opts.budget ?? config.budgetTokens,
  });
  const full = buildDigest(truth, matches, {
    ...build,
    budgetTokens: Number.MAX_SAFE_INTEGER,
  });
  const run = newRun(truth.gitDir);
  const path = writeJson(run, 'digest.json', digest);
  writeJson(run, 'digest-full.json', full);
  const ambiguous = digest.sessions.filter((s) => s.band === 'ambiguous');
  emit(
    opts,
    {
      run: run.id,
      runDir: run.dir,
      digestPath: path,
      sessions: digest.sessions.map((s) => ({
        ref: s.ref,
        agent: s.agent,
        title: s.title,
        band: s.band,
        score: s.score,
      })),
      ambiguous: ambiguous.map((s) => s.ref),
      stats: digest.stats,
      notes: digest.notes,
    },
    () =>
      [
        `Run ${run.id}: digest written to ${path}`,
        `${digest.sessions.length} session(s): ` +
          digest.sessions
            .map((s) => `${s.ref} ${s.agent} "${s.title ?? ''}" (${s.band}, ${s.score})`)
            .join('; '),
        ambiguous.length
          ? `Ambiguous: ${ambiguous.map((s) => s.ref).join(', ')}. Ask the user, then re-run with --include or --exclude.`
          : '',
        ...digest.notes,
      ]
        .filter(Boolean)
        .join('\n'),
  );
}

export function expandCmd(
  cwd: string,
  ref: string,
  opts: OutOpts & { run?: string },
): void {
  const truth = prTruth(cwd, { noGh: true });
  const run = findRun(truth.gitDir, opts.run);
  const full = readJson<TraceDigest>(run, 'digest-full.json');
  const s = full?.sessions.find((x) => x.ref === ref);
  if (!s) throw new UserError(`No session ${ref} in run ${run.id}.`);
  emit(opts, s, () => JSON.stringify(s, null, 2));
}

export function contextCmd(
  cwd: string,
  opts: OutOpts & { run?: string; offline?: boolean },
): void {
  const truth = prTruth(cwd, { noGh: opts.offline });
  let run;
  try {
    run = findRun(truth.gitDir, opts.run);
  } catch {
    run = newRun(truth.gitDir);
  }
  const template = findPrTemplate(truth.toplevel);
  const policy = detectAiPolicy(truth.toplevel);
  const config = loadConfig(truth.toplevel);
  // The only thing read back from earlier PRs: their comic styles, so this one
  // differs. Skipped when comics are off.
  const recent = config.comic ? recentStyles(truth, { offline: opts.offline }) : [];
  const ctx = {
    repo: truth.remote ? `${truth.remote.owner}/${truth.remote.name}` : null,
    head: truth.head,
    base: truth.base,
    template: template ?? null,
    aiPolicy: policy,
    existingPr: truth.pr
      ? {
          number: truth.pr.number,
          url: truth.pr.url,
          title: truth.pr.title,
          humanBody: humanPart(truth.pr.body),
          body: truth.pr.body,
          // Someone edited Tracetoon's section on GitHub since it was posted:
          // their text is the starting point, not something to overwrite.
          editedOnGitHub: regionEdited(truth.pr.body) ?? false,
          editedText: regionEdited(truth.pr.body)
            ? regionContent(truth.pr.body)
            : undefined,
          previous: decodeMeta(truth.pr.body) ?? null,
        }
      : null,
    config,
    comic: { recentStyles: recent },
  };
  writeJson(run, 'context.json', ctx);
  emit(
    opts,
    {
      run: run.id,
      ...ctx,
      existingPr: ctx.existingPr && { ...ctx.existingPr, body: undefined },
    },
    () =>
      [
        `Run ${run.id}: context written`,
        `PR: ${ctx.existingPr ? `#${ctx.existingPr.number} ${ctx.existingPr.title}` : 'none yet (will create one)'}`,
        ...(ctx.existingPr?.editedOnGitHub
          ? [
              "Note: Tracetoon's section of this PR was edited on GitHub since it was posted. Start from that text (existingPr.editedText) and keep the edits.",
            ]
          : ctx.existingPr?.humanBody
            ? [
                'Note: this PR already has a description written by someone. Keep it; add to it rather than replacing it.',
              ]
            : []),
        `Template: ${template ? template.path : 'none'}`,
        `AI policy: ${policy.verdict}${policy.excerpts.length ? ` (${policy.excerpts.length} mention(s))` : ''}`,
        ...policy.excerpts.slice(0, 5).map((e) => `  ${e.file}:${e.line}: ${e.text}`),
        `yolo: ${config.yolo} | prompt quoting: ${config.promptQuoting} | comic: ${config.comic ? 'on' : 'off'}`,
        !config.comic
          ? ''
          : config.style && config.style !== 'auto'
            ? `Comic style: pinned to ${config.style}`
            : `Comic: invent this PR's own characters, and pick a style unlike the recent ones (${recent.join(', ') || 'none yet'})`,
      ]
        .filter(Boolean)
        .join('\n'),
  );
}
