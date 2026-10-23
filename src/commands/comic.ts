/**
 * `tracetoon comic check | art | render`: turn the agent's comic.json into a
 * finished comic page. Art can come from the host agent (files it saved to
 * art/), an image model the user agreed to, or the built-in SVG artist.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composePage,
  pageWithFooter,
  type Layout,
  type PanelImage,
} from '../comic/compose.ts';
import { FORMATS, formatById } from '../comic/formats.ts';
import { fittingStyles, STYLES, styleById, styleClash } from '../comic/styles.ts';
import {
  artPrompt,
  castPrompt,
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
import {
  checkScript,
  errors,
  isPage,
  pageText,
  type CheckOpts,
  type ScriptProblem,
} from '../comic/script.ts';
import { panelSvg } from '../comic/svgArt.ts';
import {
  PALETTES,
  type ComicScript,
  type Palette,
  type SeriesBible,
} from '../comic/types.ts';
import { loadConfig, setUserConfig } from '../config.ts';
import { readAsset } from '../github/assets.ts';
import { prTruth } from '../git/pr.ts';
import { findRun, readJson, writeJson, type Run } from '../run.ts';
import { repoWeb, type Story } from '../story/story.ts';
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

/** What the script check needs beyond the script: pinned style, recent styles. */
function checkOptsFor(run: Run, root: string): CheckOpts {
  const config = loadConfig(root);
  const story = readJson<{ story?: Story }>(run, 'context.json')?.story;
  return {
    pinnedStyle: config.style && config.style !== 'auto' ? config.style : undefined,
    allowAnimalAnime: config.allowAnimalAnime,
    recentStyles: story?.recentStyles ?? [],
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
  const problems = errors(checkScript(script, bible, checkOptsFor(run, truth.toplevel)));
  if (problems.length)
    throw new UserError(`comic.json has problems:\n${describe(problems)}`);
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
  const problems = checkScript(script, bible, checkOptsFor(run, truth.toplevel));
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
  provider?: 'auto' | 'builtin' | ProviderId;
  consent?: boolean;
  force?: boolean;
  /** `model`: the image model letters the page (default for pages); `overlay`: Tracetoon draws bubbles. */
  lettering?: 'model' | 'overlay';
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
          `Making the comic art with ${info.label} sends the comic's scenes, text and character descriptions (never code or log text) to ${info.sendsTo}. Ask the user once, then re-run with --consent.`,
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

  // A page drawn whole by an image model, lettering included, unless the agent
  // asked for overlay lettering (or there's no model).
  const wantPage =
    isPage(script) && choice.id !== 'builtin' && (opts.lettering ?? 'model') === 'model';
  let warning: string | undefined;
  let castMade: string[] = [];
  const results: { panel: number; file: string; source: string }[] = [];

  if (wantPage) {
    const have = existingPage(run);
    if (have && !opts.force) {
      results.push({ panel: 0, file: have.path, source: 'existing' });
    } else {
      try {
        castMade = await makeCast(run, root, script, bible, choice.id as ProviderId);
        results.push(await makePage(run, root, script, bible, choice.id as ProviderId));
        clearPanels(run);
      } catch (e) {
        warning = `${providerInfo(choice.id as ProviderId).label} failed (${(e as Error).message}). Used the built-in artist with overlay lettering instead.`;
      }
    }
    if (results.length) {
      finish('page', 'model');
      return;
    }
  }

  // Panel mode: text-free panels, bubbles added by `comic render`.
  clearPage(run);
  const todo = script.panels
    .map((panel, i) => ({ panel, i, have: existingPanel(run, i) }))
    .filter((p) => opts.force || !p.have || warning);
  for (const [i] of script.panels.entries()) {
    const have = existingPanel(run, i);
    if (have && !todo.some((t) => t.i === i))
      results.push({ panel: i + 1, file: have.path, source: 'existing' });
  }
  if (choice.id !== 'builtin' && todo.length && !warning) {
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
  finish('panels', 'overlay');

  function drawBuiltin(i: number): void {
    // An AI panel from an earlier run would otherwise win over this one.
    for (const ext of ['png', 'jpg', 'webp'])
      rmSync(join(run.dir, 'art', `panel-${i + 1}.${ext}`), { force: true });
    const file = join(run.dir, 'art', `panel-${i + 1}.svg`);
    writeFileSync(file, panelSvg(script.panels[i]!, bible, i), 'utf8');
    results.push({ panel: i + 1, file, source: 'builtin' });
  }

  function finish(mode: 'page' | 'panels', lettering: 'model' | 'overlay'): void {
    results.sort((a, b) => a.panel - b.panel);
    writeJson(run, 'art/manifest.json', {
      provider: choice.id,
      mode,
      lettering,
      panels: results,
      castMade,
    });
    emit(
      opts,
      {
        provider: choice.id,
        mode,
        lettering,
        panels: results,
        castMade,
        hint: choice.hint,
        warning,
      },
      () =>
        [
          ...castMade.map(
            (id) => `character sheet: ${id} -> ${join(run.dir, 'art', `cast-${id}.png`)}`,
          ),
          ...results.map((r) =>
            r.panel === 0
              ? `page: ${r.source} -> ${r.file}`
              : `panel ${r.panel}: ${r.source} -> ${r.file}`,
          ),
          warning ? `Warning: ${warning}` : '',
          choice.hint ? `Note: ${choice.hint}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
    );
  }
}

const used = (script: ComicScript) => [
  ...new Set(script.panels.flatMap((p) => p.characters.map((c) => c.cast))),
];

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

/** Draw the whole page, lettering included, with the character sheets attached. */
async function makePage(
  run: Run,
  root: string,
  script: ComicScript,
  bible: SeriesBible,
  id: ProviderId,
): Promise<{ panel: number; file: string; source: string }> {
  const refs = [...castRefs(run, root, bible, used(script)).values()];
  const aspect = script.aspect ?? formatById(script.format)?.aspect ?? '4:3';
  const [img] = await generateImages(id, [
    {
      prompt: pagePrompt(
        script,
        bible,
        refs.map((r) => r.label ?? 'a character'),
      ),
      refs,
      aspect,
    },
  ]);
  clearPage(run);
  const file = join(run.dir, 'art', `page.${extOf(img!)}`);
  writeFileSync(file, img!);
  return { panel: 0, file, source: id };
}

/** Draw reference portraits for cast members in this comic who don't have one yet. */
async function makeCast(
  run: Run,
  root: string,
  script: ComicScript,
  bible: SeriesBible,
  id: ProviderId,
): Promise<string[]> {
  const ids = used(script);
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
  const cast = castRefs(run, root, bible, used(script));
  const save = (i: number, data: Uint8Array) => {
    rmSync(join(run.dir, 'art', `panel-${i + 1}.svg`), { force: true });
    const file = join(run.dir, 'art', `panel-${i + 1}.${extOf(data)}`);
    writeFileSync(file, data);
    results.push({ panel: i + 1, file, source: id });
  };
  if (id === 'codex' || id === 'antigravity') {
    // One agent session draws every panel, with all the character sheets attached.
    const refs = [...cast.values()];
    const images = await generateImages(
      id,
      todo.map((t) => ({ prompt: artPrompt(t.panel, bible, t.i, script), refs })),
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
      { prompt: artPrompt(t.panel, bible, t.i, script), refs },
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
  const ids = used(script);
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
  const prompts = isPage(script)
    ? [
        {
          panel: 0,
          saveTo: join(run.dir, 'art', 'page.png'),
          prompt: pagePrompt(
            script,
            bible,
            references.map((r) => `${r.cast} (character reference)`),
          ),
        },
      ]
    : script.panels.map((p, i) => ({
        panel: i + 1,
        saveTo: join(run.dir, 'art', `panel-${i + 1}.png`),
        prompt: artPrompt(p, bible, i, script),
      }));
  emit(
    opts,
    { cast, references, prompts, text: isPage(script) ? pageText(script) : undefined },
    () =>
      [
        ...(cast.length
          ? [
              'Character sheets first (then use them as references):',
              ...cast.map((c) => `${c.cast} -> ${c.saveTo}\n${c.prompt}`),
              '',
            ]
          : []),
        ...(references.length
          ? [`Character references: ${references.map((r) => r.path).join(', ')}`, '']
          : []),
        ...prompts.map((p) =>
          p.panel === 0
            ? `Whole page -> ${p.saveTo}\n${p.prompt}`
            : `Panel ${p.panel} -> ${p.saveTo}\n${p.prompt}`,
        ),
      ].join('\n\n'),
  );
}

/** "owner/repo #N", or the branch while the PR doesn't exist yet. */
function footerText(run: Run, root: string): string {
  const ctx = readJson<{
    repo?: string;
    head?: string;
    existingPr?: { number: number } | null;
  }>(run, 'context.json');
  const truth = prTruth(root, { noGh: true });
  const web = repoWeb(truth)?.replace(/^https?:\/\/[^/]+\//, '');
  const repo = ctx?.repo || web || truth.toplevel.split(/[\/]/).pop() || 'this repo';
  if (ctx?.existingPr?.number) return `${repo} #${ctx.existingPr.number}`;
  const head = ctx?.head ?? truth.head;
  return head && head !== 'HEAD' ? `${repo} · ${head}` : repo;
}

export async function comicRenderCmd(
  cwd: string,
  opts: OutOpts & { run?: string },
): Promise<void> {
  const { run, root, script, bible } = load(cwd, opts.run);
  const story = readJson<{ story?: Story }>(run, 'context.json')?.story;
  const manifest = readJson<{ mode?: string }>(run, 'art/manifest.json');
  const page =
    isPage(script) && manifest?.mode !== 'panels' ? existingPage(run) : undefined;
  let svg: string;
  if (page) {
    svg = pageWithFooter(
      { mime: page.mime, data: readFileSync(page.path) },
      footerText(run, root),
    );
  } else {
    const images: PanelImage[] = script.panels.map((panel, i) => {
      const have = existingPanel(run, i);
      if (have) return { mime: have.mime, data: readFileSync(have.path) };
      return {
        mime: 'image/svg+xml',
        data: new TextEncoder().encode(panelSvg(panel, bible, i)),
      };
    });
    const layout = readJson<Layout>(run, 'layout.json');
    svg = composePage(
      script,
      bible,
      images,
      {
        episode: story?.episode,
        footer: isPage(script) ? footerText(run, root) : undefined,
      },
      layout,
    );
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
 * Keep the story, change the look: pick a fresh style that suits the cast (or
 * the one given), update comic.json, and redraw with the approved provider.
 */
export async function comicRerollCmd(cwd: string, opts: RerollOpts): Promise<void> {
  const { run, root, script, bible } = load(cwd, opts.run);
  if (!isPage(script))
    throw new UserError('Reroll works on comic pages (comic.json with "v": 2).');
  const check = checkOptsFor(run, root);
  if (check.pinnedStyle && opts.style && opts.style !== check.pinnedStyle)
    throw new UserError(
      `This repo pins the style "${check.pinnedStyle}" (config style).`,
    );
  const cast = used(script)
    .map((id) => bible.cast.find((c) => c.id === id))
    .filter((c): c is SeriesBible['cast'][number] => !!c);
  let style = opts.style ? styleById(opts.style) : undefined;
  if (opts.style && !style)
    throw new UserError(
      `Unknown style "${opts.style}". Use one of: ${STYLES.map((x) => x.id).join(', ')}`,
    );
  if (style) {
    const clash = styleClash(style, cast, { allowAnimalAnime: check.allowAnimalAnime });
    if (clash && check.pinnedStyle !== style.id) throw new UserError(clash);
  } else if (check.pinnedStyle) {
    throw new UserError(
      `This repo pins the style "${check.pinnedStyle}"; there is nothing to reroll to.`,
    );
  } else {
    const fresh = fittingStyles(
      cast,
      [script.style ?? '', ...(check.recentStyles ?? [])],
      {
        allowAnimalAnime: check.allowAnimalAnime,
      },
    ).filter((s) => s.id !== script.style);
    // Some randomness among the freshest few, so rerolls don't always land on the same one.
    const pool = fresh.slice(0, 4);
    style = pool[Math.floor(Math.random() * pool.length)];
    if (!style) throw new UserError('No other style suits this cast.');
  }
  const next: ComicScript = { ...script, style: style.id };
  if (opts.format) {
    if (!formatById(opts.format))
      throw new UserError(
        `Unknown format "${opts.format}". Use one of: ${FORMATS.map((f) => f.id).join(', ')}`,
      );
    next.format = opts.format;
    if (opts.format !== 'custom') delete next.aspect;
  }
  if (opts.palette) {
    if (!PALETTES.includes(opts.palette as Palette))
      throw new UserError(
        `Unknown palette "${opts.palette}". Use one of: ${PALETTES.join(', ')}`,
      );
    next.palette = opts.palette as Palette;
  } else if (!next.palette || !style.palettes.includes(next.palette)) {
    next.palette = style.palettes[0];
  }
  const problems = errors(checkScript(next, bible, { ...check, recentStyles: [] }));
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
