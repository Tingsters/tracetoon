// Regression tests for problems found by evaluating digests against real work.
import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commandKey, testOutputFailed, testSegment } from '../src/digest/build.ts';
import { parseUnifiedDiff } from '../src/git/pr.ts';
import { parseClaudeLines } from '../src/trace/claude.ts';
import type { TraceSession } from '../src/trace/types.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(60_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');

describe('test results', () => {
  test('failures are read from output, so piped runs count', () => {
    expect(testOutputFailed(' 59 pass\n 1 fail\n Ran 60 tests')).toBe(true);
    expect(testOutputFailed(' 60 pass\n 0 fail\n')).toBe(false);
    expect(testOutputFailed('=== 2 failed, 10 passed in 1.2s ===')).toBe(true);
    expect(testOutputFailed('Tests:       1 failed, 4 passed, 5 total')).toBe(true);
    expect(testOutputFailed('FAIL src/x.test.ts')).toBe(true);
    expect(testOutputFailed('--- FAIL: TestX (0.00s)')).toBe(true);
    expect(testOutputFailed('test result: FAILED. 1 passed; 1 failed')).toBe(true);
    expect(testOutputFailed('all good, nothing failed here? no: 0 failed')).toBe(false);
  });

  test('chained commands are labeled by their test runner', () => {
    const cmd = "sed -i 's/a/b/' x.ts && bun x tsc --noEmit && bun test 2>&1 | tail -3";
    expect(testSegment(cmd)).toBe('bun test 2>&1');
    expect(commandKey(testSegment(cmd)!)).toBe('bun test');
  });
});

describe('diffs', () => {
  test('binary file changes are counted', () => {
    const diff =
      'diff --git a/docs/x.png b/docs/x.png\ndeleted file mode 100644\nBinary files a/docs/x.png and /dev/null differ\n';
    expect(parseUnifiedDiff(diff).map((f) => f.path)).toEqual(['docs/x.png']);
  });
});

describe('rejection feedback', () => {
  test('what the user types when rejecting a tool call is kept as feedback', () => {
    const s: TraceSession = {
      agent: 'claude-code',
      sessionId: 's',
      source: 'x',
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    const lines = [
      {
        type: 'user',
        timestamp: '2026-10-23T10:00:00Z',
        cwd: '/r',
        message: { role: 'user', content: 'Plan it' },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-23T10:00:01Z',
        cwd: '/r',
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { plan: '# P' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-10-23T10:00:02Z',
        cwd: '/r',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content:
                "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nresearch common practice first",
            },
          ],
        },
      },
    ];
    parseClaudeLines(lines.map((l) => JSON.stringify(l)).join('\n'), s);
    const prompts = s.records.filter((r) => r.kind === 'prompt');
    expect(prompts.map((p) => (p as { text: string }).text)).toEqual([
      'Plan it',
      'research common practice first',
    ]);
    expect(prompts[1]).toMatchObject({ feedback: true });
    expect(s.records.find((r) => r.kind === 'plan')).toMatchObject({ approved: false });
  });
});

describe('earlier work stays out', () => {
  let env: NodeJS.ProcessEnv;
  let claudeHome: string;
  beforeEach(() => {
    claudeHome = tempDir('tracetoon-claude-');
    env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(tempDir('tracetoon-cfg-'), 'c.json'),
    };
  });

  test('prompts and edits from work already in the base branch are left out', () => {
    const repo = makeRepo();
    const start = Date.now() - 20 * 60_000;
    // Earlier PR: done and committed in the same session, then merged into main.
    const earlier = repo.commit(
      'docs/old.md',
      'old feature notes line\n',
      'docs: earlier feature',
    );
    git(repo.root, ['checkout', '-q', 'main']);
    git(repo.root, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge earlier']);
    git(repo.root, ['checkout', '-q', '-b', 'next']);
    const later = repo.commit(
      'src/new.ts',
      'export const brandNewThing = 42;\n',
      'feat: the new thing',
    );
    new ClaudeLog(repo.root, 'feature', start)
      .prompt('EARLIER-REQUEST write the old notes')
      .write(join(repo.root, 'docs/old.md'), 'old feature notes line\n')
      .write(
        join(repo.root, '.git', 'tracetoon', 'runs', 'x', 'body.md'),
        'a run file inside .git\n',
      )
      .bash('git commit -q -m "docs: earlier feature"', '')
      .bash('git log --oneline -1', `${earlier.slice(0, 7)} docs: earlier feature`)
      .prompt('NEW-REQUEST now build the new thing')
      .write(join(repo.root, 'src/new.ts'), 'export const brandNewThing = 42;\n')
      .bash('git commit -q -m "feat: the new thing"', '')
      .save(claudeHome, 's1');
    void later;
    const r = spawnSync(
      process.execPath,
      [CLI, '--json', 'digest', '--offline', '--base', 'main'],
      { cwd: repo.root, env, encoding: 'utf8' },
    );
    const out = JSON.parse(r.stdout);
    const d = JSON.parse(readFileSync(out.digestPath, 'utf8'));
    const s = d.sessions[0];
    expect(s.prompts.map((p: { text: string }) => p.text)).toEqual([
      'NEW-REQUEST now build the new thing',
    ]);
    expect(s.filesEdited).toEqual(['src/new.ts']);
    expect(s.discardedEdits).toBe(0);
    expect(d.stats.commitsMadeInSessions).toBe(1); // quiet commit found by its subject
  });
});

describe('branches that merged the base in later', () => {
  test("later work merged into the base doesn't push out this PR's own edits", () => {
    const claudeHome = tempDir('tracetoon-claude-');
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(tempDir('tracetoon-cfg-'), 'c.json'),
    };
    const repo = makeRepo();
    const start = Date.now() - 20 * 60_000;
    const at = (s: number) => new Date(start + s * 1000).toISOString();
    const commitAt = (file: string, content: string, msg: string, s: number) => {
      mkdirSync(join(repo.root, file, '..'), { recursive: true });
      writeFileSync(join(repo.root, file), content);
      git(repo.root, ['add', '.']);
      git(repo.root, ['commit', '-q', '-m', msg], undefined, {
        GIT_AUTHOR_DATE: at(s),
        GIT_COMMITTER_DATE: at(s),
      });
      return git(repo.root, ['rev-parse', 'HEAD']).stdout.trim();
    };
    mkdirSync(join(repo.root, 'src'), { recursive: true });
    // This PR's own work comes first (log seconds 0-2, commit at 3)...
    commitAt('src/own.ts', 'export const ownFeatureValue = 7;\n', 'feat: own feature', 3);
    // ...then the same session does other work that lands on main (commit at 7)...
    git(repo.root, ['checkout', '-q', 'main']);
    const other = commitAt(
      'src/other.ts',
      'export const otherWorkValue = 9;\n',
      'feat: other work',
      7,
    );
    // ...and main is merged back into this branch.
    git(repo.root, ['checkout', '-q', 'feature']);
    git(repo.root, ['merge', '-q', '--no-edit', 'main']);
    new ClaudeLog(repo.root, 'feature', start)
      .prompt('OWN-REQUEST build my feature')
      .write(join(repo.root, 'src/own.ts'), 'export const ownFeatureValue = 7;\n')
      .bash('git commit -q -m "feat: own feature"', '')
      .prompt('OTHER-REQUEST do the other thing')
      .write(join(repo.root, 'src/other.ts'), 'export const otherWorkValue = 9;\n')
      .bash('git log --oneline -1', `${other.slice(0, 7)} feat: other work`)
      .save(claudeHome, 's1');
    const r = spawnSync(
      process.execPath,
      [CLI, '--json', 'digest', '--offline', '--base', 'main'],
      {
        cwd: repo.root,
        env,
        encoding: 'utf8',
      },
    );
    const d = JSON.parse(readFileSync(JSON.parse(r.stdout).digestPath, 'utf8'));
    expect(d.stats.commits).toBe(1); // the merge commit isn't the PR's own work
    expect(d.stats.agentMatchedPct).toBe(100);
    expect(d.sessions[0].prompts.map((p: { text: string }) => p.text)).toContain(
      'OWN-REQUEST build my feature',
    );
  });
});
