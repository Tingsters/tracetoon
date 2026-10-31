import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { submissionSnapshot, snapshotProblem } from '../src/review/snapshot.ts';
import { prTruth } from '../src/git/pr.ts';
import { newRun, pruneRuns, KEEP_RUNS } from '../src/run.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(90_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');
let configBefore: string | undefined;
let config: string;
beforeEach(() => {
  configBefore = process.env.TRACETOON_CONFIG;
  config = join(tempDir('tracetoon-review-config-'), 'config.json');
  process.env.TRACETOON_CONFIG = config;
});
afterEach(() => {
  if (configBefore === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = configBefore;
});

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TRACETOON_CONFIG: config,
      TRACETOON_GH_SCRIPT: FAKE_GH,
      CLAUDE_CONFIG_DIR: tempDir(),
      CODEX_HOME: tempDir(),
      GEMINI_HOME: tempDir(),
      ANTIGRAVITY_HOME: tempDir(),
    },
  });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* preserve raw output on failure */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function prepared() {
  const repo = makeRepo();
  repo.commit('greet.ts', 'export const greet = "hello";\n', 'feat: greet');
  const d = cli(repo.root, 'digest', '--offline');
  expect(d.code).toBe(0);
  expect(cli(repo.root, 'context', '--offline').code).toBe(0);
  writeFileSync(join(d.json.runDir, 'title.txt'), 'Add a greeting\n');
  writeFileSync(join(d.json.runDir, 'body.md'), 'Adds a greeting.\n');
  const rendered = cli(repo.root, 'render');
  expect(rendered.code).toBe(0);
  return { repo, run: d.json.run as string, dir: d.json.runDir as string, rendered };
}

function withRemote(root: string, push?: string) {
  const remote = tempDir('tracetoon-review-remote-');
  git(remote, ['init', '-q', '--bare']);
  git(root, ['remote', 'add', 'origin', remote]);
  if (push) git(root, ['push', '-q', 'origin', push]);
}

describe('publication freshness', () => {
  test('publishing verifies the remote revision and binds the PR target to the render', () => {
    const { repo, run, dir } = prepared();
    withRemote(repo.root, 'main:feature');
    const approvalFile = join(dir, 'approval.json');
    const approval = JSON.parse(readFileSync(approvalFile, 'utf8'));
    writeFileSync(approvalFile, JSON.stringify({ ...approval, base: 'another-target' }));
    expect(cli(repo.root, 'publish', '--run', run).json.error).toContain(
      'publication target changed',
    );
    writeFileSync(approvalFile, JSON.stringify(approval));
    expect(cli(repo.root, 'publish', '--run', run, '--no-push').json.error).toContain(
      'differs from the rendered code',
    );
    expect(cli(repo.root, 'publish', '--run', run, '--push').code).toBe(0);
    expect(
      git(repo.root, ['ls-remote', 'origin', 'refs/heads/feature']).stdout,
    ).toStartWith(approval.submission.headSha);
  });

  test('working-tree drafts can be rendered but must be committed before publication', () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, 'new.ts'), 'export const ready = true;\n');
    const d = cli(repo.root, 'digest', '--offline');
    expect(cli(repo.root, 'context', '--offline').code).toBe(0);
    writeFileSync(join(d.json.runDir, 'body.md'), 'Adds a ready flag.');
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(cli(repo.root, 'publish').json.error).toContain('uncommitted work');
  });

  test('new commits block publishing and cannot be blessed by rendering an old digest', () => {
    const { repo, run, dir, rendered } = prepared();
    repo.commit('greet.ts', 'export const greet = "hi";\n', 'fix: greeting');
    expect(cli(repo.root, 'publish', '--run', run).json.error).toContain(
      'submitted code changed',
    );
    expect(cli(repo.root, 'render', '--run', run).json.error).toContain(
      'digest needs refreshing',
    );
    expect(cli(repo.root, 'digest', '--run', run, '--offline').code).toBe(0);
    expect(readFileSync(join(dir, 'body.md'), 'utf8')).toBe('Adds a greeting.\n');
    expect(cli(repo.root, 'context', '--run', run, '--offline').code).toBe(0);
    const fresh = cli(repo.root, 'render', '--run', run);
    expect(fresh.code).toBe(0);
    expect(fresh.json.code).not.toBe(rendered.json.code);
    withRemote(repo.root);
    const posted = cli(repo.root, 'publish', '--run', run, '--push');
    expect(posted.code).toBe(0);
    expect(
      git(repo.root, ['ls-remote', 'origin', 'refs/heads/feature']).stdout,
    ).toStartWith(git(repo.root, ['rev-parse', 'HEAD']).stdout.trim());
  });

  test('wrong branches and pre-upgrade renders need refresh, without switching branches', () => {
    const { repo, run, dir } = prepared();
    git(repo.root, ['switch', '-q', '-c', 'other']);
    expect(cli(repo.root, 'publish', '--run', run).json.error).toContain(
      'belongs to branch',
    );
    expect(cli(repo.root, 'digest', '--run', run, '--offline').json.error).toContain(
      'belongs to branch',
    );
    expect(git(repo.root, ['branch', '--show-current']).stdout.trim()).toBe('other');
    git(repo.root, ['switch', '-q', 'feature']);
    const approval = JSON.parse(readFileSync(join(dir, 'approval.json'), 'utf8'));
    delete approval.submission;
    writeFileSync(join(dir, 'approval.json'), JSON.stringify(approval));
    expect(cli(repo.root, 'publish', '--run', run).json.error).toContain(
      'predates code freshness',
    );
  });

  test('working-tree changes invalidate renders while private trail files do not', () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, 'new.bin'), Buffer.from([0xff, 1]));
    const snapshot = submissionSnapshot(prTruth(repo.root, { noGh: true }));
    mkdirSync(join(repo.root, '.showtail'));
    writeFileSync(join(repo.root, '.showtail/events.jsonl'), 'private local record');
    expect(snapshotProblem(repo.root, snapshot)).toBeUndefined();
    writeFileSync(join(repo.root, 'new.bin'), Buffer.from([0xff, 2]));
    expect(snapshotProblem(repo.root, snapshot)).toContain('submitted code changed');
  });
});

describe('run pruning', () => {
  test('keeps unfinished tasks beyond the scratch limit, then allows cleanup after publication', () => {
    const repo = makeRepo();
    const { gitDir } = prTruth(repo.root, { noGh: true });
    const base = join(gitDir, 'tracetoon', 'runs');
    const unfinished = join(base, '20250101-000000');
    mkdirSync(unfinished, { recursive: true });
    const task = { v: 1, run: '20250101-000000', state: 'preparing' };
    writeFileSync(join(unfinished, 'task.json'), JSON.stringify(task));
    const scratch = join(base, '20250101-000001');
    mkdirSync(scratch);
    for (let n = 1; n <= KEEP_RUNS + 5; n++)
      mkdirSync(join(base, `20250102-0000${String(n).padStart(2, '0')}`));
    newRun(gitDir);
    expect(existsSync(unfinished)).toBe(true);
    expect(existsSync(scratch)).toBe(false);
    writeFileSync(
      join(unfinished, 'task.json'),
      JSON.stringify({ ...task, state: 'published' }),
    );
    pruneRuns(gitDir);
    expect(existsSync(unfinished)).toBe(false);
  });
});
