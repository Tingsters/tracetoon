/**
 * render -> preview -> publish. `render` freezes the exact title and body and prints
 * an approval code for them. `publish` refuses unless it gets that code and the
 * files are unchanged, so nothing can be posted that the user didn't see.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalCode, scanComment } from '@showtail/agent-traces/share/comment';
import { loadConfig } from '../config.ts';
import type { TraceDigest } from '../digest/build.ts';
import {
  defuseMentions,
  managedBlock,
  mergeIntoBody,
  type PrMeta,
} from '../github/body.ts';
import type { AiPolicy } from '../github/repoContext.ts';
import { prTruth } from '../git/pr.ts';
import { renderPreviewHtml } from '../preview/html.ts';
import { findRun, readJson, readText, writeJson, type Run } from '../run.ts';
import { gh, git, run as exec } from '../util/exec.ts';
import { TOOL_VERSION } from '../version.ts';
import { digestHash } from './digest.ts';
import { emit, UserError, type OutOpts } from './output.ts';

interface Context {
  aiPolicy: AiPolicy;
  existingPr: { number: number; url: string; title: string; body: string } | null;
}

export interface Approval {
  code: string;
  title: string;
  bodySha: string;
  findings: { kind: string; count: number }[];
  allowFindings: boolean;
  mode: 'create' | 'edit';
  prNumber?: number;
  base: string;
  head: string;
  policy: AiPolicy['verdict'];
  ambiguousSessions: string[];
  renderedAt: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const codeFor = (title: string, body: string) => approvalCode(`${title}\n\0${body}`);

function loadRun(cwd: string, runId?: string): { run: Run; gitDir: string } {
  const truth = prTruth(cwd, { noGh: true });
  return { run: findRun(truth.gitDir, runId), gitDir: truth.gitDir };
}

export interface RenderOpts extends OutOpts {
  run?: string;
  allowFindings?: boolean;
}

export function renderCmd(cwd: string, opts: RenderOpts): Approval {
  const { run } = loadRun(cwd, opts.run);
  const digest = readJson<TraceDigest>(run, 'digest.json');
  if (!digest)
    throw new UserError('This run has no digest.json. Run `tracetoon digest` first.');
  const ctx = readJson<Context>(run, 'context.json');
  if (!ctx)
    throw new UserError('This run has no context.json. Run `tracetoon context` first.');
  const bodyMd = readText(run, 'body.md');
  if (!bodyMd?.trim()) {
    throw new UserError(`Write the PR description to ${join(run.dir, 'body.md')} first.`);
  }
  const title =
    readText(run, 'title.txt')?.trim() ||
    ctx.existingPr?.title ||
    digest.pr.commits[digest.pr.commits.length - 1]?.subject ||
    digest.pr.head;

  const meta: PrMeta = {
    v: 1,
    tool: `tracetoon@${TOOL_VERSION}`,
    sessions: digest.sessions.filter((s) => s.band === 'included').map((s) => s.ref),
    digest: digestHash(digest),
    generatedAt: new Date().toISOString(),
  };
  const block = managedBlock(defuseMentions(bodyMd), meta);
  const body = mergeIntoBody(ctx.existingPr?.body, block);
  const findings = scanComment(
    `${title}\n${body.replace(/<!-- tracetoon:meta [\s\S]*? -->/, '')}`,
  );
  const approval: Approval = {
    code: codeFor(title, body),
    title,
    bodySha: sha(body),
    findings,
    allowFindings: !!opts.allowFindings,
    mode: ctx.existingPr ? 'edit' : 'create',
    prNumber: ctx.existingPr?.number,
    base: digest.pr.base,
    head: digest.pr.head,
    policy: ctx.aiPolicy.verdict,
    ambiguousSessions: digest.sessions
      .filter((s) => s.band === 'ambiguous')
      .map((s) => s.ref),
    renderedAt: new Date().toISOString(),
  };
  writeFileSync(join(run.dir, 'final-body.md'), body, 'utf8');
  writeFileSync(
    join(run.dir, 'preview.html'),
    renderPreviewHtml({ title, body, approval, digest }),
    'utf8',
  );
  writeJson(run, 'approval.json', approval);

  emit(
    opts,
    { run: run.id, ...approval, previewPath: join(run.dir, 'preview.html') },
    () =>
      [
        `Rendered "${title}" (${approval.mode === 'edit' ? `update PR #${approval.prNumber}` : 'new PR'})`,
        `Preview: ${join(run.dir, 'preview.html')}`,
        findings.length
          ? `Leak scan found: ${findings.map((f) => `${f.kind}×${f.count}`).join(', ')}. ${
              approval.allowFindings
                ? 'Allowed by --allow-findings.'
                : 'Fix body.md and render again.'
            }`
          : 'Leak scan: clean.',
        approval.policy === 'prohibited'
          ? 'WARNING: this repository appears to prohibit AI-assisted contributions. Read the policy before posting.'
          : '',
        `Approval code: ${approval.code}`,
      ]
        .filter(Boolean)
        .join('\n'),
  );
  return approval;
}

export function previewCmd(
  cwd: string,
  opts: OutOpts & { run?: string; open?: boolean },
): void {
  const { run } = loadRun(cwd, opts.run);
  const approval = readJson<Approval>(run, 'approval.json');
  const body = readText(run, 'final-body.md');
  if (!approval || body === undefined)
    throw new UserError('Nothing rendered yet. Run `tracetoon render` first.');
  const htmlPath = join(run.dir, 'preview.html');
  if (opts.open) openInBrowser(htmlPath);
  emit(
    opts,
    {
      run: run.id,
      title: approval.title,
      body,
      code: approval.code,
      previewPath: htmlPath,
    },
    () =>
      [
        '-'.repeat(72),
        `Title: ${approval.title}`,
        '-'.repeat(72),
        body,
        '-'.repeat(72),
        `Preview in a browser: ${htmlPath}`,
        `Approval code: ${approval.code}`,
      ].join('\n'),
  );
}

function openInBrowser(path: string): void {
  if (process.platform === 'win32') exec('cmd', ['/c', 'start', '', path]);
  else if (process.platform === 'darwin') exec('open', [path]);
  else exec('xdg-open', [path]);
}

export interface PublishOpts extends OutOpts {
  run?: string;
  code?: string;
  yolo?: boolean;
  push?: boolean;
  draft?: boolean;
  ackPolicy?: boolean;
}

export function publishCmd(cwd: string, opts: PublishOpts): void {
  const truth = prTruth(cwd, { noGh: true });
  const run = findRun(truth.gitDir, opts.run);
  const approval = readJson<Approval>(run, 'approval.json');
  const bodyPath = join(run.dir, 'final-body.md');
  if (!approval || !existsSync(bodyPath))
    throw new UserError('Nothing rendered yet. Run `tracetoon render` first.');
  const body = readFileSync(bodyPath, 'utf8');
  const current = codeFor(approval.title, body);
  if (current !== approval.code || sha(body) !== approval.bodySha) {
    throw new UserError(
      'The rendered body changed after it was approved. Run `tracetoon render` again.',
    );
  }
  if (approval.findings.length && !approval.allowFindings) {
    throw new UserError(
      'The leak scan found something in the body. Fix it and render again.',
    );
  }
  if (approval.policy === 'prohibited' && !opts.ackPolicy) {
    throw new UserError(
      'This repository appears to prohibit AI-assisted contributions. Re-run with --ack-policy only if the user has read the policy and still wants to post.',
    );
  }
  if (opts.yolo) {
    const config = loadConfig(truth.toplevel);
    const blockers = [
      !config.yolo && 'yolo is off (enable with `tracetoon config set yolo true`)',
      approval.findings.length > 0 && 'the leak scan found something',
      approval.ambiguousSessions.length > 0 && 'some sessions are ambiguous',
      approval.policy === 'prohibited' &&
        'the repository policy may prohibit AI contributions',
    ].filter(Boolean);
    if (blockers.length) {
      throw new UserError(
        `Yolo publish blocked: ${blockers.join('; ')}. Show the preview instead.`,
        2,
      );
    }
  } else if (opts.code !== approval.code) {
    throw new UserError(
      'Publishing needs the approval code shown with the preview (`--code`).',
    );
  }

  const titleArgs = ['--title', approval.title, '--body-file', bodyPath];
  let url: string;
  if (approval.mode === 'edit' && approval.prNumber) {
    const r = gh(truth.toplevel, ['pr', 'edit', String(approval.prNumber), ...titleArgs]);
    if (!r.ok) throw new UserError(`gh pr edit failed: ${r.stderr.trim()}`);
    url = gh(truth.toplevel, [
      'pr',
      'view',
      String(approval.prNumber),
      '--json',
      'url',
      '-q',
      '.url',
    ]).stdout.trim();
  } else {
    const onRemote = git(truth.toplevel, [
      'ls-remote',
      '--exit-code',
      '--heads',
      'origin',
      approval.head,
    ]).ok;
    if (!onRemote) {
      if (!opts.push) {
        throw new UserError(
          `Branch ${approval.head} is not on GitHub yet. Push it (or re-run with --push) and publish again.`,
        );
      }
      const p = git(truth.toplevel, ['push', '-u', 'origin', approval.head]);
      if (!p.ok) throw new UserError(`git push failed: ${p.stderr.trim()}`);
    }
    const args = [
      'pr',
      'create',
      '--base',
      approval.base,
      '--head',
      approval.head,
      ...titleArgs,
    ];
    if (opts.draft) args.push('--draft');
    const r = gh(truth.toplevel, args);
    if (!r.ok) throw new UserError(`gh pr create failed: ${r.stderr.trim()}`);
    url = r.stdout.trim().split(/\s+/).pop() ?? '';
  }
  writeJson(run, 'published.json', {
    url,
    at: new Date().toISOString(),
    code: approval.code,
    yolo: !!opts.yolo,
  });
  emit(opts, { url, mode: approval.mode }, () => `Published: ${url}`);
}
