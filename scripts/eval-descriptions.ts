// Evaluates PR descriptions against hand-checked fact sheets.
//
//   bun scripts/eval-descriptions.ts prepare   # build an evidence packet per case
//   bun scripts/eval-descriptions.ts score     # score descriptions, write the report
//   bun scripts/eval-descriptions.ts rubric    # print the blind judge's instructions
//
// Local only, like eval-summaries: everything lives under
// .git/tracetoon/eval-desc/ and nothing it produces is committed (one held-out
// case is a private repository).
//
// Layout under .git/tracetoon/eval-desc/:
//   packets/<case>/   digest.json, diff.patch, published.md (if the PR exists), case.json
//   facts/<case>.json written from the packet only, never from a description:
//                     { claims[], context[], uncertainties[], traps[] }
//   outputs/<case>/<variant>.md   descriptions to compare (e.g. old.md, new.md)
//   judgments/<case>.json         blind judge results (see JUDGE_FORMAT below)
//   report.md, report.json, ab.html
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDigest } from '../src/digest/build.ts';
import { checkClaims, claimSummary } from '../src/digest/claims.ts';
import { scan } from '../src/pipeline.ts';
import { git, gh } from '../src/util/exec.ts';

interface Case {
  id: string;
  name: string;
  repo: string;
  base: string;
  head: string;
  /** Published PR on GitHub, if any: its body is the "old" description. */
  pr?: { repo: string; number: number };
  /** Held-out cases were not looked at while designing the new rules. */
  heldOut?: boolean;
}

const dev = resolve(homedir(), 'Development');
const tt = join(dev, 'tracetoon');
export const CASES: Case[] = [
  {
    id: 'pr5',
    name: 'Summary evaluation and fixes',
    repo: tt,
    base: 'a400a0774a',
    head: '2b22db920f',
    pr: { repo: 'Tingsters/tracetoon', number: 5 },
  },
  {
    id: 'pr8',
    name: 'Clickable preview link + digest fixes',
    repo: tt,
    base: 'c62818fbd7',
    head: 'c973ef3a07',
    pr: { repo: 'Tingsters/tracetoon', number: 8 },
  },
  {
    id: 'pr9',
    name: 'AI-drawn comics',
    repo: tt,
    base: 'c33c65b82f',
    head: '421ce024cc',
    pr: { repo: 'Tingsters/tracetoon', number: 9 },
  },
  {
    id: 'pr11',
    name: 'Installer picks newest release',
    repo: tt,
    base: '76fca1565a',
    head: 'd5935ebcd4',
    pr: { repo: 'Tingsters/tracetoon', number: 11 },
  },
  {
    id: 'pr12',
    name: 'Quote-aware command splitting',
    repo: tt,
    base: '0f850d80d5',
    head: '1b46c4c72f',
    pr: { repo: 'Tingsters/tracetoon', number: 12 },
  },
  {
    id: 'pr10',
    name: 'Comic pages (held out)',
    repo: tt,
    base: 'cfd0e3d26c',
    head: '85b4567087',
    pr: { repo: 'Tingsters/tracetoon', number: 10 },
    heldOut: true,
  },
  {
    id: 'showtail',
    name: 'Showtail library extraction (held out)',
    repo: join(dev, 'Showtail'),
    base: 'ce5b776',
    head: 'e74fd9a',
    heldOut: true,
  },
  {
    id: 'vexaim',
    name: 'vexaim-cli Codex work (held out)',
    repo: join(dev, 'vexaim-cli'),
    base: '0723dbf^',
    head: '0723dbf',
    heldOut: true,
  },
];

const ROOT = join(tt, '.git', 'tracetoon', 'eval-desc');
const dir = (...p: string[]) => {
  const d = join(ROOT, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};

/** The description part of a published body: Tracetoon's region minus the comic. */
export function publishedText(body: string): string {
  const region =
    /<!-- tracetoon:start -->([\s\S]*?)<!-- tracetoon:end -->/.exec(body)?.[1] ?? body;
  return region
    .replace(/<!-- tracetoon:meta [\s\S]*?-->/g, '')
    .replace(/<p align="center"><img[\s\S]*?<\/p>/g, '')
    .replace(/<sub>Previously:[\s\S]*?<\/sub>/g, '')
    .replace(/<details>\s*<summary>Comic transcript[\s\S]*?<\/details>/g, '')
    .trim();
}

function prepare(): void {
  for (const c of CASES) {
    const out = dir('packets', c.id);
    const { truth, matches } = scan(c.repo, { base: c.base, head: c.head, noGh: true });
    writeFileSync(
      join(out, 'digest.json'),
      JSON.stringify(buildDigest(truth, matches), null, 2),
    );
    const diff = git(c.repo, [
      'diff',
      '--stat',
      '--patch',
      '--find-renames',
      `${c.base}..${c.head}`,
    ]);
    writeFileSync(join(out, 'diff.patch'), diff.stdout);
    const log = git(c.repo, ['log', '--format=%h %s%n%b', `${c.base}..${c.head}`]);
    writeFileSync(join(out, 'commits.txt'), log.stdout);
    if (c.pr) {
      const r = gh(c.repo, [
        'pr',
        'view',
        String(c.pr.number),
        '--repo',
        c.pr.repo,
        '--json',
        'title,body',
      ]);
      if (r.ok) {
        const pr = JSON.parse(r.stdout) as { title: string; body: string };
        writeFileSync(
          join(out, 'published.md'),
          `# ${pr.title}\n\n${publishedText(pr.body)}\n`,
        );
      }
    }
    writeFileSync(join(out, 'case.json'), JSON.stringify(c, null, 2));
    console.log(`${c.id}: packet ready (${diff.stdout.length} bytes of diff)`);
  }
  console.log(`\nPackets: ${join(ROOT, 'packets')}`);
}

// ---------------------------------------------------------------- scoring

/** Cheap, deterministic signals. They describe a text; they don't grade it. */
export function textSignals(md: string) {
  const body = md.replace(/^# .*\n/, '');
  const words = body.split(/\s+/).filter(Boolean).length;
  const bullets = body.split('\n').filter((l) => /^\s*[-*] /.test(l));
  const fileBullets = bullets.filter((l) => /^\s*[-*] `[^`]*[/.][^`]*`/.test(l)).length;
  return {
    words,
    fileInventory: fileBullets >= 4,
    testCountInventory: /\b\d{2,} tests?\b/i.test(body),
    matchPercentInBody: /\d+% of the added lines/i.test(body),
    agentFirstPerson: (
      body.match(
        /(^|[.!?]\s+)I (checked|placed|picked|added|wrote|changed|ran|found|made|fixed)\b/g,
      ) ?? []
    ).length,
    reviewPointer:
      /\b(start(s|ing)? (with|at|in|by)|where to (start|look)|review path|reading order|read [^.\n]{1,80} first|review(ers)? (should|could) (start|look))/i.test(
        body,
      ),
    feedbackWanted: /\bfeedback wanted\b|\b(looking for|would like) (feedback|input) on\b/i.test(
      body,
    ),
    reviewerQuestion: /\?\s*$/m.test(
      body
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n'),
    ),
  };
}

/**
 * The blind judge's instructions, versioned with the script. Print them with
 * `bun scripts/eval-descriptions.ts rubric`. v2 splits v1's `navigation`
 * (saturated at 2 in 7 of 8 cases) into `orientation` and `entry`; v1
 * judgments with `navigation` still score.
 */
export const JUDGE_RUBRIC_VERSION = 2;
export const JUDGE_RUBRIC = `Read judging/<case>/A.md and B.md, the packet (digest.json, diff.patch, commits.txt) and facts/<case>.json. Do not open outputs/ or published.md. Write judgments/<case>.json in the Judgment format.

Rubric: 0 missing/misleading, 1 partial, 2 sufficient and accurate, null = not applicable.
- problem: trigger, old and new behavior clear; the old behavior matches the base code.
- rationale: reasons explicit and correctly attributed.
- validation: evidence-bound, honest limits.
- consequences: concrete.
- orientation: changes grouped by idea in a sensible reading order (main idea or riskiest part first); no file-by-file narration.
- entry: a reader knows where to start and what feedback, if any, is wanted.
- economy: easy to find what matters; inventories and padding count against.

"preferred" = which one a maintainer reviewing this change would rather receive: accuracy first, then usefulness and effort. Do not prefer a text for being longer; every preference is reported next to its word count.`;

/**
 * What a blind judge writes per case. Labels are shuffled per case and mapped
 * back by the scorer; the judge never sees which variant is which.
 */
export interface Judgment {
  case: string;
  labels: Record<string, string>; // "A" -> "old", "B" -> "new"
  scores: Record<
    string, // label
    {
      factualErrors: string[]; // statements contradicted by the fact sheet/packet
      unsupportedClaims: string[]; // claims the packet doesn't establish
      coveredClaims: number; // fact-sheet claims conveyed
      coveredContext: number; // fact-sheet context items conveyed
      honestUncertainty: number; // fact-sheet uncertainties stated or not overclaimed
      trapsHit: string[]; // fact-sheet traps the text falls into
      rubric: Record<string, 0 | 1 | 2 | null>; // JUDGE_RUBRIC keys (v1 used navigation)
      notes: string;
    }
  >;
  preferred: string; // label, or "tie"
}

interface Facts {
  claims: string[];
  context: string[];
  uncertainties: string[];
  traps: string[];
}

function score(): void {
  const rows: Record<string, unknown>[] = [];
  const lines = ['# Description evaluation', ''];
  const totals: Record<
    string,
    {
      n: number;
      errors: number;
      unsupported: number;
      claims: number;
      context: number;
      uncertainty: number;
      traps: number;
      words: number;
      preferred: number;
      rubric: number;
      rubricN: number;
      contradicted: number;
      notEstablished: number;
    }
  > = {};
  for (const c of CASES) {
    const factsPath = join(ROOT, 'facts', `${c.id}.json`);
    const outDir = join(ROOT, 'outputs', c.id);
    if (!existsSync(factsPath) || !existsSync(outDir)) continue;
    const facts = JSON.parse(readFileSync(factsPath, 'utf8')) as Facts;
    const judgmentPath = join(ROOT, 'judgments', `${c.id}.json`);
    const judgment = existsSync(judgmentPath)
      ? (JSON.parse(readFileSync(judgmentPath, 'utf8')) as Judgment)
      : undefined;
    lines.push(`## ${c.name}${c.heldOut ? ' (held out)' : ''}`, '');
    lines.push(
      '| variant | words | errors | unsupported | claims | context | uncertainty | traps | rubric | check (contradicted / not established) | signals |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const f of readdirSync(outDir).filter((x) => x.endsWith('.md'))) {
      const variant = f.replace(/\.md$/, '');
      const text = readFileSync(join(outDir, f), 'utf8');
      const sig = textSignals(text);
      // The advisory claim check, run against the packet's evidence.
      const packetDigest = JSON.parse(
        readFileSync(join(ROOT, 'packets', c.id, 'digest.json'), 'utf8'),
      );
      const check = claimSummary(
        checkClaims({
          title: /^# (.*)/.exec(text)?.[1] ?? '',
          body: text.replace(/^# .*\n/, ''),
          digest: packetDigest,
          root: c.repo,
        }),
      );
      const label =
        judgment && Object.entries(judgment.labels).find(([, v]) => v === variant)?.[0];
      const s = label ? judgment!.scores[label] : undefined;
      const rubricVals = s
        ? Object.values(s.rubric).filter((v): v is 0 | 1 | 2 => v !== null)
        : [];
      const rubric = rubricVals.length
        ? rubricVals.reduce<number>((a, b) => a + b, 0) / rubricVals.length
        : NaN;
      const t = (totals[variant] ??= {
        n: 0,
        errors: 0,
        unsupported: 0,
        claims: 0,
        context: 0,
        uncertainty: 0,
        traps: 0,
        words: 0,
        preferred: 0,
        rubric: 0,
        rubricN: 0,
        contradicted: 0,
        notEstablished: 0,
      });
      t.n++;
      t.contradicted += check.contradicted;
      t.notEstablished += check['not established'];
      t.words += sig.words;
      if (s) {
        t.errors += s.factualErrors.length;
        t.unsupported += s.unsupportedClaims.length;
        t.claims += s.coveredClaims / Math.max(1, facts.claims.length);
        t.context += s.coveredContext / Math.max(1, facts.context.length);
        t.uncertainty += s.honestUncertainty / Math.max(1, facts.uncertainties.length);
        t.traps += s.trapsHit.length;
        if (!Number.isNaN(rubric)) {
          t.rubric += rubric;
          t.rubricN++;
        }
        if (judgment!.preferred === label) t.preferred++;
      }
      const flags = Object.entries(sig)
        .filter(
          ([k, v]) =>
            v === true &&
            k !== 'reviewPointer' &&
            k !== 'reviewerQuestion' &&
            k !== 'feedbackWanted',
        )
        .map(([k]) => k);
      if (sig.reviewPointer) flags.push('+reviewPointer');
      if (sig.feedbackWanted) flags.push('+feedbackWanted');
      if (sig.reviewerQuestion) flags.push('+reviewerQuestion');
      lines.push(
        `| ${variant} | ${sig.words} | ${s ? s.factualErrors.length : '–'} | ${s ? s.unsupportedClaims.length : '–'} | ${s ? `${s.coveredClaims}/${facts.claims.length}` : '–'} | ${s ? `${s.coveredContext}/${facts.context.length}` : '–'} | ${s ? `${s.honestUncertainty}/${facts.uncertainties.length}` : '–'} | ${s ? s.trapsHit.length : '–'} | ${Number.isNaN(rubric) ? '–' : rubric.toFixed(2)} | ${check.contradicted} / ${check['not established']} | ${flags.join(', ')} |`,
      );
      rows.push({
        case: c.id,
        heldOut: !!c.heldOut,
        variant,
        ...sig,
        check,
        ...(s ?? {}),
        rubricMean: rubric,
      });
    }
    if (judgment)
      lines.push(
        '',
        `Judge preferred: ${judgment.preferred === 'tie' ? 'tie' : judgment.labels[judgment.preferred]}`,
      );
    lines.push('');
  }
  lines.splice(
    2,
    0,
    '| variant | cases | errors | unsupported | claims % | context % | uncertainty % | traps | rubric | words | check C / NE | preferred |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(totals).map(
      ([v, t]) =>
        `| ${v} | ${t.n} | ${t.errors} | ${t.unsupported} | ${Math.round((t.claims / t.n) * 100)} | ${Math.round((t.context / t.n) * 100)} | ${Math.round((t.uncertainty / t.n) * 100)} | ${t.traps} | ${t.rubricN ? (t.rubric / t.rubricN).toFixed(2) : '–'} | ${Math.round(t.words / t.n)} | ${t.contradicted} / ${t.notEstablished} | ${t.preferred} |`,
    ),
    '',
  );
  writeFileSync(join(ROOT, 'report.md'), lines.join('\n'));
  writeFileSync(join(ROOT, 'report.json'), JSON.stringify({ totals, rows }, null, 2));
  console.log(lines.join('\n'));
  console.log(`\nReport: ${join(ROOT, 'report.md')}`);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'prepare') prepare();
  else if (cmd === 'score') score();
  else if (cmd === 'rubric') console.log(`Rubric v${JUDGE_RUBRIC_VERSION}\n\n${JUDGE_RUBRIC}`);
  else console.log('usage: bun scripts/eval-descriptions.ts prepare|score|rubric');
}
