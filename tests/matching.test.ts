/**
 * Session matching in the cases that once dropped a real session: edits made
 * with shell commands, quiet commits whose message has escaped quotes, a commit
 * named only by push output, a command still running when the digest reads the
 * log, long output, an agent launched outside the repo, and a session left out
 * that should at least be mentioned.
 */
import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  normalizeShell,
  normalizeText,
  pushLine,
  worksOnBranch,
} from '../src/correlate/correlate.ts';
import { headTail } from '../src/trace/diffLines.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(60_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const GREET = [
  'export function greet(name: string): string {',
  '  return `Hello, ${name}!`;',
  '}',
];

let claudeHome: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  claudeHome = tempDir('tracetoon-claude-');
  env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: tempDir('tracetoon-codex-'),
    ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
    GEMINI_HOME: tempDir('tracetoon-gemini-'),
    TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
  };
});

/** Digest of the repo's branch: the CLI's JSON plus the digest file. */
function digest(root: string, extra: string[] = []) {
  const r = spawnSync(
    process.execPath,
    [CLI, '--json', 'digest', '--offline', ...extra],
    {
      cwd: root,
      env,
      encoding: 'utf8',
    },
  );
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout);
  return { out, full: JSON.parse(readFileSync(out.digestPath, 'utf8')) };
}

describe('shell edits', () => {
  test('a session whose edits were all made with shell commands is matched', () => {
    const repo = makeRepo();
    // Launched from a parent folder: every record says branch "HEAD".
    new ClaudeLog(repo.root, 'HEAD')
      .prompt('Add a greeting helper')
      .bashEdit(`python3 - <<'PY'\nopen('src/greet.ts','w').write(...)\nPY`, [
        { filePath: join(repo.root, 'src/greet.ts'), added: GREET },
      ])
      .save(claudeHome, 's1');
    repo.commit('src/greet.ts', GREET.join('\n') + '\n', 'feat: greeting helper');
    const { out, full } = digest(repo.root);
    expect(out.sessions.map((s: any) => s.band)).toEqual(['included']);
    expect(full.stats.agentMatchedPct).toBe(100);
    expect(full.sessions[0].milestones).toContain('edited 1 file(s)');
  });
});

describe('quiet commits', () => {
  test('a -q commit whose message has escaped quotes is credited, in Bash and PowerShell', () => {
    for (const [tool, cmd] of [
      ['bash', 'git add -A && git commit -q -m "feat: say \\"hello\\" to everyone"'],
      ['shell', 'git commit -q -m "feat: say `"hello`" to everyone"'],
    ] as const) {
      const repo = makeRepo();
      const log = new ClaudeLog(repo.root, 'HEAD').prompt('Greet everyone');
      (tool === 'bash' ? log.bash(cmd) : log.shell(cmd)).save(claudeHome, `s-${tool}`);
      repo.commit('src/greet.ts', 'x\n', 'feat: say "hello" to everyone');
      const { full } = digest(repo.root);
      expect(full.stats.commitsMadeInSessions).toBe(1);
      expect(full.sessions[0].band).toBe('included');
    }
  });

  test('push output names the commit only when the same command committed', () => {
    const repo = makeRepo();
    const sha = repo.commit('src/greet.ts', 'x\n', 'feat: greeting helper for the CLI');
    const pushed = `To github.com:acme/demo.git\n   1234567..${sha.slice(0, 7)}  feature -> feature`;
    // Committed from a message file (no subject in the command), then pushed.
    new ClaudeLog(repo.root, 'HEAD')
      .bash('git commit -q -F msg.txt && git push', pushed)
      .save(claudeHome, 'with-commit');
    expect(digest(repo.root).full.stats.commitsMadeInSessions).toBe(1);

    const other = makeRepo();
    const sha2 = other.commit('src/greet.ts', 'x\n', 'feat: greeting helper for the CLI');
    new ClaudeLog(other.root, 'HEAD')
      .bash('git push', `   1234567..${sha2.slice(0, 7)}  feature -> feature`)
      .save(claudeHome, 'push-only', 'other');
    expect(digest(other.root).full.stats.commitsMadeInSessions).toBe(0);
  });

  test('a commit line printed after long output is still found', () => {
    const repo = makeRepo();
    const sha = repo.commit('src/greet.ts', 'x\n', 'wip');
    new ClaudeLog(repo.root, 'HEAD')
      .bash(
        'bun test && git commit -m wip',
        `${'.'.repeat(6000)}\n[feature ${sha.slice(0, 7)}] wip`,
      )
      .save(claudeHome, 's1');
    expect(digest(repo.root).full.stats.commitsMadeInSessions).toBe(1);
  });
});

describe('commands still running', () => {
  test('a commit in the same tool call as the digest is credited', () => {
    const repo = makeRepo();
    new ClaudeLog(repo.root, 'HEAD')
      .prompt('Commit it and open the PR')
      .pending('git commit -q -m "feat: greeting helper for people" && tracetoon digest')
      .save(claudeHome, 's1');
    repo.commit('src/greet.ts', 'x\n', 'feat: greeting helper for people');
    const { full } = digest(repo.root);
    expect(full.stats.commitsMadeInSessions).toBe(1);
    expect(full.sessions[0].band).toBe('included');
  });
});

describe('sessions that did less', () => {
  test('an agent launched outside the repo still gets the branch signal from its commands', () => {
    const repo = makeRepo();
    new ClaudeLog(repo.root, 'HEAD')
      .prompt('Push the branch')
      .bash(`cd ${repo.root} && git push -u origin feature`)
      .save(claudeHome, 's1');
    repo.commit('src/greet.ts', 'x\n', 'feat: greeting helper written by hand');
    const { full } = digest(repo.root);
    expect(full.sessions[0]?.reasons).toContain('worked on branch feature');
  });

  test('a session left out that worked in the repo is mentioned, with how to add it', () => {
    const repo = makeRepo();
    new ClaudeLog(repo.root, 'HEAD')
      .prompt('Look around')
      .bash('ls')
      .save(claudeHome, 's1');
    repo.commit('src/greet.ts', 'x\n', 'feat: greeting helper written by hand');
    const { out, full } = digest(repo.root);
    expect(out.sessions).toEqual([]);
    const note = full.notes.find((n: string) => n.startsWith('Left out:'));
    expect(note).toContain('--include h:');
    expect(note).toContain('worked in this repo while the commits were made');
    const ref = /--include (h:[a-f0-9]+)/.exec(note!)![1]!;
    const excluded = digest(repo.root, ['--run', out.run, '--exclude', ref]);
    expect(excluded.full.notes.some((n: string) => n.startsWith('Left out:'))).toBe(
      false,
    );
    const refreshed = digest(repo.root, ['--run', out.run]);
    expect(refreshed.full.notes.some((n: string) => n.startsWith('Left out:'))).toBe(
      false,
    );
  });
});

describe('matching helpers', () => {
  test('commit messages read the way the shell will', () => {
    const subject = normalizeText('fix: it\'s "done"  now');
    expect(normalizeShell(`git commit -m 'fix: it'\\''s "done" now'`)).toContain(subject);
    expect(normalizeShell('git commit -m "fix: it\'s \\"done\\" now"')).toContain(
      subject,
    );
    expect(normalizeShell('git commit -m "fix: it\'s `"done`" now"')).toContain(subject);
  });

  test('push lines, branch work and long output', () => {
    expect(pushLine('5f0b550f').test('   b62c2ff..5f0b550  fix/x -> fix/x')).toBe(true);
    expect(pushLine('5f0b550f').test(' * [new branch]      fix/x -> fix/x')).toBe(false);
    expect(worksOnBranch('git checkout -q -b fix/x', 'fix/x')).toBe(true);
    expect(worksOnBranch('git push -u origin fix/x-2', 'fix/x')).toBe(false);
    const t = headTail(`${'a'.repeat(5000)}END`);
    expect(t.length).toBeLessThan(4100);
    expect(t.endsWith('END')).toBe(true);
    expect(git('.', ['--version']).ok).toBe(true);
  });
});
