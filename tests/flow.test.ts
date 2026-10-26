import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from '../src/util/exec.ts';
import { decodeMeta, regionContent } from '../src/github/body.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

// Set TRACETOON_TEST_CLI to run these against the bundled build instead of the source.
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');

let claudeHome: string;
let codexHome: string;
let geminiHome: string;
let env: NodeJS.ProcessEnv;
let ghLog: string;

beforeEach(() => {
  claudeHome = tempDir('tracetoon-claude-');
  codexHome = tempDir('tracetoon-codex-');
  geminiHome = tempDir('tracetoon-gemini-');
  const scratch = tempDir('tracetoon-env-');
  ghLog = join(scratch, 'gh.log');
  env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    ANTIGRAVITY_HOME: geminiHome,
    GEMINI_HOME: geminiHome,
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

setDefaultTimeout(60_000);

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

describe('other agents', () => {
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

  test('matches a Codex session that worked from the home folder', () => {
    const repo = makeRepo();
    const start = Date.now() - 30 * 60_000;
    const t = (n: number) => new Date(start + n * 1000).toISOString();
    const dir = join(codexHome, 'sessions', '2026', '10', '23');
    mkdirSync(dir, { recursive: true });
    const id = '019ef1c4-1899-7a90-bb9f-b09bca10e91c';
    writeFileSync(
      join(dir, `rollout-2026-10-23T10-00-00-${id}.jsonl`),
      jsonl([
        {
          timestamp: t(0),
          type: 'session_meta',
          payload: { id, cwd: tempDir('tracetoon-home-') },
        },
        { timestamp: t(1), type: 'turn_context', payload: { model: 'gpt-test' } },
        {
          timestamp: t(2),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'UserMessage',
              content: [{ type: 'text', text: 'Add the greeting helper please' }],
            },
          },
        },
        {
          timestamp: t(3),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'FileChange',
              status: 'completed',
              changes: {
                [join(repo.root, 'src/greet.ts')]: { type: 'add', content: GREET },
              },
            },
          },
        },
      ]),
    );
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      jsonl([{ id, thread_name: 'Greeting helper' }]),
    );
    repo.commit('src/greet.ts', GREET, 'feat: greeting');
    // An open Windows writer may retain an old mtime while recent events append.
    utimesSync(
      join(dir, `rollout-2026-10-23T10-00-00-${id}.jsonl`),
      new Date('2020-01-01'),
      new Date('2020-01-01'),
    );
    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toMatchObject([
      { agent: 'Codex', title: 'Greeting helper', band: 'included' },
    ]);
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.stats.agentMatchedPct).toBe(100);
    expect(digest.disclosure.suggestedTrailers).toEqual(['Assisted-by: Codex:gpt-test']);
  });

  test('matches an Antigravity conversation and includes its walkthrough', () => {
    const repo = makeRepo();
    const start = Date.now() - 30 * 60_000;
    const t = (n: number) => new Date(start + n * 1000).toISOString();
    const brain = join(geminiHome, 'antigravity-ide', 'brain', 'conv-1');
    mkdirSync(join(brain, '.system_generated', 'logs'), { recursive: true });
    const target = JSON.stringify(join(repo.root, 'src/greet.ts'));
    writeFileSync(
      join(brain, '.system_generated', 'logs', 'transcript.jsonl'),
      jsonl([
        {
          step_index: 0,
          type: 'USER_INPUT',
          created_at: t(0),
          content: '<USER_REQUEST>Write a greeting helper</USER_REQUEST>',
        },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: t(1),
          source: 'MODEL',
          tool_calls: [
            {
              name: 'write_to_file',
              args: { TargetFile: target, CodeContent: JSON.stringify(GREET) },
            },
          ],
        },
        { step_index: 2, type: 'CODE_ACTION', status: 'DONE', created_at: t(2) },
      ]),
    );
    writeFileSync(
      join(brain, 'walkthrough.md'),
      '# Walkthrough\nAdded greet() and verified it in the browser.\n',
    );
    writeFileSync(
      join(brain, 'walkthrough.md.metadata.json'),
      JSON.stringify({ summary: 'Added greet()', updatedAt: t(3) }),
    );
    repo.commit('src/greet.ts', GREET, 'feat: greeting');
    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toMatchObject([{ agent: 'Antigravity', band: 'included' }]);
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.sessions[0].artifacts).toMatchObject([
      { name: 'walkthrough', summary: 'Added greet()' },
    ]);
    expect(digest.sessions[0].prompts[0].text).toBe('Write a greeting helper');
  });

  test('reports Entire checkpoints found in commit trailers', () => {
    const repo = makeRepo();
    repo.commit(
      'a.txt',
      'hello world line\n',
      'feat: a\n\nEntire-Checkpoint: 01JABCDEFGHJKMNPQRSTVWXYZ0',
    );
    const r = cli(repo.root, 'digest', '--offline');
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.interop.entire).toMatchObject({
      checkpoints: ['01JABCDEFGHJKMNPQRSTVWXYZ0'],
      commitsWithCheckpoint: 1,
    });
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
    // A clickable absolute file:/// link, in both render and preview output.
    const url = pathToFileURL(join(runDir, 'preview.html')).href;
    expect(r.json.previewUrl).toBe(url);
    const shown = cli(repo.root, 'preview');
    expect(shown.json.previewUrl).toBe(url);
    const text = spawnSync(process.execPath, [CLI, 'preview'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    });
    expect(text.stdout).toContain(`OPEN YOUR LOCAL PR PREVIEW\n${url}\n`);
    expect(text.stdout.trimEnd()).toEndWith(r.json.previewHandoff.terminal);
    expect(shown.json.previewHandoff.markdown).toContain(`\n\n${url}\n\n`);

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

    const notPushed = cli(repo.root, 'publish', '--code', code, '--no-push');
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
    expect(regionContent(create.body)).toBe(regionContent(finalBody));
    expect(decodeMeta(create.body)?.submission).toBe(code);
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
