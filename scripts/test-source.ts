import { resolve } from 'node:path';
import { runTestFiles, sourceTestFiles, TEST_FILE_WORKERS } from './test-files.ts';
const root = resolve(import.meta.dir, '..');
const results = await runTestFiles({
  root,
  files: sourceTestFiles(root),
  args: process.argv.slice(2),
});
const failed = results.filter((r) => r.code !== 0);
console.log(
  `Source test files: ${results.length - failed.length} passed, ${failed.length} failed (up to ${TEST_FILE_WORKERS} fresh processes).`,
);
process.exitCode = failed.length ? 1 : 0;
