// Stands in for the GitHub CLI in tests: logs each call and fakes `pr create`.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
const bodyIdx = args.indexOf('--body-file');
const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, 'utf8') : undefined;
if (log) appendFileSync(log, JSON.stringify({ args, body }) + '\n');

if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('https://github.com/acme/demo/pull/7\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') process.exit(1); // no existing PR
if (args[0] === '--version') {
  process.stdout.write('gh version 2.99.0 (fake)\n');
  process.exit(0);
}
process.exit(0);
