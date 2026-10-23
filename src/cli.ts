#!/usr/bin/env bun
import { Command } from 'commander';
import {
  loadConfig,
  setUserConfig,
  DEFAULTS,
  userConfigPath,
  type Config,
} from './config.ts';
import { doctor } from './commands/doctor.ts';
import { contextCmd, digestCmd, expandCmd, scanCmd } from './commands/digest.ts';
import { emit, UserError } from './commands/output.ts';
import { previewCmd, publishCmd, renderCmd } from './commands/publish.ts';
import { TOOL_VERSION } from './version.ts';

const list = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const cwd = process.cwd();

const program = new Command()
  .name('tracetoon')
  .description(
    'Write PR descriptions from the agent session logs already on your machine.',
  )
  .version(TOOL_VERSION)
  .option('--json', 'print machine-readable JSON');

const g = () => program.opts<{ json?: boolean }>();

program
  .command('doctor')
  .description('check git, gh and which agent logs are on this machine')
  .action(() => doctor(cwd, g()));

program
  .command('scan')
  .description('list agent sessions that match the current branch, with scores')
  .option('--base <ref>', 'base branch (default: the PR base or the repo default)')
  .option('--offline', 'do not ask GitHub for an existing PR')
  .action((o) => scanCmd(cwd, { ...g(), ...o }));

program
  .command('digest')
  .description('start a run: build the redacted trace digest for this branch')
  .option('--base <ref>', 'base branch')
  .option('--include <ids>', 'session refs or ids to include', list)
  .option('--exclude <ids>', 'session refs or ids to leave out', list)
  .option('--budget <tokens>', 'approximate token budget', Number)
  .option('--offline', 'do not ask GitHub for an existing PR')
  .action((o) => digestCmd(cwd, { ...g(), ...o }));

program
  .command('expand <ref>')
  .description('print the untrimmed digest entry for one session')
  .option('--run <id>', 'run id (default: latest)')
  .action((ref, o) => expandCmd(cwd, ref, { ...g(), ...o }));

program
  .command('context')
  .description('read the PR template, AI policy, existing PR and settings into the run')
  .option('--run <id>', 'run id (default: latest)')
  .option('--offline', 'do not ask GitHub for an existing PR')
  .action((o) => contextCmd(cwd, { ...g(), ...o }));

program
  .command('render')
  .description(
    'freeze body.md into the final PR body, scan it, and print an approval code',
  )
  .option('--run <id>', 'run id (default: latest)')
  .option('--allow-findings', 'allow posting even though the leak scan found something')
  .action((o) => {
    renderCmd(cwd, { ...g(), ...o });
  });

program
  .command('preview')
  .description('show the rendered PR')
  .option('--run <id>', 'run id (default: latest)')
  .option('--open', 'open the HTML preview in a browser')
  .action((o) => previewCmd(cwd, { ...g(), ...o }));

program
  .command('publish')
  .description('create or update the PR with exactly what was previewed')
  .option('--run <id>', 'run id (default: latest)')
  .option('--code <code>', 'approval code from render/preview')
  .option('--yolo', 'publish without a code when yolo is enabled and every check passes')
  .option('--push', 'push the branch first if GitHub does not have it')
  .option('--draft', 'open the PR as a draft')
  .option('--ack-policy', 'the user read the repo AI policy and still wants to post')
  .action((o) => publishCmd(cwd, { ...g(), ...o }));

const config = program.command('config').description('show or change settings');
config.command('get [key]').action((key?: keyof Config) => {
  const c = loadConfig();
  emit(g(), key ? { [key]: c[key] } : c, () =>
    key ? String(c[key]) : `${userConfigPath()}\n${JSON.stringify(c, null, 2)}`,
  );
});
config.command('set <key> <value>').action((key: string, value: string) => {
  if (!(key in DEFAULTS))
    throw new UserError(
      `Unknown setting "${key}". Known: ${Object.keys(DEFAULTS).join(', ')}`,
    );
  const c = setUserConfig(key as keyof Config, value);
  emit(g(), c, () => `${key} = ${String(c[key as keyof Config])}`);
});

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const err = e as Error & { exitCode?: number };
  if (g().json) process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
  else process.stderr.write(`tracetoon: ${err.message}\n`);
  process.exit(err instanceof UserError ? err.exitCode : 1);
}
