/**
 * `tracetoon comic check | art | render`: turn the agent's comic.json into a
 * finished comic page. Art can come from the host agent (files it saved to
 * art/), an image model the user agreed to, or the built-in SVG artist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composePage, type Layout, type PanelImage } from '../comic/compose.ts';
import {
  artPrompt,
  generateImage,
  providerAvailable,
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
  if (want === 'builtin') return { id: 'builtin' };
  if (want === 'gemini' || want === 'openai') return { id: want };
  for (const id of ['gemini', 'openai'] as ProviderId[]) {
    if (providerAvailable(id) && consented.includes(id)) return { id };
  }
  const keyed = (['gemini', 'openai'] as ProviderId[]).find(providerAvailable);
  return {
    id: 'builtin',
    hint: keyed
      ? `${keyed} is configured but not approved. After the user agrees to send comic prompts to ${keyed}, run: tracetoon comic art --provider ${keyed} --consent --force`
      : undefined,
  };
}

export async function comicArtCmd(cwd: string, opts: ArtOpts): Promise<void> {
  const { run, root, script, bible } = load(cwd, opts.run);
  let config = loadConfig(root);
  const choice = chooseProvider(opts.provider, config.imageConsent);
  if (choice.id !== 'builtin') {
    if (!providerAvailable(choice.id)) {
      throw new UserError(
        `No API key for ${choice.id} (set ${choice.id === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'}).`,
      );
    }
    if (!config.imageConsent.includes(choice.id)) {
      if (!opts.consent) {
        throw new UserError(
          `Sending comic prompts to ${choice.id} needs the user's OK once. Prompts contain only the comic's scenes and character descriptions, never code or log text. Ask the user, then re-run with --consent.`,
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
  const refs: Reference[] = [];
  for (const [castId, path] of Object.entries(bible.references ?? {})) {
    if (!script.panels.some((p) => p.characters.some((c) => c.cast === castId))) continue;
    const data = readAsset(root, path);
    if (data) refs.push({ mime: 'image/png', data });
  }
  const results: { panel: number; file: string; source: string }[] = [];
  for (const [i, panel] of script.panels.entries()) {
    const have = existingPanel(run, i);
    if (have && !opts.force) {
      results.push({ panel: i + 1, file: have.path, source: 'existing' });
      if (choice.id !== 'builtin' && i === 0 && have.mime !== 'image/svg+xml')
        refs.push({ mime: have.mime, data: readFileSync(have.path) });
      continue;
    }
    if (choice.id === 'builtin') {
      const file = join(run.dir, 'art', `panel-${i + 1}.svg`);
      writeFileSync(file, panelSvg(panel, bible, i), 'utf8');
      results.push({ panel: i + 1, file, source: 'builtin' });
      continue;
    }
    const png = await generateImage(
      choice.id,
      artPrompt(panel, bible, i),
      refs.slice(0, 4),
    );
    const file = join(run.dir, 'art', `panel-${i + 1}.png`);
    writeFileSync(file, png);
    if (i === 0) refs.push({ mime: 'image/png', data: png }); // panel 1 anchors the look of 2–4
    results.push({ panel: i + 1, file, source: choice.id });
  }
  writeJson(run, 'art/manifest.json', { panels: results });
  emit(opts, { provider: choice.id, panels: results, hint: choice.hint }, () =>
    [
      ...results.map((r) => `panel ${r.panel}: ${r.source} -> ${r.file}`),
      choice.hint ? `Note: ${choice.hint}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** Prompts for the host agent's own image tool (Codex image_gen, Antigravity). */
export function comicPromptsCmd(cwd: string, opts: OutOpts & { run?: string }): void {
  const { run, script, bible } = load(cwd, opts.run);
  const prompts = script.panels.map((p, i) => ({
    panel: i + 1,
    saveTo: join(run.dir, 'art', `panel-${i + 1}.png`),
    prompt: artPrompt(p, bible, i),
  }));
  emit(opts, { prompts }, () =>
    prompts.map((p) => `Panel ${p.panel} -> ${p.saveTo}\n${p.prompt}`).join('\n\n'),
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
