import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

const CLI = resolve(import.meta.dir, '../src/cli.ts');
const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');

let claudeHome: string;
let env: NodeJS.ProcessEnv;
let ghLog: string;

beforeEach(() => {
  claudeHome = tempDir('tracetoon-claude-');
  const scratch = tempDir('tracetoon-env-');
  ghLog = join(scratch, 'gh.log');
  env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    TRACETOON_CONFIG: join(scratch, 'config.json'),
    TRACETOON_GH_SCRIPT: FAKE_GH,
    FAKE_GH_LOG: ghLog,
  };
});

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const GREET =
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';

describe('digest', () => {
  test('matches the session that wrote the code and drops other repos', () => {
    const repo = makeRepo();
    const other = tempDir('tracetoon-other-');
    new ClaudeLog(repo.root)
      .prompt('Please add a greeting helper for the CLI')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .bash('bun test', '3 pass')
      .at(other)
      .prompt('PRIVATE-OTHER-REPO-PROMPT about another project')
      .write(join(other, 'notes.md'), 'unrelated private notes line\n')
      .save(claudeHome, 'sess-main');
    new ClaudeLog(other)
      .prompt('SECRET-PROJECT-PLANS')
      .write(join(other, 'x.ts'), 'secret code here\n')
      .save(claudeHome, 'sess-other', 'other');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');

    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toHaveLength(1);
    expect(r.json.sessions[0].band).toBe('included');
    const digestText = readFileSync(r.json.digestPath, 'utf8');
    const digest = JSON.parse(digestText);
    expect(digest.stats.agentMatchedPct).toBe(100);
    expect(digest.sessions[0].prompts.map((p: any) => p.text)).toEqual([
      'Please add a greeting helper for the CLI',
    ]);
    expect(digest.sessions[0].milestones).toContain('edited 1 file(s)');
    expect(digest.files[0].path).toBe('src/greet.ts');
    for (const leak of [
      'PRIVATE-OTHER-REPO-PROMPT',
      'SECRET-PROJECT-PLANS',
      'unrelated private notes',
      other,
      repo.root,
    ]) {
      expect(digestText).not.toContain(leak);
    }
    expect(digest.privacy.droppedForeignRecords).toBeGreaterThan(0);
  });

  test('credits a session that committed from a since-deleted worktree', () => {
    const repo = makeRepo();
    const sha = repo.commit(
      'src/a.ts',
      'export const answer = computeTheAnswer();\n',
      'feat: answer',
    );
    const goneWorktree = join(tempDir('tracetoon-gone-'), 'wt');
    new ClaudeLog(goneWorktree)
      .prompt('implement the answer in a worktree')
      .bash(
        'git commit -q -m "feat: answer" && git log --oneline -1',
        `${sha.slice(0, 7)} feat: answer`,
      )
      .save(claudeHome, 'sess-wt', 'wt');
    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toHaveLength(1);
    expect(r.json.sessions[0].score).toBe(0.9);
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.stats.commitsMadeInSessions).toBe(1);
    expect(digest.sessions[0].prompts[0].text).toBe('implement the answer in a worktree');
  });
});

describe('render and publish', () => {
  setDefaultTimeout(60_000);
  function prepared() {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    new ClaudeLog(repo.root)
      .prompt('Add greeting')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .save(claudeHome, 's1');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');
    const d = cli(repo.root, 'digest', '--offline');
    expect(d.code).toBe(0);
    expect(cli(repo.root, 'context', '--offline').code).toBe(0);
    const runDir = d.json.runDir as string;
    writeFileSync(
      join(runDir, 'body.md'),
      '## Summary\nAdds a greeting helper. Thanks @octocat!\n',
    );
    writeFileSync(join(runDir, 'title.txt'), 'Add greeting helper\n');
    return { repo, runDir };
  }

  test('publish needs the approval code for the exact rendered text', () => {
    const { repo, runDir } = prepared();
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.findings).toEqual([]);
    const code = r.json.code as string;
    const finalBody = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(finalBody).toContain('<!-- tracetoon:start -->');
    expect(finalBody).toContain('@​octocat');
    expect(existsSync(join(runDir, 'preview.html'))).toBe(true);

    expect(cli(repo.root, 'publish').code).toBe(1);
    expect(cli(repo.root, 'publish', '--code', 'deadbeef').code).toBe(1);

    const yolo = cli(repo.root, 'publish', '--yolo');
    expect(yolo.code).toBe(2);
    expect(yolo.json.error).toContain('yolo is off');

    writeFileSync(join(runDir, 'final-body.md'), finalBody + '\nsneaky edit\n');
    expect(cli(repo.root, 'publish', '--code', code).json.error).toContain(
      'changed after it was approved',
    );
    writeFileSync(join(runDir, 'final-body.md'), finalBody);

    const notPushed = cli(repo.root, 'publish', '--code', code);
    expect(notPushed.json.error).toContain('not on GitHub yet');
    expect(existsSync(ghLog)).toBe(false);

    const ok = cli(repo.root, 'publish', '--code', code, '--push');
    expect(ok.code).toBe(0);
    expect(ok.json.url).toBe('https://github.com/acme/demo/pull/7');
    const calls = readFileSync(ghLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const create = calls.find((c) => c.args[1] === 'create');
    expect(create.args).toContain('Add greeting helper');
    expect(create.body).toBe(finalBody);
  });

  test('yolo publishes without a code only when enabled and clean', () => {
    const { repo } = prepared();
    git(repo.root, ['push', '-q', 'origin', 'feature']);
    expect(cli(repo.root, 'config', 'set', 'yolo', 'true').code).toBe(0);
    expect(cli(repo.root, 'render').code).toBe(0);
    const r = cli(repo.root, 'publish', '--yolo');
    expect(r.code).toBe(0);
    expect(r.json.url).toContain('/pull/7');
  });

  test('render refuses to post a body with a leaked secret', () => {
    const { repo, runDir } = prepared();
    writeFileSync(
      join(runDir, 'body.md'),
      'Config: api_key = sk-live-abcdefghijklmnop1234567890\n',
    );
    const r = cli(repo.root, 'render');
    expect(r.json.findings.length).toBeGreaterThan(0);
    expect(cli(repo.root, 'publish', '--code', r.json.code).json.error).toContain(
      'leak scan',
    );
  });
});
