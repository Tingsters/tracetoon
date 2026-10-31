/** The user-facing notice when the leak scan stops a PR. Kept small: hooks import it. */
export interface LeakFindings {
  findings: { kind: string; count: number }[];
  /** Where each finding is ("title" or "final-body.md:<line>"); never the value. */
  findingAt?: string[];
  allowFindings?: boolean;
}

/** Whether the leak scan blocks this render from being posted. */
export const leakBlocks = (r: LeakFindings | undefined): boolean =>
  !!r && r.findings.length > 0 && !r.allowFindings;

/**
 * Names the kind and place of each finding, never the value, and what the
 * user can do about it.
 */
export function leakNotice(r: LeakFindings): string {
  const kinds = r.findings.map((f) => `${f.kind} x${f.count}`).join(', ');
  const where = r.findingAt?.length ? ` at ${r.findingAt.join(', ')}` : '';
  return `PR NOT CREATED: the leak scan found a possible secret in the PR text (${kinds}${where}). Nothing was posted. Tell the user this first, before anything else. The place is in the rendered final-body.md (or the title): remove that text where it came from (body.md, title.txt, or comic.json for the comic transcript) and render again; only if the user confirms it is not a secret, render with --allow-findings.`;
}
