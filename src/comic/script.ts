/** Checks a comic script before any art is made. */
import { formatById, FORMATS } from './formats.ts';
import { styleById } from './styles.ts';
import {
  ASPECTS,
  BEATS,
  EXPRESSIONS,
  PALETTES,
  CAST_KINDS,
  DIALOGUE_KINDS,
  STYLE_FAMILIES,
  type ComicScript,
  type ComicSummary,
} from './types.ts';
import { comicSummary, compositionProblems, visibleHeadline } from './composition.ts';

/** Words per text item on a page: the model letters them, so keep them short. */
export const MAX_ITEM_WORDS = 12;
/** All the words on a page, headline included: it has to read on a phone. */
export const MAX_PAGE_WORDS = 50;
export const MAX_HEADLINE_WORDS = 6;
export const MAX_CHARACTERS = 6;
export const MAX_STYLE_CHARS = 120;
/** A label names one thing; anything longer is a caption. */
export const MAX_LABEL_WORDS = 4;
export const MAX_ANCHOR_TERMS = 4;

export interface ScriptProblem {
  where: string;
  problem: string;
  /** Warnings don't block; errors do. */
  severity?: 'error' | 'warning';
}

export interface CheckOpts {
  /** Styles of the repo's latest comics, newest first. */
  recentStyles?: string[];
  /** A style the user pinned in config (always allowed, never a repeat). */
  pinnedStyle?: string;
  recentComics?: ComicSummary[];
  /** The run's digest and diff, to notice anchor terms the PR never mentions. */
  evidenceText?: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Case, spacing and quote marks don't matter when matching a term to lettering. */
const loose = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Every piece of text the model is asked to letter, in reading order. */
export function pageText(s: ComicScript): string[] {
  return [
    visibleHeadline(s),
    ...s.panels.flatMap((p) => (p.dialogue ?? []).map((d) => d.text)),
  ].filter((t) => t?.trim());
}

export const errors = (ps: ScriptProblem[]) => ps.filter((p) => p.severity !== 'warning');

export function checkScript(script: unknown, opts: CheckOpts = {}): ScriptProblem[] {
  const out: ScriptProblem[] = [];
  const bad = (where: string, problem: string) => out.push({ where, problem });
  const warn = (where: string, problem: string) =>
    out.push({ where, problem, severity: 'warning' });
  if (typeof script !== 'object' || script === null)
    return [{ where: 'comic.json', problem: 'is not a JSON object' }];
  const s = script as Partial<ComicScript> & { v?: unknown };
  if (s.v !== 2)
    bad(
      'v',
      s.v === 1
        ? 'the fixed 4-panel format (v1) was removed; write a page ("v": 2) with its own characters'
        : 'must be 2',
    );
  for (const key of ['title', 'synopsis', 'altText'] as const) {
    if (typeof s[key] !== 'string' || !s[key]!.trim()) bad(key, 'is required');
  }

  const format = formatById(s.format);
  if (!format) bad('format', `must be one of ${FORMATS.map((f) => f.id).join(', ')}`);
  if (s.format === 'custom' && !s.layout?.trim() && !s.composition)
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
  out.push(...compositionProblems(s as ComicScript));
  if (s.styleFamily && !STYLE_FAMILIES.includes(s.styleFamily))
    bad('styleFamily', `must be ${STYLE_FAMILIES.join(', ')}`);
  if (s.headline !== undefined && typeof s.headline !== 'string')
    bad('headline', 'must be text');

  // Any art style: an idea by id, or the agent's own words.
  if (typeof s.style !== 'string' || !s.style.trim())
    bad('style', 'is required: a style idea id (see styles.md) or your own description');
  else if (s.style.length > MAX_STYLE_CHARS)
    bad('style', `keep it under ${MAX_STYLE_CHARS} characters`);
  else {
    if (opts.pinnedStyle && !same(s.style, opts.pinnedStyle))
      bad('style', `this repo pins the style "${opts.pinnedStyle}" (config style)`);
    const recent = (opts.recentStyles ?? []).slice(0, 3);
    if (!opts.pinnedStyle && recent.some((r) => same(r, s.style!)))
      warn(
        'style',
        `"${s.style}" was used in one of the last ${recent.length} comics; pick something fresh`,
      );
  }
  if (s.palette && !PALETTES.includes(s.palette))
    bad('palette', `must be one of ${PALETTES.join(', ')}`);
  const idea = styleById(s.style);
  if (idea && s.palette && !idea.palettes.includes(s.palette))
    warn('palette', `${idea.name} is usually ${idea.palettes.join(' or ')}`);
  const headline = visibleHeadline(s as ComicScript);
  if (words(headline) > MAX_HEADLINE_WORDS)
    bad('headline', `has ${words(headline)} words; keep it to ${MAX_HEADLINE_WORDS}`);

  // Characters are invented for this comic and described once.
  const names = new Set<string>();
  if (s.characters !== undefined && !Array.isArray(s.characters))
    bad('characters', 'must be a list of { name, description }');
  for (const [i, c] of (Array.isArray(s.characters) ? s.characters : []).entries()) {
    if (!c?.name?.trim()) bad(`characters[${i}].name`, 'is required');
    else if (names.has(c.name.toLowerCase()))
      bad(`characters[${i}].name`, `"${c.name}" is listed twice`);
    else names.add(c.name.toLowerCase());
    if (!c?.description?.trim())
      bad(`characters[${i}].description`, 'describe what this character looks like');
    if (c?.kind !== undefined && !CAST_KINDS.includes(c.kind))
      bad(`characters[${i}].kind`, `must be ${CAST_KINDS.join(', ')}`);
  }
  if (names.size > MAX_CHARACTERS)
    bad('characters', `at most ${MAX_CHARACTERS} characters per comic`);
  const listed = [...names].join(', ') || 'none listed';

  const total = pageText(s as ComicScript).reduce((n, t) => n + words(t), 0);
  if (total > MAX_PAGE_WORDS)
    bad(
      'panels',
      `the page has ${total} words; keep it to ${MAX_PAGE_WORDS} so it reads on a phone`,
    );

  s.panels.forEach((p, i) => {
    const at = `panels[${i}]`;
    if (p.beat && !BEATS.includes(p.beat))
      bad(`${at}.beat`, `must be one of ${BEATS.join(', ')} (or left out)`);
    if (!p.scene?.trim()) bad(`${at}.scene`, 'is required');
    if (!Array.isArray(p.characters)) bad(`${at}.characters`, 'must be a list');
    for (const [j, c] of (p.characters ?? []).entries()) {
      if (!c?.name || !names.has(c.name.toLowerCase()))
        bad(
          `${at}.characters[${j}].name`,
          `"${c?.name ?? ''}" isn't in this comic's characters (${listed})`,
        );
      if (!['left', 'center', 'right'].includes(c?.position))
        bad(`${at}.characters[${j}].position`, 'must be left, center or right');
      if (c?.expression && !EXPRESSIONS.includes(c.expression))
        bad(
          `${at}.characters[${j}].expression`,
          `must be one of ${EXPRESSIONS.join(', ')}`,
        );
    }
    if ((p.characters ?? []).length > 4)
      bad(`${at}.characters`, 'at most 4 characters per panel');
    if (!Array.isArray(p.dialogue)) bad(`${at}.dialogue`, 'must be a list');
    if ((p.dialogue ?? []).length > 4) bad(`${at}.dialogue`, 'at most 4 lines per panel');
    for (const [j, d] of (p.dialogue ?? []).entries()) {
      const w = `${at}.dialogue[${j}]`;
      const narration =
        d.speaker === 'caption' ||
        d.kind === 'sfx' ||
        d.kind === 'sign' ||
        d.kind === 'label';
      if (!narration && !names.has(String(d.speaker).toLowerCase()))
        bad(
          `${w}.speaker`,
          `"${d.speaker}" isn't in this comic's characters (${listed})`,
        );
      if (d.kind && !DIALOGUE_KINDS.includes(d.kind))
        bad(`${w}.kind`, `must be ${DIALOGUE_KINDS.join(', ')}`);
      if (d.points !== undefined && typeof d.points !== 'string')
        bad(`${w}.points`, 'must describe the drawn element the label points at');
      if (d.kind === 'label' && !d.points?.trim())
        bad(`${w}.points`, 'a label needs the drawn element it points at');
      if (!d.text?.trim()) bad(`${w}.text`, 'is empty');
      else if (d.kind === 'label' && words(d.text) > MAX_LABEL_WORDS)
        bad(
          `${w}.text`,
          `a label has ${words(d.text)} words; keep it to ${MAX_LABEL_WORDS} (use a caption for more)`,
        );
      else if (words(d.text) > MAX_ITEM_WORDS)
        bad(`${w}.text`, `has ${words(d.text)} words; keep it to ${MAX_ITEM_WORDS}`);
      if (/https?:\/\/|@\w/.test(d.text ?? ''))
        bad(`${w}.text`, 'must not contain links or @mentions');
    }
  });
  out.push(...anchorProblems(s as ComicScript, opts.evidenceText));
  if (!out.some((p) => p.severity !== 'warning')) {
    const current = comicSummary(s as ComicScript);
    const recent = (opts.recentComics ?? []).slice(0, 5);
    if (
      current.layoutFamily &&
      recent
        .slice(0, 3)
        .filter(
          (r) =>
            r.layoutFamily === current.layoutFamily &&
            r.panelCount === current.panelCount &&
            r.titleTreatment === current.titleTreatment,
        ).length >= 2
    )
      warn(
        'composition',
        'This layout, panel count and title treatment repeat recent comics. Consider a different concept; keep it if the story earns it.',
      );
    if (
      current.castKinds?.includes('creature') &&
      !current.castKinds.includes('human') &&
      recent.slice(0, 2).length === 2 &&
      recent
        .slice(0, 2)
        .every((r) => r.castKinds?.includes('creature') && !r.castKinds.includes('human'))
    )
      warn(
        'characters',
        'Recent comics already used creature-led casts. Consider people, objects or a characterless metaphor; keep creatures when they strengthen this gag.',
      );
    if (
      !opts.pinnedStyle &&
      current.styleFamily &&
      recent.slice(0, 3).filter((r) => r.styleFamily === current.styleFamily).length >= 2
    )
      warn(
        'styleFamily',
        'This broad art family repeats recent comics, even if the style name differs. Consider another visual treatment.',
      );
  }
  return out;
}

/**
 * The anchor ties the comic to the PR: a reviewer who reads only the comic
 * should be able to name the change. Required for composed (current) scripts;
 * legacy scripts without `composition` keep working.
 */
export function anchorProblems(s: ComicScript, evidenceText?: string): ScriptProblem[] {
  const out: ScriptProblem[] = [];
  const bad = (where: string, problem: string) => out.push({ where, problem });
  const warn = (where: string, problem: string) =>
    out.push({ where, problem, severity: 'warning' });
  const a = s.anchor as Partial<ComicScript['anchor'] & object> | undefined;
  if (a === undefined) {
    if (s.composition)
      bad(
        'anchor',
        'is required: the change in one sentence, 1–4 real terms from the PR, and what each drawn element stands for',
      );
    return out;
  }
  if (typeof a !== 'object' || a === null)
    return [{ where: 'anchor', problem: 'must be an object' }];
  if (typeof a.change !== 'string' || !a.change.trim())
    bad('anchor.change', 'state the concrete change in one sentence');
  const terms = Array.isArray(a.terms)
    ? a.terms.filter((t): t is string => typeof t === 'string' && !!t.trim())
    : [];
  if (!Array.isArray(a.terms) || terms.length !== a.terms.length || terms.length < 1)
    bad(
      'anchor.terms',
      'list 1–4 real names from the PR (command, flag, file, error, concept)',
    );
  else if (terms.length > MAX_ANCHOR_TERMS)
    bad(
      'anchor.terms',
      `at most ${MAX_ANCHOR_TERMS} terms; keep the ones the comic shows`,
    );
  const mapping = Array.isArray(a.mapping) ? a.mapping : undefined;
  if (!mapping || mapping.length < 1)
    bad('anchor.mapping', 'say which drawn element stands for which technical thing');
  else
    mapping.forEach((m, i) => {
      if (!m || typeof m.visual !== 'string' || !m.visual.trim())
        bad(`anchor.mapping[${i}].visual`, 'name the drawn element');
      if (!m || typeof m.technical !== 'string' || !m.technical.trim())
        bad(`anchor.mapping[${i}].technical`, 'name what it stands for in the PR');
    });
  if (!terms.length || !Array.isArray(s.panels)) return out;

  const visible = pageText(s).map(loose);
  if (!terms.some((t) => visible.some((v) => v.includes(loose(t)))))
    bad(
      'anchor.terms',
      `none of ${terms.map((t) => `"${t}"`).join(', ')} is lettered in the comic; add a label or sign so a reviewer can tie the picture to the PR`,
    );
  const labels = s.panels.flatMap((p) =>
    (p.dialogue ?? []).filter((d) => d.kind === 'label' || d.kind === 'sign'),
  );
  (mapping ?? []).forEach((m, i) => {
    if (!m?.visual || !m.technical) return;
    const v = loose(m.visual);
    const t = loose(m.technical);
    const labelled = labels.some(
      (d) =>
        (d.points && (loose(d.points).includes(v) || v.includes(loose(d.points)))) ||
        loose(d.text).includes(t) ||
        t.includes(loose(d.text)),
    );
    if (!labelled)
      warn(
        `anchor.mapping[${i}]`,
        `"${m.visual}" stands for "${m.technical}" but has no label; readers may miss the connection`,
      );
  });
  if (evidenceText) {
    const evidence = loose(evidenceText);
    for (const t of terms)
      if (!evidence.includes(loose(t)))
        warn(
          'anchor.terms',
          `"${t}" doesn't appear in this PR's digest or diff; use the names the change actually uses`,
        );
  }
  return out;
}

/** A plain-text transcript of the comic for the PR body (accessibility). */
export function transcript(script: ComicScript): string {
  const shown = script.composition ? visibleHeadline(script) : script.headline;
  const head = shown ? `**${shown}**\n\n` : '';
  return (
    head +
    script.panels
      .map((p, i) => {
        const lines = p.dialogue.map((d) =>
          d.kind === 'label'
            ? `[label${d.points ? ` → ${d.points}` : ''}: ${d.text}]`
            : d.speaker === 'caption' || d.kind === 'caption'
              ? `*${d.text}*`
              : d.kind === 'sfx'
                ? `**${d.text}**`
                : d.kind === 'sign'
                  ? `[${d.text}]`
                  : `**${d.speaker}:** ${d.text}`,
        );
        return `${i + 1}. ${p.scene}${lines.length ? '\n   ' + lines.join('\n   ') : ''}`;
      })
      .join('\n')
  );
}
