/**
 * `tracetoon comic check | art | render`: turn the agent's comic.json into a
 * finished comic page. Art comes from an image model the user agreed to, or
 * from the host agent's own image tool (files it saved to art/). With neither,
 * there is no comic. Each comic stands alone: its characters and style are
 * its own.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contributionPolicy,
  loadGuidance,
  researchPacket,
} from '../contribution/guidance.ts';
import { detectAiPolicy, type AiPolicy } from '../github/repoContext.ts';
import {
  composePage,
  pageWithFooter,
  type Layout,
  type PanelImage,
} from '../comic/compose.ts';
import { FORMATS, formatById } from '../comic/formats.ts';
import { freshStyles, styleById } from '../comic/styles.ts';
import {
  artPrompt,
  generateImages,
  imageMime,
  pagePrompt,
  PROVIDERS,
  providerAvailable,
  providerInfo,
  type ProviderId,
  type Reference,
} from '../comic/providers.ts';
import { svgToPng } from '../comic/raster.ts';
import { routeStatuses, setupAdvice, usable } from '../comic/routes.ts';
import {
  checkScript,
  errors,
  pageText,
  type CheckOpts,
  type ScriptProblem,
} from '../comic/script.ts';
import { PALETTES, type ComicScript, type Palette } from '../comic/types.ts';
import { loadConfig, setUserConfig } from '../config.ts';
import { prTruth } from '../git/pr.ts';
import { findRun, readJson, writeJson, type Run } from '../run.ts';
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
}

/** What the script check needs beyond the script: pinned style, recent styles. */
function checkOptsFor(run: Run, root: string): CheckOpts {
  const config = loadConfig(root);
  const ctx = readJson<{ comic?: { recentStyles?: string[] } }>(run, 'context.json');
  return {
    pinnedStyle: config.style && config.style !== 'auto' ? config.style : undefined,
    recentStyles: ctx?.comic?.recentStyles ?? [],
  };
}

function describe(problems: ScriptProblem[]): string {
  return problems
    .map(
      (p) => `  ${p.severity === 'warning' ? 'warning: ' : ''}${p.where}: ${p.problem}`,
    )
    .join('\n');
}

function load(cwd: string, runId?: string): Loaded {
  let truth = prTruth(cwd, { noGh: true });
  const run = findRun(truth.gitDir, runId);
  const context = readJson<{
    base?: string;
    aiPolicy?: AiPolicy;
    contribution?: { offline: boolean };
  }>(run, 'context.json');
  if (context?.base && context.base !== truth.base)
    truth = prTruth(cwd, { noGh: true, base: context.base });
  const { request } = researchPacket(truth, context?.contribution?.offline ?? false);
  const guidance = loadGuidance(run, truth.toplevel, request);
  const policy = contributionPolicy(
    context?.aiPolicy ?? detectAiPolicy(truth.toplevel),
    guidance,
  ).policy;
  if (policy.media === 'prohibited')
    throw new UserError(
      'Repository guidance prohibits AI-generated media. Skip the comic for this PR.',
    );
  const script = readJson<ComicScript>(run, 'comic.json');
  if (!script)
    throw new UserError(
      `Write the comic script to ${join(run.dir, 'comic.json')} first.`,
    );
  const problems = errors(checkScript(script, checkOptsFor(run, truth.toplevel)));
  if (problems.length)
    throw new UserError(`comic.json has problems:\n${describe(problems)}`);
  return { run, root: truth.toplevel, script };
}

export function comicCheckCmd(cwd: string, opts: OutOpts & { run?: string }): void {
  const truth = prTruth(cwd, { noGh: true });
  const run = findRun(truth.gitDir, opts.run);
  const script = readJson<unknown>(run, 'comic.json');
  if (script === undefined)
    throw new UserError(
      `Write the comic script to ${join(run.dir, 'comic.json')} first.`,
    );
  const problems = checkScript(script, checkOptsFor(run, truth.toplevel));
  const blocking = errors(problems);
  emit(opts, { ok: blocking.length === 0, problems }, () =>
    [
      problems.length ? describe(problems).replace(/^ {2}/gm, '') : '',
      blocking.length ? '' : 'comic.json looks good.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  if (blocking.length) process.exitCode = 1;
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
  provider?: 'auto' | ProviderId;
  consent?: boolean;
  force?: boolean;
  /** `model`: the image model letters the page (default); `overlay`: Tracetoon draws bubbles. */
  lettering?: 'model' | 'overlay';
}

/** Exit code when no approved image route can draw the comic. */
export const NO_ARTIST_EXIT = 5;

/** The approved image route to use, if there is one. */
function chooseProvider(
  want: string | undefined,
  consented: string[],
): ProviderId | undefined {
  if (want === 'builtin')
    throw new UserError(
      `The built-in artist was removed. Use ${PROVIDERS.join(', ')}, or skip the comic.`,
    );
  if (want && want !== 'auto' && !PROVIDERS.includes(want as ProviderId))
    throw new UserError(`Unknown provider "${want}". Use auto, ${PROVIDERS.join(', ')}.`);
  if (want && want !== 'auto') return want as ProviderId;
  return PROVIDERS.find((id) => providerAvailable(id) && consented.includes(id));
}

/** Why there's no art, and what the user can do instead. */
function noArtist(root: string): UserError {
  const routes = routeStatuses(root);
  const ready = routes.filter(usable);
  const broken = routes.filter((r) => r.available && !usable(r));
  const options = [
    ...(ready.length
      ? [
          `approve an image route: ${ready
            .map(
              (p) =>
                `${p.id} (sends comic scenes and character descriptions to ${p.sendsTo}; ${p.cost})`,
            )
            .join(
              '; ',
            )}. After the user agrees, run: tracetoon comic art --provider ${ready[0]!.id} --consent`,
        ]
      : []),
    ...broken.map((r) => `fix ${r.id}: ${r.detail}`),
    ...(ready.length || broken.length ? [] : [`set up an image route: ${setupAdvice()}`]),
    'draw it with your own image tool: `tracetoon comic prompts` prints the prompts and where to save the images; then run `tracetoon comic render`',
    'or skip the comic: the PR is published without one',
  ];
  return new UserError(
    `No approved image route to draw the comic. Options:\n${options.map((o) => `  - ${o}`).join('\n')}`,
    NO_ARTIST_EXIT,
  );
}

export async function comicArtCmd(cwd: string, opts: ArtOpts): Promise<void> {
  const { run, root, script } = load(cwd, opts.run);
  let config = loadConfig(root);
  const provider = chooseProvider(opts.provider, config.imageConsent);
  if (provider) {
    const info = providerInfo(provider);
    if (!info.available || info.ready === 'not ready')
      throw new UserError(`${info.label} can't draw: ${info.detail}.`);
    if (!config.imageConsent.includes(provider)) {
      if (!opts.consent) {
        throw new UserError(
          `Making the comic art with ${info.label} sends the comic's scenes, text and character descriptions (never code or log text) to ${info.sendsTo}. Ask the user once, then re-run with --consent.`,
          4,
        );
      }
      config = setUserConfig(
        'imageConsent',
        [...config.imageConsent, provider].join(','),
      );
    }
  }
  mkdirSync(join(run.dir, 'art'), { recursive: true });
  const lettering = opts.lettering ?? 'model';
  const results: { panel: number; file: string; source: string }[] = [];

  // A page drawn whole, lettering included: by an image model, or already saved
  // by the host agent's own image tool. Overlay lettering uses panels instead.
  if (lettering === 'model') {
    const have = existingPage(run);
    if (have && !opts.force) {
      results.push({ panel: 0, file: have.path, source: 'existing' });
    } else if (provider) {
      try {
        results.push(await makePage(run, script, provider));
        clearPanels(run);
      } catch (e) {
        throw new UserError(
          `${providerInfo(provider).label} could not draw the page (${(e as Error).message}). Try again with --force, another --provider, or --lettering overlay; if it keeps failing, skip the comic.`,
        );
      }
    } else {
      throw noArtist(root);
    }
    finish('page', 'model');
    return;
  }

  // Panel mode: text-free panels, bubbles added by `comic render`.
  clearPage(run);
  const todo = script.panels
    .map((panel, i) => ({ panel, i, have: existingPanel(run, i) }))
    .filter((p) => opts.force || !p.have);
  for (const [i] of script.panels.entries()) {
    const have = existingPanel(run, i);
    if (have && !todo.some((t) => t.i === i))
      results.push({ panel: i + 1, file: have.path, source: 'existing' });
  }
  if (todo.length) {
    if (!provider) throw noArtist(root);
    try {
      await makePanels(run, script, provider, todo, results);
    } catch (e) {
      // Panels already drawn are kept; a retry draws only the missing ones.
      const missing = todo.filter((t) => !results.some((r) => r.panel === t.i + 1));
      throw new UserError(
        `${providerInfo(provider).label} could not draw panel${missing.length === 1 ? '' : 's'} ${missing.map((t) => t.i + 1).join(', ')} (${(e as Error).message}). Run \`tracetoon comic art\` again to draw the missing ones, or try another --provider; if it keeps failing, skip the comic.`,
      );
    }
  }
  finish('panels', 'overlay');

  function finish(mode: 'page' | 'panels', lettering: 'model' | 'overlay'): void {
    results.sort((a, b) => a.panel - b.panel);
    const summary = {
      provider: provider ?? 'existing',
      mode,
      lettering,
      panels: results,
    };
    writeJson(run, 'art/manifest.json', summary);
    emit(opts, summary, () =>
      results
        .map((r) =>
          r.panel === 0
            ? `page: ${r.source} -> ${r.file}`
            : `panel ${r.panel}: ${r.source} -> ${r.file}`,
        )
        .join('\n'),
    );
  }
}

/** The whole-page image, if one was drawn (by a provider or the host agent). */
function existingPage(run: Run): { path: string; mime: PanelImage['mime'] } | undefined {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const p = join(run.dir, 'art', `page.${ext}`);
    if (existsSync(p)) return { path: p, mime: EXT_MIME[ext]! };
  }
  return undefined;
}

function clearPage(run: Run): void {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp'])
    rmSync(join(run.dir, 'art', `page.${ext}`), { force: true });
}

function clearPanels(run: Run): void {
  for (let i = 1; i <= 6; i++)
    for (const ext of Object.keys(EXT_MIME))
      rmSync(join(run.dir, 'art', `panel-${i}.${ext}`), { force: true });
}

const extOf = (data: Uint8Array) =>
  imageMime(data) === 'image/jpeg'
    ? 'jpg'
    : imageMime(data) === 'image/webp'
      ? 'webp'
      : 'png';

/** Draw the whole page, lettering included. */
async function makePage(
  run: Run,
  script: ComicScript,
  id: ProviderId,
): Promise<{ panel: number; file: string; source: string }> {
  const aspect = script.aspect ?? formatById(script.format)?.aspect ?? '4:3';
  const [img] = await generateImages(id, [
    { prompt: pagePrompt(script), refs: [], aspect },
  ]);
  clearPage(run);
  const file = join(run.dir, 'art', `page.${extOf(img!)}`);
  writeFileSync(file, img!);
  return { panel: 0, file, source: id };
}

async function makePanels(
  run: Run,
  script: ComicScript,
  id: ProviderId,
  todo: { panel: ComicScript['panels'][number]; i: number }[],
  results: { panel: number; file: string; source: string }[],
): Promise<void> {
  const save = (i: number, data: Uint8Array) => {
    const file = join(run.dir, 'art', `panel-${i + 1}.${extOf(data)}`);
    writeFileSync(file, data);
    results.push({ panel: i + 1, file, source: id });
  };
  if (id === 'codex' || id === 'antigravity') {
    // One agent session draws every panel, so they match each other.
    const images = await generateImages(
      id,
      todo.map((t) => ({ prompt: artPrompt(t.panel, t.i, script), refs: [] })),
    );
    todo.forEach((t, k) => save(t.i, images[k]!));
    return;
  }
  // APIs: one call per panel; the first panel drawn anchors the look of the rest.
  let anchor: Reference | undefined;
  for (const t of todo) {
    const [img] = await generateImages(id, [
      { prompt: artPrompt(t.panel, t.i, script), refs: anchor ? [anchor] : [] },
    ]);
    save(t.i, img!);
    anchor ??= {
      mime: imageMime(img!),
      data: img!,
      label: 'the first panel of this comic (match its characters and style)',
    };
  }
}

/** Prompts for the host agent's own image tool (Codex image_gen, Antigravity). */
export function comicPromptsCmd(
  cwd: string,
  opts: OutOpts & { run?: string; lettering?: 'model' | 'overlay' },
): void {
  const { run, script } = load(cwd, opts.run);
  const prompts =
    (opts.lettering ?? 'model') === 'model'
      ? [
          {
            panel: 0,
            saveTo: join(run.dir, 'art', 'page.png'),
            prompt: pagePrompt(script),
          },
        ]
      : script.panels.map((p, i) => ({
          panel: i + 1,
          saveTo: join(run.dir, 'art', `panel-${i + 1}.png`),
          prompt: artPrompt(p, i, script),
        }));
  emit(opts, { prompts, text: pageText(script) }, () =>
    prompts
      .map((p) =>
        p.panel === 0
          ? `Whole page -> ${p.saveTo}\n${p.prompt}`
          : `Panel ${p.panel} -> ${p.saveTo}\n${p.prompt}`,
      )
      .join('\n\n'),
  );
}

export async function comicRenderCmd(
  cwd: string,
  opts: OutOpts & { run?: string },
): Promise<void> {
  const { run, root, script } = load(cwd, opts.run);
  const manifest = readJson<{ mode?: string }>(run, 'art/manifest.json');
  const page = manifest?.mode !== 'panels' ? existingPage(run) : undefined;
  let svg: string;
  if (page) {
    svg = pageWithFooter({ mime: page.mime, data: readFileSync(page.path) });
  } else {
    const found = script.panels.map((_, i) => existingPanel(run, i));
    const missing = found.flatMap((f, i) => (f ? [] : [i + 1]));
    if (missing.length) {
      const what =
        missing.length === found.length
          ? 'this comic'
          : `panel${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`;
      throw new UserError(
        `No art for ${what}. Run \`tracetoon comic art\`, or save the images that \`tracetoon comic prompts\` lists, or skip the comic.`,
      );
    }
    const images: PanelImage[] = found.map((f) => ({
      mime: f!.mime,
      data: readFileSync(f!.path),
    }));
    const layout = readJson<Layout>(run, 'layout.json');
    svg = composePage(script, images, layout);
  }
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
  // The image model lettered the page: the agent checks every word against this list.
  const proofread = page ? pageText(script) : undefined;
  emit(
    opts,
    {
      svg: svgPath,
      png: pngPath ?? null,
      mode: page ? 'page' : 'panels',
      proofread,
      warning,
    },
    () =>
      [
        `Comic: ${pngPath ?? svgPath}`,
        proofread
          ? `Proofread: look at the image and check each of these is lettered exactly (if not, run \`tracetoon comic art --force\`; after two tries, \`--lettering overlay\`):\n${proofread.map((t) => `  - ${t}`).join('\n')}`
          : '',
        warning,
      ]
        .filter(Boolean)
        .join('\n'),
  );
}

export interface RerollOpts extends OutOpts {
  run?: string;
  style?: string;
  format?: string;
  palette?: string;
}

/**
 * Keep the story, change the look: a style idea not used lately (or the style
 * given, in any words), then redraw with the approved provider.
 */
export async function comicRerollCmd(cwd: string, opts: RerollOpts): Promise<void> {
  const { run, root, script } = load(cwd, opts.run);
  const check = checkOptsFor(run, root);
  if (check.pinnedStyle && opts.style && opts.style !== check.pinnedStyle)
    throw new UserError(
      `This repo pins the style "${check.pinnedStyle}" (config style).`,
    );
  let style = opts.style?.trim();
  if (!style) {
    if (check.pinnedStyle)
      throw new UserError(
        `This repo pins the style "${check.pinnedStyle}"; there is nothing to reroll to.`,
      );
    // Some randomness among the freshest few, so rerolls don't always land on the same one.
    const pool = freshStyles(check.recentStyles, script.style).slice(0, 4);
    style = pool[Math.floor(Math.random() * pool.length)]!.id;
  }
  const next: ComicScript = { ...script, style };
  if (opts.format) {
    if (!formatById(opts.format))
      throw new UserError(
        `Unknown format "${opts.format}". Use one of: ${FORMATS.map((f) => f.id).join(', ')}`,
      );
    next.format = opts.format;
    if (opts.format !== 'custom') delete next.aspect;
  }
  const idea = styleById(style);
  if (opts.palette) {
    if (!PALETTES.includes(opts.palette as Palette))
      throw new UserError(
        `Unknown palette "${opts.palette}". Use one of: ${PALETTES.join(', ')}`,
      );
    next.palette = opts.palette as Palette;
  } else if (idea && (!next.palette || !idea.palettes.includes(next.palette))) {
    next.palette = idea.palettes[0];
  } else if (!idea) {
    delete next.palette;
  }
  const problems = errors(checkScript(next, { ...check, recentStyles: [] }));
  if (problems.length)
    throw new UserError(`The rerolled comic has problems:\n${describe(problems)}`);
  writeJson(run, 'comic.json', next);
  const manifest = readJson<{ lettering?: 'model' | 'overlay' }>(
    run,
    'art/manifest.json',
  );
  await comicArtCmd(cwd, {
    ...opts,
    run: run.id,
    force: true,
    lettering: manifest?.lettering,
  });
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
