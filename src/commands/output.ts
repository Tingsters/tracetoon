/** Output helpers: every command can print JSON (`--json`) for the skill to parse. */

export interface OutOpts {
  json?: boolean;
}

export function emit(opts: OutOpts, data: unknown, text: () => string): void {
  if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(text().replace(/\s*$/, '') + '\n');
}

export class UserError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
