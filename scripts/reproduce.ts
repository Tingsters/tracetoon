/** Compare outputs from two private source/dependency snapshots, without editing the working tree. */
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dir, '..'),
  work = join(root, 'node_modules', '.cache', 'build-reproduction', randomUUID());
mkdirSync(work, { recursive: true });
const sha = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const inputs = [
  'src',
  'scripts',
  'plugin',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'build-dependencies.json',
  'build.config.json',
  'install.sh',
  'install.ps1',
];
const results = [];
for (const name of ['first', 'different-parent/second']) {
  const target = join(work, name);
  mkdirSync(target, { recursive: true });
  for (const input of inputs)
    cpSync(join(root, input), join(target, input), { recursive: true });
  symlinkSync(
    join(root, 'node_modules'),
    join(target, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const commands = [
    ['scripts/dependencies.ts', '--source', join(root, '.tracetoon-deps', 'Showtail')],
    ['scripts/bundle.ts'],
    ['scripts/build.ts'],
  ];
  for (const args of commands) {
    const run = spawnSync(process.execPath, args, {
      cwd: target,
      env: { ...process.env },
      encoding: 'utf8',
      windowsHide: true,
    });
    if (run.status !== 0)
      throw new Error(`Isolated build failed: ${run.stderr || run.stdout}`);
  }
  results.push({
    root: target,
    manifest: JSON.parse(
      readFileSync(join(target, 'plugin/skills/tracetoon/build.json'), 'utf8'),
    ),
    bundle: sha(join(target, 'plugin/skills/tracetoon/dist/tracetoon.mjs')),
    native: sha(
      join(target, `dist/tracetoon${process.platform === 'win32' ? '.exe' : ''}`),
    ),
  });
}
const passed =
  results[0]!.manifest.buildId === results[1]!.manifest.buildId &&
  results[0]!.bundle === results[1]!.bundle &&
  results[0]!.native === results[1]!.native;
const report = { schema: 'tracetoon.build-reproduction/v1', passed, results };
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      passed,
      report: join(work, 'report.json'),
      outputs: results.map((r) => ({
        buildId: r.manifest.buildId,
        bundle: r.bundle,
        native: r.native,
      })),
    },
    null,
    2,
  ),
);
process.exitCode = passed ? 0 : 1;
