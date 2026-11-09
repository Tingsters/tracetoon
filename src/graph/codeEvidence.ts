/**
 * Code evidence under commit sentences, and commit-vs-code conflicts.
 *
 * - `evidenceLines` (prepare time): a hunk's few lines worth quoting, best
 *   first: added code comments (consecutive lines joined), then lines carrying
 *   literal values or `- old ⇒ + new` pairs (numbers, versions, hashes, names
 *   in quotes), then condition lines, then definitions; for prose files the
 *   added lines themselves. Stored on the Hunk as `keyLines`.
 * - `codeCells` (brief time): up to two of those lines per commit sentence,
 *   from the hunks the sentence is linked to and sharing its words, prefixed
 *   with the hunk's diff ref so a writer can cite them; capped so the TOON
 *   brief grows by at most CODE_SHARE.
 * - `conflictRows`: a sentence whose linked hunk has an added comment or
 *   literal that says the opposite on an ordering or comparison word
 *   (before/after, older/newer, first/last, less/greater…), a state
 *   (enabled/disabled, true/false) or a number or version: a doNotSay row
 *   telling the writer to describe the code. Generic token heuristics, tuned
 *   for precision: both texts must name the same anchors.
 */
import { BRANCHING, keyCodeLines } from './build.ts';
import { toToon } from './toon.ts';
import type { GraphEngine } from './engine.ts';
import type { Section } from './queries.ts';

const isComment = (l: string) =>
  /^\s*(\/\/|#(?!\[|!)|\*(?!\*?\s*$)|\/\*|--\s|<!--)/.test(l);
const PROSE_FILE = /\.(md|mdx|txt|rst|adoc)$/i;
const LITERAL = /\d|'[^']+'|"[^"]+"|`[^`]+`/;
const CONDITION = /^\s*(?:\}\s*)?(?:else\s+)?(?:if|elif|while|unless|case)\b|\?\?|\s\?\s/;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Most key lines kept per hunk. */
const MAX_KEY_LINES = 8;

/** A hunk's lines worth quoting, best first (see the file comment). */
export function evidenceLines(minus: string[], plus: string[], file: string): string[] {
  if (PROSE_FILE.test(file))
    return plus
      .map((l) => l.trim())
      .filter((l) => l.split(/\s+/).length >= 4)
      .slice(0, MAX_KEY_LINES)
      .map((l) => `+ ${clip(l, 240)}`);
  const comments: string[] = [];
  let block: string[] = [];
  const flush = () => {
    const text = block
      .map((l, i) => (i ? l.replace(/^\s*(\/\/+|#+|\*+|--)\s?/, '') : l.trim()))
      .join(' ');
    // A comment worth quoting says something: three words or more.
    if (block.length && text.replace(/^\S+\s*/, '').split(/\s+/).length >= 3)
      comments.push(`+ ${clip(text, 240)}`);
    block = [];
  };
  for (const l of plus) {
    if (isComment(l) && !/^\s*(\/\/|#)\s*(eslint|prettier|@ts-|noqa|type:)/.test(l))
      block.push(l);
    else flush();
  }
  flush();
  const key = keyCodeLines(minus, plus, 24);
  const literal: string[] = [];
  const cond: string[] = [];
  const rest: string[] = [];
  for (const k of key) {
    const code = k.replace(/^[-+]\s/, '');
    if (isComment(code)) continue;
    if (LITERAL.test(code.replace(/\b[A-Za-z_$][\w$]*\d+\w*\b/g, ''))) literal.push(k);
    else if (CONDITION.test(code) || BRANCHING.test(code)) cond.push(k);
    else rest.push(k);
  }
  return [
    ...comments.slice(0, 3),
    ...literal.slice(0, 3),
    ...cond.slice(0, 2),
    ...rest.slice(0, 2),
  ]
    .slice(0, MAX_KEY_LINES)
    .map((l) => clip(l, 240));
}

/** Number and version tokens of a hunk's changed lines, for the conflict check. */
export function literalTokens(minus: string[], plus: string[]): string[] {
  const out = new Set<string>();
  for (const l of [...minus, ...plus])
    for (const m of l.matchAll(/\bv?\d+(?:\.\d+)*(?:-[A-Za-z]+(?:\.?\d+)*)?\b/g))
      out.add(m[0].replace(/^v/, ''));
  return [...out].slice(0, 80);
}

/**
 * Crude stem, so "cases" meets `case`, "pins" meets "pinned" and "merged"
 * meets `merge`.
 */
export const stem = (w: string) =>
  (w.replace(/(ies|es|s|ed|ing)$/, (m) => (m === 'ies' ? 'y' : '')) || w)
    .replace(/(?<=..)e$/, '')
    .replace(/([^aeiou\d])\1$/, '$1');

const STOP = new Set(
  'the and for with that this from into when then than only now not are was were has have had its also each more most some any all can will would should could does did use used uses using make makes made add adds added new old instead they them their there here which what who how why one two per via over under about after before still just like same other way get gets set sets run runs ran code file files line lines test tests change changes changed fix fixes fixed update updated but out off our you yet too see may let return const true false null'.split(
    ' ',
  ),
);
const wordsOf = (s: string) =>
  new Set(
    (
      s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .match(/[a-z][a-z0-9]{2,}|\d+(?:\.\d+)*/g) ?? []
    )
      .map(stem)
      .filter((w) => !STOP.has(w)),
  );

/** Share of the TOON brief the code cells (and conflict rows) may add. */
export const CODE_SHARE = 0.11;
/** Lines per commit sentence, and characters per line. */
const PER_ROW = 2;
const LINE_CHARS = 110;

interface HunkInfo {
  id: string;
  diff: string;
  file: string;
  keyLines: string[];
  literals: string[];
}

function hunkInfo(g: GraphEngine): Map<string, HunkInfo> {
  return new Map(
    g
      .run(
        'MATCH (h:Hunk) RETURN h.id AS id, h.diff AS diff, h.file AS file, h.keyLines AS keyLines, h.literals AS literals',
      )
      .rows.map((r) => [
        String(r.id),
        {
          id: String(r.id),
          diff: String(r.diff),
          file: String(r.file),
          keyLines: (r.keyLines as string[]) ?? [],
          literals: (r.literals as string[]) ?? [],
        },
      ]),
  );
}

/**
 * Add a `code` column to `commitMessages` (TOON layout): each sentence's key
 * lines from its linked hunks, best first, within CODE_SHARE of the brief.
 */
export function addCodeCells(
  g: GraphEngine,
  sections: Section[],
  hunkLinks: Record<string, string[]>,
  /** Characters the cells may add; default CODE_SHARE of the brief. */
  budgetChars?: number,
): void {
  const commits = sections.find((s) => s.title === 'commitMessages');
  if (!commits?.rows.length) return;
  const info = hunkInfo(g);
  if (![...info.values()].some((h) => h.keyLines.length)) return;
  const budget = budgetChars ?? Math.round(toToon(sections).length * CODE_SHARE);
  // Each row's candidates, best first: lines sharing the sentence's words,
  // comments before values before conditions (keyLines' own order).
  const cands = commits.rows.map((r) => {
    const words = wordsOf(String(r.text ?? ''));
    const out: { text: string; hunk: string; score: number }[] = [];
    for (const id of hunkLinks[String(r.ref)] ?? []) {
      const h = info.get(id);
      if (!h) continue;
      h.keyLines.forEach((l, i) => {
        const shared = [...wordsOf(l)].filter((w) => words.has(w)).length;
        if (shared)
          out.push({
            text: `${h.diff} ${clip(l, LINE_CHARS)}`,
            hunk: id,
            score: shared * 10 - i,
          });
      });
    }
    out.sort((a, b) => b.score - a.score);
    // At most one line per hunk until every linked hunk had a turn.
    const picked: typeof out = [];
    for (const c of out) if (!picked.some((p) => p.hunk === c.hunk)) picked.push(c);
    for (const c of out) if (!picked.includes(c)) picked.push(c);
    return picked.map((c) => c.text);
  });
  const cells: string[][] = commits.rows.map(() => []);
  const shown = new Set<string>();
  let used = 0;
  // Round robin: every sentence's first line before anyone's second; a line
  // already under an earlier sentence is not repeated.
  // Sentences before subjects: a subject sums up what its sentences detail.
  const order = commits.rows
    .map((r, i) => ({ i, subject: !String(r.ref).includes('#') }))
    .sort((a, b) => Number(a.subject) - Number(b.subject) || a.i - b.i)
    .map((x) => x.i);
  for (let round = 0; round < PER_ROW; round++)
    order.forEach((i) => {
      const c = cands[i]!;
      const line = c.find((l) => !shown.has(l));
      if (!line) return;
      const cost = line.length + 3;
      if (used + cost > budget) return;
      used += cost;
      shown.add(line);
      cells[i]!.push(line);
    });
  if (!used) return;
  commits.columns = [...commits.columns, 'code'];
  commits.rows.forEach((r, i) => (r.code = cells[i]!.join(' ‖ ')));
}

// --- Commit-vs-code conflicts ---------------------------------------------

const OPPOSITE: Record<string, string> = {
  before: 'after',
  after: 'before',
  earlier: 'later',
  later: 'earlier',
  older: 'newer',
  newer: 'older',
  first: 'last',
  last: 'first',
  less: 'greater',
  greater: 'less',
  lower: 'higher',
  higher: 'lower',
  smaller: 'larger',
  larger: 'smaller',
  below: 'above',
  above: 'below',
};
const STATE: Record<string, string> = {
  enabled: 'disabled',
  disabled: 'enabled',
  true: 'false',
  false: 'true',
};

/** Tokens of a text: words, identifiers, versions and numbers. */
const tokensOf = (s: string) =>
  (
    s.match(
      /[A-Za-z_$][\w$]*(?:[.-][\w$]+)*|v?\d+(?:\.\d+)*(?:-[A-Za-z]+(?:\.?\d+)*)?/g,
    ) ?? []
  ).map((t) => t.replace(/^v(?=\d)/, ''));
/** A token distinctive enough to anchor a comparison: has a digit, or is code-shaped. */
const isAnchor = (t: string) => /\d/.test(t) || /[a-z][A-Z]|_|\./.test(t);
/** Same anchor: equal, or one is the other's dotted/dashed suffix (1.0.0-rc.10 ~ rc.10). */
const sameAnchor = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (
    x === y ||
    x.endsWith(`-${y}`) ||
    y.endsWith(`-${x}`) ||
    x.endsWith(`.${y}`) ||
    y.endsWith(`.${x}`)
  );
};

interface Triple {
  a: string;
  rel: string;
  b: string;
}
/** `A … before … B` within a few tokens, for each ordering word in the text. */
export function orderTriples(text: string): Triple[] {
  const toks = tokensOf(text);
  const out: Triple[] = [];
  toks.forEach((t, i) => {
    const rel = t.toLowerCase();
    if (!OPPOSITE[rel]) return;
    const a = toks
      .slice(Math.max(0, i - 4), i)
      .reverse()
      .find(isAnchor);
    const b = toks.slice(i + 1, i + 5).find(isAnchor);
    if (a && b && !sameAnchor(a, b)) out.push({ a, rel, b });
  });
  return out;
}

/** The sentence and the code say opposite things about the same two anchors. */
export function orderConflict(sentence: string, code: string): boolean {
  const s = orderTriples(sentence);
  const c = orderTriples(code);
  return s.some((x) =>
    c.some(
      (y) =>
        (sameAnchor(x.a, y.a) && sameAnchor(x.b, y.b) && OPPOSITE[x.rel] === y.rel) ||
        (sameAnchor(x.a, y.b) && sameAnchor(x.b, y.a) && x.rel === y.rel),
    ),
  );
}

/** States (enabled/disabled, true/false) the text gives a code-shaped name. */
function states(text: string, code: boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (code)
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(true|false)\b/g))
      out.set(m[1]!.toLowerCase(), m[2]! === 'true' ? 'enabled' : 'disabled');
  const toks = tokensOf(text);
  toks.forEach((t, i) => {
    const st = STATE[t.toLowerCase()] ? t.toLowerCase() : undefined;
    if (!st) return;
    const near = [...toks.slice(Math.max(0, i - 3), i), ...toks.slice(i + 1, i + 3)].find(
      (x) => /[a-z][A-Z]|_/.test(x),
    );
    if (near)
      out.set(
        near.toLowerCase(),
        st === 'true' ? 'enabled' : st === 'false' ? 'disabled' : st,
      );
  });
  return out;
}
export function stateConflict(
  sentence: string,
  code: string,
  isCodeLine: boolean,
): boolean {
  const s = states(sentence, false);
  const c = states(code, isCodeLine);
  for (const [name, st] of s) if (c.has(name) && c.get(name) === STATE[st]) return true;
  return false;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z]+(?:\.?\d+)*)?$/;
/**
 * A number next to the same noun in both texts with different values
 * (`fetch 30 releases` vs `per page: 100 releases`), when the hunk's lines never
 * carry the sentence's number; or a version the hunk never mentions while its
 * lines carry exactly one other version.
 */
export function numberConflict(
  sentence: string,
  line: string,
  hunkLiterals: string[],
): boolean {
  if (/\b(?:from|was|were|previously|used to)\s+v?\d/i.test(sentence)) return false;
  const has = new Set(hunkLiterals);
  const sToks = tokensOf(sentence);
  const versions = sToks.filter((t) => VERSION.test(t));
  const hunkVersions = hunkLiterals.filter((t) => VERSION.test(t));
  for (const v of versions)
    if (
      !has.has(v) &&
      hunkVersions.length === 1 &&
      tokensOf(line).includes(hunkVersions[0]!)
    )
      return true;
  const pairs = (toks: string[]) => {
    const out = new Map<string, string>();
    toks.forEach((t, i) => {
      if (!/^\d+$/.test(t)) return;
      const noun = toks[i + 1];
      if (noun && /^[a-z]{4,}$/i.test(noun) && !STOP.has(noun.toLowerCase()))
        out.set(noun.toLowerCase().replace(/s$/, ''), t);
    });
    return out;
  };
  const s = pairs(sToks);
  const c = pairs(tokensOf(line));
  for (const [noun, n] of s) {
    const m = c.get(noun);
    if (m && m !== n && !has.has(n)) return true;
  }
  return false;
}

/**
 * doNotSay rows for commit sentences contradicted by an added comment or
 * literal in a hunk they are linked to. At most one row per sentence.
 */
export function conflictRows(
  g: GraphEngine,
  sections: Section[],
  hunkLinks: Record<string, string[]>,
  max = 3,
): Record<string, unknown>[] {
  const commits = sections.find((s) => s.title === 'commitMessages')?.rows ?? [];
  const info = hunkInfo(g);
  const out: Record<string, unknown>[] = [];
  for (const r of commits) {
    const text = String(r.text ?? '');
    let found: { line: string; diff: string; comment: boolean } | undefined;
    for (const id of hunkLinks[String(r.ref)] ?? []) {
      const h = info.get(id);
      if (!h || PROSE_FILE.test(h.file)) continue;
      for (const l of h.keyLines) {
        const body = l.replace(/^[-+]\s/, '');
        // Only what the change adds: a `- old ⇒ + new` pair speaks for its new side.
        const added = body.includes('  ⇒  + ')
          ? body.split('  ⇒  + ')[1]!
          : l.startsWith('- ')
            ? ''
            : body;
        if (!added) continue;
        const comment = isComment(added);
        if (
          (comment &&
            (orderConflict(text, added) || stateConflict(text, added, false))) ||
          (!comment && stateConflict(text, added, true)) ||
          numberConflict(text, added, h.literals)
        ) {
          found = { line: added, diff: h.diff, comment };
          break;
        }
      }
      if (found) break;
    }
    if (!found) continue;
    out.push({
      kind: 'commit vs code',
      text: `The commit message says "${clip(text, 110)}"; the code${found.comment ? ' comment' : ''} says "${clip(found.line.replace(/^\s*(\/\/+|#+|\/\*+|\*+|--)\s*/, ''), 120)}" (${found.diff}): describe the code, not the message.`,
      cites: `${String(r.ref)} ${found.diff}`,
    });
    if (out.length >= max) break;
  }
  return out;
}
