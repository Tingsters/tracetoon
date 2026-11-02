/**
 * The drafter's local change map: every change grouped by idea, in the order a
 * reviewer should read it, written before the description and never posted.
 * Writing from groups untangles composite changes before any prose exists
 * (Tao et al., FSE 2012; Barnett et al., ICSE 2015), and a map that misses a
 * file makes the description's omissions visible. Checks here are advisory.
 */
export interface ChangeGroup {
  idea: string;
  /** One sentence: what behaves differently, or what stays the same. */
  behavior: string;
  kind: 'behavior' | 'test' | 'docs' | 'mechanical';
  paths: string[];
  /** Material conditions, defaults and fallbacks within this idea, with patch lines. */
  behaviorChecks?: { behavior: string; evidence: string[] }[];
}
export interface ChangeMap {
  groups: ChangeGroup[];
  /** Lines the drafter traced for the body's concrete example, as `path:start[-end]`; see refPath for the other accepted forms. */
  example?: { refs: string[] };
}
export interface ChangeMapFinding {
  kind: 'missing' | 'invalid' | 'uncovered' | 'unknown-path' | 'split';
  text: string;
}

const KINDS = ['behavior', 'test', 'docs', 'mechanical'];
/** Past this many separate behavior ideas, a PR is usually several changes. */
export const SPLIT_GROUPS = 3;

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function parse(raw: unknown): ChangeMap | string {
  if (!record(raw) || !Array.isArray(raw.groups) || !raw.groups.length)
    return 'change-map.json needs a nonempty groups array.';
  for (const [i, g] of raw.groups.entries()) {
    if (
      !record(g) ||
      !text(g.idea) ||
      !text(g.behavior) ||
      !KINDS.includes(g.kind as string) ||
      !Array.isArray(g.paths) ||
      !g.paths.length ||
      !g.paths.every(text)
    )
      return `change-map.json group ${i + 1} needs an idea, a behavior sentence, a kind (behavior, test, docs or mechanical) and its paths.`;
    if (
      g.behaviorChecks !== undefined &&
      (!Array.isArray(g.behaviorChecks) ||
        !g.behaviorChecks.every(
          (c) =>
            record(c) &&
            text(c.behavior) &&
            Array.isArray(c.evidence) &&
            c.evidence.length > 0 &&
            c.evidence.every(
              (ref) => typeof ref === 'string' && /^diff:\d+(-\d+)?$/.test(ref),
            ),
        ))
    )
      return `change-map.json group ${i + 1} behaviorChecks need a behavior and nonempty diff:line evidence.`;
  }
  if (
    raw.example !== undefined &&
    (!record(raw.example) ||
      !Array.isArray(raw.example.refs) ||
      !raw.example.refs.every(text))
  )
    return 'change-map.json example needs refs as path:line strings.';
  return raw as unknown as ChangeMap;
}

export function checkChangeMap(input: {
  raw: unknown;
  /** Changed files with their digest role. */
  files: { path: string; role?: string; added: number }[];
  /** Every path in the submitted diff. */
  changedPaths: string[];
  /** The exact patch whose one-based lines are cited by behavior checks. */
  patch?: string;
  /** Whether an example ref's path (outside the diff) exists in the checkout. */
  exists: (path: string) => boolean;
}): ChangeMapFinding[] {
  const behavior = input.files.filter((f) => (f.role ?? 'behavior') === 'behavior');
  if (input.raw === undefined) {
    const added = behavior.reduce((n, f) => n + f.added, 0);
    return behavior.length >= 3 || added > 300
      ? [
          {
            kind: 'missing',
            text: 'No change-map.json. Grouping the changes by idea before writing helps catch omissions in a change this size.',
          },
        ]
      : [];
  }
  const map = parse(input.raw);
  if (typeof map === 'string') return [{ kind: 'invalid', text: map }];
  const findings: ChangeMapFinding[] = [];
  const changed = new Set(input.changedPaths);
  const mapped = new Set(map.groups.flatMap((g) => g.paths));
  for (const group of map.groups)
    for (const check of group.behaviorChecks ?? []) {
      for (const ref of check.evidence) {
        const [, first, last] = /^diff:(\d+)(?:-(\d+))?$/.exec(ref)!;
        if (
          input.patch === undefined ||
          Number(first) < 1 ||
          Number(last ?? first) < Number(first) ||
          Number(last ?? first) > input.patch.split(/\r?\n/).length
        )
          findings.push({
            kind: 'invalid',
            text: `Behavior check "${check.behavior}" cites an unavailable patch range: ${ref}.`,
          });
      }
    }
  for (const path of mapped)
    if (!changed.has(path))
      findings.push({
        kind: 'unknown-path',
        text: `The change map names ${path}, which this diff doesn't change.`,
      });
  const uncovered = behavior.filter((f) => !mapped.has(f.path)).map((f) => f.path);
  if (uncovered.length)
    findings.push({
      kind: 'uncovered',
      text: `The change map leaves out ${uncovered.length} behavior file(s): ${uncovered.slice(0, 6).join(', ')}${uncovered.length > 6 ? ', …' : ''}. Check that the description covers them.`,
    });
  for (const ref of map.example?.refs ?? []) {
    const path = refPath(ref);
    if (!changed.has(path) && !input.exists(path))
      findings.push({
        kind: 'unknown-path',
        text: `The example trace cites ${ref}, which isn't in the diff or the repository.`,
      });
  }
  const ideas = map.groups.filter((g) => g.kind === 'behavior').length;
  if (ideas > SPLIT_GROUPS)
    findings.push({
      kind: 'split',
      text: `The change map has ${ideas} separate behavior ideas. If they don't depend on each other, consider splitting this PR; smaller, single-purpose changes are reviewed more effectively.`,
    });
  return findings;
}

/**
 * The file a ref points at. Drafters write refs several ways; all name a file:
 * `src/a.ts:12-30`, `src/a.ts:12,40-44`, `origin/main:src/a.ts:12` (any revision
 * first), or with a note after it (`src/a.ts:12 (old behavior)`).
 */
export function refPath(ref: string): string {
  let r = ref.trim().split(/\s/)[0]!;
  r = r.replace(/:[\d,\-]+$/, ''); // line numbers
  // Anything before a colon is taken as a revision (`main:`, `v1.2.0:`,
  // `origin/x~1:`, a sha). Windows forbids colons in file names and they are
  // rare elsewhere; a path that has one is flagged, and the check is advisory.
  const colon = r.indexOf(':');
  if (colon > 0) r = r.slice(colon + 1);
  return r;
}
