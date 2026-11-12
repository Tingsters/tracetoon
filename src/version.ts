import pkg from '../package.json';

/** The build identity `bun run bundle` and `bun run build` stamp into a packaged copy. */
interface BuildManifest {
  buildId: string;
  revision: string | null;
  protocol: number;
  dependencies?: unknown[];
  compiler?: { name: string; version: string };
}

/** The build id of a run from a source checkout (`bun src/cli.ts`). */
export const SOURCE_BUILD = 'source';

// Injected at bundle and compile time (scripts/bundle.ts, scripts/build.ts). A source
// checkout has no generated build.json, so running from source reports the `source` build.
declare const __TRACETOON_BUILD__: BuildManifest | undefined;
const manifest: BuildManifest =
  typeof __TRACETOON_BUILD__ !== 'undefined'
    ? __TRACETOON_BUILD__
    : { buildId: SOURCE_BUILD, revision: null, protocol: 2 };

/** package.json is the version authority; the build script stamps package identity. */
export const TOOL_VERSION = pkg.version;
export const BUILD_INFO = {
  version: TOOL_VERSION,
  buildId: manifest.buildId,
  revision: manifest.revision,
  protocol: manifest.protocol,
  ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
  ...(manifest.compiler ? { compiler: manifest.compiler } : {}),
  capabilities: [
    'task-lifecycle',
    'check-receipts',
    'pr-creation-routing',
    'shared-preparation',
    'batch-evidence',
    'claim-review-v2',
  ],
};

/** True when this process runs from a source checkout rather than a bundle or binary. */
export const FROM_SOURCE = BUILD_INFO.buildId === SOURCE_BUILD;
