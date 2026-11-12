import { resolve } from 'node:path';
import { prepareDependencies } from './dependencies.ts';
import {
  longestFirst,
  readTestTimes,
  runTestFiles,
  sourceTestFiles,
  TEST_FILE_WORKERS,
  writeTestTimes,
} from './test-files.ts';
const root = resolve(import.meta.dir, '..');
prepareDependencies();
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
// Exit explicitly after flushing: Bun on Windows can fail to exit on its own.
await new Promise<void>((done) => process.stdout.write('', () => done()));
process.exit(failed.length ? 1 : 0);
