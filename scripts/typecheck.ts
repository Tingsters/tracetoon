import { spawnSync } from 'node:child_process';
import { prepareDependencies } from './dependencies.ts';
prepareDependencies();
process.exitCode =
  spawnSync(process.execPath, ['x', 'tsc', '--noEmit'], {
    stdio: 'inherit',
    windowsHide: true,
  }).status ?? 1;
