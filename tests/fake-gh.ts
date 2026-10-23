// Stands in for the GitHub CLI in tests: logs each call and fakes the few
// commands Tracetoon uses.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
const bodyIdx = args.indexOf('--body-file');
const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, 'utf8') : undefined;
if (log) appendFileSync(log, JSON.stringify({ args, body }) + '\n');

const [a, b] = args;
if (a === 'pr' && b === 'create') {
  process.stdout.write('https://github.com/acme/demo/pull/7\n');
  process.exit(0);
}
if (a === 'pr' && b === 'view') process.exit(1); // no existing PR
if (a === 'pr' && b === 'list') {
  process.stdout.write(process.env.FAKE_GH_PRS ?? '[]');
  process.exit(0);
}
if (a === 'repo' && b === 'view') {
  process.stdout.write(`${process.env.FAKE_GH_VISIBILITY ?? 'PUBLIC'}\n`);
  process.exit(0);
}
if (a === '--version') {
  process.stdout.write(`gh version ${process.env.FAKE_GH_VERSION ?? '2.99.0'} (fake)\n`);
  process.exit(0);
}
process.exit(0);
