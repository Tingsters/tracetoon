/** Bound concurrency while giving every test file its own OS process. */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { privateRepoPath } from '../src/util/repoFiles.ts';

// Bun 1.3.14's subprocess-heavy suites fail intermittently under concurrent
// macOS load, including with fresh processes. Keep full coverage there serial.
export const TEST_FILE_WORKERS = process.platform === 'darwin' ? 1 : 4;

export function sourceTestFiles(root: string): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || 'Cannot discover source tests');
  const files = [
    ...new Set(
      result.stdout
        .split('\0')
        .filter(
          (file) =>
            /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
            !privateRepoPath(file) &&
            !file.split('/').includes('node_modules'),
        ),
    ),
  ].sort();
  if (!files.length) throw new Error('No source test files found');
  return files;
}

export async function runTestFiles(options: {
  root: string;
  files: string[];
  args?: string[];
  env?: NodeJS.ProcessEnv;
  workers?: number;
  reports?: string;
  quiet?: boolean;
}) {
  if (
    !options.files.length ||
    !Number.isInteger(options.workers ?? TEST_FILE_WORKERS) ||
    (options.workers ?? TEST_FILE_WORKERS) < 1
  )
    throw new Error('Test execution requires files and a positive worker count');
  let next = 0;
  const results: Array<{ file: string; code: number; report?: string }> = [];
  const worker = async () => {
    while (next < options.files.length) {
      const index = next++;
      const file = options.files[index]!;
      const report = options.reports ? join(options.reports, `${index}.xml`) : undefined;
      const result = await new Promise<{ file: string; code: number; report?: string }>(
        (resolve) => {
          const child = spawn(
            process.execPath,
            [
              'test',
              file,
              ...(options.args ?? []),
              ...(report ? ['--reporter=junit', '--reporter-outfile', report] : []),
            ],
            {
              cwd: options.root,
              env: options.env ?? process.env,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let stdout = '',
            stderr = '';
          child.stdout!.on('data', (chunk) => {
            stdout += String(chunk);
          });
          child.stderr!.on('data', (chunk) => {
            stderr += String(chunk);
          });
          child.once('error', (error) => {
            stderr += error.message;
          });
          child.once('close', (code) => {
            if (!options.quiet) {
              process.stdout.write(stdout);
              process.stderr.write(stderr);
            }
            resolve({ file, code: code ?? 1, report });
          });
        },
      );
      results[index] = result;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.workers ?? TEST_FILE_WORKERS, options.files.length) },
      worker,
    ),
  );
  return results;
}
