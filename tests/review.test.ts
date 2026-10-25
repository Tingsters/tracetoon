import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORDMARK, previewHandoff } from '../src/review/handoff.ts';
import {
  activePendingRuns,
  pendingDrafts,
  recordRendered,
  setReviewState,
} from '../src/review/pending.ts';
import { pendingReminder } from '../src/review/reminder.ts';
import { submissionSnapshot, snapshotProblem } from '../src/review/snapshot.ts';
import { terminalCommand } from '../src/util/userCommand.ts';
import { prTruth } from '../src/git/pr.ts';
import { newRun, pruneRuns, KEEP_RUNS } from '../src/run.ts';
import { git } from '../src/util/exec.ts';
import { decide } from '../src/hook/prHook.ts';
import type { Approval } from '../src/commands/publish.ts';
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

function draft(root: string, id = '20250101-000000', code = 'first') {
  const truth = prTruth(root, { noGh: true });
  const run = { id, dir: join(truth.gitDir, 'tracetoon', 'runs', id) };
  mkdirSync(run.dir, { recursive: true });
  const approval: Approval = {
    code,
    title: 'Review this change',
    bodySha: 'body',
    findings: [],
    allowFindings: false,
    mode: 'create',
    base: 'main',
    head: truth.head,
    policy: 'none',
    ambiguousSessions: [],
    renderedAt: id,
    submission: submissionSnapshot(truth),
  };
  writeFileSync(join(run.dir, 'approval.json'), JSON.stringify(approval));
  writeFileSync(join(run.dir, 'preview.html'), '<p>Preview</p>');
  return { run, approval, gitDir: truth.gitDir };
}

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

describe('compact review handoff', () => {
  test('keeps the exact two-line logo and a standalone clickable URL at the end', () => {
    const root = tempDir();
    const url = pathToFileURL(join(root, 'a folder with spaces', 'preview.html')).href;
    const out = previewHandoff({
      root,
      command: 'tracetoon',
      url,
      run: '20250101-000000',
    });
    expect(WORDMARK.split('\n')).toEqual([
      '_|_ ._  _   _  _  _|_  _   _   _',
      ' |_ |  (_| (_ (/_  |_ (_) (_) | |',
    ]);
    expect(out.terminal).toContain(`\nOPEN YOUR LOCAL PR PREVIEW\n${url}\n`);
    const prefix = out.markdown.slice(0, out.markdown.indexOf(url));
    expect((prefix.match(/```/g) ?? []).length % 2).toBe(0);
    expect(out.markdown).toContain(`\n\n${url}\n\n`);
    expect(out.markdown).toContain('Enable Tracetoon yolo mode for future PRs');
    expect(out.terminal).toContain('tracetoon config set yolo true');
  });

  test('shows effective YOLO state and never suggests an ineffective user toggle', () => {
    const root = tempDir();
    const input = { root, command: 'launcher', url: 'file:///preview.html', run: 'run' };
    writeFileSync(config, '{"yolo":true}');
    expect(previewHandoff(input).terminal).toContain('launcher config set yolo false');
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, '.github/tracetoon.json'), '{"yolo":false}');
    const overridden = previewHandoff(input);
    expect(overridden.terminal).toContain('YOLO is off in this repository');
    expect(overridden.terminal).not.toContain('config set yolo');
    writeFileSync(join(root, '.github/tracetoon.json'), '{"yolo":true}');
    expect(previewHandoff(input).terminal).toContain('YOLO is on in this repository');
  });

  test('prints executable commands for PowerShell and POSIX paths with spaces or quotes', () => {
    expect(
      terminalCommand(['C:\\Program Files\\Tracetoon\\tracetoon.cmd'], 'win32'),
    ).toBe("& 'C:\\Program Files\\Tracetoon\\tracetoon.cmd'");
    expect(
      terminalCommand(['C:\\Tools\\bun.exe', "C:\\Sam's work\\cli.ts"], 'win32'),
    ).toBe("C:\\Tools\\bun.exe 'C:\\Sam''s work\\cli.ts'");
    expect(terminalCommand(["/home/sam's tools/tracetoon"], 'linux')).toBe(
      "'/home/sam'\\''s tools/tracetoon'",
    );
  });
});

describe('pending review lifecycle', () => {
  test('finds legacy drafts, supersedes older previews and does not revive them after dismissal', () => {
    const repo = makeRepo();
    const first = draft(repo.root);
    expect(pendingDrafts(repo.root, first.gitDir)).toHaveLength(1);
    const second = draft(repo.root, '20250101-000001', 'second');
    recordRendered(second.gitDir, second.run, second.approval);
    expect(activePendingRuns(second.gitDir).map((d) => d.run.id)).toEqual([
      second.run.id,
    ]);
    setReviewState(second.run, second.approval, 'dismissed');
    expect(activePendingRuns(second.gitDir)).toEqual([]);
    // Even removing the newer run cannot resurrect its superseded predecessor.
    rmSync(second.run.dir, { recursive: true });
    expect(activePendingRuns(first.gitDir)).toEqual([]);
  });

  test('publication clears a reminder and rendering changed content creates a new one', () => {
    const repo = makeRepo();
    const d = draft(repo.root);
    writeFileSync(
      join(d.run.dir, 'published.json'),
      JSON.stringify({ code: d.approval.code }),
    );
    expect(activePendingRuns(d.gitDir)).toEqual([]);
    d.approval.code = 'updated';
    writeFileSync(join(d.run.dir, 'approval.json'), JSON.stringify(d.approval));
    recordRendered(d.gitDir, d.run, d.approval);
    expect(activePendingRuns(d.gitDir)).toHaveLength(1);
  });

  test('preserves pending previews beyond the scratch limit, then allows cleanup after dismissal', () => {
    const repo = makeRepo();
    const d = draft(repo.root);
    const base = join(d.gitDir, 'tracetoon/runs');
    for (let n = 1; n <= KEEP_RUNS + 5; n++)
      mkdirSync(join(base, `20250102-0000${String(n).padStart(2, '0')}`));
    newRun(d.gitDir);
    expect(existsSync(join(d.run.dir, 'preview.html'))).toBe(true);
    expect(activePendingRuns(d.gitDir)).toHaveLength(1);
    setReviewState(d.run, d.approval, 'dismissed');
    pruneRuns(d.gitDir);
    expect(existsSync(d.run.dir)).toBe(false);
  });

  test('a new digest does not hide a pending preview; dismiss never touches code', () => {
    const { repo, run, dir } = prepared();
    expect(cli(repo.root, 'digest', '--offline').json.pendingDrafts[0].run).toBe(run);
    const status = cli(repo.root, 'status');
    expect(status.json.pendingDrafts[0].previewUrl).toBe(
      pathToFileURL(join(dir, 'preview.html')).href,
    );
    expect(cli(repo.root, 'pending', 'dismiss', '--run', '../not-a-run').code).toBe(1);
    const head = git(repo.root, ['rev-parse', 'HEAD']).stdout;
    expect(cli(repo.root, 'pending', 'dismiss', '--run', run).code).toBe(0);
    expect(cli(repo.root, 'status').json.pendingDrafts).toEqual([]);
    expect(git(repo.root, ['rev-parse', 'HEAD']).stdout).toBe(head);
    expect(readFileSync(join(repo.root, 'greet.ts'), 'utf8')).toContain('hello');
  });
});

describe('preview freshness', () => {
  test('publishing verifies the remote revision and binds the PR target to approval', () => {
    const { repo, run, dir, rendered } = prepared();
    const remote = tempDir('tracetoon-review-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main:feature']);
    const approvalFile = join(dir, 'approval.json');
    const approval = JSON.parse(readFileSync(approvalFile, 'utf8'));
    writeFileSync(approvalFile, JSON.stringify({ ...approval, base: 'another-target' }));
    expect(
      cli(repo.root, 'publish', '--run', run, '--code', rendered.json.code).json.error,
    ).toContain('publication target changed');
    writeFileSync(approvalFile, JSON.stringify(approval));
    expect(
      cli(repo.root, 'publish', '--run', run, '--code', rendered.json.code).json.error,
    ).toContain('differs from the approved code');
    expect(
      cli(repo.root, 'publish', '--run', run, '--code', rendered.json.code, '--push')
        .code,
    ).toBe(0);
    expect(cli(repo.root, 'status').json.pendingDrafts).toEqual([]);
    expect(
      git(repo.root, ['ls-remote', 'origin', 'refs/heads/feature']).stdout,
    ).toStartWith(approval.submission.headSha);
  });

  test('working-tree drafts can be reviewed but must be committed before publication', () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, 'new.ts'), 'export const ready = true;\n');
    const d = cli(repo.root, 'digest', '--offline');
    expect(cli(repo.root, 'context', '--offline').code).toBe(0);
    writeFileSync(join(d.json.runDir, 'body.md'), 'Adds a ready flag.');
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(cli(repo.root, 'publish', '--code', r.json.code).json.error).toContain(
      'uncommitted work',
    );
  });

  test('new commits block both publish modes and cannot be blessed by rendering an old digest', () => {
    const { repo, run, dir, rendered } = prepared();
    writeFileSync(config, '{"yolo":true}');
    repo.commit('greet.ts', 'export const greet = "hi";\n', 'fix: greeting');
    for (const args of [['--code', rendered.json.code], ['--yolo']])
      expect(cli(repo.root, 'publish', '--run', run, ...args).json.error).toContain(
        'submitted code changed',
      );
    expect(cli(repo.root, 'render', '--run', run).json.error).toContain(
      'digest needs refreshing',
    );
    expect(cli(repo.root, 'status').json.pendingDrafts[0].freshness).toBe('stale');
    expect(cli(repo.root, 'digest', '--run', run, '--offline').code).toBe(0);
    expect(readFileSync(join(dir, 'body.md'), 'utf8')).toBe('Adds a greeting.\n');
    expect(cli(repo.root, 'context', '--run', run, '--offline').code).toBe(0);
    const fresh = cli(repo.root, 'render', '--run', run);
    expect(fresh.code).toBe(0);
    expect(fresh.json.code).not.toBe(rendered.json.code);
    expect(
      cli(repo.root, 'publish', '--run', run, '--code', rendered.json.code).json.error,
    ).toContain('approval code');
  });

  test('wrong branches and pre-upgrade approvals need refresh, without switching branches', () => {
    const { repo, run, dir, rendered } = prepared();
    git(repo.root, ['switch', '-q', '-c', 'other']);
    expect(
      cli(repo.root, 'publish', '--run', run, '--code', rendered.json.code).json.error,
    ).toContain('belongs to branch');
    expect(cli(repo.root, 'status').json.pendingDrafts[0].freshness).toBe('other-branch');
    expect(cli(repo.root, 'digest', '--run', run, '--offline').json.error).toContain(
      'belongs to branch',
    );
    expect(git(repo.root, ['branch', '--show-current']).stdout.trim()).toBe('other');
    git(repo.root, ['switch', '-q', 'feature']);
    const approval = JSON.parse(readFileSync(join(dir, 'approval.json'), 'utf8'));
    delete approval.submission;
    writeFileSync(join(dir, 'approval.json'), JSON.stringify(approval));
    expect(
      cli(repo.root, 'publish', '--run', run, '--code', rendered.json.code).json.error,
    ).toContain('predates code freshness');
    expect(cli(repo.root, 'status').json.pendingDrafts[0].freshness).toBe(
      'needs-refresh',
    );
  });

  test('working-tree changes invalidate previews while private trail files do not', () => {
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

describe('nonblocking hook reminders', () => {
  test('reminds once per session, again in another session, and stays quiet when disabled', () => {
    const repo = makeRepo();
    draft(repo.root);
    const payload = {
      cwd: repo.root,
      session_id: 'session-one',
      tool_input: { command: 'git status' },
    };
    const env = { ...process.env, CI: '', TRACETOON: '1' };
    const first = JSON.parse(decide('codex', payload, env)!);
    expect(first.hookSpecificOutput.additionalContext).toContain(
      'You have a PR awaiting review',
    );
    expect(first.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(decide('codex', payload, env)).toBeUndefined();
    expect(decide('codex', { ...payload, session_id: 'session-two' }, env)).toContain(
      'awaiting review',
    );
    expect(
      decide(
        'codex',
        { ...payload, session_id: 'session-three' },
        { ...env, TRACETOON: '0' },
      ),
    ).toBeUndefined();
    const denied = JSON.parse(
      decide('codex', { ...payload, tool_input: { command: 'gh pr create' } }, env)!,
    );
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('falls back to 30-minute suppression and stops after dismissal', () => {
    const repo = makeRepo();
    const d = draft(repo.root);
    expect(pendingReminder('claude', {}, repo.root, 1_000)).toContain('awaiting review');
    expect(pendingReminder('claude', {}, repo.root, 2_000)).toBeUndefined();
    expect(pendingReminder('claude', {}, repo.root, 1_801_001)).toContain(
      'awaiting review',
    );
    setReviewState(d.run, d.approval, 'dismissed');
    expect(pendingReminder('claude', { session_id: 'new' }, repo.root)).toBeUndefined();
  });

  test('Antigravity reminders allow the command and new drafts get a new reminder', () => {
    const repo = makeRepo();
    const d = draft(repo.root);
    const payload = {
      cwd: repo.root,
      sessionId: 'one',
      toolCall: { args: { CommandLine: 'git status' } },
    };
    const env = { ...process.env, CI: '', TRACETOON: '1' };
    expect(JSON.parse(decide('antigravity', payload, env)!).decision).toBe('allow');
    expect(decide('antigravity', payload, env)).toBeUndefined();
    d.approval.code = 'new-version';
    writeFileSync(join(d.run.dir, 'approval.json'), JSON.stringify(d.approval));
    recordRendered(d.gitDir, d.run, d.approval);
    expect(decide('antigravity', payload, env)).toContain('awaiting review');
  });
});
