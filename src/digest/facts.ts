/** Resolve local evidence references without exposing raw transcripts. */
import type { TraceDigest } from './build.ts';

export function digestFact(digest: TraceDigest, ref: string): unknown {
  const id = ref.replace(/^digest:/, '');
  const commit = /^commit:([a-f0-9]{7,40})$/i.exec(id);
  if (commit) {
    const matches = digest.pr.commits.filter((c) =>
      c.sha.toLowerCase().startsWith(commit[1]!.toLowerCase()),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  const session = digest.sessions.find((s) => s.ref === id);
  if (session) return session;
  return (
    digest.verification?.find((r) => r.id === id) ??
    digest.sessions
      .flatMap((s) => [
        ...(s.prompts ?? []),
        ...(s.plans ?? []),
        ...(s.decisions ?? []),
        ...(s.runs ?? []),
      ])
      .find((fact) => fact.id === id)
  );
}
