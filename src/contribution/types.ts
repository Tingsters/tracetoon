/** Handoffs between the host's researcher, drafter and independent reviewer. */
export interface AgentRole {
  mode: 'delegated' | 'inline';
  /** The actual host invocation id, not an invented persona or model name. */
  agentId?: string;
}

export interface SourceRef {
  source: string;
  startLine: number;
  endLine: number;
}

export interface GuidanceSource {
  id: string;
  kind: 'repository' | 'web';
  /** Repo-relative path or HTTPS URL. */
  location: string;
  scope: string;
  content: string;
  sha256: string;
  retrievedAt: string;
  revision?: string;
  discoveredFrom?: SourceRef;
}

export type RenderingRule =
  | 'disclosure-required'
  | 'disclosure-prohibited'
  | 'media-prohibited'
  | 'text-prohibited'
  | 'author-written-recommended'
  | 'no-pull-requests';

export interface Requirement {
  id: string;
  text: string;
  strength:
    'required' | 'expected' | 'prohibited' | 'recommended' | 'conditional' | 'advisory';
  applicability: 'applicable' | 'inapplicable' | 'unknown';
  appliesWhen: string;
  exceptions: string[];
  evidenceExpected: string[];
  sources: SourceRef[];
  /** Only explicit, applicable source requirements can affect composition. */
  rendering?: RenderingRule;
}

export interface Guidance {
  v: 1;
  requestFingerprint: string;
  researcher: AgentRole;
  sources: GuidanceSource[];
  requirements: Requirement[];
  gaps: string[];
}

export interface GuidanceRequest {
  v: 1;
  fingerprint: string;
  offline: boolean;
  changedPaths: string[];
  sourceSeeds: { location: string; scope: string; sha256: string }[];
  changesPath: string;
  headSha: string;
  diffSha256: string;
  gaps: string[];
}

export interface GuidanceResult {
  status: 'current' | 'partial' | 'missing' | 'invalid' | 'stale';
  issues: string[];
  guidance?: Guidance;
  sha256: string;
}

export type AssessmentState =
  'satisfied' | 'violated' | 'inapplicable' | 'missing-evidence' | 'unresolved-conflict';

export interface Assessment {
  requirement: string;
  state: AssessmentState;
  reason: string;
  /** Source refs, digest ids, author.md, or a location in the reviewed title/body/diff. */
  evidence: string[];
  correction?: string;
}

export interface ContributionReview {
  v: 1;
  inputFingerprint: string;
  drafter: AgentRole;
  reviewer: AgentRole;
  assessments: Assessment[];
  comicReview?: ComicReview;
}

export const COMIC_REVIEW_CHECKS = [
  'clarity',
  'continuity',
  'fidelity',
  'payoff',
  'readability',
] as const;
export type ComicReviewCheck = (typeof COMIC_REVIEW_CHECKS)[number];
export interface ComicReview {
  /** Host-reported image-first reading, not a machine certification of humor. */
  imageSha256: string;
  observedPanels: string[];
  inferredStory: string;
  perceivedJoke: string;
  checks: Record<
    ComicReviewCheck,
    {
      state: 'satisfied' | 'needs-revision' | 'uncertain' | 'inapplicable';
      reason: string;
      /** One-based references to the observed panels. */
      panels: number[];
    }
  >;
  correction?: {
    target: 'premise' | 'script' | 'art' | 'lettering';
    instruction: string;
  };
}

export interface ReviewInput {
  v: 1;
  fingerprint: string;
  title: string;
  body: string;
  guidanceSha256: string;
  digestSha256: string;
  diffSha256: string;
  headSha: string;
  authorSha256: string;
  comicSha256: string;
  /** Present on new comic renders; absent on legacy packets and comic-free PRs. */
  comic?: { imagePath: string; scriptPath: string; panelCount: number };
  /** Run-relative evidence paths for the reviewer. */
  artifacts: string[];
}

export interface ReviewResult {
  status: 'current' | 'incomplete' | 'missing' | 'stale' | 'invalid';
  mode?: 'delegated' | 'inline';
  issues: string[];
  guidanceStatus: GuidanceResult['status'];
  assessments: Assessment[];
  requirements: Requirement[];
  sources: GuidanceSource[];
  comicReview?: ComicReview;
}
