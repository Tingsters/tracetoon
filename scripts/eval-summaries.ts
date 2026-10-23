// Evaluates digests against real past work with known ground truth.
//
//   bun scripts/eval-summaries.ts [--json]
//
// Reads this machine's real agent logs, so it is local only: the report goes to
// .git/tracetoon/eval/<time>/ and nothing it produces is committed. Edit CASES to
// match your own history.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { buildDigest, type TraceDigest } from '../src/digest/build.ts';
import { scan } from '../src/pipeline.ts';

interface Check {
  what: string;
  ok: boolean;
  detail?: string;
}

interface Case {
  name: string;
  repo: string;
  base?: string;
  head?: string;
  expect: (d: TraceDigest) => Check[];
}

const dev = resolve(homedir(), 'Development');
const prompts = (d: TraceDigest) =>
  d.sessions.flatMap((s) => s.prompts.map((p) => p.text));
const milestones = (d: TraceDigest) => d.sessions.flatMap((s) => s.milestones);
const hasPrompt = (d: TraceDigest, text: string): Check => ({
  what: `prompt "${text}" captured`,
  ok: prompts(d).some((p) => p.toLowerCase().includes(text.toLowerCase())),
});
const noPrompt = (d: TraceDigest, text: string, why: string): Check => ({
  what: `no prompt "${text}" (${why})`,
  ok: !prompts(d).some(
    (p) =>
      p.toLowerCase().trim() === text.toLowerCase() ||
      p.toLowerCase().includes(text.toLowerCase()),
  ),
});
const milestone = (d: TraceDigest, text: string): Check => ({
  what: `milestone "${text}"`,
  ok: milestones(d).some((m) => m.includes(text)),
  detail: milestones(d).join('; '),
});
const eq = (what: string, got: unknown, want: unknown): Check => ({
  what: `${what} = ${String(want)}`,
  ok: got === want,
  detail: `got ${String(got)}`,
});
const atLeast = (what: string, got: number, want: number): Check => ({
  what: `${what} >= ${want}`,
  ok: got >= want,
  detail: `got ${got}`,
});
const files = (d: TraceDigest) => d.files.map((f) => f.path);

const CASES: Case[] = [
  {
    name: 'PR #1 doctor change (Claude Code)',
    repo: join(dev, 'tracetoon'),
    base: 'cbd8f79',
    head: 'a2c019f', // PR #1 as first published, before main was merged into it
    expect: (d) => [
      eq('included sessions', d.sessions.filter((s) => s.band === 'included').length, 1),
      hasPrompt(d, 'create a new pr for tracetoon with it'),
      noPrompt(d, 'install it locally', 'asked before the branch existed'),
      milestone(d, 'tests went from failing to passing'),
      eq(
        'edits that did not survive',
        d.sessions.reduce((n, s) => n + s.discardedEdits, 0),
        0,
      ),
      eq('commits made in sessions', d.stats.commitsMadeInSessions, 2),
      {
        what: 'only doctor files and the bundle changed',
        ok: files(d).every((f) => /doctor|tracetoon\.mjs/.test(f)),
        detail: files(d).join(', '),
      },
    ],
  },
  {
    name: 'PR #1 after merging main into it',
    repo: join(dev, 'tracetoon'),
    // Pinned to PR #1's merge commit: main before the merge, and the branch tip.
    base: 'c62818f^1',
    head: 'c62818f^2',
    expect: (d) => [
      hasPrompt(d, 'create a new pr for tracetoon with it'),
      atLeast('agent-matched lines %', d.stats.agentMatchedPct, 60),
      eq('PR commits (merges excluded)', d.stats.commits, 2),
      eq('commits made in sessions', d.stats.commitsMadeInSessions, 2),
    ],
  },
  {
    name: 'PR #3 default PR hook (Claude Code)',
    repo: join(dev, 'tracetoon'),
    base: '115db17',
    head: '3675b42',
    expect: (d) => [
      hasPrompt(d, 'why did you make a tracetoon for the readme'),
      hasPrompt(d, 'why do you have to decide all pr'),
      noPrompt(d, 'install it locally', 'before the branch'),
      noPrompt(d, 'publish', 'belongs to PR #1'),
      milestone(d, 'plan approved'),
      atLeast(
        'decisions',
        d.sessions.reduce((n, s) => n + s.decisions.length, 0),
        2,
      ),
      eq('commits made in sessions', d.stats.commitsMadeInSessions, 1),
      {
        what: 'edited files are all in this PR (no later work)',
        ok: d.sessions.flatMap((x) => x.filesEdited).every((f) => files(d).includes(f)),
        detail: d.sessions
          .flatMap((x) => x.filesEdited)
          .filter((f) => !files(d).includes(f))
          .join(', '),
      },
    ],
  },
  {
    name: 'Codex and Antigravity adapters (Claude Code)',
    repo: join(dev, 'tracetoon'),
    base: '88a4f41',
    head: '2f4fc1b',
    expect: (d) => [
      eq('included sessions', d.sessions.filter((s) => s.band === 'included').length, 1),
      hasPrompt(d, 'continue'),
      {
        what: 'codex and antigravity adapters in files',
        ok: ['src/trace/codex.ts', 'src/trace/antigravity.ts'].every((f) =>
          files(d).includes(f),
        ),
      },
      eq('commits made in sessions', d.stats.commitsMadeInSessions, 2),
      hasPrompt(d, 'publish it publicly'),
      atLeast('agent-matched lines %', d.stats.agentMatchedPct, 60),
    ],
  },
  {
    name: 'Comics milestone (Claude Code)',
    repo: join(dev, 'tracetoon'),
    base: '2f4fc1b',
    head: 'e9993f0',
    expect: (d) => [
      hasPrompt(d, 'continue through with all the steps'),
      noPrompt(d, 'install it locally', 'much later'),
      { what: 'comic modules in files', ok: files(d).includes('src/comic/compose.ts') },
      atLeast('agent-matched lines %', d.stats.agentMatchedPct, 60),
    ],
  },
  {
    name: 'Showtail library extraction (Claude Code, shell edits)',
    repo: join(dev, 'Showtail'),
    base: 'ce5b776',
    head: 'e74fd9a',
    expect: (d) => [
      hasPrompt(d, 'The world needs a better PR system'),
      milestone(d, 'plan approved'),
      eq('commits made in sessions', d.stats.commitsMadeInSessions, 3),
      {
        what: 'test runs recorded',
        ok: d.sessions.some((s) => s.commands.some((c) => c.isTest)),
      },
    ],
  },
  {
    name: 'vexaim-cli Codex work (committed later as 0723dbf)',
    repo: join(dev, 'vexaim-cli'),
    base: '0723dbf^',
    head: '0723dbf',
    expect: (d) => [
      {
        what: 'a Codex session included',
        ok: d.sessions.some((s) => s.agent === 'Codex' && s.band === 'included'),
      },
      atLeast('agent-matched lines %', d.stats.agentMatchedPct, 70),
      {
        what: 'Claude sessions that only looked around are not included',
        ok: !d.sessions.some((s) => s.agent === 'Claude Code' && s.band === 'included'),
      },
    ],
  },
];

function privacy(d: TraceDigest, repoName: string): Check[] {
  const text = JSON.stringify(d);
  const user = homedir().split(/[\\/]/).pop()!;
  const others = ['vexaim', 'Nextcloud', 'Showtail', 'tracetoon'].filter(
    (r) => r.toLowerCase() !== repoName.toLowerCase(),
  );
  return [
    { what: 'no username', ok: !new RegExp(`\\b${user}\\b`, 'i').test(text) },
    {
      what: 'no home or absolute paths',
      ok: !/[A-Za-z]:\\\\Users|\/c\/Users|\/home\//i.test(text),
    },
    {
      what: 'no other repos named in prompts',
      ok: !prompts(d).some((p) =>
        others.some(
          (o) =>
            p.toLowerCase().includes(o.toLowerCase()) && !/showtail|tracetoon/i.test(o),
        ),
      ),
    },
  ];
}

const json = process.argv.includes('--json');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const outDir = join(dev, 'tracetoon', '.git', 'tracetoon', 'eval', stamp);
mkdirSync(outDir, { recursive: true });
const results: { name: string; checks: Check[]; digest: TraceDigest }[] = [];
for (const c of CASES) {
  const { truth, matches } = scan(c.repo, { base: c.base, head: c.head, noGh: true });
  const d = buildDigest(truth, matches);
  writeFileSync(
    join(outDir, `${c.name.replace(/[^\w]+/g, '-')}.json`),
    JSON.stringify(d, null, 2),
  );
  results.push({
    name: c.name,
    checks: [...c.expect(d), ...privacy(d, c.repo.split(/[\\/]/).pop()!)],
    digest: d,
  });
}

const lines: string[] = [`# Summary evaluation ${stamp}`, ''];
let pass = 0;
let total = 0;
for (const r of results) {
  const ok = r.checks.filter((c) => c.ok).length;
  pass += ok;
  total += r.checks.length;
  lines.push(`## ${r.name}: ${ok}/${r.checks.length}`, '');
  for (const c of r.checks)
    lines.push(
      `- ${c.ok ? 'PASS' : 'FAIL'} ${c.what}${!c.ok && c.detail ? ` (${c.detail})` : ''}`,
    );
  const d = r.digest;
  lines.push(
    '',
    `Sessions: ${d.sessions.map((s) => `${s.agent} "${s.title ?? ''}" ${s.band} ${s.score}`).join('; ') || 'none'}`,
    `Stats: ${JSON.stringify(d.stats)}`,
    `Prompts: ${prompts(d)
      .map((p) => JSON.stringify(p.slice(0, 70)))
      .join(' | ')}`,
    `Tests: ${d.sessions.flatMap((s) => s.commands.filter((c) => c.isTest).map((c) => `${c.cmd} x${c.count} (${c.failures} failed)`)).join(', ') || 'none'}`,
    `Milestones: ${milestones(d).join('; ') || 'none'}`,
    '',
  );
}
lines.splice(1, 0, `**${pass}/${total} checks pass.**`);
writeFileSync(join(outDir, 'report.md'), lines.join('\n'));
if (json)
  console.log(
    JSON.stringify(
      {
        outDir,
        pass,
        total,
        results: results.map((r) => ({ name: r.name, checks: r.checks })),
      },
      null,
      2,
    ),
  );
else console.log(lines.join('\n') + `\n\nReport: ${join(outDir, 'report.md')}`);
