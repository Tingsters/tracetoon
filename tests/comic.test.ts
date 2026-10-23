import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addAgents, defaultBible } from '../src/comic/bible.ts';
import { composePage, wrap } from '../src/comic/compose.ts';
import { svgToPng } from '../src/comic/raster.ts';
import { checkScript, transcript } from '../src/comic/script.ts';
import { panelSvg } from '../src/comic/svgArt.ts';
import type { ComicScript, SeriesBible } from '../src/comic/types.ts';
import { decodeMeta, encodeMeta, type PrMeta } from '../src/github/body.ts';
import { buildStory, type EpisodeRef } from '../src/story/story.ts';
import type { PrTruth } from '../src/git/pr.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(90_000);
// Set TRACETOON_TEST_CLI to run these against the bundled build instead of the source.
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');
const GREET =
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';

function script(bible: SeriesBible): ComicScript {
  const id = (role: string) => bible.cast.find((c) => c.role === role)!.id;
  const agent = id('agent');
  const human = id('human');
  return {
    v: 1,
    title: 'Hello, Greeter',
    synopsis: 'Kit adds a greeting helper and the tests turn green.',
    altText: 'Sam asks for a greeting; Kit writes it; a bug appears; tests pass.',
    panels: [
      {
        beat: 'ki',
        scene: 'Sam asks for a greeting',
        characters: [
          { cast: human, position: 'left' },
          { cast: agent, position: 'right', expression: 'excited' },
        ],
        dialogue: [{ speaker: human, text: 'Can we greet people?' }],
      },
      {
        beat: 'sho',
        scene: 'Kit types quickly',
        characters: [{ cast: agent, position: 'center', expression: 'determined' }],
        dialogue: [{ speaker: 'caption', text: 'One small function later...' }],
      },
      {
        beat: 'ten',
        scene: 'A bug appears',
        camera: 'close',
        characters: [{ cast: id('extra'), position: 'center', expression: 'angry' }],
        dialogue: [{ speaker: 'sfx', kind: 'sfx', text: 'BZZT!' }],
      },
      {
        beat: 'ketsu',
        scene: 'Tests pass',
        characters: [
          { cast: human, position: 'left', expression: 'proud' },
          { cast: agent, position: 'right', expression: 'happy' },
        ],
        dialogue: [{ speaker: agent, text: 'All green!' }],
      },
    ],
  };
}

describe('comic pieces', () => {
  test('default cast per theme gives each agent a character', () => {
    for (const theme of ['pets', 'mecha', 'scifi'] as const) {
      const b = defaultBible('ser_x', theme, ['Claude Code', 'Codex', 'Antigravity']);
      expect(b.cast.filter((c) => c.role === 'agent').map((c) => c.agent)).toEqual([
        'Claude Code',
        'Codex',
        'Antigravity',
      ]);
      expect(new Set(b.cast.map((c) => c.id)).size).toBe(b.cast.length);
    }
    const b = defaultBible('ser_x', 'pets', ['Claude Code']);
    addAgents(b, ['Claude Code', 'Mystery Agent']);
    expect(b.cast.filter((c) => c.role === 'agent')).toHaveLength(2);
  });

  test('script checks catch common mistakes', () => {
    const bible = defaultBible('ser_x', 'pets', ['Claude Code']);
    const good = script(bible);
    expect(checkScript(good, bible)).toEqual([]);
    const bad = structuredClone(good);
    bad.panels[0]!.dialogue[0]!.text =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
    bad.panels[1]!.characters[0]!.cast = 'nobody';
    bad.panels[2]!.beat = 'ki';
    bad.panels[3]!.dialogue[0]!.text = 'see https://x.y';
    const problems = checkScript(bad, bible).map((p) => p.where);
    expect(problems).toEqual(
      [
        'panels[1].characters[0].cast',
        'panels[2].beat',
        'panels[0].dialogue[0].text',
        'panels[3].dialogue[0].text',
      ].sort((a, b) => problems.indexOf(a) - problems.indexOf(b)),
    );
    expect(checkScript({ panels: [] }, bible).length).toBeGreaterThan(0);
    expect(transcript(good, bible)).toContain('**Sam:** Can we greet people?');
  });

  test('balanced wrapping avoids a lonely last word', () => {
    const lines = wrap('1,326 tests green. Ship it!', 330, 30);
    expect(lines.length).toBe(2);
    expect(lines[1]!.split(' ').length).toBeGreaterThan(1);
  });

  test('builds a PNG page with the built-in artist', async () => {
    const bible = defaultBible('ser_x', 'scifi', ['Claude Code']);
    const s = script(bible);
    const images = s.panels.map((p, i) => ({
      mime: 'image/svg+xml' as const,
      data: new TextEncoder().encode(panelSvg(p, bible, i)),
    }));
    const svg = composePage(s, bible, images, { episode: 3 });
    expect(svg).toContain('Ep. 3');
    const png = await svgToPng(svg, 800);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  });
});

describe('story', () => {
  const truth = { head: 'feat-b', base: 'feat-a', pr: undefined } as unknown as PrTruth;
  const ep = (
    n: number,
    episode: number,
    extra: Omit<Partial<EpisodeRef>, 'meta'> & { meta?: Partial<PrMeta> } = {},
  ): EpisodeRef => ({
    number: n,
    title: `PR ${n}`,
    head: `h${n}`,
    base: 'main',
    ...extra,
    meta: {
      v: 1,
      tool: 't',
      sessions: [],
      digest: 'd',
      generatedAt: '',
      series: 'ser_1',
      episode,
      synopsis: `episode ${episode}`,
      ...(extra.meta ?? {}),
    },
  });

  test('numbers episodes and recaps the latest ones', () => {
    const s = buildStory({
      truth,
      series: 'ser_1',
      episodes: [ep(1, 1), ep(2, 2), ep(3, 3), ep(9, 1, { meta: { series: 'other' } })],
      sessionRefs: [],
      linkedPrs: [],
    });
    expect(s.episode).toBe(4);
    expect(s.saga).toBeUndefined();
    expect(s.previously).toEqual(['#2: episode 2', '#3: episode 3']);
  });

  test('detects sagas from stacked branches, shared sessions and links', () => {
    const stacked = buildStory({
      truth,
      series: 'ser_1',
      episodes: [ep(1, 1), ep(2, 2, { head: 'feat-a' })],
      sessionRefs: [],
      linkedPrs: [],
    });
    expect(stacked.saga?.prs.map((p) => p.number)).toEqual([2]);
    // Sharing a session alone doesn't make a saga (one session often makes many PRs).
    const shared = buildStory({
      truth,
      series: 'ser_1',
      episodes: [ep(5, 1, { meta: { sessions: ['h:abc'], saga: 'sg_keep' } })],
      sessionRefs: ['h:abc'],
      linkedPrs: [],
    });
    expect(shared.saga).toBeUndefined();
    // A linked PR that already has a saga id passes it on.
    const continued = buildStory({
      truth,
      series: 'ser_1',
      episodes: [ep(5, 1, { meta: { saga: 'sg_keep' } })],
      sessionRefs: [],
      linkedPrs: [5],
    });
    expect(continued.saga?.id).toBe('sg_keep');
    expect(continued.previously).toEqual(['#5: episode 1']);
    const linked = buildStory({
      truth,
      series: 'ser_1',
      episodes: [ep(8, 1)],
      sessionRefs: [],
      linkedPrs: [8],
    });
    expect(linked.saga?.prs[0]?.number).toBe(8);
  });

  test('metadata with saga fields survives the round trip', () => {
    const meta = {
      v: 1 as const,
      tool: 't',
      sessions: ['h:1'],
      digest: 'd',
      generatedAt: 'g',
      series: 'ser_1',
      episode: 2,
      saga: 'sg_1',
      prev: [1],
      theme: 'pets',
      synopsis: 'a -- b',
    };
    expect(decodeMeta(encodeMeta(meta as never))).toEqual(meta as never);
  });
});

describe('comic end to end', () => {
  let env: NodeJS.ProcessEnv;
  let ghLog: string;
  beforeEach(() => {
    const scratch = tempDir('tracetoon-env-');
    ghLog = join(scratch, 'gh.log');
    env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: tempDir('tracetoon-claude-'),
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(scratch, 'config.json'),
      TRACETOON_GH_SCRIPT: FAKE_GH,
      TRACETOON_REPO_WEB: 'https://github.com/acme/demo',
      FAKE_GH_LOG: ghLog,
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
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
    return { code: r.status, json, stderr: r.stderr };
  };

  function prepared() {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    new ClaudeLog(repo.root)
      .prompt('Add greeting')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .save(env.CLAUDE_CONFIG_DIR!, 's1');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');
    const d = cli(repo.root, 'digest', '--offline');
    expect(d.code).toBe(0);
    const c = cli(repo.root, 'context', '--offline');
    expect(c.code).toBe(0);
    expect(c.json.story.episode).toBe(1);
    const runDir = d.json.runDir as string;
    const bible = JSON.parse(
      readFileSync(join(runDir, 'bible.json'), 'utf8'),
    ) as SeriesBible;
    writeFileSync(join(runDir, 'comic.json'), JSON.stringify(script(bible)));
    writeFileSync(join(runDir, 'body.md'), '## Summary\nAdds a greeting helper.\n');
    writeFileSync(join(runDir, 'title.txt'), 'Add greeting helper\n');
    return { repo, remote, runDir };
  }

  test('makes the comic, puts it on the assets branch, and links it by commit', () => {
    const { repo, remote, runDir } = prepared();
    expect(cli(repo.root, 'comic', 'check').code).toBe(0);
    const art = cli(repo.root, 'comic', 'art');
    expect(art.json.provider).toBe('builtin');
    expect(
      readdirSync(join(runDir, 'art')).filter((f) => f.endsWith('.svg')),
    ).toHaveLength(4);
    const rendered = cli(repo.root, 'comic', 'render');
    expect(rendered.code).toBe(0);
    expect(existsSync(join(runDir, 'out', 'comic.png'))).toBe(true);

    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.comicSha).toMatch(/^[0-9a-f]{64}$/);
    const finalBody = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(finalBody).toContain('{{tracetoon:comic-src}}');
    expect(finalBody).toContain('Comic transcript');
    expect(decodeMeta(finalBody)).toMatchObject({
      episode: 1,
      theme: 'pets',
      synopsis: 'Kit adds a greeting helper and the tests turn green.',
    });
    expect(readFileSync(join(runDir, 'preview.html'), 'utf8')).toContain(
      'src="./out/comic.png"',
    );

    // Swapping the image after approval is refused.
    const png = readFileSync(join(runDir, 'out', 'comic.png'));
    writeFileSync(
      join(runDir, 'out', 'comic.png'),
      Buffer.concat([png, Buffer.from('x')]),
    );
    expect(
      cli(repo.root, 'publish', '--code', r.json.code, '--push').json.error,
    ).toContain('comic image changed');
    writeFileSync(join(runDir, 'out', 'comic.png'), png);

    const ok = cli(repo.root, 'publish', '--code', r.json.code, '--push');
    expect(ok.code).toBe(0);
    expect(ok.json.hosting).toBe('branch');
    const create = readFileSync(ghLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((c) => c.args[1] === 'create');
    const m =
      /https:\/\/github\.com\/acme\/demo\/blob\/([0-9a-f]{40})\/(episodes\/[^?]+comic\.png)\?raw=true/.exec(
        create.body,
      );
    expect(m).not.toBeNull();
    const files = git(remote, ['ls-tree', '-r', '--name-only', m![1]!]).stdout;
    expect(files).toContain(m![2]!);
    expect(files).toMatch(/bible\/ser_[0-9a-f]{8}\/series\.json/);
    expect(git(remote, ['rev-parse', 'refs/heads/tracetoon-assets']).stdout.trim()).toBe(
      m![1]!,
    );
    expect(git(repo.root, ['branch', '--show-current']).stdout.trim()).toBe('feature');
  });

  test('image providers need the user to agree first', () => {
    const { repo, runDir } = prepared();
    const fake = join(runDir, 'fake.png');
    writeFileSync(
      fake,
      readFileSync(
        resolve(
          import.meta.dir,
          '..',
          'plugin',
          'skills',
          'tracetoon',
          'assets',
          'fonts',
          'OFL.txt',
        ),
      ),
    );
    env.GEMINI_API_KEY = 'test-key';
    env.TRACETOON_FAKE_IMAGE = fake;
    const auto = cli(repo.root, 'comic', 'art');
    expect(auto.json.provider).toBe('builtin');
    expect(auto.json.hint).toContain('--consent');
    const refused = cli(repo.root, 'comic', 'art', '--provider', 'gemini', '--force');
    expect(refused.code).toBe(4);
    const ok = cli(
      repo.root,
      'comic',
      'art',
      '--provider',
      'gemini',
      '--consent',
      '--force',
    );
    expect(ok.code).toBe(0);
    expect(ok.json.panels.map((p: any) => p.source)).toEqual([
      'gemini',
      'gemini',
      'gemini',
      'gemini',
    ]);
    expect(JSON.parse(readFileSync(env.TRACETOON_CONFIG!, 'utf8')).imageConsent).toEqual([
      'gemini',
    ]);
    expect(cli(repo.root, 'comic', 'art', '--force').json.provider).toBe('gemini');
  });

  test('exports an Agent Trace record with line ranges', () => {
    const { repo } = prepared();
    const r = cli(repo.root, 'export', '--offline');
    expect(r.code).toBe(0);
    const rec = JSON.parse(readFileSync(r.json.path, 'utf8'));
    expect(rec.version).toBe('0.1.0');
    const file = rec.files.find((f: any) => f.path === 'src/greet.ts');
    expect(file.conversations[0]).toMatchObject({
      contributor: { type: 'ai', tool: 'Claude Code', model_id: 'claude-test-1' },
      ranges: [{ start_line: 1, end_line: 2 }],
    });
  });
});
