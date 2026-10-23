/**
 * Stand-in for `codex exec` in tests. Reads the prompt from stdin, "draws" one
 * image per numbered prompt into $CODEX_HOME/generated_images/<thread>/ like the
 * real image tool, and prints Codex's JSON events. FAKE_CODEX_LOG records each
 * call; FAKE_CODEX_MAKE limits how many images it makes (to test failures).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const images = args.flatMap((a, i) => (args[i - 1] === '--image' ? [a] : []));
const wanted = (prompt.match(/^\d+\. /gm) ?? []).length;
const make = process.env.FAKE_CODEX_MAKE ? Number(process.env.FAKE_CODEX_MAKE) : wanted;
if (process.env.FAKE_CODEX_LOG)
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({ args, images, prompt }) + '\n',
  );

const thread = `thread-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const dir = join(process.env.CODEX_HOME!, 'generated_images', thread);
mkdirSync(dir, { recursive: true });
const paths: string[] = [];
for (let i = 0; i < make; i++) {
  const p = join(dir, `exec-${i}.png`);
  writeFileSync(p, PNG);
  paths.push(p);
  // Distinct modification times, so order is stable.
  const until = Date.now() + 5;
  while (Date.now() < until) {}
}
const say = (text: string) =>
  console.log(
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  );
console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
say(paths.join('\n'));
console.log(JSON.stringify({ type: 'turn.completed' }));
