import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from './helpers.ts';

setDefaultTimeout(90_000);
const source = resolve(import.meta.dir, '../plugin/skills/tracetoon');
const win = process.platform === 'win32';
let skill: string;
let oldRuntime: string;
beforeAll(() => {
  skill = join(tempDir('tracetoon-launcher-'), 'skill');
  mkdirSync(join(skill, 'bin'), { recursive: true });
  mkdirSync(join(skill, 'dist'));
  for (const name of [
    'build.json',
    'VERSION',
    'bin/tracetoon',
    'bin/tracetoon.ps1',
    'bin/tracetoon.cmd',
    'dist/tracetoon.mjs',
  ])
    copyFileSync(join(source, name), join(skill, name));
  chmodSync(join(skill, 'bin/tracetoon'), 0o755);
  const stub = join(dirnameForStub(skill), 'old-runtime.ts');
  writeFileSync(
    stub,
    'console.log(JSON.stringify({buildId:"wrong-build",version:"1.0.0-rc.1"}));\n',
  );
  const os = win ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  oldRuntime = join(skill, 'bin', `tracetoon-${os}-${process.arch}${win ? '.exe' : ''}`);
  const compiled = spawnSync(
    process.execPath,
    ['build', '--compile', stub, '--outfile', oldRuntime],
    { encoding: 'utf8', windowsHide: true },
  );
  if (compiled.status !== 0) throw new Error(compiled.stderr);
});
function dirnameForStub(path: string) {
  return resolve(path, '..');
}
function launch(extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    win ? 'powershell.exe' : 'sh',
    win
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(skill, 'bin/tracetoon.ps1'),
          'build-info',
          '--json',
        ]
      : [join(skill, 'bin/tracetoon'), 'build-info', '--json'],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        TRACETOON_ASSETS: '',
        TRACETOON_BIN: '',
        TRACETOON_ALLOW_DOWNLOAD: '0',
        ...extra,
      },
    },
  );
}
describe('packaged runtime selection', () => {
  test('skips an executable from another build and runs the matching shipped bundle', () => {
    const result = launch();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const expected = JSON.parse(readFileSync(join(skill, 'build.json'), 'utf8'));
    expect(JSON.parse(result.stdout).buildId).toBe(expected.buildId);
  });
  test('an explicit incompatible runtime produces an actionable failure', () => {
    const result = launch({ TRACETOON_BIN: oldRuntime });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('does not match');
  });
});
