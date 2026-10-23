/**
 * Lays out the 2×2 comic page: four panel images, speech bubbles, a title band
 * and a footer. Art is always made without text; all words are drawn here, so
 * they stay legible whatever made the art.
 */
import type { ComicScript, Dialogue, Panel, SeriesBible } from './types.ts';

export const PAGE_W = 1600;
const MARGIN = 30;
const GUTTER = 24;
const TITLE_H = 110;
const FOOTER_H = 48;
export const CELL = (PAGE_W - 2 * MARGIN - GUTTER) / 2; // 758
export const PAGE_H = TITLE_H + MARGIN + 2 * CELL + GUTTER + FOOTER_H + MARGIN;
const SRC = 800; // panel art coordinate space
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

function speakerX(panel: Panel, speaker: string): number | undefined {
  const c = panel.characters.find((pc) => pc.cast === speaker);
  return c ? XPOS[c.position] : undefined;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function bubble(
  d: Dialogue,
  box: Box,
  lines: string[],
  size: number,
  tailTo?: number,
): string {
  const kind = d.speaker === 'caption' ? 'caption' : (d.kind ?? 'speech');
  const lh = size * 1.18;
  const textX = box.x + box.w / 2;
  const textY = box.y + (box.h - lines.length * lh) / 2 + size * 0.88;
  const text = lines
    .map(
      (l, i) =>
        `<text x="${textX}" y="${textY + i * lh}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${INK}">${esc(l)}</text>`,
    )
    .join('');
  if (kind === 'caption') {
    return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#FFF3B0" stroke="${INK}" stroke-width="4"/>${text}`;
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

function sfx(d: Dialogue, i: number): string {
  const x = 400 + (i % 2 ? 120 : -120);
  return `<text x="${x}" y="360" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="84" fill="#F25F5C" stroke="#FFFFFF" stroke-width="10" paint-order="stroke" transform="rotate(-9 ${x} 360)">${esc(d.text)}</text>`;
}

/** Bubbles for one panel, in the panel's own 800×800 space. */
export function panelBubbles(
  panel: Panel,
  placed?: ({ x: number; y: number; w?: number } | null)[],
): string {
  const size = 30;
  const boxes: Box[] = [];
  /**
   * The highest free spot for a bubble. Two bubbles may share a row only if the
   * new one sits to the right of the earlier ones, so reading order stays
   * left-to-right, top-to-bottom; otherwise it goes below, clear of their tails.
   */
  const place = (x: number, w: number, h: number): number => {
    for (let y = 22; y < 420; y += 6) {
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
      if (d.kind === 'sfx') return sfx(d, i);
      const isCaption = d.speaker === 'caption' || d.kind === 'caption';
      const manual = placed?.[i];
      const maxW = manual?.w ? manual.w * SRC - 44 : isCaption ? 520 : 330;
      const lines = wrap(d.text, maxW, size);
      const w = Math.min(maxW, Math.max(...lines.map((l) => textWidth(l, size)))) + 44;
      const h = lines.length * size * 1.18 + 30;
      const sx = speakerX(panel, d.speaker);
      let x: number;
      let y: number;
      if (manual) {
        x = manual.x * SRC;
        y = manual.y * SRC;
      } else {
        if (isCaption) x = 18;
        else if (sx === undefined) x = (SRC - w) / 2;
        else x = Math.min(Math.max(sx - w / 2, 18), SRC - w - 18);
        y = place(x, w, h);
      }
      const box = { x, y, w, h };
      boxes.push(box);
      return bubble(d, box, lines, size, isCaption ? undefined : sx);
    })
    .join('');
}

function dataUri(img: PanelImage): string {
  return `data:${img.mime};base64,${Buffer.from(img.data).toString('base64')}`;
}

export interface PageInfo {
  episode?: number;
}

/** The full page as SVG. */
export function composePage(
  script: ComicScript,
  bible: SeriesBible,
  images: PanelImage[],
  info: PageInfo = {},
  layout?: Layout,
): string {
  const k = CELL / SRC;
  const cells = script.panels
    .map((panel, i) => {
      const px = MARGIN + (i % 2) * (CELL + GUTTER);
      const py = TITLE_H + MARGIN + Math.floor(i / 2) * (CELL + GUTTER);
      const img = images[i];
      return `<g transform="translate(${px} ${py})">
<clipPath id="c${i}"><rect width="${CELL}" height="${CELL}" rx="10"/></clipPath>
<g clip-path="url(#c${i})">${img ? `<image href="${dataUri(img)}" width="${CELL}" height="${CELL}" preserveAspectRatio="xMidYMid slice"/>` : `<rect width="${CELL}" height="${CELL}" fill="#EEE"/>`}
<g transform="scale(${k})">${panelBubbles(panel, layout?.panels[i])}</g></g>
<rect width="${CELL}" height="${CELL}" rx="10" fill="none" stroke="${INK}" stroke-width="6"/>
<circle cx="30" cy="${CELL - 30}" r="18" fill="${INK}"/><text x="30" y="${CELL - 21}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="24" fill="#FFF">${i + 1}</text>
</g>`;
    })
    .join('\n');
  const ep = info.episode ? `Ep. ${info.episode} · ` : '';
  const footY = PAGE_H - MARGIN - 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">
<rect width="${PAGE_W}" height="${PAGE_H}" fill="#FFFDF7"/>
<text x="${PAGE_W / 2}" y="72" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="52" fill="${INK}">${esc(script.title)}</text>
${cells}
<text x="${MARGIN}" y="${footY}" font-family="${FONT}" font-weight="700" font-size="26" fill="#6B6B78">${esc(
    `${bible.title} · ${ep}${bible.cast
      .filter((c) =>
        script.panels.some((p) => p.characters.some((pc) => pc.cast === c.id)),
      )
      .map((c) => c.name)
      .join(', ')}`,
  )}</text>
<text x="${PAGE_W - MARGIN}" y="${footY}" text-anchor="end" font-family="${FONT}" font-size="22" fill="#8A8A96">made with Tracetoon</text>
</svg>`;
}
