/** Synthetic reader probes, not automatic humor scores or real traces. */
import { COMIC_STORIES } from './comic-stories.ts';
const probes: Record<string, { facts: string[]; watchFor: string[]; control: string }> = {
  single: {
    facts: ['A small resource-handle change addresses a leak.'],
    watchFor: [
      'A static scale gag can work without showing a repair.',
      'An open tap does not prove a fixed leak.',
    ],
    control: 'static-control',
  },
  comparison: {
    facts: ['A confusing save workflow becomes one clear action.'],
    watchFor: [
      'Keep the user goal recognizable.',
      'Simplification alone may explain a feature without a comic turn.',
    ],
    control: 'unscored',
  },
  vertical: {
    facts: [
      'Retries wait between attempts.',
      'Eventual success and measured delay are unknown.',
    ],
    watchFor: [
      'Show or clearly cue an active attempt after waiting.',
      'An opening door alone does not establish a later retry.',
      'Look for a payoff beyond advice to wait.',
    ],
    control: 'negative-control',
  },
  asymmetric: {
    facts: ['Concurrent requests must not claim the same last available seat.'],
    watchFor: [
      'Unexplained empty available seats contradict last-seat scarcity.',
      'A gate appearing does not explain how a claimant wins.',
      'An exclusive result alone is not a punchline.',
    ],
    control: 'negative-control',
  },
  'hero-inset': {
    facts: ['Configuration keys change while values are preserved.'],
    watchFor: [
      'Recognizable unchanged contents support preservation.',
      'Blank labels cannot demonstrate a naming change.',
      'Look for a comic turn beyond announcing preservation.',
    ],
    control: 'negative-control',
  },
  diagonal: {
    facts: ['Shutdown now stops orphaned background jobs.'],
    watchFor: [
      'A creature can earn its place through the zombie-job metaphor.',
      'Separate fictional release from claimed runtime results.',
    ],
    control: 'unscored',
  },
};
export const COMIC_CONTENT_CASES = [
  ...COMIC_STORIES.map((item) => ({ ...item, ...probes[item.id]! })),
  {
    id: 'cache-invalidation',
    story: 'Validation can be reused despite changing host request identifiers.',
    facts: [
      'A new host request ID does not change tested content.',
      'Changed code or relevant environment still invalidates validation.',
    ],
    watchFor: [
      'Do not imply all invalidation is disabled.',
      'Find a comic consequence of unstable identity beyond tests-passed celebration.',
    ],
    control: 'held-out',
    script: undefined,
  },
  {
    id: 'documentation-only',
    story: 'A documentation typo is corrected without changing program behavior.',
    facts: [
      'The change corrects a documentation typo only.',
      'No runtime, performance, or production outcome was established.',
    ],
    watchFor: [
      'Do not invent an outage, failing build, or performance improvement.',
      'A small change can support a compact joke without an elaborate rescue.',
    ],
    control: 'held-out',
    script: undefined,
  },
];
