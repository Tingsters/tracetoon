/**
 * Onboarding for comics: which image routes can really draw, approving and
 * testing one before a PR depends on it, and the fixes a first-time tester
 * needed (a Codex pointed at a proxy, a key for another service, a sandboxed
 * browser, a PR base that wasn't a branch, a digest older than the branch).
 */
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
import { codexCustomProvider, explainFailure } from '../src/comic/providers.ts';
import { digestStale, prBase } from '../src/commands/publish.ts';
import { loadConfig } from '../src/config.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(60_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const FAKE_CODEX = resolve(import.meta.dir, 'fake-codex.ts');
const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');

let env: NodeJS.ProcessEnv;
beforeEach(() => {
  const scratch = tempDir('tracetoon-images-');
  env = {
    ...process.env,
    TRACETOON_CONFIG: join(scratch, 'config.json'),
    CODEX_HOME: tempDir('tracetoon-codexhome-'),
    TRACETOON_CODEX_BIN: FAKE_CODEX,
    TRACETOON_AGY_BIN: 'none',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    TRACETOON_GH_SCRIPT: FAKE_GH,
  };
});

const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
const route = (json: any, id: string) => json.routes.find((r: any) => r.id === id);

describe('tracetoon images', () => {
  test('a signed-in Codex is ready and recommended first, ahead of a paid API key', () => {
    env.GEMINI_API_KEY = 'test-key';
    const r = cli(tempDir('tracetoon-cwd-'), 'images');
    expect(r.code).toBe(0);
    expect(route(r.json, 'codex')).toMatchObject({
      available: true,
      ready: 'ready',
      approved: false,
    });
    expect(r.json.routes.map((x: any) => x.id)).toEqual([
      'codex',
      'antigravity',
      'openai',
      'gemini',
    ]);
    expect(r.json.next).toMatchObject({ kind: 'approve', route: 'codex' });
    expect(r.json.next.text).toContain('tracetoon images --approve codex --test');
  });

  test("a signed-out Codex, or one routed to a proxy, can't draw and says why", () => {
    env.FAKE_CODEX_LOGIN = 'Not logged in';
    let r = cli(tempDir('tracetoon-cwd-'), 'images');
    expect(route(r.json, 'codex').ready).toBe('not ready');
    expect(route(r.json, 'codex').detail).toContain('codex login');
    expect(r.json.next.kind).toBe('fix');

    delete env.FAKE_CODEX_LOGIN;
    writeFileSync(
      join(env.CODEX_HOME!, 'config.toml'),
      'model = "sol"\nmodel_provider = "homelab-litellm"\n\n[model_providers.homelab-litellm]\nbase_url = "https://proxy.example"\n',
    );
    r = cli(tempDir('tracetoon-cwd-'), 'images');
    expect(route(r.json, 'codex').ready).toBe('not ready');
    expect(route(r.json, 'codex').detail).toContain('homelab-litellm');
    // comic art won't try it either.
    const art = cli(tempDir('tracetoon-cwd-'), 'images', '--approve', 'codex');
    expect(art.code).toBe(1);
    expect(art.json.error).toContain("can't draw");
  });

  test('--test needs consent, then draws a picture and approves the route', () => {
    const cwd = tempDir('tracetoon-cwd-');
    const refused = cli(cwd, 'images', '--test', 'codex');
    expect(refused.code).toBe(4);
    expect(refused.json.error).toContain('no code, no repo content');

    const ok = cli(cwd, 'images', '--test', 'codex', '--consent');
    expect(ok.code).toBe(0);
    expect(ok.json.tested).toMatchObject({ route: 'codex', ok: true });
    expect(existsSync(ok.json.tested.image)).toBe(true);
    expect(JSON.parse(readFileSync(env.TRACETOON_CONFIG!, 'utf8')).imageConsent).toEqual([
      'codex',
    ]);
    expect(ok.json.next.kind).toBe('ready');
  });

  test('--approve then --test reports the real cause when Codex draws nothing', () => {
    env.FAKE_CODEX_MAKE = '0';
    const r = cli(tempDir('tracetoon-cwd-'), 'images', '--approve', 'codex', '--test');
    expect(r.code).toBe(1);
    expect(r.json.tested.ok).toBe(false);
    expect(r.json.tested.error).toContain('no image tool here');
  });

  test('nothing found: how to set one up, keys included', () => {
    env.TRACETOON_CODEX_BIN = 'none';
    const r = cli(tempDir('tracetoon-cwd-'), 'images', '--brief');
    expect(r.json.next.kind).toBe('setup');
    expect(r.json.next.text).toContain('codex login');
    expect(r.json.next.text).toContain(process.platform === 'win32' ? 'setx' : 'export');
  });
});

describe('route checks and messages', () => {
  test("reads Codex's provider from the top level or the selected profile", () => {
    expect(codexCustomProvider('model_provider = "litellm"\n[tui]\n')).toBe('litellm');
    expect(
      codexCustomProvider('profile = "sol"\n[profiles.sol]\nmodel_provider = "proxy"\n'),
    ).toBe('proxy');
    expect(codexCustomProvider('model_provider = "openai"\n')).toBeUndefined();
    expect(codexCustomProvider('[tui]\nmodel_provider = "x"\n')).toBeUndefined();
  });

  test('failures say what went wrong and what to do', () => {
    expect(explainFailure('openai', '401 Unauthorized: invalid_api_key')).toContain(
      'belong to another service',
    );
    expect(explainFailure('gemini', '429 Too Many Requests')).toContain('out of quota');
    expect(explainFailure('codex', 'Codex made 0 image(s) for 1 prompt(s).')).toContain(
      'codex login',
    );
  });

  test("a repo's config can't approve image services for the user", () => {
    const saved = process.env.TRACETOON_CONFIG;
    process.env.TRACETOON_CONFIG = join(tempDir('tracetoon-user-'), 'config.json');
    try {
      const repo = tempDir('tracetoon-repo-');
      mkdirSync(join(repo, '.github'), { recursive: true });
      writeFileSync(
        join(repo, '.github', 'tracetoon.json'),
        JSON.stringify({ imageConsent: ['openai'], hosting: 'attach' }),
      );
      const c = loadConfig(repo);
      expect(c.imageConsent).toEqual([]);
      expect(c.hosting).toBe('attach');
    } finally {
      process.env.TRACETOON_CONFIG = saved;
    }
  });
});

describe('PR base and stale digests', () => {
  test('a commit as the digest base opens the PR against the default branch', () => {
    const repo = makeRepo();
    const first = git(repo.root, ['rev-list', '--max-parents=0', 'HEAD']).stdout.trim();
    expect(prBase(repo.root, first)).toBe('main');
    expect(prBase(repo.root, 'main')).toBe('main');
  });

  test('commits added after the digest are flagged', () => {
    const repo = makeRepo();
    repo.commit('a.txt', 'a\n', 'feat: a');
    const sha = git(repo.root, ['rev-parse', 'HEAD']).stdout.trim();
    const digest = {
      pr: {
        base: 'main',
        head: 'feature',
        mergeBase: 'x',
        usedWorkingTree: false,
        commits: [{ sha: sha.slice(0, 12), subject: 'feat: a', trailers: {} }],
      },
    } as any;
    expect(digestStale(repo.root, digest)).toBeUndefined();
    repo.commit('docs/comic.png', 'png\n', 'docs: add the comic');
    expect(digestStale(repo.root, digest)).toContain(
      '1 commit(s) were added after the digest',
    );
  });
});

describe('doctor', () => {
  test('warns before any work when the gh account cannot push to the repo', () => {
    const repo = makeRepo();
    env.FAKE_GH_PERMISSION = 'READ';
    const r = cli(repo.root, 'doctor');
    expect(r.json.push).toMatchObject({
      repo: 'acme/demo',
      account: 'octo-tester',
      canPush: false,
    });
    expect(r.json.comics.kind).toBe('approve');
    const text = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    }).stdout;
    expect(text).toContain("octo-tester can't push to acme/demo");
    expect(text).toContain('next: Approve');
  });
});
