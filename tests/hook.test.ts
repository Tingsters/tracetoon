import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decide, DENY_REASON, writesPr } from '../src/hook/prHook.ts';
import { parseAliases } from '../src/hook/prCommands.ts';
import {
  hookCommand,
  hookStatus,
  hookTargets,
  installHooks,
  uninstallHooks,
} from '../src/hook/install.ts';
import { switchState } from '../src/hook/switches.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';

const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const claude = (command: string, cwd = tempDir()) => ({ tool_input: { command }, cwd });

let savedConfig: string | undefined;
beforeEach(() => {
  savedConfig = process.env.TRACETOON_CONFIG;
  process.env.TRACETOON_CONFIG = join(tempDir('tracetoon-cfg-'), 'config.json');
});
afterEach(() => {
  if (savedConfig === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = savedConfig;
});
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  CI: '',
  TRACETOON: '',
  ...extra,
});

describe('which commands are PR writes', () => {
  test.each([
    ['gh pr create --title x --body y', true],
    ['cd repo && gh pr create --fill', true],
    ['git push -u origin feat && gh pr create', true],
    ['GH_TOKEN=abc gh pr create', true],
    ['"C:/Program Files/GitHub CLI/gh.exe" pr create', true],
    ['& gh pr new', true],
    ['gh pr edit 5 --body-file b.md', true],
    ['gh pr edit 5 -t "New title"', true],
    ['gh pr edit 5', true],
    ['gh pr edit 5 --add-label bug', false],
    ['gh pr view 5', false],
    ['gh pr list', false],
    ['gh pr merge 5 --merge', false],
    ['echo "gh pr create"', false],
    ['git commit -m "use gh pr create later"', false],
    ['gh pr create --body "a; b"', true],
    ['gh pr create --title "Fix a && b"', true],
    // Heredoc bodies and quoted multi-line text are file content, not commands.
    ["cat >> notes.md <<'EOF'\ngh pr create --fill\nEOF", false],
    ["cat > t.ts <<EOF\nrun('git push && gh pr create --fill')\nEOF\nbun test", false],
    ['git commit -m "first line\ngh pr create --fill"', false],
    ["cat > a.txt <<'EOF'\nnothing\nEOF\ngh pr create --fill", true],
    // Other PR CLIs.
    ['hub pull-request -m "Fix it"', true],
    ['hub pr list', false],
    ['git pull-request', true],
    ['git -C ../other pull-request', true],
    ['git town propose', true],
    ['git town new-pull-request', true],
    ['git-town propose --title x', true],
    ['git town sync', false],
    // Stacking tools manage whole stacks; Tracetoon leaves them alone.
    ['gt submit --stack', false],
    ['git-spice branch submit', false],
    // The API, through gh/hub or any HTTP client.
    ['gh api repos/acme/demo/pulls -f title=x -f head=f -f base=main', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f body=new', true],
    ['gh api repos/acme/demo/pulls', false],
    [
      "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'",
      true,
    ],
    ['hub api -X POST repos/acme/demo/pulls --input pr.json', true],
    ['curl -X POST https://api.github.com/repos/acme/demo/pulls -d @pr.json', true],
    ['curl -s https://api.github.com/repos/acme/demo/pulls', false],
    // curl's lowercase -x is --proxy: a read through a proxy, not a write.
    ['curl -x proxy.example:8080 https://api.github.com/repos/acme/demo/pulls', false],
    ['iwr -method POST https://api.github.com/repos/acme/demo/pulls', true],
    // Joined and abbreviated flags.
    ['curl -XPOST https://api.github.com/repos/acme/demo/pulls -d @pr.json', true],
    ['curl -d@pr.json https://api.github.com/repos/acme/demo/pulls', true],
    ['curl -X post https://api.github.com/repos/acme/demo/pulls -d "{}"', true],
    [
      'Invoke-RestMethod -Method:Post -Uri https://api.github.com/repos/acme/demo/pulls',
      true,
    ],
    ['irm -Meth Post https://api.github.com/repos/acme/demo/pulls', true],
    [
      'Invoke-RestMethod -Uri https://api.github.com/repos/acme/demo/pulls -Body $b',
      false,
    ],
    // Reads that carry data as a query string.
    ['curl -G -d state=open https://api.github.com/repos/acme/demo/pulls', false],
    ['http https://api.github.com/repos/acme/demo/pulls state==open', false],
    // Closing a PR is not a description write, like gh pr close.
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=closed', false],
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d \'{"state":"closed"}\'',
      false,
    ],
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d \'{"title":"x"}\'',
      true,
    ],
    // The state-only check reads the payload, never the URL, and can't see into files.
    [
      'curl -X PATCH https://api.github.com/repos/acme/state/pulls/3 -d \'{"title":"x"}\'',
      true,
    ],
    // A repo named "state" with a payload that never mentions state (passed on main).
    ['gh api -X PATCH repos/acme/state/pulls/3 -f base=main', true],
    // Only PATCH can be a state-only change.
    ['gh api -X PUT repos/acme/demo/pulls/3 -f state=closed', true],
    ['curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d @state.json', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 --input state.json', true],
    // Every spelling of a file payload is a write.
    ['curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d@state.json', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 --input=state.json', true],
    [
      'Invoke-RestMethod -Method Patch -Uri https://api.github.com/repos/acme/demo/pulls/3 -InFile state.json',
      true,
    ],
    // State-only means state is the only field sent.
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=open -f base=main', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f base=state', true],
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d \'{"state":"open","base":"main"}\'',
      true,
    ],
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d state=open&base=main',
      true,
    ],
    [
      'Invoke-RestMethod -Method Patch -Uri https://api.github.com/repos/acme/demo/pulls/3 -Body \'{"state":"closed"}\'',
      false,
    ],
    // Joined and long field flags are read too.
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=open --field=base=main', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=open --raw-field=base=main', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=open -fbase=main', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -F state=open -Fbase=main', true],
    ['gh api -X PATCH repos/acme/demo/pulls/3 --field=state=closed', false],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -fstate=closed', false],
    // A JSON key with an escape can't be read, so it is a write.
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d \'{"state":"closed","ba\\u0073e":"main"}\'',
      true,
    ],
    // PowerShell: inline values, hashtable bodies, and headers that aren't payload.
    [
      'Invoke-RestMethod -Method Patch -Uri https://api.github.com/repos/acme/demo/pulls/3 -Body:\'{"state":"closed"}\'',
      false,
    ],
    [
      'Invoke-RestMethod -Method Patch -Uri https://api.github.com/repos/acme/demo/pulls/3 -Headers @{Accept=\'application/json\'} -Body \'{"state":"closed"}\'',
      false,
    ],
    [
      "Invoke-RestMethod -Method Patch -Uri https://api.github.com/repos/acme/demo/pulls/3 -Body @{state='closed'; base='main'}",
      true,
    ],
    ['gh api -X POST repos/acme/demo/pulls -f state=open -f head=f -f base=main', true],
    // HEAD is a read, for gh/hub api as for the HTTP clients.
    ['gh api -X HEAD repos/acme/demo/pulls', false],
    // PowerShell's colon form for -Uri.
    [
      'Invoke-RestMethod -Method Post -Uri:https://api.github.com/repos/acme/demo/pulls',
      true,
    ],
    // Other forges' pulls APIs are not GitHub PRs.
    [
      'curl -X POST https://gitea.example.com/api/v1/repos/acme/demo/pulls -d "{}"',
      false,
    ],
    [
      'curl -X POST https://ghe.example.com/api/graphql -d \'{"query":"mutation{createPullRequest}"}\'',
      true,
    ],
    [
      'curl --request PATCH https://ghe.example.com/api/v3/repos/acme/demo/pulls/4 --data-raw "{}"',
      true,
    ],
    [
      'curl -H "Authorization: x" --json @pr.json https://api.github.com/repos/acme/demo/pulls',
      true,
    ],
    ['curl https://api.github.com/repos/acme/demo/pulls/4/comments -d "{}"', false],
    [
      'curl -X POST https://api.github.com/graphql -d \'{"query":"mutation{createPullRequest}"}\'',
      true,
    ],
    ['wget --post-data "{}" https://api.github.com/repos/acme/demo/pulls', true],
    ['http POST https://api.github.com/repos/acme/demo/pulls title=x', true],
    [
      `http --raw '{"title":"new"}' PATCH https://api.github.com/repos/acme/demo/pulls/3`,
      true,
    ],
    [`http --raw='{"title":"new"}' https://api.github.com/repos/acme/demo/pulls`, true],
    ['http https://api.github.com/repos/acme/demo/pulls @pr.json', true],
    [
      'https -A bearer -a TOKEN PATCH https://api.github.com/repos/acme/demo/pulls/3 title=new',
      true,
    ],
    [
      'xh --auth-type bearer --auth TOKEN PATCH https://api.github.com/repos/acme/demo/pulls/3 title=new',
      true,
    ],
    [
      'xhs --timeout 30 PATCH https://api.github.com/repos/acme/demo/pulls/3 title=new',
      true,
    ],
    [
      `http --raw '{"title":"new"}' GET https://api.github.com/repos/acme/demo/pulls/3`,
      false,
    ],
    ['http -A bearer -a TOKEN HEAD https://api.github.com/repos/acme/demo/pulls', false],
    [
      'http --auth=PATCH --style=POST GET https://api.github.com/repos/acme/demo/pulls',
      false,
    ],
    ['http --auth PATCH https://api.github.com/repos/acme/demo/pulls', false],
    [
      `http --raw '{"state":"closed"}' PATCH https://api.github.com/repos/acme/demo/pulls/3`,
      false,
    ],
    [
      `http --raw='{"state":"closed"}' PATCH https://api.github.com/repos/acme/demo/pulls/3`,
      false,
    ],
    [
      'http -A bearer -a TOKEN PATCH https://api.github.com/repos/acme/demo/pulls/3 state=closed',
      false,
    ],
    [
      'http --auth-type=bearer --auth=TOKEN PATCH https://api.github.com/repos/acme/demo/pulls/3 state=closed',
      false,
    ],
    ['http https://api.github.com/repos/acme/demo/pulls', false],
    [
      'Invoke-RestMethod -Method Post -Uri https://api.github.com/repos/acme/demo/pulls -Body $b',
      true,
    ],
    ['irm https://api.github.com/repos/acme/demo/pulls', false],
    ['echo "curl -X POST https://api.github.com/repos/acme/demo/pulls"', false],
  ])('%s -> %p', (cmd, expected) => {
    expect(writesPr(cmd)).toBe(expected);
  });

  test('gh aliases that expand to a PR write count, others do not', () => {
    const dir = tempDir('gh-config-');
    writeFileSync(
      join(dir, 'config.yml'),
      [
        'git_protocol: https',
        'aliases:',
        '    prc: pr create --fill',
        "    ship: '!gh pr create --fill && gh pr view --web'",
        "    pushpr: '!git push -u origin HEAD && gh pr create --fill'",
        '    co: pr checkout',
        '    setbody: pr edit --body-file',
        'editor: vim',
        '',
      ].join('\n'),
    );
    const before = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = dir;
    try {
      expect(parseAliases(readFileSync(join(dir, 'config.yml'), 'utf8'))).toMatchObject({
        prc: 'pr create --fill',
        co: 'pr checkout',
      });
      expect(writesPr('gh prc')).toBe(true);
      expect(writesPr('gh ship')).toBe(true);
      expect(writesPr('gh setbody 5 b.md')).toBe(true);
      // A shell alias writes the PR wherever the write sits in its command line.
      expect(writesPr('gh pushpr')).toBe(true);
      expect(writesPr('gh co 5')).toBe(false);
      expect(writesPr('gh unknown-alias')).toBe(false);
    } finally {
      if (before === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = before;
    }
  });
});

describe('hook decisions', () => {
  test('denies in each agent format', () => {
    const c = JSON.parse(decide('claude', claude('gh pr create'), env())!);
    expect(c.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason: string = c.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toBe(DENY_REASON);
    expect(reason).toContain(
      'Tracetoon handles pull requests on this machine: it writes the description',
    );
    expect(reason).toContain('then creates the PR');
    expect(reason).toContain('use the tracetoon skill and finish with tracetoon publish');
    expect(reason).toContain('TRACETOON=0');
    // The PR is created directly; nothing waits for a local preview or approval.
    expect(reason).not.toMatch(/preview|approv/i);
    expect(
      JSON.parse(decide('codex', claude('gh pr create'), env())!).hookSpecificOutput
        .permissionDecision,
    ).toBe('deny');
    const a = JSON.parse(
      decide(
        'antigravity',
        { toolCall: { args: { CommandLine: JSON.stringify('gh pr create') } } },
        env(),
      )!,
    );
    expect(a).toMatchObject({ decision: 'deny', reason: DENY_REASON });
  });

  test('lets everything else through', () => {
    const cwd = tempDir();
    expect(decide('claude', claude('ls -la', cwd), env())).toBeUndefined();
    expect(decide('claude', claude('gh pr view', cwd), env())).toBeUndefined();
    expect(decide('claude', {}, env())).toBeUndefined();
    expect(decide('claude', 'nonsense', env())).toBeUndefined();
  });

  test('ordinary commands in a repo with Tracetoon runs get no reminder', () => {
    const repo = makeRepo();
    mkdirSync(join(repo.root, '.git', 'tracetoon', 'runs', 'r1'), { recursive: true });
    writeFileSync(
      join(repo.root, '.git', 'tracetoon', 'runs', 'r1', 'approval.json'),
      '{}',
    );
    for (const command of ['git status', 'bun test', 'git push -u origin HEAD'])
      expect(decide('claude', claude(command, repo.root), env())).toBeUndefined();
    expect(decide('antigravity', claude('git status', repo.root), env())).toBeUndefined();
  });

  test('every bypass and switch turns it off', () => {
    expect(decide('claude', claude('TRACETOON=0 gh pr create'), env())).toBeUndefined();
    expect(
      decide('claude', claude("$env:TRACETOON='0'; gh pr create"), env()),
    ).toBeUndefined();
    expect(
      decide('claude', claude('set TRACETOON=0 && gh pr create'), env()),
    ).toBeUndefined();
    expect(
      decide('claude', claude('gh pr create'), env({ TRACETOON: '0' })),
    ).toBeUndefined();
    expect(decide('claude', claude('gh pr create'), env({ CI: 'true' }))).toBeUndefined();
    expect(
      decide('claude', claude('gh pr create'), env({ CI: 'true', TRACETOON: '1' })),
    ).toBeDefined();
  });

  test('repo, personal and user settings, with any off winning', () => {
    const repo = makeRepo();
    const at = (s: string) => decide('claude', claude(s, repo.root), env());
    expect(at('gh pr create')).toBeDefined();
    git(repo.root, ['config', 'tracetoon.enabled', 'false']);
    expect(switchState(repo.root, env())).toMatchObject({
      enabled: false,
      decidedBy: 'local',
    });
    expect(at('gh pr create')).toBeUndefined();
    git(repo.root, ['config', '--unset', 'tracetoon.enabled']);
    mkdirSync(join(repo.root, '.github'), { recursive: true });
    writeFileSync(
      join(repo.root, '.github', 'tracetoon.json'),
      JSON.stringify({ enabled: false }),
    );
    expect(switchState(repo.root, env())).toMatchObject({
      enabled: false,
      decidedBy: 'repo',
    });
    writeFileSync(
      join(repo.root, '.github', 'tracetoon.json'),
      JSON.stringify({ enabled: true }),
    );
    writeFileSync(process.env.TRACETOON_CONFIG!, JSON.stringify({ enabled: false }));
    expect(switchState(repo.root, env())).toMatchObject({
      enabled: false,
      decidedBy: 'user',
    });
  });
});

describe('installing the hook', () => {
  function home() {
    const h = tempDir('tracetoon-home-');
    mkdirSync(join(h, '.claude'), { recursive: true });
    mkdirSync(join(h, '.codex'), { recursive: true });
    mkdirSync(join(h, '.gemini', 'antigravity-cli'), { recursive: true });
    return h;
  }
  const existingClaude = {
    model: 'opus',
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'other-tool check' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'showtail hook stop' }] }],
    },
  };

  test('merges next to existing hooks, idempotently, and uninstalls cleanly', () => {
    const h = home();
    const targets = hookTargets(h, {});
    writeFileSync(
      join(h, '.claude', 'settings.json'),
      JSON.stringify(existingClaude, null, 2),
    );
    writeFileSync(join(h, '.gemini', 'config.json'), '{}');
    mkdirSync(join(h, '.gemini', 'config'), { recursive: true });
    writeFileSync(
      join(h, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({ 'showtail-cli': { enabled: true } }),
    );

    const first = installHooks('/opt/tracetoon/bin', targets);
    expect(first.map((c) => c.result)).toEqual(['installed', 'installed', 'installed']);
    expect(first[1]!.note).toContain('/hooks');
    expect(installHooks('/opt/tracetoon/bin', targets).map((c) => c.result)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);

    const settings = JSON.parse(
      readFileSync(join(h, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop[0]).toEqual(existingClaude.hooks.Stop[0]);
    expect(settings.hooks.Stop[1].hooks[0].command).toContain(
      'hook lifecycle --agent claude --event Stop',
    );
    expect(settings.hooks.PreToolUse).toHaveLength(3);
    expect(settings.hooks.PreToolUse[1]).toMatchObject({
      matcher: 'Bash|PowerShell',
      hooks: [{ command: '/opt/tracetoon/bin hook pre-pr --agent claude' }],
    });
    const agy = JSON.parse(
      readFileSync(join(h, '.gemini', 'config', 'hooks.json'), 'utf8'),
    );
    expect(Object.keys(agy)).toEqual(['showtail-cli', 'tracetoon']);
    expect(agy.tracetoon.PreToolUse[0].matcher).toBe('run_command');
    expect(existsSync(join(h, '.claude', 'settings.json.tracetoon.bak'))).toBe(true);
    expect(hookStatus(targets).map((s) => s.installed)).toEqual([true, true, true]);

    expect(uninstallHooks(targets).map((c) => c.result)).toEqual([
      'removed',
      'removed',
      'removed',
    ]);
    expect(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))).toEqual(
      existingClaude,
    );
    expect(existsSync(join(h, '.codex', 'hooks.json'))).toBe(false); // created by us, now empty
    expect(
      JSON.parse(readFileSync(join(h, '.gemini', 'config', 'hooks.json'), 'utf8')),
    ).toEqual({ 'showtail-cli': { enabled: true } });
  });

  test('never touches a file it cannot parse, and skips missing agents', () => {
    const h = tempDir('tracetoon-home-');
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', 'settings.json'), '{ not json');
    const changes = installHooks('/x/tracetoon', hookTargets(h, {}));
    expect(changes[0]).toMatchObject({ result: 'skipped' });
    expect(changes[0]!.note).toContain('left untouched');
    expect(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
    expect(changes.slice(1).map((c) => c.note)).toEqual([
      'not installed',
      'not installed',
    ]);
  });

  test('hook commands use forward slashes and quote paths with spaces', () => {
    expect(
      hookCommand(
        'codex',
        'C:\\Users\\me\\AppData\\Local\\tracetoon\\cache\\1.0.0\\tracetoon-windows-x64.exe',
      ),
    ).toBe(
      'C:/Users/me/AppData/Local/tracetoon/cache/1.0.0/tracetoon-windows-x64.exe hook pre-pr --agent codex',
    );
    expect(hookCommand('claude', ['C:\\Program Files\\bun.exe', 'C:\\src\\cli.ts'])).toBe(
      '"C:/Program Files/bun.exe" C:/src/cli.ts hook pre-pr --agent claude',
    );
  });
});

describe('hook end to end', () => {
  test('the CLI reads stdin and answers like an agent hook', () => {
    const run = (payload: unknown, extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, [CLI, 'hook', 'pre-pr', '--agent', 'claude'], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: env(extra),
      });
    const denied = run(claude('gh pr create --fill'));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const allowed = run(claude('git status'));
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');
    const garbage = spawnSync(
      process.execPath,
      [CLI, 'hook', 'pre-pr', '--agent', 'claude'],
      { input: 'not json', encoding: 'utf8', env: env() },
    );
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe('');
  });
});

describe('hook diagnostics', () => {
  test("flags other tools' invalid Antigravity blocks and untrusted Codex hooks", () => {
    const h = tempDir('tracetoon-home-');
    mkdirSync(join(h, '.gemini', 'antigravity-cli'), { recursive: true });
    mkdirSync(join(h, '.gemini', 'config'), { recursive: true });
    mkdirSync(join(h, '.codex'), { recursive: true });
    // Handlers nested under "hooks" for a non-tool event: Antigravity rejects the whole file.
    writeFileSync(
      join(h, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({
        other: { enabled: true, Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      }),
    );
    const targets = hookTargets(h, {});
    const changes = installHooks('/x/tracetoon', targets);
    expect(changes[2]!.note).toContain('invalid block from another tool (other)');
    const status = hookStatus(targets);
    expect(status[1]).toMatchObject({ installed: true });
    expect(status[1]!.problem).toContain('/hooks');
    expect(status[2]!.problem).toContain('(other)');

    writeFileSync(
      join(h, '.codex', 'config.toml'),
      "[hooks.state.'" +
        join(h, '.codex') +
        '\hooks.json:pre_tool_use:0:0\']\ntrusted_hash = "sha256:x"\n',
    );
    expect(hookStatus(targets)[1]!.problem).toBeUndefined();
    writeFileSync(
      join(h, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({
        other: { enabled: true, Stop: [{ type: 'command', command: 'x' }] },
        tracetoon: JSON.parse(
          readFileSync(join(h, '.gemini', 'config', 'hooks.json'), 'utf8'),
        ).tracetoon,
      }),
    );
    expect(hookStatus(targets)[2]!.problem).toBeUndefined();
  });
});
