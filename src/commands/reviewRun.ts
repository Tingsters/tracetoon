/**
 * `tracetoon review run`: Tracetoon starts the lean reviewer itself, as a
 * `codex exec` session with the plan's reviewer model pinned, instead of
 * trusting the drafting agent to start one and report its id and model.
 *
 * The session id comes from Codex's JSON events; the model the session actually
 * ran on is read back from its rollout under $CODEX_HOME/sessions. Both are
 * recorded on the imported pass, and with `Reviewer runner: tracetoon.` publish
 * accepts only passes recorded this way, on the configured model.
 *
 * `--recheck` resumes the same session with the changed body lines and its
 * previous findings, and imports the answer as the same pass.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { codexBin, codexHome, runCli } from '../comic/providers.ts';
import { FINDING_KINDS, FINDING_VERDICTS } from '../contribution/leanReview.ts';
import {
  loadReviewPlan,
  parseEffort,
  parseLens,
  planEnforced,
  planSummary,
  resolveCodexModel,
  type ReviewLens,
  type ReviewPass,
} from '../contribution/reviewPlan.ts';
import { skillDir } from '../contribution/skillSettings.ts';
import type { Run } from '../run.ts';
import { emit, UserError, type OutOpts } from './output.ts';
import {
  importLeanReview,
  lensFindingsFile,
  loadPasses,
  openRun,
  renderedInput,
  writeLeanPacket,
  type StoredPass,
} from './review.ts';

export const SCHEMA_FILE = 'review-findings.schema.json';
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const suffix = (lens?: string) => (lens ? `-${lens}` : '');
/** The body text a lens's last run reviewed, for --recheck. */
const reviewedBodyFile = (lens?: string) => `review-run-body${suffix(lens)}.md`;
const lastMessageFile = (lens?: string) => `review-run-last${suffix(lens)}.txt`;

/** JSON Schema for the reviewer's final message (strict: every field required). */
export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'reviewer', 'coldRead', 'findings'],
  properties: {
    v: { type: 'integer', enum: [1] },
    reviewer: {
      type: 'object',
      additionalProperties: false,
      required: ['agentId'],
      properties: { agentId: { type: 'string' } },
    },
    coldRead: {
      type: 'object',
      additionalProperties: false,
      required: ['change', 'start'],
      properties: { change: { type: 'string' }, start: { type: 'string' } },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'quote', 'verdict', 'evidence', 'fix'],
        properties: {
          kind: { type: 'string', enum: [...FINDING_KINDS] },
          quote: { type: 'string' },
          verdict: { type: 'string', enum: [...FINDING_VERDICTS] },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
};

/** Replaces the reference's "write review-findings.json" output step. */
export const RUN_OVERRIDE = [
  '## Override for this run',
  '',
  'You were started by `tracetoon review run`. Everything you need is in the packet above:',
  'make no lookups, run no commands, and write no files. Instead of writing',
  'review-findings.json, reply with ONLY that JSON object (no prose, no code fence),',
  'in the shape given above. Put "codex-exec" as reviewer.agentId; Tracetoon records',
  'your real session id. Give coldRead as two short strings.',
].join('\n');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The reviewer reference text from the skill folder next to this runtime. */
function referenceText(lens?: ReviewLens): string {
  const dir = process.env.TRACETOON_SKILL_DIR || skillDir();
  const name = lens ? `reviewer-lens-${lens}.md` : 'reviewer-lean.md';
  const path = dir ? join(dir, 'references', name) : undefined;
  if (!path || !existsSync(path))
    throw new UserError(
      `Cannot find the skill's references/${name} next to this Tracetoon runtime; reinstall the skill.`,
    );
  return readFileSync(path, 'utf8');
}

/** Codex's JSON events, one per stdout line; other lines are ignored. */
export function parseEvents(stdout: string): Record<string, unknown>[] {
  return stdout.split('\n').flatMap((l) => {
    const t = l.trim();
    if (!t.startsWith('{')) return [];
    try {
      const e = JSON.parse(t);
      return e && typeof e === 'object' && !Array.isArray(e) ? [e] : [];
    } catch {
      return [];
    }
  });
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const rec = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The session (thread) id from Codex's events: `thread.started`, else other known shapes. */
export function sessionIdFromEvents(
  events: Record<string, unknown>[],
): string | undefined {
  for (const e of events)
    if (e.type === 'thread.started' && str(e.thread_id)) return str(e.thread_id);
  for (const e of events) {
    const id =
      str(e.thread_id) ??
      str(e.session_id) ??
      str(rec(e.session).id) ??
      (e.type === 'session_meta' || e.type === 'session.created'
        ? (str(rec(e.payload).id) ?? str(e.id))
        : undefined);
    if (id) return id;
  }
  return undefined;
}

/** The last agent message text in Codex's events. */
function lastAgentMessage(events: Record<string, unknown>[]): string | undefined {
  let text: string | undefined;
  for (const e of events) {
    const item = rec(e.item);
    if (e.type === 'item.completed' && item.type === 'agent_message' && str(item.text))
      text = String(item.text);
  }
  return text;
}

/** The findings object in a model reply: whole text, a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) tries.push(fence[1]!.trim());
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      /* next */
    }
  }
  throw new Error('the reply is not a JSON object');
}

/** Every rollout file under a sessions folder. */
function rolloutFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (st.isFile() && /^rollout-.*\.jsonl$/.test(n)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * The model a rollout's own thread ran on: the last `turn_context` model that
 * is not replayed parent history, else `thread_settings_applied`, else the
 * `session_meta` model. Returns the file's own session id too.
 */
export function rolloutModel(text: string): { id?: string; model?: string } {
  let id: string | undefined;
  let historyStart: number | undefined;
  let turnModel: string | undefined;
  let settingsModel: string | undefined;
  let metaModel: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec(e.payload);
    if (e.type === 'session_meta') {
      if (id === undefined && str(p.id)) {
        id = str(p.id);
        metaModel = str(p.model);
        if (typeof p.subagent_history_start_ordinal === 'number')
          historyStart = p.subagent_history_start_ordinal;
      }
      continue;
    }
    if (e.type === 'turn_context') {
      const replayed =
        historyStart !== undefined &&
        typeof e.ordinal === 'number' &&
        e.ordinal < historyStart;
      const m = str(p.model) ?? str(rec(rec(p.collaboration_mode).settings).model);
      if (m && !replayed) turnModel = m;
      continue;
    }
    if (p.type === 'thread_settings_applied') {
      const m = str(rec(p.thread_settings).model);
      const tid = str(p.thread_id);
      if (m && (!tid || !id || tid === id)) settingsModel = m;
    }
  }
  return { id, model: turnModel ?? settingsModel ?? metaModel };
}

/** Find a session's rollout under $CODEX_HOME/sessions and read the model it ran on. */
export function verifiedSessionModel(sessionId: string): {
  rollout?: string;
  model: string | null;
} {
  const files = rolloutFiles(join(codexHome(), 'sessions'));
  // Rollout names end in the session id; fall back to each file's session_meta.
  const named = files.filter((f) => f.includes(sessionId));
  for (const f of [...named, ...files.filter((f) => !named.includes(f))]) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const r = rolloutModel(text);
    if (r.id === sessionId) return { rollout: f, model: r.model ?? null };
  }
  return { model: null };
}

/** The body lines that changed since the reviewed text, numbered as in the current body. */
export function changedLines(before: string, after: string): string[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push(`+ body:${j + 1} | ${b[j]}`);
      j++;
    } else {
      out.push(`- (removed) | ${a[i]}`);
      i++;
    }
  }
  return out;
}

export interface ReviewRunOptions extends OutOpts {
  run?: string;
  lens?: string;
  recheck?: boolean;
  model?: string;
  effort?: string;
}

function timeoutMs(): number {
  const v = Number(process.env.TRACETOON_REVIEW_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/** The previous Tracetoon-run pass for this lens, which --recheck resumes. */
function previousRun(run: Run, lens?: ReviewLens): StoredPass | undefined {
  return loadPasses(run)
    .filter((p) => p.source === 'tracetoon-run' && p.sessionId && p.lens === lens)
    .sort((x, y) => x.importedAt.localeCompare(y.importedAt))
    .at(-1);
}

export async function reviewRunCmd(cwd: string, opts: ReviewRunOptions): Promise<void> {
  let lens: ReviewLens | undefined;
  let effortOpt: string | undefined;
  try {
    lens = parseLens(opts.lens);
    effortOpt = parseEffort(opts.effort);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const { run, root } = openRun(cwd, opts.run);
  const plan = loadReviewPlan(run);
  const modelOpt = opts.model?.trim() || undefined;
  if (modelOpt && plan?.reviewerModel && modelOpt !== plan.reviewerModel)
    throw new UserError(
      `This run's review plan names reviewer model ${plan.reviewerModel}; --model ${modelOpt} would not satisfy it. Leave --model out.`,
    );
  if (effortOpt && plan?.reviewerEffort && effortOpt !== plan.reviewerEffort)
    throw new UserError(
      `This run's review plan names reviewer effort ${plan.reviewerEffort}; --effort ${effortOpt} would not satisfy it. Leave --effort out.`,
    );
  const model = plan?.reviewerModel ?? modelOpt;
  const effort = plan?.reviewerEffort ?? effortOpt;
  if (!model)
    throw new UserError(
      'No reviewer model configured for this run: set the SKILL "Reviewer model:" line (or prepare --reviewer-model <name>), or pass --model <name>.',
    );
  if (plan?.lenses.length && !lens)
    throw new UserError(
      `This run's review plan has lenses ${plan.lenses.join(', ')}: run each with --lens <${plan.lenses.join('|')}>.`,
    );
  if (lens && plan?.lenses.length && !plan.lenses.includes(lens))
    throw new UserError(
      `Lens ${lens} is not in this run's review plan (lenses ${plan.lenses.join(', ')}).`,
    );
  const bin = codexBin();
  if (!bin)
    throw new UserError(
      'The Codex CLI is not installed (or TRACETOON_CODEX_BIN is "none"); tracetoon review run needs codex.',
    );
  const codexModel = resolveCodexModel(model);
  const { input } = renderedInput(run);
  const schemaPath = join(run.dir, SCHEMA_FILE);
  writeFileSync(schemaPath, JSON.stringify(FINDINGS_SCHEMA, null, 2) + '\n', 'utf8');
  const outPath = join(run.dir, lastMessageFile(lens));
  if (existsSync(outPath)) writeFileSync(outPath, '', 'utf8');
  const pinned = [
    '--skip-git-repo-check',
    '--json',
    '-m',
    codexModel,
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '--output-schema',
    schemaPath,
    '-o',
    outPath,
  ];

  let args: string[];
  let prompt: string;
  let resumed: string | undefined;
  if (opts.recheck) {
    const prev = previousRun(run, lens);
    if (!prev?.sessionId)
      throw new UserError(
        `No earlier tracetoon review run pass${lens ? ` for lens ${lens}` : ''} to recheck: run tracetoon review run --run ${run.id}${lens ? ` --lens ${lens}` : ''} first.`,
      );
    resumed = prev.sessionId;
    const before = existsSync(join(run.dir, reviewedBodyFile(lens)))
      ? readFileSync(join(run.dir, reviewedBodyFile(lens)), 'utf8')
      : undefined;
    const changed =
      before === undefined
        ? [
            '(The reviewed body was not stored; the whole current body follows.)',
            ...input.body.split(/\r?\n/).map((l, i) => `  body:${i + 1} | ${l}`),
          ]
        : changedLines(before, input.body).filter((l) => !/\| <!-- tracetoon:/.test(l));
    prompt = [
      '# Confirmation round',
      '',
      'The author applied fixes after your review. Body lines that changed (`+ body:N` is the line in the current body; `- (removed)` lines are gone):',
      '',
      ...(changed.length ? changed : ['(No body line changed.)']),
      '',
      'Your previous findings:',
      '',
      JSON.stringify({ v: 1, findings: prev.raw.findings }, null, 2),
      '',
      'Update them in one turn: drop findings the changes fixed, keep or reword the ones that still hold (quote the current body text), and add any new problem the changed lines introduce. Reply with ONLY the updated findings JSON object in the same shape as before (no prose, no code fence, no files, no commands).',
    ].join('\n');
    args = ['exec', 'resume', ...pinned, resumed, '-'];
  } else {
    const { packet } = writeLeanPacket(run, lens);
    prompt = [
      packet.text.trimEnd(),
      '',
      '---',
      '',
      referenceText(lens).trimEnd(),
      '',
      RUN_OVERRIDE,
      '',
    ].join('\n');
    args = ['exec', '--sandbox', 'read-only', ...pinned, '-C', run.dir, '-'];
  }

  const res = await runCli(bin, args, run.dir, timeoutMs(), prompt);
  const events = parseEvents(res.stdout);
  const lastErr = () =>
    res.stderr.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';
  if (res.code !== 0)
    throw new UserError(
      `codex exec ${res.code === null ? 'timed out or was killed' : `exited ${res.code}`}${lastErr() ? `: ${lastErr()}` : ''}. Nothing was imported.`,
    );
  const sessionId = resumed ?? sessionIdFromEvents(events);
  if (!sessionId)
    throw new UserError(
      'codex exec reported no session id in its JSON events. Nothing was imported.',
    );
  const reply =
    (existsSync(outPath) ? readFileSync(outPath, 'utf8') : '').trim() ||
    lastAgentMessage(events) ||
    '';
  let raw: unknown;
  try {
    if (!reply) throw new Error('the reviewer gave no reply');
    raw = extractJson(reply);
  } catch (e) {
    throw new UserError(
      `The reviewer's reply could not be read as findings JSON (${(e as Error).message}). Nothing was imported.`,
    );
  }
  const verified = verifiedSessionModel(sessionId);
  const obj = rec(raw);
  const cold = rec(obj.coldRead);
  const findings = {
    v: 1,
    reviewer: { agentId: sessionId, model },
    ...(str(cold.change) || str(cold.start) ? { coldRead: cold } : {}),
    findings: obj.findings,
  };
  const findingsPath = join(run.dir, lensFindingsFile(lens));
  const previousFile = existsSync(findingsPath)
    ? readFileSync(findingsPath, 'utf8')
    : undefined;
  writeFileSync(findingsPath, JSON.stringify(findings, null, 2) + '\n', 'utf8');
  let result: ReturnType<typeof importLeanReview>;
  try {
    result = importLeanReview(run, root, {
      findings: findingsPath,
      agentId: sessionId,
      reviewerModel: model,
      ...(effort ? { reviewerEffort: effort } : {}),
      ...(lens ? { lens } : {}),
      provenance: {
        source: 'tracetoon-run',
        runner: 'codex-exec',
        sessionId,
        verifiedModel: verified.model,
        bodySha256: sha256(input.body),
      },
    });
  } catch (e) {
    // Leave the run as it was: nothing imported.
    if (previousFile === undefined) unlinkSync(findingsPath);
    else writeFileSync(findingsPath, previousFile, 'utf8');
    throw e;
  }
  writeFileSync(join(run.dir, reviewedBodyFile(lens)), input.body, 'utf8');
  const warnings = [...result.warnings];
  if (verified.model !== codexModel)
    warnings.unshift(
      verified.model
        ? `The session's rollout says it ran on ${verified.model}, not ${codexModel}: publish refuses this pass.`
        : `No rollout for session ${sessionId} under ${join(codexHome(), 'sessions')} shows its model: the model is unverified${plan?.runner === 'tracetoon' ? ' and publish refuses this pass' : ''}.`,
    );
  const pass = result.pass as ReviewPass;
  const recheck = `tracetoon review run --run ${run.id}${lens ? ` --lens ${lens}` : ''} --recheck`;
  const next = opts.recheck
    ? `tracetoon render --json --run ${run.id}; publish when the review is current`
    : pass.findings
      ? `check each finding against the patch and apply the valid ones to body.md, tracetoon render --json --run ${run.id}, then ${recheck} once`
      : `tracetoon render --json --run ${run.id}`;
  emit(
    opts,
    {
      ...result,
      warnings,
      sessionId,
      model: codexModel,
      verifiedModel: verified.model,
      rollout: verified.rollout ?? null,
      findingsPath,
      next,
    },
    () =>
      [
        `${opts.recheck ? 'Rechecked' : 'Reviewed'} with codex exec on ${codexModel}${effort ? ` (effort ${effort})` : ''}: session ${sessionId}, ${pass.findings} finding(s) (pass ${pass.pass}${lens ? `, lens ${lens}` : ''}).`,
        `Verified model (rollout): ${verified.model ?? 'not found'}.`,
        `Wrote ${findingsPath} and ${result.path}.`,
        ...warnings.map((w) => `  warning: ${w}`),
        planEnforced(plan)
          ? result.planMissing.length
            ? `Review plan (${planSummary(plan)}) still needs:\n${result.planMissing.map((m) => `  - ${m}`).join('\n')}`
            : `Review plan (${planSummary(plan)}): met.`
          : '',
        `Next: ${next}`,
      ]
        .filter(Boolean)
        .join('\n'),
  );
}
