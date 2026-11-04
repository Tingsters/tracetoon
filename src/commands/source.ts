/** Exact base/head code snapshots for claims outside diff hunks. */
import { createHash } from 'node:crypto';
import { repository } from '../workflow/state.ts';
import { assertRunOwner, findRun, readJson, writeJson } from '../run.ts';
import { repoPath } from '../util/repoFiles.ts';
import { git } from '../util/exec.ts';
import { makeScrubber } from '../digest/sanitize.ts';
import type { TraceDigest } from '../digest/build.ts';
import type { SubmissionSnapshot } from '../review/snapshot.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export interface CodeSource {
  id: string;
  path: string;
  revision: string;
  blob: string;
  sha256: string;
  content: string;
}
export interface CodeSources {
  schema: 'tracetoon.code-sources/v1';
  files: CodeSource[];
}
export const codeHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function sourceCmd(
  cwd: string,
  paths: string[],
  opts: OutOpts & { run?: string; revision?: string },
) {
  const repo = repository(cwd),
    run = findRun(repo.gitDir, opts.run);
  assertRunOwner(run, repo.root, repo.branch);
  if (!paths.length || paths.some((path) => !repoPath(path)))
    throw new UserError('Source paths must be public repository-relative paths.');
  const digest = readJson<TraceDigest>(run, 'digest.json'),
    snapshot = readJson<SubmissionSnapshot>(run, 'submission.json');
  if (!digest || !snapshot)
    throw new UserError('Prepare a digest before collecting code evidence.');
  const requested = opts.revision ?? 'head';
  const revision =
    requested === 'base'
      ? digest.pr.mergeBase
      : requested === 'head'
        ? snapshot.headSha
        : requested;
  if (
    ![digest.pr.mergeBase, snapshot.headSha].includes(revision) ||
    !/^[a-f0-9]{40,64}$/.test(revision)
  )
    throw new UserError('Code evidence must use the prepared base or head revision.');
  if (digest.pr.usedWorkingTree && revision !== digest.pr.mergeBase)
    throw new UserError(
      'Working-tree changes are covered by changes.patch; source snapshots require committed head or base code.',
    );
  const result = git(
    cwd,
    ['cat-file', '--batch'],
    paths.map((path) => `${revision}:${path}`).join('\n') + '\n',
  );
  if (!result.ok) throw new UserError('Could not collect code evidence.');
  const bytes = Buffer.from(result.stdout),
    files: CodeSource[] = [],
    scrub = makeScrubber([repo.root]);
  let offset = 0;
  for (const path of paths) {
    const end = bytes.indexOf(10, offset),
      match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(
        bytes.subarray(offset, end).toString('utf8'),
      );
    if (!match)
      throw new UserError(`No regular source blob for ${path} at the prepared revision.`);
    const size = Number(match[2]),
      raw = bytes.subarray(end + 1, end + 1 + size);
    if (raw.includes(0) || !Buffer.from(raw.toString('utf8')).equals(raw))
      throw new UserError(`Code evidence requires UTF-8 text: ${path}`);
    const content = scrub.text(raw.toString('utf8'));
    files.push({
      id: codeHash(`${revision}\0${path}\0${match[1]}`).slice(0, 24),
      path,
      revision,
      blob: match[1]!,
      sha256: codeHash(content),
      content,
    });
    offset = end + 1 + size + 1;
  }
  const previous = readJson<CodeSources>(run, 'source-evidence.json');
  const all = new Map((previous?.files ?? []).map((file) => [file.id, file]));
  for (const file of files) all.set(file.id, file);
  writeJson(run, 'source-evidence.json', {
    schema: 'tracetoon.code-sources/v1',
    files: [...all.values()].sort((a, b) => a.id.localeCompare(b.id)),
  });
  const records = files.map((file) => ({
    ...file,
    reference: `code:${file.id}:1-${file.content.split(/\r?\n/).length}`,
  }));
  emit(opts, records, () => JSON.stringify(records, null, 2));
}
