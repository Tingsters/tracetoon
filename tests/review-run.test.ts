import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  changedLines,
  extractJson,
  rolloutModel,
  sessionIdFromEvents,
} from '../src/commands/reviewRun.ts';
import {
  CODEX_MODELS,
  planFromOptions,
  planGate,
  resolveCodexModel,
} from '../src/contribution/reviewPlan.ts';
import { graphNext } from '../src/commands/digest.ts';
import { lifecycle } from '../src/hook/lifecycle.ts';
import { findRun } from '../src/run.ts';
import { git } from '../src/util/exec.ts';
import { writeLocal } from '../src/util/localJson.ts';
import { repository, tasks } from '../src/workflow/state.ts';
import { makeRepo, tempDir } from './helpers.ts';

const CLI = resolve(import.meta.dir, '../src/cli.ts');
const FAKE = resolve(import.meta.dir, 'fake-codex-review.ts');
let previous: string | undefined;
let config: string;
let codexHome: string;
let log: string;
beforeEach(() => {
  previous = process.env.TRACETOON_CONFIG;
  config = join(tempDir('tracetoon-review-run-'), 'config.json');
  codexHome = join(dirname(config), 'codex');
  log = join(dirname(config), 'codex-log.jsonl');
  process.env.TRACETOON_CONFIG = config;
});
afterEach(() => {
  if (previous === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = previous;
});
const env = () => ({ ...process.env, CI: '', TRACETOON: '1' });

function cli(root: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env(),
      CLAUDE_CONFIG_DIR: join(dirname(config), 'claude'),
      CODEX_HOME: codexHome,
      GEMINI_HOME: join(dirname(config), 'gemini'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
      TRACETOON_CODEX_BIN: FAKE,
      FAKE_CODEX_LOG: log,
      CODEX_THREAD_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      ...extra,
    },
  });
  let json: any;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = { error: result.stderr || result.stdout };
  }
  return { code: result.status, json };
}
function ok(root: string, args: string[], extra: Record<string, string> = {}) {
  const r = cli(root, args, extra);
  expect(r.json.error).toBeUndefined();
  expect(r.code).toBe(0);
  return r.json;
}
const calls = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { args: string[]; prompt: string })
    : [];

/** A task run rendered and ready for reviewer passes. */
function renderedRun() {
  const repo = makeRepo();
  const remote = tempDir('tracetoon-run-remote-');
  expect(git(remote, ['init', '-q', '--bare']).ok).toBe(true);
  expect(git(repo.root, ['remote', 'add', 'origin', remote]).ok).toBe(true);
  const p = { cwd: repo.root, session_id: 'review-run' };
  lifecycle('codex', 'SessionStart', p, env());
  repo.commit(
    'src/greet.ts',
    "export function greet(name?: string) {\n  if (!name) return 'hello';\n  return `hello ${name}`;\n}\n",
    'Greet by name',
  );
  lifecycle(
    'codex',
    'PreToolUse',
    { ...p, tool_input: { command: 'gh pr create --fill' } },
    env(),
  );
  const run = findRun(
    repository(repo.root).gitDir,
    tasks(repository(repo.root).gitDir)[0]!.run.id,
  );
  ok(repo.root, ['digest', '--run', run.id, '--offline']);
  ok(repo.root, ['context', '--run', run.id, '--offline']);
  writeFileSync(
    join(run.dir, 'body.md'),
    'The greeting always uses the given name.\n\nIt previously only said hello.\n\nSee src/greet.ts.\n',
  );
  writeFileSync(join(run.dir, 'title.txt'), 'Greet by name');
  ok(repo.root, ['render', '--run', run.id, '--no-comic']);
  const patch = readFileSync(join(run.dir, 'changes.patch'), 'utf8').split('\n');
  const ifLine = patch.findIndex((l) => l.includes('if (!name)')) + 1;
  const reply = (...quotes: string[]) =>
    JSON.stringify({
      v: 1,
      reviewer: { agentId: 'codex-exec' },
      coldRead: { change: 'Greets by name.', start: 'src/greet.ts' },
      findings: quotes.map((quote) => ({
        kind: 'claim',
        quote,
        verdict: 'overstated',
        evidence: `diff:${ifLine}`,
        fix: 'Qualify it.',
      })),
    });
  const plan = (extra: Record<string, unknown>) =>
    writeLocal(join(run.dir, 'review-plan.json'), {
      v: 1,
      passes: 1,
      lenses: [],
      ...extra,
    });
  return { repo, run, reply, plan };
}

describe('review run helpers', () => {
  test('model short names map to Codex ids; full ids pass through', () => {
    expect(CODEX_MODELS.terra).toBe('gpt-6.1-terra');
    expect(resolveCodexModel('Terra')).toBe('gpt-6.1-terra');
    expect(resolveCodexModel('luna')).toBe('gpt-6-luna');
    expect(resolveCodexModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });
  test('session id, rollout model, reply JSON and changed lines', () => {
    expect(
      sessionIdFromEvents([{ type: 'x' }, { type: 'thread.started', thread_id: 'abc' }]),
    ).toBe('abc');
    expect(sessionIdFromEvents([{ type: 'session.created', session_id: 'def' }])).toBe(
      'def',
    );
    expect(sessionIdFromEvents([{ type: 'turn.completed' }])).toBeUndefined();
    const rollout = [
      { type: 'session_meta', payload: { id: 's1', model: 'meta-model' } },
      { type: 'response_item', payload: { type: 'message' } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-terra' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(rolloutModel(rollout)).toEqual({ id: 's1', model: 'gpt-6.1-terra' });
    expect(
      rolloutModel(
        [
          { type: 'session_meta', payload: { id: 's2' } },
          {
            type: 'event_msg',
            payload: {
              type: 'thread_settings_applied',
              thread_settings: { model: 'm2' },
            },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      ),
    ).toEqual({ id: 's2', model: 'm2' });
    expect(extractJson('Here:\n```json\n{"v":1}\n```')).toEqual({ v: 1 });
    expect(() => extractJson('no json')).toThrow();
    expect(changedLines('a\nb\nc', 'a\nB\nc')).toEqual([
      '+ body:2 | B',
      '- (removed) | b',
    ]);
  });
  test('the next step names review run only for runner tracetoon', () => {
    const t = graphNext('r1', {
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    expect(t).toContain('`tracetoon review run --run r1`');
    expect(t).toContain('`tracetoon review run --run r1 --recheck`');
    expect(t).not.toContain('review-packet');
    const l = graphNext('r1', {
      v: 1,
      passes: 1,
      lenses: ['a', 'c'],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    expect(l).toContain('tracetoon review run --run r1 --lens <lens>');
    const agent = graphNext('r1', {
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
    });
    expect(agent).not.toContain('review run');
    expect(agent).toContain('review import');
  });
  test('the runner plan field is stored only for tracetoon', () => {
    expect(planFromOptions({ reviewerRunner: 'agent' })).toEqual({
      v: 1,
      passes: 1,
      lenses: [],
    });
    expect(
      planFromOptions({ reviewerRunner: 'tracetoon.', reviewerModel: 'terra' }),
    ).toEqual({
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    expect(() => planFromOptions({ reviewerRunner: 'robot' })).toThrow(
      'Unknown reviewer runner',
    );
  });
});

describe('tracetoon review run', () => {
  test('runs codex exec pinned to the plan model, imports with provenance, rechecks by resume', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ reviewerModel: 'terra', reviewerEffort: 'xhigh', runner: 'tracetoon' });
    const first = ok(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
    });
    const [call] = calls();
    expect(call!.args.slice(0, 4)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
    ]);
    expect(call!.args).toContain('--json');
    expect(call!.args.join(' ')).toContain('-m gpt-6.1-terra');
    expect(call!.args.join(' ')).toContain('-c model_reasoning_effort="xhigh"');
    expect(call!.args).toContain('--output-schema');
    expect(call!.args).toContain('-o');
    expect(call!.args.join(' ')).toContain(`-C ${run.dir}`);
    expect(call!.args).not.toContain('--ephemeral');
    expect(call!.args.at(-1)).toBe('-');
    expect(call!.prompt).toContain('# Lean review packet');
    expect(call!.prompt).toContain('# Lean reviewer');
    expect(call!.prompt).toContain('Override for this run');
    expect(existsSync(join(run.dir, 'review-findings.schema.json'))).toBe(true);

    expect(first.sessionId).toBeTruthy();
    expect(first.verifiedModel).toBe('gpt-6.1-terra');
    expect(first.pass).toMatchObject({
      pass: 1,
      agentId: first.sessionId,
      model: 'terra',
      effort: 'xhigh',
      findings: 1,
      source: 'tracetoon-run',
      runner: 'codex-exec',
      sessionId: first.sessionId,
      verifiedModel: 'gpt-6.1-terra',
    });
    const written = JSON.parse(
      readFileSync(join(run.dir, 'review-findings.json'), 'utf8'),
    );
    expect(written.reviewer.agentId).toBe(first.sessionId);
    expect(first.planMissing).toEqual([]);
    expect(first.next).toContain('--recheck');
    expect(planGate(run)).toBeUndefined();

    // The author fixes the sentence; the recheck resumes the same session.
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting uses the given name when one is passed, else says hello.\n\nIt previously only said hello.\n\nSee src/greet.ts.\n',
    );
    ok(repo.root, ['render', '--run', run.id, '--no-comic']);
    const again = ok(repo.root, ['review', 'run', '--run', run.id, '--recheck'], {
      FAKE_REVIEW_OUTPUT: reply(),
    });
    const resume = calls()[1]!;
    expect(resume.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resume.args.at(-2)).toBe(first.sessionId);
    expect(resume.args.join(' ')).toContain('-m gpt-6.1-terra');
    expect(resume.args).toContain('--output-schema');
    expect(resume.prompt).toMatch(/\+ body:\d+ \| The greeting uses the given name/);
    expect(resume.prompt).not.toContain('tracetoon:meta');
    expect(resume.prompt).toContain('always uses the given name');
    expect(again.pass).toMatchObject({
      pass: 1,
      sessionId: first.sessionId,
      findings: 0,
      source: 'tracetoon-run',
      verifiedModel: 'gpt-6.1-terra',
    });
    expect(again.passes).toHaveLength(1);
    expect(planGate(run)).toBeUndefined();
  });

  test('lens runs use the lens packet and reference and record the lens', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ lenses: ['a', 'b'], reviewerModel: 'terra', runner: 'tracetoon' });
    expect(cli(repo.root, ['review', 'run', '--run', run.id]).json.error).toContain(
      '--lens <a|b>',
    );
    const a = ok(repo.root, ['review', 'run', '--run', run.id, '--lens', 'a'], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
    });
    expect(calls()[0]!.prompt).toContain('Lens A: place');
    expect(calls()[0]!.prompt).toContain('# Lens reviewer A');
    expect(a.pass).toMatchObject({ lens: 'a', source: 'tracetoon-run' });
    expect(existsSync(join(run.dir, 'review-findings-a.json'))).toBe(true);
    expect(a.planMissing.join(' ')).toContain('tracetoon review run --lens b');
    const b = ok(repo.root, ['review', 'run', '--run', run.id, '--lens', 'b']);
    expect(b.pass).toMatchObject({ pass: 2, lens: 'b' });
    expect(b.planMissing).toEqual([]);
  });

  test('without a reviewer model, or with a conflicting override, nothing runs', () => {
    const { repo, run, plan } = renderedRun();
    expect(cli(repo.root, ['review', 'run', '--run', run.id]).json.error).toContain(
      'No reviewer model configured',
    );
    plan({ reviewerModel: 'terra' });
    expect(
      cli(repo.root, ['review', 'run', '--run', run.id, '--model', 'luna']).json.error,
    ).toContain('names reviewer model terra');
    expect(calls()).toHaveLength(0);
  });

  test('failures import nothing: non-zero exit and unreadable output', () => {
    const { repo, run, plan } = renderedRun();
    plan({ reviewerModel: 'terra', runner: 'tracetoon' });
    const failed = cli(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_EXIT: '3',
    });
    expect(failed.code).not.toBe(0);
    expect(failed.json.error).toContain('exited 3');
    expect(failed.json.error).toContain('Nothing was imported');
    const bad = cli(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: 'I could not review this.',
    });
    expect(bad.json.error).toContain('could not be read as findings JSON');
    expect(existsSync(join(run.dir, 'review.json'))).toBe(false);
    expect(existsSync(join(run.dir, 'review-findings.json'))).toBe(false);
  });

  test('a rollout on another model is recorded, and the gate refuses it', () => {
    const { repo, run, plan } = renderedRun();
    plan({ reviewerModel: 'terra', runner: 'tracetoon' });
    const r = ok(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_ROLLOUT_MODEL: 'gpt-6-luna',
    });
    expect(r.verifiedModel).toBe('gpt-6-luna');
    expect(r.warnings.join(' ')).toContain('ran on gpt-6-luna, not gpt-6.1-terra');
    expect(planGate(run)).toContain('ran on gpt-6-luna, not gpt-6.1-terra');
    ok(repo.root, ['render', '--run', run.id, '--no-comic']);
    const refused = cli(repo.root, ['publish', '--run', run.id]);
    expect(refused.code).not.toBe(0);
    expect(refused.json.error).toContain('tracetoon review run');
    // No rollout at all: the model is unverified, also refused.
    const none = ok(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_NO_ROLLOUT: '1',
    });
    expect(none.verifiedModel).toBeNull();
    expect(planGate(run)).toContain('rollout shows no model');
  });

  test('runner tracetoon refuses agent-imported passes; runner agent accepts them', () => {
    const { repo, run, reply, plan } = renderedRun();
    writeFileSync(
      join(run.dir, 'review-findings.json'),
      reply('always uses the given name').replace('codex-exec', 'agent-x7k'),
    );
    plan({ reviewerModel: 'terra', runner: 'tracetoon' });
    ok(repo.root, ['review', 'import', '--run', run.id, '--reviewer-model', 'terra']);
    expect(planGate(run)).toContain('was not run by Tracetoon');
    const rendered = cli(repo.root, ['render', '--run', run.id, '--no-comic']);
    expect(rendered.json.reviewPlan.missing.join(' ')).toContain('tracetoon review run');
    const refused = cli(repo.root, ['publish', '--run', run.id]);
    expect(refused.json.error).toContain('was not run by Tracetoon');
    // Same passes with runner agent: the gate is as before.
    plan({ reviewerModel: 'terra' });
    expect(planGate(run)).toBeUndefined();
  });

  test('prepare stores the runner from the SKILL line and points at review run', () => {
    const { repo, run } = renderedRun();
    const skill = join(dirname(config), 'SKILL.md');
    writeFileSync(
      skill,
      'Reviewer model: terra.\n\nReviewer effort: default.\n\nReview passes: 1.\n\nReview lenses: none.\n\nReviewer runner: tracetoon.\n\nBrief layout: toon.\n',
    );
    const prepared = ok(repo.root, ['prepare', '--offline'], {
      TRACETOON_SKILL_MD: skill,
    });
    expect(
      JSON.parse(readFileSync(join(prepared.runDir, 'review-plan.json'), 'utf8')),
    ).toEqual({
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    if (prepared.next) {
      expect(prepared.next).toContain(`tracetoon review run --run ${prepared.run}`);
      expect(prepared.next).toContain('--recheck');
    }
    // The flag wins over the SKILL line.
    const flagged = ok(
      repo.root,
      [
        'prepare',
        '--offline',
        '--run',
        run.id,
        '--reviewer-model',
        'terra',
        '--reviewer-runner',
        'agent',
      ],
      { TRACETOON_SKILL_MD: skill },
    );
    expect(
      JSON.parse(readFileSync(join(flagged.runDir, 'review-plan.json'), 'utf8')).runner,
    ).toBeUndefined();
  });
});
