/** The same packaged workflow checks locally and on every CI platform. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLE_CONTRACTS,
  PUBLICATION_CONTRACT,
  contractPattern,
  missingContracts,
} from './packaged-contracts.ts';

const compiled = process.argv.includes('--compiled');
const root = resolve(import.meta.dir, '..');
const cases = compiled ? [PUBLICATION_CONTRACT] : BUNDLE_CONTRACTS;
const report = join(mkdtempSync(join(tmpdir(), 'tracetoon-packaged-')), 'junit.xml');
const result = spawnSync(
  process.execPath,
  [
    'test',
    '--parallel=4',
    ...new Set(cases.map((c) => c.file)),
    '-t',
    contractPattern(cases),
    '--reporter=junit',
    '--reporter-outfile',
    report,
  ],
  {
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
            TRACETOON_TEST_CLI: resolve(
              root,
              'plugin/skills/tracetoon/dist/tracetoon.mjs',
            ),
          }),
    },
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
try {
  const missing = missingContracts(readFileSync(report, 'utf8'), cases);
  if (missing.length) {
    console.error(`Packaged contract coverage missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(
    `Verified ${cases.length} packaged contract(s) against ${compiled ? 'the native executable' : 'the shipped bundle'}.`,
  );
} catch (e) {
  console.error(`Packaged results could not be verified: ${(e as Error).message}`);
  process.exit(1);
}
