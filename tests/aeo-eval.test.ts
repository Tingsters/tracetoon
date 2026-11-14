import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENTS_MD,
  createFixture,
  FEATURE_BRANCH,
  GH_SHIM,
  installedSkills,
  readGhLog,
  START_MARKER,
  type GhCall,
} from '../evals/aeo/fixture.ts';
import { aggregate, markdown, type RunResult } from '../evals/aeo/report.ts';
import { scrubber } from '../evals/aeo/run.ts';
import {
  invokesTracetoon,
  parseClaudeStream,
  parseCodexJson,
  parseOpencodeJson,
  readSessions,
  score,
} from '../evals/aeo/score.ts';
import { tempDir } from './helpers.ts';

setDefaultTimeout(60_000);

const FIXTURES = join(import.meta.dir, '..', 'evals', 'aeo', 'fixtures');
const transcript = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const create = (body: string): GhCall => ({
  args: ['pr', 'create', '--title', 'Add greet helper', '--body-file', 'x'],
  body,
});
const base = { gh: [], preinstalled: false, skillsAfter: [], wallMs: 1000 };

describe('aeo score', () => {
  test('a skill-driven Tracetoon publish passes every stage', () => {
    const s = score({
      ...base,
      host: 'claude',
      stdout: transcript('claude-skill-run.jsonl'),
      gh: [create(`${START_MARKER}\n## Summary\n<!-- tracetoon:end -->`)],
      preinstalled: true,
    });
    expect(s).toMatchObject({
      discover: true,
      discoverVia: 'text',
      suggest: true,
      install: true,
      installVia: 'preinstalled',
      run: true,
      prCreated: true,
      skillTrigger: true,
      tracetoonCommands: 2,
      tracetoonCommandsOk: 2,
      turns: 5,
      costUsd: 0.4213,
      sessionId: 'sess-claude-1',
    });
    expect(s.tokens).toEqual({
      input: 120,
      output: 900,
      cacheRead: 40000,
      cacheWrite: 3000,
    });
  });

  test("a skill in the host's startup list is not a discovery; a plain gh PR is not a run", () => {
    const s = score({
      ...base,
      host: 'claude',
      stdout: transcript('claude-clean-gh.jsonl'),
      gh: [create('Adds greet() with tests.')],
    });
    expect(s).toMatchObject({
      discover: false,
      suggest: false,
      install: false,
      run: false,
      prCreated: true,
      skillTrigger: false,
      tracetoonCommands: 0,
    });
  });

  test('a hook redirect is a discovery and the offer is a suggestion', () => {
    const t = parseCodexJson(transcript('codex-hook-redirect.jsonl'));
    expect(t.sessionId).toBe('thread-codex-1');
    expect(t.events.find((e) => e.kind === 'result')?.isError).toBe(true);
    const s = score({
      ...base,
      host: 'codex',
      stdout: transcript('codex-hook-redirect.jsonl'),
    });
    expect(s).toMatchObject({
      discover: true,
      discoverVia: 'result',
      suggest: true,
      install: false,
      run: false,
      prCreated: false,
    });
    expect(s.tokens).toEqual({
      input: 5000,
      output: 300,
      cacheRead: 2000,
      cacheWrite: 0,
    });
  });

  test('web discovery and an agent-driven install', () => {
    const t = parseOpencodeJson(transcript('opencode-web-install.jsonl'));
    expect(t.events.filter((e) => e.kind === 'web')).toHaveLength(2); // the search and its result
    const s = score({
      ...base,
      host: 'opencode',
      stdout: transcript('opencode-web-install.jsonl'),
      skillsAfter: ['<home>/.agents/skills/tracetoon'],
    });
    expect(s).toMatchObject({
      discover: true,
      discoverVia: 'web',
      suggest: true,
      install: true,
      installVia: 'skill-dir',
      run: false,
      webCalls: 1,
      tracetoonCommands: 1,
      tracetoonCommandsOk: 0,
      costUsd: 0.012,
      turns: 1,
    });
  });

  test('a successful tracetoon command counts as an install when nothing was preinstalled', () => {
    const stdout = [
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'tracetoon doctor',
          aggregated_output: 'ok',
          exit_code: 0,
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(score({ ...base, host: 'codex', stdout })).toMatchObject({
      install: true,
      installVia: 'command',
    });
  });

  test('which commands run Tracetoon', () => {
    for (const cmd of [
      'tracetoon publish --push',
      '"/h/.claude/skills/tracetoon/bin/tracetoon" digest --json',
      'bun ~/.agents/skills/tracetoon/dist/tracetoon.mjs context',
      'C:\\x\\bin\\tracetoon.cmd --version',
    ])
      expect(invokesTracetoon(cmd)).toBe(true);
    for (const cmd of [
      'cat ~/.claude/skills/tracetoon/SKILL.md',
      'grep -ri tracetoon README.md',
      'npm view tracetoon',
      'gh pr create --title tracetoon',
    ])
      expect(invokesTracetoon(cmd)).toBe(false);
  });

  test('unparseable output scores as nothing happened', () => {
    expect(parseClaudeStream('not json\n{broken').events).toEqual([]);
    expect(score({ ...base, host: 'claude', stdout: '' })).toMatchObject({
      discover: false,
      suggest: false,
      install: false,
      run: false,
    });
  });
});

describe('aeo fixture', () => {
  test('a clean repo with an unpushed feature branch and a recording gh', () => {
    const f = createFixture({
      host: 'codex',
      condition: 'clean',
      parent: tempDir('aeo-'),
    });
    const git = (...a: string[]) =>
      spawnSync('git', a, { cwd: f.repo, env: f.env, encoding: 'utf8' }).stdout.trim();
    expect(git('branch', '--show-current')).toBe(FEATURE_BRANCH);
    expect(git('rev-list', '--count', 'main..HEAD')).toBe('2');
    expect(git('ls-remote', '--heads', 'origin')).toContain('refs/heads/main');
    expect(git('ls-remote', '--heads', 'origin')).not.toContain(FEATURE_BRANCH);
    expect(f.preinstalled).toBe(false);
    expect(installedSkills(f)).toEqual([]);
    expect(f.env.HOME).toBe(f.home);
    expect(f.env.CODEX_HOME!.startsWith(f.home)).toBe(true);
    expect(existsSync(join(f.repo, 'AGENTS.md'))).toBe(false);

    // Tracetoon reaches the shim through TRACETOON_GH_SCRIPT...
    const body = join(f.dir, 'body.md');
    writeFileSync(body, `${START_MARKER}\nhello\n`);
    const r = spawnSync(
      process.execPath,
      [
        GH_SHIM,
        'pr',
        'create',
        '--title',
        'T',
        '--body-file',
        body,
        '--head',
        FEATURE_BRANCH,
      ],
      { cwd: f.repo, env: f.env, encoding: 'utf8' },
    );
    expect(r.stdout.trim()).toBe('https://github.com/acme/demo/pull/1');
    // ...and the agent's shell through `gh` on PATH.
    const sh = spawnSync('sh', ['-c', 'gh pr view --json url -q .url'], {
      cwd: f.repo,
      env: f.env,
      encoding: 'utf8',
    });
    expect(sh.stdout.trim()).toBe('https://github.com/acme/demo/pull/1');
    const calls = readGhLog(f.ghLog);
    expect(calls[0]).toMatchObject({
      args: [
        'pr',
        'create',
        '--title',
        'T',
        '--body-file',
        body,
        '--head',
        FEATURE_BRANCH,
      ],
    });
    expect(calls[0]!.body).toContain(START_MARKER);
    expect(calls[1]!.args.slice(0, 2)).toEqual(['pr', 'view']);

    // The seeded session that wrote the branch is not the agent's.
    expect(readSessions('codex', f.repo, f.env).sessions).toEqual([]);
    expect(readSessions('claude', f.repo, f.env).sessions).toEqual([]);
  });

  test('skill and agents-md conditions', () => {
    const source = tempDir('aeo-skill-');
    mkdirSync(join(source, 'bin'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: tracetoon\n---\n');
    writeFileSync(join(source, 'bin', 'tracetoon'), '#!/bin/sh\necho ok\n');
    chmodSync(join(source, 'bin', 'tracetoon'), 0o755);
    const skill = createFixture({
      host: 'codex',
      condition: 'skill',
      parent: tempDir('aeo-'),
      skillSource: source,
    });
    expect(skill.preinstalled).toBe(true);
    expect(skill.skillDir.startsWith(skill.home)).toBe(true);
    expect(installedSkills(skill)).toEqual([skill.skillDir]);

    const md = createFixture({
      host: 'claude',
      condition: 'agents-md',
      parent: tempDir('aeo-'),
    });
    expect(readFileSync(join(md.repo, 'AGENTS.md'), 'utf8')).toBe(AGENTS_MD);
    expect(readFileSync(join(md.repo, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(md.preinstalled).toBe(false);
    expect(() => createFixture({ host: 'claude', condition: 'mcp' })).toThrow(
      /not implemented/,
    );
  });
});

describe('aeo report', () => {
  test('rates per agent, tier and condition', () => {
    const s = score({
      ...base,
      host: 'claude',
      stdout: transcript('claude-skill-run.jsonl'),
    });
    const run = (trial: number, run: boolean): RunResult => ({
      agent: 'claude',
      tier: 4,
      condition: 'skill',
      web: true,
      trial,
      exitCode: 0,
      timedOut: false,
      score: { ...s, run },
      notes: [],
    });
    const cells = aggregate([run(1, true), run(2, false)]);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ n: 2, discover: 2, run: 1, agentInstall: 2 });
    const md = markdown({
      name: 'unit',
      startedAt: '2026-11-13T00:00:00Z',
      tracetoon: { version: '0.0.0' },
      agents: { claude: { version: '1.0.0' } },
      matrix: {
        agents: ['claude'],
        tiers: [4],
        conditions: ['skill'],
        web: [true],
        trials: 2,
        timeoutMs: 1,
      },
      runs: [run(1, true), run(2, false)],
    });
    expect(md).toContain('| claude | 4 | skill | on | 2 | 2/2 (100%) |');
    expect(md).toContain('| 1/2 (50%) |');
  });

  test('scrubs machine paths', () => {
    const scrub = scrubber({ 'C:\\tmp\\tracetoon-aeo-abc': '<fixture>' });
    expect(
      scrub('cd C:\\tmp\\tracetoon-aeo-abc\\repo && C:/tmp/tracetoon-aeo-abc/x'),
    ).toBe('cd <fixture>\\repo && <fixture>/x');
  });
});
