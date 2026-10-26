/**
 * An advisory check of a PR description against the captured evidence. It never
 * blocks publishing: logs are incomplete (other terminals, CI, manual checks,
 * commands we don't parse), so missing evidence is not contradicting evidence.
 *
 * Each consequential claim gets one of four states:
 *  - observed: a captured fact supports it (within its scope);
 *  - author-reported: the author said so (author.md, or attributed in the text);
 *  - not established: nothing captured supports it (a gentle note, never "false");
 *  - contradicted: captured evidence conflicts with it (worth fixing).
 *
 * The checks are deliberately shallow: verification claims, attributions of
 * decisions, and references to files. Semantic truth ("adds rate limiting") is
 * not judged.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, TraceDigest } from './build.ts';

export type ClaimState =
  'observed' | 'author-reported' | 'not established' | 'contradicted';

export interface ClaimFinding {
  /** The sentence the finding is about, as it appears in the text. */
  quote: string;
  kind: 'verification' | 'attribution' | 'reference';
  state: ClaimState;
  /** What the evidence shows, in plain words. */
  detail: string;
  /** Ids of the facts consulted (R3, D1…). */
  evidence: string[];
}

export interface ClaimInput {
  title: string;
  /** The description markdown (without the comic block or disclosure). */
  body: string;
  digest: Pick<TraceDigest, 'sessions' | 'files' | 'pr' | 'verification'>;
  /** Repository root, to tell a stale reference from a file outside the diff. */
  root?: string;
  /** Things the author told Tracetoon (author.md), treated as author-reported. */
  authorText?: string;
}

// ------------------------------------------------------------------ text

/** Sentences of prose, skipping code blocks, headings markup and HTML comments. */
export function sentences(markdown: string): string[] {
  const prose = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return prose
    .split(/\n\s*\n|\n(?=\s*[-*]\s|\s*\d+\.\s|#)/)
    .flatMap((block) =>
      block
        .replace(/^\s*(#+|[-*]|\d+\.)\s*/gm, '')
        .replace(/\s+/g, ' ')
        // Split on sentence ends, but not inside `code` or numbers like 1.0.
        .split(/(?<=[.!?])\s+(?=[A-Z*`"(])/),
    )
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

const VERIFY =
  /(`[^`]*\b(test|tests|tsc|lint|check|build|prettier|eslint|pytest|jest|vitest|cargo|bundle)\b[^`]*`[^.]{0,30}\b(pass\w*|succeed\w*|clean|green)\b)|\b(all (the )?tests? pass\w*|tests? (all )?(pass\w*|succeed\w*|(are|is|went) green)|(suite|build|ci|lint\w*|type ?check\w*|tsc|checks?)\b[^.]{0,40}\b(pass\w*|succeed\w*|clean|green)|\bpass(es|ed)? (locally|on (ci|this|the final))|\b\d+\s+(tests?|pass(es|ing)?)\b|no regressions?|verified|fully (tested|backward[- ]compatible)|works (everywhere|on all))/i;

const AUTHOR =
  /\b(reported by the author|(the )?author (reports|says|checked|tested)|manually|by hand|I (tested|checked|ran|verified|tried))\b/i;
const ATTRIBUTION =
  /\b(the user|the author|you)\s+(chose|decided|picked|selected|asked|wanted|preferred|rejected|turned down|approved)\b/i;
const ALTERNATIVE =
  /\b(instead of|rather than|considered|alternative|rejected|dropped|replaces?|replaced|removed|deleted|renamed|old|previously|no longer|was)\b/i;

/** Which kind of run a verification sentence is about. */
function runKindsFor(s: string): Run['kind'][] {
  const kinds: Run['kind'][] = [];
  if (/\btests?\b|\bsuite\b|\bpass(es|ed|ing)?\b/i.test(s)) kinds.push('test');
  if (/\bbuild\b|\bbundle\b|\bcompil/i.test(s)) kinds.push('build');
  if (/\blint|prettier|eslint|format/i.test(s)) kinds.push('lint');
  if (/\btype ?check|\btsc\b|mypy/i.test(s)) kinds.push('typecheck');
  if (/\beval|benchmark|harness/i.test(s)) kinds.push('eval');
  return kinds.length ? kinds : ['test'];
}

function allRuns(d: ClaimInput['digest']): Run[] {
  return (
    [...d.sessions.flatMap((s) => s.runs ?? []), ...(d.verification ?? [])]
      // Runs on later work (after the PR's last commit and further edits) say nothing about this PR.
      .filter((r) => r.revision !== 'after later work')
      .slice()
      .sort((a, b) => (a.t ?? '').localeCompare(b.t ?? ''))
  );
}

// ---------------------------------------------------------------- checks

function checkVerification(
  s: string,
  input: ClaimInput,
  runs: Run[],
): ClaimFinding | undefined {
  // Quoted text is an example, not a claim ("tests pass" when the run failed), and
  // a sentence about claims ("each sentence that claims a check passed") isn't one.
  const bare = s.replace(/"[^"]*"|“[^”]*”/g, '""');
  const hit = VERIFY.exec(bare);
  if (!hit) return undefined;
  if (
    /\b(claims?|claiming|says?|such as)\b/i.test(
      bare.slice(Math.max(0, hit.index - 40), hit.index),
    )
  )
    return undefined;
  const author = AUTHOR.test(s) || mentionedBy(input.authorText, s);
  // A named command narrows the runs: `bun test tests/x.test.ts`, `prettier --check`.
  const named = [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  const kinds = runKindsFor(s);
  let relevant = runs.filter((r) => kinds.includes(r.kind));
  const byName = relevant.filter((r) =>
    named.some(
      (n) => r.cmd.startsWith(n) || n.startsWith(r.cmd.split(' ').slice(0, 2).join(' ')),
    ),
  );
  if (byName.length) relevant = byName;
  const last = relevant[relevant.length - 1];
  const passed = relevant.filter((r) => r.outcome === 'passed');
  const lastPass = passed[passed.length - 1];
  const ids = relevant
    .slice(-3)
    .map((r) => r.id ?? '')
    .filter(Boolean);
  const overreach =
    /no regressions?|works (everywhere|on all)|fully (tested|backward[- ]compatible)/i.test(
      s,
    );

  if (overreach && !author)
    return finding(
      s,
      'verification',
      'not established',
      'A passing run shows what was checked, not that nothing else broke.',
      ids,
    );
  if (last && last.outcome === 'failed' && !author)
    return finding(
      s,
      'verification',
      'contradicted',
      `The last captured run (${last.id}: ${last.cmd}) failed${last.summary.length ? `: ${last.summary.join(', ')}` : ''}.`,
      ids,
    );
  const numbers = [...s.matchAll(/\b(\d+)\s+(?:tests?|pass(?:es|ing)?)\b/gi)].map(
    (m) => m[1]!,
  );
  if (numbers.length && lastPass && !author) {
    const shown = lastPass.summary.join(' ');
    const missing = numbers.filter((n) => !new RegExp(`\\b${n}\\b`).test(shown));
    if (
      missing.length &&
      passed.every(
        (r) => !missing.every((n) => new RegExp(`\\b${n}\\b`).test(r.summary.join(' '))),
      )
    )
      return finding(
        s,
        'verification',
        'not established',
        `No captured run shows ${missing.join(', ')}; the last passing run shows: ${shown || 'no counts'}.`,
        ids,
      );
  }
  if (lastPass) {
    if (lastPass.revision === 'before later edits')
      return finding(
        s,
        'verification',
        'observed',
        `${lastPass.id} passed, but files in the PR changed afterwards; say it passed before the final edits, or re-run.`,
        ids,
      );
    const dirty =
      input.digest.pr.dirty && lastPass.verificationBasis !== 'exact-content-receipt'
        ? ' Uncommitted changes existed, so it may have covered code outside the PR.'
        : '';
    return finding(
      s,
      'verification',
      'observed',
      `${lastPass.id} (${lastPass.cmd}) passed${lastPass.summary.length ? `: ${lastPass.summary.join(', ')}` : ''}${lastPass.verificationBasis === 'exact-content-receipt' ? '; its receipt matches the current content and environment' : ', with no later edits seen'}.${dirty}`,
      ids,
    );
  }
  if (author)
    return finding(
      s,
      'verification',
      'author-reported',
      'Reported by the author; no captured run shows it, which is fine for checks done outside the logs.',
      ids,
    );
  return finding(
    s,
    'verification',
    'not established',
    relevant.length
      ? 'No captured run shows this passing.'
      : 'No matching run was captured. If it ran elsewhere (CI, another terminal), keep it and note where; otherwise reword.',
    ids,
  );
}

function checkAttribution(s: string, input: ClaimInput): ClaimFinding | undefined {
  if (!ATTRIBUTION.test(s)) return undefined;
  if (mentionedBy(input.authorText, s))
    return finding(s, 'attribution', 'author-reported', 'The author said so.', []);
  const decisions = input.digest.sessions.flatMap((x) => x.decisions);
  const prompts = input.digest.sessions.flatMap((x) => x.prompts);
  const words = (t: string) =>
    new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []);
  const sw = words(s);
  const overlap = (t: string) => [...words(t)].filter((w) => sw.has(w)).length;
  const support = [
    ...decisions.map((d) => ({
      id: d.id ?? 'D?',
      text: [
        d.text,
        ...(d.questions ?? []).map((q) => `${q.question} ${q.answer ?? ''}`),
      ].join(' '),
    })),
    ...prompts.map((p) => ({ id: p.id ?? 'S?', text: p.text })),
  ]
    .map((f) => ({ ...f, score: overlap(f.text) }))
    .filter((f) => f.score >= 2)
    .sort((a, b) => b.score - a.score);
  const rejects = /\b(rejected|turned down)\b/i.test(s);
  if (!support.length)
    return finding(
      s,
      'attribution',
      'not established',
      'No recorded prompt or decision says this. State it neutrally, or keep it if the author confirms.',
      [],
    );
  if (
    rejects &&
    !decisions.some((d) => d.questions?.some((q) => q.ownWords)) &&
    !prompts.some((p) => p.pushback)
  )
    return finding(
      s,
      'attribution',
      'not established',
      'A recorded choice shows what was picked; an unpicked option is not the same as a rejection with a reason.',
      support.slice(0, 2).map((f) => f.id),
    );
  return finding(
    s,
    'attribution',
    'observed',
    `Matches ${support
      .slice(0, 2)
      .map((f) => f.id)
      .join(', ')}.`,
    support.slice(0, 2).map((f) => f.id),
  );
}

const FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|rs|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|ya?ml|toml|sh|ps1|cmd|bat|css|scss|html|sql|txt|lock|cfg|ini|xml|vue|svelte|wasm|png|svg)$/i;

/** Sentences that describe changing something (as opposed to mentioning it). */
const CHANGE_VERB =
  /\b(adds?|added|changes?|changed|updates?|updated|fix(es|ed)?|modif(y|ies|ied)|edits?|edited|moves?|moved|refactor\w*|rewrites?|rewrote|implements?|introduces?)\b/i;

const tracked = new Map<string, string[]>();
/**
 * Whether the repository has this file (a path, or a bare filename anywhere in
 * it), or only names it in its text: a file the code writes or reads, such as a
 * run-folder output or a config name, isn't tracked but isn't stale either.
 */
function repoHas(root: string, ref: string): 'file' | 'mentioned' | false {
  if (existsSync(join(root, ref))) return 'file';
  if (!ref.includes('/')) {
    if (!tracked.has(root)) {
      const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
      tracked.set(root, r.status === 0 ? r.stdout.split('\n') : []);
    }
    if (tracked.get(root)!.some((p) => p === ref || p.endsWith(`/${ref}`))) return 'file';
  }
  const key = `${root}|${ref}`;
  if (!mentioned.has(key)) {
    const g = spawnSync('git', ['grep', '-q', '-F', '--', ref], { cwd: root });
    mentioned.set(key, g.status === 0);
  }
  return mentioned.get(key) ? 'mentioned' : false;
}
const mentioned = new Map<string, boolean>();

function checkReferences(s: string, input: ClaimInput): ClaimFinding[] {
  const changed = new Set(input.digest.files.map((f) => f.path));
  const out: ClaimFinding[] = [];
  for (const m of s.matchAll(/`([^`\s]+)`/g)) {
    const ref = m[1]!.replace(/^\.\//, '').replace(/[:#].*$/, '');
    // Only things that look like files: a known extension, or a path with a slash
    // and an extension. Field names like `pr.dirty` and flags aren't files.
    if (
      !FILE_EXT.test(ref) ||
      /^https?:|^[a-z]+:\/\//i.test(ref) ||
      /[*?<>{}$()=,]/.test(ref)
    )
      continue;
    if (changed.has(ref) || [...changed].some((p) => p.endsWith(`/${ref}`))) continue;
    const exists = input.root ? repoHas(input.root, ref) : undefined;
    if (ALTERNATIVE.test(s)) continue; // alternatives, renames and removals may name other files
    if (exists === 'file' && CHANGE_VERB.test(s))
      out.push(
        finding(
          s,
          'reference',
          'not established',
          `\`${ref}\` exists but isn't changed in this PR; make sure the sentence doesn't describe a change to it.`,
          [],
        ),
      );
    else if (exists === false)
      out.push(
        finding(
          s,
          'reference',
          'not established',
          `\`${ref}\` isn't in this PR or the repository; possibly a stale reference.`,
          [],
        ),
      );
  }
  return out;
}

const finding = (
  quote: string,
  kind: ClaimFinding['kind'],
  state: ClaimState,
  detail: string,
  evidence: string[],
): ClaimFinding => ({ quote, kind, state, detail, evidence });

/** Whether the author's own notes cover this sentence (shared distinctive words). */
function mentionedBy(authorText: string | undefined, s: string): boolean {
  if (!authorText?.trim()) return false;
  const words = (t: string) => t.toLowerCase().match(/[a-z0-9][a-z0-9-]{4,}/g) ?? [];
  const a = new Set(words(authorText));
  const hits = words(s).filter((w) => a.has(w)).length;
  return hits >= 2;
}

/** Check every sentence of the title and body. Never throws, never blocks. */
export function checkClaims(input: ClaimInput): ClaimFinding[] {
  const runs = allRuns(input.digest);
  const out: ClaimFinding[] = [];
  for (const s of [input.title, ...sentences(input.body)]) {
    const v = checkVerification(s, input, runs);
    if (v) out.push(v);
    const a = checkAttribution(s, input);
    if (a) out.push(a);
    out.push(...checkReferences(s, input));
  }
  return out;
}

/** Counts by state, for one-line summaries. */
export function claimSummary(findings: ClaimFinding[]): Record<ClaimState, number> {
  const c: Record<ClaimState, number> = {
    observed: 0,
    'author-reported': 0,
    'not established': 0,
    contradicted: 0,
  };
  for (const f of findings) c[f.state]++;
  return c;
}
