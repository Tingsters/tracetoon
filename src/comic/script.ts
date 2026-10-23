/** Checks a comic script before any art is made. */
import { BEATS, EXPRESSIONS, type ComicScript, type SeriesBible } from './types.ts';

export const MAX_WORDS = 14;

export interface ScriptProblem {
  where: string;
  problem: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function checkScript(script: unknown, bible: SeriesBible): ScriptProblem[] {
  const out: ScriptProblem[] = [];
  const bad = (where: string, problem: string) => out.push({ where, problem });
  if (typeof script !== 'object' || script === null)
    return [{ where: 'comic.json', problem: 'is not a JSON object' }];
  const s = script as Partial<ComicScript>;
  for (const key of ['title', 'synopsis', 'altText'] as const) {
    if (typeof s[key] !== 'string' || !s[key]!.trim()) bad(key, 'is required');
  }
  if (!Array.isArray(s.panels) || s.panels.length !== 4) {
    bad('panels', 'must have exactly 4 panels (setup, development, twist, resolution)');
    return out;
  }
  const castIds = new Set(bible.cast.map((c) => c.id));
  s.panels.forEach((p, i) => {
    const at = `panels[${i}]`;
    if (p.beat !== BEATS[i]) bad(`${at}.beat`, `should be "${BEATS[i]}"`);
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
    if ((p.characters ?? []).length > 3)
      bad(`${at}.characters`, 'at most 3 characters per panel');
    if (!Array.isArray(p.dialogue)) bad(`${at}.dialogue`, 'must be a list');
    if ((p.dialogue ?? []).length > 3) bad(`${at}.dialogue`, 'at most 3 lines per panel');
    for (const [j, d] of (p.dialogue ?? []).entries()) {
      const w = `${at}.dialogue[${j}]`;
      if (d.speaker !== 'caption' && d.kind !== 'sfx' && !castIds.has(d.speaker))
        bad(`${w}.speaker`, `"${d.speaker}" is not in the cast`);
      if (!d.text?.trim()) bad(`${w}.text`, 'is empty');
      else if (words(d.text) > MAX_WORDS)
        bad(`${w}.text`, `has ${words(d.text)} words; keep it to ${MAX_WORDS}`);
      if (/https?:\/\/|@\w/.test(d.text ?? ''))
        bad(`${w}.text`, 'must not contain links or @mentions');
    }
  });
  return out;
}

/** A plain-text transcript of the comic for the PR body (accessibility). */
export function transcript(script: ComicScript, bible: SeriesBible): string {
  const name = (id: string) => bible.cast.find((c) => c.id === id)?.name ?? id;
  return script.panels
    .map((p, i) => {
      const lines = p.dialogue.map((d) =>
        d.speaker === 'caption' || d.kind === 'caption'
          ? `*${d.text}*`
          : d.kind === 'sfx'
            ? `**${d.text}**`
            : `**${name(d.speaker)}:** ${d.text}`,
      );
      return `${i + 1}. ${p.scene}${lines.length ? '\n   ' + lines.join('\n   ') : ''}`;
    })
    .join('\n');
}
