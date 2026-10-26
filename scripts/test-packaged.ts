/** The same packaged workflow checks locally and on every CI platform. */
import { runTestFiles } from './test-files.ts';
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
const results = await runTestFiles({
  root,
  files: [...new Set(cases.map((c) => c.file))],
  args: ['-t', contractPattern(cases)],
  reports: mkdtempSync(join(tmpdir(), 'tracetoon-packaged-')),
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
if (results.some((r) => r.code !== 0)) process.exit(1);
try {
  const missing = results.flatMap((r) =>
    missingContracts(
      readFileSync(r.report!, 'utf8'),
      cases.filter((c) => c.file === r.file),
    ),
  );
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
