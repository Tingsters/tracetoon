/**
 * `tracetoon comic check | art | render`: turn the agent's comic.json into a
 * finished comic page. Art can come from the host agent (files it saved to
 * art/), an image model the user agreed to, or the built-in SVG artist.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composePage, type Layout, type PanelImage } from '../comic/compose.ts';
import {
  artPrompt,
  castPrompt,
  generateImages,
  imageMime,
  PROVIDERS,
  providerAvailable,
  providerInfo,
  type ProviderId,
  type Reference,
} from '../comic/providers.ts';
import { svgToPng } from '../comic/raster.ts';
import { checkScript } from '../comic/script.ts';
import { panelSvg } from '../comic/svgArt.ts';
import type { ComicScript, SeriesBible } from '../comic/types.ts';
import { loadConfig, setUserConfig } from '../config.ts';
import { readAsset } from '../github/assets.ts';
import { prTruth } from '../git/pr.ts';
import { findRun, readJson, writeJson, type Run } from '../run.ts';
import type { Story } from '../story/story.ts';
import { emit, UserError, type OutOpts } from './output.ts';

const EXT_MIME: Record<string, PanelImage['mime']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

interface Loaded {
  run: Run;
  root: string;
  script: ComicScript;
  bible: SeriesBible;
}

function load(cwd: string, runId?: string): Loaded {
  const truth = prTruth(cwd, { noGh: true });
  const run = findRun(truth.gitDir, runId);
  const bible = readJson<SeriesBible>(run, 'bible.json');
  if (!bible)
    throw new UserError('No bible.json in this run. Run `tracetoon context` first.');
  const script = readJson<ComicScript>(run, 'comic.json');
  if (!script)
    throw new UserError(
      `Write the comic script to ${join(run.dir, 'comic.json')} first.`,
    );
  const problems = checkScript(script, bible);
  if (problems.length) {
    throw new UserError(
      `comic.json has problems:\n${problems.map((p) => `  ${p.where}: ${p.problem}`).join('\n')}`,
    );
  }
  return { run, root: truth.toplevel, script, bible };
}

export function comicCheckCmd(cwd: string, opts: OutOpts & { run?: string }): void {
  const truth = prTruth(cwd, { noGh: true });
  const run = findRun(truth.gitDir, opts.run);
  const bible = readJson<SeriesBible>(run, 'bible.json');
  const script = readJson<unknown>(run, 'comic.json');
  if (!bible || script === undefined)
    throw new UserError(
      'Need bible.json (from `tracetoon context`) and comic.json in the run.',
    );
  const problems = checkScript(script, bible);
  emit(opts, { ok: problems.length === 0, problems }, () =>
    problems.length
      ? problems.map((p) => `${p.where}: ${p.problem}`).join('\n')
      : 'comic.json looks good.',
  );
  if (problems.length) process.exitCode = 1;
}

/** An existing panel image in art/, made by the host agent or an earlier run. */
function existingPanel(
  run: Run,
  i: number,
): { path: string; mime: PanelImage['mime'] } | undefined {
  for (const [ext, mime] of Object.entries(EXT_MIME)) {
    const p = join(run.dir, 'art', `panel-${i + 1}.${ext}`);
    if (existsSync(p)) return { path: p, mime };
  }
  return undefined;
}

export interface ArtOpts extends OutOpts {
  run?: string;
  provider?: 'auto' | 'builtin' | ProviderId;
  consent?: boolean;
  force?: boolean;
}

function chooseProvider(
  want: ArtOpts['provider'],
  consented: string[],
): { id: 'builtin' | ProviderId; hint?: string } {
  if (want && want !== 'auto' && want !== 'builtin' && !PROVIDERS.includes(want))
    throw new UserError(
      `Unknown provider "${want}". Use auto, builtin, ${PROVIDERS.join(', ')}.`,
    );
  if (want === 'builtin') return { id: 'builtin' };
  if (want && want !== 'auto') return { id: want };
  for (const id of PROVIDERS) {
    if (providerAvailable(id) && consented.includes(id)) return { id };
  }
  const ready = PROVIDERS.filter(providerAvailable).map(providerInfo);
  return {
    id: 'builtin',
    hint: ready.length
      ? `AI art is available but not approved yet: ${ready
          .map(
            (p) =>
              `${p.id} (sends comic scenes and character descriptions to ${p.sendsTo})`,
          )
          .join(
            '; ',
          )}. After the user agrees, run: tracetoon comic art --provider ${ready[0]!.id} --consent --force`
      : undefined,
  };
}

/** The cast's reference portraits: this run's, or the series' from the assets branch. */
function castRefs(
  run: Run,
  root: string,
  bible: SeriesBible,
  ids: string[],
): Map<string, Reference> {
  const refs = new Map<string, Reference>();
  for (const id of ids) {
    const name = bible.cast.find((c) => c.id === id)?.name ?? id;
    const local = join(run.dir, 'art', `cast-${id}.png`);
    const series = bible.references?.[id];
    const data = existsSync(local)
      ? new Uint8Array(readFileSync(local))
      : series
        ? readAsset(root, series)
        : undefined;
    if (data)
      refs.set(id, {
        mime: imageMime(data),
        data,
        label: `${name} (character reference)`,
      });
  }
  return refs;
}

export async function comicArtCmd(cwd: string, opts: ArtOpts): Promise<void> {
  const { run, root, script, bible } = load(cwd, opts.run);
  let config = loadConfig(root);
  const choice = chooseProvider(opts.provider, config.imageConsent);
  if (choice.id !== 'builtin') {
    const info = providerInfo(choice.id);
    if (!info.available)
      throw new UserError(`${info.label} is not available: ${info.detail}.`);
    if (!config.imageConsent.includes(choice.id)) {
      if (!opts.consent) {
        throw new UserError(
          `Making the comic art with ${info.label} sends the comic's scenes and character descriptions (never code or log text) to ${info.sendsTo}. Ask the user once, then re-run with --consent.`,
          4,
        );
      }
      config = setUserConfig(
        'imageConsent',
        [...config.imageConsent, choice.id].join(','),
      );
    }
  }
  mkdirSync(join(run.dir, 'art'), { recursive: true });

  const todo = script.panels
    .map((panel, i) => ({ panel, i, have: existingPanel(run, i) }))
    .filter((p) => opts.force || !p.have);
  const results: { panel: number; file: string; source: string }[] = script.panels
    .map((_, i) => ({ i, have: existingPanel(run, i) }))
    .filter((p) => p.have && !opts.force)
    .map((p) => ({ panel: p.i + 1, file: p.have!.path, source: 'existing' }));
  let warning: string | undefined;
  let castMade: string[] = [];

  if (choice.id !== 'builtin' && todo.length) {
    try {
      castMade = await makeCast(run, root, script, bible, choice.id);
      await makePanels(run, root, script, bible, choice.id, todo, results);
    } catch (e) {
      warning = `${providerInfo(choice.id).label} failed (${(e as Error).message}). Used the built-in artist instead.`;
      for (const t of todo)
        if (!results.some((r) => r.panel === t.i + 1)) drawBuiltin(t.i);
    }
  } else {
    for (const t of todo) drawBuiltin(t.i);
  }

  function drawBuiltin(i: number): void {
    // An AI panel from an earlier run would otherwise win over this one.
    for (const ext of ['png', 'jpg', 'webp'])
      rmSync(join(run.dir, 'art', `panel-${i + 1}.${ext}`), { force: true });
    const file = join(run.dir, 'art', `panel-${i + 1}.svg`);
    writeFileSync(file, panelSvg(script.panels[i]!, bible, i), 'utf8');
    results.push({ panel: i + 1, file, source: 'builtin' });
  }

  results.sort((a, b) => a.panel - b.panel);
  writeJson(run, 'art/manifest.json', { provider: choice.id, panels: results, castMade });
  emit(
    opts,
    { provider: choice.id, panels: results, castMade, hint: choice.hint, warning },
    () =>
      [
        ...castMade.map(
          (id) => `character sheet: ${id} -> ${join(run.dir, 'art', `cast-${id}.png`)}`,
        ),
        ...results.map((r) => `panel ${r.panel}: ${r.source} -> ${r.file}`),
        warning ? `Warning: ${warning}` : '',
        choice.hint ? `Note: ${choice.hint}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  );
}

/** Draw reference portraits for cast members in this comic who don't have one yet. */
async function makeCast(
  run: Run,
  root: string,
  script: ComicScript,
  bible: SeriesBible,
  id: ProviderId,
): Promise<string[]> {
  const ids = [...new Set(script.panels.flatMap((p) => p.characters.map((c) => c.cast)))];
  const have = castRefs(run, root, bible, ids);
  const missing = ids.filter((c) => !have.has(c));
  if (!missing.length) return [];
  const images = await generateImages(
    id,
    missing.map((c) => ({
      prompt: castPrompt(
        bible.cast.find((m) => m.id === c)!,
        bible,
      ),
      refs: [],
    })),
  );
  missing.forEach((c, k) =>
    writeFileSync(join(run.dir, 'art', `cast-${c}.png`), images[k]!),
  );
  return missing;
}

async function makePanels(
  run: Run,
  root: string,
  script: ComicScript,
  bible: SeriesBible,
  id: ProviderId,
  todo: { panel: ComicScript['panels'][number]; i: number }[],
  results: { panel: number; file: string; source: string }[],
): Promise<void> {
  const ids = [...new Set(script.panels.flatMap((p) => p.characters.map((c) => c.cast)))];
  const cast = castRefs(run, root, bible, ids);
  const save = (i: number, data: Uint8Array) => {
    const ext =
      imageMime(data) === 'image/jpeg'
        ? 'jpg'
        : imageMime(data) === 'image/webp'
          ? 'webp'
          : 'png';
    rmSync(join(run.dir, 'art', `panel-${i + 1}.svg`), { force: true });
    const file = join(run.dir, 'art', `panel-${i + 1}.${ext}`);
    writeFileSync(file, data);
    results.push({ panel: i + 1, file, source: id });
  };
  if (id === 'codex' || id === 'antigravity') {
    // One agent session draws every panel, with all the character sheets attached.
    const refs = [...cast.values()];
    const images = await generateImages(
      id,
      todo.map((t) => ({ prompt: artPrompt(t.panel, bible, t.i), refs })),
    );
    todo.forEach((t, k) => save(t.i, images[k]!));
    return;
  }
  // APIs: one call per panel, with that panel's characters; the first panel
  // drawn then anchors the look of the rest.
  let anchor: Reference | undefined;
  for (const t of todo) {
    const refs = t.panel.characters
      .map((c) => cast.get(c.cast))
      .filter((r): r is Reference => !!r);
    if (anchor) refs.push(anchor);
    const [img] = await generateImages(id, [
      { prompt: artPrompt(t.panel, bible, t.i), refs },
    ]);
    save(t.i, img!);
    anchor ??= {
      mime: imageMime(img!),
      data: img!,
      label: 'the first panel of this comic (match its style)',
    };
  }
}

/** Prompts for the host agent's own image tool (Codex image_gen, Antigravity). */
export function comicPromptsCmd(cwd: string, opts: OutOpts & { run?: string }): void {
  const { run, root, script, bible } = load(cwd, opts.run);
  const ids = [...new Set(script.panels.flatMap((p) => p.characters.map((c) => c.cast)))];
  const have = castRefs(run, root, bible, ids);
  const cast = ids
    .filter((c) => !have.has(c))
    .map((c) => ({
      cast: c,
      saveTo: join(run.dir, 'art', `cast-${c}.png`),
      prompt: castPrompt(
        bible.cast.find((m) => m.id === c)!,
        bible,
      ),
    }));
  const references = [...have.keys()].map((c) => {
    const local = join(run.dir, 'art', `cast-${c}.png`);
    if (!existsSync(local)) writeFileSync(local, have.get(c)!.data);
    return { cast: c, path: local };
  });
  const prompts = script.panels.map((p, i) => ({
    panel: i + 1,
    saveTo: join(run.dir, 'art', `panel-${i + 1}.png`),
    prompt: artPrompt(p, bible, i),
  }));
  emit(opts, { cast, references, prompts }, () =>
    [
      ...(cast.length
        ? [
            'Character sheets first (then use them as references for the panels):',
            ...cast.map((c) => `${c.cast} -> ${c.saveTo}\n${c.prompt}`),
            '',
          ]
        : []),
      ...(references.length
        ? [`Character references: ${references.map((r) => r.path).join(', ')}`, '']
        : []),
      ...prompts.map((p) => `Panel ${p.panel} -> ${p.saveTo}\n${p.prompt}`),
    ].join('\n\n'),
  );
}

export async function comicRenderCmd(
  cwd: string,
  opts: OutOpts & { run?: string },
): Promise<void> {
  const { run, script, bible } = load(cwd, opts.run);
  const story = readJson<{ story?: Story }>(run, 'context.json')?.story;
  const images: PanelImage[] = script.panels.map((panel, i) => {
    const have = existingPanel(run, i);
    if (have) return { mime: have.mime, data: readFileSync(have.path) };
    return {
      mime: 'image/svg+xml',
      data: new TextEncoder().encode(panelSvg(panel, bible, i)),
    };
  });
  const layout = readJson<Layout>(run, 'layout.json');
  const svg = composePage(script, bible, images, { episode: story?.episode }, layout);
  mkdirSync(join(run.dir, 'out'), { recursive: true });
  const svgPath = join(run.dir, 'out', 'comic.svg');
  writeFileSync(svgPath, svg, 'utf8');
  let pngPath: string | undefined;
  let warning: string | undefined;
  try {
    let png = await svgToPng(svg, 1600);
    if (png.length > 9_500_000) png = await svgToPng(svg, 1200); // GitHub's 10 MB limit
    pngPath = join(run.dir, 'out', 'comic.png');
    writeFileSync(pngPath, png);
  } catch (e) {
    warning = `Could not make a PNG (${(e as Error).message}); the SVG will be used.`;
  }
  emit(opts, { svg: svgPath, png: pngPath ?? null, warning }, () =>
    [`Comic: ${pngPath ?? svgPath}`, warning].filter(Boolean).join('\n'),
  );
}

/** The comic file to publish, if one was rendered. */
export function renderedComic(
  run: Run,
): { path: string; mime: string; data: Buffer } | undefined {
  for (const [name, mime] of [
    ['comic.png', 'image/png'],
    ['comic.svg', 'image/svg+xml'],
  ] as const) {
    const p = join(run.dir, 'out', name);
    if (existsSync(p)) return { path: p, mime, data: readFileSync(p) };
  }
  return undefined;
}
