/** Package checks exercise process/asset boundaries; pure source tests run in full separately. */
export interface PackagedContract {
  id: string;
  file: string;
  pattern: string;
  minimum: number;
}
export const PUBLICATION_CONTRACT: PackagedContract = {
  id: 'publication-recovery',
  file: 'tests/workflow.test.ts',
  pattern: 'author review to publication rehearsal',
  minimum: 1,
};
export const BUNDLE_CONTRACTS: PackagedContract[] = [
  {
    id: 'trace-selection-and-redaction',
    file: 'tests/flow.test.ts',
    pattern: 'matches the session that wrote the code and drops other repos',
    minimum: 1,
  },
  {
    id: 'exact-author-approval',
    file: 'tests/flow.test.ts',
    pattern: 'publish needs the approval code for the exact rendered text',
    minimum: 1,
  },
  {
    id: 'comic-assets-and-body',
    file: 'tests/comic.test.ts',
    pattern:
      'makes the comic, puts only the image on the assets branch, and links it by commit',
    minimum: 1,
  },
  {
    id: 'page-rendering-and-lettering',
    file: 'tests/comic.test.ts',
    pattern: 'a page is drawn whole with its lettering, then gets the footer bar',
    minimum: 1,
  },
  {
    id: 'research-review-handoff',
    file: 'tests/contribution.test.ts',
    pattern:
      'research → draft → review → correction → preview; retained text and approval stay intact',
    minimum: 1,
  },
  {
    id: 'composition-cache-freshness',
    file: 'tests/composition.test.ts',
    pattern:
      'changed composition regenerates art and refuses stale output; format rerolls need matching beats',
    minimum: 1,
  },
  {
    id: 'hook-protocol',
    file: 'tests/hook.test.ts',
    pattern: 'the CLI reads stdin and answers like an agent hook',
    minimum: 1,
  },
  {
    id: 'code-freshness',
    file: 'tests/review.test.ts',
    pattern:
      'new commits block both publish modes and cannot be blessed by rendering an old digest',
    minimum: 1,
  },
  {
    id: 'runtime-selection',
    file: 'tests/runtime.test.ts',
    pattern: 'packaged runtime selection',
    minimum: 2,
  },
  PUBLICATION_CONTRACT,
];
export const contractPattern = (cases: PackagedContract[]) =>
  cases.map((c) => `(?:${c.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join('|');
const decode = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, n: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n]!,
  );

/** A renamed/skipped/empty selection must fail instead of silently dropping coverage. */
export function missingContracts(xml: string, cases: PackagedContract[]): string[] {
  const passed = [
    ...xml.matchAll(/<testcase\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/testcase>)/g),
  ].flatMap((m) => {
    if (/<(?:skipped|failure|error)\b/.test(m[2] ?? '')) return [];
    const attr = (key: string) =>
      decode(new RegExp(`\\b${key}="([^"]*)"`).exec(m[1]!)?.[1] ?? '');
    return [
      {
        file: attr('file').replaceAll('\\', '/'),
        name: `${attr('classname')} ${attr('name')}`,
      },
    ];
  });
  return cases
    .filter(
      (c) =>
        passed.filter(
          (p) =>
            (p.file === c.file || p.file.endsWith('/' + c.file)) &&
            p.name.includes(c.pattern),
        ).length < c.minimum,
    )
    .map((c) => c.id);
}
