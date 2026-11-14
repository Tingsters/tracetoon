// `tracetoon mcp`: the stdio MCP server. Spawns the source, the bundle
// (TRACETOON_TEST_CLI) or the native executable (TRACETOON_TEST_BINARY) and talks
// JSON-RPC to it the way an MCP host does.
import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { claudeCodeHint, claudeHasTracetoon } from '../src/util/claudeHint.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');

setDefaultTimeout(120_000);

let env: NodeJS.ProcessEnv;
let home: string;
let ghLog: string;

beforeEach(() => {
  home = tempDir('tracetoon-mcp-home-');
  const scratch = tempDir('tracetoon-mcp-');
  ghLog = join(scratch, 'gh.log');
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CODEX_HOME: join(home, 'codex'),
    GEMINI_HOME: join(home, 'gemini'),
    ANTIGRAVITY_HOME: join(home, 'antigravity'),
    FACTORY_HOME: join(home, 'factory'),
    COPILOT_HOME: join(home, 'copilot'),
    CURSOR_HOME: join(home, 'cursor'),
    KIRO_HOME: join(home, 'kiro'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    TRACETOON_VSCODE_USER_DIR: join(home, 'vscode'),
    TRACETOON_CONFIG: join(scratch, 'config.json'),
    TRACETOON_GH_SCRIPT: FAKE_GH,
    TRACETOON_TEST_RUNNER: process.execPath,
    FAKE_GH_LOG: ghLog,
  };
  delete env.CLAUDE_PROJECT_DIR;
  // Leave the shipped SKILL.md's review plan out, so a plain render can publish.
  const skill = join(scratch, 'SKILL.md');
  writeFileSync(skill, '---\nname: tracetoon\n---\n');
  env.TRACETOON_SKILL_MD = skill;
});

/** A started `tracetoon mcp` with a request/response helper. */
function server(cwd: string) {
  const program = process.env.TRACETOON_TEST_BINARY
    ? [process.env.TRACETOON_TEST_BINARY]
    : [
        process.execPath,
        process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts'),
      ];
  const child = spawn(program[0]!, [...program.slice(1), 'mcp'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const waiting = new Map<number, (m: any) => void>();
  const lines: any[] = [];
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line); // every stdout line must be a JSON-RPC message
      lines.push(m);
      waiting.get(m.id)?.(m);
    }
  });
  const exited = new Promise<number | null>((done) => child.on('exit', done));
  let id = 0;
  return {
    lines,
    stderr: () => stderr,
    request(method: string, params?: object): Promise<any> {
      const n = ++id;
      return new Promise((done) => {
        waiting.set(n, done);
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n',
        );
      });
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    async close() {
      child.stdin.end();
      return exited;
    },
  };
}

async function started(cwd: string) {
  const s = server(cwd);
  const init = await s.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  s.notify('notifications/initialized');
  return { s, init };
}

const ghCalls = (): { args: string[] }[] =>
  existsSync(ghLog)
    ? readFileSync(ghLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe('MCP server', () => {
  test('mcp server lists its tools and skill resources and answers status', async () => {
    const repo = makeRepo();
    const { s, init } = await started(repo.root);
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('tracetoon');
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.capabilities.resources).toBeDefined();
    expect((await s.request('ping')).result).toEqual({});

    const tools = (await s.request('tools/list')).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual([
      'tracetoon_status',
      'tracetoon_prepare_pr',
      'tracetoon_publish_pr',
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.description).toBe('string');
    }
    const byName = (n: string) => tools.find((t: any) => t.name === n);
    expect(byName('tracetoon_status').annotations.readOnlyHint).toBe(true);
    expect(byName('tracetoon_publish_pr').annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName('tracetoon_publish_pr').inputSchema.required).toEqual(['run']);
    expect(byName('tracetoon_publish_pr').inputSchema.properties.dryRun.default).toBe(
      true,
    );
    expect(Object.keys(byName('tracetoon_prepare_pr').inputSchema.properties)).toEqual(
      expect.arrayContaining(['base', 'run', 'layout']),
    );

    const status = (
      await s.request('tools/call', { name: 'tracetoon_status', arguments: {} })
    ).result;
    expect(status.isError).toBeUndefined();
    expect(typeof status.structuredContent.ok).toBe('boolean');
    expect(status.structuredContent.enabled).toBe(true);
    const ids = status.structuredContent.checks.map((c: any) => c.id);
    for (const id of ['git', 'gh', 'repo']) expect(ids).toContain(id);
    expect(JSON.parse(status.content[0].text).checks).toBeDefined();

    const resources = (await s.request('resources/list')).result.resources;
    const uris = resources.map((r: any) => r.uri);
    expect(uris).toContain('tracetoon://skill/SKILL.md');
    expect(uris).toContain('tracetoon://skill/references/drafting.md');
    const skill = (
      await s.request('resources/read', { uri: 'tracetoon://skill/SKILL.md' })
    ).result;
    expect(skill.contents[0].text).toContain('name: tracetoon');
    expect(
      (await s.request('resources/read', { uri: 'tracetoon://skill/../../package.json' }))
        .error.code,
    ).toBe(-32002);

    // Errors keep the CLI's shape.
    const bad = (
      await s.request('tools/call', { name: 'tracetoon_publish_pr', arguments: {} })
    ).result;
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.errorCode).toBe('USAGE');
    const noRun = (
      await s.request('tools/call', {
        name: 'tracetoon_publish_pr',
        arguments: { run: 'nope', render: 'skip' },
      })
    ).result;
    expect(noRun.isError).toBe(true);
    expect(noRun.structuredContent.errorCode).toBe('RUN_NOT_FOUND');
    expect(noRun.structuredContent.fix).toBe('tracetoon prepare --json');
    expect((await s.request('no/such/method')).error.code).toBe(-32601);

    expect(await s.close()).toBe(0);
    // Nothing but protocol messages on stdout.
    for (const m of s.lines) expect(m.jsonrpc).toBe('2.0');
  });

  test('mcp prepare and dry-run publish post nothing', async () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    const GREET = 'export const greet = (name: string) => `Hello, ${name}!`;\n';
    new ClaudeLog(repo.root)
      .prompt('Add greeting')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .save(env.CLAUDE_CONFIG_DIR!, 's1');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');

    const { s } = await started(repo.root);
    const prepared = (
      await s.request('tools/call', {
        name: 'tracetoon_prepare_pr',
        arguments: { offline: true },
      })
    ).result;
    expect(prepared.structuredContent.error).toBeUndefined();
    expect(prepared.isError).toBeUndefined();
    const { run, runDir, drafting, files } = prepared.structuredContent;
    expect(typeof run).toBe('string');
    expect(existsSync(runDir)).toBe(true);
    expect(drafting).toContain('# Drafting from the evidence brief');
    expect(files.body).toBe(join(runDir, 'body.md'));

    writeFileSync(join(runDir, 'body.md'), '## Summary\nAdds a greeting helper.\n');
    writeFileSync(join(runDir, 'title.txt'), 'Add greeting helper\n');
    const dry = (
      await s.request('tools/call', { name: 'tracetoon_publish_pr', arguments: { run } })
    ).result;
    expect(dry.structuredContent.error).toBeUndefined();
    expect(dry.isError).toBeUndefined();
    expect(dry.structuredContent).toMatchObject({
      dryRun: true,
      action: 'create',
      title: 'Add greeting helper',
    });
    expect(dry.structuredContent.render).toBeDefined();
    const commands = dry.structuredContent.commands.map((c: string[]) => c.join(' '));
    expect(commands.some((c: string) => c.startsWith('gh pr create'))).toBe(true);
    expect(await s.close()).toBe(0);

    expect(
      ghCalls().filter(
        (c) => c.args[0] === 'pr' && ['create', 'edit'].includes(c.args[1]!),
      ),
    ).toEqual([]);
    expect(git(remote, ['branch', '--list']).stdout).not.toContain('feature');
    for (const file of ['publish-progress.json', 'published.json', 'posted-body.md'])
      expect(existsSync(join(runDir, file))).toBe(false);
  });
});

describe('Claude Code plugin hint', () => {
  test('off by default; when on, only inside Claude Code and without the plugin', () => {
    const h = tempDir('tracetoon-hint-');
    const inClaude = { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: join(h, 'claude') };
    expect(claudeCodeHint(['doctor'], inClaude, h)).toBeUndefined();
    const line = claudeCodeHint(['doctor', '--json'], inClaude, h, true);
    expect(line).toBe(
      '<claude-code-hint v="1" type="plugin" value="tracetoon@claude-plugins-official" />\n',
    );
    expect(claudeCodeHint(['doctor'], { CLAUDE_CODE_CHILD_SESSION: '1' }, h, true)).toBe(
      line,
    );
    expect(claudeCodeHint(['doctor'], {}, h, true)).toBeUndefined();
    expect(claudeCodeHint(['mcp'], inClaude, h, true)).toBeUndefined();
    expect(claudeCodeHint(['hook', 'pre-pr'], inClaude, h, true)).toBeUndefined();
    const skill = join(h, 'claude', 'skills', 'tracetoon');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: tracetoon\n---\n');
    expect(claudeHasTracetoon(inClaude, h)).toBe(true);
    expect(claudeCodeHint(['doctor'], inClaude, h, true)).toBeUndefined();
  });

  test('a plugin install is detected from installed_plugins.json', () => {
    const h = tempDir('tracetoon-hint-');
    const dir = join(h, '.claude', 'plugins');
    mkdirSync(dir, { recursive: true });
    expect(claudeHasTracetoon({}, h)).toBe(false);
    writeFileSync(
      join(dir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'tracetoon@tracetoon': [] } }),
    );
    expect(claudeHasTracetoon({}, h)).toBe(true);
  });
});
