/** Shared art direction. Legacy v2 scripts intentionally retain their old defaults. */
import { createHash } from 'node:crypto';
import { formatById } from './formats.ts';
import {
  LAYOUT_FAMILIES,
  type Aspect,
  type ComicScript,
  type ComicSummary,
  type Composition,
  type FrameBounds,
  type PanelFrame,
  type StyleFamily,
} from './types.ts';

export function pageAspect(script: ComicScript): Aspect {
  return (
    script.aspect ??
    (script.composition?.family === 'vertical'
      ? '3:4'
      : (formatById(script.format)?.aspect ?? '4:3'))
  );
}
export function aspectRatio(aspect: Aspect): number {
  const [w, h] = aspect.split(':').map(Number);
  return w! / h!;
}
export function visibleHeadline(script: ComicScript): string {
  const value =
    script.composition?.title?.mode === 'none' ? '' : (script.headline ?? script.title);
  return typeof value === 'string' ? value : '';
}

export function resolveComposition(
  script: ComicScript,
): (Composition & { frames: PanelFrame[] }) | undefined {
  const c = script.composition;
  if (!c) return;
  if (c.frames) return { ...c, frames: c.frames };
  const n = script.panels.length;
  const top = c.title.mode === 'heading' ? 0.14 : 0.025;
  const height = 0.975 - top;
  const frame = (x: number, y: number, w: number, h: number): PanelFrame => ({
    x,
    y: top + y * height,
    w,
    h: h * height,
  });
  const gap = 0.025;
  let frames: PanelFrame[];
  switch (c.family) {
    case 'single':
      frames = [frame(0.025, 0, 0.95, 1)];
      break;
    case 'comparison':
    case 'sequence': {
      const w = (0.95 - gap * (n - 1)) / n;
      frames = Array.from({ length: n }, (_, i) => frame(0.025 + i * (w + gap), 0, w, 1));
      break;
    }
    case 'vertical': {
      const h = (1 - gap * (n - 1)) / n;
      frames = Array.from({ length: n }, (_, i) => frame(0.025, i * (h + gap), 0.95, h));
      break;
    }
    case 'asymmetric': {
      // Small setup beats above a wide, visually dominant payoff.
      const count = n - 1;
      const cols = count <= 2 ? count : 2;
      const rows = Math.ceil(count / cols);
      const w = (0.95 - gap * (cols - 1)) / cols;
      const h = (0.46 - gap * (rows - 1)) / rows;
      frames = Array.from({ length: count }, (_, i) =>
        frame(0.025 + (i % cols) * (w + gap), Math.floor(i / cols) * (h + gap), w, h),
      );
      frames.push(frame(0.025, 0.49, 0.95, 0.51));
      break;
    }
    case 'hero-inset': {
      frames = [
        { ...frame(0.025, 0, 0.95, 1), textBox: { x: 0.035, y: 0.03, w: 0.56, h: 0.8 } },
      ];
      const h = (0.88 - gap * (n - 2)) / (n - 1);
      for (let i = 0; i < n - 1; i++)
        frames.push(frame(0.64, 0.045 + i * (h + gap), 0.305, h));
      break;
    }
    case 'diagonal':
      frames = [
        {
          ...frame(0.025, 0, 0.95, 1),
          clip: [
            [0, 0],
            [0.98, 0],
            [0, 0.98],
          ],
          textBox: { x: 0.035, y: 0.03, w: 0.48, h: 0.32 },
        },
        {
          ...frame(0.025, 0, 0.95, 1),
          clip: [
            [1, 0.02],
            [1, 1],
            [0.02, 1],
          ],
          textBox: { x: 0.5, y: 0.65, w: 0.46, h: 0.31 },
        },
      ];
      break;
    default:
      frames = [];
  }
  return { ...c, frames };
}

export function titleBox(script: ComicScript): FrameBounds | undefined {
  const title = script.composition?.title;
  if (!title || title.mode === 'none') return;
  return (
    title.box ??
    (title.mode === 'heading'
      ? { x: 0.035, y: 0.015, w: 0.93, h: 0.1 }
      : { x: 0.055, y: 0.82, w: 0.55, h: 0.13 })
  );
}

export function frameAspect(script: ComicScript, index: number): Aspect {
  const f = resolveComposition(script)?.frames[index];
  if (!f) return '1:1';
  const ratio = (f.w * aspectRatio(pageAspect(script))) / f.h;
  return (['1:1', '4:3', '16:9', '3:4'] as Aspect[]).reduce((a, b) =>
    Math.abs(Math.log(aspectRatio(a) / ratio)) <
    Math.abs(Math.log(aspectRatio(b) / ratio))
      ? a
      : b,
  );
}

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;
export function compositionPrompt(script: ComicScript): string {
  const c = resolveComposition(script);
  if (!c) return '';
  return [
    `Composition: ${c.family}; exactly ${c.frames.length} scene(s), read left-to-right then top-to-bottom in the numbered story order. Preserve the specified hierarchy, unequal sizes and negative space.`,
    ...c.frames.map(
      (f, i) =>
        `Frame ${i + 1}: left ${percent(f.x)}, top ${percent(f.y)}, width ${percent(f.w)}, height ${percent(f.h)}; ${f.clip ? `polygon clipping points ${JSON.stringify(f.clip)}` : 'rectangular'}; ${f.border === 'none' ? 'borderless' : 'visible frame border'}.`,
    ),
    c.title.mode === 'none'
      ? 'No visible title or headline. Start with the art; do not reserve a title banner.'
      : `Title treatment: ${c.title.mode}; place "${visibleHeadline(script)}" inside this page area ${JSON.stringify(titleBox(script))}. ${c.title.mode === 'integrated' ? 'Integrate it into the scene; no separate top banner.' : 'Keep it inside that heading area, sized to the composition.'}`,
  ].join('\n');
}

export function artFingerprint(
  script: ComicScript,
  lettering: 'model' | 'overlay',
): string {
  // Local reasoning doesn't change the drawing; labels live in the dialogue.
  const { designReason: _private, anchor: _anchor, ...art } = script;
  return createHash('sha256').update(JSON.stringify({ art, lettering })).digest('hex');
}

const STYLE_GROUPS: [StyleFamily, string[]][] = [
  ['ink', ['manga-ink', 'noir', 'ligne-claire']],
  [
    'flat-color',
    [
      'shonen-action',
      'mecha-anime',
      'chibi-anime',
      'sunday-strip',
      'rubber-hose',
      'atomic-flat',
      'vaporwave',
    ],
  ],
  ['painted', ['storybook-watercolor', 'pulp-scifi']],
  ['print', ['silver-age', 'ukiyo-e']],
  ['dimensional', ['claymation']],
  ['pixel', ['pixel-16bit']],
  ['technical', ['blueprint']],
];
export function comicSummary(script: ComicScript): ComicSummary {
  const knownCast =
    Array.isArray(script.characters) && script.characters.every((c) => c.kind);
  return {
    style: script.style,
    ...(script.styleFamily || STYLE_GROUPS.some(([, ids]) => ids.includes(script.style))
      ? {
          styleFamily:
            script.styleFamily ??
            STYLE_GROUPS.find(([, ids]) => ids.includes(script.style))![0],
        }
      : {}),
    ...(script.composition
      ? {
          layoutFamily: script.composition.family,
          titleTreatment: script.composition.title.mode,
        }
      : {}),
    panelCount: script.panels.length,
    ...(knownCast
      ? { castKinds: [...new Set(script.characters.map((c) => c.kind!))].sort() }
      : {}),
  };
}

type Point = [number, number];
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
function inPolygon(p: Point, polygon: Point[]): boolean {
  const sides = polygon
    .map((a, i) => cross(a, polygon[(i + 1) % polygon.length]!, p))
    .filter((v) => Math.abs(v) > 1e-8);
  return sides.every((v) => v >= 0) || sides.every((v) => v <= 0);
}
function points(frame: PanelFrame): Point[] {
  return (
    frame.clip ?? [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
  ).map(([x, y]) => [frame.x + x * frame.w, frame.y + y * frame.h]);
}
function overlaps(a: Point[], b: Point[]): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!,
        q = poly[(i + 1) % poly.length]!;
      const axis: Point = [q[1] - p[1], p[0] - q[0]];
      const pa = a.map(([x, y]) => x * axis[0] + y * axis[1]);
      const pb = b.map(([x, y]) => x * axis[0] + y * axis[1]);
      if (
        Math.min(...pa) >= Math.max(...pb) - 1e-8 ||
        Math.min(...pb) >= Math.max(...pa) - 1e-8
      )
        return false;
    }
  return true;
}
export function validBounds(value: unknown): value is FrameBounds {
  const r = value as FrameBounds | undefined;
  return (
    !!r &&
    [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.w > 0 &&
    r.h > 0 &&
    r.x + r.w <= 1.00000001 &&
    r.y + r.h <= 1.00000001
  );
}

export function compositionProblems(
  script: ComicScript,
): { where: string; problem: string }[] {
  const c = script.composition;
  if (!c) return [];
  const out: { where: string; problem: string }[] = [];
  const bad = (where: string, problem: string) =>
    out.push({ where: `composition.${where}`, problem });
  if (!LAYOUT_FAMILIES.includes(c.family))
    bad('family', `must be ${LAYOUT_FAMILIES.join(', ')}`);
  if (!c.title || !['none', 'integrated', 'heading'].includes(c.title.mode))
    bad('title.mode', 'must be none, integrated or heading');
  if (c.title?.box !== undefined && !validBounds(c.title.box))
    bad('title.box', 'must be positive bounds within the 0–1 page');
  const limits: Partial<Record<Composition['family'], [number, number]>> = {
    single: [1, 1],
    comparison: [2, 3],
    asymmetric: [3, 6],
    'hero-inset': [2, 6],
    diagonal: [2, 2],
  };
  const range = limits[c.family];
  if (range && (script.panels.length < range[0] || script.panels.length > range[1]))
    bad(
      'family',
      `${c.family} needs ${range[0]}–${range[1]} panels; choose another family or explicit custom geometry`,
    );
  if (c.family === 'custom' && !Array.isArray(c.frames))
    bad('frames', 'custom composition requires explicit frames');
  if (
    c.frames !== undefined &&
    (!Array.isArray(c.frames) || c.frames.length !== script.panels.length)
  )
    bad('frames', 'must contain one frame per story panel, in reading order');
  if (out.length) return out;
  const resolved = resolveComposition(script)!;
  resolved.frames.forEach((f, i) => {
    const at = `frames[${i}]`;
    if (!validBounds(f)) {
      bad(at, 'must be positive bounds within the 0–1 page');
      return;
    }
    if (f.border !== undefined && !['line', 'none'].includes(f.border))
      bad(`${at}.border`, 'must be line or none');
    if (f.inset !== undefined && typeof f.inset !== 'boolean')
      bad(`${at}.inset`, 'must be boolean');
    if (f.textBox !== undefined && !validBounds(f.textBox))
      bad(`${at}.textBox`, 'must be positive bounds within the 0–1 frame');
    if (f.clip !== undefined) {
      if (
        !Array.isArray(f.clip) ||
        f.clip.length < 3 ||
        f.clip.length > 8 ||
        f.clip.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 2 ||
            p.some((n) => !Number.isFinite(n) || n < 0 || n > 1),
        )
      ) {
        bad(`${at}.clip`, 'use 3–8 polygon points in the frame’s 0–1 space');
        return;
      }
      const turns = f.clip.map((a, k) =>
        cross(a, f.clip![(k + 1) % f.clip!.length]!, f.clip![(k + 2) % f.clip!.length]!),
      );
      if (
        turns.every((v) => Math.abs(v) < 1e-8) ||
        !(turns.every((v) => v >= -1e-8) || turns.every((v) => v <= 1e-8)) ||
        !f.clip.every((p) => inPolygon(p, f.clip!))
      )
        bad(
          `${at}.clip`,
          'must be a nonzero convex polygon, with points around its edge',
        );
      if (script.panels[i]?.dialogue?.length && !f.textBox)
        bad(`${at}.textBox`, 'polygon panels with dialogue require a safe lettering box');
      if (
        f.textBox &&
        validBounds(f.textBox) &&
        points(f.textBox).some((p) => !inPolygon(p, f.clip!))
      )
        bad(`${at}.textBox`, 'must fit entirely inside the clipping polygon');
    }
  });
  if (out.length) return out;
  const heading = c.title.mode === 'heading' ? points(titleBox(script)!) : undefined;
  resolved.frames.forEach((f, i) => {
    const poly = points(f);
    if (heading && overlaps(poly, heading))
      bad(
        `frames[${i}]`,
        'overlaps the separate heading; move it or use integrated title treatment',
      );
    for (let j = 0; j < i; j++) {
      const before = points(resolved.frames[j]!);
      if (!overlaps(poly, before)) continue;
      const inset =
        (c.family === 'hero-inset' || f.inset) && poly.every((p) => inPolygon(p, before));
      if (!inset)
        bad(
          `frames[${i}]`,
          `overlaps frame ${j + 1}; deliberate insets must be contained and marked inset: true`,
        );
    }
  });
  return out;
}
