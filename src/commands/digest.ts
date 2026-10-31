import { createHash } from 'node:crypto';
import { writeResearchPacket } from '../contribution/guidance.ts';
import { loadConfig } from '../config.ts';
import { buildDigest, type TraceDigest } from '../digest/build.ts';
import { findPrTemplate, detectAiPolicy } from '../github/repoContext.ts';
import { decodeMeta, humanPart, regionContent, regionEdited } from '../github/body.ts';
import { prTruth } from '../git/pr.ts';
import { scan } from '../pipeline.ts';
import { recentComics } from '../github/history.ts';
import { describeTitleRules, readTitleRules } from '../github/titleRules.ts';
import { findRun, newRun, readJson, writeJson } from '../run.ts';
import { emit, UserError, type OutOpts } from './output.ts';
import { submissionSnapshot } from '../review/snapshot.ts';
import { checkReport, receiptEvidence } from '../workflow/checks.ts';
import { detectInterop } from '../git/interop.ts';
import { readTask, saveTask } from '../workflow/state.ts';
import { receipts } from '../workflow/checks.ts';
import { fileHash } from '../workflow/readiness.ts';
import { makeScrubber } from '../digest/sanitize.ts';

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
  run?: string;
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
  const run = opts.run ? findRun(truth.gitDir, opts.run) : newRun(truth.gitDir);
  const config = loadConfig(truth.toplevel);
  const selected = readJson<{ include?: string[]; exclude?: string[] }>(
    run,
    'session-selection.json',
  );
  const build = {
    include: opts.include ?? selected?.include,
    exclude: opts.exclude ?? selected?.exclude,
  };
  // Both digests describe the same truth; read its provenance once.
  const interop = detectInterop(truth);
  const digest = buildDigest(truth, matches, {
    ...build,
    interop,
    budgetTokens: opts.budget ?? config.budgetTokens,
  });
  const full = buildDigest(truth, matches, {
    ...build,
    interop,
    budgetTokens: Number.MAX_SAFE_INTEGER,
  });
  if (readTask(run)) {
    const report = checkReport(truth.toplevel, run);
    const validation = report.map((c) => ({
      name: c.name,
      command: c.command.join(' '),
      outcome: c.outcome,
      current: c.current,
      reason: c.reason,
      durationMs: c.durationMs,
    }));
    const verification = receiptEvidence(truth.toplevel, run, report);
    digest.verification = full.verification = verification;
    digest.checksSha = full.checksSha = receipts(run).length
      ? fileHash(run, 'checks.json')
      : undefined;
    const noChecks = readTask(run)?.noChecksReason;
    if (noChecks)
      validation.push({
        name: 'No local checks applicable',
        command: '',
        outcome: 'not-run',
        current: true,
        reason: makeScrubber([truth.toplevel]).text(noChecks),
        durationMs: 0,
      });
    digest.validation = full.validation = validation;
  }
  const previous = opts.run
    ? readJson<{ head: string }>(run, 'approval.json')
    : undefined;
  if (previous?.head && previous.head !== truth.head)
    throw new UserError(
      `This run belongs to branch ${previous.head}. Switch to that branch before refreshing it.`,
    );
  // A digest is only built to make a PR. Record the request, so the session
  // that asked for it can't end with the PR unmade, even without a redirected
  // `gh pr create`.
  const task = readTask(run);
  if (task && task.state !== 'published') {
    // The session running the digest is the one asking; the task owner is a fallback.
    const by =
      process.env.CODEX_THREAD_ID ||
      process.env.CLAUDE_CODE_SESSION_ID ||
      process.env.CLAUDE_SESSION_ID ||
      task.session;
    if (!task.prRequestedAt || (by && task.prRequestedBy !== by)) {
      task.prRequestedAt ??= new Date().toISOString();
      if (by) task.prRequestedBy = by;
    }
    if (
      task.state === 'working' ||
      task.state === 'blocked' ||
      task.state === 'deferred'
    ) {
      if (task.state !== 'working')
        task.recoveryGeneration = (task.recoveryGeneration ?? 0) + 1;
      task.state = 'preparing';
      task.reason = undefined;
    }
    saveTask(run, task);
  }
  writeJson(run, 'session-selection.json', build);
  const path = writeJson(run, 'digest.json', digest);
  writeJson(run, 'digest-full.json', full);
  writeJson(run, 'submission.json', submissionSnapshot(truth));
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
          ? `Ambiguous, left out: ${ambiguous.map((s) => s.ref).join(', ')}. The PR message says so; re-run with --include only if one clearly belongs.`
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
  const s =
    full?.sessions.find((x) => x.ref === ref) ??
    full?.verification?.find((x) => x.id === ref.replace(/^digest:/, ''));
  if (!s) throw new UserError(`No session ${ref} in run ${run.id}.`);
  emit(opts, s, () => JSON.stringify(s, null, 2));
}

export function contextCmd(
  cwd: string,
  opts: OutOpts & { run?: string; offline?: boolean },
): void {
  let truth = prTruth(cwd, { noGh: opts.offline });
  let run;
  try {
    run = findRun(truth.gitDir, opts.run);
  } catch {
    run = newRun(truth.gitDir);
  }
  const digest = readJson<TraceDigest>(run, 'digest.json');
  if (digest?.pr.base && digest.pr.base !== truth.base)
    truth = prTruth(cwd, { base: digest.pr.base, noGh: opts.offline });
  const contribution = writeResearchPacket(run, truth, opts.offline);
  const template = findPrTemplate(truth.toplevel);
  const policy = detectAiPolicy(truth.toplevel);
  const titleRules = readTitleRules(truth.toplevel, {
    offline: opts.offline,
    repo: truth.remote ? `${truth.remote.owner}/${truth.remote.name}` : undefined,
  });
  const config = loadConfig(truth.toplevel);
  // Compact creative choices help this comic differ. Skipped when comics are off.
  const recent =
    config.comic !== 'off' ? recentComics(truth, { offline: opts.offline }) : [];
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
    comic: {
      recentStyles: recent.flatMap((c) => (c.style ? [c.style] : [])),
      recentComics: recent,
    },
    titleRules,
    contribution,
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
        `Contribution research: ${contribution.sourceSeeds.length} source seed(s); guidance-request.json and changes.patch written${contribution.offline ? ' (offline: do not browse external links)' : ''}.`,
        `AI policy: ${policy.verdict}${policy.excerpts.length ? ` (${policy.excerpts.length} mention(s))` : ''}`,
        ...policy.excerpts.slice(0, 5).map((e) => `  ${e.file}:${e.line}: ${e.text}`),
        `prompt quoting: ${config.promptQuoting} | comic: ${config.comic}`,
        ...describeTitleRules(titleRules),
        config.comic === 'off'
          ? ''
          : config.style && config.style !== 'auto'
            ? `Comic style: pinned to ${config.style}`
            : `Comic: choose the story, composition and cast; compare recent creative choices (${
                recent
                  .map((c) => c.style)
                  .filter(Boolean)
                  .join('; ') || 'none yet'
              })`,
      ]
        .filter(Boolean)
        .join('\n'),
  );
}
