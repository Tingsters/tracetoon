// Synthetic, source-cited evaluation packets; no real session logs or PR writes.
// bun scripts/eval-contributions.ts prepare|review-inputs|score [output-directory]
// Default output is local scratch under .git/tracetoon/eval-contributions/.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cases from '../tests/fixtures/contribution-cases.json';
import { loadGuidance, objectHash, textHash } from '../src/contribution/guidance.ts';
import { loadReview, reviewInput, reviewSummary } from '../src/contribution/review.ts';
import type { GuidanceRequest } from '../src/contribution/types.ts';
import type { TraceDigest } from '../src/digest/build.ts';
import { detectAiPolicy } from '../src/github/repoContext.ts';
import { readTitleRules } from '../src/github/titleRules.ts';
import { git } from '../src/util/exec.ts';

export interface ContributionCase {
  id: string;
  inspiration?: string;
  guide: string;
  change: string;
  diff: string;
  facts: string[];
  existingBody?: string;
  titlePattern?: string;
  mustInclude: string[];
  mustNotInclude: string[];
}

/** Behavioral probes, not a semantic judge or proof of overall PR quality. */
export function contributionSignals(
  c: ContributionCase,
  title: string,
  body: string,
): string[] {
  const text = `${title}\n${body}`.toLowerCase();
  const errors: string[] = [];
  for (const word of c.mustInclude)
    if (!text.includes(word.toLowerCase()))
      errors.push(`Missing expected content: ${word}`);
  for (const word of c.mustNotInclude)
    if (text.includes(word.toLowerCase()))
      errors.push(`Unsupported or prohibited content: ${word}`);
  if (c.titlePattern && !new RegExp(c.titlePattern).test(title.trim()))
    errors.push("Title does not follow this fixture's convention.");
  if (c.existingBody && !body.includes(c.existingBody))
    errors.push('Existing human text was changed or removed.');
  return errors;
}

function prepare(root: string): void {
  const oldGuide = git(resolve(import.meta.dir, '..'), [
    'show',
    'HEAD:plugin/skills/tracetoon/references/writing-guide.md',
  ]);
  for (const c of cases as ContributionCase[]) {
    const dir = join(root, 'packets', c.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CONTRIBUTING.md'), c.guide);
    writeFileSync(join(dir, 'changes.patch'), c.diff);
    writeFileSync(join(dir, 'author.md'), c.facts.join('\n'));
    const stable = {
      offline: true,
      changedPaths: ['changed-file'],
      sourceSeeds: [
        { location: 'CONTRIBUTING.md', scope: '.', sha256: textHash(c.guide) },
      ],
      changesPath: 'changes.patch',
      headSha: 'synthetic-fixture',
      diffSha256: objectHash(c.diff),
      gaps: [],
    };
    const request: GuidanceRequest = { v: 1, fingerprint: objectHash(stable), ...stable };
    writeFileSync(join(dir, 'guidance-request.json'), JSON.stringify(request, null, 2));
    writeFileSync(
      join(dir, 'request.json'),
      JSON.stringify(
        {
          synthetic: true,
          change: c.change,
          facts: c.facts,
          existingBody: c.existingBody ?? '',
          guidance: 'CONTRIBUTING.md',
          inspiration: c.inspiration,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(dir, 'legacy-context.json'),
      JSON.stringify(
        {
          aiPolicy: detectAiPolicy(dir),
          titleRules: readTitleRules(dir, { offline: true }),
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(dir, 'baseline-writing-guide.md'),
      oldGuide.ok
        ? oldGuide.stdout
        : 'Describe the change faithfully, preserve author text, and follow project conventions.',
    );
    const digest: TraceDigest = {
      v: 1,
      tool: 'synthetic-contribution-evaluation',
      generatedAt: '2026-10-24T12:00:00Z',
      repo: {},
      pr: {
        base: 'main',
        head: 'fixture',
        mergeBase: 'fixture-base',
        usedWorkingTree: false,
        commits: [],
      },
      stats: {
        filesChanged: 1,
        added: 1,
        removed: 0,
        evidenceLines: 1,
        agentMatchedPct: 100,
        unmatchedPct: 0,
        commitsMadeInSessions: 0,
        commits: 0,
      },
      sessions: [],
      files: [
        { path: 'changed-file', added: 1, removed: 0, sessions: [], unmatchedLines: 0 },
      ],
      disclosure: {
        agents: ['Test Assistant'],
        models: [],
        suggestedTrailers: [],
        existingTrailers: [],
      },
      interop: {},
      privacy: { redactions: 0, droppedForeignRecords: 0, sessionIdsHashed: true },
      linkedPrs: [],
      notes: c.facts,
      truncated: [],
    };
    writeFileSync(join(dir, 'digest.json'), JSON.stringify(digest, null, 2));
  }
  writeFileSync(
    join(root, 'README.txt'),
    'Synthetic fixtures inspired by pinned primary sources, verified October 25, 2026 UTC. They are paraphrased scenario inputs, not current project policies. Baseline and three-phase agents have access to the same evidence and CONTRIBUTING.md. Keep separate contexts and do not read the scorer expectations while drafting. Write <variant>.title.txt and <variant>.body.md in each packet. The researcher writes guidance.json; review-inputs prepares the independent reviewer packet; the reviewer writes review.json. Run score afterward. These lexical probes do not measure semantic correctness or establish a causal improvement from delegation.\n',
  );
  process.stdout.write(`Prepared ${cases.length} synthetic packets in ${root}\n`);
}

function prepareReviews(root: string): void {
  for (const c of cases) {
    const dir = join(root, 'packets', c.id);
    const run = { id: c.id, dir };
    const request: GuidanceRequest = JSON.parse(
      readFileSync(join(dir, 'guidance-request.json'), 'utf8'),
    );
    const guidance = loadGuidance(run, dir, request);
    if (!guidance.guidance)
      throw new Error(
        `${c.id}: guidance ${guidance.status}: ${guidance.issues.join('; ')}`,
      );
    const digest: TraceDigest = JSON.parse(
      readFileSync(join(dir, 'digest.json'), 'utf8'),
    );
    const title = readFileSync(join(dir, 'three-phase.title.txt'), 'utf8').trim();
    const body = readFileSync(join(dir, 'three-phase.body.md'), 'utf8');
    const input = reviewInput({
      title,
      body,
      guidance,
      digest,
      diffSha256: request.diffSha256,
      headSha: request.headSha,
      authorText: readFileSync(join(dir, 'author.md'), 'utf8'),
    });
    // These synthetic packets have no comic, GitHub approval or browser preview.
    input.artifacts = input.artifacts.filter(
      (p) => existsSync(join(dir, p)) || p === 'final-body.md',
    );
    writeFileSync(join(dir, 'final-body.md'), body);
    writeFileSync(join(dir, 'review-input.json'), JSON.stringify(input, null, 2));
  }
  process.stdout.write('Prepared independent-review inputs.\n');
}

function score(root: string): void {
  const results: { case: string; variant: string; missing: boolean; errors: string[] }[] =
    [];
  for (const c of cases)
    for (const variant of ['baseline', 'three-phase']) {
      const dir = join(root, 'packets', c.id);
      const titlePath = join(dir, `${variant}.title.txt`);
      const bodyPath = join(dir, `${variant}.body.md`);
      if (!existsSync(titlePath) || !existsSync(bodyPath)) {
        results.push({
          case: c.id,
          variant,
          missing: true,
          errors: ['Output not supplied.'],
        });
        continue;
      }
      const title = readFileSync(titlePath, 'utf8');
      const body = readFileSync(bodyPath, 'utf8');
      const errors = contributionSignals(c, title, body);
      results.push({ case: c.id, variant, missing: false, errors });
    }
  const summaries = ['baseline', 'three-phase'].map((variant) => {
    const rows = results.filter((r) => r.variant === variant);
    return {
      variant,
      supplied: rows.filter((r) => !r.missing).length,
      probesPassing: rows.filter((r) => !r.missing && !r.errors.length).length,
      findings: rows.flatMap((r) => r.errors).length,
    };
  });
  const reviews = cases.map((c) => {
    const dir = join(root, 'packets', c.id);
    if (!existsSync(join(dir, 'review-input.json')))
      return { case: c.id, status: 'missing' };
    const request: GuidanceRequest = JSON.parse(
      readFileSync(join(dir, 'guidance-request.json'), 'utf8'),
    );
    const guidance = loadGuidance({ id: c.id, dir }, dir, request);
    const digest: TraceDigest = JSON.parse(
      readFileSync(join(dir, 'digest.json'), 'utf8'),
    );
    const input = reviewInput({
      title: readFileSync(join(dir, 'three-phase.title.txt'), 'utf8').trim(),
      body: readFileSync(join(dir, 'three-phase.body.md'), 'utf8'),
      guidance,
      digest,
      diffSha256: request.diffSha256,
      headSha: request.headSha,
      authorText: readFileSync(join(dir, 'author.md'), 'utf8'),
    });
    return {
      case: c.id,
      ...reviewSummary(
        loadReview(
          { id: c.id, dir },
          input,
          guidance,
          digest,
          readFileSync(join(dir, 'changes.patch'), 'utf8'),
        ),
      ),
    };
  });
  writeFileSync(
    join(root, 'report.json'),
    JSON.stringify(
      {
        synthetic: true,
        limitation:
          'Lexical probes and handoff validation, not a semantic quality score or causal experiment.',
        summaries,
        results,
        reviews,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, 'report.md'),
    [
      '# Contributor workflow evaluation',
      '',
      'Synthetic scenarios inspired by pinned sources. Lexical probes do not certify compliance or prove delegation improves quality.',
      '',
      ...summaries.map(
        (s) =>
          `- ${s.variant}: ${s.supplied}/${cases.length} outputs; ${s.probesPassing} pass lexical probes; ${s.findings} probe findings.`,
      ),
      '',
      ...reviews.map((r) => `- ${r.case}: review ${r.status}`),
      '',
      ...results
        .filter((r) => r.errors.length)
        .map((r) => `- ${r.case} (${r.variant}): ${r.errors.join('; ')}`),
    ].join('\n'),
  );
  process.stdout.write(
    `${JSON.stringify(summaries)}\nReport: ${join(root, 'report.md')}\n`,
  );
}

if (import.meta.main) {
  const root = resolve(
    process.argv[3] ?? join(import.meta.dir, '../.git/tracetoon/eval-contributions'),
  );
  const action = process.argv[2];
  if (action === 'prepare') prepare(root);
  else if (action === 'review-inputs') prepareReviews(root);
  else if (action === 'score') score(root);
  else
    throw new Error(
      'Usage: bun scripts/eval-contributions.ts prepare|review-inputs|score [output-directory]',
    );
}
