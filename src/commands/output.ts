/** Output helpers: every command can print JSON (`--json`) for the skill to parse. */
import { errorCodeInfo } from './exitCodes.ts';

export interface OutOpts {
  json?: boolean;
}

/** Version of the JSON shapes commands print; bumped only for incompatible changes. */
export const SCHEMA_VERSION = 1;

/**
 * Print a command's result. JSON objects end with `schemaVersion`; arrays (such as
 * `integrations --json`) are printed as they are.
 */
export function emit(opts: OutOpts, data: unknown, text: () => string): void {
  if (opts.json) {
    // Appended, so the fields a command puts first (prepare: run, next, brief) stay first.
    const out =
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      !('schemaVersion' in data)
        ? { ...data, schemaVersion: SCHEMA_VERSION }
        : data;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else process.stdout.write(text().replace(/\s*$/, '') + '\n');
}

export interface ErrorDetails {
  /** Stable UPPER_SNAKE identifier agents can branch on (docs/agents/errors.md). */
  code?: string;
  /** The exact command (or action) that fixes it. */
  fix?: string;
  /** Running the same command again later may succeed. */
  retryable?: boolean;
  /** Only the user can resolve it (sign in, install, consent, permission). */
  humanRequired?: boolean;
}

/** An error meant for the user (or the skill), with a meaningful exit code. */
export class UserError extends Error {
  /** Checked instead of `instanceof`, which a bundler's duplicate module copies can defeat. */
  readonly isUserError = true;
  readonly code?: string;
  readonly fix?: string;
  readonly retryable?: boolean;
  readonly humanRequired?: boolean;
  constructor(
    message: string,
    readonly exitCode = 1,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.code = details.code;
    this.fix = details.fix;
    this.retryable = details.retryable;
    this.humanRequired = details.humanRequired;
  }
}

/** A UserError whose exit code and flags come from the error-code table. */
export function codedError(code: string, message: string, fix?: string): UserError {
  const info = errorCodeInfo(code);
  return new UserError(message, info?.exit ?? 1, {
    code,
    fix: fix ?? info?.fix,
    retryable: info?.retryable ?? false,
    humanRequired: info?.humanRequired ?? false,
  });
}

/** A failed `gh` call, classified so agents can tell sign-in and network trouble apart. */
export function ghFailure(what: string, stderr: string): UserError {
  const said = stderr.trim();
  const message = `${what} failed: ${said}`;
  if (/ENOENT|not recognized as|executable file not found|command not found/i.test(said))
    return codedError('GH_MISSING', message);
  if (/not logged in|gh auth login|authentication|HTTP 401|bad credentials/i.test(said))
    return codedError('GH_NOT_AUTHENTICATED', message);
  if (
    /rate limit|HTTP 5\d\d|timed? ?out|ECONNRESET|ETIMEDOUT|could not resolve host|connection (lost|refused|reset)|network/i.test(
      said,
    )
  )
    return codedError('GITHUB_UNREACHABLE', message);
  return codedError('GH_FAILED', message);
}

/** Errors thrown below the command layer, recognized by their (stable) wording. */
const KNOWN: [RegExp, string][] = [
  [/not (inside )?a git repository/i, 'NOT_A_GIT_REPO'],
  [/No Tracetoon run found/, 'RUN_NOT_FOUND'],
  [/Invalid Tracetoon run id/, 'RUN_NOT_FOUND'],
  [/belongs to another worktree or branch/, 'RUN_OTHER_WORKTREE'],
];

/** What `--json` prints for an error: `error` stays the message, the rest sits beside it. */
export function errorEnvelope(e: unknown): {
  schemaVersion: number;
  error: string;
  errorCode: string;
  fix?: string;
  retryable: boolean;
  humanRequired: boolean;
} {
  const err = e as Partial<UserError> & { message?: string };
  const message = String(err?.message ?? e);
  const own = err?.isUserError ? err : undefined;
  const code = own?.code || KNOWN.find(([re]) => re.test(message))?.[1];
  const info = code ? errorCodeInfo(code) : undefined;
  const fix = own?.fix || info?.fix;
  return {
    schemaVersion: SCHEMA_VERSION,
    error: message,
    errorCode: code ?? 'ERROR',
    ...(fix ? { fix } : {}),
    retryable: own?.retryable ?? info?.retryable ?? false,
    humanRequired: own?.humanRequired ?? info?.humanRequired ?? false,
  };
}

export function exitCodeOf(e: unknown): number {
  const err = e as { isUserError?: boolean; exitCode?: unknown };
  return err?.isUserError && typeof err.exitCode === 'number' ? err.exitCode : 1;
}
