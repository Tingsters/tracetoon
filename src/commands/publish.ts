/**
 * render → preview → publish. `render` freezes the exact title, body and comic
 * image and prints an approval code for them. `publish` refuses unless it gets
 * that code and nothing changed, so nothing can be posted that the user didn't
 * see. The only edits after approval fill in where the comic image is hosted.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  contributionPolicy,
  loadGuidance,
  objectHash,
  researchPacket,
} from '../contribution/guidance.ts';
import {
  loadReview,
  reviewInput,
  reviewLine,
  reviewSummary,
} from '../contribution/review.ts';
import type { GuidanceRequest, ReviewResult } from '../contribution/types.ts';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { approvalCode, scanComment } from '@showtail/agent-traces/share/comment';
import { transcript } from '../comic/script.ts';
import type { ComicScript } from '../comic/types.ts';
import { loadConfig } from '../config.ts';
import type { TraceDigest } from '../digest/build.ts';
import { checkClaims, claimSummary, type ClaimFinding } from '../digest/claims.ts';
import { contextNotes, evidenceNotes } from '../digest/notes.ts';
import { assetUrl, publishAssets, type AssetFile } from '../github/assets.ts';
import {
  contentHash,
  decodeMeta,
  titleHash,
  defuseMentions,
  managedBlock,
  mergeIntoBody,
  type PrMeta,
} from '../github/body.ts';
import type { AiPolicy } from '../github/repoContext.ts';
import { defaultBase, prTruth, type PrTruth } from '../git/pr.ts';
import { renderPreviewHtml } from '../preview/html.ts';
import { findRun, readJson, readText, writeJson, type Run } from '../run.ts';
import { repoWeb } from '../github/history.ts';
import type { TitleRules } from '../github/titleRules.ts';
import { checkTitle, titleLine } from '../digest/titleCheck.ts';
import { gh, git, run as exec } from '../util/exec.ts';
import { TOOL_VERSION } from '../version.ts';
import { renderedComic } from './comic.ts';
import { digestHash } from './digest.ts';
import { emit, UserError, type OutOpts } from './output.ts';
import {
  sameSubmission,
  snapshotProblem,
  submissionSnapshot,
  type SubmissionSnapshot,
} from '../review/snapshot.ts';
import { previewHandoff } from '../review/handoff.ts';
import { recordRendered, setReviewState } from '../review/pending.ts';
import { userCommand } from '../util/userCommand.ts';

export const COMIC_SRC = '{{tracetoon:comic-src}}';
const COMIC_MARKER = '{{tracetoon:comic}}';

interface Context {
  base?: string;
  contribution?: GuidanceRequest;
  aiPolicy: AiPolicy;
  existingPr: { number: number; url: string; title: string; body: string } | null;
  config?: { disclosure?: 'assisted-by' | 'co-authored-by' | 'none' };
  titleRules?: TitleRules;
}

/**
 * One short disclosure line, added after the description and the comic. The
 * match percentage and session details live in the preview, not the PR.
 */
export function disclosureLine(
  digest: Pick<TraceDigest, 'disclosure'>,
  mode: 'assisted-by' | 'co-authored-by' | 'none' = 'assisted-by',
  form?: AiPolicy['disclosure'],
): string {
  if (mode === 'none') return '';
  const trailers = digest.disclosure.suggestedTrailers;
  if (!trailers.length) return '';
  const tools = digest.disclosure.agents.join(', ');
  if (form === 'tool-and-use') {
    // e.g. Django, Ghostty: name the tool and model, and say what it was used for.
    const models = digest.disclosure.models.join(', ');
    return `<sub>AI use: ${tools}${models ? ` (${models})` : ''} assisted with the code; this description was drafted from the session logs with [Tracetoon](https://github.com/Tingsters/tracetoon) and reviewed by the author.</sub>`;
  }
  const trailer =
    mode === 'assisted-by' ? trailers.join(' · ') : `AI-assisted with ${tools}`;
  return `<sub>${trailer} · description drafted from the session logs with [Tracetoon](https://github.com/Tingsters/tracetoon) and reviewed by the author</sub>`;
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
  /** The repo's agent instructions say never to open a PR. */
  noPullRequests?: boolean;
  ambiguousSessions: string[];
  renderedAt: string;
  /** Optional only for reading pre-upgrade previews; publishing requires it. */
  submission?: SubmissionSnapshot;
}

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const codeFor = (approval: Approval, body: string) =>
  approvalCode(
    `${approval.title}\n\0${body}\n\0${approval.comicSha ?? ''}\n\0${objectHash({ submission: approval.submission, head: approval.head, base: approval.base, mode: approval.mode, prNumber: approval.prNumber })}`,
  );

/**
 * The branch to open the PR against. A digest can compare with a commit (to
 * tell the story of the whole history, say), but a PR targets a branch: then
 * it's the repo's default branch.
 */
export function prBase(root: string, base: string): string {
  const branch = (name: string) =>
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok ||
    git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`]).ok;
  return branch(base) ? base : defaultBase(root);
}

/** Commits added since the digest, which its checks can't see. */
export function digestStale(
  root: string,
  digest: Pick<TraceDigest, 'pr'>,
): string | undefined {
  if (digest.pr.usedWorkingTree) return undefined;
  const last = digest.pr.commits[digest.pr.commits.length - 1]?.sha;
  const head = git(root, ['rev-parse', `${digest.pr.head}^{commit}`]).stdout.trim();
  if (!last || !head || head.startsWith(last)) return undefined;
  const added = git(root, ['rev-list', '--count', `${last}..${head}`]).stdout.trim();
  return `${added && added !== '0' ? `${added} commit(s) were` : 'Commits were'} added after the digest; run \`tracetoon digest\` again so the description and checks see them.`;
}

function loadRun(cwd: string, runId?: string): { run: Run; truth: PrTruth } {
  const truth = prTruth(cwd, { noGh: true });
  return { run: findRun(truth.gitDir, runId), truth };
}

/** The comic as it appears in the body: image, then a collapsed transcript. */
function comicBlock(script: ComicScript): string {
  const alt = script.altText.replace(/[\[\]\n]/g, ' ').trim();
  return `<p align="center"><img src="${COMIC_SRC}" alt="${alt.replace(/"/g, "'")}" width="760"></p>

<details>
<summary>Comic transcript</summary>

${transcript(script)}

</details>`;
}

export interface RenderOpts extends OutOpts {
  run?: string;
  allowFindings?: boolean;
  noComic?: boolean;
  /** Replace a title a person chose (only after the user agrees). */
  retitle?: boolean;
}

export function renderCmd(cwd: string, opts: RenderOpts): Approval {
  let { run, truth } = loadRun(cwd, opts.run);
  const digest = readJson<TraceDigest>(run, 'digest.json');
  if (!digest)
    throw new UserError('This run has no digest.json. Run `tracetoon digest` first.');
  const ctx = readJson<Context>(run, 'context.json');
  if (!ctx)
    throw new UserError('This run has no context.json. Run `tracetoon context` first.');
  if (ctx.base && ctx.base !== truth.base)
    truth = prTruth(cwd, { base: ctx.base, noGh: true });
  const captured = readJson<SubmissionSnapshot>(run, 'submission.json');
  if (!captured || !sameSubmission(captured, submissionSnapshot(truth)))
    throw new UserError(
      `The digest needs refreshing for the current code. Run tracetoon digest --run ${run.id}, then context, update the description, and render again.`,
    );
  const packet = researchPacket(truth, ctx.contribution?.offline ?? false);
  const guidance = loadGuidance(run, truth.toplevel, packet.request);
  const composition = contributionPolicy(ctx.aiPolicy, guidance);
  ctx.aiPolicy = composition.policy;
  const bodyMd = readText(run, 'body.md');
  if (!bodyMd?.trim()) {
    throw new UserError(`Write the PR description to ${join(run.dir, 'body.md')} first.`);
  }
  // The title: a person's choice is kept. A title edited on GitHub since
  // Tracetoon posted it, or written by someone on a PR Tracetoon didn't title,
  // stays unless the user agrees to replace it (--retitle).
  const proposed = readText(run, 'title.txt')?.trim();
  const current = ctx.existingPr?.title;
  const postedTitle = ctx.existingPr
    ? decodeMeta(ctx.existingPr.body)?.titleSha
    : undefined;
  const chosenByPerson =
    !!current && (postedTitle ? postedTitle !== titleHash(current) : true);
  let titleNote: string | undefined;
  let title: string;
  if (proposed && current && proposed !== current && chosenByPerson && !opts.retitle) {
    title = current;
    titleNote = `Kept the PR's current title "${current}" (${postedTitle ? 'edited on GitHub' : 'chosen by a person'}); title.txt proposes "${proposed}". Re-render with --retitle only if the user agrees.`;
  } else {
    title =
      proposed ||
      current ||
      digest.pr.commits[digest.pr.commits.length - 1]?.subject ||
      digest.pr.head;
  }
  const titleFindings = checkTitle({ title, rules: ctx.titleRules, digest });
  writeJson(run, 'title-checks.json', titleFindings);

  const script = readJson<ComicScript>(run, 'comic.json');
  const mediaBanned = ctx.aiPolicy.media === 'prohibited';
  const comic = opts.noComic || mediaBanned ? undefined : renderedComic(run);
  // The description comes first; the comic is the closing beat, unless the
  // writer placed it with the marker. A short disclosure goes last.
  let content = defuseMentions(bodyMd).replace(COMIC_MARKER, '');
  if (comic && script) {
    const block = comicBlock(script);
    content = bodyMd.includes(COMIC_MARKER)
      ? defuseMentions(bodyMd).replace(COMIC_MARKER, block)
      : `${content.trim()}\n\n${block}`;
  }
  const disclosureMode =
    composition.disclosure === 'required' && ctx.config?.disclosure === 'none'
      ? 'assisted-by'
      : ctx.config?.disclosure;
  const disclosure =
    composition.disclosure === 'prohibited'
      ? ''
      : disclosureLine(digest, disclosureMode, ctx.aiPolicy.disclosure) ||
        (composition.disclosure === 'required'
          ? '<sub>This description was drafted with [Tracetoon](https://github.com/Tingsters/tracetoon).</sub>'
          : '');
  if (disclosure) content = `${content.trim()}\n\n${disclosure}`;

  // Only what's read back later: the comic's style (so the next one differs)
  // and a hash of the text as posted (to keep edits made on GitHub).
  const meta: PrMeta = {
    v: 1,
    ...(comic && script?.style ? { style: script.style } : {}),
    contentSha: contentHash(content),
    titleSha: titleHash(title),
  };
  const block = managedBlock(content, meta);
  const body = mergeIntoBody(ctx.existingPr?.body, block);
  const findings = scanComment(
    `${title}\n${body.replace(/<!-- tracetoon:meta [\s\S]*? -->/, '')}`,
  );
  const comicSha = comic ? sha(comic.data) : undefined;
  const approval: Approval = {
    code: '',
    title,
    bodySha: sha(body),
    comicSha,
    comicFile: comic?.path,
    findings,
    allowFindings: !!opts.allowFindings,
    mode: ctx.existingPr ? 'edit' : 'create',
    prNumber: ctx.existingPr?.number,
    base: prBase(truth.toplevel, digest.pr.base),
    head: digest.pr.head,
    policy: ctx.aiPolicy.verdict,
    ...(ctx.aiPolicy.noPullRequests ? { noPullRequests: true } : {}),
    ambiguousSessions: digest.sessions
      .filter((s) => s.band === 'ambiguous')
      .map((s) => s.ref),
    renderedAt: new Date().toISOString(),
    submission: captured,
  };
  approval.code = codeFor(approval, body);
  writeFileSync(join(run.dir, 'final-body.md'), body, 'utf8');
  writeFileSync(join(run.dir, 'changes.patch'), packet.patch, 'utf8');
  const reviewPacket = reviewInput({
    title,
    body,
    guidance,
    digest,
    diffSha256: packet.request.diffSha256,
    headSha: packet.request.headSha,
    authorText: readText(run, 'author.md'),
    comicSha256: comicSha,
  });
  writeJson(run, 'review-input.json', reviewPacket);
  const contributionReview = loadReview(
    run,
    reviewPacket,
    guidance,
    digest,
    packet.patch,
    composition.issues,
  );
  writeJson(run, 'review-result.json', contributionReview);
  // Advisory: check the description's claims against the captured evidence.
  const claims = checkClaims({
    title,
    body: bodyMd,
    digest,
    root: truth.toplevel,
    authorText: readText(run, 'author.md'),
  });
  writeJson(run, 'claims.json', claims);
  const notes = contextNotes(digest, bodyMd, claims);
  writeJson(run, 'notes.json', notes);
  // Authors who write the text themselves (or must, by policy) get the facts as an outline.
  const writeYourself =
    ctx.aiPolicy.text === 'prohibited' ||
    ctx.aiPolicy.text === 'author-written-recommended';
  const outline = evidenceNotes(digest);
  writeFileSync(join(run.dir, 'evidence-notes.md'), outline, 'utf8');
  // The comic is embedded, so the preview shows it in any browser and from any
  // folder (sandboxed browsers can't read files inside .git).
  const comicData = comic
    ? `data:${comic.mime};base64,${comic.data.toString('base64')}`
    : '';
  let previewComic: { src: string; data: string } | undefined;
  if (comic) {
    let src: string;
    do {
      src = `tracetoon-preview-comic-${randomUUID()}.png`;
    } while (body.includes(src));
    previewComic = { src, data: comicData };
  }
  const previewBody = previewComic ? body.replaceAll(COMIC_SRC, previewComic.src) : body;
  writeFileSync(
    join(run.dir, 'preview.html'),
    renderPreviewHtml({
      title,
      body: previewBody,
      approval,
      claims,
      titleFindings,
      titleNote,
      notes,
      policy: ctx.aiPolicy,
      outline: writeYourself ? outline : undefined,
      comicHeldBack: mediaBanned && !!renderedComic(run),
      digest,
      previewComic,
      contributionReview,
      share: comic
        ? {
            image: comicData,
            caption: shareCaption(script, title, '(link to the PR)'),
          }
        : undefined,
    }),
    'utf8',
  );
  writeJson(run, 'approval.json', approval);
  recordRendered(truth.gitDir, run, approval);

  const previewPath = join(run.dir, 'preview.html');
  const stale = digestStale(truth.toplevel, digest);
  const handoff = previewHandoff({
    root: truth.toplevel,
    command: userCommand().run,
    url: fileUrl(previewPath),
    run: run.id,
  });
  emit(
    opts,
    {
      run: run.id,
      ...approval,
      previewPath,
      previewUrl: fileUrl(previewPath),
      previewHandoff: handoff,
      titleChecks: titleFindings,
      contributionReview: reviewSummary(contributionReview),
      reviewInputPath: join(run.dir, 'review-input.json'),
      reviewFingerprint: reviewPacket.fingerprint,
      ...(titleNote ? { titleNote } : {}),
      claims: {
        ...claimSummary(claims),
        findings: claims.filter(
          (c) => c.state === 'contradicted' || c.state === 'not established',
        ),
      },
    },
    () =>
      [
        `Rendered "${title}" (${approval.mode === 'edit' ? `update PR #${approval.prNumber}` : 'new PR'})${comic ? ' with comic' : ''}`,
        approval.mode === 'create'
          ? `PR base: ${approval.base}${approval.base !== digest.pr.base ? ` (the story covers changes since ${digest.pr.base.slice(0, 12)})` : ''}`
          : '',
        stale ? `Warning: ${stale}` : '',
        findings.length
          ? `Leak scan found: ${findings.map((f) => `${f.kind} x${f.count}`).join(', ')}. ${
              approval.allowFindings
                ? 'Allowed by --allow-findings.'
                : 'Fix body.md and render again.'
            }`
          : 'Leak scan: clean.',
        titleNote ? `Note: ${titleNote}` : '',
        titleLine(titleFindings),
        claimLine(claims),
        reviewLine(contributionReview),
        notes.length
          ? `Optional notes for the author (skippable; offer them, don't ask before drafting):\n${notes.map((n) => `  - ${n.text}`).join('\n')}`
          : '',
        policyLines(ctx.aiPolicy, mediaBanned),
        !comic && !opts.noComic && !mediaBanned && existsSync(join(run.dir, 'comic.json'))
          ? 'No comic: comic.json exists but no comic was drawn, so this PR has none.'
          : '',
        approval.policy === 'prohibited'
          ? 'WARNING: this repository appears to prohibit AI-assisted contributions. Read the policy before posting.'
          : '',
        `Approval code: ${approval.code}`,
        '',
        handoff.terminal,
      ]
        .filter(Boolean)
        .join('\n'),
  );
  return approval;
}

/** What the repo's AI policy means for this PR, in a few lines. */
function policyLines(policy: AiPolicy, mediaBanned: boolean): string {
  const out: string[] = [];
  if (policy.text === 'prohibited')
    out.push(
      'Policy: this repository appears to prohibit AI-written contributions. The draft is notes, not ready to post; see evidence-notes.md. Publishing needs --ack-policy.',
    );
  else if (policy.text === 'author-written-recommended')
    out.push(
      'Policy: this repository asks authors to write PR text themselves. Offer evidence-notes.md as an outline to write from; the draft is optional.',
    );
  if (mediaBanned)
    out.push(
      'Policy: AI-generated images are not allowed here, so the comic is left out.',
    );
  if (policy.noPullRequests)
    out.push(
      "Policy: the repo's agent instructions say never to open a PR. Only post if the user explicitly decides to (--ack-policy).",
    );
  if (policy.disclosure && policy.disclosure !== 'unspecified')
    out.push(
      `Policy: disclosure in the form the repo asks for (${policy.disclosure}) is added.`,
    );
  for (const i of policy.prInstructions ?? [])
    out.push(`Repo instruction (${i.file}:${i.line}): ${i.text}`);
  return out.join('\n');
}

/** One advisory line about the claim check, with the claims worth a look. */
function claimLine(claims: ClaimFinding[]): string {
  if (!claims.length) return '';
  const c = claimSummary(claims);
  const look = claims.filter(
    (x) => x.state === 'contradicted' || x.state === 'not established',
  );
  return [
    `Claim check (advisory): ${c.observed} supported, ${c['author-reported']} author-reported, ${c['not established']} not established, ${c.contradicted} contradicted.`,
    ...look.map((x) => `  - ${x.state}: "${x.quote.slice(0, 90)}" (${x.detail})`),
  ].join('\n');
}

export function previewCmd(
  cwd: string,
  opts: OutOpts & { run?: string; open?: boolean },
): void {
  const { run, truth } = loadRun(cwd, opts.run);
  const approval = readJson<Approval>(run, 'approval.json');
  const body = readText(run, 'final-body.md');
  const contributionReview = readJson<ReviewResult>(run, 'review-result.json');
  if (!approval || body === undefined)
    throw new UserError('Nothing rendered yet. Run `tracetoon render` first.');
  const htmlPath = join(run.dir, 'preview.html');
  const problem = snapshotProblem(truth.toplevel, approval.submission);
  const handoff = previewHandoff({
    root: truth.toplevel,
    command: userCommand().run,
    url: fileUrl(htmlPath),
    run: run.id,
    problem,
  });
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
      previewUrl: fileUrl(htmlPath),
      previewHandoff: handoff,
      contributionReview: contributionReview && reviewSummary(contributionReview),
    },
    () =>
      [
        '-'.repeat(72),
        `Title: ${approval.title}`,
        '-'.repeat(72),
        shown,
        contributionReview ? reviewLine(contributionReview) : '',
        '-'.repeat(72),
        approval.comicFile ? `Comic image: ${fileUrl(approval.comicFile)}` : '',
        `Approval code: ${approval.code}`,
        '',
        handoff.terminal,
      ]
        .filter(Boolean)
        .join('\n'),
  );
}

/**
 * A file path as an absolute file:/// URL. Terminals and agent UIs turn these
 * into clickable links (Ctrl+click), unlike bare or relative paths.
 */
export function fileUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
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
  /** Where the comic image can be viewed, when it is on the assets branch. */
  imageUrl?: string;
}

/**
 * A ready-to-post caption for social media: the headline, what happened in one
 * line, and the PR link. Kept under 280 characters.
 */
export function shareCaption(
  script: ComicScript | undefined,
  title: string,
  url: string,
): string {
  const headline = (script?.v === 2 && script.headline) || script?.title || title;
  const tail = `\n${url} #tracetoon`;
  const room = 280 - headline.length - tail.length - 3;
  let line = (script?.synopsis ?? '').replace(/\s+/g, ' ').trim();
  if (line.length > room)
    line = `${line.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/, '')}…`;
  return `${headline}${line ? ` — ${line}` : ''}${tail}`;
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
  // Only the image goes on the assets branch: nothing a later PR reads back.
  const folder = `comics/${approval.prNumber ?? approval.head.replace(/[^\w.-]+/g, '-')}-${approval.comicSha.slice(0, 7)}`;
  const ext = approval.comicFile.endsWith('.svg') ? 'svg' : 'png';
  const files: AssetFile[] = [{ path: `${folder}/comic.${ext}`, data }];
  try {
    const commit = publishAssets(truth.toplevel, files, `tracetoon: ${folder}`);
    return {
      body: body.replaceAll(COMIC_SRC, assetUrl(web, commit, `${folder}/comic.${ext}`)),
      imageUrl: assetUrl(web, commit, `${folder}/comic.${ext}`),
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
  const problem = snapshotProblem(truth.toplevel, approval.submission);
  if (problem)
    throw new UserError(
      `${problem} Run tracetoon digest --run ${run.id}, then refresh context, description, review and preview before publishing.`,
    );
  if (approval.submission?.usedWorkingTree)
    throw new UserError(
      `This preview includes uncommitted work. Commit the changes, then run tracetoon digest --run ${run.id} and refresh the preview before publishing.`,
    );
  const body = readFileSync(bodyPath, 'utf8');
  const current = codeFor(approval, body);
  if (current !== approval.code || sha(body) !== approval.bodySha) {
    throw new UserError(
      'The rendered body or publication target changed after it was approved. Run `tracetoon render` again.',
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
  if (approval.noPullRequests && !opts.ackPolicy) {
    throw new UserError(
      "This repository's agent instructions say never to open a PR. Re-run with --ack-policy only if the user has read them and decides to post anyway.",
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
      approval.noPullRequests && "the repo's agent instructions say never to open a PR",
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

  {
    const remote = git(truth.toplevel, [
      'ls-remote',
      '--exit-code',
      '--heads',
      'origin',
      `refs/heads/${approval.head}`,
    ]);
    const remoteSha = remote.stdout.trim().split(/\s/)[0];
    if (!remote.ok || remoteSha !== approval.submission!.headSha) {
      if (!opts.push) {
        throw new UserError(
          remoteSha
            ? `Branch ${approval.head} on GitHub differs from the approved code. Push it (or re-run with --push) and publish again.`
            : `Branch ${approval.head} is not on GitHub yet. Push it (or re-run with --push) and publish again.`,
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
  setReviewState(run, approval, 'published');
  const shareScript = readJson<ComicScript>(run, 'comic.json');
  const share =
    hosted.hosting !== 'none'
      ? {
          caption: shareCaption(shareScript, approval.title, url),
          image: hosted.imageUrl ?? null,
        }
      : undefined;
  emit(opts, { url, mode: approval.mode, hosting: hosted.hosting, share }, () =>
    [
      `Published: ${url}${hosted.hosting !== 'none' ? ` (comic hosted via ${hosted.hosting})` : ''}`,
      share
        ? `\nShare it (offer this to the user):\n${share.caption}${share.image ? `\nImage: ${share.image}` : ''}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
