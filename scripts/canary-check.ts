/**
 * Drift canary check: every agent that ran in the toy repository must still be found by its
 * reader, with the file it was asked to create showing up as an edit.
 *
 *   bun scripts/canary-check.ts <repo> <adapter-id>:<file> ...
 *
 * `doctor --probe` catches record types a reader doesn't know; this catches the quieter
 * failure where an agent moves or reshapes its logs and the reader finds nothing at all.
 */
import { resolve } from 'node:path';
import { ADAPTERS } from '../src/integrations/registry.ts';

const [root, ...expected] = process.argv.slice(2);
if (!root || expected.length === 0) {
  console.error('usage: bun scripts/canary-check.ts <repo> <adapter-id>:<file> ...');
  process.exit(2);
}

let failed = 0;
for (const pair of expected) {
  const [id, file] = pair.split(':');
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter || !file) {
    console.log(`FAIL ${pair}: no reader with that id`);
    failed++;
    continue;
  }
  const refs = adapter.discover({ roots: [resolve(root)], sinceMs: 0 });
  const sessions = refs.map((ref) => adapter.read(ref));
  const edited = sessions.some((s) =>
    s.records.some((r) => r.kind === 'edit' && r.file.replace(/\\/g, '/').endsWith(file)),
  );
  const unknown = sessions.flatMap((s) => Object.keys(s.unknownTypes));
  const detail = `${sessions.length} session(s)${unknown.length ? `, unknown types: ${[...new Set(unknown)].join(', ')}` : ''}`;
  if (edited) console.log(`ok   ${adapter.label}: ${detail}, edit to ${file} found`);
  else {
    console.log(`FAIL ${adapter.label}: ${detail}, no edit to ${file}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
