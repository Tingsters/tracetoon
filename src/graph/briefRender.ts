/**
 * What `render` does with the evidence brief:
 *
 * - writes the Validation section itself from the brief's validation rows, at
 *   the `<!-- tracetoon:validation -->` marker, so no writer restates (and
 *   rewords) run results;
 * - removes the writer's ref tags (`[CH1, S1]`) and reports sentences with no
 *   tag or an unknown ref, and run or test claims made outside that section.
 *
 * The checks are advisory; the text is deterministic.
 */
import type { Section } from './queries.ts';

export const VALIDATION_MARKER = '<!-- tracetoon:validation -->';

export interface BriefParts {
  sections: Section[];
  unchecked: string[];
}

export interface BriefApplied {
  text: string;
  /** The Validation section was written at the marker. */
  validation: boolean;
  /** Ref tags found and removed. */
  tags: number;
  unknownRefs: string[];
  /** Sentences that state something but carry no ref tag. */
  untagged: string[];
  /** Run, test or check claims outside the generated Validation section. */
  validationClaims: string[];
}

const rowsOf = (b: BriefParts, title: string) =>
  b.sections.find((s) => s.title === title)?.rows ?? [];

/** A command as run, without trailing output redirections. */
function shownCommand(cmd: unknown): string {
  return String(cmd ?? '')
    .replace(/(\s+(\d?>>?|&>)\s*(\/dev\/null|&\d)|\s+2>&1)+\s*$/g, '')
    .trim();
}

const plain = (s: unknown) => String(s ?? '').replace(/\*\*|__|`/g, '').trim();

const list = (xs: unknown) => {
  const a = (Array.isArray(xs) ? xs : []).map(String).filter(Boolean);
  return a.join(', ');
};

/** The Validation section, from the brief's validation rows only. */
export function validationSection(b: BriefParts): string {
  const lines: string[] = [];
  for (const r of rowsOf(b, 'validation')) {
    if (r.kind === 'commit message') {
      lines.push(
        `- The message of commit ${String(r.when).replace(/^not a run: commit (\S+) says so$/, '$1')} says: "${plain(r.cmd)}" (not a recorded run).`,
      );
      continue;
    }
    const outcome =
      r.outcome === 'passed' || r.outcome === 'failed'
        ? String(r.outcome)
        : 'outcome not recorded';
    const result = r.result ? ` (${plain(r.result)})` : '';
    const edited = list(r.editedAfter);
    const when =
      edited && String(r.when).startsWith('before later edits')
        ? `ran before later edits to ${edited}`
        : r.when
          ? `ran ${String(r.when)}`
          : '';
    lines.push(`- \`${shownCommand(r.cmd)}\`: ${outcome}${result}${when ? `; ${when}` : ''}.`);
  }
  if (b.unchecked.length)
    lines.push(
      `- No recorded passing test, build, lint or typecheck run after the last captured edit of ${b.unchecked.join(', ')}.`,
    );
  if (!lines.length)
    lines.push('- No test, build, lint or typecheck run was recorded in the captured sessions.');
  return [
    '## Validation',
    '',
    '<sub>Written by Tracetoon from the checks recorded in the session logs.</sub>',
    '',
    ...lines,
  ].join('\n');
}

/** Every ref a writer may cite. */
export function briefRefs(b: BriefParts): Set<string> {
  const out = new Set<string>();
  for (const s of b.sections)
    for (const r of s.rows)
      for (const k of ['change', 'ref', 'check'])
        if (typeof r[k] === 'string' && r[k]) out.add(r[k] as string);
  // `commit:<sha>` rows also answer to the short sha, and claim refs to `commit:<sha>#n`.
  for (const ref of [...out]) {
    const m = /^(?:commit:)?([0-9a-f]{7,40})(#\d+)?$/.exec(ref);
    if (m) {
      out.add(`commit:${m[1]}${m[2] ?? ''}`);
      out.add(`${m[1]}${m[2] ?? ''}`);
    }
  }
  return out;
}

const REF = String.raw`(?:[A-Z]{1,3}\d+|(?:commit:)?[0-9a-f]{7,40}(?:#\d+)?)`;
const TAG = new RegExp(String.raw`\s?\[(${REF}(?:\s*[,;]\s*${REF})*)\](?!\()`, 'g');

/** Run, test or check results stated in prose. */
const VALIDATION_CLAIM =
  /\b(\d+\s*(pass|passed|fail|failed|failures?)\b|tests? (pass|passed|fail|failed|ran|run)\b|(passed|passes|passing|failed|failing)\b|untested|not tested|exercised|typecheck(s|ed)?\b|no recorded run)/i;

/** Lines of prose: skips headings, code, HTML, tables and the generated section. */
function proseUnits(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line || /^(#|<|\||-{3,}|\*{3,})/.test(line)) continue;
    const body = line.replace(/^([-*+]|\d+[.)])\s+/, '');
    for (const s of body.split(/(?<=[.!?])\s+(?=[A-Z`"(])/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

/**
 * Removes ref tags, writes the Validation section at the marker, and reports
 * what the evidence brief doesn't back. Without a brief only the marker is
 * dropped.
 */
export function applyBrief(body: string, b: BriefParts | undefined): BriefApplied {
  if (!b)
    return {
      text: body.replace(`${VALIDATION_MARKER}\n`, '').replace(VALIDATION_MARKER, ''),
      validation: false,
      tags: 0,
      unknownRefs: [],
      untagged: [],
      validationClaims: [],
    };
  const known = briefRefs(b);
  const unknown = new Set<string>();
  let tags = 0;
  const untagged: string[] = [];
  const validationClaims: string[] = [];
  for (const unit of proseUnits(body)) {
    const found = [...unit.matchAll(TAG)];
    const clean = unit.replace(TAG, '').trim();
    if (VALIDATION_CLAIM.test(clean)) validationClaims.push(clean);
    if (!found.length) {
      // Short labels and lead-ins ("Changes:", "Start here") state nothing.
      if (clean.split(/\s+/).length >= 5 && !clean.endsWith(':')) untagged.push(clean);
      continue;
    }
    for (const m of found)
      for (const ref of m[1]!.split(/\s*[,;]\s*/)) {
        tags++;
        if (!known.has(ref)) unknown.add(ref);
      }
  }
  let text = body.replace(TAG, '');
  const validation = text.includes(VALIDATION_MARKER);
  if (validation) text = text.replace(VALIDATION_MARKER, validationSection(b));
  return {
    text,
    validation,
    tags,
    unknownRefs: [...unknown].sort(),
    untagged,
    validationClaims,
  };
}
