import pkg from '../package.json';
import manifest from '../plugin/skills/tracetoon/build.json';

/** package.json is the version authority; the build script stamps package identity. */
export const TOOL_VERSION = pkg.version;
export const BUILD_INFO = {
  version: TOOL_VERSION,
  buildId: manifest.buildId,
  revision: manifest.revision,
  protocol: manifest.protocol,
  ...('dependencies' in manifest ? { dependencies: manifest.dependencies } : {}),
  ...('compiler' in manifest ? { compiler: manifest.compiler } : {}),
  capabilities: [
    'task-lifecycle',
    'check-receipts',
    'pr-creation-routing',
    'shared-preparation',
    'batch-evidence',
    'claim-review-v2',
  ],
};
