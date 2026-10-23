/**
 * Continuity: which series a repo's comics belong to, which episode this PR is,
 * and which other PRs it continues (a saga). Nothing is stored on the developer's
 * machine: the bible lives on the assets branch and each PR carries its own
 * metadata, so any clone can pick up the story.
 */
import { createHash } from 'node:crypto';
import { addAgents, defaultBible } from '../comic/bible.ts';
import type { SeriesBible, Theme } from '../comic/types.ts';
import { decodeMeta, type PrMeta } from '../github/body.ts';
import { fetchAssets, readAssetText } from '../github/assets.ts';
import type { PrTruth } from '../git/pr.ts';
import { gh } from '../util/exec.ts';

export function seriesId(truth: PrTruth): string {
  const key = truth.remote
    ? `${truth.remote.owner}/${truth.remote.name}`.toLowerCase()
    : truth.toplevel;
  return 'ser_' + createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export const biblePath = (series: string) => `bible/${series}/series.json`;

export function repoWeb(truth: PrTruth): string | undefined {
  if (process.env.TRACETOON_REPO_WEB) return process.env.TRACETOON_REPO_WEB;
  return truth.remote
    ? `https://github.com/${truth.remote.owner}/${truth.remote.name}`
    : undefined;
}

export interface LoadedBible {
  bible: SeriesBible;
  /** True when no bible existed yet; publishing will save it to the assets branch. */
  isNew: boolean;
}

export function loadBible(
  truth: PrTruth,
  theme: Theme,
  agents: string[],
  opts: { offline?: boolean } = {},
): LoadedBible {
  const series = seriesId(truth);
  if (!opts.offline) fetchAssets(truth.toplevel);
  const text = readAssetText(truth.toplevel, biblePath(series));
  if (text) {
    try {
      const bible = JSON.parse(text) as SeriesBible;
      const before = bible.cast.length;
      addAgents(bible, agents);
      return { bible, isNew: bible.cast.length !== before };
    } catch {
      /* unreadable bible: start a fresh one */
    }
  }
  return { bible: defaultBible(series, theme, agents), isNew: true };
}

export interface EpisodeRef {
  number: number;
  title: string;
  head: string;
  base: string;
  meta: PrMeta;
}

/** Earlier PRs in this repo that carry Tracetoon metadata. */
export function previousEpisodes(
  truth: PrTruth,
  opts: { offline?: boolean } = {},
): EpisodeRef[] {
  if (opts.offline) return [];
  const r = gh(truth.toplevel, [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    '100',
    '--search',
    '"tracetoon:meta" in:body',
    '--json',
    'number,title,body,headRefName,baseRefName',
  ]);
  if (!r.ok) return [];
  try {
    const rows = JSON.parse(r.stdout) as {
      number: number;
      title: string;
      body: string;
      headRefName: string;
      baseRefName: string;
    }[];
    return rows
      .map((p) => ({
        number: p.number,
        title: p.title,
        head: p.headRefName,
        base: p.baseRefName,
        meta: decodeMeta(p.body),
      }))
      .filter((p): p is EpisodeRef => !!p.meta);
  } catch {
    return [];
  }
}

export interface Story {
  series: string;
  episode: number;
  saga?: { id: string; prs: { number: number; title: string; synopsis?: string }[] };
  /** "Previously on…": synopses of the episodes this one follows. */
  previously: string[];
}

export interface StoryInput {
  truth: PrTruth;
  series: string;
  episodes: EpisodeRef[];
  /** Session refs included in this PR's digest. */
  sessionRefs: string[];
  /** Other PR numbers the agent sessions linked themselves to. */
  linkedPrs: number[];
}

export function buildStory({
  truth,
  series,
  episodes,
  sessionRefs,
  linkedPrs,
}: StoryInput): Story {
  const mine = episodes.filter((e) => e.meta.series === series);
  const current = truth.pr ? mine.find((e) => e.number === truth.pr!.number) : undefined;
  const others = mine.filter((e) => e !== current);
  const episode =
    current?.meta.episode ?? Math.max(0, ...others.map((e) => e.meta.episode ?? 0)) + 1;

  // Related PRs: stacked branches, or a session that linked itself to the other PR.
  // Sharing a long agent session is not enough: one session often produces
  // several unrelated PRs.
  void sessionRefs;
  const related = others.filter(
    (e) => e.head === truth.base || e.base === truth.head || linkedPrs.includes(e.number),
  );
  let saga: Story['saga'];
  if (related.length) {
    const id =
      related.find((e) => e.meta.saga)?.meta.saga ??
      'sg_' +
        createHash('sha256')
          .update(
            related
              .map((e) => e.number)
              .sort()
              .join(','),
          )
          .digest('hex')
          .slice(0, 8);
    const prs = [
      ...related,
      ...others.filter((e) => e.meta.saga === id && !related.includes(e)),
    ]
      .sort((a, b) => (a.meta.episode ?? 0) - (b.meta.episode ?? 0))
      .map((e) => ({ number: e.number, title: e.title, synopsis: e.meta.synopsis }));
    saga = { id, prs };
  }
  const prior = saga
    ? saga.prs.filter((p) => p.synopsis).map((p) => `#${p.number}: ${p.synopsis}`)
    : others
        .sort((a, b) => (b.meta.episode ?? 0) - (a.meta.episode ?? 0))
        .slice(0, 2)
        .reverse()
        .filter((e) => e.meta.synopsis)
        .map((e) => `#${e.number}: ${e.meta.synopsis}`);
  return { series, episode, saga, previously: prior.slice(-4) };
}
