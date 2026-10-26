import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTestFiles, sourceTestFiles } from '../scripts/test-files.ts';
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
