import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  artFingerprint,
  comicSummary,
  frameAspect,
  resolveComposition,
  visibleHeadline,
} from '../src/comic/composition.ts';
import { composePage, imageSize } from '../src/comic/compose.ts';
import { checkScript, errors, pageText, transcript } from '../src/comic/script.ts';
import { artPrompt, pagePrompt } from '../src/comic/providers.ts';
import { svgToPng } from '../src/comic/raster.ts';
import { recentComics, recentStyles } from '../src/github/history.ts';
import { encodeMeta } from '../src/github/body.ts';
import { prTruth } from '../src/git/pr.ts';
import type { ComicScript } from '../src/comic/types.ts';
import { COMIC_STORIES } from './fixtures/comic-stories.ts';
import { pageScript } from './pageScript.ts';
import { makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(90_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const example = (id: string): ComicScript =>
  structuredClone(COMIC_STORIES.find((c) => c.id === id)!.script);

describe('story-led compositions', () => {
  test('a hidden art title is absent everywhere readers see lettering, while metadata stays named', () => {
    const s = example('single');
    s.headline = 'This metadata headline has more than six words';
    expect(errors(checkScript(s))).toEqual([]);
    expect(visibleHeadline(s)).toBe('');
    expect(pageText(s)).toEqual(['One tiny handle.']);
    expect(pagePrompt(s)).not.toContain(s.headline);
    expect(pagePrompt(s)).not.toContain('lettered big and bold');
    expect(pagePrompt(s)).toContain('No visible title');
    expect(transcript(s)).not.toContain(s.headline);
    expect(composePage(s, [])).not.toContain(s.headline);
    expect(s.title).toBe('The Last Drip');
  });

  test('explicit composition wins over the stock horizontal-strip and headline instructions', () => {
    const s = example('vertical');
    s.format = 'strip';
    const prompt = pagePrompt(s);
    expect(prompt).toContain('portrait 3:4');
    expect(prompt).toContain('Composition: vertical');
    expect(prompt).not.toContain('horizontal row');
    expect(prompt).not.toMatch(/bold brush-script headline|Headline, lettered/);
    expect(prompt).toContain('human characters are welcome');
    expect(artPrompt(s.panels[0]!, 0, s)).not.toContain('Square image');
    expect(frameAspect(s, 0)).toBe('16:9');
  });

  test('geometry validates bounds, reading-order count, safe clipping and deliberate insets', () => {
    const s = example('comparison');
    s.composition!.frames = [{ x: 0, y: 0, w: 1, h: 1 }];
    expect(errors(checkScript(s)).some((p) => p.where === 'composition.frames')).toBe(
      true,
    );
    s.composition!.frames = [
      { x: 0, y: 0, w: 0.6, h: 1 },
      { x: 0.5, y: 0, w: 0.6, h: 1 },
    ];
    expect(errors(checkScript(s)).some((p) => p.problem.includes('bounds'))).toBe(true);
    s.composition!.frames[1]!.w = 0.5;
    expect(errors(checkScript(s)).some((p) => p.problem.includes('overlaps'))).toBe(true);
    const inset = example('hero-inset');
    expect(errors(checkScript(inset))).toEqual([]);
    inset.composition!.family = 'custom';
    inset.composition!.frames = resolveComposition(example('hero-inset'))!.frames;
    expect(errors(checkScript(inset)).some((p) => p.problem.includes('overlaps'))).toBe(
      true,
    );
    inset.composition!.frames.slice(1).forEach((f) => (f.inset = true));
    expect(errors(checkScript(inset))).toEqual([]);
    const diagonal = example('diagonal');
    diagonal.composition!.frames = resolveComposition(diagonal)!.frames;
    diagonal.composition!.frames[0]!.textBox = { x: 0.7, y: 0.7, w: 0.2, h: 0.2 };
    expect(
      errors(checkScript(diagonal)).some((p) =>
        p.problem.includes('inside the clipping polygon'),
      ),
    ).toBe(true);
    diagonal.composition!.frames[0]!.clip = [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ];
    expect(
      errors(checkScript(diagonal)).some((p) => p.problem.includes('convex polygon')),
    ).toBe(true);
  });

  test('overlay preserves six different geometries and rasterizes without square-grid fallback', async () => {
    for (const item of COMIC_STORIES) {
      expect(errors(checkScript(item.script))).toEqual([]);
      const svg = composePage(item.script, []);
      expect(svg.match(/<clipPath/g)).toHaveLength(item.script.panels.length);
      expect(svg).not.toContain('transform="scale(');
      expect(svg).toContain('made with Tracetoon');
      const size = imageSize(await svgToPng(svg, 800))!;
      expect(size.w).toBe(800);
      if (item.id === 'vertical' || item.id === 'asymmetric')
        expect(size.h).toBeGreaterThan(size.w);
      if (item.id === 'diagonal') expect(svg.match(/<polygon/g)).toHaveLength(4);
    }
    const final = resolveComposition(example('asymmetric'))!.frames;
    expect(final.at(-1)!.h).toBeGreaterThan(final[0]!.h);
  });

  test('overlay refuses clipped or overflowing dialogue instead of stretching it', () => {
    const s = example('comparison');
    s.composition!.frames = [
      { x: 0, y: 0, w: 0.06, h: 1 },
      { x: 0.1, y: 0, w: 0.9, h: 1 },
    ];
    expect(() => composePage(s, [])).toThrow('too narrow');
    const normal = example('comparison');
    expect(() =>
      composePage(normal, [], { panels: [[{ x: 0.95, y: 0.95 }], []] }),
    ).toThrow('does not fit');
    normal.panels[0]!.dialogue[0]!.text = 'Unbreakable'.repeat(30);
    expect(() => composePage(normal, [])).toThrow('does not fit');
  });

  test('cache fingerprints cover composition and title changes, not private reasoning', () => {
    const s = example('comparison');
    const original = artFingerprint(s, 'model');
    s.designReason = 'A private evaluation note.';
    expect(artFingerprint(s, 'model')).toBe(original);
    s.composition!.title.mode = 'none';
    expect(artFingerprint(s, 'model')).not.toBe(original);
    expect(artFingerprint(s, 'overlay')).not.toBe(artFingerprint(s, 'model'));
  });

  test('repeat checks are semantic, advisory and respect style pins and unknown history', () => {
    const s = example('diagonal');
    const recent = Array.from({ length: 3 }, () => comicSummary(s));
    const findings = checkScript(s, { recentComics: recent });
    expect(findings.filter((p) => p.severity === 'warning').map((p) => p.where)).toEqual([
      'composition',
      'characters',
      'styleFamily',
    ]);
    expect(errors(findings)).toEqual([]);
    expect(
      checkScript(s, { recentComics: recent, pinnedStyle: s.style }).some(
        (p) => p.where === 'styleFamily',
      ),
    ).toBe(false);
    expect(
      checkScript(s, { recentComics: [{ style: 'some old custom style' }] }),
    ).toEqual([]);
    const noCast = example('single');
    expect(comicSummary(noCast).castKinds).toEqual([]);
    expect(comicSummary(pageScript()).castKinds).toBeUndefined();
  });
});

describe('creative history', () => {
  const saved = {
    script: process.env.TRACETOON_GH_SCRIPT,
    prs: process.env.FAKE_GH_PRS,
    log: process.env.FAKE_GH_LOG,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries({
      TRACETOON_GH_SCRIPT: saved.script,
      FAKE_GH_PRS: saved.prs,
      FAKE_GH_LOG: saved.log,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  test('reads compact choices, keeps old fields unknown and performs no network read offline', () => {
    process.env.TRACETOON_GH_SCRIPT = resolve(import.meta.dir, 'fake-gh.ts');
    process.env.FAKE_GH_LOG = join(tempDir(), 'gh.jsonl');
    const log = process.env.FAKE_GH_LOG;
    process.env.FAKE_GH_PRS = JSON.stringify([
      { number: 1, body: encodeMeta({ v: 1, style: 'noir' }) },
      {
        number: 2,
        body: encodeMeta({
          v: 1,
          style: 'custom ink',
          comic: {
            layoutFamily: 'diagonal',
            panelCount: 2,
            titleTreatment: 'none',
            castKinds: ['creature'],
            styleFamily: 'ink',
            secret: 'must not escape',
          } as any,
        }),
      },
    ]);
    const truth = prTruth(makeRepo().root, { noGh: true });
    expect(recentComics(truth, { offline: true })).toEqual([]);
    expect(existsSync(log!)).toBe(false);
    const history = recentComics(truth);
    expect(history).toEqual([
      {
        style: 'custom ink',
        styleFamily: 'ink',
        layoutFamily: 'diagonal',
        panelCount: 2,
        titleTreatment: 'none',
        castKinds: ['creature'],
      },
      { style: 'noir' },
    ]);
    expect(JSON.stringify(history)).not.toContain('secret');
    expect(recentStyles(truth)).toEqual(['custom ink', 'noir']);
  });
});

describe('composition CLI and cache', () => {
  test('changed composition regenerates art and refuses stale output; format rerolls need matching beats', () => {
    const repo = makeRepo();
    repo.commit('feature.ts', 'export const ready = true;', 'feat: ready');
    const scratch = tempDir();
    const env = {
      ...process.env,
      TRACETOON_CONFIG: join(scratch, 'config.json'),
      CLAUDE_CONFIG_DIR: scratch,
      CODEX_HOME: scratch,
      GEMINI_HOME: scratch,
      ANTIGRAVITY_HOME: scratch,
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
      TRACETOON_CODEX_BIN: resolve(import.meta.dir, 'fake-codex.ts'),
      FAKE_CODEX_LOG: join(scratch, 'codex.jsonl'),
    };
    writeFileSync(env.TRACETOON_CONFIG, JSON.stringify({ imageConsent: ['codex'] }));
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
        cwd: repo.root,
        env,
        encoding: 'utf8',
      });
      return { code: r.status, json: JSON.parse(r.stdout) as any };
    };
    const d = cli('digest', '--offline');
    expect(cli('context', '--offline').code).toBe(0);
    const run = d.json.runDir;
    const s = example('comparison');
    writeFileSync(join(run, 'comic.json'), JSON.stringify(s));
    writeFileSync(join(run, 'body.md'), 'Makes saving clearer.');
    expect(cli('comic', 'art', '--provider', 'codex').code).toBe(0);
    expect(cli('comic', 'render').code).toBe(0);
    expect(cli('render').code).toBe(0);
    const calls = () =>
      readFileSync(env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').length;
    const first = calls();
    expect(cli('comic', 'art', '--provider', 'codex').code).toBe(0);
    expect(calls()).toBe(first);
    s.composition!.title.mode = 'none';
    writeFileSync(join(run, 'comic.json'), JSON.stringify(s));
    expect(cli('render').json.error).toContain('stale');
    expect(cli('comic', 'render').json.error).toContain('earlier script');
    expect(cli('comic', 'art', '--provider', 'codex').code).toBe(0);
    expect(calls()).toBeGreaterThan(first);
    expect(cli('comic', 'render').code).toBe(0);
    expect(cli('render').code).toBe(0);
    expect(cli('comic', 'reroll', '--format', 'movie-poster').json.error).toContain(
      'rewrite the story',
    );
    expect(cli('comic', 'reroll', '--format', '4koma').json.error).toContain(
      'rewrite the story',
    );
    expect(cli('comic', 'reroll', '--format', 'strip').code).toBe(0);
    const rerolled = JSON.parse(readFileSync(join(run, 'comic.json'), 'utf8'));
    expect(rerolled.composition.family).toBe('sequence');
    expect(rerolled.composition.title.mode).toBe('none');
    expect(rerolled.layout).toBeUndefined();
    // Printing host-tool prompts cannot make old art current. Saving a fresh
    // page to the requested path can, without invoking a paid provider.
    rerolled.composition.title.mode = 'heading';
    writeFileSync(join(run, 'comic.json'), JSON.stringify(rerolled));
    const prompts = cli('comic', 'prompts');
    expect(prompts.code).toBe(0);
    expect(cli('comic', 'render').json.error).toContain('earlier script');
    const file = prompts.json.prompts[0].saveTo;
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0])]));
    expect(cli('comic', 'render').code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(run, 'art/manifest.json'), 'utf8')).provider,
    ).toBe('host');
    expect(cli('render').code).toBe(0);
    const freshPage = readFileSync(file);
    rerolled.style = 'clean pencil on warm paper';
    writeFileSync(join(run, 'comic.json'), JSON.stringify(rerolled));
    Object.assign(env, { FAKE_CODEX_MAKE: '0' });
    expect(
      cli('comic', 'art', '--lettering', 'overlay', '--provider', 'codex').code,
    ).not.toBe(0);
    expect(
      JSON.parse(readFileSync(join(run, 'art/manifest.json'), 'utf8')).fingerprint,
    ).toBe(artFingerprint(rerolled, 'overlay'));
    // Simulate a panel completed before a failed API batch: the retry must keep it.
    writeFileSync(join(run, 'art', 'panel-1.png'), freshPage);
    delete (env as Record<string, string | undefined>).FAKE_CODEX_MAKE;
    expect(
      cli('comic', 'art', '--lettering', 'overlay', '--provider', 'codex').code,
    ).toBe(0);
    expect(readFileSync(join(run, 'art', 'panel-1.png'))).toEqual(freshPage);
  });
});
