// Evaluates PR descriptions against hand-checked fact sheets.
//
//   bun scripts/eval-descriptions.ts prepare   # build an evidence packet per case
//   bun scripts/eval-descriptions.ts score     # score descriptions, write the report
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
      /\b(start (with|at|in|by)|where to look|review(ers)? (should|could) (start|look))/i.test(
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
      rubric: Record<string, 0 | 1 | 2 | null>; // problem, rationale, validation, consequences, navigation, economy
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
      '| variant | words | errors | unsupported | claims | context | uncertainty | traps | rubric | signals |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const f of readdirSync(outDir).filter((x) => x.endsWith('.md'))) {
      const variant = f.replace(/\.md$/, '');
      const sig = textSignals(readFileSync(join(outDir, f), 'utf8'));
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
      });
      t.n++;
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
          ([k, v]) => v === true && k !== 'reviewPointer' && k !== 'reviewerQuestion',
        )
        .map(([k]) => k);
      if (sig.reviewPointer) flags.push('+reviewPointer');
      if (sig.reviewerQuestion) flags.push('+reviewerQuestion');
      lines.push(
        `| ${variant} | ${sig.words} | ${s ? s.factualErrors.length : '–'} | ${s ? s.unsupportedClaims.length : '–'} | ${s ? `${s.coveredClaims}/${facts.claims.length}` : '–'} | ${s ? `${s.coveredContext}/${facts.context.length}` : '–'} | ${s ? `${s.honestUncertainty}/${facts.uncertainties.length}` : '–'} | ${s ? s.trapsHit.length : '–'} | ${Number.isNaN(rubric) ? '–' : rubric.toFixed(2)} | ${flags.join(', ')} |`,
      );
      rows.push({
        case: c.id,
        heldOut: !!c.heldOut,
        variant,
        ...sig,
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
    '| variant | cases | errors | unsupported | claims % | context % | uncertainty % | traps | rubric | words | preferred |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(totals).map(
      ([v, t]) =>
        `| ${v} | ${t.n} | ${t.errors} | ${t.unsupported} | ${Math.round((t.claims / t.n) * 100)} | ${Math.round((t.context / t.n) * 100)} | ${Math.round((t.uncertainty / t.n) * 100)} | ${t.traps} | ${t.rubricN ? (t.rubric / t.rubricN).toFixed(2) : '–'} | ${Math.round(t.words / t.n)} | ${t.preferred} |`,
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
  else console.log('usage: bun scripts/eval-descriptions.ts prepare|score');
}
