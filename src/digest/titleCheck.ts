/**
 * Advisory checks on a PR title. Meaning and format are checked separately:
 * a valid prefix doesn't make a title good, and a style point never hides a
 * false claim. Each check says pass, revise or uncertain with a short reason;
 * nothing blocks publishing.
 */
import type { TitleRules } from '../github/titleRules.ts';
import type { TraceDigest } from './build.ts';

export type TitleState = 'pass' | 'revise' | 'uncertain';
export interface TitleFinding {
  check: 'compliance' | 'distinction' | 'shape' | 'truth' | 'scope';
  state: Exclude<TitleState, 'pass'>;
  reason: string;
}

const CONVENTIONAL = /^([a-z]+)(\([^)]+\))?!?: /;
const GENERIC =
  /^(fix(es|ed)?|update[sd]?|improve(s|d|ments?)?|changes?|misc(ellaneous)?|minor( changes?| fixes)?|various( fixes| changes)?|wip|clean ?up|refactor(ing)?|tweaks?|small fixes)(\s+(a |the )?(bugs?|stuff|things|code|issues?|readme|docs?|tests?|it|this))?\.?$/i;
/** What's left after a prefix like `fix: ` when that's all there is: "bug", "stuff". */
const GENERIC_NOUN =
  /^(a |the |some )?(bugs?|issues?|stuff|things|changes?|updates?|fixes|improvements?|cleanup|tweaks?|typos?|errors?|problems?)\.?$/i;
const ISSUE_ONLY =
  /^(\[?[A-Za-z]+-\d+\]?|#\d+|(gh|bpo)-\d+)?:?\s*((fix(es|ed)?|close[sd]?|resolve[sd]?|address(es)?|for|see)\s+)?(#\d+|(gh|bpo)-\d+|issue\s+#?\d+|[A-Z][A-Z0-9]+-\d+)\.?$/i;
const PERF =
  /\b(faster|speed(s|ed)? up|speedup|quicker|perf(ormance)? (boost|win|improvement)|\d+(\.\d+)?\s*(%|x)\s*(faster|smaller|less|fewer|improvement)?|reduce[sd]? (latency|memory|allocations?))\b/i;
const FILLER = /^(this (pr|pull request|change)|pr (to|for)|various|some|misc)\b/i;
const NEW_WORK =
  /^(fix(es|ed)?|add(s|ed)?|implement(s|ed)?|support(s|ed)?|enable[sd]?)\b/i;

/** The title without a conventional type or issue prefix: the part that has to identify the change. */
export function titleCore(title: string): string {
  return title
    .replace(CONVENTIONAL, '')
    .replace(/^(\[[^\]]+\]\s*)+/, '')
    .replace(/^((gh|bpo)-\d+|[A-Z][A-Z0-9]+-\d+):\s*/, '')
    .trim();
}

const normalize = (s: string) =>
  titleCore(s).replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();

export function checkTitle(input: {
  title: string;
  rules?: TitleRules;
  digest?: Pick<TraceDigest, 'files' | 'pr' | 'sessions'>;
}): TitleFinding[] {
  const { title, rules, digest } = input;
  const out: TitleFinding[] = [];
  const t = title.trim();
  const core = titleCore(t);
  const conventional = CONVENTIONAL.exec(t);

  // Local compliance: strict only where the repository is.
  if (rules?.conventional) {
    if (!conventional)
      out.push({
        check: 'compliance',
        state: 'revise',
        reason: `this repo requires a Conventional Commits type (${rules.conventional.types.slice(0, 6).join(', ')}…), per ${rules.conventional.source}`,
      });
    else if (!rules.conventional.types.includes(conventional[1]!))
      out.push({
        check: 'compliance',
        state: 'revise',
        reason: `"${conventional[1]}" isn't one of the allowed types (${rules.conventional.types.join(', ')})`,
      });
  } else if (conventional && rules?.recent && rules.recent.conventionalShare < 0.3) {
    out.push({
      check: 'compliance',
      state: 'uncertain',
      reason: `this repo's recent titles rarely use type prefixes (${Math.round(rules.recent.conventionalShare * 100)}%); drop "${conventional[0].trim()}" unless it's wanted`,
    });
  }
  if (rules?.issuePrefix) {
    const family = rules.issuePrefix.example
      .replace(/\d+|n{3,}|x{3,}|<[^>]+>/gi, '')
      .replace(/[[\]]/g, '');
    if (!t.toLowerCase().replace(/^\[/, '').startsWith(family.toLowerCase()))
      out.push({
        check: 'compliance',
        state: 'revise',
        reason: `start with the issue reference this repo asks for (like ${rules.issuePrefix.example}), per ${rules.issuePrefix.source}`,
      });
  }
  if (rules?.maxLength && t.length > rules.maxLength.value)
    out.push({
      check: 'compliance',
      state: 'revise',
      reason: `${t.length} characters; this repo's limit is ${rules.maxLength.value} (${rules.maxLength.source}). Shorten without losing the qualifier.`,
    });

  // Distinction: can a maintainer tell this change from its neighbors?
  if (ISSUE_ONLY.test(t) || !core)
    out.push({
      check: 'distinction',
      state: 'revise',
      reason:
        'names only an issue; say what changes (the issue can stay as a prefix or in the body)',
    });
  else if (GENERIC.test(core) || GENERIC_NOUN.test(core))
    out.push({
      check: 'distinction',
      state: 'revise',
      reason: `"${core}" could describe almost any change; name the operation or behavior and what triggers it`,
    });

  // Shape and economy.
  const tagline = /^([^:]{3,80}):\s+\S/.exec(core);
  if (tagline && tagline[1]!.trim().split(/\s+/).length >= 3)
    out.push({
      check: 'shape',
      state: 'revise',
      reason: 'headline plus tagline ("X: a, b, c"); say the main change once, plainly',
    });
  const parts = core.split(/,\s*|\s+and\s+|;\s*/).filter((p) => p.trim().length > 2);
  if (parts.length >= 3)
    out.push({
      check: 'shape',
      state: 'revise',
      reason: `lists ${parts.length} things; name the principal change (if they're unrelated, the PR may cover too much)`,
    });
  // Two clauses joined by a semicolon are two changes in one title: fine when
  // both matter to a maintainer, otherwise the smaller one belongs in the body.
  else if (/;\s+\S/.test(core))
    out.push({
      check: 'shape',
      state: 'uncertain',
      reason:
        'two changes in one title; keep both only if a maintainer needs both ("X, and Y" reads better), else move the smaller one to the body',
    });
  if (FILLER.test(core))
    out.push({
      check: 'shape',
      state: 'revise',
      reason: 'starts with filler; start with the change itself',
    });
  if (/[^.]\.$/.test(t))
    out.push({
      check: 'shape',
      state: 'uncertain',
      reason: 'ends with a period; most repos leave it off',
    });
  if (!rules?.maxLength && t.length > 72)
    out.push({
      check: 'shape',
      state: 'revise',
      reason: `${t.length} characters; check every word earns its place (keep the qualifier that matters, cut the rest)`,
    });

  // Truth: the title's claim must fit the change.
  // A revert quotes the original title; its claims aren't this PR's.
  const revert = /^revert\b/i.test(core);
  if (PERF.test(core) && !revert) {
    const measured = (digest?.sessions ?? []).some((s) =>
      (s.runs ?? []).some(
        (r) => r.kind === 'eval' || /bench|perf|hyperfine|time\b/i.test(r.cmd),
      ),
    );
    if (!measured)
      out.push({
        check: 'truth',
        state: 'uncertain',
        reason:
          'claims a speed or size gain, but no benchmark was captured; name the measured case or drop the claim',
      });
  }
  const roles = (digest?.files ?? []).map((f) => f.role ?? 'behavior');
  if (roles.length && roles.every((r) => r === 'docs') && NEW_WORK.test(core))
    out.push({
      check: 'truth',
      state: 'revise',
      reason: `every changed file is documentation; "${core.split(/\s+/)[0]}" suggests a code change. Say what the docs now explain.`,
    });
  if (
    roles.length &&
    roles.every((r) => r === 'tests') &&
    !/\btests?\b|\bspec/i.test(core)
  )
    out.push({
      check: 'truth',
      state: 'uncertain',
      reason: 'only tests changed; say so, so nobody expects a behavior change',
    });

  // Scope: the whole PR, not its latest commit.
  const commits = digest?.pr.commits ?? [];
  const subjects = new Set(commits.map((c) => normalize(c.subject)));
  const last = commits[commits.length - 1];
  if (
    commits.length >= 2 &&
    subjects.size >= 2 &&
    last &&
    normalize(last.subject) === normalize(t)
  )
    out.push({
      check: 'scope',
      state: 'uncertain',
      reason: `matches only the latest of ${commits.length} commits; make sure it covers the whole PR`,
    });
  return out;
}

/** One line for `render`, plus the findings worth a look. */
export function titleLine(findings: TitleFinding[]): string {
  if (!findings.length) return 'Title check (advisory): no problems found.';
  return [
    `Title check (advisory): ${findings.filter((f) => f.state === 'revise').length} to revise, ${findings.filter((f) => f.state === 'uncertain').length} uncertain.`,
    ...findings.map((f) => `  - ${f.state} (${f.check}): ${f.reason}`),
  ].join('\n');
}
