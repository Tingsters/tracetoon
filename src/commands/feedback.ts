/**
 * `tracetoon feedback`: a link to a new GitHub issue, prefilled with what is
 * safe to share from `doctor` (versions, platform, which checks failed). No
 * paths, account, repository or host names. It never submits anything.
 */
import { BUILD_INFO } from '../version.ts';
import { run } from '../util/exec.ts';
import { doctorReport } from './doctor.ts';
import { emit, type OutOpts } from './output.ts';

export const ISSUES = 'https://github.com/Tracetoon/tracetoon/issues/new';

export interface FeedbackOpts extends OutOpts {
  title?: string;
  open?: boolean;
}

/** The redacted summary the issue body carries. */
export function feedbackSummary(report: ReturnType<typeof doctorReport>): string {
  const failed = report.checks.filter((c) => !c.ok);
  // Only the kind of runtime, never its path.
  const runtime = report.runtime.replace(/[\\/].*$/, '').trim();
  return [
    '<!-- Describe what happened and what you expected. -->',
    '',
    '',
    '### Environment (from `tracetoon doctor`)',
    '',
    `- Tracetoon: ${BUILD_INFO.version} (build ${BUILD_INFO.buildId.slice(0, 12)})`,
    `- Runtime: ${runtime}`,
    `- OS: ${process.platform} ${process.arch}`,
    `- git: ${report.git ?? 'not found'}; gh: ${report.gh ?? 'not found'}`,
    `- Agents with logs: ${
      report.agents
        .filter((a) => a.found)
        .map((a) => a.id)
        .join(', ') || 'none'
    }`,
    `- Failed checks: ${
      failed.map((c) => `${c.id} (${c.severity})`).join(', ') || 'none'
    }`,
  ].join('\n');
}

export function feedbackUrl(title: string, body: string): string {
  const q = new URLSearchParams({ title, body });
  return `${ISSUES}?${q.toString()}`;
}

/** Hand the link to the system browser; whether it opened is reported, never required. */
function openInBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  return run(cmd, args, { timeoutMs: 5000 }).ok;
}

export function feedbackCmd(cwd: string, opts: FeedbackOpts): void {
  const report = doctorReport(cwd);
  const title = opts.title?.trim() || 'Feedback';
  const url = feedbackUrl(title, feedbackSummary(report));
  const opened = opts.open ? openInBrowser(url) : false;
  emit(opts, { url, opened, submitted: false }, () =>
    [
      'Open this link to file the issue (nothing was sent):',
      url,
      ...(opts.open && !opened
        ? ['Could not open a browser; copy the link instead.']
        : []),
    ].join('\n'),
  );
}
