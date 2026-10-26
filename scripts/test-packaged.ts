/** The same packaged workflow checks locally and on every CI platform. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const compiled = process.argv.includes('--compiled');
const root = resolve(import.meta.dir, '..');
const suites = compiled
  ? ['tests/workflow.test.ts', '-t', 'author review to publication rehearsal']
  : [
      'tests/flow.test.ts',
      'tests/comic.test.ts',
      'tests/contribution.test.ts',
      'tests/review.test.ts',
      'tests/composition.test.ts',
      'tests/workflow.test.ts',
      'tests/runtime.test.ts',
      'tests/hook.test.ts',
      'tests/doctor.test.ts',
    ];
const result = spawnSync(process.execPath, ['test', ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    ...(compiled
      ? {
          TRACETOON_TEST_BINARY: resolve(
            root,
            `dist/tracetoon${process.platform === 'win32' ? '.exe' : ''}`,
          ),
        }
      : {
          TRACETOON_TEST_CLI: resolve(root, 'plugin/skills/tracetoon/dist/tracetoon.mjs'),
        }),
  },
});
process.exit(result.status ?? 1);
