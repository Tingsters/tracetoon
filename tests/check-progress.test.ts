import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beginTask } from '../src/workflow/state.ts';
import { executeCheckLive, receipts } from '../src/workflow/checks.ts';
import { makeRepo, tempDir } from './helpers.ts';

test('CLI streams check progress while the receipt and lock still indicate running', async () => {
  const repo = makeRepo(),
    { run } = beginTask(repo.root);
  const release = join(tempDir(), 'release');
  const cli = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
  const command = `console.log('CHECK_PROGRESS_VISIBLE'); const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('1 pass');}},20);`;
  const proc = Bun.spawn(
    [
      ...(process.env.TRACETOON_TEST_BINARY
        ? [process.env.TRACETOON_TEST_BINARY]
        : [process.execPath, cli]),
      '--json',
      'check',
      '--run',
      run.id,
      '--name',
      'progress',
      '--',
      process.execPath,
      '-e',
      command,
    ],
    {
      cwd: repo.root,
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const visible = Promise.withResolvers<void>();
  let stderr = '';
  const reading = (async () => {
    for await (const bytes of proc.stderr) {
      stderr += new TextDecoder().decode(bytes);
      if (stderr.includes('CHECK_PROGRESS_VISIBLE')) visible.resolve();
    }
  })();
  const stdout = new Response(proc.stdout).text();
  const timer = setTimeout(
    () => visible.reject(new Error('No progress before the check finished.')),
    15000,
  );
  try {
    await visible.promise;
    expect(proc.exitCode).toBeNull();
    expect(receipts(run)[0]?.outcome).toBe('running');
    expect(existsSync(join(run.dir, 'checks.lock'))).toBe(true);
    writeFileSync(release, 'finish');
    expect(await proc.exited).toBe(0);
    await reading;
    expect(JSON.parse(await stdout)).toMatchObject({
      outcome: 'passed',
      summary: ['1 pass'],
    });
    expect(stderr).toContain('1 pass');
    expect(existsSync(join(run.dir, 'checks.lock'))).toBe(false);
    const saved = JSON.parse(readFileSync(join(run.dir, 'checks.json'), 'utf8'))[0];
    expect(saved).not.toHaveProperty('stdout');
    expect(saved).not.toHaveProperty('stderr');
  } finally {
    clearTimeout(timer);
    writeFileSync(release, 'finish');
    if (proc.exitCode === null) proc.kill();
  }
}, 25000);

test('live checks preserve failure exits and reuse only a completed matching pass', async () => {
  const repo = makeRepo(),
    { run } = beginTask(repo.root);
  const failed = await executeCheckLive(repo.root, run, {
    name: 'failure',
    command: [process.execPath, '-e', 'console.error("1 fail");process.exit(7)'],
  });
  expect(failed).toMatchObject({ outcome: 'failed', exitCode: 7, summary: ['1 fail'] });
  const options = {
    name: 'pass',
    command: [process.execPath, '-e', 'console.log("1 pass")'],
  };
  expect((await executeCheckLive(repo.root, run, options)).outcome).toBe('passed');
  expect((await executeCheckLive(repo.root, run, options)).reused).toBe(true);
  const missing = await executeCheckLive(repo.root, run, {
    name: 'missing',
    command: ['missing-tracetoon-validation-command'],
  });
  expect(missing.outcome).toBe('failed');
  expect(missing.reason).toBeTruthy();
  expect(existsSync(join(run.dir, 'checks.lock'))).toBe(false);
}, 25000);
