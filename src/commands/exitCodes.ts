/**
 * The one table of what Tracetoon's exit codes and error codes mean.
 * docs/agents/errors.md and AGENTS.md are generated from it
 * (scripts/agent-surfaces.ts), so the docs never drift from the code.
 */

export interface ExitCode {
  code: number;
  name: string;
  meaning: string;
  whatToDo: string;
}

export const EXIT_CODES: ExitCode[] = [
  { code: 0, name: 'OK', meaning: 'Success', whatToDo: '' },
  {
    code: 1,
    name: 'ERROR',
    meaning: 'Error (the message says why)',
    whatToDo: 'Read `errorCode` and `fix`; fix and rerun',
  },
  {
    code: 2,
    name: 'USAGE',
    meaning: 'Unknown command or option, or a missing argument',
    whatToDo: 'Check `tracetoon commands --json`, then rerun',
  },
  {
    code: 3,
    name: 'NO_RUNTIME',
    meaning: 'Launcher found no runtime',
    whatToDo: 'Ask the user, then rerun with `TRACETOON_ALLOW_DOWNLOAD=1`',
  },
  {
    code: 4,
    name: 'CONSENT_REQUIRED',
    meaning: 'Image route needs consent',
    whatToDo: 'Ask the user; add `--consent` only after they agree',
  },
  {
    code: 5,
    name: 'NO_IMAGE_ROUTE',
    meaning:
      'No approved image route, or `doctor --probe --strict` found unknown log records',
    whatToDo: 'Offer the printed options, or skip the comic',
  },
  {
    code: 6,
    name: 'HUMAN_REQUIRED',
    meaning:
      'Only the user can fix it (install or sign in to `gh`, grant access), or `doctor --strict` found a failed required check',
    whatToDo: 'Show the user `fix`; rerun after they act',
  },
  {
    code: 7,
    name: 'RETRYABLE',
    meaning: 'GitHub or the network failed or rate-limited the request',
    whatToDo: 'Wait a little, then rerun the same command',
  },
  {
    code: 10,
    name: 'UPDATE_AVAILABLE',
    meaning: '`update --check --exit-code`: a newer release exists',
    whatToDo: 'Tell the user; update only if they ask',
  },
];

export interface ErrorCode {
  code: string;
  exit: number;
  meaning: string;
  fix?: string;
  retryable?: boolean;
  humanRequired?: boolean;
}

/** `errorCode` values in `--json` errors. Codes are stable; new ones may be added. */
export const ERROR_CODES: ErrorCode[] = [
  { code: 'ERROR', exit: 1, meaning: 'Any error without a more specific code' },
  {
    code: 'USAGE',
    exit: 2,
    meaning: 'Unknown command or option, or a missing argument',
    fix: 'tracetoon commands --json',
  },
  {
    code: 'NOT_A_GIT_REPO',
    exit: 1,
    meaning: 'The command must run inside a git repository',
    fix: 'cd into the repository, then rerun',
  },
  {
    code: 'RUN_NOT_FOUND',
    exit: 1,
    meaning: 'No Tracetoon run, or not the one named by `--run`',
    fix: 'tracetoon prepare --json',
  },
  {
    code: 'RUN_OTHER_WORKTREE',
    exit: 1,
    meaning: 'The run belongs to another worktree or branch',
    fix: 'Switch to that checkout, or pass another --run',
  },
  {
    code: 'NOTHING_RENDERED',
    exit: 1,
    meaning: 'Publishing needs a render first',
    fix: 'tracetoon render --json',
  },
  {
    code: 'BRANCH_NOT_PUSHED',
    exit: 1,
    meaning: 'With `--no-push`: GitHub does not have the rendered revision',
    fix: 'tracetoon publish --push',
  },
  {
    code: 'PR_EXISTS',
    exit: 1,
    meaning: 'A PR Tracetoon did not render already exists for this branch and base',
    fix: 'tracetoon context --json, then render and publish again (it updates that PR)',
  },
  {
    code: 'GH_MISSING',
    exit: 6,
    meaning: 'The GitHub CLI (`gh`) is not installed',
    fix: 'Install the GitHub CLI: https://cli.github.com',
    humanRequired: true,
  },
  {
    code: 'GH_NOT_AUTHENTICATED',
    exit: 6,
    meaning: '`gh` is not signed in, or its token was refused',
    fix: 'gh auth login',
    humanRequired: true,
  },
  {
    code: 'GH_FAILED',
    exit: 1,
    meaning: 'A `gh` call failed for another reason (the message has its output)',
  },
  {
    code: 'GITHUB_UNREACHABLE',
    exit: 7,
    meaning: 'GitHub could not be reached, timed out or rate-limited the call',
    fix: 'Rerun the same command in a minute',
    retryable: true,
  },
  {
    code: 'CONSENT_REQUIRED',
    exit: 4,
    meaning: 'Sending comic prompts to this image route needs the user’s agreement',
    fix: 'Ask the user; rerun with --consent only after they agree',
    humanRequired: true,
  },
  {
    code: 'NO_IMAGE_ROUTE',
    exit: 5,
    meaning: 'No approved image route can draw the comic',
    fix: 'Offer the printed options, or skip the comic',
    humanRequired: true,
  },
  {
    code: 'UPDATES_DISABLED',
    exit: 1,
    meaning: '`TRACETOON_DISABLE_UPDATES=1` is set here',
  },
  {
    code: 'UPDATE_LOOKUP_FAILED',
    exit: 7,
    meaning: 'The release list could not be fetched',
    fix: 'Rerun the same command in a minute',
    retryable: true,
  },
  {
    code: 'SKILL_SOURCE_NOT_FOUND',
    exit: 1,
    meaning: '`setup` found no skill folder shipped with this runtime',
    fix: 'Follow docs/agents/install.md',
  },
];

export function errorCodeInfo(code: string): ErrorCode | undefined {
  return ERROR_CODES.find((e) => e.code === code);
}
