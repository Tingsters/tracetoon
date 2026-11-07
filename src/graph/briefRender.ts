/**
 * What `render` does with the evidence brief:
 *
 * - writes the Validation section itself from the brief's validation rows, at
 *   the `<!-- tracetoon:validation -->` marker, so no writer restates (and
 *   rewords) run results;
 * - removes the writer's ref tags (`[CH1, S1]`) and reports sentences with no
 *   tag or an unknown ref, tagged sentences naming code their refs don't
 *   mention, and run or test claims made outside that section.
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
  /** Tagged sentences that name code (`fn`, a type, a file) no cited row mentions. */
  unbackedNames: { sentence: string; names: string[] }[];
}

const rowsOf = (b: BriefParts, title: string) =>
  b.sections.find((s) => s.title === title)?.rows ?? [];

/** A command as run, without output redirections (files, /dev/null, redacted paths). */
export function shownCommand(cmd: unknown): string {
  return String(cmd ?? '')
    .replace(/\s+(\d?>>?|&>)\s*(&\d|<[^>\s]+>|"[^"]*"|'[^']*'|[^\s;|&]+)/g, '')
    .replace(/\s+([;|&]{1,2})\s*/g, ' $1 ')
    .trim();
}

const plain = (s: unknown) =>
  String(s ?? '')
    .replace(/\*\*|__|`/g, '')
    .trim()
    .replace(/[.!]+$/, '');

const list = (xs: unknown) => {
  const a = (Array.isArray(xs) ? xs : []).map(String).filter(Boolean);
  const more = /^\+(\d+) more$/.exec(a.at(-1) ?? '');
  return more ? `${a.slice(0, -1).join(', ')} and ${more[1]} more` : a.join(', ');
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
    // Only what the logs establish: the result as recorded, and edits seen
    // after the run. A run with no later edit in the logs may still predate
    // the final code (later commits, edits outside the logs), so say so.
    const recorded = r.outcome === 'passed' || r.outcome === 'failed';
    const result = recorded
      ? `${String(r.outcome)}${r.result ? ` (${plain(r.result)})` : ''}`
      : 'ran; Tracetoon could not read its result';
    const edited = list(r.editedAfter);
    const when = edited
      ? `the logs show later edits to ${edited}`
      : String(r.when ?? '').startsWith('after the last edit')
        ? 'whether it ran on the final code is not recorded'
        : r.when
          ? `ran ${String(r.when)}`
          : '';
    lines.push(`- \`${shownCommand(r.cmd)}\`: ${result}${when ? `; ${when}` : ''}.`);
  }
  if (b.unchecked.length)
    lines.push(
      `- No recorded passing test, build, lint or typecheck run after the last captured edit of ${b.unchecked.join(', ')}.`,
    );
  if (!lines.length)
    lines.push(
      '- No test, build, lint or typecheck run was recorded in the captured sessions.',
    );
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

/** The text of every row each ref names, for checking what a tagged sentence cites. */
function refTexts(b: BriefParts): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const sec of b.sections)
    for (const r of sec.rows)
      for (const k of ['change', 'ref', 'check'])
        if (typeof r[k] === 'string' && r[k])
          out.push({
            key: (r[k] as string).replace(/^commit:/, ''),
            text: JSON.stringify(r),
          });
  return out;
}

const citedText = (rows: { key: string; text: string }[], refs: string[]) =>
  refs
    .map((ref) => ref.replace(/^commit:/, ''))
    .flatMap((ref) =>
      rows.filter((r) =>
        /^[0-9a-f]{7,40}(#\d+)?$/.test(ref)
          ? r.key.startsWith(ref.split('#')[0]!) || ref.startsWith(r.key.split('#')[0]!)
          : r.key === ref,
      ),
    )
    .map((r) => r.text)
    .join('\n');

/**
 * Code a sentence names: backticked names shaped like code (`a_b`, `a.b`,
 * `src/x.ts`, `fn()`, `camelCase`, `PascalCase`) and bare lowerCamel words.
 * Plain words and product names (`pushd`, OpenAI) are not checked.
 */
function codeNames(sentence: string): string[] {
  const names = new Set<string>();
  for (const m of sentence.matchAll(/`([^`\s]+)`/g)) {
    const raw = m[1]!;
    const n = raw.replace(/\(\)$/, '');
    if (!/^[A-Za-z_.][\w.$/-]*$/.test(n)) continue;
    if (raw.endsWith('()') || /[_./]/.test(n) || /[a-z][A-Z]/.test(n)) names.add(n);
  }
  for (const m of sentence.replace(/`[^`]*`/g, ' ').matchAll(/\b([a-z]+[A-Z]\w*)\b/g))
    names.add(m[1]!);
  return [...names];
}

/** Known, or a 7+ character prefix of a known commit sha (`421ce02` for `commit:421ce024cc68`). */
function knownRef(known: Set<string>, ref: string): boolean {
  if (known.has(ref)) return true;
  const m = /^(?:commit:)?([0-9a-f]{7,40})(#\d+)?$/.exec(ref);
  if (!m) return false;
  for (const k of known) {
    const n = /^(?:commit:)?([0-9a-f]{7,40})(#\d+)?$/.exec(k);
    if (n && n[1]!.startsWith(m[1]!) && (n[2] ?? '') === (m[2] ?? '')) return true;
  }
  return false;
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
    for (const s of body.split(/(?<=[.!?])\s+(?=[A-Z`"(])/))
      if (s.trim()) out.push(s.trim());
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
      unbackedNames: [],
    };
  const known = briefRefs(b);
  const unknown = new Set<string>();
  let tags = 0;
  const untagged: string[] = [];
  const validationClaims: string[] = [];
  const unbackedNames: BriefApplied['unbackedNames'] = [];
  const rows = refTexts(b);
  for (const unit of proseUnits(body)) {
    const found = [...unit.matchAll(TAG)];
    const clean = unit.replace(TAG, '').trim();
    if (VALIDATION_CLAIM.test(clean)) validationClaims.push(clean);
    if (!found.length) {
      // Short labels and lead-ins ("Changes:", "Start here") state nothing.
      if (clean.split(/\s+/).length >= 5 && !clean.endsWith(':')) untagged.push(clean);
      continue;
    }
    const refs = found.flatMap((m) => m[1]!.split(/\s*[,;]\s*/));
    for (const ref of refs) {
      tags++;
      if (!knownRef(known, ref)) unknown.add(ref);
    }
    // A name the cited rows never mention is the writer's own attribution.
    const cited = citedText(rows, refs);
    const names = codeNames(clean).filter(
      (n) => !cited.includes(n) && !cited.includes(n.split('/').pop()!),
    );
    if (names.length) unbackedNames.push({ sentence: clean, names });
  }
  let text = body.replace(TAG, '');
  // The section brings its own heading: drop a writer's heading right above the marker.
  text = text.replace(
    new RegExp(String.raw`^#{1,6}[^\n]*\n(\s*\n)*(?=${VALIDATION_MARKER})`, 'm'),
    '',
  );
  const validation = text.includes(VALIDATION_MARKER);
  if (validation) text = text.replace(VALIDATION_MARKER, validationSection(b));
  return {
    text,
    validation,
    tags,
    unknownRefs: [...unknown].sort(),
    untagged,
    validationClaims,
    unbackedNames,
  };
}
