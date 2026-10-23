/**
 * render → preview → publish. `render` freezes the exact title, body and comic
 * image and prints an approval code for them. `publish` refuses unless it gets
 * that code and nothing changed, so nothing can be posted that the user didn't
 * see. The only edits after approval fill in where the comic image is hosted.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalCode, scanComment } from '@showtail/agent-traces/share/comment';
import { transcript } from '../comic/script.ts';
import type { ComicScript, SeriesBible } from '../comic/types.ts';
import { loadConfig } from '../config.ts';
import type { TraceDigest } from '../digest/build.ts';
import { assetUrl, publishAssets, type AssetFile } from '../github/assets.ts';
import {
  defuseMentions,
  managedBlock,
  mergeIntoBody,
  type PrMeta,
} from '../github/body.ts';
import type { AiPolicy } from '../github/repoContext.ts';
import { prTruth, type PrTruth } from '../git/pr.ts';
import { renderPreviewHtml } from '../preview/html.ts';
import { findRun, readJson, readText, writeJson, type Run } from '../run.ts';
import { biblePath, repoWeb, type Story } from '../story/story.ts';
import { gh, git, run as exec } from '../util/exec.ts';
import { TOOL_VERSION } from '../version.ts';
import { renderedComic } from './comic.ts';
import { digestHash } from './digest.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export const COMIC_SRC = '{{tracetoon:comic-src}}';
const COMIC_MARKER = '{{tracetoon:comic}}';

interface Context {
  aiPolicy: AiPolicy;
  existingPr: { number: number; url: string; title: string; body: string } | null;
  story?: Story;
  bibleIsNew?: boolean;
}

export interface Approval {
  code: string;
  title: string;
  bodySha: string;
  /** SHA-256 of the comic image, when the PR has one. */
  comicSha?: string;
  comicFile?: string;
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

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const codeFor = (title: string, body: string, comicSha = '') =>
  approvalCode(`${title}\n\0${body}\n\0${comicSha}`);

function loadRun(cwd: string, runId?: string): { run: Run; truth: PrTruth } {
  const truth = prTruth(cwd, { noGh: true });
  return { run: findRun(truth.gitDir, runId), truth };
}

/** The comic as it appears in the body: image, then a collapsed transcript. */
function comicBlock(script: ComicScript, bible: SeriesBible, story?: Story): string {
  const prev = story?.previously.length
    ? `\n\n<sub>Previously: ${story.previously.join(' · ')}</sub>`
    : '';
  const alt = script.altText.replace(/[\[\]\n]/g, ' ').trim();
  return `<p align="center"><img src="${COMIC_SRC}" alt="${alt.replace(/"/g, "'")}" width="760"></p>${prev}

<details>
<summary>Comic transcript${story ? ` (${bible.title}, episode ${story.episode})` : ''}</summary>

${transcript(script, bible)}

</details>`;
}

export interface RenderOpts extends OutOpts {
  run?: string;
  allowFindings?: boolean;
  noComic?: boolean;
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

  const script = readJson<ComicScript>(run, 'comic.json');
  const bible = readJson<SeriesBible>(run, 'bible.json');
  const comic = opts.noComic ? undefined : renderedComic(run);
  let content = defuseMentions(bodyMd).replace(COMIC_MARKER, '');
  if (comic && script && bible) {
    const block = comicBlock(script, bible, ctx.story);
    content = bodyMd.includes(COMIC_MARKER)
      ? defuseMentions(bodyMd).replace(COMIC_MARKER, block)
      : `${block}\n\n${content}`;
  }

  const story = ctx.story;
  const meta: PrMeta = {
    v: 1,
    tool: `tracetoon@${TOOL_VERSION}`,
    sessions: digest.sessions.filter((s) => s.band === 'included').map((s) => s.ref),
    digest: digestHash(digest),
    generatedAt: new Date().toISOString(),
    ...(story && bible
      ? {
          series: story.series,
          episode: story.episode,
          theme: bible.theme,
          ...(story.saga
            ? { saga: story.saga.id, prev: story.saga.prs.map((p) => p.number) }
            : {}),
        }
      : {}),
    ...(script?.synopsis ? { synopsis: script.synopsis.slice(0, 280) } : {}),
  };
  const block = managedBlock(content, meta);
  const body = mergeIntoBody(ctx.existingPr?.body, block);
  const findings = scanComment(
    `${title}\n${body.replace(/<!-- tracetoon:meta [\s\S]*? -->/, '')}`,
  );
  const comicSha = comic ? sha(comic.data) : undefined;
  const approval: Approval = {
    code: codeFor(title, body, comicSha),
    title,
    bodySha: sha(body),
    comicSha,
    comicFile: comic?.path,
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
  const previewBody = comic
    ? body.replaceAll(COMIC_SRC, `./out/${comic.path.split(/[\\/]/).pop()}`)
    : body;
  writeFileSync(
    join(run.dir, 'preview.html'),
    renderPreviewHtml({ title, body: previewBody, approval, digest }),
    'utf8',
  );
  writeJson(run, 'approval.json', approval);

  emit(
    opts,
    { run: run.id, ...approval, previewPath: join(run.dir, 'preview.html') },
    () =>
      [
        `Rendered "${title}" (${approval.mode === 'edit' ? `update PR #${approval.prNumber}` : 'new PR'})${comic ? ' with comic' : ''}`,
        `Preview: ${join(run.dir, 'preview.html')}`,
        findings.length
          ? `Leak scan found: ${findings.map((f) => `${f.kind} x${f.count}`).join(', ')}. ${
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
  const shown = approval.comicFile
    ? body.replaceAll(COMIC_SRC, approval.comicFile)
    : body;
  emit(
    opts,
    {
      run: run.id,
      title: approval.title,
      body: shown,
      code: approval.code,
      comic: approval.comicFile ?? null,
      previewPath: htmlPath,
    },
    () =>
      [
        '-'.repeat(72),
        `Title: ${approval.title}`,
        '-'.repeat(72),
        shown,
        '-'.repeat(72),
        approval.comicFile ? `Comic image: ${approval.comicFile}` : '',
        `Preview in a browser: ${htmlPath}`,
        `Approval code: ${approval.code}`,
      ]
        .filter(Boolean)
        .join('\n'),
  );
}

function openInBrowser(path: string): void {
  if (process.platform === 'win32') exec('cmd', ['/c', 'start', '', path]);
  else if (process.platform === 'darwin') exec('open', [path]);
  else exec('xdg-open', [path]);
}

function ghVersionAtLeast(cwd: string, min: [number, number]): boolean {
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(gh(cwd, ['--version']).stdout);
  if (!v) return false;
  const [maj, minor] = [Number(v[1]), Number(v[2])];
  return maj > min[0] || (maj === min[0] && minor >= min[1]);
}

function repoIsPrivate(cwd: string): boolean {
  const r = gh(cwd, ['repo', 'view', '--json', 'visibility', '-q', '.visibility']);
  return r.ok && /private|internal/i.test(r.stdout);
}

interface Hosted {
  body: string;
  attach?: string;
  assetsCommit?: string;
  hosting: 'branch' | 'attach' | 'none';
}

/** Put the comic somewhere GitHub can show it, and fill in its URL. */
function hostComic(
  truth: PrTruth,
  run: Run,
  approval: Approval,
  body: string,
  mode: 'auto' | 'branch' | 'attach',
): Hosted {
  if (!approval.comicFile || !approval.comicSha) return { body, hosting: 'none' };
  const data = readFileSync(approval.comicFile);
  if (sha(data) !== approval.comicSha) {
    throw new UserError(
      'The comic image changed after it was approved. Run `tracetoon render` again.',
    );
  }
  const canAttach = ghVersionAtLeast(truth.toplevel, [2, 99]);
  const web = repoWeb(truth);
  const tryAttach = (): Hosted => {
    if (!canAttach)
      throw new UserError(
        'Attaching images needs GitHub CLI 2.99 or newer (`gh --version`).',
      );
    const local = approval.comicFile!.replace(/\\/g, '/');
    return {
      body: body.replaceAll(COMIC_SRC, local),
      attach: approval.comicFile,
      hosting: 'attach',
    };
  };
  const wantAttach =
    mode === 'attach' || (mode === 'auto' && canAttach && repoIsPrivate(truth.toplevel));
  if (wantAttach) return tryAttach();
  if (!web) {
    if (canAttach) return tryAttach();
    throw new UserError(
      'Cannot work out the GitHub URL for this repo to host the comic. Set an `origin` GitHub remote.',
    );
  }
  const ctx = readJson<Context>(run, 'context.json');
  const script = readJson<ComicScript>(run, 'comic.json');
  const bible = readJson<SeriesBible>(run, 'bible.json');
  const series = ctx?.story?.series ?? bible?.series ?? 'series';
  const folder = `episodes/${series}/${approval.prNumber ?? approval.head.replace(/[^\w.-]+/g, '-')}-${approval.comicSha.slice(0, 7)}`;
  const ext = approval.comicFile.endsWith('.svg') ? 'svg' : 'png';
  const files: AssetFile[] = [{ path: `${folder}/comic.${ext}`, data }];
  if (script)
    files.push({ path: `${folder}/script.json`, data: JSON.stringify(script, null, 2) });
  if (bible && ctx?.bibleIsNew)
    files.push({ path: biblePath(bible.series), data: JSON.stringify(bible, null, 2) });
  try {
    const commit = publishAssets(truth.toplevel, files, `tracetoon: ${folder}`);
    return {
      body: body.replaceAll(COMIC_SRC, assetUrl(web, commit, `${folder}/comic.${ext}`)),
      assetsCommit: commit,
      hosting: 'branch',
    };
  } catch (e) {
    if (mode === 'auto' && canAttach) return tryAttach();
    throw new UserError(
      `Could not host the comic on the assets branch: ${(e as Error).message}`,
    );
  }
}

export interface PublishOpts extends OutOpts {
  run?: string;
  code?: string;
  yolo?: boolean;
  push?: boolean;
  draft?: boolean;
  ackPolicy?: boolean;
  hosting?: 'auto' | 'branch' | 'attach';
}

export function publishCmd(cwd: string, opts: PublishOpts): void {
  const { run, truth } = loadRun(cwd, opts.run);
  const approval = readJson<Approval>(run, 'approval.json');
  const bodyPath = join(run.dir, 'final-body.md');
  if (!approval || !existsSync(bodyPath))
    throw new UserError('Nothing rendered yet. Run `tracetoon render` first.');
  const body = readFileSync(bodyPath, 'utf8');
  const current = codeFor(approval.title, body, approval.comicSha);
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
  const config = loadConfig(truth.toplevel);
  if (opts.yolo) {
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

  if (approval.mode === 'create') {
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
  }

  const hosted = hostComic(truth, run, approval, body, opts.hosting ?? config.hosting);
  const postedPath = join(run.dir, 'posted-body.md');
  writeFileSync(postedPath, hosted.body, 'utf8');
  const args = ['--title', approval.title, '--body-file', postedPath];
  if (hosted.attach) args.push('--attach', hosted.attach);
  let url: string;
  if (approval.mode === 'edit' && approval.prNumber) {
    const r = gh(truth.toplevel, ['pr', 'edit', String(approval.prNumber), ...args]);
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
    const create = [
      'pr',
      'create',
      '--base',
      approval.base,
      '--head',
      approval.head,
      ...args,
    ];
    if (opts.draft) create.push('--draft');
    const r = gh(truth.toplevel, create);
    if (!r.ok) throw new UserError(`gh pr create failed: ${r.stderr.trim()}`);
    url = r.stdout.trim().split(/\s+/).pop() ?? '';
  }
  writeJson(run, 'published.json', {
    url,
    at: new Date().toISOString(),
    code: approval.code,
    yolo: !!opts.yolo,
    hosting: hosted.hosting,
    assetsCommit: hosted.assetsCommit,
  });
  emit(
    opts,
    { url, mode: approval.mode, hosting: hosted.hosting },
    () =>
      `Published: ${url}${hosted.hosting !== 'none' ? ` (comic hosted via ${hosted.hosting})` : ''}`,
  );
}
