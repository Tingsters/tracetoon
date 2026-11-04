/** Optional invocation diagnostics. No command text, output or environment is saved. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface ProfileState {
  invocation: string;
  started: number;
  counters: Record<string, number>;
  spans: {
    id: string;
    parent: string;
    stage: string;
    startedMs: number;
    durationMs: number;
  }[];
}
// The collector belongs to the process invocation, including when a packager
// emits separate instances for different imported exports of this module.
const stateKey = Symbol.for('tracetoon.profile-state/v1');
const registry = globalThis as unknown as { [key: symbol]: ProfileState | undefined };
const { invocation, started, counters, spans } = (registry[stateKey] ??= {
  invocation: randomUUID(),
  started: performance.now(),
  counters: {},
  spans: [],
});
export function count(name: string, n = 1) {
  counters[name] = (counters[name] ?? 0) + n;
}
export function measured<T>(stage: string, action: () => T): T {
  const at = performance.now();
  try {
    return action();
  } finally {
    spans.push({
      id: randomUUID(),
      parent: invocation,
      stage,
      startedMs: at - started,
      durationMs: performance.now() - at,
    });
  }
}
// Keep diagnostics independent of run.ts, which records read/write counts.
export function saveProfile(run: { dir: string }, stage: string) {
  try {
    appendFileSync(
      join(run.dir, 'profiles.jsonl'),
      JSON.stringify({
        schema: 'tracetoon.profile/v1',
        id: invocation,
        stage,
        at: new Date().toISOString(),
        durationMs: performance.now() - started,
        counters,
        spans,
        scope:
          'runtime diagnostics; nested spans overlap and are not validation evidence',
      }) + '\n',
    );
  } catch {
    /* Telemetry must never change the PR workflow result. */
  }
}
