import { describe, expect, test } from 'bun:test';
import { parseUnifiedDiff } from '../src/git/pr.ts';
import { parseClaudeLines } from '../src/trace/claude.ts';
import type { TraceSession } from '../src/trace/types.ts';
import {
  decodeMeta,
  defuseMentions,
  encodeMeta,
  mergeIntoBody,
  humanPart,
  START,
} from '../src/github/body.ts';
import { makeScrubber } from '../src/digest/sanitize.ts';
import { commandKey, isTestCommand } from '../src/digest/build.ts';
import { mentionsAnyRoot } from '../src/trace/pathMatch.ts';
import { sanitizeHtml } from '../src/preview/html.ts';
import { ClaudeLog } from './helpers.ts';

const emptySession = (): TraceSession => ({
  agent: 'claude-code',
  sessionId: 's',
  source: 'x',
  records: [],
  unknownTypes: {},
  warnings: [],
});

describe('parseUnifiedDiff', () => {
  test('reads added and removed lines per file, including deletions', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old line',
      '+new line',
      '--- not a header, a removed line starting with dashes',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-bye',
      '-bye2',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.addedAt)).toEqual([[1], []]);
    expect(files.map(({ addedAt: _a, ...f }) => f)).toEqual([
      {
        path: 'a.ts',
        added: ['new line'],
        removed: ['old line', '-- not a header, a removed line starting with dashes'],
      },
      { path: 'gone.ts', added: [], removed: ['bye', 'bye2'] },
    ]);
  });
});

describe('Claude adapter', () => {
  test('normalizes prompts, edits, commands, plans and usage', () => {
    const log = new ClaudeLog('/repo')
      .prompt('Add a greeting function')
      .prompt('<command-name>/model</command-name>')
      .prompt('<local-command-stdout>Set model</local-command-stdout>')
      .reply('Sure')
      .write('/repo/src/greet.ts', 'export function greet() {\n  return "hi";\n}\n')
      .edit('/repo/src/greet.ts', '  return "hi";', '  return "hello";')
      .bash('bun test', '1 pass', false)
      .plan('# Plan\nDo it')
      .raw({ type: 'brand-new-type', x: 1 });
    const s = emptySession();
    parseClaudeLines(log.text(), s);
    const kinds = s.records.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'prompt')).toHaveLength(1);
    const edits = s.records.filter((r) => r.kind === 'edit');
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({
      created: true,
      added: ['export function greet() {', '  return "hi";', '}'],
    });
    expect(edits[1]).toMatchObject({
      added: ['  return "hello";'],
      removed: ['  return "hi";'],
    });
    expect(s.records.find((r) => r.kind === 'command')).toMatchObject({
      cmd: 'bun test',
      isError: false,
      output: '1 pass\n',
    });
    expect(s.records.find((r) => r.kind === 'plan')).toMatchObject({ approved: true });
    expect(s.unknownTypes).toEqual({ 'brand-new-type': 1 });
    expect(kinds.filter((k) => k === 'usage').length).toBeGreaterThan(0);
  });

  test('marks subagent prompts as delegated and skips failed edits', () => {
    const log = new ClaudeLog('/repo').prompt('research X');
    const s = emptySession();
    parseClaudeLines(log.text(), s, { subagent: true });
    expect(s.records[0]).toMatchObject({ kind: 'prompt', delegated: true });
  });
});

describe('PR body', () => {
  test('metadata never closes the HTML comment early and round-trips', () => {
    const meta = {
      v: 1 as const,
      tool: 'tracetoon@0.1.0',
      sessions: ['h:1'],
      digest: 'abc',
      generatedAt: '2026-10-23T00:00:00Z',
      synopsis: 'a --> b -- c',
    };
    const enc = encodeMeta(meta);
    expect(enc.slice(4, -3)).not.toContain('--');
    expect(enc.slice(4, -3)).not.toContain('>');
    expect(decodeMeta(`text\n${enc}\n`)).toEqual(meta);
  });

  test('replaces only the managed region and keeps human text', () => {
    const first = mergeIntoBody('Human notes', `${START}\nv1\n<!-- tracetoon:end -->`);
    expect(first).toContain('Human notes');
    const second = mergeIntoBody(first, `${START}\nv2\n<!-- tracetoon:end -->`);
    expect(second).toContain('v2');
    expect(second).not.toContain('v1');
    expect(humanPart(second)).toBe('Human notes');
  });

  test('defuses mentions outside code', () => {
    expect(defuseMentions('thanks @octocat, see `@scope/pkg`')).toBe(
      'thanks @\u200boctocat, see `@scope/pkg`',
    );
  });
});

describe('scrubber', () => {
  test('removes repo roots, home, username, outside paths and secrets', () => {
    const s = makeScrubber(['C:\\Users\\alice\\code\\app'], 'C:\\Users\\alice');
    const out = s.text(
      'edit C:\\Users\\alice\\code\\app\\src\\x.ts and /c/Users/alice/code/app/y.ts; ' +
        'also C:\\Users\\alice\\other\\secret.txt and D:\\work\\z; alice was here; token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(out).toContain('src\\x.ts');
    expect(out).toContain('y.ts');
    expect(out).not.toMatch(/alice/i);
    expect(out).not.toContain('D:\\work');
    expect(out).not.toContain('ghp_');
    expect(s.redactions).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  test('command grouping and test detection', () => {
    expect(commandKey('cd /x/y && bun test --watch')).toBe('bun test');
    expect(commandKey('FOO=1 npm run build')).toBe('npm run');
    expect(isTestCommand('pytest -q')).toBe(true);
    expect(isTestCommand('git status')).toBe(false);
  });

  test('path mentions respect name boundaries and Git Bash spelling', () => {
    expect(mentionsAnyRoot('cd /c/Users/a/app && ls', ['C:\\Users\\a\\app'])).toBe(true);
    expect(mentionsAnyRoot('cd /c/Users/a/app-old', ['C:\\Users\\a\\app'])).toBe(false);
  });

  test('preview HTML keeps GitHub-safe tags and escapes the rest', () => {
    expect(sanitizeHtml('<details open><summary>x</summary>')).toBe(
      '<details open><summary>x</summary>',
    );
    expect(sanitizeHtml('<img src="comic.png" onerror="alert(1)">')).toBe(
      '<img src="comic.png">',
    );
    expect(sanitizeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(sanitizeHtml('<img src="javascript:alert(1)">')).toBe('<img>');
    expect(sanitizeHtml('<img src="data:image/png;base64,aGVsbG8=">')).toBe('<img>');
    expect(sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zy8+">')).toBe('<img>');
  });
});

describe('test detection', () => {
  test('looks at the program, not words in paths', () => {
    expect(isTestCommand('cd app && bun test tests/x.test.ts')).toBe(true);
    expect(isTestCommand('CI=1 npm run test -- --watch=false')).toBe(true);
    expect(isTestCommand('python -m pytest -q')).toBe(true);
    expect(isTestCommand('find tests -name "*.ts"')).toBe(false);
    expect(isTestCommand('grep -rn foo tests/')).toBe(false);
  });
});

describe('commit detection', () => {
  const commit = { sha: '0723dbf0c0ffee11', subject: 'Add fast contact play' };
  const cmd = (c: string, output: string) =>
    ({ kind: 'command', ts: '2026-10-23T21:00:00Z', cmd: c, output }) as const;

  test('a SHA shown by git log is not a commit the session made', async () => {
    const { commitMoments } = await import('../src/correlate/correlate.ts');
    const looked = [
      cmd('git -C ../repo log --oneline -3', '0723dbf Add fast contact play'),
    ];
    expect(commitMoments(looked as never, [commit]).size).toBe(0);
  });

  test('a SHA printed by git commit, even in a chain, is', async () => {
    const { commitMoments } = await import('../src/correlate/correlate.ts');
    const made = [
      cmd('bun test && git commit -qm "x" && git log --oneline -1', '0723dbf x'),
    ];
    expect(commitMoments(made as never, [commit]).size).toBe(1);
  });
});

describe('commands that start by changing directory', () => {
  test('are judged by the directory they move to', async () => {
    const { leadingCd } = await import('../src/trace/pathMatch.ts');
    const { resolve } = await import('node:path');
    const here = resolve('/work/tracetoon');
    expect(leadingCd('cd ../Showtail && bun test', here)).toBe(resolve('/work/Showtail'));
    expect(leadingCd('Set-Location "../x y"; ls', here)).toBe(resolve('/work/x y'));
    expect(leadingCd('bun test', here)).toBeUndefined();
    if (process.platform === 'win32')
      expect(leadingCd('cd /c/Users/me/repo && git status', here)).toBe(
        resolve('C:/Users/me/repo'),
      );
  });
});

describe('image responses', () => {
  test('finds the image in each API shape', async () => {
    const { findImageData } = await import('../src/comic/providers.ts');
    // Gemini Interactions API
    expect(
      findImageData({
        steps: [
          {
            type: 'model_output',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'image', data: 'AAA' },
            ],
          },
        ],
      }),
    ).toBe('AAA');
    // Gemini generateContent
    expect(
      findImageData({
        candidates: [{ content: { parts: [{ inlineData: { data: 'BBB' } }] } }],
      }),
    ).toBe('BBB');
    // OpenAI Images API
    expect(findImageData({ data: [{ b64_json: 'CCC' }] })).toBe('CCC');
    expect(findImageData({ error: 'no' })).toBeUndefined();
  });
});

describe('matching Codex images to prompts', () => {
  const reply = (text: string) => ({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  });
  const made = [
    '/h/g/t/a.png',
    '/h/g/t/b.png',
    '/h/g/t/c.png',
    '/h/g/t/d.png',
    '/h/g/t/e.png',
  ];

  test("trusts Codex's final list over file times when it redrew images", async () => {
    const { pickCodexImages } = await import('../src/comic/providers.ts');
    const events = [
      reply('Working on it.'),
      reply('/h/g/t/c.png\n/h/g/t/a.png\n/h/g/t/e.png'),
    ];
    expect(pickCodexImages(events, made, 3)).toEqual([
      '/h/g/t/c.png',
      '/h/g/t/a.png',
      '/h/g/t/e.png',
    ]);
  });

  test('ignores files outside the session and refuses to guess', async () => {
    const { pickCodexImages } = await import('../src/comic/providers.ts');
    const events = [reply('/etc/secret.png\n/h/g/t/a.png\n/h/g/t/b.png')];
    expect(pickCodexImages(events, made, 3)).toEqual([]);
    expect(pickCodexImages([], made.slice(0, 3), 3)).toEqual(made.slice(0, 3));
  });
});
