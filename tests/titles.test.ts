/**
 * PR titles: what the repository asks for, and advisory checks that keep
 * meaning and format apart. Examples come from the title research (real PRs in
 * CPython, Rust, pytest, Tokio, curl) and from Tracetoon's own history.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkTitle, titleCore } from '../src/digest/titleCheck.ts';
import {
  readTitleRules,
  summarizeTitles,
  type TitleRules,
} from '../src/github/titleRules.ts';
import { encodeMeta, titleHash } from '../src/github/body.ts';
import { makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(60_000);

const states = (title: string, more: Parameters<typeof checkTitle>[0] = { title }) =>
  checkTitle({ ...more, title }).map((f) => `${f.state}:${f.check}`);

function repoWith(files: Record<string, string>): string {
  const root = tempDir('tracetoon-titles-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('good titles pass', () => {
  test.each([
    'gh-126024: optimize UTF-8 decoder for short non-ASCII string',
    'Fix ICE when multiple RegionOriginNotes add same diagnostic arg',
    'Add tokio::task::spawn_named and deprecate Builder::name',
    'Revert "Speed up NLL with HybridIdxSetBuf"',
    'Commands quoted inside scripts and heredocs no longer count as test runs',
    "Keep a PR's own work when the base branch is merged into it",
    'doctor: show where the skill is installed',
    'Require Ruby 2.4.1 or newer',
  ])('%s', (title) => {
    expect(states(title)).toEqual([]);
  });
});

describe('titles that need another look', () => {
  test('an issue number alone, or a generic phrase, does not identify the change', () => {
    expect(states('Fix #7432')).toEqual(['revise:distinction']);
    expect(states('gh-12345')).toEqual(['revise:distinction']);
    expect(states('Fix bug')).toEqual(['revise:distinction']);
    expect(states('Update README')).toEqual(['revise:distinction']);
  });

  test('taglines, lists, filler and length are flagged; nothing is cut', () => {
    const t =
      "Don't miss the session that did the work: shell edits, quiet commits, running commands";
    const f = checkTitle({ title: t });
    expect(f.map((x) => x.check)).toEqual(['shape', 'shape', 'shape']);
    expect(f.map((x) => x.reason).join(' ')).toContain('tagline');
    expect(states('This PR improves robustness and code quality')).toEqual([
      'revise:shape',
    ]);
    expect(states('Clarify the install steps in the README.')).toEqual([
      'uncertain:shape',
    ]);
  });

  test('a performance claim needs a captured measurement', () => {
    const digest = { files: [], pr: { commits: [] }, sessions: [] } as any;
    expect(states('Speed up NLL with HybridIdxSetBuf', { title: '', digest })).toEqual([
      'uncertain:truth',
    ]);
    const measured = {
      ...digest,
      sessions: [{ runs: [{ kind: 'eval', cmd: 'bun scripts/bench.ts' }] }],
    };
    expect(
      states('Speed up NLL with HybridIdxSetBuf', { title: '', digest: measured }),
    ).toEqual([]);
  });

  test('docs-only or tests-only changes should say so', () => {
    const docs = {
      files: [{ path: 'README.md', role: 'docs' }],
      pr: { commits: [] },
      sessions: [],
    } as any;
    expect(states('Fix the scheduler fairness', { title: '', digest: docs })).toEqual([
      'revise:truth',
    ]);
    expect(
      states('Explain the scheduler fairness rules', { title: '', digest: docs }),
    ).toEqual([]);
    const tests = {
      files: [{ path: 'tests/a.test.ts', role: 'tests' }],
      pr: { commits: [] },
      sessions: [],
    } as any;
    expect(states('Handle empty exports', { title: '', digest: tests })).toEqual([
      'uncertain:truth',
    ]);
  });

  test('a title that is only the latest of several commits is questioned', () => {
    const digest = {
      files: [],
      sessions: [],
      pr: {
        commits: [
          { subject: 'feat: export CSV with headers' },
          { subject: 'fix lint warnings in exporter' },
        ],
      },
    } as any;
    expect(states('Fix lint warnings in exporter', { title: '', digest })).toEqual([
      'uncertain:scope',
    ]);
  });
});

describe('repository rules', () => {
  const conventional: TitleRules = {
    excerpts: [],
    destinations: [],
    conventional: { types: ['feat', 'fix', 'docs'], source: '.github/workflows/pr.yml' },
  };

  test('a required type is checked, and a disallowed one named', () => {
    expect(states('Add CSV export', { title: '', rules: conventional })).toEqual([
      'revise:compliance',
    ]);
    expect(states('perf: faster CSV export', { title: '', rules: conventional })[0]).toBe(
      'revise:compliance',
    );
    expect(
      states('feat: add CSV export with headers', { title: '', rules: conventional }),
    ).toEqual([]);
    // A valid prefix doesn't make a vague title good.
    expect(states('fix: bug', { title: '', rules: conventional })).toEqual([
      'revise:distinction',
    ]);
  });

  test("a type prefix in a repo that doesn't use them is questioned", () => {
    const rules: TitleRules = {
      excerpts: [],
      destinations: [],
      recent: summarizeTitles(['Add X to Y', 'Fix Z when W', 'Keep A when B']),
    };
    expect(states('feat: add CSV export with headers', { title: '', rules })).toEqual([
      'uncertain:compliance',
    ]);
  });

  test('issue prefix and length limits come from the docs', () => {
    const root = repoWith({
      'CONTRIBUTING.md':
        '# Contributing\n\nPR titles must start with the issue number, like gh-NNNN: followed by a summary.\nKeep pull request titles under 60 characters.\n',
    });
    const r = readTitleRules(root, { offline: true });
    expect(r.issuePrefix?.example).toBe('gh-NNNN');
    expect(r.maxLength?.value).toBe(60);
    expect(states('Fix urllib timeout in the FTP test', { title: '', rules: r })).toEqual(
      ['revise:compliance'],
    );
    expect(
      states('gh-143507: Fix FTP socket access in test_urllib2net', {
        title: '',
        rules: r,
      }),
    ).toEqual([]);
    expect(titleCore('gh-143507: Fix FTP socket access')).toBe('Fix FTP socket access');
  });

  test('a semantic-title workflow, commitlint types and release tooling are found', () => {
    const root = repoWith({
      '.github/workflows/pr-title.yml':
        'on: pull_request_target\njobs:\n  lint:\n    steps:\n      - uses: amannn/action-semantic-pull-request@v5\n        with:\n          types: |\n            feat\n            fix\n            chore\n',
      '.github/workflows/release.yml':
        'jobs:\n  draft:\n    steps:\n      - uses: release-drafter/release-drafter@v6\n',
    });
    const r = readTitleRules(root, { offline: true });
    expect(r.conventional).toEqual({
      types: ['feat', 'fix', 'chore'],
      source: '.github/workflows/pr-title.yml',
    });
    expect(r.destinations[0]).toContain('Release Drafter');

    const lint = repoWith({
      '.github/workflows/ci.yml':
        'on: pull_request\njobs:\n  t:\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}" | npx commitlint\n',
      'commitlint.config.js':
        "module.exports = { rules: { 'type-enum': [2, 'always', ['feat', 'fix', 'perf']] } };\n",
    });
    expect(readTitleRules(lint, { offline: true }).conventional?.types).toEqual([
      'feat',
      'fix',
      'perf',
    ]);
  });

  test('a repo with no title rules says nothing', () => {
    expect(
      readTitleRules(repoWith({ 'README.md': '# Hello\n' }), { offline: true }),
    ).toEqual({
      excerpts: [],
      destinations: [],
    });
  });
});

describe('keeping a title a person chose', () => {
  const CLI = process.env.TRACETOON_TEST_CLI ?? join(import.meta.dir, '../src/cli.ts');
  const run = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    return { code: r.status, json: JSON.parse(r.stdout || '{}') };
  };

  test("an existing PR's own title is kept unless --retitle; a title Tracetoon posted can change", () => {
    const repo = makeRepo();
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: tempDir('tracetoon-claude-'),
      CODEX_HOME: tempDir('tracetoon-codex-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
    };
    repo.commit('src/a.ts', 'export const a = 1;\n', 'feat: export a');
    const d = run(repo.root, env, 'digest', '--offline');
    expect(run(repo.root, env, 'context', '--offline').code).toBe(0);
    const dir = d.json.runDir as string;
    writeFileSync(join(dir, 'body.md'), 'Exports `a`.\n');
    writeFileSync(join(dir, 'title.txt'), 'Export the a constant\n');
    const ctxPath = join(dir, 'context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    const withPr = (title: string, body: string) =>
      writeFileSync(
        ctxPath,
        JSON.stringify({ ...ctx, existingPr: { number: 3, url: 'u', title, body } }),
      );

    // Written by a person (no Tracetoon metadata): kept.
    withPr('Expose a for the CLI', 'Hand-written description.');
    let r = run(repo.root, env, 'render');
    expect(r.json.title).toBe('Expose a for the CLI');
    expect(r.json.titleNote).toContain('--retitle');
    r = run(repo.root, env, 'render', '--retitle');
    expect(r.json.title).toBe('Export the a constant');

    // Posted by Tracetoon and unchanged since: the new title replaces it.
    const posted = 'Export a';
    withPr(posted, encodeMeta({ v: 1, titleSha: titleHash(posted) }));
    expect(run(repo.root, env, 'render').json.title).toBe('Export the a constant');

    // Posted by Tracetoon, then edited on GitHub: kept.
    withPr('Export a (for the CLI)', encodeMeta({ v: 1, titleSha: titleHash(posted) }));
    r = run(repo.root, env, 'render');
    expect(r.json.title).toBe('Export a (for the CLI)');
    expect(r.json.titleNote).toContain('edited on GitHub');
  });
});
