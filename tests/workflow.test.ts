import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  beginTask,
  contentFingerprint,
  readTask,
  repository,
  saveTask,
  tasks,
  workFingerprint,
} from '../src/workflow/state.ts';
import { checkReport, executeCheck, receipts } from '../src/workflow/checks.ts';
import { lifecycle } from '../src/hook/lifecycle.ts';
import { discoveryIndex } from '../src/trace/discovery.ts';
import { readLocal, writeLocal } from '../src/util/localJson.ts';
import { git } from '../src/util/exec.ts';
import { findRun, pruneRuns } from '../src/run.ts';
import { makeRepo, tempDir } from './helpers.ts';
import { serveBrowserPreview } from '../src/review/browser.ts';

setDefaultTimeout(180_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const binary = process.env.TRACETOON_TEST_BINARY;
const program = binary ? [binary] : [process.execPath, CLI];
let previous: string | undefined;
let config: string;
const previewClosers: Array<() => Promise<void>> = [];
beforeEach(() => {
  previous = process.env.TRACETOON_CONFIG;
  config = join(tempDir('tracetoon-workflow-'), 'config.json');
  process.env.TRACETOON_CONFIG = config;
});
afterEach(async () => {
  await Promise.all(previewClosers.splice(0).map((close) => close()));
  if (previous === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = previous;
});
const env = () => ({ ...process.env, CI: '', TRACETOON: '1' });

function cli(root: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(program[0]!, [...program.slice(1), '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env(),
      CLAUDE_CONFIG_DIR: join(dirname(config), 'claude'),
      CODEX_HOME: join(dirname(config), 'codex'),
      GEMINI_HOME: join(dirname(config), 'gemini'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
      TRACETOON_TEST_RUNNER: process.execPath,
      ...extra,
    },
    windowsHide: true,
  });
  let json: any;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = { error: result.stderr || result.stdout };
  }
  return { code: result.status, json, stderr: result.stderr };
}
function ok(root: string, ...args: string[]) {
  const result = cli(root, args);
  expect(result.json.error).toBeUndefined();
  expect(result.code).toBe(0);
  return result.json;
}

describe('finished task completion contract', () => {
  test('finished edits without any PR command cannot silently end; deferral is explicit', () => {
    const repo = makeRepo();
    const p = {
      cwd: repo.root,
      session_id: 'finished-edit',
      tool_input: { command: 'git status' },
    };
    expect(lifecycle('codex', 'SessionStart', p, env())).toContain('cohesive');
    lifecycle('codex', 'PreToolUse', p, env());
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
    repo.commit('fix.ts', 'export const fixed = true;\n', 'Fix behavior');
    const response = JSON.parse(lifecycle('codex', 'Stop', p, env())!);
    expect(response.decision).toBe('block');
    expect(response.reason).toContain('no completion disposition');
    const active = tasks(repository(repo.root).gitDir)[0]!;
    active.task.state = 'deferred';
    active.task.reason = 'User asked to continue later.';
    saveTask(active.run, active.task);
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
  });

  test('parent workspace resolves the command workdir and preserves unfinished tasks beyond pruning', () => {
    const repo = makeRepo();
    const p = {
      cwd: dirname(repo.root),
      session_id: 'parent',
      tool_input: { command: 'git status', workdir: repo.root },
    };
    lifecycle('claude', 'PreToolUse', p, env());
    writeFileSync(join(repo.root, 'new.ts'), 'changed');
    expect(lifecycle('claude', 'Stop', { ...p, tool_input: {} }, env())).toContain(
      'block',
    );
    const { gitDir } = repository(repo.root);
    const active = tasks(gitDir)[0]!;
    pruneRuns(gitDir);
    expect(existsSync(join(active.run.dir, 'task.json'))).toBe(true);
    expect(
      lifecycle('codex', 'Stop', { ...p, permission_mode: 'plan' }, env()),
    ).toBeUndefined();
    expect(
      lifecycle('codex', 'Stop', { ...p, is_subagent: true }, env()),
    ).toBeUndefined();
    expect(
      lifecycle('antigravity', 'Stop', { ...p, fullyIdle: false }, env()),
    ).toBeUndefined();
    expect(lifecycle('codex', 'Stop', p, { ...env(), TRACETOON: '0' })).toBeUndefined();
  });

  test('recovery is bounded; preparation failure remains visible', () => {
    const repo = makeRepo();
    const { run, task } = beginTask(repo.root, { session: 'bounded' });
    task.state = 'preparing';
    saveTask(run, task);
    const p = { cwd: repo.root, session_id: 'bounded' };
    expect(lifecycle('codex', 'Stop', p, env())).toContain('block');
    expect(lifecycle('codex', 'Stop', { ...p, stop_hook_active: true }, env())).toContain(
      'block',
    );
    expect(lifecycle('codex', 'Stop', p, env())).toContain('exhausted');
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
    expect(readTask(run)?.state).toBe('blocked');
    expect(readTask(run)?.reason).toContain('recovery exhausted');
  });

  test('connector publication is guarded while read-only GitHub requests are allowed', () => {
    const repo = makeRepo();
    beginTask(repo.root, { session: 'connector' });
    const p = {
      cwd: repo.root,
      session_id: 'connector',
      tool_name: 'mcp__github__create_pull_request',
      tool_input: {},
    };
    expect(lifecycle('codex', 'PreToolUse', p, env())).toContain('deny');
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_name: 'mcp__github__get_pull_request' },
        env(),
      ),
    ).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'git push --dry-run' } },
        env(),
      ),
    ).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'git push -n' } },
        env(),
      ),
    ).toBeUndefined();
  });

  test('pushes pass through; a missed task registration is caught at the PR; quoted examples are ordinary work', () => {
    const repo = makeRepo();
    const p = {
      cwd: repo.root,
      session_id: 'missed-registration',
      tool_input: { command: 'git status' },
    };
    lifecycle('codex', 'PreToolUse', p, env());
    repo.commit('fix.ts', 'fixed', 'Fix without registering a task');
    for (const command of [
      'git push origin feature',
      'git push -u origin HEAD',
      'git push origin v1.2.0',
      'git push --tags',
      'git push origin main',
    ])
      expect(
        lifecycle('codex', 'PreToolUse', { ...p, tool_input: { command } }, env()),
      ).toBeUndefined();
    // A push never creates a task.
    expect(tasks(repository(repo.root).gitDir)).toHaveLength(0);
    // Writing the PR outside Tracetoon is redirected and starts the task.
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'gh pr create --fill' } },
        env(),
      ),
    ).toContain('deny');
    expect(tasks(repository(repo.root).gitDir)).toHaveLength(1);
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'echo "git push origin feature"' } },
        env(),
      ),
    ).toBeUndefined();
  });

  test('publication targets the explicit repository, not another pending task in the hook cwd', () => {
    const a = makeRepo();
    const b = makeRepo();
    git(a.root, ['remote', 'add', 'origin', 'https://github.com/acme/a.git']);
    git(b.root, ['remote', 'add', 'origin', 'https://github.com/acme/b.git']);
    beginTask(a.root, { session: 'scope' });
    const deferred = beginTask(b.root, { session: 'scope' });
    deferred.task.state = 'deferred';
    deferred.task.reason = 'Explicit WIP sync.';
    saveTask(deferred.run, deferred.task);
    const p = {
      cwd: a.root,
      session_id: 'scope',
      tool_input: { command: `cd "${b.root}" && git push` },
    };
    expect(lifecycle('codex', 'PreToolUse', p, env())).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: `git -C "${b.root}" push` } },
        env(),
      ),
    ).toBeUndefined();
    // A repository that explicitly disables Tracetoon must not inherit A's pending task.
    const deferredPr = lifecycle(
      'codex',
      'PreToolUse',
      {
        cwd: a.root,
        session_id: 'scope',
        tool_name: 'mcp__github__update_pull_request',
        tool_input: { owner: 'acme', repo: 'b' },
      },
      env(),
    );
    expect(deferredPr).toContain('deny');
    expect(deferredPr).toContain(deferred.run.id);
    mkdirSync(join(b.root, '.github'));
    writeFileSync(join(b.root, '.github/tracetoon.json'), '{"enabled":false}');
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'gh api repos/acme/b/pulls -X POST' } },
        env(),
      ),
    ).toBeUndefined();
    const connector = {
      cwd: a.root,
      session_id: 'scope',
      tool_name: 'mcp__github__update_pull_request',
      tool_input: { owner: 'acme', repo: 'b' },
    };
    expect(lifecycle('codex', 'PreToolUse', connector, env())).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...connector, tool_input: { owner: 'acme', repo: 'a' } },
        env(),
      ),
    ).toContain('deny');
  });

  test('unrelated branches and worktrees keep separate tasks; a new directory is observed before its first write', () => {
    const repo = makeRepo();
    const first = beginTask(repo.root, { session: 'separate' });
    git(repo.root, ['checkout', '-qb', 'other']);
    const second = beginTask(repo.root, { session: 'separate' });
    expect(first.run.id).not.toBe(second.run.id);
    expect(tasks(first.gitDir)).toHaveLength(2);
    const otherWorktree = join(tempDir('tracetoon-worktree-'), 'checkout');
    expect(git(repo.root, ['worktree', 'add', '-qb', 'third', otherWorktree]).ok).toBe(
      true,
    );
    const third = beginTask(otherWorktree, { session: 'separate' });
    expect(third.gitDir).not.toBe(first.gitDir);
    expect(tasks(third.gitDir)).toHaveLength(1);
    const input = {
      cwd: dirname(repo.root),
      session_id: 'new-folder',
      tool_name: 'Write',
      tool_input: { file_path: join(repo.root, 'not-yet', 'file.ts') },
    };
    lifecycle('claude', 'PreToolUse', input, env());
    mkdirSync(join(repo.root, 'not-yet'));
    writeFileSync(input.tool_input.file_path, 'new');
    expect(
      lifecycle(
        'claude',
        'Stop',
        { cwd: dirname(repo.root), session_id: 'new-folder' },
        env(),
      ),
    ).toContain('block');
  });
});

describe('receipts follow tested content', () => {
  test('ignored generated artifacts are explicit validation inputs', () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, '.gitignore'), 'dist/\n');
    mkdirSync(join(repo.root, 'dist'));
    writeFileSync(join(repo.root, 'dist/program.bin'), 'first build');
    const { run } = beginTask(repo.root);
    const command = [process.execPath, '-e', 'console.log("1 pass")'];
    const options = { name: 'compiled', command, input: ['dist/program.bin'] };
    const source = contentFingerprint(repo.root);
    expect(executeCheck(repo.root, run, options).outcome).toBe('passed');
    expect(executeCheck(repo.root, run, options).reused).toBe(true);
    writeFileSync(join(repo.root, 'dist/program.bin'), 'different executable');
    expect(contentFingerprint(repo.root)).toBe(source);
    expect(executeCheck(repo.root, run, options).reused).toBeUndefined();
  });
  test('reuses unchanged input, survives commits and ignores private trails; edits and environment changes invalidate', () => {
    const repo = makeRepo();
    const { run } = beginTask(repo.root);
    writeFileSync(join(repo.root, 'code.ts'), 'one');
    const command = [process.execPath, '-e', 'console.log("1 pass")'];
    const first = executeCheck(repo.root, run, { name: 'tests', command });
    expect(first.outcome).toBe('passed');
    expect(first.summary).toContain('1 pass');
    const originalCall = process.env.CODEX_TOOL_CALL_ID;
    process.env.CODEX_TOOL_CALL_ID = 'another-host-tool-invocation';
    try {
      expect(executeCheck(repo.root, run, { name: 'tests', command }).reused).toBe(true);
    } finally {
      if (originalCall === undefined) delete process.env.CODEX_TOOL_CALL_ID;
      else process.env.CODEX_TOOL_CALL_ID = originalCall;
    }
    git(repo.root, ['add', 'code.ts']);
    git(repo.root, ['commit', '-qm', 'Add code']);
    mkdirSync(join(repo.root, '.showtail'));
    writeFileSync(join(repo.root, '.showtail/private.json'), 'private');
    expect(contentFingerprint(repo.root)).toBe(first.fingerprint);
    expect(executeCheck(repo.root, run, { name: 'tests', command }).reused).toBe(true);
    writeFileSync(join(repo.root, 'code.ts'), 'two');
    expect(
      executeCheck(repo.root, run, { name: 'tests', command }).reused,
    ).toBeUndefined();
    const oldEnvironment = process.env.WORKFLOW_TEST_INPUT;
    process.env.WORKFLOW_TEST_INPUT = 'changed';
    try {
      expect(
        executeCheck(repo.root, run, { name: 'tests', command }).reused,
      ).toBeUndefined();
    } finally {
      if (oldEnvironment === undefined) delete process.env.WORKFLOW_TEST_INPUT;
      else process.env.WORKFLOW_TEST_INPUT = oldEnvironment;
    }
    expect(
      executeCheck(repo.root, run, {
        name: 'fail',
        command: [process.execPath, '-e', 'process.exit(7)'],
      }).outcome,
    ).toBe('failed');
    const skip = executeCheck(repo.root, run, {
      name: 'integration',
      command: [],
      skip: 'CI-only per contributor guide.',
    });
    expect(skip.outcome).toBe('not-run');
    expect(skip.exitCode).toBeNull();
  });
});

describe('active transcript discovery', () => {
  test('recent events in old-mtime logs are discoverable, including incremental partial-line appends and truncation', () => {
    const dir = tempDir('tracetoon-log-');
    const file = join(dir, 'rollout.jsonl');
    const query = {
      roots: [dir],
      sinceMs: Date.now() - 60_000,
      cacheDir: join(dir, 'cache'),
    };
    const old = '2020-01-01T00:00:00Z';
    writeFileSync(
      file,
      JSON.stringify({ timestamp: old, cwd: dir, padding: 'x'.repeat(900) }) + '\n',
    );
    let index = discoveryIndex(query);
    expect(index.inspect(file)?.recent).toBe(Date.parse(old));
    index.save();
    appendFileSync(file, `{"timestamp":"${new Date().toISOString().slice(0, 10)}`);
    index = discoveryIndex(query);
    index.inspect(file);
    index.save();
    appendFileSync(
      file,
      `${new Date().toISOString().slice(10)}","cwd":${JSON.stringify(dir)}}\n`,
    );
    utimesSync(file, new Date(old), new Date(old));
    index = discoveryIndex(query);
    const recent = index.inspect(file)!;
    index.save();
    expect(recent.recent).toBeGreaterThan(query.sinceMs);
    expect(recent.match).toBe(true);
    const disk = readFileSync(
      join(query.cacheDir, readdirSync(query.cacheDir)[0]!),
      'utf8',
    );
    expect(disk).not.toContain('padding');
    expect(disk).not.toContain('timestamp');
    writeFileSync(file, JSON.stringify({ timestamp: old, cwd: '/unrelated' }) + '\n');
    index = discoveryIndex(query);
    expect(index.inspect(file)?.match).toBe(false);
  });
});

describe('author review to publication rehearsal', () => {
  test('prepares, detects missing handoff, publishes without rerunning work, and recovers an interrupted create', async () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    const begun = ok(repo.root, 'task', 'begin', '--session', 'rehearsal');
    const run = findRun(repository(repo.root).gitDir, begun.run);
    repo.commit('greet.ts', 'export const greet = () => "hello";\n', 'Add greeting');
    const checked = ok(
      repo.root,
      'check',
      '--run',
      run.id,
      '--name',
      'tests',
      '--',
      process.execPath,
      '-e',
      'console.log("1 pass")',
    );
    expect(checked.outcome).toBe('passed');
    ok(repo.root, 'task', 'complete', '--run', run.id, '--checks', 'tests');
    ok(repo.root, 'digest', '--run', run.id, '--offline');
    ok(repo.root, 'context', '--run', run.id, '--offline');
    const request = readLocal<{ fingerprint: string }>(
      join(run.dir, 'guidance-request.json'),
    )!;
    writeLocal(join(run.dir, 'guidance.json'), {
      v: 1,
      requestFingerprint: request.fingerprint,
      researcher: { mode: 'inline' },
      sources: [],
      requirements: [],
      gaps: ['Isolated workflow fixture; no production compliance claim.'],
    });
    writeFileSync(
      join(run.dir, 'body.md'),
      'Adds a greeting.\n\nTesting: the smoke test passed.\n',
    );
    writeFileSync(join(run.dir, 'title.txt'), 'Add greeting');
    const first = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(ok(repo.root, 'status').pendingDrafts).toEqual([]);
    expect(cli(repo.root, ['ready', '--run', run.id]).json.error).toContain('review');
    writeLocal(join(run.dir, 'review.json'), {
      v: 1,
      inputFingerprint: first.reviewFingerprint,
      drafter: { mode: 'inline' },
      reviewer: { mode: 'inline' },
      assessments: [],
    });
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    const browser = await serveBrowserPreview(run.dir);
    previewClosers.push(browser.close);
    const ready = ok(repo.root, 'ready', '--run', run.id, '--serve');
    expect(readFileSync(join(run.dir, 'preview.html'), 'utf8')).toContain(
      'Local validation before author review',
    );
    expect(ready.previewHandoff.markdown).toContain(
      `[OPEN YOUR LOCAL PR PREVIEW](${browser.url})`,
    );
    expect(ready.previewHandoff.markdown).not.toContain('file://');
    const p = {
      cwd: repo.root,
      session_id: 'rehearsal',
      last_assistant_message: 'Done.',
    };
    expect(lifecycle('codex', 'Stop', p, env())).toContain('has not been shown');
    expect(
      lifecycle(
        'codex',
        'Stop',
        { ...p, last_assistant_message: ready.previewHandoff.markdown },
        env(),
      ),
    ).toBeUndefined();
    expect(readTask(run)?.presentedCode).toBe(ready.code);
    const exactBody = readFileSync(join(run.dir, 'final-body.md'), 'utf8');
    writeFileSync(join(run.dir, 'final-body.md'), exactBody + '\nUnreviewed change.');
    expect(ok(repo.root, 'status').pendingDrafts[0].freshness).toBe('stale');
    expect(
      cli(repo.root, ['publish', '--run', run.id, '--code', ready.code]).json.error,
    ).toContain('description changed');
    writeFileSync(join(run.dir, 'final-body.md'), exactBody);
    // Approval binds the remote as well as code, and unexpected new files invalidate it.
    git(repo.root, ['remote', 'set-url', 'origin', join(remote, 'different')]);
    expect(
      cli(repo.root, ['publish', '--run', run.id, '--code', ready.code]).json.error,
    ).toContain('remote changed');
    git(repo.root, ['remote', 'set-url', 'origin', remote]);
    writeFileSync(join(repo.root, 'unreviewed.ts'), 'not in preview');
    expect(ok(repo.root, 'status').pendingDrafts[0].freshness).toBe('stale');
    expect(
      cli(repo.root, ['publish', '--run', run.id, '--code', ready.code]).json.error,
    ).toContain('content changed');
    rmSync(join(repo.root, 'unreviewed.ts'));
    const log = join(dirname(config), 'gh.log');
    const state = join(dirname(config), 'gh-state.json');
    const before = readFileSync(join(run.dir, 'checks.json'), 'utf8');
    const firstPublish = cli(
      repo.root,
      ['publish', '--run', run.id, '--code', ready.code],
      { FAKE_GH_LOG: log, FAKE_GH_STATE: state, FAKE_GH_FAIL_CREATE_ONCE: '1' },
    );
    expect(firstPublish.code).toBe(1);
    const retried = cli(repo.root, ['publish', '--run', run.id, '--code', ready.code], {
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: state,
    });
    expect(retried.json.error).toBeUndefined();
    expect(retried.code).toBe(0);
    expect(retried.json.url).toBe('https://github.com/acme/demo/pull/7');
    expect(retried.json.merged).toBe(false);
    expect(readFileSync(join(run.dir, 'checks.json'), 'utf8')).toBe(before);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create'),
    ).toHaveLength(1);
    expect(calls.some((c) => c.args.includes('merge') || c.args.includes('checks'))).toBe(
      false,
    );
    expect(readTask(run)?.state).toBe('published');
    const interrupted = readTask(run)!;
    interrupted.state = 'ready';
    saveTask(run, interrupted);
    const cached = cli(repo.root, ['publish', '--run', run.id, '--code', ready.code], {
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: state,
    });
    expect(cached.json.reused).toBe(true);
    expect(readTask(run)?.state).toBe('published');
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined(); // don't recreate a just-published task
    expect(ok(repo.root, 'status').pendingDrafts).toEqual([]);
  });
});

describe('ordinary git, task identity and handoff recognition', () => {
  function prepared(repo: ReturnType<typeof makeRepo>, runId: string) {
    const run = findRun(repository(repo.root).gitDir, runId);
    ok(repo.root, 'task', 'complete', '--run', run.id, '--checks', 'tests');
    ok(repo.root, 'digest', '--run', run.id, '--offline');
    ok(repo.root, 'context', '--run', run.id, '--offline');
    const request = readLocal<{ fingerprint: string }>(
      join(run.dir, 'guidance-request.json'),
    )!;
    writeLocal(join(run.dir, 'guidance.json'), {
      v: 1,
      requestFingerprint: request.fingerprint,
      researcher: { mode: 'inline' },
      sources: [],
      requirements: [],
      gaps: ['Isolated workflow fixture; no production compliance claim.'],
    });
    if (!existsSync(join(run.dir, 'body.md'))) {
      writeFileSync(join(run.dir, 'body.md'), 'Adds a greeting.\n');
      writeFileSync(join(run.dir, 'title.txt'), 'Add greeting');
    }
    const first = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    writeLocal(join(run.dir, 'review.json'), {
      v: 1,
      inputFingerprint: first.reviewFingerprint,
      drafter: { mode: 'inline' },
      reviewer: { mode: 'inline' },
      assessments: [],
    });
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    return run;
  }
  const check = (root: string, run: string) =>
    ok(root, 'check', '--run', run, '--name', 'tests', '--', process.execPath, '-e', '1');
  const prCreate = ['gh', 'pr', 'create', '--fill'].join(' ');

  test('PR writes stay intercepted, including inside a compound push command', () => {
    const repo = makeRepo();
    git(repo.root, ['switch', '-q', '-c', 'feature']);
    const p = { cwd: repo.root, session_id: 'intercept' };
    const run = (tool_input: object) =>
      lifecycle('codex', 'PreToolUse', { ...p, tool_input }, env());
    expect(run({ command: 'git push -u origin feature' })).toBeUndefined();
    expect(run({ command: `git push -u origin feature && ${prCreate}` })).toContain(
      'deny',
    );
    expect(
      run({ command: ['gh', 'pr', 'edit', '3', '--body', '"new"'].join(' ') }),
    ).toContain('deny');
    expect(
      run({ command: 'gh api -X PATCH repos/acme/demo/pulls/3 -f body=new' }),
    ).toContain('deny');
    // Other ways agents open PRs go through Tracetoon too.
    for (const command of [
      'hub pull-request -m "Fix"',
      'git pull-request',
      'git town propose',
      'curl -X POST https://api.github.com/repos/acme/demo/pulls -d @pr.json',
      'Invoke-RestMethod -Method Post -Uri https://api.github.com/repos/acme/demo/pulls',
    ])
      expect(run({ command })).toContain('deny');
    // Reads and stacking tools are not PR writes Tracetoon replaces.
    expect(
      run({ command: 'curl -s https://api.github.com/repos/acme/demo/pulls' }),
    ).toBeUndefined();
    expect(run({ command: 'gt submit --stack' })).toBeUndefined();
    // Closing a PR through the API is left alone by both hooks, like gh pr close.
    expect(
      run({ command: 'gh api -X PATCH repos/acme/demo/pulls/3 -f state=closed' }),
    ).toBeUndefined();
    // Text that only mentions a PR command is not a PR write.
    expect(run({ command: `echo "${prCreate}"` })).toBeUndefined();
    expect(
      run({ command: `cat >> notes.md <<'EOF'\nRun ${prCreate} later\nEOF` }),
    ).toBeUndefined();
    // Connector pushes are ordinary git; connector PR writes are not.
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_name: 'mcp__github__push_files', tool_input: {} },
        env(),
      ),
    ).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_name: 'mcp__github__create_pull_request', tool_input: {} },
        env(),
      ),
    ).toContain('deny');
    const deny = JSON.parse(run({ command: prCreate })!);
    expect(deny.hookSpecificOutput.permissionDecisionReason).toContain(
      'Pushing branches is fine',
    );
  });

  test('defer/block/complete keep the task branch; explicit adoption refreshes target state', async () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    git(repo.root, ['switch', '-q', '-c', 'feat/a']);
    const begun = ok(repo.root, 'task', 'begin', '--session', 'adopt');
    repo.commit('greet.ts', 'export const greet = () => "hello";\n', 'Add greeting');
    check(repo.root, begun.run);
    const run = prepared(repo, begun.run);
    // Serverless ready: no clickable file anchor (Codex renders only http links),
    // yet the exact returned markdown is recognized as delivered.
    const ready = ok(repo.root, 'ready', '--run', run.id);
    expect(ready.previewHandoff.markdown).not.toContain('file://');
    const p = { cwd: repo.root, session_id: 'adopt', last_assistant_message: 'Done.' };
    expect(lifecycle('codex', 'Stop', p, env())).toContain('has not been shown');
    expect(
      lifecycle(
        'codex',
        'Stop',
        { ...p, last_assistant_message: ready.previewHandoff.markdown },
        env(),
      ),
    ).toBeUndefined();
    expect(readTask(run)?.presentedCode).toBe(ready.code);

    // Same commit, different branch: bookkeeping commands never move the task.
    git(repo.root, ['switch', '-q', '-c', 'feat/b']);
    ok(repo.root, 'task', 'defer', '--run', run.id, '--reason', 'Waiting on the author.');
    expect(readTask(run)?.branch).toBe('feat/a');
    ok(repo.root, 'task', 'block', '--run', run.id, '--reason', 'Image route down.');
    expect(readTask(run)?.branch).toBe('feat/a');
    ok(repo.root, 'task', 'complete', '--run', run.id, '--checks', 'tests');
    expect(readTask(run)?.branch).toBe('feat/a');
    expect(existsSync(join(run.dir, 'approval.json'))).toBe(true);

    // Explicit adoption moves it and clears what was bound to feat/a.
    ok(repo.root, 'task', 'begin', '--run', run.id);
    const adopted = readTask(run)!;
    expect(adopted.branch).toBe('feat/b');
    expect(adopted.readyCode).toBeUndefined();
    expect(adopted.presentedCode).toBeUndefined();
    for (const file of ['approval.json', 'preview.html', 'final-body.md'])
      expect(existsSync(join(run.dir, file))).toBe(false);
    for (const file of ['body.md', 'title.txt', 'checks.json'])
      expect(existsSync(join(run.dir, file))).toBe(true);
    // Receipts are content-bound, so the same tree reuses them.
    expect(check(repo.root, run.id).reused).toBe(true);
    // Previously `digest --run` rejected the old approval's branch.
    prepared(repo, run.id);
    const browser = await serveBrowserPreview(run.dir);
    previewClosers.push(browser.close);
    const served = ok(repo.root, 'ready', '--run', run.id, '--serve');
    expect(served.previewHandoff.markdown).toContain(`(${browser.url})`);
    expect(
      lifecycle(
        'codex',
        'Stop',
        { ...p, last_assistant_message: served.previewHandoff.markdown },
        env(),
      ),
    ).toBeUndefined();
    // Adopting across different commits is still refused.
    git(repo.root, ['switch', '-q', 'main']);
    git(repo.root, ['switch', '-q', '-c', 'feat/c']);
    repo.commit('other.ts', 'x', 'Unrelated');
    expect(cli(repo.root, ['task', 'begin', '--run', run.id]).json.error).toContain(
      'Switch to the task branch',
    );
  });

  test('a branch pushed past the approved commit is never published as reviewed', () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    git(repo.root, ['switch', '-q', '-c', 'feat/a']);
    const begun = ok(repo.root, 'task', 'begin', '--session', 'ahead');
    repo.commit('greet.ts', 'export const greet = () => "hello";\n', 'Add greeting');
    const approved = git(repo.root, ['rev-parse', 'HEAD']).stdout.trim();
    check(repo.root, begun.run);
    const run = prepared(repo, begun.run);
    const ready = ok(repo.root, 'ready', '--run', run.id);
    // Pushing is allowed now: an unreviewed commit reaches the remote branch.
    repo.commit('extra.ts', 'export const extra = 1;\n', 'Unreviewed follow-up');
    git(repo.root, ['push', '-q', '-u', 'origin', 'feat/a']);
    git(repo.root, ['reset', '-q', '--hard', approved]);
    const log = join(dirname(config), 'gh-ahead.log');
    const published = cli(repo.root, ['publish', '--run', run.id, '--code', ready.code], {
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: join(dirname(config), 'gh-ahead.json'),
    });
    expect(published.code).not.toBe(0);
    expect(published.json.error).toContain('git push failed');
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    expect(calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(false);
  });

  test('receipts ignore agent session bookkeeping but not the toolchain', () => {
    const repo = makeRepo();
    const { run } = beginTask(repo.root, { session: 'receipts' });
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { CLAUDE_EFFORT: 'medium', AI_AGENT: 'claude-code_1' });
      const receipt = executeCheck(repo.root, run, {
        name: 'tests',
        command: [process.execPath, '-e', '1'],
      });
      expect(receipt.outcome).toBe('passed');
      const current = () =>
        checkReport(repo.root, run).find((c) => c.name === 'tests')!.current;
      expect(current()).toBe(true);
      for (const [k, v] of [
        ['CLAUDE_EFFORT', 'high'],
        ['CLAUDE_CODE_SESSION_ATTENDED', '0'],
        ['AI_AGENT', 'claude-code_2'],
        ['CODEX_THREAD_ID', 'another-thread'],
        ['CODEX_TOOL_CALL_ID', 'call-2'],
      ] as const) {
        process.env[k] = v;
        expect(current()).toBe(true);
      }
      process.env.NODE_ENV = 'production';
      expect(current()).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
