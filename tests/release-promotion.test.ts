import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sha,
  SUPPORTED_TARGETS,
  verifyArtifactMetadata,
  verifyAssets,
  verifyPromotion,
  writeInventory,
  type Promotion,
} from '../.github/scripts/release-assets.ts';
import { tempDir } from './helpers.ts';
function fixture() {
  const root = tempDir(),
    skill = join(root, 'tracetoon'),
    out = join(root, 'release');
  mkdirSync(join(skill, 'dist'), { recursive: true });
  mkdirSync(out);
  const manifest = {
    version: '1.0.0-rc.24',
    buildId: 'a'.repeat(64),
    protocol: 2,
    compiler: { name: 'bun', version: Bun.version },
    recipe: { native: { targets: SUPPORTED_TARGETS } },
  };
  writeFileSync(join(skill, 'build.json'), JSON.stringify(manifest));
  writeFileSync(join(skill, 'VERSION'), manifest.version);
  writeFileSync(join(skill, 'SKILL.md'), '# Synthetic skill');
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
    const file = join(
      out,
      `tracetoon-${target}${target.startsWith('windows-') ? '.exe' : ''}`,
    );
    writeFileSync(file, 'synthetic binary ' + target);
    writeFileSync(file + '.build.json', JSON.stringify(receipt(file, target)));
    writeFileSync(
      join(out, `tracetoon-skill-${target}.zip`),
      'synthetic archive ' + target,
    );
  }
  writeFileSync(join(out, 'tracetoon-skill.zip'), 'synthetic slim archive');
  const inventory = writeInventory(out, skill, 'c'.repeat(40));
  const promotion: Promotion = {
    schema: 'tracetoon.release-promotion/v1',
    version: manifest.version,
    buildId: manifest.buildId,
    artifact: {
      runId: 123,
      id: 456,
      name: 'candidate-123',
      digest: 'sha256:' + 'd'.repeat(64),
    },
    expected: {
      manifestSha256: sha(join(out, 'candidate-manifest.json')),
      checksumsSha256: sha(join(out, 'checksums.txt')),
      windowsSha256: sha(join(out, 'tracetoon-windows-x64.exe')),
      bundleSha256: inventory.bundleSha256,
    },
    evaluations: [
      {
        split: 'dev',
        status: 'passed',
        experiment: 'e'.repeat(64),
        reportSha256: 'f'.repeat(64),
        writers: 90,
        orders: 240,
      },
      {
        split: 'test',
        status: 'passed',
        experiment: '1'.repeat(64),
        reportSha256: '2'.repeat(64),
        writers: 36,
        orders: 96,
      },
    ],
  };
  return { out, skill, manifest, promotion };
}
test('promotion verifies the exact frozen bytes and requires both full adoption cohorts', () => {
  const { out, manifest, promotion } = fixture();
  expect(verifyPromotion(out, promotion, manifest, `v${manifest.version}`).buildId).toBe(
    manifest.buildId,
  );
  expect(() => verifyPromotion(out, promotion, manifest, 'v1.0.0-rc.25')).toThrow(
    'tag/source',
  );
  const missing = structuredClone(promotion);
  missing.evaluations.pop();
  expect(() => verifyPromotion(out, missing, manifest, `v${manifest.version}`)).toThrow(
    'Both adoption',
  );
  const unknown = structuredClone(promotion);
  unknown.evaluations[1]!.status = 'inconclusive' as any;
  expect(() => verifyPromotion(out, unknown, manifest, `v${manifest.version}`)).toThrow(
    'Passing test',
  );
  writeFileSync(join(out, 'tracetoon-windows-x64.exe'), 'different bytes');
  expect(() => verifyAssets(out)).toThrow('checksum mismatch');
});
test('artifact API identity, inventory paths and receipt identities cannot drift at publication', () => {
  const { out, promotion } = fixture();
  const metadata = {
    id: 456,
    name: 'candidate-123',
    digest: promotion.artifact.digest,
    expired: false,
    workflow_run: { id: 123 },
  };
  verifyArtifactMetadata(metadata, promotion);
  expect(() => verifyArtifactMetadata({ ...metadata, expired: true }, promotion)).toThrow(
    'artifact identity',
  );
  expect(() => verifyArtifactMetadata({ ...metadata, id: 457 }, promotion)).toThrow(
    'artifact identity',
  );
  const manifestPath = join(out, 'candidate-manifest.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files[0].name = '../outside';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(() => verifyAssets(out)).toThrow('checksum mismatch');
});
