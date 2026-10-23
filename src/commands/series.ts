/** `tracetoon series`: the repo's comic series as it stands on GitHub. */
import { loadConfig } from '../config.ts';
import { prTruth } from '../git/pr.ts';
import { loadBible, previousEpisodes } from '../story/story.ts';
import { emit, type OutOpts } from './output.ts';

export function seriesShowCmd(cwd: string, opts: OutOpts & { offline?: boolean }): void {
  const truth = prTruth(cwd, { noGh: true });
  const config = loadConfig(truth.toplevel);
  const { bible, isNew } = loadBible(truth, config.theme, [], { offline: opts.offline });
  const episodes = previousEpisodes(truth, { offline: opts.offline })
    .filter((e) => e.meta.series === bible.series)
    .sort((a, b) => (a.meta.episode ?? 0) - (b.meta.episode ?? 0));
  emit(
    opts,
    {
      bible,
      saved: !isNew,
      episodes: episodes.map((e) => ({
        number: e.number,
        title: e.title,
        episode: e.meta.episode,
        saga: e.meta.saga,
        synopsis: e.meta.synopsis,
      })),
    },
    () =>
      [
        `${bible.title} (${bible.theme}) - series ${bible.series}${isNew ? ' (not saved yet; created on the first published comic)' : ''}`,
        'Cast:',
        ...bible.cast.map(
          (c) =>
            `  ${c.id.padEnd(16)} ${c.name}${c.agent ? ` - ${c.agent}` : ''}: ${c.description}`,
        ),
        episodes.length ? 'Episodes:' : 'No episodes published yet.',
        ...episodes.map(
          (e) =>
            `  Ep. ${e.meta.episode} #${e.number} ${e.title}${e.meta.synopsis ? ` - ${e.meta.synopsis}` : ''}`,
        ),
      ].join('\n'),
  );
}
