import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  longestFirst,
  readTestTimes,
  runTestFiles,
  sourceTestFiles,
  writeTestTimes,
} from '../scripts/test-files.ts';
import { makeRepo, tempDir } from './helpers.ts';

test('each test file gets a new process even when there is only one worker slot', async () => {
  const root = tempDir('tracetoon-test-processes-');
  const changedCwd = tempDir('tracetoon-changed-cwd-');
  writeFileSync(
    join(root, 'a.test.ts'),
    `import {test} from 'bun:test'; test('mutates native process state',()=>{process.env.TRACETOON_POOL_SENTINEL='changed';process.chdir(${JSON.stringify(changedCwd)});});`,
  );
  writeFileSync(
    join(root, 'b.test.ts'),
    `import {test,expect} from 'bun:test'; import {realpathSync} from 'node:fs'; test('starts with independent native state',()=>{expect(process.env.TRACETOON_POOL_SENTINEL).toBeUndefined();expect(realpathSync(process.cwd())).toBe(${JSON.stringify(root)});});`,
  );
  const results = await runTestFiles({
    root,
    files: ['a.test.ts', 'b.test.ts'],
    workers: 1,
    quiet: true,
  });
  expect(results.map((r) => r.code)).toEqual([0, 0]);
});

test('failed test files and empty selections cannot report a passing source run', async () => {
  const root = tempDir('tracetoon-failing-file-');
  writeFileSync(
    join(root, 'failure.test.ts'),
    "import {test,expect} from 'bun:test';test('failure',()=>expect(1).toBe(2));",
  );
  const results = await runTestFiles({ root, files: ['failure.test.ts'], quiet: true });
  expect(results[0]!.code).not.toBe(0);
  await expect(runTestFiles({ root, files: [], quiet: true })).rejects.toThrow(
    'requires files',
  );
});

test('source discovery includes tracked and new tests throughout the repo, excluding private trails', () => {
  const repo = makeRepo();
  repo.commit('src/inside.test.ts', '// tracked fixture\n', 'Add source test');
  writeFileSync(join(repo.root, 'new.spec.ts'), '// new fixture\n');
  mkdirSync(join(repo.root, '.showtail'));
  writeFileSync(join(repo.root, '.showtail/private.test.ts'), '// private fixture\n');
  mkdirSync(join(repo.root, 'node_modules'));
  writeFileSync(
    join(repo.root, 'node_modules/vendor.test.ts'),
    '// dependency fixture\n',
  );
  writeFileSync(join(repo.root, '.gitignore'), 'ignored.test.ts\n');
  writeFileSync(join(repo.root, 'ignored.test.ts'), '// ignored fixture\n');
  expect(sourceTestFiles(repo.root)).toEqual(['new.spec.ts', 'src/inside.test.ts']);
});

test('slowest files start first: measured times, then size for unmeasured files', () => {
  const root = tempDir('tracetoon-longest-first-');
  writeFileSync(join(root, 'a.test.ts'), 'x'.repeat(10));
  writeFileSync(join(root, 'b.test.ts'), 'x'.repeat(5_000));
  writeFileSync(join(root, 'c.test.ts'), 'x'.repeat(10));
  writeFileSync(join(root, 'new.test.ts'), 'x'.repeat(2_000));
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'new.test.ts'];
  // Alphabetical order would start the slowest file (c) last.
  expect(
    longestFirst(root, files, {
      'a.test.ts': 100,
      'b.test.ts': 900,
      'c.test.ts': 90_000,
    }),
  ).toEqual(['c.test.ts', 'new.test.ts', 'b.test.ts', 'a.test.ts']);
  // With no history, size decides and ties keep a stable order.
  expect(longestFirst(root, files, {})).toEqual([
    'b.test.ts',
    'new.test.ts',
    'a.test.ts',
    'c.test.ts',
  ]);
});

test('runs report durations; only passing runs update the timing history', async () => {
  const root = tempDir('tracetoon-test-times-');
  writeFileSync(
    join(root, 'ok.test.ts'),
    "import {test} from 'bun:test';test('ok',()=>{});",
  );
  writeFileSync(
    join(root, 'bad.test.ts'),
    "import {test,expect} from 'bun:test';test('bad',()=>expect(1).toBe(2));",
  );
  expect(readTestTimes(root)).toEqual({});
  writeTestTimes(root, [{ file: 'bad.test.ts', code: 0, ms: 4_000 }]);
  const results = await runTestFiles({
    root,
    files: ['ok.test.ts', 'bad.test.ts'],
    workers: 1,
    quiet: true,
  });
  expect(results.map((r) => [r.file, r.code === 0])).toEqual([
    ['ok.test.ts', true],
    ['bad.test.ts', false],
  ]);
  expect(results.every((r) => Number.isInteger(r.ms) && r.ms > 0)).toBe(true);
  writeTestTimes(root, results);
  const times = readTestTimes(root);
  expect(times['ok.test.ts']).toBe(results[0]!.ms);
  // The failed run keeps the earlier, representative time.
  expect(times['bad.test.ts']).toBe(4_000);
});
