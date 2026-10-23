/**
 * The built-in artist: draws a panel as SVG with no image model at all. Chibi
 * characters with expressions, on a background for each theme. The top ~30% is
 * kept clear for speech bubbles. Used when no image generation is available.
 */
import type { CastMember, Expression, Panel, SeriesBible, Theme } from './types.ts';

export const PANEL = 800;
const SKIN = '#F5D0B5';
const INK = '#2B2B33';

/** Small deterministic random numbers, so a panel always draws the same way. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function background(theme: Theme, index: number, beat: Panel['beat']): string {
  const r = rng(index * 7919 + theme.length * 31);
  let bg = '';
  if (theme === 'pets') {
    bg = `<defs><linearGradient id="wall${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF6E9"/><stop offset="1" stop-color="#FCE3C8"/></linearGradient></defs>
<rect width="800" height="800" fill="url(#wall${index})"/>
<rect x="470" y="70" width="250" height="190" rx="14" fill="#BFE3F5" stroke="#E9C9A5" stroke-width="12"/>
<line x1="595" y1="70" x2="595" y2="260" stroke="#E9C9A5" stroke-width="8"/>
<circle cx="${520 + r() * 60}" cy="${120 + r() * 30}" r="22" fill="#FFF" opacity="0.9"/>
<rect x="0" y="610" width="800" height="190" fill="#E4B98E"/>
<rect x="0" y="600" width="800" height="14" fill="#D19C6B"/>
<rect x="60" y="520" width="220" height="16" rx="6" fill="#B07A4F"/><rect x="95" y="455" width="110" height="68" rx="8" fill="#5A6170"/><rect x="104" y="463" width="92" height="50" rx="4" fill="#9FD3E8"/>
<circle cx="700" cy="560" r="34" fill="#7FB77E"/><rect x="684" y="560" width="32" height="44" rx="6" fill="#C9734B"/>`;
  } else if (theme === 'mecha') {
    let grid = '';
    for (let x = 0; x <= 800; x += 80)
      grid += `<line x1="${x}" y1="0" x2="${x}" y2="800" stroke="#2F4466" stroke-width="2"/>`;
    for (let y = 0; y <= 800; y += 80)
      grid += `<line x1="0" y1="${y}" x2="800" y2="${y}" stroke="#2F4466" stroke-width="2"/>`;
    let stripes = '';
    for (let x = -40; x < 800; x += 60)
      stripes += `<polygon points="${x},640 ${x + 30},640 ${x + 60},610 ${x + 30},610" fill="#F2C14E"/>`;
    bg = `<defs><linearGradient id="hang${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16233A"/><stop offset="1" stop-color="#26385A"/></linearGradient></defs>
<rect width="800" height="800" fill="url(#hang${index})"/>${grid}
<rect x="0" y="610" width="800" height="30" fill="#1B1B22"/>${stripes}
<rect x="0" y="640" width="800" height="160" fill="#3A4660"/>
<circle cx="140" cy="60" r="40" fill="#FFF4C2" opacity="0.35"/><circle cx="660" cy="60" r="40" fill="#FFF4C2" opacity="0.35"/>`;
  } else {
    let stars = '';
    for (let i = 0; i < 70; i++)
      stars += `<circle cx="${(r() * 800).toFixed(0)}" cy="${(r() * 560).toFixed(0)}" r="${(r() * 2.6 + 0.6).toFixed(1)}" fill="#FFF" opacity="${(0.4 + r() * 0.6).toFixed(2)}"/>`;
    bg = `<defs><radialGradient id="space${index}" cx="0.7" cy="0.2" r="0.9"><stop offset="0" stop-color="#3A2F7A"/><stop offset="1" stop-color="#0C1230"/></radialGradient></defs>
<rect width="800" height="800" fill="url(#space${index})"/>${stars}
<circle cx="${600 + r() * 80}" cy="${150 + r() * 60}" r="70" fill="#E07A5F" opacity="0.85"/><ellipse cx="640" cy="180" rx="120" ry="18" fill="none" stroke="#F2CC8F" stroke-width="6" opacity="0.7"/>
<path d="M0,620 Q400,560 800,620 L800,800 L0,800 Z" fill="#232B4D"/>
<rect x="80" y="640" width="640" height="40" rx="16" fill="#2F3B66"/>
<rect x="110" y="650" width="90" height="18" rx="6" fill="#5EEAD4" opacity="0.8"/><rect x="230" y="650" width="60" height="18" rx="6" fill="#F472B6" opacity="0.8"/><rect x="560" y="650" width="120" height="18" rx="6" fill="#FBBF24" opacity="0.7"/>`;
  }
  if (beat === 'ten') {
    // The twist: emphasis lines radiating from the centre.
    let lines = '';
    for (let a = 0; a < 360; a += 12) {
      const rad = (a * Math.PI) / 180;
      lines += `<line x1="${400 + Math.cos(rad) * 300}" y1="${430 + Math.sin(rad) * 300}" x2="${400 + Math.cos(rad) * 700}" y2="${430 + Math.sin(rad) * 700}" stroke="${theme === 'pets' ? '#C98B5A' : '#FFFFFF'}" stroke-width="5" opacity="0.25"/>`;
    }
    bg += lines;
  }
  return bg;
}

/** Eyes, brows, mouth and blush for an expression, centred on (0,0) at head scale 1. */
function face(expr: Expression, eyeColor = INK, glow = false): string {
  const e = (x: number) => {
    switch (expr) {
      case 'happy':
      case 'proud':
        return `<path d="M${x - 12},4 Q${x},-10 ${x + 12},4" stroke="${eyeColor}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
      case 'sleepy':
        return `<path d="M${x - 12},2 L${x + 12},2" stroke="${eyeColor}" stroke-width="5" stroke-linecap="round"/>`;
      case 'surprised':
      case 'excited':
        return `<circle cx="${x}" cy="0" r="12" fill="${eyeColor}"/><circle cx="${x + 4}" cy="-4" r="4" fill="#FFF"/>${expr === 'excited' ? `<circle cx="${x - 4}" cy="4" r="2" fill="#FFF"/>` : ''}`;
      case 'thinking':
        return `<ellipse cx="${x + 3}" cy="-2" rx="7" ry="10" fill="${eyeColor}"/><circle cx="${x + 6}" cy="-6" r="3" fill="#FFF"/>`;
      default:
        return `<ellipse cx="${x}" cy="0" rx="8" ry="11" fill="${eyeColor}"/><circle cx="${x + 3}" cy="-4" r="3" fill="#FFF"/>`;
    }
  };
  const brows: Partial<Record<Expression, string>> = {
    worried: `<path d="M-38,-18 L-14,-30 M38,-18 L14,-30" stroke="${eyeColor}" stroke-width="4" stroke-linecap="round"/>`,
    determined: `<path d="M-38,-30 L-12,-20 M38,-30 L12,-20" stroke="${eyeColor}" stroke-width="5" stroke-linecap="round"/>`,
    angry: `<path d="M-38,-32 L-10,-18 M38,-32 L10,-18" stroke="${eyeColor}" stroke-width="6" stroke-linecap="round"/>`,
  };
  const mouths: Record<Expression, string> = {
    happy: 'M-14,22 Q0,36 14,22',
    proud: 'M-16,22 Q0,38 16,22',
    excited: 'M-16,20 Q0,44 16,20 Z',
    surprised: '',
    worried: 'M-12,30 Q0,22 12,30',
    determined: 'M-12,26 L12,26',
    thinking: 'M-6,28 L10,24',
    sleepy: 'M-8,26 Q0,30 8,26',
    angry: 'M-14,32 Q0,20 14,32',
  };
  const mouth =
    expr === 'surprised'
      ? `<ellipse cx="0" cy="28" rx="9" ry="11" fill="${eyeColor}"/>`
      : `<path d="${mouths[expr]}" stroke="${eyeColor}" stroke-width="4.5" fill="${expr === 'excited' ? '#E8576B' : 'none'}" stroke-linecap="round"/>`;
  const blush =
    ['happy', 'proud', 'excited'].includes(expr) && !glow
      ? `<ellipse cx="-36" cy="16" rx="11" ry="6" fill="#F497A8" opacity="0.7"/><ellipse cx="36" cy="16" rx="11" ry="6" fill="#F497A8" opacity="0.7"/>`
      : '';
  const extra =
    expr === 'thinking'
      ? `<circle cx="70" cy="-70" r="7" fill="#FFF" stroke="${INK}" stroke-width="3"/><circle cx="90" cy="-96" r="11" fill="#FFF" stroke="${INK}" stroke-width="3"/>`
      : '';
  return `${brows[expr] ?? ''}${e(-26)}${e(26)}${mouth}${blush}${extra}`;
}

const stroke = `stroke="${INK}" stroke-width="5" stroke-linejoin="round"`;

/** One character standing at (x, baseline), scaled. Head is ~120px at scale 1. */
function character(
  c: CastMember,
  expr: Expression,
  x: number,
  base: number,
  s: number,
  facing: 1 | -1,
): string {
  const [main = '#999', light = '#EEE', dark = '#444'] = c.palette;
  const headY = -175;
  let body = `<ellipse cx="0" cy="-55" rx="52" ry="60" fill="${main}" ${stroke}/><ellipse cx="0" cy="-45" rx="30" ry="36" fill="${light}"/>`;
  let head = `<circle cx="0" cy="${headY}" r="70" fill="${main}" ${stroke}/>`;
  let behind = '';
  let front = '';
  let faceSvg = `<g transform="translate(0 ${headY + 8})">${face(expr)}</g>`;
  const muzzle = `<ellipse cx="0" cy="${headY + 30}" rx="34" ry="22" fill="${light}"/><ellipse cx="0" cy="${headY + 18}" rx="8" ry="6" fill="${INK}"/>`;
  let float = 0;
  switch (c.species) {
    case 'fox':
      behind = `<path d="M40,-40 Q140,-60 120,-160 Q100,-90 30,-80 Z" fill="${main}" ${stroke}/><path d="M118,-150 Q125,-170 120,-160" fill="${light}"/>`;
      head += `<polygon points="-62,${headY - 30} -40,${headY - 110} -12,${headY - 60}" fill="${main}" ${stroke}/><polygon points="62,${headY - 30} 40,${headY - 110} 12,${headY - 60}" fill="${main}" ${stroke}/><polygon points="-50,${headY - 42} -40,${headY - 88} -24,${headY - 60}" fill="${light}"/><polygon points="50,${headY - 42} 40,${headY - 88} 24,${headY - 60}" fill="${light}"/>${muzzle}`;
      front = `<path d="M-40,-92 Q0,-70 40,-92 L34,-80 Q0,-62 -34,-80 Z" fill="${dark}"/>`;
      break;
    case 'cat':
      behind = `<path d="M40,-30 Q120,-20 110,-120" fill="none" stroke="${INK}" stroke-width="20" stroke-linecap="round"/><path d="M40,-30 Q120,-20 110,-120" fill="none" stroke="${main}" stroke-width="11" stroke-linecap="round"/>`;
      head += `<polygon points="-60,${headY - 25} -50,${headY - 95} -15,${headY - 62}" fill="${main}" ${stroke}/><polygon points="60,${headY - 25} 50,${headY - 95} 15,${headY - 62}" fill="${main}" ${stroke}/>${muzzle}<path d="M-30,${headY + 30} L-80,${headY + 22} M-30,${headY + 38} L-80,${headY + 42} M30,${headY + 30} L80,${headY + 22} M30,${headY + 38} L80,${headY + 42}" stroke="${INK}" stroke-width="3"/>`;
      front = `<path d="M-46,-118 Q0,-100 46,-118" stroke="${dark}" stroke-width="10" fill="none"/><circle cx="58" cy="${headY + 5}" r="14" fill="${dark}"/>`;
      break;
    case 'otter':
    case 'dog':
      head +=
        c.species === 'otter'
          ? `<circle cx="-56" cy="${headY - 46}" r="18" fill="${main}" ${stroke}/><circle cx="56" cy="${headY - 46}" r="18" fill="${main}" ${stroke}/>${muzzle}`
          : `<ellipse cx="-70" cy="${headY + 5}" rx="22" ry="48" fill="${dark}" ${stroke}/><ellipse cx="70" cy="${headY + 5}" rx="22" ry="48" fill="${dark}" ${stroke}/>${muzzle}`;
      if (c.species === 'otter') {
        float = 30;
        front = `<circle cx="0" cy="-100" r="12" fill="${c.palette[2] ?? '#3BB273'}" ${stroke}/>`;
      }
      break;
    case 'human':
      head = `<circle cx="0" cy="${headY}" r="66" fill="${SKIN}" ${stroke}/><path d="M-70,${headY} Q-72,${headY - 90} 0,${headY - 82} Q72,${headY - 90} 70,${headY} Q50,${headY - 50} 10,${headY - 56} Q-30,${headY - 40} -70,${headY} Z" fill="${dark}" ${stroke}/>`;
      body = `<path d="M-60,0 L-54,-90 Q0,-125 54,-90 L60,0 Z" fill="${main}" ${stroke}/><path d="M-18,-108 L0,-80 L18,-108" fill="none" stroke="${light}" stroke-width="5"/>`;
      front = `<path d="M-64,${headY + 10} Q-64,${headY - 70} 0,${headY - 70} Q64,${headY - 70} 64,${headY + 10}" fill="none" stroke="${INK}" stroke-width="7"/><rect x="-74" y="${headY - 5}" width="16" height="30" rx="6" fill="${INK}"/><rect x="58" y="${headY - 5}" width="16" height="30" rx="6" fill="${INK}"/>`;
      break;
    case 'beetle':
      s *= 0.6;
      body = `<ellipse cx="0" cy="-60" rx="70" ry="58" fill="${main}" ${stroke}/><line x1="0" y1="-118" x2="0" y2="-2" stroke="${INK}" stroke-width="4"/><circle cx="-30" cy="-70" r="10" fill="${dark}"/><circle cx="30" cy="-50" r="12" fill="${dark}"/><circle cx="-20" cy="-30" r="8" fill="${dark}"/>`;
      head = `<circle cx="0" cy="-140" r="44" fill="${dark}" ${stroke}/><path d="M-16,-176 Q-40,-220 -60,-210 M16,-176 Q40,-220 60,-210" stroke="${INK}" stroke-width="5" fill="none"/>`;
      faceSvg = `<g transform="translate(0 -140) scale(0.6)">${face(expr, '#FFFFFF', true)}</g>`;
      break;
    case 'mecha':
      body = `<path d="M-64,0 L-70,-100 L70,-100 L64,0 Z" fill="${main}" ${stroke}/><circle cx="0" cy="-58" r="18" fill="${light}" ${stroke}/><rect x="-96" y="-100" width="30" height="60" rx="10" fill="${dark}" ${stroke}/><rect x="66" y="-100" width="30" height="60" rx="10" fill="${dark}" ${stroke}/>`;
      head = `<rect x="-66" y="${headY - 62}" width="132" height="118" rx="30" fill="${main}" ${stroke}/><polygon points="-56,${headY - 50} -46,${headY - 120} -20,${headY - 62}" fill="${light}" ${stroke}/><polygon points="56,${headY - 50} 46,${headY - 120} 20,${headY - 62}" fill="${light}" ${stroke}/><rect x="-54" y="${headY - 22}" width="108" height="46" rx="18" fill="${dark}"/>`;
      faceSvg = `<g transform="translate(0 ${headY}) scale(0.8)">${face(expr, light, true)}</g>`;
      break;
    case 'drone':
      float = 120;
      body = '';
      head = `<line x1="-110" y1="${headY - 40}" x2="110" y2="${headY - 40}" stroke="${INK}" stroke-width="8"/><ellipse cx="-110" cy="${headY - 52}" rx="44" ry="10" fill="${light}" ${stroke}/><ellipse cx="110" cy="${headY - 52}" rx="44" ry="10" fill="${light}" ${stroke}/><circle cx="0" cy="${headY}" r="70" fill="${main}" ${stroke}/><circle cx="0" cy="${headY}" r="40" fill="${dark}"/>`;
      faceSvg = `<g transform="translate(0 ${headY + 4}) scale(0.7)">${face(expr, '#7CF29C', true)}</g>`;
      break;
    case 'robot':
      body = `<rect x="-56" y="-110" width="112" height="110" rx="24" fill="${dark}" ${stroke}/><rect x="-30" y="-86" width="60" height="30" rx="8" fill="${main}"/>`;
      head = `<line x1="0" y1="${headY - 70}" x2="0" y2="${headY - 110}" stroke="${INK}" stroke-width="6"/><circle cx="0" cy="${headY - 116}" r="12" fill="${main}" ${stroke}/><rect x="-72" y="${headY - 70}" width="144" height="128" rx="34" fill="${light}" ${stroke}/><rect x="-56" y="${headY - 52}" width="112" height="92" rx="22" fill="${INK}"/>`;
      faceSvg = `<g transform="translate(0 ${headY - 4}) scale(0.8)">${face(expr, main, true)}</g>`;
      break;
    case 'kaiju':
      s *= 0.75;
      body = `<path d="M-80,0 Q-90,-120 0,-130 Q90,-120 80,0 Z" fill="${main}" ${stroke}/>`;
      head = `<circle cx="0" cy="${headY + 10}" r="72" fill="${main}" ${stroke}/>${[-50, -20, 10, 40].map((dx) => `<polygon points="${dx - 14},${headY - 50} ${dx},${headY - 92} ${dx + 14},${headY - 50}" fill="${dark}" ${stroke}/>`).join('')}`;
      break;
    case 'alien':
      float = 40;
      head = `<ellipse cx="0" cy="${headY - 10}" rx="66" ry="84" fill="${main}" ${stroke}/><path d="M-26,${headY - 90} Q-40,${headY - 140} -54,${headY - 136} M26,${headY - 90} Q40,${headY - 140} 54,${headY - 136}" stroke="${INK}" stroke-width="5" fill="none"/><circle cx="-54" cy="${headY - 136}" r="9" fill="${light}" ${stroke}/><circle cx="54" cy="${headY - 136}" r="9" fill="${light}" ${stroke}/>`;
      break;
  }
  const shadow = `<ellipse cx="${x}" cy="${base + 6}" rx="${70 * s}" ry="${14 * s}" fill="#000" opacity="0.18"/>`;
  return `${shadow}<g transform="translate(${x} ${base - float * s}) scale(${s * facing} ${s})">${behind}${body}${head}${faceSvg}${front}</g>`;
}

const XPOS = { left: 200, center: 400, right: 600 } as const;

/** Draw one panel as a standalone SVG document. */
export function panelSvg(panel: Panel, bible: SeriesBible, index: number): string {
  const crowd = panel.characters.length >= 3 ? 0.88 : 1;
  const scale =
    (panel.camera === 'close' ? 1.45 : panel.camera === 'wide' ? 0.8 : 1.1) * crowd;
  const base = panel.camera === 'close' ? 790 : 740;
  const chars = panel.characters
    .map((pc) => {
      const c = bible.cast.find((m) => m.id === pc.cast);
      if (!c) return '';
      const x =
        panel.characters.length === 1 &&
        pc.position !== 'center' &&
        panel.camera === 'close'
          ? 400
          : XPOS[pc.position];
      const facing: 1 | -1 = pc.position === 'right' ? -1 : 1;
      return character(c, pc.expression ?? 'happy', x, base, scale, facing);
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL}" height="${PANEL}" viewBox="0 0 ${PANEL} ${PANEL}">${background(bible.theme, index, panel.beat)}${chars}</svg>`;
}

/** A head-and-shoulders portrait, used as the cast sheet in previews. */
export function portraitSvg(c: CastMember, theme: Theme): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 800 800">${background(theme, 99, 'ki')}${character(c, 'happy', 400, 860, 1.6, 1)}</svg>`;
}
