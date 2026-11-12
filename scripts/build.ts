import { spawnSync } from 'node:child_process';
import { buildManifest, recordOutput } from './build-info.ts';
const manifest = buildManifest();
const args = process.argv.slice(2);
let target = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--outfile') {
    i++;
    continue;
  }
  if (arg === '--target') {
    target = args[++i]!.replace(/^bun-/, '');
    continue;
  }
  if (arg.startsWith('--target=')) {
    target = arg.slice('--target='.length).replace(/^bun-/, '');
    continue;
  }
  throw new Error(
    `Unrecorded compiler option ${arg}; add it to build.config.json before changing the recipe.`,
  );
}
if (!manifest.recipe.native.targets.includes(target))
  throw new Error('Native target is not declared in build.config.json.');
const output = args.includes('--outfile')
  ? []
  : ['--outfile', `dist/tracetoon${target.startsWith('windows-') ? '.exe' : ''}`];
const result = spawnSync(
  process.execPath,
  [
    'build',
    '--compile',
    ...(manifest.recipe.native.minify ? ['--minify'] : []),
    // The build identity is compiled in; src/version.ts falls back to `source` without it.
    '--define',
    `${manifest.recipe.identity}=${JSON.stringify(manifest)}`,
    './src/cli.ts',
    ...output,
    ...args,
  ],
  { stdio: 'inherit', windowsHide: true },
);
if (result.status === 0) {
  const at = args.indexOf('--outfile');
  recordOutput(at < 0 ? output[1]! : args[at + 1]!, target, manifest.buildId);
}
process.exit(result.status ?? 1);
