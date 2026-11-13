/**
 * Read-only SQLite for session stores (OpenCode, Kilo). The compiled binary runs
 * on Bun (bun:sqlite); the shipped bundle may run on Node 22+ (node:sqlite).
 * Modules are loaded by computed name so the bundler leaves them alone.
 */
import { createRequire } from 'node:module';

export interface ReadOnlyDb {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
}

const load = createRequire(import.meta.url);

/** The database opened read-only, or undefined when this runtime has no SQLite. */
export function openReadOnly(path: string): ReadOnlyDb | undefined {
  if ((globalThis as { Bun?: unknown }).Bun) {
    const { Database } = load(['bun', 'sqlite'].join(':')) as any;
    const db = new Database(path, { readonly: true });
    return {
      all: (sql, ...params) => db.query(sql).all(...params),
      close: () => db.close(),
    };
  }
  try {
    const { DatabaseSync } = load(['node', 'sqlite'].join(':')) as any;
    const db = new DatabaseSync(path, { readOnly: true });
    return {
      all: (sql, ...params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch {
    return undefined;
  }
}
