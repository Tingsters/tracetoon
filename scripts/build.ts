import { spawnSync } from 'node:child_process';
import { buildManifest } from './build-info.ts';
buildManifest();
const args = process.argv.slice(2);
const output = args.includes('--outfile')
  ? []
  : ['--outfile', `dist/tracetoon${process.platform === 'win32' ? '.exe' : ''}`];
const result = spawnSync(
  process.execPath,
  ['build', '--compile', '--minify', './src/cli.ts', ...output, ...args],
  { stdio: 'inherit', windowsHide: true },
);
process.exit(result.status ?? 1);
