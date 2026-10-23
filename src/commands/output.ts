/** Output helpers: every command can print JSON (`--json`) for the skill to parse. */

export interface OutOpts {
  json?: boolean;
}

export function emit(opts: OutOpts, data: unknown, text: () => string): void {
  if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(text().replace(/\s*$/, '') + '\n');
}

/** An error meant for the user (or the skill), with a meaningful exit code. */
export class UserError extends Error {
  /** Checked instead of `instanceof`, which a bundler's duplicate module copies can defeat. */
  readonly isUserError = true;
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function exitCodeOf(e: unknown): number {
  const err = e as { isUserError?: boolean; exitCode?: unknown };
  return err?.isUserError && typeof err.exitCode === 'number' ? err.exitCode : 1;
}
