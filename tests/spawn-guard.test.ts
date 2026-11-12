import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from './helpers.ts';

const GUARD = resolve(import.meta.dir, 'spawn-guard.ts');

function guarded(script: string, timeout = 60_000) {
  const dir = tempDir('tracetoon-guard-');
  const file = join(dir, 'child.ts');
  writeFileSync(file, script);
  const started = Date.now();
  const r = spawnSync(process.execPath, [GUARD, process.execPath, file], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, TRACETOON_EXIT_FILE: join(dir, 'done') },
  });
  return { status: r.status, stdout: r.stdout, error: r.error, ms: Date.now() - started };
}

test('a command that exits by itself keeps its exit code and output', () => {
  expect(guarded("console.log('hello'); process.exit(2);")).toMatchObject({
    status: 2,
    stdout: 'hello\n',
  });
});

test('a command that never exits after recording its code is killed and returns that code', () => {
  const r = guarded(
    "import {writeFileSync} from 'node:fs'; console.log('result'); writeFileSync(process.env.TRACETOON_EXIT_FILE!, '5'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000);",
  );
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(5);
  expect(r.stdout).toBe('result\n');
  expect(r.ms).toBeLessThan(60_000);
});

test('a command that hangs without finishing is not hidden by the guard', () => {
  const r = guarded(
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000);',
    6_000,
  );
  expect(r.error?.message).toContain('ETIMEDOUT');
});
