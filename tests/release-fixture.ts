/** A synthetic verified release artifact set (no compiling), for distribution tests. */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sha,
  SUPPORTED_TARGETS,
  writeInventory,
} from '../.github/scripts/release-assets.ts';
import { tempDir } from './helpers.ts';

export const binaryName = (target: string) =>
  `tracetoon-${target}${target.startsWith('windows-') ? '.exe' : ''}`;

/**
 * `binaries` maps a release target to a file whose bytes stand in for that
 * target's binary; the rest get placeholder text.
 */
export function releaseFixture(
  opts: { version?: string; binaries?: Record<string, string> } = {},
) {
  const root = tempDir(),
    skill = join(root, 'tracetoon'),
    out = join(root, 'release');
  mkdirSync(join(skill, 'dist'), { recursive: true });
  mkdirSync(join(skill, 'bin'), { recursive: true });
  mkdirSync(join(skill, 'assets'), { recursive: true });
  mkdirSync(out);
  const manifest = {
    version: opts.version ?? '1.0.0-rc.24',
    buildId: 'a'.repeat(64),
    protocol: 2,
    compiler: { name: 'bun', version: Bun.version },
    recipe: { native: { targets: SUPPORTED_TARGETS } },
  };
  writeFileSync(join(skill, 'build.json'), JSON.stringify(manifest));
  writeFileSync(join(skill, 'VERSION'), manifest.version);
  writeFileSync(join(skill, 'SKILL.md'), '# Synthetic skill');
  writeFileSync(join(skill, 'bin', 'tracetoon'), '#!/bin/sh\nexit 3\n');
  writeFileSync(join(skill, 'assets', 'resvg.wasm'), 'synthetic wasm');
  writeFileSync(join(skill, 'dist/tracetoon.mjs'), 'console.log("synthetic");');
  const receipt = (file: string, target: string) => ({
    schema: 'tracetoon.build-output/v1',
    target,
    buildId: manifest.buildId,
    inputManifestSha256: sha(join(skill, 'build.json')),
    sha256: sha(file),
    compiler: { version: Bun.version, sha256: 'b'.repeat(64) },
  });
  writeFileSync(
    join(skill, 'dist/tracetoon.mjs.build.json'),
    JSON.stringify(receipt(join(skill, 'dist/tracetoon.mjs'), 'node-esm')),
  );
  for (const target of SUPPORTED_TARGETS) {
    const file = join(out, binaryName(target));
    const stand = opts.binaries?.[target];
    if (stand) copyFileSync(stand, file);
    else writeFileSync(file, 'synthetic binary ' + target);
    writeFileSync(file + '.build.json', JSON.stringify(receipt(file, target)));
    writeFileSync(
      join(out, `tracetoon-skill-${target}.zip`),
      'synthetic archive ' + target,
    );
  }
  writeFileSync(join(out, 'tracetoon-skill.zip'), 'synthetic slim archive');
  const inventory = writeInventory(out, skill, 'c'.repeat(40));
  return { root, out, skill, manifest, inventory };
}
