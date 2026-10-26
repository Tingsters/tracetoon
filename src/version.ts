import pkg from '../package.json';
import manifest from '../plugin/skills/tracetoon/build.json';

/** package.json is the version authority; the build script stamps package identity. */
export const TOOL_VERSION = pkg.version;
export const BUILD_INFO = {
  version: TOOL_VERSION,
  buildId: manifest.buildId,
  revision: manifest.revision,
  protocol: 1,
  capabilities: [
    'task-lifecycle',
    'completion-hook',
    'check-receipts',
    'publication-recovery',
  ],
};
