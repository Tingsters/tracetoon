/** Checks a comic script before any art is made. */
import { formatById, FORMATS } from './formats.ts';
import { STYLES, styleById, styleClash } from './styles.ts';
import {
  ASPECTS,
  BEATS,
  EXPRESSIONS,
  PALETTES,
  type ComicScript,
  type SeriesBible,
} from './types.ts';

/** Words per line in a v1 script (Tracetoon wraps them into bubbles). */
export const MAX_WORDS = 14;
/** Words per text item on a page: the model letters them, so keep them short. */
export const MAX_ITEM_WORDS = 12;
/** All the words on a page, headline included: it has to read on a phone. */
export const MAX_PAGE_WORDS = 50;
export const MAX_HEADLINE_WORDS = 6;

export interface ScriptProblem {
  where: string;
  problem: string;
  /** Warnings don't block; errors do. */
  severity?: 'error' | 'warning';
}

export interface CheckOpts {
  /** Style ids of the repo's latest comics, newest first. */
  recentStyles?: string[];
  /** A style the user pinned in config (always allowed, never a repeat). */
  pinnedStyle?: string;
  allowAnimalAnime?: boolean;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export const isPage = (s: Pick<ComicScript, 'v'>) => s.v === 2;

/** Every piece of text the model is asked to letter, in reading order. */
export function pageText(s: ComicScript): string[] {
  return [
    s.headline ?? s.title,
    ...s.panels.flatMap((p) => (p.dialogue ?? []).map((d) => d.text)),
  ].filter((t) => t?.trim());
}

export const errors = (ps: ScriptProblem[]) => ps.filter((p) => p.severity !== 'warning');

export function checkScript(
  script: unknown,
  bible: SeriesBible,
  opts: CheckOpts = {},
): ScriptProblem[] {
  const out: ScriptProblem[] = [];
  const bad = (where: string, problem: string) => out.push({ where, problem });
  const warn = (where: string, problem: string) =>
    out.push({ where, problem, severity: 'warning' });
  if (typeof script !== 'object' || script === null)
    return [{ where: 'comic.json', problem: 'is not a JSON object' }];
  const s = script as Partial<ComicScript>;
  const page = s.v === 2;
  if (s.v !== 1 && s.v !== 2) bad('v', 'must be 1 (4-koma) or 2 (page)');
  for (const key of ['title', 'synopsis', 'altText'] as const) {
    if (typeof s[key] !== 'string' || !s[key]!.trim()) bad(key, 'is required');
  }

  if (!page) {
    if (!Array.isArray(s.panels) || s.panels.length !== 4) {
      bad('panels', 'must have exactly 4 panels (setup, development, twist, resolution)');
      return out;
    }
  } else {
    const format = formatById(s.format);
    if (!format) bad('format', `must be one of ${FORMATS.map((f) => f.id).join(', ')}`);
    if (s.format === 'custom' && !s.layout?.trim())
      bad('layout', 'is required for a custom format: describe the page');
    if (!Array.isArray(s.panels) || s.panels.length < 1 || s.panels.length > 6) {
      bad('panels', 'must have 1 to 6 panels');
      return out;
    }
    if (
      format &&
      (s.panels.length < format.panels[0] || s.panels.length > format.panels[1])
    )
      warn(
        'panels',
        `${format.name} usually has ${format.panels[0]}–${format.panels[1]} panels; you have ${s.panels.length}`,
      );
    if (s.aspect && !ASPECTS.includes(s.aspect))
      bad('aspect', `must be one of ${ASPECTS.join(', ')}`);
    const style = styleById(s.style);
    if (!style) bad('style', `must be one of ${STYLES.map((x) => x.id).join(', ')}`);
    if (opts.pinnedStyle && s.style !== opts.pinnedStyle)
      bad('style', `this repo pins the style "${opts.pinnedStyle}" (config style)`);
    if (s.palette && !PALETTES.includes(s.palette))
      bad('palette', `must be one of ${PALETTES.join(', ')}`);
    if (style && s.palette && !style.palettes.includes(s.palette))
      warn('palette', `${style.name} is usually ${style.palettes.join(' or ')}`);
    const headline = s.headline ?? s.title ?? '';
    if (words(headline) > MAX_HEADLINE_WORDS)
      bad('headline', `has ${words(headline)} words; keep it to ${MAX_HEADLINE_WORDS}`);
    if (s.continuity && !['standalone', 'sequel', 'new-arc'].includes(s.continuity.mode))
      bad('continuity.mode', 'must be standalone, sequel or new-arc');
    if (s.continuity?.mode === 'sequel' && !s.continuity.of?.length)
      bad('continuity.of', 'a sequel names the PR numbers it follows');
    if (style) {
      const used = [
        ...new Set(s.panels.flatMap((p) => (p.characters ?? []).map((c) => c.cast))),
      ]
        .map((id) => bible.cast.find((c) => c.id === id))
        .filter((c): c is SeriesBible['cast'][number] => !!c);
      const clash = styleClash(style, used, { allowAnimalAnime: opts.allowAnimalAnime });
      if (clash && opts.pinnedStyle !== style.id) bad('style', clash);
      const recent = (opts.recentStyles ?? []).slice(0, 3);
      if (recent.includes(style.id) && opts.pinnedStyle !== style.id)
        warn(
          'style',
          `${style.name} was used in one of the last ${recent.length} comics; pick something fresh (or keep it for a sequel)`,
        );
    }
    const total = pageText(s as ComicScript).reduce((n, t) => n + words(t), 0);
    if (total > MAX_PAGE_WORDS)
      bad(
        'panels',
        `the page has ${total} words; keep it to ${MAX_PAGE_WORDS} so it reads on a phone`,
      );
  }

  const castIds = new Set(bible.cast.map((c) => c.id));
  const maxChars = page ? 4 : 3;
  const maxLines = page ? 4 : 3;
  const maxWords = page ? MAX_ITEM_WORDS : MAX_WORDS;
  (s.panels ?? []).forEach((p, i) => {
    const at = `panels[${i}]`;
    if (!page && p.beat !== BEATS[i]) bad(`${at}.beat`, `should be "${BEATS[i]}"`);
    if (page && p.beat && !BEATS.includes(p.beat))
      bad(`${at}.beat`, `must be one of ${BEATS.join(', ')} (or left out)`);
    if (!p.scene?.trim()) bad(`${at}.scene`, 'is required');
    if (!Array.isArray(p.characters)) bad(`${at}.characters`, 'must be a list');
    for (const [j, c] of (p.characters ?? []).entries()) {
      if (!castIds.has(c.cast))
        bad(
          `${at}.characters[${j}].cast`,
          `"${c.cast}" is not in the cast (${[...castIds].join(', ')})`,
        );
      if (!['left', 'center', 'right'].includes(c.position))
        bad(`${at}.characters[${j}].position`, 'must be left, center or right');
      if (c.expression && !EXPRESSIONS.includes(c.expression))
        bad(
          `${at}.characters[${j}].expression`,
          `must be one of ${EXPRESSIONS.join(', ')}`,
        );
    }
    if ((p.characters ?? []).length > maxChars)
      bad(`${at}.characters`, `at most ${maxChars} characters per panel`);
    if (!Array.isArray(p.dialogue)) bad(`${at}.dialogue`, 'must be a list');
    if ((p.dialogue ?? []).length > maxLines)
      bad(`${at}.dialogue`, `at most ${maxLines} lines per panel`);
    for (const [j, d] of (p.dialogue ?? []).entries()) {
      const w = `${at}.dialogue[${j}]`;
      const narration = d.speaker === 'caption' || d.kind === 'sfx' || d.kind === 'sign';
      if (!narration && !castIds.has(d.speaker))
        bad(`${w}.speaker`, `"${d.speaker}" is not in the cast`);
      if (d.kind && !['speech', 'thought', 'caption', 'sfx', 'sign'].includes(d.kind))
        bad(`${w}.kind`, 'must be speech, thought, caption, sfx or sign');
      if (!d.text?.trim()) bad(`${w}.text`, 'is empty');
      else if (words(d.text) > maxWords)
        bad(`${w}.text`, `has ${words(d.text)} words; keep it to ${maxWords}`);
      if (/https?:\/\/|@\w/.test(d.text ?? ''))
        bad(`${w}.text`, 'must not contain links or @mentions');
    }
  });
  return out;
}

/** A plain-text transcript of the comic for the PR body (accessibility). */
export function transcript(script: ComicScript, bible: SeriesBible): string {
  const name = (id: string) => bible.cast.find((c) => c.id === id)?.name ?? id;
  const head = script.v === 2 && script.headline ? `**${script.headline}**\n\n` : '';
  return (
    head +
    script.panels
      .map((p, i) => {
        const lines = p.dialogue.map((d) =>
          d.speaker === 'caption' || d.kind === 'caption'
            ? `*${d.text}*`
            : d.kind === 'sfx'
              ? `**${d.text}**`
              : d.kind === 'sign'
                ? `[${d.text}]`
                : `**${name(d.speaker)}:** ${d.text}`,
        );
        return `${i + 1}. ${p.scene}${lines.length ? '\n   ' + lines.join('\n   ') : ''}`;
      })
      .join('\n')
  );
}
