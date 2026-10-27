/**
 * Lays out comic pages. Two kinds:
 *  - `composePage`: text-free panel art in a grid, with Tracetoon's bubbles,
 *    a title band and a footer (pages drawn with overlay lettering);
 *  - `pageWithFooter`: a whole page the image model drew, lettering included,
 *    with Tracetoon's exact footer bar underneath.
 */
import type { ComicScript, Dialogue, Panel } from './types.ts';
import {
  aspectRatio,
  pageAspect,
  resolveComposition,
  titleBox,
  visibleHeadline,
} from './composition.ts';

export const PAGE_W = 1600;
const MARGIN = 30;
const GUTTER = 24;
const TITLE_H = 110;
const FOOTER_H = 48;
export const CELL = (PAGE_W - 2 * MARGIN - GUTTER) / 2; // 758
export const PAGE_H = TITLE_H + MARGIN + 2 * CELL + GUTTER + FOOTER_H + MARGIN;
const SRC = 800; // panel art coordinate space (bubbles are placed in it, whatever the image size)
const FONT = 'Comic Neue';
const INK = '#2B2B33';

export interface PanelImage {
  mime: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp';
  data: Uint8Array;
}

/** Optional hand placement of bubbles: per panel, per dialogue line, 0–1 coordinates. */
export interface Layout {
  panels: ({ x: number; y: number; w?: number } | null)[][];
}

export const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Approximate text width for the bundled Comic Neue Bold. */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    if ("il.,:;'!|".includes(ch)) w += 0.26;
    else if ('mwMW@'.includes(ch)) w += 0.82;
    else if (ch === ' ') w += 0.28;
    else if (ch >= 'A' && ch <= 'Z') w += 0.6;
    else w += 0.5;
  }
  return w * size;
}

function greedy(text: string, maxWidth: number, size: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (textWidth(next, size) > maxWidth && cur) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Wrap to the fewest lines, then narrow the width so the lines come out even. */
export function wrap(text: string, maxWidth: number, size: number): string[] {
  const best = greedy(text, maxWidth, size);
  if (best.length < 2) return best;
  let lines = best;
  for (let w = maxWidth - 10; w > size * 3; w -= 10) {
    const tryLines = greedy(text, w, size);
    if (tryLines.length > best.length) break;
    lines = tryLines;
  }
  return lines;
}

const XPOS = { left: 200, center: 400, right: 600 } as const;

function speakerX(panel: Panel, speaker: string, width = SRC): number | undefined {
  const c = panel.characters.find(
    (pc) => pc.name.toLowerCase() === speaker.toLowerCase(),
  );
  return c ? (XPOS[c.position] * width) / SRC : undefined;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Look {
  caption: string;
  sfx: string;
}

function bubble(
  d: Dialogue,
  box: Box,
  lines: string[],
  size: number,
  tailTo?: number,
  look: Look = { caption: '#FFF3B0', sfx: '#F25F5C' },
): string {
  const kind =
    d.kind === 'label'
      ? 'label'
      : d.speaker === 'caption' || d.kind === 'sign'
        ? 'caption'
        : (d.kind ?? 'speech');
  const lh = size * 1.18;
  const textX = box.x + box.w / 2;
  const textY = box.y + (box.h - lines.length * lh) / 2 + size * 0.88;
  const text = lines
    .map(
      (l, i) =>
        `<text x="${textX}" y="${textY + i * lh}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${INK}">${esc(l)}</text>`,
    )
    .join('');
  if (kind === 'label') {
    // A tidy callout tag: white, square-ish, thinner line than a caption box.
    return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" fill="#FFF" stroke="${INK}" stroke-width="3"/><circle cx="${box.x + 14}" cy="${box.y + box.h / 2}" r="5" fill="${INK}"/>${text}`;
  }
  if (kind === 'caption') {
    return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${look.caption}" stroke="${INK}" stroke-width="4"/>${text}`;
  }
  let tail = '';
  if (tailTo !== undefined) {
    const bx = Math.min(Math.max(tailTo, box.x + 40), box.x + box.w - 40);
    const by = box.y + box.h;
    // A short wedge aimed at the speaker.
    const tipY = by + 72;
    const tipX = bx + Math.max(-60, Math.min(60, (tailTo - bx) * 0.75));
    tail =
      kind === 'thought'
        ? `<circle cx="${tipX}" cy="${by + 22}" r="12" fill="#FFF" stroke="${INK}" stroke-width="4"/><circle cx="${tipX + (tailTo - bx) * 0.2}" cy="${by + 50}" r="7" fill="#FFF" stroke="${INK}" stroke-width="4"/>`
        : `<path d="M${bx - 26},${by - 4} L${tipX},${tipY} L${bx + 26},${by - 4}" fill="#FFF" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/><path d="M${bx - 22},${by - 6} L${bx + 22},${by - 6}" stroke="#FFF" stroke-width="8"/>`;
  }
  const rx = kind === 'thought' ? box.h / 2 : 28;
  const dash =
    kind === 'thought' ? ' stroke-dasharray="2 10" stroke-linecap="round"' : '';
  const shape = `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${rx}" fill="#FFF" stroke="${INK}" stroke-width="${kind === 'thought' ? 6 : 4}"${dash}/>`;
  return kind === 'thought' ? `${shape}${tail}${text}` : `${tail}${shape}${text}`;
}

function sfx(
  d: Dialogue,
  i: number,
  color = '#F25F5C',
  width = SRC,
  height = SRC,
  fit = false,
): string {
  const x = width * (i % 2 ? 0.65 : 0.35),
    y = height * 0.45;
  const size = fit
    ? Math.min(84, height * 0.4, (width * 0.6) / Math.max(d.text.length * 0.65, 1))
    : 84;
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${color}" stroke="#FFFFFF" stroke-width="10" paint-order="stroke" transform="rotate(-9 ${x} ${y})">${esc(d.text)}</text>`;
}

/** Bubbles for one panel, in the panel's own 800×800 space. */
export function panelBubbles(
  panel: Panel,
  placed?: ({ x: number; y: number; w?: number } | null)[],
  look?: Look,
  canvas?: { w: number; h: number; size: number },
): string {
  const size = canvas?.size ?? 30;
  const width = canvas?.w ?? SRC,
    height = canvas?.h ?? SRC;
  const boxes: Box[] = [];
  /**
   * The highest free spot for a bubble. Two bubbles may share a row only if the
   * new one sits to the right of the earlier ones, so reading order stays
   * left-to-right, top-to-bottom; otherwise it goes below, clear of their tails.
   */
  const place = (x: number, w: number, h: number): number => {
    for (let y = 22; y < (canvas ? height - h - 80 : 420); y += 6) {
      const ok = boxes.every((b) => {
        const rowOverlap = y < b.y + b.h + 34 && y + h + 34 > b.y;
        if (!rowOverlap) return y >= b.y + b.h; // below: always fine
        return x >= b.x + b.w + 16; // same row: only to the right
      });
      if (ok) return y;
    }
    return boxes.length ? Math.max(...boxes.map((b) => b.y + b.h + 20)) : 22;
  };
  return panel.dialogue
    .map((d, i) => {
      if (d.kind === 'sfx') return sfx(d, i, look?.sfx, width, height, !!canvas);
      const isCaption =
        d.speaker === 'caption' ||
        d.kind === 'caption' ||
        d.kind === 'sign' ||
        d.kind === 'label';
      const manual = placed?.[i];
      const maxW = manual?.w
        ? manual.w * width - 44
        : canvas
          ? Math.min(width - 80, isCaption ? width - 80 : width * 0.7)
          : isCaption
            ? 520
            : 330;
      if (maxW < 60)
        throw new Error(
          'The panel lettering area is too narrow. Enlarge it or reduce the dialogue.',
        );
      const lines = wrap(d.text, maxW, size);
      if (canvas && lines.some((line) => textWidth(line, size) > maxW))
        throw new Error(
          'Dialogue does not fit its safe panel area. Shorten the word or enlarge the frame/textBox.',
        );
      const w = Math.min(maxW, Math.max(...lines.map((l) => textWidth(l, size)))) + 44;
      const h = lines.length * size * 1.18 + 30;
      const sx = speakerX(panel, d.speaker, width);
      let x: number;
      let y: number;
      if (manual) {
        x = manual.x * width;
        y = manual.y * height;
      } else {
        if (isCaption) x = 18;
        else if (sx === undefined) x = (width - w) / 2;
        else x = Math.min(Math.max(sx - w / 2, 18), width - w - 18);
        y = place(x, w, h);
      }
      const box = { x, y, w, h };
      if (
        canvas &&
        (x < 0 || y < 0 || x + w > width || y + h + (isCaption ? 0 : 72) > height)
      )
        throw new Error(
          'Dialogue does not fit its safe panel area. Enlarge the frame/textBox, move the bubble or shorten the text.',
        );
      boxes.push(box);
      return bubble(d, box, lines, size, isCaption ? undefined : sx, look);
    })
    .join('');
}

function dataUri(img: PanelImage): string {
  return `data:${img.mime};base64,${Buffer.from(img.data).toString('base64')}`;
}

const FOOTER_BAR = 56;
const ACCENTS: Record<string, string> = {
  red: '#D7263D',
  blue: '#1F6FEB',
  yellow: '#F2B705',
  orange: '#F26B1D',
  green: '#2DA44E',
  pink: '#E83E8C',
  purple: '#8250DF',
  teal: '#1A9E9E',
  cyan: '#12B5CB',
};

/** Colors for bubbles and lettering that follow the comic's palette. */
function lookOf(script: ComicScript): { caption: string; sfx: string; paper: string } {
  const accent = ACCENTS[(script.accent ?? '').toLowerCase()] ?? '#F25F5C';
  if (script.palette === 'bw-accent')
    return { caption: '#FFFFFF', sfx: accent, paper: '#FFFFFF' };
  if (script.palette === 'duotone')
    return { caption: '#FFFFFF', sfx: accent, paper: '#F7F3EA' };
  return { caption: '#FFF3B0', sfx: accent, paper: '#FFFDF7' };
}

/** The footer bar: "made with Tracetoon", drawn by Tracetoon, never by the model. */
function footerBar(y: number, width: number): string {
  const ty = y + FOOTER_BAR / 2 + 9;
  return `<rect x="0" y="${y}" width="${width}" height="${FOOTER_BAR}" fill="#111114"/>
<text x="${width - 28}" y="${ty}" text-anchor="end" font-family="${FONT}" font-weight="700" font-size="24" fill="#C9C9D3">made with Tracetoon</text>`;
}

/** Width and height of a PNG or JPEG, from its header. */
export function imageSize(data: Uint8Array): { w: number; h: number } | undefined {
  const b = Buffer.from(data);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47)
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return undefined;
}

/**
 * A page the image model drew whole (lettering included), with Tracetoon's
 * footer bar added underneath.
 */
export function pageWithFooter(img: PanelImage, aspect = 4 / 3): string {
  const size = imageSize(img.data);
  const ratio = size ? size.w / size.h : aspect;
  const h = Math.round(PAGE_W / ratio);
  const total = h + FOOTER_BAR;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${total}" viewBox="0 0 ${PAGE_W} ${total}">
<rect width="${PAGE_W}" height="${total}" fill="#111114"/>
<image href="${dataUri(img)}" width="${PAGE_W}" height="${h}" preserveAspectRatio="xMidYMid slice"/>
${footerBar(h, PAGE_W)}
</svg>`;
}

/** Columns for a page of n square panels. */
function columns(n: number): number {
  if (n <= 3) return n;
  if (n === 4) return 2;
  return 3;
}

/**
 * The full page as SVG, with Tracetoon's bubbles over text-free art: pages
 * drawn with overlay lettering.
 */
export function composePage(
  script: ComicScript,
  images: PanelImage[],
  layout?: Layout,
): string {
  if (script.composition) return composeDesignedPage(script, images, layout);
  const n = script.panels.length;
  const cols = columns(n);
  const rows = Math.ceil(n / cols);
  const cell = (PAGE_W - 2 * MARGIN - (cols - 1) * GUTTER) / cols;
  const k = cell / SRC;
  const look = lookOf(script);
  const bodyH = TITLE_H + MARGIN + rows * cell + (rows - 1) * GUTTER + MARGIN;
  const height = bodyH + FOOTER_BAR;
  const cells = script.panels
    .map((panel, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const offset = ((cols - inRow) * (cell + GUTTER)) / 2; // center a short last row
      const px = MARGIN + offset + (i % cols) * (cell + GUTTER);
      const py = TITLE_H + MARGIN + row * (cell + GUTTER);
      const img = images[i];
      return `<g transform="translate(${px} ${py})">
<clipPath id="c${i}"><rect width="${cell}" height="${cell}" rx="10"/></clipPath>
<g clip-path="url(#c${i})">${img ? `<image href="${dataUri(img)}" width="${cell}" height="${cell}" preserveAspectRatio="xMidYMid slice"/>` : `<rect width="${cell}" height="${cell}" fill="#EEE"/>`}
<g transform="scale(${k})">${panelBubbles(panel, layout?.panels[i], look)}</g></g>
<rect width="${cell}" height="${cell}" rx="10" fill="none" stroke="${INK}" stroke-width="6"/>
${n > 1 ? `<circle cx="30" cy="${cell - 30}" r="18" fill="${INK}"/><text x="30" y="${cell - 21}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="24" fill="#FFF">${i + 1}</text>` : ''}
</g>`;
    })
    .join('\n');
  const footer = footerBar(bodyH, PAGE_W);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${height}" viewBox="0 0 ${PAGE_W} ${height}">
<rect width="${PAGE_W}" height="${height}" fill="${look.paper}"/>
<text x="${PAGE_W / 2}" y="72" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="52" fill="${INK}">${esc(script.headline || script.title)}</text>
${cells}
${footer}
</svg>`;
}

/** Explicit page geometry, without square crops, fixed title bands or stretched text. */
function composeDesignedPage(
  script: ComicScript,
  images: PanelImage[],
  layout?: Layout,
): string {
  const composition = resolveComposition(script)!;
  const h = Math.round(PAGE_W / aspectRatio(pageAspect(script)));
  const look = lookOf(script);
  const cells = composition.frames
    .map((frame, i) => {
      const x = frame.x * PAGE_W,
        y = frame.y * h,
        w = frame.w * PAGE_W,
        fh = frame.h * h;
      const shape = frame.clip
        ? `<polygon points="${frame.clip.map(([px, py]) => `${px * w},${py * fh}`).join(' ')}"`
        : `<rect width="${w}" height="${fh}"`;
      const art = images[i];
      const safe = frame.textBox ?? { x: 0, y: 0, w: 1, h: 1 };
      const sw = safe.w * w,
        sh = safe.h * fh;
      // Existing manual bubble coordinates still refer to the full panel, not its safe box.
      const placed = layout?.panels[i]?.map((p) =>
        p
          ? {
              x: (p.x - safe.x) / safe.w,
              y: (p.y - safe.y) / safe.h,
              ...(p.w ? { w: p.w / safe.w } : {}),
            }
          : null,
      );
      const words = panelBubbles(script.panels[i]!, placed, look, {
        w: sw,
        h: sh,
        size: 52,
      });
      return `<g data-panel="${i + 1}" transform="translate(${x} ${y})">
<clipPath id="design-${i}">${shape}/></clipPath>
<g clip-path="url(#design-${i})">${art ? `<image href="${dataUri(art)}" width="${w}" height="${fh}" preserveAspectRatio="xMidYMid slice"/>` : `<rect width="${w}" height="${fh}" fill="#EEE"/>`}
<g transform="translate(${safe.x * w} ${safe.y * fh})">${words}</g></g>
${frame.border === 'none' ? '' : `${shape} fill="none" stroke="${INK}" stroke-width="4"/>`}</g>`;
    })
    .join('\n');
  const title = visibleHeadline(script),
    box = titleBox(script);
  let heading = '';
  if (title && box) {
    const w = box.w * PAGE_W,
      bh = box.h * h;
    let size = 72,
      lines = wrap(title, w - 12, size);
    while (
      size > 32 &&
      (lines.length * size * 1.18 > bh || lines.some((line) => textWidth(line, size) > w))
    ) {
      size -= 2;
      lines = wrap(title, w - 12, size);
    }
    if (
      lines.length * size * 1.18 > bh ||
      lines.some((line) => textWidth(line, size) > w)
    )
      throw new Error(
        'The visible title does not fit its box. Enlarge it, shorten it or omit it.',
      );
    heading = lines
      .map(
        (line, i) =>
          `<text x="${(box.x + box.w / 2) * PAGE_W}" y="${box.y * h + (bh - lines.length * size * 1.18) / 2 + size * 0.9 + i * size * 1.18}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${INK}" stroke="#FFF" stroke-width="3" paint-order="stroke">${esc(line)}</text>`,
      )
      .join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${h + FOOTER_BAR}" viewBox="0 0 ${PAGE_W} ${h + FOOTER_BAR}">
<rect width="${PAGE_W}" height="${h + FOOTER_BAR}" fill="${look.paper}"/>
${cells}${heading}${footerBar(h, PAGE_W)}</svg>`;
}
