import { resolve } from 'node:path';
import {
  longestFirst,
  readTestTimes,
  runTestFiles,
  sourceTestFiles,
  TEST_FILE_WORKERS,
  writeTestTimes,
} from './test-files.ts';
const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const results = await runTestFiles({
  root,
  files: longestFirst(root, sourceTestFiles(root), readTestTimes(root)),
  args,
});
// A filtered run (extra bun arguments) does not represent a file's full time.
if (!args.length) writeTestTimes(root, results);
const failed = results.filter((r) => r.code !== 0);
console.log(
  `Source test files: ${results.length - failed.length} passed, ${failed.length} failed (up to ${TEST_FILE_WORKERS} fresh processes).`,
);
process.exitCode = failed.length ? 1 : 0;
