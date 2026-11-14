import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { gooseDataDir } from '../src/integrations/goose/trace.ts';
import { codexHookHash } from '../src/integrations/codex/trust.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';

// Several tests build real repos and run many git processes; Windows is slow
// under load (the settings test timed out at the 5 s default).
setDefaultTimeout(60_000);

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

describe('which commands create PRs', () => {
  test.each([
    ['gh pr create --title x --body y', true],
    ['cd repo && gh pr create --fill', true],
    ['git push -u origin feat && gh pr create', true],
    ['GH_TOKEN=abc gh pr create', true],
    ['"C:/Program Files/GitHub CLI/gh.exe" pr create', true],
    ['& gh pr new', true],
    ['gh pr edit 5 --body-file b.md', false],
    ['gh pr edit 5 -t "New title"', false],
    ['gh pr edit 5', false],
    ['gh pr edit 5 --add-label bug', false],
    ['gh pr view 5', false],
    ['gh pr list', false],
    ['gh pr create --help', false],
    ['gh pr create -h', false],
    ['gh pr create --dry-run', false],
    ['gh pr create --body "--help"', true],
    ["@'\nprint('example')\ngh pr create --fill\n'@ | python -", false],
    ["@'\ngh pr create\n'@ | Set-Content notes.txt\ngh pr create --fill", true],
    ['hub pull-request --help', false],
    ['git town propose --dry-run', false],
    ['gh api -X PUT repos/acme/demo/pulls -f title=x', false],
    ['gh api -X PATCH repos/acme/demo/pulls -f title=x', false],
    ['gh api graphql -f query="mutation { updatePullRequest(input: {}) { id } }"', false],
    ['gh api graphql -f query="query { createPullRequest }"', false],
    [
      `gh api graphql -f query='mutation { updatePullRequest(input: {title: "createPullRequest(input: {})"}) { id } }'`,
      false,
    ],
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
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f body=new', false],
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
      false,
    ],
    // The state-only check reads the payload, never the URL, and can't see into files.
    [
      'curl -X PATCH https://api.github.com/repos/acme/state/pulls/3 -d \'{"title":"x"}\'',
      false,
    ],
    // A repo named "state" with a payload that never mentions state (passed on main).
    ['gh api -X PATCH repos/acme/state/pulls/3 -f base=main', false],
    // Existing PR operations pass through for every HTTP method.
    ['gh api -X PUT repos/acme/demo/pulls/3 -f state=closed', false],
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d @state.json',
      false,
    ],
    ['gh api -X PATCH repos/acme/demo/pulls/3 --input state.json', false],
    // Updates read from files also pass through.
    ['curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d@state.json', false],
    ['gh api -X PATCH repos/acme/demo/pulls/3 --input=state.json', false],
    [
      'Invoke-RestMethod -Method Patch -Uri https://api.github.com/repos/acme/demo/pulls/3 -InFile state.json',
      false,
    ],
    // State-only means state is the only field sent.
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=open -f base=main', false],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f base=state', false],
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d \'{"state":"open","base":"main"}\'',
      false,
    ],
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d state=open&base=main',
      false,
    ],
    [
      'Invoke-RestMethod -Method Patch -Uri https://api.github.com/repos/acme/demo/pulls/3 -Body \'{"state":"closed"}\'',
      false,
    ],
    // Joined and long field flags are read too.
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=open --field=base=main', false],
    [
      'gh api -X PATCH repos/acme/demo/pulls/3 -f state=open --raw-field=base=main',
      false,
    ],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -f state=open -fbase=main', false],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -F state=open -Fbase=main', false],
    ['gh api -X PATCH repos/acme/demo/pulls/3 --field=state=closed', false],
    ['gh api -X PATCH repos/acme/demo/pulls/3 -fstate=closed', false],
    // A JSON key with an escape can't be read, so it is a write.
    [
      'curl -X PATCH https://api.github.com/repos/acme/demo/pulls/3 -d \'{"state":"closed","ba\\u0073e":"main"}\'',
      false,
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
      false,
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
      'curl -X POST https://ghe.example.com/api/graphql -d \'{"query":"mutation{createPullRequest(input:{}){id}}"}\'',
      true,
    ],
    [
      'curl --request PATCH https://ghe.example.com/api/v3/repos/acme/demo/pulls/4 --data-raw "{}"',
      false,
    ],
    [
      'curl -H "Authorization: x" --json @pr.json https://api.github.com/repos/acme/demo/pulls',
      true,
    ],
    ['curl https://api.github.com/repos/acme/demo/pulls/4/comments -d "{}"', false],
    [
      'curl -X POST https://api.github.com/graphql -d \'{"query":"mutation{createPullRequest(input:{}){id}}"}\'',
      true,
    ],
    ['wget --post-data "{}" https://api.github.com/repos/acme/demo/pulls', true],
    ['http POST https://api.github.com/repos/acme/demo/pulls title=x', true],
    [
      `http --raw '{"title":"new"}' PATCH https://api.github.com/repos/acme/demo/pulls/3`,
      false,
    ],
    [`http --raw='{"title":"new"}' https://api.github.com/repos/acme/demo/pulls`, true],
    ['http https://api.github.com/repos/acme/demo/pulls @pr.json', true],
    [
      'https -A bearer -a TOKEN PATCH https://api.github.com/repos/acme/demo/pulls/3 title=new',
      false,
    ],
    [
      'xh --auth-type bearer --auth TOKEN PATCH https://api.github.com/repos/acme/demo/pulls/3 title=new',
      false,
    ],
    [
      'xhs --timeout 30 PATCH https://api.github.com/repos/acme/demo/pulls/3 title=new',
      false,
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
      expect(writesPr('gh setbody 5 b.md')).toBe(false);
      expect(writesPr('gh prc --help')).toBe(false);
      expect(writesPr('gh ship --dry-run')).toBe(true);
      expect(writesPr('gh ship --help')).toBe(true);
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
      'Tracetoon handles PR creation on this machine: it writes the description',
    );
    expect(reason).toContain('then creates the PR');
    expect(reason).toContain(
      'use the tracetoon skill and publish with tracetoon publish',
    );
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
    mkdirSync(join(h, '.factory'), { recursive: true });
    mkdirSync(join(h, '.copilot'), { recursive: true });
    mkdirSync(join(h, '.cursor'), { recursive: true });
    mkdirSync(join(h, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(h, '.config', 'kilo'), { recursive: true });
    mkdirSync(join(h, '.kiro'), { recursive: true });
    mkdirSync(join(h, '.cline'), { recursive: true });
    mkdirSync(join(h, '.junie'), { recursive: true });
    mkdirSync(gooseDataDir({}, h), { recursive: true });
    mkdirSync(join(h, '.qwen'), { recursive: true });
    mkdirSync(join(h, '.config', 'crush'), { recursive: true });
    mkdirSync(join(h, '.config', 'amp'), { recursive: true });
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
    expect(first.map((c) => c.result)).toEqual([
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
      'installed',
    ]);
    expect(first[1]!.note).toContain('/hooks');
    expect(installHooks('/opt/tracetoon/bin', targets).map((c) => c.result)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);

    const settings = JSON.parse(
      readFileSync(join(h, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop[0]).toEqual(existingClaude.hooks.Stop[0]);
    expect(settings.hooks.Stop).toEqual(existingClaude.hooks.Stop);
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
    // Factory's hooks.json is the bare event map, with the shell tool named Execute.
    const droid = JSON.parse(readFileSync(join(h, '.factory', 'hooks.json'), 'utf8'));
    expect(droid.hooks).toBeUndefined();
    expect(droid.PreToolUse[0]).toMatchObject({
      matcher: 'Execute',
      hooks: [{ command: '/opt/tracetoon/bin hook pre-pr --agent factory' }],
    });
    // Copilot gets its own file, with exec + args so no shell parses the path.
    const copilot = JSON.parse(
      readFileSync(join(h, '.copilot', 'hooks', 'tracetoon.json'), 'utf8'),
    );
    // Cursor's hooks.json: entries sit directly under each event, PR route on beforeShellExecution.
    // OpenCode and Kilo get a plugin file that names the command it runs.
    const plugin = readFileSync(
      join(h, '.config', 'kilo', 'plugins', 'tracetoon.js'),
      'utf8',
    );
    expect(plugin).toContain('hook pre-pr --agent kilo');
    expect(plugin).toContain("'tool.execute.before'");
    const cursor = JSON.parse(readFileSync(join(h, '.cursor', 'hooks.json'), 'utf8'));
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.beforeShellExecution[0].command).toContain(
      'hook pre-pr --agent cursor',
    );
    // Cline gets one script per event; the PreToolUse one routes PRs.
    expect(readFileSync(join(h, '.cline', 'hooks', 'PreToolUse.mjs'), 'utf8')).toContain(
      'hook pre-pr --agent cline',
    );
    expect(readFileSync(join(h, '.cline', 'hooks', 'TaskStart.mjs'), 'utf8')).toContain(
      '"--event","SessionStart"',
    );
    // On Windows the Cline VS Code extension reads PowerShell hooks from Documents.
    const extensionHook = join(h, 'Documents', 'Cline', 'Hooks', 'PreToolUse.ps1');
    if (process.platform === 'win32')
      expect(readFileSync(extensionHook, 'utf8')).toContain('cancel = $true');
    else expect(existsSync(extensionHook)).toBe(false);
    // Junie's config.json takes Claude-style groups; its shell tool is Bash or powershell.
    const junie = JSON.parse(readFileSync(join(h, '.junie', 'config.json'), 'utf8'));
    expect(junie.hooks.PreToolUse[0]).toMatchObject({
      matcher: 'Bash|powershell',
      hooks: [{ command: '/opt/tracetoon/bin hook pre-pr --agent junie' }],
    });
    // Goose gets a plugin folder of its own: a manifest and Claude-style hooks.
    const goose = JSON.parse(
      readFileSync(
        join(h, '.agents', 'plugins', 'tracetoon', 'hooks', 'hooks.json'),
        'utf8',
      ),
    );
    expect(goose.hooks.PreToolUse[0]).toMatchObject({
      matcher: '^shell$',
      hooks: [{ command: '/opt/tracetoon/bin hook pre-pr --agent goose' }],
    });
    expect(
      JSON.parse(
        readFileSync(join(h, '.agents', 'plugins', 'tracetoon', 'plugin.json'), 'utf8'),
      ).name,
    ).toBe('tracetoon');
    // Qwen Code takes Claude-style groups in settings.json; its shell tool is run_shell_command.
    const qwen = JSON.parse(readFileSync(join(h, '.qwen', 'settings.json'), 'utf8'));
    expect(qwen.hooks.PreToolUse[0]).toMatchObject({
      matcher: 'run_shell_command',
      hooks: [{ command: '/opt/tracetoon/bin hook pre-pr --agent qwen' }],
    });
    // Crush's crush.json takes one flat list of hooks per event.
    const crush = JSON.parse(
      readFileSync(join(h, '.config', 'crush', 'crush.json'), 'utf8'),
    );
    expect(crush.hooks.PreToolUse[0]).toMatchObject({
      name: 'tracetoon-pr',
      matcher: '^bash$',
      command: '/opt/tracetoon/bin hook pre-pr --agent crush',
    });
    expect(crush.hooks.SessionStart[0].matcher).toBeUndefined();
    // Amp gets a plugin that asks Tracetoon about shell commands.
    expect(
      readFileSync(join(h, '.config', 'amp', 'plugins', 'tracetoon.ts'), 'utf8'),
    ).toContain("'reject-and-continue'");
    // Kiro gets its own file in ~/.kiro/hooks, PR route on the shell matcher.
    const kiro = JSON.parse(
      readFileSync(join(h, '.kiro', 'hooks', 'tracetoon.json'), 'utf8'),
    );
    expect(kiro.version).toBe('v1');
    expect(kiro.hooks[0]).toMatchObject({
      trigger: 'PreToolUse',
      matcher: 'shell',
      action: { type: 'command', command: '/opt/tracetoon/bin hook pre-pr --agent kiro' },
    });
    expect(copilot.version).toBe(1);
    expect(copilot.hooks.preToolUse[0]).toMatchObject({
      matcher: 'bash|powershell',
      hooks: [
        {
          exec: '/opt/tracetoon/bin',
          args: ['hook', 'pre-pr', '--agent', 'copilot'],
        },
      ],
    });
    expect(hookStatus(targets).map((s) => s.installed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);

    expect(uninstallHooks(targets).map((c) => c.result)).toEqual([
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
      'removed',
    ]);
    expect(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))).toEqual(
      existingClaude,
    );
    expect(existsSync(join(h, '.codex', 'hooks.json'))).toBe(false); // created by us, now empty
    expect(existsSync(join(h, '.factory', 'hooks.json'))).toBe(false);
    expect(existsSync(join(h, '.copilot', 'hooks', 'tracetoon.json'))).toBe(false);
    expect(existsSync(join(h, '.cursor', 'hooks.json'))).toBe(false);
    expect(existsSync(join(h, '.kiro', 'hooks', 'tracetoon.json'))).toBe(false);
    expect(existsSync(join(h, '.junie', 'config.json'))).toBe(false);
    expect(existsSync(join(h, '.agents', 'plugins', 'tracetoon', 'plugin.json'))).toBe(
      false,
    );
    for (const name of ['PreToolUse.mjs', 'PostToolUse.mjs', 'TaskStart.mjs'])
      expect(existsSync(join(h, '.cline', 'hooks', name))).toBe(false);
    expect(existsSync(join(h, 'Documents', 'Cline', 'Hooks', 'PreToolUse.ps1'))).toBe(
      false,
    );
    expect(existsSync(join(h, '.config', 'opencode', 'plugins', 'tracetoon.js'))).toBe(
      false,
    );
    expect(
      JSON.parse(readFileSync(join(h, '.gemini', 'config', 'hooks.json'), 'utf8')),
    ).toEqual({ 'showtail-cli': { enabled: true } });
  });

  test('upgrades remove only Tracetoon Stop hooks and preserve other settings', () => {
    // Plugin files (OpenCode, Kilo) are Tracetoon's own and hold no JSON settings;
    // Kiro's file is new, so no release ever wrote a Stop hook there.
    const targets = hookTargets(home(), {}).filter(
      (t) =>
        !t.file.endsWith('.js') &&
        !t.file.endsWith('.mjs') &&
        t.agent !== 'kiro' &&
        t.agent !== 'goose' &&
        t.agent !== 'crush' &&
        !t.file.endsWith('.ts'),
    );
    const other = { hooks: [{ type: 'command', command: 'other-tool stop' }] };
    for (const target of targets) {
      const old = {
        hooks: [
          {
            type: 'command',
            command: `tracetoon hook lifecycle --agent ${target.agent} --event Stop`,
          },
        ],
      };
      if (target.agent !== 'antigravity')
        old.hooks.unshift({ type: 'command', command: 'other-tool mixed-stop' });
      mkdirSync(join(target.file, '..'), { recursive: true });
      writeFileSync(
        target.file,
        JSON.stringify(
          target.agent === 'antigravity'
            ? {
                other: {
                  enabled: true,
                  Stop: [{ type: 'command', command: 'other-tool stop' }],
                },
                tracetoon: { enabled: true, Stop: old.hooks },
              }
            : { model: 'chosen-model', hooks: { Stop: [other, old] } },
        ),
      );
    }
    expect(
      installHooks('/opt/tracetoon/bin', targets).every((r) => r.result === 'installed'),
    ).toBe(true);
    expect(hookStatus(targets).every((r) => !r.completionInstalled && r.installed)).toBe(
      true,
    );
    for (const target of targets) {
      const data = JSON.parse(readFileSync(target.file, 'utf8'));
      if (target.agent === 'antigravity') {
        expect(data.tracetoon.Stop).toBeUndefined();
        expect(data.other.Stop).toHaveLength(1);
      } else {
        expect(data.model).toBe('chosen-model');
        expect(data.hooks.Stop).toEqual([
          other,
          { hooks: [{ type: 'command', command: 'other-tool mixed-stop' }] },
        ]);
      }
    }
    expect(
      installHooks('/opt/tracetoon/bin', targets).every((r) => r.result === 'unchanged'),
    ).toBe(true);
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
      'not installed',
      'not installed',
      'not installed',
      'not installed',
      'not installed',
      'not installed',
      'not installed',
      'not installed',
      'not installed',
      'not installed',
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
  test('Kiro, which ignores JSON answers, is blocked by exit status 2 with the reason on stderr', () => {
    const command = process.env.TRACETOON_TEST_BINARY
      ? [process.env.TRACETOON_TEST_BINARY]
      : [process.execPath, CLI];
    const run = (shell: string) =>
      spawnSync(command[0]!, [...command.slice(1), 'hook', 'pre-pr', '--agent', 'kiro'], {
        input: JSON.stringify({
          session_id: 'sess_1',
          hook_event_name: 'PreToolUse',
          cwd: tempDir(),
          tool_name: 'execute_pwsh',
          tool_input: { command: shell },
        }),
        encoding: 'utf8',
        env: env(),
      });
    const denied = run('gh pr create --fill');
    expect(denied.status).toBe(2);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('Tracetoon handles PR creation');
    const allowed = run('git status');
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toBe('');
  });

  test('the CLI reads stdin and answers like an agent hook', () => {
    const command = process.env.TRACETOON_TEST_BINARY
      ? [process.env.TRACETOON_TEST_BINARY]
      : [process.execPath, CLI];
    const run = (payload: unknown, extra: Record<string, string> = {}) =>
      spawnSync(
        command[0]!,
        [...command.slice(1), 'hook', 'pre-pr', '--agent', 'claude'],
        {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          env: env(extra),
        },
      );
    const denied = run(claude('gh pr create --fill'));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const allowed = run(claude('git status'));
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');
    const aliases = tempDir('tracetoon-aliases-');
    writeFileSync(
      join(aliases, 'config.yml'),
      "aliases:\n  prc: pr create --fill\n  ship: '!gh pr create --fill && gh pr view --web'\n",
    );
    for (const [shell, creates] of [
      ['gh pr create --help', false],
      ['gh pr create -h', false],
      ['gh pr edit 3 --body revised', false],
      ['gh prc --dry-run', false],
      ['gh ship --dry-run', true],
      ['gh ship --help', true],
    ] as const) {
      const result = run(claude(shell), { GH_CONFIG_DIR: aliases });
      expect(result.status).toBe(0);
      if (creates)
        expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe(
          'deny',
        );
      else expect(result.stdout).toBe('');
    }
    for (const agent of ['claude', 'codex', 'antigravity']) {
      for (const event of ['SessionStart', 'Stop']) {
        const result = spawnSync(
          command[0]!,
          [...command.slice(1), 'hook', 'lifecycle', '--agent', agent, '--event', event],
          {
            input: JSON.stringify({ cwd: tempDir(), session_id: 'passive-hook' }),
            encoding: 'utf8',
            env: env(),
            windowsHide: true,
          },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
      }
    }
    const garbage = spawnSync(
      command[0]!,
      [...command.slice(1), 'hook', 'pre-pr', '--agent', 'claude'],
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

    // Trust every Tracetoon handler the way Codex's /hooks records it.
    const codexFile = join(h, '.codex', 'hooks.json');
    const codexData = JSON.parse(readFileSync(codexFile, 'utf8'));
    const trustAll = (hash?: (current: string) => string, extra = '') => {
      let toml = '';
      for (const [event, groups] of Object.entries<any[]>(codexData.hooks))
        groups.forEach((group, g) =>
          group.hooks.forEach((handler: any, i: number) => {
            const current = codexHookHash(event, group.matcher, handler)!;
            const label = event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
            toml += `[hooks.state.'${codexFile}:${label}:${g}:${i}']\ntrusted_hash = "${hash ? hash(current) : current}"\n${extra}\n`;
          }),
        );
      writeFileSync(join(h, '.codex', 'config.toml'), toml);
    };
    trustAll();
    expect(hookStatus(targets)[1]!.problem).toBeUndefined();
    // A record from before an update no longer matches: Codex skips the hook as modified.
    trustAll(() => 'sha256:x');
    expect(hookStatus(targets)[1]!.problem).toContain('trust the Tracetoon hook again');
    trustAll(undefined, 'enabled = false');
    expect(hookStatus(targets)[1]!.problem).toContain('turn the Tracetoon hook back on');
    trustAll();
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

describe('hooks that fire together', () => {
  test('Cursor and the Claude Code hook it imports start one task, not two', async () => {
    const repo = makeRepo();
    repo.commit('a.txt', 'a\n', 'change');
    const command = process.env.TRACETOON_TEST_BINARY
      ? [process.env.TRACETOON_TEST_BINARY]
      : [process.execPath, CLI];
    // The payload Cursor sends to both its own hook and the imported Claude Code one.
    const payload = JSON.stringify({
      conversation_id: 'c-par',
      session_id: 'c-par',
      hook_event_name: 'preToolUse',
      cursor_version: '2026.11.11',
      tool_name: 'Shell',
      tool_input: { command: 'gh pr create --fill', cwd: '' },
      cwd: '',
      workspace_roots: [repo.root],
    });
    const input = join(tempDir(), 'payload.json');
    writeFileSync(input, payload);
    const spawn = (agent: string) => {
      const p = Bun.spawn(
        [...command, 'hook', 'lifecycle', '--agent', agent, '--event', 'PreToolUse'],
        { stdin: Bun.file(input), stdout: 'pipe', env: env(), cwd: tempDir() },
      );
      return new Response(p.stdout).text();
    };
    const answers = await Promise.all([spawn('cursor'), spawn('claude')]);
    const runs = readdirSync(join(repo.root, '.git', 'tracetoon', 'runs')).filter((r) =>
      existsSync(join(repo.root, '.git', 'tracetoon', 'runs', r, 'task.json')),
    );
    expect(runs).toHaveLength(1);
    for (const answer of answers) expect(answer).toContain(`Task ${runs[0]}`);
  });
});

describe('Cline hook files', () => {
  test("a script of the same name that isn't Tracetoon's is left alone, and uninstall keeps it", () => {
    const h = tempDir('tracetoon-home-');
    mkdirSync(join(h, '.cline', 'hooks'), { recursive: true });
    writeFileSync(join(h, '.cline', 'hooks', 'PostToolUse.mjs'), '// my own hook\n');
    const targets = hookTargets(h, {}).filter((t) => t.agent === 'cline');
    expect(installHooks('/x/tracetoon', targets)[0]).toMatchObject({ result: 'skipped' });
    expect(existsSync(join(h, '.cline', 'hooks', 'PreToolUse.mjs'))).toBe(false);
    expect(uninstallHooks(targets)[0]).toMatchObject({ result: 'unchanged' });
    expect(readFileSync(join(h, '.cline', 'hooks', 'PostToolUse.mjs'), 'utf8')).toBe(
      '// my own hook\n',
    );
  });

  test('a PR command is replaced by an echo of the reason, which every shell runs', () => {
    const answer = JSON.parse(
      decide(
        'cline',
        {
          hookName: 'tool_call',
          taskId: 't',
          sessionContext: { rootSessionId: 's' },
          workspaceRoots: [tempDir()],
          tool_call: {
            name: 'run_commands',
            input: { commands: ['git push', 'gh pr create --fill'] },
          },
        },
        env(), // CI turns Tracetoon off unless the test clears it
      )!,
    );
    expect(answer.errorMessage).toBe(DENY_REASON);
    expect(answer.cancel).toBeUndefined(); // cancel would stop the whole run
    const [echo] = answer.overrideInput.commands;
    expect(echo).toMatch(/^echo 'Blocked by Tracetoon\. [^'‘’‚‛]*'$/);
  });

  test('a PR command in the older payload of the VS Code extension is blocked too', () => {
    // Recorded from the Cline 4.1.26 VS Code extension's PreToolUse.ps1 hook.
    const answer = JSON.parse(
      decide(
        'cline',
        {
          clineVersion: '4.1.26',
          hookName: 'PreToolUse',
          timestamp: '1794646999494',
          taskId: 'conv_1794646985049_9g5nvg7',
          workspaceRoots: [tempDir()],
          preToolUse: {
            toolName: 'run_commands',
            parameters: { commands: 'git status; gh pr create --fill' },
          },
        },
        env(),
      )!,
    );
    expect(answer.errorMessage).toBe(DENY_REASON);
  });

  test('a PR command sent as one string (Cline 4.x) is blocked too', () => {
    const answer = JSON.parse(
      decide(
        'cline',
        {
          hookName: 'tool_call',
          taskId: 't',
          sessionContext: { rootSessionId: 's' },
          workspaceRoots: [tempDir()],
          tool_call: {
            name: 'run_commands',
            input: { commands: 'git push; gh pr create --fill' },
          },
        },
        env(),
      )!,
    );
    expect(answer.errorMessage).toBe(DENY_REASON);
  });
});
